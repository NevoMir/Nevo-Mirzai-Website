// Typed client for the Worker's REST API (see shared/contract.ts for the endpoints).
// One function per endpoint; every failure is an ApiRequestError carrying the server's {error}.

import {
    ACCESS_HEADER,
    API_BASE,
    type AnalysisSummary,
    type BulkAction,
    type CreateProjectBody,
    type CreateProjectFromExampleBody,
    type ExampleSummary,
    type ExamplesResponse,
    type GenerateBody,
    type HubProject,
    type HubTag,
    type Job,
    type ModelAsset,
    type PatchProjectBody,
    type ProjectDetail,
    type ProvidersResponse,
} from "@/assignment/shared/contract";

export class ApiRequestError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "ApiRequestError";
        this.status = status;
    }
}

// ---------- Access code ----------

const ACCESS_CODE_KEY = "assembly-studio-access-code";

/** The code the visitor typed once; kept in this browser only. */
export function getAccessCode(): string | null {
    try {
        return localStorage.getItem(ACCESS_CODE_KEY) || null;
    } catch {
        return null;
    }
}

export function setAccessCode(code: string): void {
    try {
        localStorage.setItem(ACCESS_CODE_KEY, code);
    } catch {
        // Storage blocked (private mode): the code just will not survive a reload.
    }
}

/**
 * Can this code travel as a header? Only printable ASCII can: anything else makes fetch throw before
 * a request is made, which would read as "could not reach the server". A code outside that range
 * cannot be the right one anyway.
 */
export function isValidAccessCode(code: string): boolean {
    return /^[\x20-\x7e]+$/.test(code);
}

export function clearAccessCode(): void {
    try {
        localStorage.removeItem(ACCESS_CODE_KEY);
    } catch {
        // Nothing stored that we could remove.
    }
}

// ---------- Transport ----------

/** Options of apiRequest. */
export interface RequestOptions {
    json?: unknown;
    /** A raw body (the thumbnail upload); sent with the blob's own content type. */
    blob?: Blob;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Lets the request outlive the page (a save fired while the tab closes). Bodies are capped at 64 KB. */
    keepalive?: boolean;
}

/**
 * One call to the API: JSON in, JSON out, every failure an ApiRequestError carrying the server's {error}. `path` is relative to API_BASE.
 * Exported so the feature clients (edits, block edits, optimization) can add their own endpoints in files of their own.
 */
export async function apiRequest<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...options.headers };
    let body: BodyInit | undefined;
    if (options.blob) {
        body = options.blob;
        headers["content-type"] = options.blob.type || "application/octet-stream";
    } else if (options.json !== undefined) {
        body = JSON.stringify(options.json);
        headers["content-type"] = "application/json";
    }

    let res: Response;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body,
            signal: options.signal,
            keepalive: options.keepalive,
        });
    } catch (err) {
        // An aborted request is the caller's own doing; let it through untouched.
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        // AbortSignal.timeout(): the server never answered. Counts as a failed attempt, like a dropped connection.
        if (err instanceof DOMException && err.name === "TimeoutError") {
            throw new ApiRequestError(0, "The server took too long to answer. Check your connection and try again.");
        }
        throw new ApiRequestError(0, "Could not reach the server. Check your connection and try again.");
    }

    let payload: unknown = null;
    try {
        payload = await res.json();
    } catch {
        // An empty or non-JSON body: handled below by status.
    }
    if (!res.ok) {
        let message = `Request failed (${res.status})`;
        if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") message = payload.error;
        // Not our JSON: the platform's own error page (a Worker over its limits, a deploy in progress). Say what to do.
        else if (res.status >= 500) message = `The server could not finish this (${res.status}); it may be busy. Try again in a moment.`;
        throw new ApiRequestError(res.status, message);
    }
    return payload as T;
}

const enc = encodeURIComponent;

// ---------- Providers and access ----------

export function getProviders(signal?: AbortSignal): Promise<ProvidersResponse> {
    return apiRequest("GET", "/providers", { signal });
}

export function checkAccess(code: string): Promise<{ ok: boolean }> {
    return apiRequest("POST", "/access/check", { json: { code } });
}

// ---------- Projects ----------

export function listProjects(signal?: AbortSignal): Promise<{ projects: HubProject[]; tags: HubTag[] }> {
    return apiRequest("GET", "/projects", { signal });
}

export async function createProject(body: CreateProjectBody = {}): Promise<HubProject> {
    const res = await apiRequest<{ project: HubProject }>("POST", "/projects", { json: body });
    return res.project;
}

/**
 * A new project holding a bundled example: its generated-style model and the stabilized twin, with the chat
 * already written. Nothing is generated, so no access code and no token spend. Resolves to the project, ready to show.
 */
export async function createProjectFromExample(slug: string, tagId?: string | null): Promise<ProjectDetail> {
    const body: CreateProjectFromExampleBody = tagId ? { slug, tag_id: tagId } : { slug };
    const res = await apiRequest<{ project: ProjectDetail }>("POST", "/projects/from-example", { json: body });
    return res.project;
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
    const res = await apiRequest<{ project: ProjectDetail }>("GET", `/projects/${enc(id)}`, { signal });
    return res.project;
}

export async function patchProject(
    id: string,
    body: PatchProjectBody,
    options: { keepalive?: boolean } = {},
): Promise<HubProject> {
    const res = await apiRequest<{ project: HubProject }>("PATCH", `/projects/${enc(id)}`, {
        json: body,
        keepalive: options.keepalive,
    });
    return res.project;
}

/** Upload the viewer capture (image/webp or image/png, at most 512 KB). */
export async function putThumbnail(projectId: string, image: Blob): Promise<string> {
    const res = await apiRequest<{ thumbnail_url: string }>("PUT", `/projects/${enc(projectId)}/thumbnail`, {
        blob: image,
    });
    return res.thumbnail_url;
}

/** Trash, restore, archive, unarchive or purge several projects; resolves to how many changed. */
export async function bulkProjects(ids: string[], action: BulkAction): Promise<number> {
    const res = await apiRequest<{ count: number }>("POST", "/projects/bulk", { json: { ids, action } });
    return res.count;
}

/** Add (or remove) one tag on several projects; resolves to how many were affected. */
export async function setProjectsTag(ids: string[], tagId: string, add: boolean): Promise<number> {
    const res = await apiRequest<{ count: number }>("POST", "/projects/tags", {
        json: { ids, tag_id: tagId, add },
    });
    return res.count;
}

// ---------- Tags ----------

export async function listTags(signal?: AbortSignal): Promise<HubTag[]> {
    const res = await apiRequest<{ tags: HubTag[] }>("GET", "/tags", { signal });
    return res.tags;
}

export async function createTag(input: { name: string; icon: string | null; color: string }): Promise<HubTag> {
    const res = await apiRequest<{ tag: HubTag }>("POST", "/tags", { json: input });
    return res.tag;
}

export async function updateTag(
    id: string,
    patch: { name?: string; icon?: string | null; color?: string },
): Promise<HubTag> {
    const res = await apiRequest<{ tag: HubTag }>("PATCH", `/tags/${enc(id)}`, { json: patch });
    return res.tag;
}

export async function deleteTag(id: string): Promise<void> {
    await apiRequest<{ ok: true }>("DELETE", `/tags/${enc(id)}`);
}

// ---------- Generation ----------

/** The stored access code as a request header, for the calls that spend credits or stop a paid run. */
export function accessHeaders(): Record<string, string> | undefined {
    const code = getAccessCode();
    return code && isValidAccessCode(code) ? { [ACCESS_HEADER]: code } : undefined;
}

/** Start one job per provider. Sends the stored access code when there is one. */
export async function generate(projectId: string, body: GenerateBody): Promise<Job[]> {
    const res = await apiRequest<{ jobs: Job[] }>("POST", `/projects/${enc(projectId)}/generate`, {
        json: body,
        headers: accessHeaders(),
    });
    return res.jobs;
}

/** Poll a job. The server advances it (at most every few seconds), so polling is what drives it. */
export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
    const res = await apiRequest<{ job: Job }>("GET", `/jobs/${enc(id)}`, { signal });
    return res.job;
}

/** Stop a job. Needs the access code like starting one does (anyone can see a job's id). */
export async function cancelJob(id: string): Promise<Job> {
    const res = await apiRequest<{ job: Job }>("POST", `/jobs/${enc(id)}/cancel`, { headers: accessHeaders() });
    return res.job;
}

// ---------- Analysis ----------

/**
 * Save the headline numbers of a model's block analysis, so the chat cards and the Models list can show a
 * verdict without loading the GLB. Resolves to the model as the server now has it.
 */
export async function putModelAnalysis(modelId: string, summary: AnalysisSummary): Promise<ModelAsset> {
    const res = await apiRequest<{ model: ModelAsset }>("PUT", `/models/${enc(modelId)}/analysis`, { json: { summary } });
    return res.model;
}

// ---------- Examples and block versions ----------

/** The bundled examples (cacheable: the list only changes with a deploy). */
export async function listExamples(signal?: AbortSignal): Promise<ExampleSummary[]> {
    const res = await apiRequest<ExamplesResponse>("GET", "/examples", { signal });
    return Array.isArray(res?.examples) ? res.examples : [];
}

/**
 * Store a block version of `sourceId`: stabilized, edited (a change of the blocks) or optimized. `glb` is the assembly GLB the
 * stabilizer, the block editor or the optimizer wrote (shared/assemblyGlb.ts), carrying exactly one log; the server accepts only
 * exactly what that writer produces and reads the log out of the file itself. Asking again for the same assembly returns the
 * model stored the first time.
 */
export async function createDerivedModel(sourceId: string, glb: Uint8Array, signal?: AbortSignal): Promise<ModelAsset> {
    // A copy backed by a plain ArrayBuffer: the stabilizer hands over a view on a transferred buffer.
    const body = new Blob([new Uint8Array(glb)], { type: "model/gltf-binary" });
    const res = await apiRequest<{ model: ModelAsset }>("POST", `/models/${enc(sourceId)}/derived`, { blob: body, signal });
    return res.model;
}

/** Delete a version (stabilized, edited or optimized), and any version made from it. The server refuses a root: a generated model or an example (409). */
export async function deleteModel(id: string): Promise<void> {
    await apiRequest<{ ok: true }>("DELETE", `/models/${enc(id)}`);
}
