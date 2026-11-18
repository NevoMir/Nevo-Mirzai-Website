// Who is calling. Three kinds of caller:
// - the founder: signs in once with the owner key (Worker secret OUTREACH_KEY) on the login page and then holds a signed cookie;
// - an agent with a key the founder created ("Authorization: Bearer llo_<id>_<secret>"; only a hash of the secret is stored);
// - an agent in a browser, which never types a key: the founder gives it a one-time link that opens a signed agent cookie.
// The owner key is never accepted as a Bearer token, except by the data upload endpoints (/api/outreach/admin/*).

import { secretsMatch } from "../util.ts";
import type { OutreachEnv } from "./types.ts";

export type Role = "owner" | "agent" | "reply-check";
export interface Actor {
    role: Role;
    /** "you" for the founder, else the agent's name as the founder typed it. */
    name: string;
    keyId: string | null;
    canSend: boolean;
    fullRead: boolean;
    via: "cookie" | "bearer" | "owner-key";
    inboxCheckedAt: string | null;
}
export const OWNER_NAME = "you";

const COOKIE = "__Host-llo";
const DEV_COOKIE = "llo_dev";
export const OWNER_SESSION_DAYS = 14;
export const AGENT_SESSION_HOURS = 12;
export const MIN_OWNER_KEY_LENGTH = 32;

const enc = new TextEncoder();

export const isConfigured = (env: OutreachEnv): boolean =>
    !!env.OUTREACH_DB && !!env.OUTREACH_KEY && env.OUTREACH_KEY.length >= MIN_OWNER_KEY_LENGTH;

/* ---------- encoding ---------- */

export function b64url(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array | null {
    try {
        const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
        return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } catch {
        return null;
    }
}
export const randomToken = (bytes = 32): string => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";
export function randomId(n = 10): string {
    const r = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(r, (x) => ID_CHARS[x % ID_CHARS.length]).join("");
}
export async function sha256Hex(s: string): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
    return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------- the session cookie ---------- */

// The cookie key is derived from the owner key, so changing OUTREACH_KEY also signs everyone out.
let cachedKey: { source: string; key: CryptoKey } | null = null;
async function sessionKey(env: OutreachEnv): Promise<CryptoKey> {
    const source = env.OUTREACH_KEY as string;
    if (cachedKey && cachedKey.source === source) return cachedKey.key;
    const base = await crypto.subtle.importKey("raw", enc.encode(source), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, enc.encode("client-outreach session v1"));
    const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    cachedKey = { source, key };
    return key;
}

interface Session {
    role: "owner" | "agent";
    sub: string;
    epoch: number;
    exp: number;
}

async function signSession(env: OutreachEnv, s: Session): Promise<string> {
    const payload = `v1.${s.role}.${s.sub}.${s.epoch}.${s.exp}`;
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload)));
    return `${payload}.${b64url(sig)}`;
}

async function readSessionCookie(request: Request, env: OutreachEnv): Promise<Session | null> {
    // The plain dev cookie only on a local http wrangler dev: elsewhere only the __Host- cookie, which no subdomain can plant.
    const raw = cookieValue(request, COOKIE) ?? (isLocalHttp(request) ? cookieValue(request, DEV_COOKIE) : null);
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length !== 6 || parts[0] !== "v1" || (parts[1] !== "owner" && parts[1] !== "agent")) return null;
    const sig = fromB64url(parts[5]);
    if (!sig) return null;
    const ok = await crypto.subtle.verify("HMAC", await sessionKey(env), sig, enc.encode(parts.slice(0, 5).join(".")));
    if (!ok) return null;
    const epoch = Number(parts[3]);
    const exp = Number(parts[4]);
    if (!Number.isInteger(epoch) || !Number.isInteger(exp) || exp * 1000 < Date.now()) return null;
    return { role: parts[1], sub: parts[2], epoch, exp };
}

function cookieValue(request: Request, name: string): string | null {
    const header = request.headers.get("Cookie") || "";
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}

/** A plain-http localhost (wrangler dev) cannot hold a __Host- cookie, which must be Secure. */
function isLocalHttp(request: Request): boolean {
    const u = new URL(request.url);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

export async function sessionCookieHeader(request: Request, env: OutreachEnv, role: "owner" | "agent", sub: string, epoch: number): Promise<string> {
    const ttl = role === "owner" ? OWNER_SESSION_DAYS * 86400 : AGENT_SESSION_HOURS * 3600;
    const value = await signSession(env, { role, sub, epoch, exp: Math.floor(Date.now() / 1000) + ttl });
    if (isLocalHttp(request)) return `${DEV_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}`;
    return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${ttl}`;
}

export function clearCookieHeader(request: Request): string {
    return isLocalHttp(request) ? `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` : `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/* ---------- the epoch: "sign out everywhere" ---------- */

export async function currentEpoch(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT data FROM meta WHERE key = 'auth'").first<{ data: string }>();
    if (!row) return 1;
    try {
        const n = Number(JSON.parse(row.data).epoch);
        return Number.isInteger(n) && n > 0 ? n : 1;
    } catch {
        return 1;
    }
}

/* ---------- keys ---------- */

export function checkOwnerKey(env: OutreachEnv, candidate: string): Promise<boolean> {
    return secretsMatch(candidate, env.OUTREACH_KEY as string);
}

export interface KeyRow {
    id: string;
    name: string;
    hash: string;
    role: string;
    can_send: number;
    full_read: number;
    expires_at: string | null;
    revoked_at: string | null;
    last_used_at: string | null;
    inbox_checked_at: string | null;
}

const KEY_RE = /^llo_([a-z2-9]{10})_([A-Za-z0-9_-]{43})$/;
const DUMMY_HASH = "0".repeat(64);

export function keyIsLive(row: KeyRow | null, now = new Date()): row is KeyRow {
    return !!row && !row.revoked_at && (!row.expires_at || new Date(row.expires_at) > now);
}

/** The agent behind a Bearer key, or null. Always hashes and compares, so a wrong id and a wrong secret take the same time. */
async function agentFromKey(db: D1Database, token: string): Promise<Actor | null> {
    const m = KEY_RE.exec(token);
    const row = m ? await db.prepare("SELECT * FROM agent_keys WHERE id = ?").bind(m[1]).first<KeyRow>() : null;
    const hash = await sha256Hex(m ? m[2] : token);
    const ok = await secretsMatch(hash, row ? row.hash : DUMMY_HASH);
    if (!ok || !keyIsLive(row)) return null;
    await touchKey(db, row);
    return actorFromRow(row, "bearer");
}

export function actorFromRow(row: KeyRow, via: Actor["via"]): Actor {
    return {
        role: row.role === "reply-check" ? "reply-check" : "agent",
        name: row.name,
        keyId: row.id,
        canSend: row.role === "agent" && row.can_send === 1,
        fullRead: row.full_read === 1,
        via,
        inboxCheckedAt: row.inbox_checked_at,
    };
}

/** last_used_at moves at most once an hour, so reading does not turn into a write on every request. */
async function touchKey(db: D1Database, row: KeyRow): Promise<void> {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (row.last_used_at && row.last_used_at > hourAgo) return;
    await db.prepare("UPDATE agent_keys SET last_used_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
}

export async function newAgentKey(): Promise<{ id: string; token: string; hash: string }> {
    const id = randomId(10);
    const secret = randomToken(32);
    return { id, token: `llo_${id}_${secret}`, hash: await sha256Hex(secret) };
}

/* ---------- failed attempts ---------- */

const FAIL_WINDOW_MIN = 15;
const FAIL_LIMIT = 20;

export const clientIp = (request: Request): string => request.headers.get("CF-Connecting-IP") || "local";

/**
 * Failed attempts are counted per kind ("login" or "key") and address, and only refusals count: a valid key or a valid
 * login is never turned away because someone else at the same address guessed wrong.
 */
export const failureKey = (kind: "login" | "key", request: Request): string => `${kind}:${clientIp(request)}`;

export async function tooManyFailures(db: D1Database, key: string): Promise<boolean> {
    const row = await db.prepare("SELECT window_start, count FROM auth_failures WHERE ip = ?").bind(key).first<{ window_start: string; count: number }>();
    if (!row) return false;
    const fresh = new Date(row.window_start).getTime() > Date.now() - FAIL_WINDOW_MIN * 60_000;
    return fresh && row.count >= FAIL_LIMIT;
}

export async function noteFailure(db: D1Database, key: string): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - FAIL_WINDOW_MIN * 60_000).toISOString();
    await db
        .prepare(
            `INSERT INTO auth_failures (ip, window_start, count) VALUES (?1, ?2, 1)
             ON CONFLICT(ip) DO UPDATE SET
               count = CASE WHEN auth_failures.window_start < ?3 THEN 1 ELSE auth_failures.count + 1 END,
               window_start = CASE WHEN auth_failures.window_start < ?3 THEN ?2 ELSE auth_failures.window_start END`,
        )
        .bind(key, now.toISOString(), cutoff)
        .run();
}

/* ---------- the caller of a request ---------- */

export interface AuthResult {
    actor: Actor | null;
    /** A credential was offered and refused (so the caller should be told, and the attempt counted). */
    refused: boolean;
}

/**
 * Bearer first (agents), then the cookie (the founder, or an agent's browser session). `allowOwnerKey` lets the data upload
 * script use the owner key directly.
 */
export async function authenticate(request: Request, env: OutreachEnv, allowOwnerKey = false): Promise<AuthResult> {
    const db = env.OUTREACH_DB as D1Database;
    const header = request.headers.get("Authorization") || "";
    if (header) {
        const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? "";
        if (!token) return { actor: null, refused: true };
        if (allowOwnerKey && !token.startsWith("llo_") && (await checkOwnerKey(env, token))) {
            return { actor: { role: "owner", name: OWNER_NAME, keyId: null, canSend: true, fullRead: true, via: "owner-key", inboxCheckedAt: null }, refused: false };
        }
        const agent = await agentFromKey(db, token);
        return { actor: agent, refused: !agent };
    }
    const s = await readSessionCookie(request, env);
    if (!s) return { actor: null, refused: false };
    if (s.epoch !== (await currentEpoch(db))) return { actor: null, refused: false };
    if (s.role === "owner") {
        return { actor: { role: "owner", name: OWNER_NAME, keyId: null, canSend: true, fullRead: true, via: "cookie", inboxCheckedAt: null }, refused: false };
    }
    const row = await db.prepare("SELECT * FROM agent_keys WHERE id = ?").bind(s.sub).first<KeyRow>();
    if (!keyIsLive(row)) return { actor: null, refused: false };
    return { actor: actorFromRow(row, "cookie"), refused: false };
}

/**
 * A browser holding a cookie must prove a write comes from this site's own page (CSRF). Bearer callers carry no ambient
 * credential, so they need no such proof.
 */
export function sameOriginWrite(request: Request, actor: Actor): boolean {
    if (actor.via !== "cookie" || request.method === "GET" || request.method === "HEAD") return true;
    return isSameOriginRequest(request);
}

/** The page's own form posts and fetches: a matching Origin, or the browser's own Sec-Fetch-Site (a page cannot forge it). */
export function isSameOriginRequest(request: Request): boolean {
    if (request.headers.get("Origin") === new URL(request.url).origin) return true;
    return request.headers.get("Sec-Fetch-Site") === "same-origin";
}
