// Block versions: POST /models/:sourceId/derived stores the block assembly the browser built, DELETE /models/:id removes a version.
// Three kinds of version arrive here, told apart by the log the GLB carries (exactly one):
//   - "nevo:stabilization" the stabilizer's result            -> kind 'stabilized', provider 'stabilizer'
//   - "nevo:edit"          a block edit made by words          -> kind 'edited' (EditMeta.target "voxel"), provider 'editor'
//   - "nevo:optimization"  the optimizer's result              -> kind 'optimized', provider 'optimizer'
// (A design or mesh edit is not a block assembly; worker/edit.ts and worker/editUpload.ts store those.)
//
// The site has no login and anyone can call this, so nothing the client says is believed:
//   - the body must be EXACTLY a GLB that shared/assemblyGlb.ts would write (every vertex, normal and index is checked
//     against the cells in its own descriptor), at most DERIVED_GLB_LIMIT (1 MiB; a full 1000-block assembly is 650 KB);
//   - the log inside it is validated field by field and bounded (DERIVED_META_LIMIT, 32 KB), and rebuilt: what the row keeps
//     is the Worker's own slim copy (EditMeta from summarizeVoxelEdit, OptimizeSummary from summarizeOptimize; D15), with the
//     chain depth the Worker counted itself;
//   - the hash it states must be the hash of the cells, the stabilization count must follow from the source (shared/versionMeta.ts
//     stabilizationsOf), and the counts in the log (blocks, blocks added, per role, per step) must be what the cells say
//     (derivedChecks.ts for the stabilizer, editChecks.ts for an edit, shared/optimizeMeta.ts crossCheckOptimized); an edit's or an
//     optimization's "before" must be the block count the source's own saved analysis has (a block version always has one);
//   - the key in R2 is generated here, the content type is forced, and the number of versions is capped per source, per project and
//     per day. The per-source and per-project caps are part of the INSERT itself (worker/versions.ts: a COUNT before it would let
//     parallel requests all see the same count); the daily counter is one atomic upsert. DELETE removes a subtree in one statement that
//     also returns the files to remove, so a save under a version that is going away is either deleted with it or refused (404), never kept
//     with a parent that is gone.
// The claims in the log about stress (that it "passes all checks", the before/after numbers) are the client's: they are
// derived data, like PUT /models/:id/analysis, and the Stability tab recomputes the verdict from the geometry every time it
// opens. The same blocks are stored once per source: a second upload of them, even with a log made under other settings
// (material, target) or another kind of log, is answered with the model that is there, not a second row.
// CPU (Node on an M-series laptop, a fresh process: reading and checking the file, the log, the hash and the cross-check):
// about 5 ms for the 60-block desk lamp, 5 to 6 ms for the 394 and 426-block examples and 9 ms for a full 1000-block
// assembly. Most of it is cold start: once the code is warm the same files take 0.5 ms (60 blocks) and 4 ms (1000 blocks).
// The edit and optimization logs add at most 1 ms (one pass over the cells). Cloudflare's CPU is probably slower than this
// laptop. Workers Free allows 10 ms per request, so on that plan a save of a large assembly can fail with Cloudflare's error
// 1102 (an HTML page, not JSON); the paid plan has no such limit. Measure on the deployed Worker; if saves fail there, the plan
// is the fix. Cutting the per-vertex geometry check is not: it is what keeps an uploaded mesh from disagreeing with its blocks,
// and everyone's viewer renders that mesh.
// There is no per-client throttle in the code: the open API is meant to be fronted by a Cloudflare rate-limiting rule on
// POST /api/assignment_alex/models/*/derived (and .../edits, .../edited, /llm/*) and POST /api/assignment_alex/projects/from-example
// (about 10 a minute per IP), which is configuration, not code. Without it one script can use up the day's DAILY_DERIVED_LIMIT.

import {
    DERIVED_GLB_LIMIT,
    EDIT_META_LIMIT,
    MAX_DERIVED_DEPTH,
    OPTIMIZE_SUMMARY_LIMIT,
    type AnalysisSummary,
    type ModelAsset,
    type ModelKind,
    type ModelProvider,
} from "../src/assignment/shared/contract.ts";
import { CELL_STRIDE, assemblyHash } from "../src/assignment/shared/assembly.ts";
import { readAssemblyGlb, type ReadAssemblyResult } from "../src/assignment/shared/assemblyGlb.ts";
import { checkDerivedMeta } from "../src/assignment/shared/derivedMeta.ts";
import { checkOptimizeMeta, crossCheckOptimized, summarizeOptimize } from "../src/assignment/shared/optimizeMeta.ts";
import { representationOf, stabilizationsOf } from "../src/assignment/shared/versionMeta.ts";
import { checkVoxelEditLog, summarizeVoxelEdit } from "../src/assignment/shared/voxelEdit/log.ts";
import { readStoredAnalysis } from "./analysis.ts";
import { MODEL_COLS, toModelAsset, touchProject, type ModelRow } from "./db.ts";
import { crossCheckDerived } from "./derivedChecks.ts";
import { crossCheckVoxelEdit } from "./editChecks.ts";
import { GLB_CONTENT_TYPE } from "./glb.ts";
import type { Env } from "./providers/types.ts";
import { HttpError, nowIso, readBytes, requireUuid } from "./util.ts";
import {
    VERSION_KINDS_SQL,
    chainLengthSql,
    readVersionCounts,
    refundUpload,
    requireChainRoom,
    reserveUpload,
    versionCapError,
    versionCountsStatement,
    versionInsert,
    type VersionCounts,
    type VersionKind,
} from "./versions.ts";

interface SourceRow {
    id: string;
    project_id: string;
    job_id: string;
    prompt: string;
    kind: ModelKind;
    meta: string | null;
    assembly_hash: string | null;
    analysis: string | null;
    deleted_at: string | null;
    /** Models on the path from the source up to its root, itself included (a root: 1). */
    chain: number | null;
}

/** An upload that passed every check: what the new row keeps. */
interface Accepted {
    kind: VersionKind;
    provider: ModelProvider;
    hash: string;
    /** The verdict of the result, stored in models.analysis. */
    summary: AnalysisSummary;
    /** What goes in models.meta: DerivedMeta, EditMeta (slim) or OptimizeSummary. */
    meta: unknown;
}

const bad = (message: string): HttpError => new HttpError(400, message);

/** The stabilizer's result. The depth counts stabilizations only: an edit between two of them does not use one up. */
function acceptStabilization(source: SourceRow, read: Extract<ReadAssemblyResult, { ok: true }>, hash: string): Accepted {
    const checked = checkDerivedMeta(read.meta, Date.now());
    if (!checked.ok) throw bad(checked.error);
    const meta = checked.value;
    const depth = stabilizationsOf(source) + 1;
    if (depth > MAX_DERIVED_DEPTH) throw new HttpError(409, "A model can be stabilized again at most twice.");
    if (meta.depth !== depth) throw bad("The stabilizer's log does not match the model it was made from.");
    if (hash !== meta.assembly_hash) throw bad("The stabilizer's log does not match the blocks.");
    // D14: a first run is the stabilizer working on a mesh (generated, example, an edited design or mesh); every other source is already a block
    // assembly whose blocks keep their roles and steps, and this run's steps are numbered after them.
    const mismatch = crossCheckDerived(read.descriptor, meta, representationOf(source) === "mesh");
    if (mismatch) throw bad(mismatch);
    return { kind: "stabilized", provider: "stabilizer", hash, summary: meta.after_summary, meta };
}

/** A block edit made by words. */
function acceptVoxelEdit(source: SourceRow, read: Extract<ReadAssemblyResult, { ok: true }>, hash: string, depth: number): Accepted {
    const checked = checkVoxelEditLog(read.edit, Date.now());
    if (!checked.ok) throw bad(checked.error);
    const log = checked.value;
    if (log.stabilized_depth !== stabilizationsOf(source)) throw bad("The edit log's stabilization count does not match the model it was made from.");
    // A mesh has no steps of its own (its blocks are the voxelised mesh, all step 0), so an edit of one starts at 0.
    if (representationOf(source) === "mesh" && log.base_steps !== 0) throw bad("The edit log does not match the model it was made from.");
    if (hash !== log.assembly_hash) throw bad("The edit log does not match the blocks.");
    const mismatch = crossCheckVoxelEdit(read.descriptor, log);
    if (mismatch) throw bad(mismatch);
    // The verdict the browser stored for the source (when it has) must be the one the edit started from: the same model has the same blocks.
    const prior = readStoredAnalysis(source.analysis);
    if (prior && log.before.blocks !== prior.blocks) throw bad("The edit log was made from a different model than the one it is saved on.");
    // The row keeps the Worker's own slim copy, with the depth it counted (D15); the full log stays in the GLB.
    const meta = summarizeVoxelEdit(log, { depth });
    if (JSON.stringify(meta).length > EDIT_META_LIMIT) throw bad(`The edit log is larger than ${EDIT_META_LIMIT} bytes.`);
    return { kind: "edited", provider: "editor", hash, summary: log.after_summary, meta };
}

/** The optimizer's result. */
function acceptOptimization(source: SourceRow, read: Extract<ReadAssemblyResult, { ok: true }>, hash: string): Accepted {
    const checked = checkOptimizeMeta(read.optimization, Date.now());
    if (!checked.ok) throw bad(checked.error);
    const log = checked.value;
    if (log.stabilized_depth !== stabilizationsOf(source)) throw bad("The optimization log's stabilization count does not match the model it was made from.");
    if (hash !== log.assembly_hash) throw bad("The optimization log does not match the blocks.");
    // A block version's assembly_hash is the hash of its cells; the other kinds store a different hash (a design's) or none, so a mesh source passes null.
    const blockSource = representationOf(source) === "blocks";
    const mismatch = crossCheckOptimized(read.descriptor, log, { kind: source.kind, assembly_hash: blockSource ? source.assembly_hash : null });
    if (mismatch) throw bad(mismatch);
    // The log's "before" must be the model it is saved on (as for a block edit): the same model has the same blocks. Without this the counts are
    // only consistent with each other, and a no-op could be saved as "300 blocks removed, 93 % lighter". A block version always has its verdict
    // (the Worker stored it from the log that made it, and its block count was checked against the cells), so there it is required; a mesh has a
    // verdict only once the browser has saved one, and is compared when it has.
    const prior = readStoredAnalysis(source.analysis);
    if (blockSource && !prior) throw bad("The model this optimization was made from has no saved analysis to check it against.");
    if (prior && log.before.blocks !== prior.blocks) throw bad("The optimization log was made from a different model than the one it is saved on.");
    // (With `before` fixed, the removed count is forced: crossCheckOptimized made before - removed + added the file's blocks, and added <= those.)
    const meta = summarizeOptimize(log);
    if (JSON.stringify(meta).length > OPTIMIZE_SUMMARY_LIMIT) throw bad(`The optimization log is larger than ${OPTIMIZE_SUMMARY_LIMIT} bytes.`);
    return { kind: "optimized", provider: "optimizer", hash, summary: log.after_summary, meta };
}

/** POST /models/:sourceId/derived. Resolves to the status and the model (201 new, 200 the same result stored before). */
export async function createDerivedModel(env: Env, request: Request, rawSourceId: string): Promise<{ status: 200 | 201; model: ModelAsset }> {
    // Cheapest refusals first: nothing below touches D1 or reads the body until the request looks like an upload.
    const sourceId = requireUuid(rawSourceId, "model id");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== GLB_CONTENT_TYPE) throw new HttpError(415, `The body must be ${GLB_CONTENT_TYPE}`);
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > DERIVED_GLB_LIMIT) throw new HttpError(413, "Request body too large");

    // One statement: the source, its project's state, and how deep it sits in the tree (a walk of at most MAX_VERSION_DEPTH + 1 rows).
    const source = await env.DB.prepare(
        `SELECT m.id, m.project_id, m.job_id, m.prompt, m.kind, m.meta, m.assembly_hash, m.analysis, p.deleted_at, ${chainLengthSql("?1")} AS chain
         FROM models m JOIN projects p ON p.id = m.project_id WHERE m.id = ?1`,
    )
        .bind(sourceId)
        .first<SourceRow>();
    if (!source) throw new HttpError(404, "Model not found");
    if (source.deleted_at) throw new HttpError(409, "This project is in the bin. Restore it first.");
    // The version to add would have `chain` ancestors; this does not depend on the body, so it is refused before the body is read.
    const depth = requireChainRoom(source.chain);

    const bytes = await readBytes(request, DERIVED_GLB_LIMIT);
    // `now` is null on purpose: the reader compares the file with its canonical form, and capping a timestamp to the server's
    // clock would change it, so a browser whose clock runs a second ahead would be refused as "unexpected content".
    // The timestamps are capped below, in what is stored.
    const read = readAssemblyGlb(bytes, null);
    if (!read.ok) throw bad(read.error);
    // Exactly one log (the reader already refuses a file that carries two).
    const logs = [read.meta, read.edit, read.optimization].filter(Boolean).length;
    if (logs !== 1) throw bad("The GLB does not carry a log: the stabilizer's, an edit's or the optimizer's.");

    const hash = await assemblyHash(read.descriptor);
    const accepted = read.meta ? acceptStabilization(source, read, hash) : read.edit ? acceptVoxelEdit(source, read, hash, depth) : acceptOptimization(source, read, hash);

    // The same result for the same source is stored once. The caps are read in the same round trip: a cheap early refusal, before the
    // daily slot and the R2 write. It is not the cap: parallel requests all read the same count here, so the INSERT below checks it again.
    const [existing, counts] = await env.DB.batch([
        env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE source_model_id = ?1 AND assembly_hash = ?2`).bind(sourceId, hash),
        versionCountsStatement(env, sourceId, source.project_id),
    ]);
    const stored = (existing.results as unknown as ModelRow[])[0];
    if (stored) return { status: 200, model: toModelAsset(stored) };
    const early = versionCapError((counts.results as unknown as VersionCounts[])[0] ?? null);
    if (early) throw early;
    if (!(await reserveUpload(env, "derived"))) throw new HttpError(429, "Today's limit of saved versions is used up. Try again tomorrow.");

    const id = crypto.randomUUID();
    const key = `models/${id}.glb`;
    let row: ModelRow | undefined;
    try {
        await env.FILES.put(key, bytes, { httpMetadata: { contentType: GLB_CONTENT_TYPE } });
        const roles = new Set<number>();
        for (let n = 3; n < read.descriptor.cells.length; n += CELL_STRIDE) roles.add(read.descriptor.cells[n]);
        const [inserted] = await env.DB.batch([
            versionInsert(env, {
                id,
                projectId: source.project_id,
                jobId: source.job_id,
                provider: accepted.provider,
                prompt: source.prompt,
                glbKey: key,
                sizeBytes: bytes.byteLength,
                partCount: roles.size,
                createdAt: nowIso(),
                analysis: JSON.stringify(accepted.summary),
                kind: accepted.kind,
                sourceId,
                assemblyHash: hash,
                meta: JSON.stringify(accepted.meta),
            }),
        ]);
        row = (inserted.results as unknown as ModelRow[])[0];
    } catch (err) {
        await env.FILES.delete(key).catch(() => {});
        await refundUpload(env, "derived");
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
        await refundUpload(env, "derived");
        // The same result may have been stored by a request that got in just before (and filled a cap doing it).
        const winner = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE source_model_id = ?1 AND assembly_hash = ?2`).bind(sourceId, hash).first<ModelRow>();
        if (winner) return { status: 200, model: toModelAsset(winner) };
        const after = await readVersionCounts(env, sourceId, source.project_id);
        if (after && !after.source_exists) throw new HttpError(404, "Model not found");
        throw versionCapError(after) ?? new HttpError(409, "The model changed while it was being saved. Try again.");
    }
    // Outside the try: a failed touch must not delete the file of a row that exists. Saving a version is an edit.
    await touchProject(env, source.project_id).catch(() => {});
    return { status: 201, model: toModelAsset(row) };
}

/**
 * DELETE /models/:id: a version of any kind (stabilized, edited, optimized) goes, and every version made from it (its subtree).
 * The roots (generated, example) belong to the project's history and are refused (409).
 */
export async function deleteVersion(env: Env, rawId: string): Promise<void> {
    const id = requireUuid(rawId, "model id");
    const row = await env.DB.prepare("SELECT kind, project_id FROM models WHERE id = ?1").bind(id).first<{ kind: string; project_id: string }>();
    if (!row) throw new HttpError(404, "Model not found");
    if (row.kind !== "stabilized" && row.kind !== "edited" && row.kind !== "optimized") throw new HttpError(409, "Only a version made from another model can be deleted.");
    // A version made from this one (a stabilization, an edit, an optimization, at any depth) goes with it: it has no source left.
    // One statement finds the subtree and deletes it, and hands back exactly the files of the rows it deleted. Reading the subtree first and
    // deleting by that list in a second statement left a window for a save under a doomed version (its INSERT checks "the source exists",
    // which still held): the new row survived with a parent that was gone. Now such a save lands either inside the subtree (and goes with
    // it, file included) or after it (and is refused, 404, because its source is gone).
    const gone = await env.DB.prepare(
        `DELETE FROM models
         WHERE kind IN ${VERSION_KINDS_SQL}
           AND id IN (
               WITH RECURSIVE tree(id) AS (
                   SELECT id FROM models WHERE id = ?1
                   UNION SELECT m.id FROM models m JOIN tree t ON m.source_model_id = t.id
               ) SELECT id FROM tree
           )
         RETURNING glb_key`,
    )
        .bind(id)
        .all<{ glb_key: string }>();
    // Only our own files: "static:" keys (examples) never reach R2.
    const keys = gone.results.map((r) => r.glb_key).filter((k) => k.startsWith("models/"));
    if (keys.length > 0) await env.FILES.delete(keys).catch(() => {});
    await touchProject(env, row.project_id);
}
