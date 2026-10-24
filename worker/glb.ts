// Copying a provider's finished GLB into R2: bounded download, glTF validation, mesh-node count.
// Provider URLs expire and lack CORS, so the app only ever serves its own copy.

import type { Env } from "./providers/types.ts";
import { readStreamLimited, sniffImageType } from "./util.ts";

export const MAX_GLB_BYTES = 150 * 1024 * 1024;
// Without a trustworthy content-length the file is buffered in memory (a Worker has 128 MB), so cap it lower.
const MAX_BUFFERED_BYTES = 40 * 1024 * 1024;
// The JSON chunk is decoded and parsed to count parts; a Free-plan request has ~10 ms of CPU, so only small ones are read.
const MAX_JSON_CHUNK_BYTES = 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000; // one attempt
const DOWNLOAD_BUDGET_MS = 120_000; // every attempt of one save together
const MIN_ATTEMPT_MS = 10_000; // no point starting another attempt with less time than this left
const MAX_DOWNLOAD_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1_000;
const THUMBNAIL_TIMEOUT_MS = 15_000;
/** The longest one storeGlb + storeThumbnail can take; the job engine keeps its finalize lease above it. */
export const MAX_STORE_MS = DOWNLOAD_BUDGET_MS + THUMBNAIL_TIMEOUT_MS;

export const GLB_CONTENT_TYPE = "model/gltf-binary";

/**
 * A failure whose message is fit to show the user as the job's error. `retryable` marks a hiccup on the way
 * (dropped connection, 5xx, 429): the copy is worth trying again. Anything else is about the file itself.
 */
export class ModelFileError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable = false) {
        super(message);
        this.name = "ModelFileError";
        this.retryable = retryable;
    }
}

/** The body stopped short or did not match its declared length. */
class DownloadInterrupted extends ModelFileError {
    readonly declared: number;
    constructor(message: string, declared: number) {
        super(message, true);
        this.declared = declared;
    }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface StoredGlb {
    size: number;
    partCount: number | null;
}

const SOURCE_ERROR = "Could not download the generated file from the provider.";

/** Opens a provider URL: "asset:/path" (a file bundled with this site), a base64 "data:" URL, or https. */
async function openSource(env: Env, source: string, timeoutMs: number): Promise<Response> {
    if (source.startsWith("data:")) {
        const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(source);
        if (!match) throw new ModelFileError(SOURCE_ERROR);
        try {
            const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
            return new Response(bytes, {
                headers: { "content-type": match[1], "content-length": String(bytes.byteLength) },
            });
        } catch {
            throw new ModelFileError(SOURCE_ERROR);
        }
    }
    const isAsset = source.startsWith("asset:");
    let url: URL;
    try {
        url = isAsset ? new URL(source.slice("asset:".length), "https://assets.local") : new URL(source);
    } catch {
        throw new ModelFileError(SOURCE_ERROR);
    }
    // A URL that is not usable stays unusable; only a failed request is worth another try.
    if (isAsset ? url.host !== "assets.local" : url.protocol !== "https:") throw new ModelFileError(SOURCE_ERROR);
    try {
        return isAsset
            ? await env.ASSETS.fetch(new Request(url))
            : await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
        throw new ModelFileError(SOURCE_ERROR, true);
    }
}

/** The content-length to trust, or null when it is missing or the body is content-encoded. */
function trustedLength(res: Response): number | null {
    const encoding = res.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") return null;
    const length = Number(res.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : null;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Validates the 12-byte GLB header plus the first chunk header; returns the JSON chunk length. */
function readGlbHeader(head: Uint8Array, size: number): number {
    if (head.byteLength < 20) throw new ModelFileError("The provider returned a file that is not a GLB model.");
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
        throw new ModelFileError("The provider returned a file that is not a GLB model.");
    }
    if (view.getUint32(4, true) !== 2) throw new ModelFileError("The provider returned an unsupported glTF version.");
    // The header states the length of the whole file. More than what arrived means a cut-off file; fewer is let
    // through on purpose (loaders ignore trailing bytes, and refusing a paid model over padding would be worse).
    if (view.getUint32(8, true) > size) throw new ModelFileError("The GLB file is incomplete.");
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength === 0) {
        throw new ModelFileError("The GLB file is malformed.");
    }
    return jsonLength;
}

/** Number of nodes that carry a mesh (the parts of an assembly), or null when the JSON is too big to read. */
function countMeshNodes(json: Uint8Array): number {
    let doc: unknown;
    try {
        doc = JSON.parse(new TextDecoder().decode(json));
    } catch {
        throw new ModelFileError("The GLB file is malformed.");
    }
    const nodes = (doc as { nodes?: unknown }).nodes;
    if (!Array.isArray(nodes)) return 0;
    return nodes.filter((n) => typeof n === "object" && n !== null && typeof (n as { mesh?: unknown }).mesh === "number")
        .length;
}

/**
 * Downloads `source` into R2 at `key`. Throws ModelFileError (message safe for the user) on any problem.
 * A hiccup (dropped connection, 5xx, 429, timeout) is retried by fetching again, within one time budget; the
 * file is read into memory instead only when the vendor gives no usable size, or when a size that fits in
 * memory keeps disagreeing with the body (a proxy that rewrites it).
 */
export async function storeGlb(env: Env, source: string, key: string): Promise<StoredGlb> {
    const deadline = Date.now() + DOWNLOAD_BUDGET_MS;
    let trustLength = true;
    let interrupted = 0;
    for (let attempt = 1; ; attempt++) {
        try {
            return await storeOnce(env, source, key, Math.min(DOWNLOAD_TIMEOUT_MS, deadline - Date.now()), trustLength);
        } catch (err) {
            const again =
                err instanceof ModelFileError &&
                err.retryable &&
                attempt < MAX_DOWNLOAD_ATTEMPTS &&
                deadline - Date.now() > MIN_ATTEMPT_MS + RETRY_PAUSE_MS * attempt;
            if (!again) throw err;
            if (err instanceof DownloadInterrupted && ++interrupted >= 2 && err.declared <= MAX_BUFFERED_BYTES) {
                trustLength = false;
            }
            await sleep(RETRY_PAUSE_MS * attempt);
        }
    }
}

async function storeOnce(
    env: Env,
    source: string,
    key: string,
    timeoutMs: number,
    trustLength: boolean,
): Promise<StoredGlb> {
    const res = await openSource(env, source, timeoutMs);
    if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        // 5xx, 408 and 429 are the host having a moment; any other status will not change on a retry.
        const transient = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new ModelFileError(`Downloading the generated model failed (HTTP ${res.status}).`, transient);
    }
    const length = trustLength ? trustedLength(res) : null;
    if (length !== null && length > MAX_GLB_BYTES) {
        await res.body.cancel().catch(() => {});
        throw new ModelFileError("The generated model is larger than the 150 MB limit.");
    }
    return length !== null ? storeStreamed(env, res.body, length, key) : storeBuffered(env, res.body, key);
}

/** Known size: pipe the body straight into R2 without touching the bytes in JavaScript, then inspect it there. */
async function storeStreamed(
    env: Env,
    body: ReadableStream<Uint8Array>,
    length: number,
    key: string,
): Promise<StoredGlb> {
    const { readable, writable } = new FixedLengthStream(length);
    const [piped, put] = await Promise.allSettled([
        body.pipeTo(writable),
        env.FILES.put(key, readable, { httpMetadata: { contentType: GLB_CONTENT_TYPE } }),
    ]);
    if (piped.status === "rejected" || put.status === "rejected") {
        await env.FILES.delete(key).catch(() => {});
        throw new DownloadInterrupted("Copying the generated model was interrupted.", length);
    }
    try {
        const head = await env.FILES.get(key, { range: { offset: 0, length: 20 } });
        const jsonLength = readGlbHeader(new Uint8Array(await (head?.arrayBuffer() ?? new ArrayBuffer(0))), length);
        let partCount: number | null = null;
        if (jsonLength <= MAX_JSON_CHUNK_BYTES && 20 + jsonLength <= length) {
            const chunk = await env.FILES.get(key, { range: { offset: 20, length: jsonLength } });
            partCount = countMeshNodes(new Uint8Array(await (chunk?.arrayBuffer() ?? new ArrayBuffer(0))));
        }
        return { size: length, partCount };
    } catch (err) {
        await env.FILES.delete(key).catch(() => {});
        throw err;
    }
}

/** Unknown size: read with a running byte count, validate, then store. */
async function storeBuffered(env: Env, body: ReadableStream<Uint8Array>, key: string): Promise<StoredGlb> {
    const bytes = await readStreamLimited(body, MAX_BUFFERED_BYTES);
    if (!bytes) {
        throw new ModelFileError(
            "The provider did not report the file size and the model is too large to buffer (over 40 MB).",
        );
    }
    const jsonLength = readGlbHeader(bytes.subarray(0, 20), bytes.byteLength);
    const partCount =
        jsonLength <= MAX_JSON_CHUNK_BYTES && 20 + jsonLength <= bytes.byteLength
            ? countMeshNodes(bytes.subarray(20, 20 + jsonLength))
            : null;
    try {
        await env.FILES.put(key, bytes, { httpMetadata: { contentType: GLB_CONTENT_TYPE } });
    } catch {
        throw new ModelFileError("Storing the generated model failed.", true);
    }
    return { size: bytes.byteLength, partCount };
}

// ---------- Provider thumbnail (optional) ----------

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Stores a provider still as model-thumbs/<modelId>.<ext>. Returns the R2 key, or null on any problem. */
export async function storeThumbnail(env: Env, source: string, modelId: string): Promise<string | null> {
    try {
        const res = await openSource(env, source, THUMBNAIL_TIMEOUT_MS);
        if (!res.ok || !res.body) return null;
        const length = trustedLength(res);
        if (length !== null && length > MAX_THUMBNAIL_BYTES) return null;
        const bytes = await readStreamLimited(res.body, MAX_THUMBNAIL_BYTES);
        if (!bytes || bytes.byteLength === 0) return null;
        const type = sniffImageType(bytes);
        const ext = type ? IMAGE_TYPES[type] : null;
        if (!type || !ext) return null;
        const key = `model-thumbs/${modelId}.${ext}`;
        await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
        return key;
    } catch {
        return null;
    }
}
