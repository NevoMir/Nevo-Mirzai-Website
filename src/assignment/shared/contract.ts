// The REST contract between the /assignment_alex app (src/assignment) and its Worker (worker/).
// Pure types and constants only: this file is compiled by both the browser and the Worker tsconfig.
// All JSON is snake_case; every timestamp is an ISO-8601 UTC string.

export const APP_BASE = "/assignment_alex";
export const API_BASE = "/api/assignment_alex";
export const ACCESS_HEADER = "x-access-code";

// ---------- Providers ----------

/**
 * A text-to-3D model the app can call. "via" says which API key it needs:
 * fal = FAL_KEY (fal.ai queue API), tripo = TRIPO_API_KEY, meshy = MESHY_API_KEY,
 * tencent = TENCENTCLOUD_SECRET_ID + TENCENTCLOUD_SECRET_KEY (Hunyuan 3D official API, 200 free credits),
 * openrouter = OPENROUTER_API_KEY (an LLM designs the object as named primitive parts; the app builds the GLB),
 * mock = no key (replays a bundled multi-part GLB; only when MOCK_PROVIDER = "1").
 */
export type ProviderId =
    | "tripo-parts" // Tripo H3.1 with generate_parts (multi-part assembly, untextured), Tripo direct API
    | "tripo" // Tripo H3.1 textured (Tripo direct API, else via fal)
    | "meshy" // Meshy 7.1 (Meshy direct API, else via fal)
    | "rodin" // Hyper3D Rodin Gen-2.5 (via fal)
    | "hunyuan" // Tencent Hunyuan 3D (Tencent Cloud official API, else via fal)
    | "muse" // Meta Muse Spark 1.3 (via OpenRouter): a text model that designs the object as named parts (multi-part, untextured)
    | "mock";

export interface ProviderInfo {
    id: ProviderId;
    label: string; // "Meshy 7.1"
    vendor: string; // "Meshy"
    via: "fal" | "tripo" | "meshy" | "tencent" | "openrouter" | "mock" | null; // null when no key is configured
    available: boolean; // false when its key is missing
    description: string; // one line for the picker
    parts: boolean; // returns separate meshes per part (an assembly)
    textured: boolean;
    approx_seconds: number; // typical end-to-end time, for the progress estimate
}

export interface ProvidersResponse {
    providers: ProviderInfo[];
    default_provider: ProviderId | null; // first available, preferring "tripo-parts"
    access_required: boolean; // POST /generate needs the ACCESS_HEADER
    daily_limit: number | null; // null = no daily cap
    used_today: number;
}

// ---------- Jobs and models ----------

export type JobStatus = "queued" | "running" | "finalizing" | "succeeded" | "failed" | "canceled";
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "canceled"];

/**
 * Where a model came from. "generated": a text-to-3D provider made it (every model before the stabilizer existed).
 * "example": the original model of a bundled example (src/assignment examples manifest), shared by every project
 * made from it. "stabilized": the corrected block assembly the browser built from another model of the project.
 */
export type ModelKind = "generated" | "example" | "stabilized";

/** `provider` of a model: a text-to-3D model, "example" (bundled) or "stabilizer" (made in the browser). */
export type ModelProvider = ProviderId | "example" | "stabilizer";

/**
 * A model stored in our own R2 (provider URLs expire and lack CORS), or shipped with the site (kind "example").
 * Read `kind` as "generated" when it is missing: a server from before the stabilizer does not send it.
 */
export interface ModelAsset {
    id: string;
    project_id: string;
    job_id: string; // "" for a model that no job made (examples); a stabilized model carries its source's job id
    provider: ModelProvider;
    prompt: string;
    glb_url: string; // same-origin: `${API_BASE}/files/models/${id}.glb`, or `${APP_BASE}/examples/<slug>/<file>.glb` for examples
    thumbnail_url: string | null; // provider still if it gave one: `${API_BASE}/files/model-thumbs/${id}.<ext>`
    size_bytes: number;
    part_count: number | null; // mesh nodes in the GLB if known, else null
    created_at: string;
    analysis: AnalysisSummary | null; // the latest block analysis, saved by the client after it runs
    kind: ModelKind;
    /** The model this one was made from (stabilized only; same project). */
    source_model_id: string | null;
    /** The bundled example this model belongs to (kind "example", and the stabilized twin made from it). */
    example_slug: string | null;
    /** What the stabilizer did (kind "stabilized"), else null. */
    derived: DerivedMeta | null;
}

/**
 * Headline numbers of a model's structural analysis (scaled to the 1000 mm target, 100 mm blocks). The client
 * computes it (src/assignment/analysis) and saves it with PUT /models/:id/analysis so chat cards and the Models
 * list can show a verdict without reloading the GLB.
 */
export interface AnalysisSummary {
    version: 1;
    blocks: number; // components used
    bodies: number; // connected structures
    floating_blocks: number; // blocks in structures that do not touch the ground
    cantilevered: number; // blocks with nothing underneath
    longest_cantilever: number; // in blocks
    over_limit: number; // blocks further than cantilever_limit from a support
    cantilever_limit: number;
    cog_mm: [number, number, number] | null; // null when nothing touches the ground
    cog_inside: boolean;
    cog_margin_mm: number; // > 0 inside the support base, < 0 outside
    size_mm: [number, number, number]; // scaled bounding box
    coverage: number; // 0-1
    fill_threshold: number; // 0-1
    errors: number; // constraint violations
    warnings: number;
    /** The joint-stress estimate; absent on summaries saved before it existed and while it has not been computed. */
    stress?: StressSummary | null;
    analyzed_at: string;
}

// ---------- Stress, block roles, stabilized models ----------

/** What a block of an assembly is for. "original" blocks were in the analysed model; the others were added to it. */
export type BlockRole = "original" | "column" | "footing" | "bracket" | "bridge" | "reinforcement";
export const BLOCK_ROLES: readonly BlockRole[] = ["original", "column", "footing", "bracket", "bridge", "reinforcement"];
/** The roles the stabilizer adds (every role except "original"). */
export type AddedRole = Exclude<BlockRole, "original">;

/** Block material of the stress estimate (src/assignment/analysis/materials.ts has the numbers). */
export type MaterialId = "concrete" | "timber";
export const MATERIAL_IDS: readonly MaterialId[] = ["concrete", "timber"];

/** Headline numbers of the stress estimate (self-weight only), saved with the AnalysisSummary. */
export interface StressSummary {
    material: MaterialId;
    /** Highest joint utilisation: 0.73 = 73 % of the allowable stress, above 1 the joint opens. 0..50. */
    max_utilisation: number;
    max_at: [number, number, number] | null; // grid cell (i, j, k) of the most stressed block
    stressed_blocks: number; // blocks above 75 % of the allowable (the warning level)
    overstressed_blocks: number; // blocks above 100 %
    analysed_blocks: number; // blocks the solver saw (the ones that stand on the ground)
    unsupported_blocks: number; // blocks with no load path to the ground: no stress can be computed for them
}

/** The numbers the stabilizer watches, before and after a step or the whole run. */
export interface StabilizationMetrics {
    blocks: number;
    errors: number;
    warnings: number;
    floating_blocks: number;
    over_limit: number; // blocks beyond the cantilever limit
    longest_cantilever: number;
    cog_margin_mm: number | null; // null: nothing touches the ground
    max_utilisation: number | null; // null: no block stands on the ground
    overstressed_blocks: number;
}

export type StabilizeReason = "floating" | "cantilever" | "cog" | "stress";
export type StabilizeStop = "stable" | "no-improving-move" | "max-steps" | "max-blocks" | "time-budget" | "canceled";
export type StepMetrics = Pick<
    StabilizationMetrics,
    "blocks" | "errors" | "floating_blocks" | "over_limit" | "longest_cantilever" | "cog_margin_mm" | "max_utilisation"
>;

/** One iteration of the stabilizer: a move, why it was made and what it changed. */
export interface StabilizeStepLog {
    n: number; // 1-based; the `step` of every block this move added
    move: AddedRole;
    reason: StabilizeReason;
    added: number; // blocks added
    /** One or two sentences with the numbers, e.g. "Added a 5-block column under the arm tip at x = 850 mm ...". */
    text: string;
    at_mm: [number, number, number]; // where to point the camera
    before: StepMetrics;
    after: StepMetrics;
}

/** Everything a stabilized model records about how it was made (kind "stabilized"; stored in models.meta). */
export interface DerivedMeta {
    version: 1;
    depth: number; // 1: made from a generated or example model, 2: from a stabilized one, ...
    stabilizer: string; // algorithm version, "1.0.0"
    solver: "awatif-wasm" | "awatif-ts";
    material: MaterialId;
    target_utilisation: number; // the stress level the loop tried to get under (default 0.75)
    cantilever_limit: number;
    fill_threshold: number;
    complete: boolean; // no errors left and stress under the target
    stop: StabilizeStop;
    /** Blocks added by THIS run. A second run (depth 2) keeps the first run's blocks, roles and steps as part of the model. */
    added_blocks: number;
    added_by_role: Partial<Record<AddedRole, number>>;
    before: StabilizationMetrics;
    after: StabilizationMetrics;
    steps: StabilizeStepLog[]; // at most MAX_STABILIZE_STEPS
    duration_ms: number;
    assembly_hash: string; // SHA-256 (hex) of the canonical block list
    /** The stabilized model's own analysis; also stored in models.analysis so cards show the verdict at once. */
    after_summary: AnalysisSummary;
    created_at: string;
}

export const DERIVED_GLB_LIMIT = 1024 * 1024; // a 1000-block assembly is 650 KB
export const DERIVED_META_LIMIT = 32 * 1024;
export const MAX_STABILIZE_STEPS = 60;
export const MAX_DERIVED_PER_SOURCE = 5;
export const MAX_DERIVED_PER_PROJECT = 20;
export const MAX_DERIVED_DEPTH = 3;

export interface Job {
    id: string;
    project_id: string;
    provider: ProviderId;
    prompt: string;
    status: JobStatus;
    progress: number; // 0-100
    stage: string; // short human text: "Queued", "Generating mesh", "Texturing", "Saving model"
    error: string | null;
    created_at: string;
    updated_at: string;
    finished_at: string | null;
    model: ModelAsset | null; // set once status = "succeeded"
}

// ---------- Projects, tags, chat ----------

export interface ChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string; // user: the prompt; assistant: markdown written by the client
    timestamp: string;
    job_ids?: string[]; // assistant replies point at the jobs a prompt started (one per provider)
    /** Assistant replies that present models directly (an opened example, a stabilized version): at most 10. */
    model_ids?: string[];
}

/** Free-form workspace state the client saves with PATCH /projects/:id { data }. */
export interface ProjectData {
    messages: ChatMessage[];
    active_model_id: string | null; // the model shown in the viewer
}

export interface HubProject {
    id: string;
    name: string;
    created_at: string;
    modified_at: string; // last user edit (rename, new prompt, tags); drives "Edited 3m ago" and sorting
    deleted_at: string | null; // soft delete; purged for good 7 days later
    archived_at: string | null;
    pinned: boolean;
    thumbnail_url: string | null; // `${API_BASE}/files/thumbs/${id}.webp?v=<n>` captured from the viewer
    tag_ids: string[];
    model_count: number;
}

export interface ProjectDetail extends HubProject {
    data: ProjectData;
    models: ModelAsset[]; // oldest first
    jobs: Job[]; // every job of the project, oldest first (assistant messages look them up by id)
}

export interface HubTag {
    id: string;
    name: string; // unique, case-insensitive
    icon: string | null; // lucide icon name (see lib/hub/tagIcons.ts) or null for a colour dot
    color: string; // #rrggbb
    created_at: string;
}

export type BulkAction = "trash" | "restore" | "archive" | "unarchive" | "purge";

// ---------- Endpoints (all under API_BASE) ----------
//
// GET    /providers                              -> ProvidersResponse
// POST   /access/check        {code}             -> {ok: boolean}
//
// GET    /projects                               -> {projects: HubProject[], tags: HubTag[]}   (all views; client filters)
// POST   /projects            CreateProjectBody  -> {project: HubProject}
// GET    /projects/:id                           -> {project: ProjectDetail}                    404 {error}
// PATCH  /projects/:id        PatchProjectBody   -> {project: HubProject}
// PUT    /projects/:id/thumbnail  (raw image/webp or image/png body, <= 512 KB) -> {thumbnail_url}
// POST   /projects/bulk       {ids, action: BulkAction}          -> {count}
// POST   /projects/tags       {ids, tag_id, add: boolean}        -> {count}
//
// GET    /tags                                   -> {tags: HubTag[]}
// POST   /tags                {name, icon, color}                -> {tag: HubTag}   409 {error} on duplicate name
// PATCH  /tags/:id            {name?, icon?, color?}             -> {tag: HubTag}
// DELETE /tags/:id                                -> {ok: true}
//
// POST   /projects/:id/generate  GenerateBody  (+ ACCESS_HEADER when access_required)
//                                                 -> {jobs: Job[]}  one per provider, already submitted
//                                                    401 {error} bad/missing code, 429 {error} daily limit
// GET    /jobs/:id                               -> {job: Job}   advances the job: polls the provider at most every
//                                                    ~3 s and, on success, copies the GLB into R2 and creates the model
// POST   /jobs/:id/cancel   (+ ACCESS_HEADER)    -> {job: Job}   409 {error} when the model cannot be stopped (e.g.
//                                                    Tencent has no cancel API: the job keeps running and still lands)
//
// PUT    /models/:id/analysis   {summary: AnalysisSummary}  -> {model: ModelAsset}   400 {error} on a malformed summary
//
// POST   /models/:sourceId/derived  (raw GLB, Content-Type model/gltf-binary, <= DERIVED_GLB_LIMIT; the stabilizer's
//                                    metadata travels inside the GLB, see shared/assemblyGlb.ts)
//                                                 -> 201 {model: ModelAsset}  (200 with the existing model when the same
//                                                    assembly was stored before, whatever log it came with)
//                                                    400 {error} invalid file, or a log that disagrees with the blocks
//                                                    (hash, depth, blocks added, per role, per step), 404 source,
//                                                    409 source in the bin / chain too deep, 413 too large,
//                                                    415 wrong content type, 429 per-source / per-project / daily limit
//                                                    (the first two are checked inside the INSERT, so parallel requests
//                                                    cannot pass them)
// DELETE /models/:id                              -> {ok: true}   only models of kind "stabilized"; 409 for the others
//
// GET    /examples                                -> ExamplesResponse   (cacheable for 5 minutes)
// POST   /projects/from-example  CreateProjectFromExampleBody
//                                                 -> 201 {project: ProjectDetail}  a project holding the example's two
//                                                    models (kind "example" and its "stabilized" twin), nothing generated
//                                                    404 unknown slug, 429 project limit
//
// GET    /files/models/:modelId.glb              -> model/gltf-binary (immutable cache; for a model of an example the Worker
//                                                    proxies the site's static file instead, cached for 5 minutes)
// GET    /files/model-thumbs/:file               -> image
// GET    /files/thumbs/:projectId.webp           -> image
//
// Errors are always JSON {error: string} with a 4xx/5xx status (503 + Retry-After while the database is behind the Worker).

export interface CreateProjectFromExampleBody {
    slug: string; // ExampleSummary.slug
    tag_id?: string; // seed tag, as for CreateProjectBody
}

/** One bundled example: a generated-style model with problems, and its stabilized version. Nothing here costs tokens. */
export interface ExampleSummary {
    slug: string; // ^[a-z0-9-]{3,40}$
    title: string; // "Mushroom table"
    prompt: string; // the prompt it stands for ("A mushroom-shaped garden table"); becomes the models' prompt
    blurb: string; // one sentence on what goes wrong and what the stabilizer does
    tags: string[]; // "floating", "cantilever", "tipping", "stress", "stable" ...
    cover_url: string; // 512 x 384 image: also the new project's card image
    original: { size_bytes: number; part_count: number | null; analysis: AnalysisSummary };
    stabilized: {
        size_bytes: number;
        analysis: AnalysisSummary;
        added_blocks: number;
        before: StabilizationMetrics;
        after: StabilizationMetrics;
    };
    version: string; // content hash of the example's files (8 hex)
}

export interface ExamplesResponse {
    examples: ExampleSummary[];
}

export interface CreateProjectBody {
    name?: string; // default "Untitled project"
    tag_id?: string; // seed tag when created from a tag page
}

export interface PatchProjectBody {
    name?: string;
    pinned?: boolean;
    data?: ProjectData;
}

export interface GenerateBody {
    prompt: string; // 1..1000 chars
    providers: ProviderId[]; // 1..5, each must be available
}

export interface ApiError {
    error: string;
}
