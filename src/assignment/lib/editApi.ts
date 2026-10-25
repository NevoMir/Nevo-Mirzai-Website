// The browser's client of the two mesh-edit endpoints (worker/edit.ts, worker/editUpload.ts) and the file fetch that feeds the editor.
// Built on apiRequest, like the rest of lib/api.ts; a file of its own so the feature stays in one place.

import { accessHeaders, apiRequest, ApiRequestError } from "@/assignment/lib/api";
import { EDITED_GLB_LIMIT, type Job, type ModelAsset, type StartEditBody } from "@/assignment/shared/contract";

const enc = encodeURIComponent;

/** How long the upload of the edited model (15 to 28 MB) may take: a slow uplink needs about a minute; a dead connection must not hang for ever. */
export const UPLOAD_TIMEOUT_MS = 180_000;
/** The model file is fetched once per edit; Hunyuan files are 15 to 30 MB, and the server holds at most 150 MB. */
export const MAX_SOURCE_BYTES = 150 * 1024 * 1024;

/** Either signal ending ends the request (AbortSignal.any where the browser has it). */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
    const list = signals.filter((s): s is AbortSignal => s !== undefined);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return typeof AbortSignal.any === "function" ? AbortSignal.any(list) : list[0];
}

const timeoutSignal = (ms: number): AbortSignal | undefined => (typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined);

/** Start a design edit (the server rebuilds the parts) or the plan of a mesh edit (the pictures go along). Needs the access code like generation. */
export async function startEdit(sourceId: string, body: StartEditBody, signal?: AbortSignal): Promise<Job> {
    const res = await apiRequest<{ job: Job }>("POST", `/models/${enc(sourceId)}/edits`, { json: body, headers: accessHeaders(), signal });
    return res.job;
}

/**
 * Store the GLB a finished mesh edit produced. The same job id makes a retry safe: an upload that did get through the first time answers
 * with the model it made.
 */
export async function uploadEditedMesh(sourceId: string, jobId: string, glb: Uint8Array, signal?: AbortSignal): Promise<ModelAsset> {
    if (glb.byteLength > EDITED_GLB_LIMIT) throw new ApiRequestError(413, "The edited model is larger than the 48 MB limit.");
    // A copy backed by a plain ArrayBuffer: the worker hands over a view on a transferred buffer.
    const body = new Blob([new Uint8Array(glb)], { type: "model/gltf-binary" });
    const res = await apiRequest<{ model: ModelAsset }>("POST", `/models/${enc(sourceId)}/edited?job=${enc(jobId)}`, {
        blob: body,
        signal: anySignal([signal, timeoutSignal(UPLOAD_TIMEOUT_MS)]),
    });
    return res.model;
}

/** The model's GLB as the server serves it (cached by the browser: the viewer fetched the same URL). */
export async function fetchModelBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    let res: Response;
    try {
        res = await fetch(url, { signal });
    } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        throw new ApiRequestError(0, "Could not load the model file. Check your connection and try again.");
    }
    if (!res.ok) throw new ApiRequestError(res.status, `Could not load the model file (${res.status}).`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) throw new ApiRequestError(413, "This model file is too large to edit here.");
    return res.arrayBuffer();
}
