// Stabilized models: POST /models/:sourceId/derived stores the block assembly the browser built, DELETE /models/:id
// removes one. The site has no login and anyone can call this, so nothing the client says is believed:
//   - the body must be EXACTLY a GLB that shared/assemblyGlb.ts would write (every vertex, normal and index is checked
//     against the cells in its own descriptor), at most DERIVED_GLB_LIMIT (1 MiB; a full 1000-block assembly is 650 KB);
//   - the stabilizer's log inside it is validated field by field and bounded (DERIVED_META_LIMIT);
//   - the hash it states must be the hash of the cells, the chain depth must follow from the source, and the counts in the
//     log (blocks, blocks added, per role, per step) must be what the cells say (derivedChecks.ts);
//   - the key in R2 is generated here, the content type is forced, and the number of stabilized models is capped per
//     source, per project and per day. The per-source and per-project caps are part of the INSERT itself (a COUNT before it
//     would let parallel requests all see the same count); the daily counter is one atomic upsert.
// The claims in the log about stress (that it "passes all checks", the before/after numbers) are the client's: they are
// derived data, like PUT /models/:id/analysis, and the Analysis tab recomputes the verdict from the geometry every time it
// opens. The same blocks are stored once per source: a second upload of them, even with a log made under other settings
// (material, target), is answered with the model that is there, not a second row.
// CPU (Node on an M-series laptop, a fresh process: reading and checking the file, the log, the hash and the cross-check):
// about 5 ms for the 60-block desk lamp, 5 to 6 ms for the 394 and 426-block examples and 9 ms for a full 1000-block
// assembly. Most of it is cold start: once the code is warm the same files take 0.5 ms (60 blocks) and 4 ms (1000 blocks).
// Cloudflare's CPU is probably slower than this laptop. Workers Free allows 10 ms per request, so on that plan a save of a
// large assembly can fail with Cloudflare's error 1102 (an HTML page, not JSON); the paid plan has no such limit. Measure
// on the deployed Worker; if saves fail there, the plan is the fix. Cutting the per-vertex geometry check is not: it is
// what keeps an uploaded mesh from disagreeing with its blocks, and everyone's viewer renders that mesh.
// There is no per-client throttle in the code: the open API is meant to be fronted by a Cloudflare rate-limiting rule on
// POST /api/assignment_alex/models/*/derived and POST /api/assignment_alex/projects/from-example (about 10 a minute per IP),
// which is configuration, not code. Without it one script can use up the day's DAILY_DERIVED_LIMIT.

import {
    DERIVED_GLB_LIMIT,
    MAX_DERIVED_DEPTH,
    MAX_DERIVED_PER_PROJECT,
    MAX_DERIVED_PER_SOURCE,
    type ModelAsset,
} from "../src/assignment/shared/contract.ts";
import { CELL_STRIDE, assemblyHash } from "../src/assignment/shared/assembly.ts";
import { readAssemblyGlb } from "../src/assignment/shared/assemblyGlb.ts";
import { checkDerivedMeta, readDerivedMeta } from "../src/assignment/shared/derivedMeta.ts";
import { MODEL_COLS, toModelAsset, touchProject, type ModelRow } from "./db.ts";
import { crossCheckDerived } from "./derivedChecks.ts";
import type { Env } from "./providers/types.ts";
import { GLB_CONTENT_TYPE } from "./glb.ts";
import { HttpError, nowIso, readBytes, requireUuid } from "./util.ts";

const DEFAULT_DAILY_DERIVED = 300;

const dailyCap = (env: Env): number => {
    const n = Number(env.DAILY_DERIVED_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_DERIVED;
};

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** Takes one slot of today's cap; false when it is used up. */
async function reserveDerived(env: Env): Promise<boolean> {
    const row = await env.DB.prepare(
        `INSERT INTO usage (day, derived) VALUES (?1, 1)
         ON CONFLICT (day) DO UPDATE SET derived = derived + 1 WHERE derived < ?2
         RETURNING derived`,
    )
        .bind(utcDay(), dailyCap(env))
        .first<{ derived: number }>();
    return row !== null;
}

async function refundDerived(env: Env): Promise<void> {
    await env.DB.prepare("UPDATE usage SET derived = MAX(0, derived - 1) WHERE day = ?1").bind(utcDay()).run().catch(() => {});
}

interface Counts {
    per_source: number;
    per_project: number;
    source_exists: number;
}

const readCounts = (env: Env, sourceId: string, projectId: string): Promise<Counts | null> =>
    env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM models WHERE source_model_id = ?1) AS per_source,
                (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind = 'stabilized') AS per_project,
                EXISTS (SELECT 1 FROM models WHERE id = ?1 AND project_id = ?2) AS source_exists`,
    )
        .bind(sourceId, projectId)
        .first<Counts>();

/** The error for a cap that is used up, else null. */
function capError(counts: Counts | null): HttpError | null {
    if ((counts?.per_source ?? 0) >= MAX_DERIVED_PER_SOURCE) {
        return new HttpError(429, `A model can have at most ${MAX_DERIVED_PER_SOURCE} stabilized versions. Delete one first.`);
    }
    if ((counts?.per_project ?? 0) >= MAX_DERIVED_PER_PROJECT) {
        return new HttpError(429, `A project can hold at most ${MAX_DERIVED_PER_PROJECT} stabilized versions. Delete some first.`);
    }
    return null;
}

/** POST /models/:sourceId/derived. Resolves to the status and the model (201 new, 200 the same result stored before). */
export async function createDerivedModel(env: Env, request: Request, rawSourceId: string): Promise<{ status: 200 | 201; model: ModelAsset }> {
    // Cheapest refusals first: nothing below touches D1 or reads the body until the request looks like an upload.
    const sourceId = requireUuid(rawSourceId, "model id");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== GLB_CONTENT_TYPE) throw new HttpError(415, `The body must be ${GLB_CONTENT_TYPE}`);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > DERIVED_GLB_LIMIT) throw new HttpError(413, "Request body too large");

    const source = await env.DB.prepare(
        `SELECT m.id, m.project_id, m.job_id, m.prompt, m.kind, m.meta, p.deleted_at
         FROM models m JOIN projects p ON p.id = m.project_id WHERE m.id = ?1`,
    )
        .bind(sourceId)
        .first<{ id: string; project_id: string; job_id: string; prompt: string; kind: string; meta: string | null; deleted_at: string | null }>();
    if (!source) throw new HttpError(404, "Model not found");
    if (source.deleted_at) throw new HttpError(409, "This project is in the bin. Restore it first.");

    const bytes = await readBytes(request, DERIVED_GLB_LIMIT);
    // `now` is null on purpose: the reader compares the file with its canonical form, and capping a timestamp to the server's
    // clock would change it, so a browser whose clock runs a second ahead would be refused as "unexpected content".
    // The timestamps are capped below, in what is stored.
    const read = readAssemblyGlb(bytes, null);
    if (!read.ok) throw new HttpError(400, read.error);
    if (!read.meta) throw new HttpError(400, "The GLB does not carry the stabilizer's log.");
    const checked = checkDerivedMeta(read.meta, Date.now());
    if (!checked.ok) throw new HttpError(400, checked.error);
    const meta = checked.value;

    const depth = source.kind === "stabilized" ? (readDerivedMeta(source.meta)?.depth ?? MAX_DERIVED_DEPTH) + 1 : 1;
    if (depth > MAX_DERIVED_DEPTH) throw new HttpError(409, "A model can be stabilized again at most twice.");
    if (meta.depth !== depth) throw new HttpError(400, "The stabilizer's log does not match the model it was made from.");
    const hash = await assemblyHash(read.descriptor);
    if (hash !== meta.assembly_hash) throw new HttpError(400, "The stabilizer's log does not match the blocks.");
    const mismatch = crossCheckDerived(read.descriptor, meta, source.kind !== "stabilized");
    if (mismatch) throw new HttpError(400, mismatch);

    // The same result for the same source is stored once.
    const existing = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE source_model_id = ?1 AND assembly_hash = ?2`)
        .bind(sourceId, hash)
        .first<ModelRow>();
    if (existing) return { status: 200, model: toModelAsset(existing) };

    // A cheap early refusal, before the daily slot and the R2 write. It is not the cap: parallel requests all read the same
    // count here, so the INSERT below checks it again, inside the one statement that adds the row.
    const early = capError(await readCounts(env, sourceId, source.project_id));
    if (early) throw early;
    if (!(await reserveDerived(env))) throw new HttpError(429, "Today's limit of stabilized models is used up. Try again tomorrow.");

    const id = crypto.randomUUID();
    const key = `models/${id}.glb`;
    let row: ModelRow | undefined;
    try {
        await env.FILES.put(key, bytes, { httpMetadata: { contentType: GLB_CONTENT_TYPE } });
        const parts = new Set<number>();
        for (let n = 3; n < read.descriptor.cells.length; n += CELL_STRIDE) parts.add(read.descriptor.cells[n]);
        // INSERT ... SELECT ... WHERE: the caps and "the source still exists" are conditions of the statement, so D1 (which
        // runs statements one at a time) decides them against the rows as they are at that moment. No row comes back when
        // one fails.
        const [inserted] = await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at,
                                     analysis, kind, source_model_id, assembly_hash, meta)
                 SELECT ?1, ?2, ?3, 'stabilizer', ?4, ?5, NULL, ?6, ?7, ?8, ?9, 'stabilized', ?10, ?11, ?12
                 WHERE EXISTS (SELECT 1 FROM models WHERE id = ?10 AND project_id = ?2)
                   AND (SELECT COUNT(*) FROM models WHERE source_model_id = ?10) < ${MAX_DERIVED_PER_SOURCE}
                   AND (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind = 'stabilized') < ${MAX_DERIVED_PER_PROJECT}
                 RETURNING ${MODEL_COLS}`,
            ).bind(id, source.project_id, source.job_id, source.prompt, key, bytes.byteLength, parts.size, nowIso(), JSON.stringify(meta.after_summary), sourceId, hash, JSON.stringify(meta)),
        ]);
        row = (inserted.results as unknown as ModelRow[])[0];
    } catch (err) {
        await env.FILES.delete(key).catch(() => {});
        await refundDerived(env);
        // A second request with the same result got in first (the unique index): that one is the answer.
        if (err instanceof Error && /UNIQUE constraint/i.test(err.message)) {
            const winner = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE source_model_id = ?1 AND assembly_hash = ?2`).bind(sourceId, hash).first<ModelRow>();
            if (winner) return { status: 200, model: toModelAsset(winner) };
        }
        // The project was purged while the file was being checked.
        if (err instanceof Error && /FOREIGN KEY constraint/i.test(err.message)) throw new HttpError(404, "Model not found");
        throw err;
    }
    if (!row) {
        // Nothing was inserted: the condition failed. Undo the file and the daily slot, then say why.
        await env.FILES.delete(key).catch(() => {});
        await refundDerived(env);
        // The same result may have been stored by a request that got in just before (and filled a cap doing it).
        const winner = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE source_model_id = ?1 AND assembly_hash = ?2`).bind(sourceId, hash).first<ModelRow>();
        if (winner) return { status: 200, model: toModelAsset(winner) };
        const counts = await readCounts(env, sourceId, source.project_id);
        if (counts && !counts.source_exists) throw new HttpError(404, "Model not found");
        throw capError(counts) ?? new HttpError(409, "The model changed while it was being saved. Try again.");
    }
    // Outside the try: a failed touch must not delete the file of a row that exists. Saving a version is an edit.
    await touchProject(env, source.project_id).catch(() => {});
    return { status: 201, model: toModelAsset(row) };
}

/** DELETE /models/:id: only a stabilized model can be removed (the originals belong to the project's history). */
export async function deleteDerivedModel(env: Env, rawId: string): Promise<void> {
    const id = requireUuid(rawId, "model id");
    const row = await env.DB.prepare("SELECT kind, glb_key, project_id FROM models WHERE id = ?1").bind(id).first<{ kind: string; glb_key: string; project_id: string }>();
    if (!row) throw new HttpError(404, "Model not found");
    if (row.kind !== "stabilized") throw new HttpError(409, "Only a stabilized version can be deleted.");
    // A stabilized version of this one (depth 2, 3) goes with it: it has no source left.
    const doomed = await env.DB.prepare(
        `WITH RECURSIVE tree(id, glb_key) AS (
             SELECT id, glb_key FROM models WHERE id = ?1
             UNION SELECT m.id, m.glb_key FROM models m JOIN tree t ON m.source_model_id = t.id
         ) SELECT id, glb_key FROM tree`,
    )
        .bind(id)
        .all<{ id: string; glb_key: string }>();
    const ids = JSON.stringify(doomed.results.map((r) => r.id));
    await env.DB.prepare("DELETE FROM models WHERE id IN (SELECT value FROM json_each(?1)) AND kind = 'stabilized'").bind(ids).run();
    const keys = doomed.results.map((r) => r.glb_key).filter((k) => k.startsWith("models/"));
    if (keys.length > 0) await env.FILES.delete(keys).catch(() => {});
    await touchProject(env, row.project_id);
}
