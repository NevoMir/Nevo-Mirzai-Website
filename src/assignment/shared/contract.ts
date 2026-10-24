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
 * mock = no key (replays a bundled multi-part GLB; only when MOCK_PROVIDER = "1").
 */
export type ProviderId =
    | "tripo-parts" // Tripo H3.1 with generate_parts (multi-part assembly, untextured), Tripo direct API
    | "tripo" // Tripo H3.1 textured (Tripo direct API, else via fal)
    | "meshy" // Meshy 7.1 (Meshy direct API, else via fal)
    | "rodin" // Hyper3D Rodin Gen-2.5 (via fal)
    | "hunyuan" // Tencent Hunyuan 3D (Tencent Cloud official API, else via fal)
    | "mock";

export interface ProviderInfo {
    id: ProviderId;
    label: string; // "Meshy 7.1"
    vendor: string; // "Meshy"
    via: "fal" | "tripo" | "meshy" | "tencent" | "mock" | null; // null when no key is configured
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

/** A generated model stored in our own R2 (provider URLs expire and lack CORS). */
export interface ModelAsset {
    id: string;
    project_id: string;
    job_id: string;
    provider: ProviderId;
    prompt: string;
    glb_url: string; // same-origin: `${API_BASE}/files/models/${id}.glb`
    thumbnail_url: string | null; // provider still if it gave one: `${API_BASE}/files/model-thumbs/${id}.<ext>`
    size_bytes: number;
    part_count: number | null; // mesh nodes in the GLB if known, else null
    created_at: string;
    analysis: AnalysisSummary | null; // the latest block analysis, saved by the client after it runs
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
    analyzed_at: string;
}

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
// GET    /files/models/:modelId.glb              -> model/gltf-binary (immutable cache)
// GET    /files/model-thumbs/:file               -> image
// GET    /files/thumbs/:projectId.webp           -> image
//
// Errors are always JSON {error: string} with a 4xx/5xx status.

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
