// Small shared helpers for the /assignment_alex Worker: JSON responses, errors, body reading, validation.

export const JSON_BODY_LIMIT = 256 * 1024;

const API_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
};

/** An error whose message is safe to show to the client. Anything else becomes a generic 500. */
export class HttpError extends Error {
    readonly status: number;
    readonly headers: Record<string, string> | undefined;
    constructor(status: number, message: string, headers?: Record<string, string>) {
        super(message);
        this.name = "HttpError";
        this.status = status;
        this.headers = headers;
    }
}

export function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...API_HEADERS, ...extraHeaders },
    });
}

export function jsonError(status: number, message: string, extraHeaders?: Record<string, string>): Response {
    return json({ error: message }, status, extraHeaders);
}

export const nowIso = (): string => new Date().toISOString();

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_RE.test(value);

/** Path/body ids must look like UUIDs: a malformed one is a 400, a well-formed unknown one a 404 later. */
export function requireUuid(value: unknown, what: string): string {
    if (!isUuid(value)) throw new HttpError(400, `Invalid ${what}`);
    return value.toLowerCase();
}

/** Reads a stream into memory with a running byte count; null when it grows past `max` (the rest is discarded). */
export async function readStreamLimited(
    body: ReadableStream<Uint8Array> | null,
    max: number,
): Promise<Uint8Array | null> {
    if (!body) return new Uint8Array(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Reads a request body into memory, refusing anything over `max` bytes (declared or actual). */
export async function readBytes(request: Request, max: number): Promise<Uint8Array> {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "Request body too large");
    const bytes = await readStreamLimited(request.body, max);
    if (!bytes) throw new HttpError(413, "Request body too large");
    return bytes;
}

/**
 * Parses a JSON object body (<= 256 KB unless `max` says less); an empty body counts as {}.
 * Arrays, scalars and invalid JSON are 400s, an oversized body a 413.
 */
export async function readJsonObject(request: Request, max = JSON_BODY_LIMIT): Promise<Record<string, unknown>> {
    const bytes = await readBytes(request, max);
    if (bytes.byteLength === 0) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new HttpError(400, "Request body must be valid JSON");
    }
    if (!isRecord(parsed)) throw new HttpError(400, "Request body must be a JSON object");
    return parsed;
}

// ---------- Field validation ----------

export const DEFAULT_PROJECT_NAME = "Untitled project";
const NAME_MAX = 120;

/** A trimmed 1..120 character name. */
export function parseName(value: unknown, field = "name"): string {
    if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
    const name = value.trim();
    if (name.length < 1 || name.length > NAME_MAX) {
        throw new HttpError(400, `${field} must be 1 to ${NAME_MAX} characters`);
    }
    return name;
}

export function parseColor(value: unknown): string {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
        throw new HttpError(400, "color must look like #rrggbb");
    }
    return value.toLowerCase();
}

/** A lucide icon name (alphanumeric, <= 64 chars) or null for a plain colour dot. */
export function parseIcon(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    // Lucide icon names are PascalCase; requiring a capital first letter also rules out keys like "constructor".
    if (typeof value !== "string" || !/^[A-Z][A-Za-z0-9]{0,63}$/.test(value)) {
        throw new HttpError(400, "icon must be null or a PascalCase icon name of up to 64 letters and digits");
    }
    return value;
}

/** A non-empty list of distinct UUIDs (deduplicated), for the bulk endpoints. */
export function parseIdList(value: unknown, max = 500): string[] {
    if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "ids must be a non-empty array");
    if (value.length > max) throw new HttpError(400, `At most ${max} ids per request`);
    const ids = new Set<string>();
    for (const id of value) ids.add(requireUuid(id, "id"));
    return [...ids];
}

/** Compares secrets without leaking their length or content through timing (hashes both first). */
export async function secretsMatch(a: string, b: string): Promise<boolean> {
    const enc = new TextEncoder();
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest("SHA-256", enc.encode(a)),
        crypto.subtle.digest("SHA-256", enc.encode(b)),
    ]);
    const x = new Uint8Array(ha);
    const y = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

export function errorSummary(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
    return "unknown error";
}

/**
 * D1 says a column or table is missing: the code is newer than the database, i.e. a migration has not been applied yet
 * (deploy order: `npx wrangler d1 migrations apply assignment-alex --remote` first, then the Worker).
 */
export function isSchemaMismatch(err: unknown): boolean {
    return err instanceof Error && /no such (column|table)|has no column named/i.test(err.message);
}

/** The image type a byte string really is (PNG, JPEG or WebP), or null. Never trust a header alone. */
export function sniffImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    return null;
}

/**
 * The pixel size an image declares in its header, or null when it cannot be read. Only the headers are parsed
 * (nothing is decoded), so the check is cheap; it exists to refuse an image that claims to be gigantic.
 */
export function imageSize(
    bytes: Uint8Array,
    type: "image/png" | "image/jpeg" | "image/webp",
): { width: number; height: number } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at: number) => (at + 4 <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + 4)) : "");
    if (type === "image/png") {
        // 8-byte signature, then the IHDR chunk: length, "IHDR", width and height as big-endian 32-bit numbers.
        if (bytes.length < 24 || tag(12) !== "IHDR") return null;
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === "image/webp") {
        // "RIFF" size "WEBP", then the first chunk: extended (VP8X), lossy (VP8 ) or lossless (VP8L).
        const chunk = tag(12);
        if (chunk === "VP8X" && bytes.length >= 30) {
            const at = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
            return { width: at(24) + 1, height: at(27) + 1 };
        }
        if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
            return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }
        if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
            const bits = view.getUint32(21, true);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        return null;
    }
    // JPEG: walk the marker segments until a start-of-frame one, which holds height then width (big-endian 16-bit).
    let at = 2;
    while (at + 4 <= bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker === 0xff) {
            at += 1; // fill byte
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2; // markers without a payload
            continue;
        }
        const length = view.getUint16(at + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
            return at + 9 <= bytes.length ? { width: view.getUint16(at + 7), height: view.getUint16(at + 5) } : null;
        }
        if (marker === 0xda || length < 2) return null; // image data starts without a frame header: unreadable
        at += 2 + length;
    }
    return null;
}
