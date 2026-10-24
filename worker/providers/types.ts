// Text-to-3D provider adapters: the seam between the job engine (worker/jobs.ts) and each vendor API.
// An adapter only talks to its vendor. The job engine stores tasks in D1, copies results into R2,
// and turns them into ModelAssets.

import type { ProviderId, ProviderInfo } from "../../src/assignment/shared/contract.ts";

export interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    FILES: R2Bucket;
    // Secrets (wrangler secret put / .dev.vars). A provider is available only when its key is set.
    FAL_KEY?: string;
    TRIPO_API_KEY?: string;
    MESHY_API_KEY?: string;
    TENCENTCLOUD_SECRET_ID?: string; // Tencent Cloud API key pair for Hunyuan 3D (HY 3D Global)
    TENCENTCLOUD_SECRET_KEY?: string;
    ACCESS_CODE?: string; // when set, POST /generate needs it in the x-access-code header
    // Vars
    DAILY_GENERATION_LIMIT?: string;
    ALLOW_OPEN_GENERATION?: string; // "1" lets paid generation run without an ACCESS_CODE (deliberate opt-out)
    MOCK_PROVIDER?: string; // "1" enables the offline mock provider (local dev only)
}

export type Via = "fal" | "tripo" | "meshy" | "tencent" | "mock";

/** JSON-serialisable adapter state, persisted in jobs.provider_state between polls. */
export type AdapterState = Record<string, unknown> | null;

export interface SubmitResult {
    taskId: string;
    state?: AdapterState;
}

export type PollResult =
    | {
          status: "queued" | "running";
          progress?: number; // 0-100 when the vendor reports it; the engine estimates otherwise
          stage?: string; // "Generating mesh", "Texturing", ...
          state?: AdapterState; // replaces the stored state when present (multi-stage flows)
      }
    | {
          status: "succeeded";
          /** https URL of the GLB, or "asset:/path" for a file served by env.ASSETS (mock provider). */
          glbUrl: string;
          thumbnailUrl?: string | null;
          state?: AdapterState;
      }
    | { status: "failed"; error: string }
    | { status: "canceled" };

export interface ProviderAdapter {
    via: Via;
    /** Starts the vendor task. Throw ProviderError with a readable message on failure. */
    submit(env: Env, prompt: string): Promise<SubmitResult>;
    poll(env: Env, taskId: string, state: AdapterState): Promise<PollResult>;
    /**
     * Best-effort: stop the vendor task so it stops costing credits. Never throws. A vendor that cannot stop a
     * started task (Tencent, Tripo) has no cancel() at all: that is how the engine knows it must refuse "Stop" for
     * such a job instead of marking it canceled while the vendor keeps running (and charging) it. An adapter whose
     * tasks cost nothing to leave alone (the mock) therefore still defines a no-op cancel().
     */
    cancel?(env: Env, taskId: string, state: AdapterState): Promise<void>;
}

/** One selectable model in the UI, with the APIs that can serve it, in order of preference. */
export interface ProviderSpec {
    id: ProviderId;
    info: Omit<ProviderInfo, "id" | "via" | "available">;
    routes: Array<{ via: Via; adapter: ProviderAdapter; enabled(env: Env): boolean }>;
}

/** A retryable error that may turn out to be real: after `max` errors of this `kind` in a row, the job fails with it. */
export interface RetryLimit {
    kind: string;
    max: number;
}

/** Errors whose message is safe and useful to show the user (never include keys). */
export class ProviderError extends Error {
    readonly status: number;
    /**
     * Transient (timeout, 429, 5xx): while polling, the adapter reports "running" and tries again. At submit time a
     * retryable error is ambiguous instead: the request may have reached the vendor and created a (paid) task.
     */
    readonly retryable: boolean;
    /** Only with `retryable`: caps how many of this same kind of error may repeat before the job fails (see guardPoll). */
    readonly limit: RetryLimit | null;
    constructor(message: string, status = 502, retryable = false, limit: RetryLimit | null = null) {
        super(message);
        this.name = "ProviderError";
        this.status = status;
        this.retryable = retryable;
        this.limit = limit;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Helpers shared by the vendor adapters (fal.ts, tripo.ts, meshy.ts): one place for the request timeout,
// the HTTP error wording and the "keep polling through a vendor hiccup" rule.
// ---------------------------------------------------------------------------------------------------------

export const REQUEST_TIMEOUT_MS = 20_000;
/** Consecutive transient poll errors (timeouts, 429, 5xx) tolerated before the job is failed (~1-2 min, one real poll per 3-6 s). */
export const MAX_TRANSIENT_POLL_ERRORS = 20;

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The https URL of a vendor file field: a bare string or a fal-style `{url, file_name, ...}` object. */
export function fileUrl(value: unknown): string | null {
    const url = typeof value === "string" ? value : isRecord(value) ? asString(value.url) : null;
    return url !== null && url.startsWith("https://") ? url : null;
}

/** False for URLs/file names that clearly are not a binary glTF (FBX, OBJ, images, ...). */
export function looksLikeGlb(url: string | null, fileName?: string | null): boolean {
    if (url === null) return false;
    const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? null;
    let pathname = url;
    try {
        pathname = new URL(url).pathname; // the extension of the path only, never of the host or the query
    } catch {
        // not parseable: judge the raw string
    }
    const known = [fileName ? ext(fileName) : null, ext(pathname)].filter((e): e is string => e !== null);
    if (known.includes("glb")) return true;
    return known.length === 0;
}

/** Trims the prompt and cuts it to the vendor's limit at a word boundary; `trimmedTo` is set when it was cut. */
export function preparePrompt(raw: string, max: number): { prompt: string; trimmedTo: number | null } {
    const text = raw.trim();
    if (!text) throw new ProviderError("The prompt is empty.", 422);
    const chars = Array.from(text); // code points, so an emoji is never cut in half
    if (chars.length <= max) return { prompt: text, trimmedTo: null };
    const cut = chars.slice(0, max).join("");
    const lastSpace = cut.lastIndexOf(" ");
    return { prompt: (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd(), trimmedTo: max };
}

/** Appends the "prompt shortened" note (kept in the adapter state at submit time) to a stage label. */
export function withPromptNote(stage: string, state: AdapterState): string {
    const limit = isRecord(state) ? asNumber(state.prompt_trimmed_to) : null;
    return limit === null ? stage : `${stage} (prompt shortened to ${limit} characters)`;
}

/** The secret, trimmed (a pasted key often carries a newline, which is an invalid header value). */
export function requireKey(key: string | undefined, envName: string): string {
    const trimmed = key?.trim();
    if (!trimmed) throw new ProviderError(`${envName} is not configured`, 503);
    return trimmed;
}

export type FailureKind = "auth" | "credits" | "plan" | "rate" | "busy" | "content";

export interface VendorReply {
    status: number;
    headers: Headers;
    /** The JSON object body, or null when the reply was not a JSON object. */
    body: Json | null;
    text: string;
}

export interface VendorInfo {
    name: string; // used in messages: "fal.ai", "Tripo", "Meshy"
    authScheme: "Key" | "Bearer";
    billingUrl: string; // where to top up, shown without a scheme
    /** Reads vendor-specific error codes out of a reply; null falls back to the HTTP status. */
    classify?(reply: VendorReply): FailureKind | null;
}

/** One vendor call: auth header, JSON body, 20 s timeout. Network errors and timeouts become retryable errors. */
export async function vendorFetch(
    vendor: VendorInfo,
    key: string,
    url: string,
    init: { method?: string; json?: unknown } = {},
): Promise<VendorReply> {
    const headers: Record<string, string> = { Authorization: `${vendor.authScheme} ${key}`, Accept: "application/json" };
    if (init.json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    let text: string;
    try {
        res = await fetch(url, {
            method: init.method ?? "GET",
            headers,
            body: init.json === undefined ? undefined : JSON.stringify(init.json),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        text = await res.text();
    } catch (err) {
        const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
        // The URL is left out of the message on purpose: result URLs are signed.
        throw new ProviderError(
            timedOut ? `${vendor.name} did not answer in time` : `Could not reach ${vendor.name}`,
            timedOut ? 504 : 502,
            true,
        );
    }
    let body: Json | null = null;
    try {
        const parsed: unknown = JSON.parse(text);
        body = isRecord(parsed) ? parsed : null;
    } catch {
        // not JSON (an HTML error page from a proxy, an empty 200): body stays null
    }
    return { status: res.status, headers: res.headers, body, text };
}

/** A short human line from a vendor error body ({message}, {detail}, {error}, Tripo's {message, suggestion}). */
export function describeBody(reply: VendorReply, key: string): string | null {
    const body = reply.body;
    let detail: string | null = null;
    if (body) {
        const first = Array.isArray(body.detail) && isRecord(body.detail[0]) ? body.detail[0] : null;
        detail =
            asString(body.message) ??
            asString(body.detail) ??
            (first ? asString(first.msg) : null) ??
            asString(body.error) ??
            (isRecord(body.error) ? asString(body.error.message) : null);
        const hint = asString(body.suggestion);
        if (detail && hint) detail = `${detail} (${hint})`;
    } else if (reply.text && !reply.text.trimStart().startsWith("<")) {
        detail = reply.text; // plain-text error; an HTML page is not worth showing
    }
    if (!detail) return null;
    detail = detail.replace(/\s+/g, " ").trim();
    if (key.length >= 8) detail = detail.split(key).join("***");
    return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}

function defaultKind(status: number): FailureKind | null {
    if (status === 401) return "auth";
    if (status === 402 || status === 403) return "credits";
    if (status === 429) return "rate";
    return null;
}

/**
 * Turns a failed vendor reply into a ProviderError with a message that is safe to show in the UI. While
 * polling, rate limits and 5xx are marked retryable so guardPoll keeps the job running instead of failing it.
 */
export function failure(vendor: VendorInfo, reply: VendorReply, phase: "submit" | "poll", key: string): ProviderError {
    const { name, billingUrl } = vendor;
    const { status } = reply;
    const classified = vendor.classify?.(reply) ?? null;
    const kind = classified ?? defaultKind(status);
    const polling = phase === "poll";
    switch (kind) {
        case "auth":
            return new ProviderError(`The ${name} API key was rejected (${status})`, 502);
        case "credits":
            // A bare 403 can also mean a key without access, so say so unless the body spelled out the credits.
            return new ProviderError(
                classified === null && status === 403
                    ? `Out of credits on ${name}, or the key lacks access (403) — top up at ${billingUrl}`
                    : `Out of credits on ${name} — top up at ${billingUrl}`,
                502,
            );
        case "plan":
            return new ProviderError(`${name} API access needs a paid plan — upgrade at ${billingUrl}`, 502);
        case "rate":
            return polling
                ? new ProviderError(`Rate limited by ${name}, retrying…`, 429, true)
                : new ProviderError(`Rate limited by ${name} — too many requests. Wait a moment and try again.`, 429);
        case "busy":
            return polling
                ? new ProviderError(`${name} is busy, retrying…`, 429, true)
                : new ProviderError(
                      `${name} is already running the maximum number of tasks for this account. Wait for one to finish.`,
                      429,
                  );
        case "content":
            return new ProviderError(`${name} rejected the prompt (content policy). Try rewording it.`, 422);
        default:
            break;
    }
    if (status >= 500) {
        return polling
            ? new ProviderError(`${name} is having trouble (${status}), retrying…`, 502, true)
            : new ProviderError(`${name} had a server error (${status}). Try again in a moment.`, 502);
    }
    const detail = describeBody(reply, key);
    return new ProviderError(
        `${name} rejected the request (${status})${detail ? `: ${detail}` : ""}`,
        status === 400 || status === 422 ? 422 : 502,
    );
}

function transientCount(state: AdapterState): number {
    return isRecord(state) ? (asNumber(state.transient_errors) ?? 0) : 0;
}

/** How many errors of this kind came in a row just before, from the streak that guardPoll keeps in the state. */
function streakOf(state: AdapterState, kind: string): number {
    return isRecord(state) && state.transient_kind === kind ? (asNumber(state.transient_kind_count) ?? 0) : 0;
}

function without(state: AdapterState | undefined, keys: string[]): AdapterState {
    if (!isRecord(state)) return state ?? null;
    const rest: Record<string, unknown> = { ...state };
    for (const key of keys) delete rest[key];
    return rest;
}

const STREAK_KEYS = ["transient_kind", "transient_kind_count"];

export interface GuardOptions {
    /** Consecutive transient errors tolerated, whatever their kind. Default MAX_TRANSIENT_POLL_ERRORS. */
    maxTransient?: number;
}

/**
 * Wraps one poll: a vendor hiccup (timeout, 429, 5xx) keeps the job "running" with the error as its stage text
 * and counts it in the state; a real error fails the job with the message. The counter resets on the next
 * clean poll, and the job fails after `maxTransient` in a row so a dead vendor cannot hang it. An error with a
 * `limit` is retried like a hiccup but fails the job with its own message once that many of the same kind repeat:
 * for answers that are probably real but would be costly to act on if they were a blip.
 */
export async function guardPoll(
    state: AdapterState,
    run: () => Promise<PollResult>,
    options: GuardOptions = {},
): Promise<PollResult> {
    const before = transientCount(state);
    const maxTransient = options.maxTransient ?? MAX_TRANSIENT_POLL_ERRORS;
    try {
        const result = await run();
        if (before > 0 && (result.status === "queued" || result.status === "running")) {
            const keys = ["transient_errors", ...STREAK_KEYS];
            return { ...result, state: without(result.state !== undefined ? result.state : state, keys) };
        }
        return result;
    } catch (err) {
        // Anything that is not a ProviderError is unexpected: let the engine's own poll-error counter handle it.
        if (!(err instanceof ProviderError)) throw err;
        if (!err.retryable) return { status: "failed", error: err.message };
        const count = before + 1;
        const reason = err.message.replace(/,? retrying…$/, "");
        const streak = err.limit ? streakOf(state, err.limit.kind) + 1 : 0;
        if (err.limit && streak > err.limit.max) return { status: "failed", error: reason };
        if (count > maxTransient) return { status: "failed", error: `Gave up after ${count} failed attempts: ${reason}` };
        const kept = without(state, STREAK_KEYS); // a different kind of error, or none, ends the previous streak
        const next: Record<string, unknown> = { ...(isRecord(kept) ? kept : {}), transient_errors: count };
        if (err.limit) {
            next.transient_kind = err.limit.kind;
            next.transient_kind_count = streak;
        }
        return { status: "running", stage: err.message, state: next };
    }
}
