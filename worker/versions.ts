// The rules every row of the version tree obeys, in one place: a model made from another model (stabilized, edited, optimized) is
// counted against the same caps whoever writes it (worker/derived.ts for block versions, worker/editUpload.ts and the edit job's saveModel
// for design and mesh edits). The caps are conditions of the INSERT statement itself: D1 runs statements one at a time, so a COUNT read
// before the INSERT would let parallel requests all see the same number and all pass. The daily counters are one atomic upsert each.
//
// Nothing here knows what a GLB or a log is; it is rows, counts and SQL.

import {
    MAX_MESH_EDITS_PER_PROJECT,
    MAX_VERSIONS_PER_PROJECT,
    MAX_VERSIONS_PER_SOURCE,
    MAX_VERSION_DEPTH,
    type ModelKind,
    type ModelProvider,
} from "../src/assignment/shared/contract.ts";
import { MODEL_COLS } from "./db.ts";
import type { Env } from "./providers/types.ts";
import { HttpError } from "./util.ts";

/** The kinds that are made from another model and can be deleted (the roots are generated and example). */
export const VERSION_KINDS_SQL = "('stabilized', 'edited', 'optimized')";
export type VersionKind = "stabilized" | "edited" | "optimized";

// ---------- Daily counters ----------

const DEFAULT_DAILY_DERIVED = 300;
const DEFAULT_DAILY_EDIT_UPLOADS = 30;

const positiveInt = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};

const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** The two upload counters of the usage table: block versions (stabilized, edited blocks, optimized) and mesh edits (15 to 28 MB each). */
export type UploadCounter = "derived" | "edited";
const COLUMN_CAP: Record<UploadCounter, (env: Env) => number> = {
    derived: (env) => positiveInt(env.DAILY_DERIVED_LIMIT, DEFAULT_DAILY_DERIVED),
    edited: (env) => positiveInt(env.DAILY_EDIT_UPLOAD_LIMIT, DEFAULT_DAILY_EDIT_UPLOADS),
};

/** Takes one slot of today's cap for an upload; false when it is used up. One statement, so parallel requests cannot overshoot. */
export async function reserveUpload(env: Env, counter: UploadCounter): Promise<boolean> {
    // `counter` is one of the two literals above, never request data.
    const row = await env.DB.prepare(
        `INSERT INTO usage (day, ${counter}) VALUES (?1, 1)
         ON CONFLICT (day) DO UPDATE SET ${counter} = ${counter} + 1 WHERE ${counter} < ?2
         RETURNING ${counter} AS n`,
    )
        .bind(utcDay(), COLUMN_CAP[counter](env))
        .first<{ n: number }>();
    return row !== null;
}

/** Gives the slot back (the upload was refused after all). Never throws: a failed refund only costs one slot until midnight. */
export async function refundUpload(env: Env, counter: UploadCounter): Promise<void> {
    await env.DB.prepare(`UPDATE usage SET ${counter} = MAX(0, ${counter} - 1) WHERE day = ?1`).bind(utcDay()).run().catch(() => {});
}

// ---------- The chain above a model ----------

/**
 * A scalar subquery: the number of models on the path from model ?`param` up to its root, itself included (a root counts 1). A new version made from
 * it has that many ancestors, and `MAX_VERSION_DEPTH` is the most it may have. The walk stops one step past the limit, so a chain that is too long
 * (or, in a damaged database, a loop) answers MAX_VERSION_DEPTH + 1 instead of running on.
 */
export const chainLengthSql = (param: string): string =>
    `(WITH RECURSIVE up(id, parent, n) AS (
          SELECT id, source_model_id, 1 FROM models WHERE id = ${param}
          UNION ALL
          SELECT m.id, m.source_model_id, up.n + 1 FROM models m JOIN up ON m.id = up.parent WHERE up.n <= ${MAX_VERSION_DEPTH}
      ) SELECT MAX(n) FROM up)`;

/** 409 when a version made from a model with `chain` models on its path would be more than MAX_VERSION_DEPTH deep. */
export function requireChainRoom(chain: number | null): number {
    const depth = chain ?? 1;
    if (depth > MAX_VERSION_DEPTH) {
        throw new HttpError(409, `Versions can be made from versions at most ${MAX_VERSION_DEPTH} deep. Start from an earlier version.`);
    }
    return depth;
}

// ---------- Caps ----------

export interface VersionCounts {
    per_source: number; // models made from the source, of any kind
    per_project: number; // stabilized, edited and optimized models of the project
    mesh_edits: number; // edited models of the project whose target is "mesh"
    source_exists: number; // 0 or 1
}

/** `CASE WHEN json_valid` first: json_extract on damaged text raises an error that would take the whole statement down. */
export const MESH_EDITS_SQL = `(SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind = 'edited' AND CASE WHEN json_valid(meta) THEN json_extract(meta, '$.target') END = 'mesh')`;

/** The statement of readVersionCounts, for a caller that sends it in a batch with others. */
export const versionCountsStatement = (env: Env, sourceId: string, projectId: string): D1PreparedStatement =>
    env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM models WHERE source_model_id = ?1) AS per_source,
                (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind IN ${VERSION_KINDS_SQL}) AS per_project,
                ${MESH_EDITS_SQL} AS mesh_edits,
                EXISTS (SELECT 1 FROM models WHERE id = ?1 AND project_id = ?2) AS source_exists`,
    ).bind(sourceId, projectId);

export const readVersionCounts = (env: Env, sourceId: string, projectId: string): Promise<VersionCounts | null> =>
    versionCountsStatement(env, sourceId, projectId).first<VersionCounts>();

/** The error for a cap that is used up, else null. `meshEdit`: the row to add is a mesh edit (it also counts against MAX_MESH_EDITS_PER_PROJECT). */
export function versionCapError(counts: VersionCounts | null, meshEdit = false): HttpError | null {
    if ((counts?.per_source ?? 0) >= MAX_VERSIONS_PER_SOURCE) {
        return new HttpError(429, `A model can have at most ${MAX_VERSIONS_PER_SOURCE} versions made from it. Delete one first.`);
    }
    if ((counts?.per_project ?? 0) >= MAX_VERSIONS_PER_PROJECT) {
        return new HttpError(429, `A project can hold at most ${MAX_VERSIONS_PER_PROJECT} versions. Delete some first.`);
    }
    if (meshEdit && (counts?.mesh_edits ?? 0) >= MAX_MESH_EDITS_PER_PROJECT) {
        return new HttpError(429, `A project can hold at most ${MAX_MESH_EDITS_PER_PROJECT} edited 3D models (each is large). Delete one first.`);
    }
    return null;
}

// ---------- The one INSERT ----------

/** Every column of a new version row that the caller decides; the rest (thumb_key) is NULL. */
export interface NewVersion {
    id: string;
    projectId: string;
    jobId: string;
    provider: ModelProvider;
    prompt: string;
    glbKey: string;
    sizeBytes: number;
    partCount: number | null;
    createdAt: string;
    /** The AnalysisSummary as JSON, or null (a design or mesh edit gets its analysis from the browser later). */
    analysis: string | null;
    kind: Extract<ModelKind, VersionKind>;
    sourceId: string;
    assemblyHash: string | null;
    /** DerivedMeta, EditMeta or OptimizeSummary as JSON. */
    meta: string;
    /** The row is an edit whose target is "mesh": it also has to fit under MAX_MESH_EDITS_PER_PROJECT. */
    meshEdit?: boolean;
}

/**
 * INSERT ... SELECT ... WHERE: "the source still exists in this project" and every cap are conditions of the statement, so the rows as they are at
 * that moment decide. No row comes back when one fails (`.all()` on a batch result is then empty); a UNIQUE violation (the same source and
 * hash stored by a request that got in first) is an error of the batch. The caller runs it alone or in a batch with other statements.
 */
export function versionInsert(env: Env, v: NewVersion): D1PreparedStatement {
    return env.DB.prepare(
        `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at,
                             analysis, kind, source_model_id, assembly_hash, meta)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
         WHERE EXISTS (SELECT 1 FROM models WHERE id = ?12 AND project_id = ?2)
           AND (SELECT COUNT(*) FROM models WHERE source_model_id = ?12) < ${MAX_VERSIONS_PER_SOURCE}
           AND (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind IN ${VERSION_KINDS_SQL}) < ${MAX_VERSIONS_PER_PROJECT}
           ${v.meshEdit ? `AND ${MESH_EDITS_SQL} < ${MAX_MESH_EDITS_PER_PROJECT}` : ""}
         RETURNING ${MODEL_COLS}`,
    ).bind(v.id, v.projectId, v.jobId, v.provider, v.prompt, v.glbKey, v.sizeBytes, v.partCount, v.createdAt, v.analysis, v.kind, v.sourceId, v.assemblyHash, v.meta);
}
