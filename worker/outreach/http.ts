// Responses for the client-outreach routes. Every response carries the same privacy headers: never cached by a shared cache,
// never indexed, never framed, and no referrer to other sites. ("same-origin", not "no-referrer": with no-referrer a browser
// sends "Origin: null" on its own form posts and fetches, and the sign-in and every write would look cross-site.)

import { HttpError, errorSummary, isSchemaMismatch } from "../util.ts";

export const GUIDE_PATH = "/client-outreach/agents";

const PRIVATE_HEADERS: Record<string, string> = {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
};

/** The page's own scripts and styles only (built by Vite into /assets), Google Fonts, and calls back to this origin. */
export const PAGE_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
].join("; ");

export function withPrivateHeaders(response: Response, extra?: Record<string, string>): Response {
    const out = new Response(response.body, response);
    for (const [k, v] of Object.entries({ ...PRIVATE_HEADERS, ...extra })) out.headers.set(k, v);
    return out;
}

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...PRIVATE_HEADERS, ...extra },
    });
}

/** JSON assembled from pieces that are already JSON text (stored documents), so nothing is parsed and re-serialised. */
export function rawJson(text: string, status = 200, extra?: Record<string, string>): Response {
    return new Response(text, { status, headers: { "Content-Type": "application/json; charset=utf-8", ...PRIVATE_HEADERS, ...extra } });
}

export function html(body: string, status = 200, extra?: Record<string, string>): Response {
    return new Response(body, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, ...PRIVATE_HEADERS, ...extra },
    });
}

export function text(body: string, status = 200, contentType = "text/plain; charset=utf-8", extra?: Record<string, string>): Response {
    return new Response(body, { status, headers: { "Content-Type": contentType, ...PRIVATE_HEADERS, ...extra } });
}

/** Every refusal points an agent at the guide, so one that arrives without instructions can find them. */
export function apiError(status: number, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>): Response {
    return json({ error: message, ...extra, how_to: `Read ${GUIDE_PATH} (public, no data)` }, status, headers);
}

export function unauthorized(): Response {
    return apiError(401, "Sign in first: send an agent key as 'Authorization: Bearer <key>', or open /client-outreach in a browser.", undefined, {
        "WWW-Authenticate": 'Bearer realm="client-outreach"',
    });
}

/** Turns anything thrown by a handler into a response that never echoes internals. */
export function errorResponse(err: unknown): Response {
    if (err instanceof HttpError) return apiError(err.status, err.message, undefined, err.headers);
    if (err instanceof Refusal) return apiError(err.status, err.message, err.extra);
    if (isSchemaMismatch(err)) {
        console.error("outreach: database schema is out of date (npx wrangler d1 migrations apply llo-outreach --remote)");
        return apiError(503, "The server is being updated. Please try again in a few minutes.", undefined, { "Retry-After": "60" });
    }
    // Only the error class and message: never a request body, an address or a query string.
    console.error(`outreach: unhandled error: ${errorSummary(err).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<address>")}`);
    return apiError(500, "Something went wrong on the server. Please try again.");
}

/** A refusal with structured details for agents (what is missing, what to do). */
export class Refusal extends Error {
    readonly status: number;
    readonly extra: Record<string, unknown>;
    constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
        super(message);
        this.name = "Refusal";
        this.status = status;
        this.extra = extra;
    }
}

export const escapeHtml = (s: unknown): string =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
