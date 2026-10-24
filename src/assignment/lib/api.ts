// Typed client for the Worker's REST API (see shared/contract.ts for the endpoints).
// One function per endpoint; every failure is an ApiRequestError carrying the server's {error}.

import {
    ACCESS_HEADER,
    API_BASE,
    type AnalysisSummary,
    type BulkAction,
    type CreateProjectBody,
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

interface RequestOptions {
    json?: unknown;
    /** A raw body (the thumbnail upload); sent with the blob's own content type. */
    blob?: Blob;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Lets the request outlive the page (a save fired while the tab closes). Bodies are capped at 64 KB. */
    keepalive?: boolean;
}

async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
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
        const message =
            payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
                ? payload.error
                : `Request failed (${res.status})`;
        throw new ApiRequestError(res.status, message);
    }
    return payload as T;
}

const enc = encodeURIComponent;

// ---------- Providers and access ----------

export function getProviders(signal?: AbortSignal): Promise<ProvidersResponse> {
    return request("GET", "/providers", { signal });
}

export function checkAccess(code: string): Promise<{ ok: boolean }> {
    return request("POST", "/access/check", { json: { code } });
}

// ---------- Projects ----------

export function listProjects(signal?: AbortSignal): Promise<{ projects: HubProject[]; tags: HubTag[] }> {
    return request("GET", "/projects", { signal });
}

export async function createProject(body: CreateProjectBody = {}): Promise<HubProject> {
    const res = await request<{ project: HubProject }>("POST", "/projects", { json: body });
    return res.project;
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
    const res = await request<{ project: ProjectDetail }>("GET", `/projects/${enc(id)}`, { signal });
    return res.project;
}

export async function patchProject(
    id: string,
    body: PatchProjectBody,
    options: { keepalive?: boolean } = {},
): Promise<HubProject> {
    const res = await request<{ project: HubProject }>("PATCH", `/projects/${enc(id)}`, {
        json: body,
        keepalive: options.keepalive,
    });
    return res.project;
}

/** Upload the viewer capture (image/webp or image/png, at most 512 KB). */
export async function putThumbnail(projectId: string, image: Blob): Promise<string> {
    const res = await request<{ thumbnail_url: string }>("PUT", `/projects/${enc(projectId)}/thumbnail`, {
        blob: image,
    });
    return res.thumbnail_url;
}

/** Trash, restore, archive, unarchive or purge several projects; resolves to how many changed. */
export async function bulkProjects(ids: string[], action: BulkAction): Promise<number> {
    const res = await request<{ count: number }>("POST", "/projects/bulk", { json: { ids, action } });
    return res.count;
}

/** Add (or remove) one tag on several projects; resolves to how many were affected. */
export async function setProjectsTag(ids: string[], tagId: string, add: boolean): Promise<number> {
    const res = await request<{ count: number }>("POST", "/projects/tags", {
        json: { ids, tag_id: tagId, add },
    });
    return res.count;
}

// ---------- Tags ----------

export async function listTags(signal?: AbortSignal): Promise<HubTag[]> {
    const res = await request<{ tags: HubTag[] }>("GET", "/tags", { signal });
    return res.tags;
}

export async function createTag(input: { name: string; icon: string | null; color: string }): Promise<HubTag> {
    const res = await request<{ tag: HubTag }>("POST", "/tags", { json: input });
    return res.tag;
}

export async function updateTag(
    id: string,
    patch: { name?: string; icon?: string | null; color?: string },
): Promise<HubTag> {
    const res = await request<{ tag: HubTag }>("PATCH", `/tags/${enc(id)}`, { json: patch });
    return res.tag;
}

export async function deleteTag(id: string): Promise<void> {
    await request<{ ok: true }>("DELETE", `/tags/${enc(id)}`);
}

// ---------- Generation ----------

/** The stored access code as a request header, for the calls that spend credits or stop a paid run. */
function accessHeaders(): Record<string, string> | undefined {
    const code = getAccessCode();
    return code && isValidAccessCode(code) ? { [ACCESS_HEADER]: code } : undefined;
}

/** Start one job per provider. Sends the stored access code when there is one. */
export async function generate(projectId: string, body: GenerateBody): Promise<Job[]> {
    const res = await request<{ jobs: Job[] }>("POST", `/projects/${enc(projectId)}/generate`, {
        json: body,
        headers: accessHeaders(),
    });
    return res.jobs;
}

/** Poll a job. The server advances it (at most every few seconds), so polling is what drives it. */
export async function getJob(id: string, signal?: AbortSignal): Promise<Job> {
    const res = await request<{ job: Job }>("GET", `/jobs/${enc(id)}`, { signal });
    return res.job;
}

/** Stop a job. Needs the access code like starting one does (anyone can see a job's id). */
export async function cancelJob(id: string): Promise<Job> {
    const res = await request<{ job: Job }>("POST", `/jobs/${enc(id)}/cancel`, { headers: accessHeaders() });
    return res.job;
}

// ---------- Analysis ----------

/**
 * Save the headline numbers of a model's block analysis, so the chat cards and the Models list can show a
 * verdict without loading the GLB. Resolves to the model as the server now has it.
 */
export async function putModelAnalysis(modelId: string, summary: AnalysisSummary): Promise<ModelAsset> {
    const res = await request<{ model: ModelAsset }>("PUT", `/models/${enc(modelId)}/analysis`, { json: { summary } });
    return res.model;
}
