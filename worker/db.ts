// D1 data layer: row types, mapping to the REST contract, and the project/tag queries.
// Prepared statements only. Lists of ids go in as one JSON parameter through json_each(),
// which sidesteps D1's limit of 100 bound parameters per statement.

import { API_BASE } from "../src/assignment/shared/contract.ts";
import type {
    AnalysisSummary,
    BulkAction,
    DerivedMeta,
    HubProject,
    HubTag,
    Job,
    JobStatus,
    ModelAsset,
    ModelKind,
    ModelProvider,
    ProjectData,
    ProjectDetail,
    ProviderId,
} from "../src/assignment/shared/contract.ts";
import { readStoredAnalysis } from "./analysis.ts";
import { stagingKeys } from "./providers/openrouter.ts";
import type { Env } from "./providers/types.ts";
import { DEFAULT_PROJECT_NAME, HttpError, errorSummary, isRecord, nowIso } from "./util.ts";

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PROJECTS = 500;
export const MAX_TAGS = 100;

// ---------- Rows ----------

export interface ProjectRow {
    id: string;
    name: string;
    created_at: string;
    modified_at: string;
    deleted_at: string | null;
    archived_at: string | null;
    pinned: number;
    thumbnail_key: string | null;
    thumbnail_version: number;
    model_count: number;
}

export interface TagRow {
    id: string;
    name: string;
    icon: string | null;
    color: string;
    created_at: string;
}

export interface ModelRow {
    id: string;
    project_id: string;
    job_id: string;
    provider: string;
    prompt: string;
    glb_key: string;
    thumb_key: string | null;
    size_bytes: number;
    part_count: number | null;
    created_at: string;
    analysis: string | null; // AnalysisSummary as JSON
    kind: string; // ModelKind
    source_model_id: string | null;
    example_slug: string | null;
    assembly_hash: string | null;
    meta: string | null; // DerivedMeta as JSON (kind 'stabilized')
}

export interface JobRow {
    id: string;
    project_id: string;
    provider: string;
    via: string;
    prompt: string;
    status: string;
    progress: number;
    stage: string;
    error: string | null;
    provider_task_id: string | null;
    provider_state: string | null;
    created_at: string;
    updated_at: string;
    polled_at: string | null;
    finished_at: string | null;
    model_id: string | null;
    poll_errors: number;
    finalize_attempts: number;
}

const PROJECT_COLS =
    "p.id, p.name, p.created_at, p.modified_at, p.deleted_at, p.archived_at, p.pinned, p.thumbnail_key, " +
    "p.thumbnail_version, (SELECT COUNT(*) FROM models m WHERE m.project_id = p.id) AS model_count";
const TAG_COLS = "id, name, icon, color, created_at";
export const MODEL_COLS =
    "id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at, analysis, " +
    "kind, source_model_id, example_slug, assembly_hash, meta";

/** glb_key of a model whose file ships with the site (a bundled example), shared by every project made from it. */
export const STATIC_KEY_PREFIX = "static:";
export const isStaticKey = (key: string): boolean => key.startsWith(STATIC_KEY_PREFIX);
export const JOB_COLS =
    "id, project_id, provider, via, prompt, status, progress, stage, error, provider_task_id, provider_state, " +
    "created_at, updated_at, polled_at, finished_at, model_id, poll_errors, finalize_attempts";

// ---------- Mapping ----------

/**
 * A stored stabilizer log. This is the read path of every project (up to 20 logs of up to 32 KB each), so it parses and
 * checks the shape only: both writers (worker/derived.ts and worker/examples.ts) store what checkDerivedMeta rebuilt, field
 * by field, and nothing else writes the column. Running the full validation on each read cost about 0.2 ms a log, which is
 * a visible share of a Workers Free request (10 ms of CPU) when a project is full of them.
 */
export function readStoredDerivedMeta(raw: string | null): DerivedMeta | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (isRecord(value) && value.version === 1 && Array.isArray(value.steps) && isRecord(value.after_summary) && typeof value.assembly_hash === "string") {
            return value as unknown as DerivedMeta;
        }
    } catch {
        // damaged: the model then shows no log
    }
    return null;
}

export function toHubProject(row: ProjectRow, tagIds: string[]): HubProject {
    return {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        modified_at: row.modified_at,
        deleted_at: row.deleted_at,
        archived_at: row.archived_at,
        pinned: row.pinned === 1,
        thumbnail_url: row.thumbnail_key
            ? `${API_BASE}/files/thumbs/${row.id}.webp?v=${row.thumbnail_version}`
            : null,
        tag_ids: tagIds,
        model_count: row.model_count,
    };
}

export function toTag(row: TagRow): HubTag {
    return { id: row.id, name: row.name, icon: row.icon, color: row.color, created_at: row.created_at };
}

export function toModelAsset(row: ModelRow): ModelAsset {
    return {
        id: row.id,
        project_id: row.project_id,
        job_id: row.job_id,
        provider: row.provider as ModelProvider,
        prompt: row.prompt,
        // An example's file is a static asset of the site (key "static:/assignment_alex/examples/<slug>/original.glb").
        glb_url: isStaticKey(row.glb_key) ? row.glb_key.slice(STATIC_KEY_PREFIX.length) : `${API_BASE}/files/models/${row.id}.glb`,
        thumbnail_url: row.thumb_key ? (row.thumb_key.startsWith("/") ? row.thumb_key : `${API_BASE}/files/${row.thumb_key}`) : null,
        size_bytes: row.size_bytes,
        part_count: row.part_count,
        created_at: row.created_at,
        analysis: readStoredAnalysis(row.analysis),
        kind: (row.kind as ModelKind) ?? "generated",
        source_model_id: row.source_model_id,
        example_slug: row.example_slug,
        derived: row.kind === "stabilized" ? readStoredDerivedMeta(row.meta) : null,
    };
}

export function toJob(row: JobRow, model: ModelAsset | null): Job {
    return {
        id: row.id,
        project_id: row.project_id,
        provider: row.provider as ProviderId,
        prompt: row.prompt,
        status: row.status as JobStatus,
        progress: row.progress,
        stage: row.stage,
        error: row.error,
        created_at: row.created_at,
        updated_at: row.updated_at,
        finished_at: row.finished_at,
        model,
    };
}

function parseProjectData(raw: string): ProjectData {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Array.isArray((parsed as ProjectData).messages)) {
            const data = parsed as ProjectData;
            return { ...data, active_model_id: data.active_model_id ?? null };
        }
    } catch {
        // fall through to the empty state
    }
    return { messages: [], active_model_id: null };
}

// ---------- Projects ----------

function groupTagIds(links: Array<{ project_id: string; tag_id: string }>): Map<string, string[]> {
    const byProject = new Map<string, string[]>();
    for (const link of links) {
        const list = byProject.get(link.project_id);
        if (list) list.push(link.tag_id);
        else byProject.set(link.project_id, [link.tag_id]);
    }
    return byProject;
}

/** Everything the hub shows: every project (trashed and archived included) and every tag. */
export async function listProjectsAndTags(env: Env): Promise<{ projects: HubProject[]; tags: HubTag[] }> {
    // Housekeeping must never take the hub down: a failed purge is logged and tried again on the next load.
    await purgeExpiredTrash(env).catch((err) => console.error(`trash purge failed: ${errorSummary(err)}`));
    const [projects, links, tags] = await env.DB.batch([
        env.DB.prepare(`SELECT ${PROJECT_COLS} FROM projects p ORDER BY p.modified_at DESC, p.created_at DESC`),
        env.DB.prepare("SELECT project_id, tag_id FROM project_tags ORDER BY created_at"),
        env.DB.prepare(`SELECT ${TAG_COLS} FROM tags ORDER BY lower(name), created_at`),
    ]);
    const tagIds = groupTagIds(links.results as Array<{ project_id: string; tag_id: string }>);
    return {
        projects: (projects.results as unknown as ProjectRow[]).map((row) =>
            toHubProject(row, tagIds.get(row.id) ?? []),
        ),
        tags: (tags.results as unknown as TagRow[]).map(toTag),
    };
}

export async function getHubProject(env: Env, id: string): Promise<HubProject | null> {
    const [project, links] = await env.DB.batch([
        env.DB.prepare(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = ?1`).bind(id),
        env.DB.prepare("SELECT tag_id FROM project_tags WHERE project_id = ?1 ORDER BY created_at").bind(id),
    ]);
    const row = (project.results as unknown as ProjectRow[])[0];
    if (!row) return null;
    return toHubProject(
        row,
        (links.results as Array<{ tag_id: string }>).map((l) => l.tag_id),
    );
}

export async function getProjectDetail(env: Env, id: string): Promise<ProjectDetail | null> {
    const [project, links, data, models, jobs] = await env.DB.batch([
        env.DB.prepare(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = ?1`).bind(id),
        env.DB.prepare("SELECT tag_id FROM project_tags WHERE project_id = ?1 ORDER BY created_at").bind(id),
        env.DB.prepare("SELECT data FROM projects WHERE id = ?1").bind(id),
        env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE project_id = ?1 ORDER BY created_at, rowid`).bind(id),
        env.DB.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE project_id = ?1 ORDER BY created_at, rowid`).bind(id),
    ]);
    const row = (project.results as unknown as ProjectRow[])[0];
    if (!row) return null;
    const modelRows = models.results as unknown as ModelRow[];
    const assets = new Map(modelRows.map((m) => [m.id, toModelAsset(m)]));
    return {
        ...toHubProject(
            row,
            (links.results as Array<{ tag_id: string }>).map((l) => l.tag_id),
        ),
        data: parseProjectData((data.results as Array<{ data: string }>)[0]?.data ?? ""),
        models: [...assets.values()],
        jobs: (jobs.results as unknown as JobRow[]).map((j) =>
            toJob(j, j.model_id ? (assets.get(j.model_id) ?? null) : null),
        ),
    };
}

export async function projectExists(env: Env, id: string): Promise<{ deleted_at: string | null } | null> {
    return env.DB.prepare("SELECT deleted_at FROM projects WHERE id = ?1")
        .bind(id)
        .first<{ deleted_at: string | null }>();
}

export async function createProject(env: Env, name: string | undefined, tagId: string | undefined): Promise<HubProject> {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PROJECTS) {
        throw new HttpError(429, "Project limit reached. Delete some projects first.");
    }
    if (tagId && !(await env.DB.prepare("SELECT 1 AS ok FROM tags WHERE id = ?1").bind(tagId).first())) {
        throw new HttpError(404, "Tag not found");
    }
    const id = crypto.randomUUID();
    const now = nowIso();
    const statements = [
        env.DB.prepare(
            "INSERT INTO projects (id, name, created_at, modified_at) VALUES (?1, ?2, ?3, ?3)",
        ).bind(id, name ?? DEFAULT_PROJECT_NAME, now),
    ];
    if (tagId) {
        statements.push(
            env.DB.prepare("INSERT INTO project_tags (project_id, tag_id, created_at) VALUES (?1, ?2, ?3)").bind(
                id,
                tagId,
                now,
            ),
        );
    }
    await env.DB.batch(statements);
    const project = await getHubProject(env, id);
    if (!project) throw new Error("project vanished after insert");
    return project;
}

export interface ProjectPatch {
    name?: string;
    pinned?: boolean;
    data?: ProjectData;
}

/** Renames, pins or saves workspace data. Pinning does not count as an edit; the rest bump modified_at. */
export async function patchProject(env: Env, id: string, patch: ProjectPatch): Promise<HubProject> {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    const add = (column: string, value: string | number) => {
        values.push(value);
        sets.push(`${column} = ?${values.length}`);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.data !== undefined) add("data", JSON.stringify(patch.data));
    if (patch.pinned !== undefined) add("pinned", patch.pinned ? 1 : 0);
    if (patch.name !== undefined || patch.data !== undefined) add("modified_at", nowIso());
    if (sets.length > 0) {
        values.push(id);
        const result = await env.DB.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?${values.length}`)
            .bind(...values)
            .run();
        if (result.meta.changes !== 1) throw new HttpError(404, "Project not found");
    }
    const project = await getHubProject(env, id);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
}

/**
 * Stores the client's analysis of a model. Derived data, so the project's modified_at is left alone (an
 * "Edited just now" label should mean a person edited it). Null when the model does not exist.
 */
export async function saveModelAnalysis(env: Env, id: string, summary: AnalysisSummary): Promise<ModelAsset | null> {
    const row = await env.DB.prepare(`UPDATE models SET analysis = ?1 WHERE id = ?2 RETURNING ${MODEL_COLS}`)
        .bind(JSON.stringify(summary), id)
        .first<ModelRow>();
    return row ? toModelAsset(row) : null;
}

export async function touchProject(env: Env, id: string): Promise<void> {
    await env.DB.prepare("UPDATE projects SET modified_at = ?1 WHERE id = ?2").bind(nowIso(), id).run();
}

// ---------- Bulk actions ----------

export async function bulkProjects(env: Env, ids: string[], action: BulkAction): Promise<number> {
    const idList = JSON.stringify(ids);
    const now = nowIso();
    let statement: D1PreparedStatement;
    switch (action) {
        case "trash":
            statement = env.DB.prepare(
                "UPDATE projects SET deleted_at = ?1 WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?2))",
            ).bind(now, idList);
            break;
        case "restore":
            statement = env.DB.prepare(
                "UPDATE projects SET deleted_at = NULL WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))",
            ).bind(idList);
            break;
        case "archive":
            statement = env.DB.prepare(
                `UPDATE projects SET archived_at = ?1 WHERE archived_at IS NULL AND deleted_at IS NULL
                 AND id IN (SELECT value FROM json_each(?2))`,
            ).bind(now, idList);
            break;
        case "unarchive":
            statement = env.DB.prepare(
                "UPDATE projects SET archived_at = NULL WHERE archived_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))",
            ).bind(idList);
            break;
        case "purge": {
            // Only trashed projects can be deleted for good.
            const trashed = await env.DB.prepare(
                "SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))",
            )
                .bind(idList)
                .all<{ id: string }>();
            return purgeProjects(
                env,
                trashed.results.map((r) => r.id),
            );
        }
    }
    const result = await statement.run();
    return result.meta.changes;
}

/** Adds or removes one tag on many projects (an edit: bumps modified_at only where something changes). */
export async function bulkTag(env: Env, ids: string[], tagId: string, add: boolean): Promise<number> {
    if (!(await env.DB.prepare("SELECT 1 AS ok FROM tags WHERE id = ?1").bind(tagId).first())) {
        throw new HttpError(404, "Tag not found");
    }
    const idList = JSON.stringify(ids);
    const now = nowIso();
    const statements = add
        ? [
              env.DB.prepare(
                  `UPDATE projects SET modified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))
                   AND NOT EXISTS (SELECT 1 FROM project_tags t WHERE t.project_id = projects.id AND t.tag_id = ?3)`,
              ).bind(now, idList, tagId),
              env.DB.prepare(
                  `INSERT OR IGNORE INTO project_tags (project_id, tag_id, created_at)
                   SELECT p.id, ?1, ?2 FROM projects p WHERE p.id IN (SELECT value FROM json_each(?3))`,
              ).bind(tagId, now, idList),
          ]
        : [
              env.DB.prepare(
                  `UPDATE projects SET modified_at = ?1 WHERE id IN (SELECT value FROM json_each(?2))
                   AND EXISTS (SELECT 1 FROM project_tags t WHERE t.project_id = projects.id AND t.tag_id = ?3)`,
              ).bind(now, idList, tagId),
              env.DB.prepare(
                  "DELETE FROM project_tags WHERE tag_id = ?1 AND project_id IN (SELECT value FROM json_each(?2))",
              ).bind(tagId, idList),
          ];
    const results = await env.DB.batch(statements);
    return results[1].meta.changes;
}

// ---------- Deleting for good ----------

/** Removes projects, their jobs/models/tag links, and every R2 object they own. Returns how many went. */
export async function purgeProjects(env: Env, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const idList = JSON.stringify(ids);
    // Every statement re-checks that the project is still trashed, so a restore that lands between the caller's
    // lookup and this batch wins: the project is left alone instead of being deleted under the user.
    const trashed = "(SELECT id FROM projects WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1)))";
    const keys = await env.DB.prepare(
        `SELECT glb_key AS k FROM models WHERE glb_key NOT LIKE 'static:%' AND project_id IN ${trashed}
         UNION SELECT thumb_key FROM models WHERE thumb_key IS NOT NULL AND thumb_key NOT LIKE '/%' AND project_id IN ${trashed}
         UNION SELECT thumbnail_key FROM projects WHERE thumbnail_key IS NOT NULL AND id IN ${trashed}`,
    )
        .bind(idList)
        .all<{ k: string }>();
    // The Muse designer stages its files in R2 under the job's task id (llm/<id>.json / .glb / .cancel); the job rows are about to go.
    const tasks = await env.DB.prepare(
        `SELECT provider_task_id AS t FROM jobs WHERE via = 'openrouter' AND provider_task_id IS NOT NULL AND project_id IN ${trashed}`,
    )
        .bind(idList)
        .all<{ t: string }>();
    const results = await env.DB.batch([
        env.DB.prepare(`DELETE FROM project_tags WHERE project_id IN ${trashed}`).bind(idList),
        env.DB.prepare(`DELETE FROM jobs WHERE project_id IN ${trashed}`).bind(idList),
        env.DB.prepare(`DELETE FROM models WHERE project_id IN ${trashed}`).bind(idList),
        env.DB.prepare("DELETE FROM projects WHERE deleted_at IS NOT NULL AND id IN (SELECT value FROM json_each(?1))").bind(
            idList,
        ),
    ]);
    // Files go after the rows: a failed R2 delete leaves an orphan object, never a dangling row.
    // The SQL above already leaves out "static:" keys (files shipped with the site, shared by every project made from an
    // example); the filter is the second lock on the one door that deletes from R2.
    const fileKeys = [...keys.results.map((r) => r.k), ...tasks.results.flatMap((r) => stagingKeys(r.t))].filter(
        (k) => Boolean(k) && !isStaticKey(k),
    );
    for (let i = 0; i < fileKeys.length; i += 500) {
        await env.FILES.delete(fileKeys.slice(i, i + 500)).catch(() => {});
    }
    return results[3].meta.changes;
}

/** Trash is kept for 7 days; expired projects are purged lazily whenever the hub list is read. */
async function purgeExpiredTrash(env: Env): Promise<void> {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
    const expired = await env.DB.prepare("SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT 100")
        .bind(cutoff)
        .all<{ id: string }>();
    if (expired.results.length > 0) {
        await purgeProjects(
            env,
            expired.results.map((r) => r.id),
        );
    }
}

// ---------- Tags ----------

export async function listTags(env: Env): Promise<HubTag[]> {
    const rows = await env.DB.prepare(`SELECT ${TAG_COLS} FROM tags ORDER BY lower(name), created_at`).all<TagRow>();
    return rows.results.map(toTag);
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint/i.test(err.message);

export async function createTag(env: Env, name: string, icon: string | null, color: string): Promise<HubTag> {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tags").first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_TAGS) throw new HttpError(429, "Tag limit reached. Delete some tags first.");
    const row: TagRow = { id: crypto.randomUUID(), name, icon, color, created_at: nowIso() };
    try {
        await env.DB.prepare("INSERT INTO tags (id, name, icon, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(row.id, row.name, row.icon, row.color, row.created_at)
            .run();
    } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(409, "A tag with that name already exists");
        throw err;
    }
    return toTag(row);
}

export interface TagPatch {
    name?: string;
    icon?: string | null;
    color?: string;
}

export async function patchTag(env: Env, id: string, patch: TagPatch): Promise<HubTag> {
    const sets: string[] = [];
    const values: Array<string | null> = [];
    const add = (column: string, value: string | null) => {
        values.push(value);
        sets.push(`${column} = ?${values.length}`);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.icon !== undefined) add("icon", patch.icon);
    if (patch.color !== undefined) add("color", patch.color);
    if (sets.length > 0) {
        values.push(id);
        try {
            const result = await env.DB.prepare(`UPDATE tags SET ${sets.join(", ")} WHERE id = ?${values.length}`)
                .bind(...values)
                .run();
            if (result.meta.changes !== 1) throw new HttpError(404, "Tag not found");
        } catch (err) {
            if (isUniqueViolation(err)) throw new HttpError(409, "A tag with that name already exists");
            throw err;
        }
    }
    const row = await env.DB.prepare(`SELECT ${TAG_COLS} FROM tags WHERE id = ?1`).bind(id).first<TagRow>();
    if (!row) throw new HttpError(404, "Tag not found");
    return toTag(row);
}

export async function deleteTag(env: Env, id: string): Promise<void> {
    const results = await env.DB.batch([
        env.DB.prepare("DELETE FROM project_tags WHERE tag_id = ?1").bind(id),
        env.DB.prepare("DELETE FROM tags WHERE id = ?1").bind(id),
    ]);
    if (results[1].meta.changes !== 1) throw new HttpError(404, "Tag not found");
}
