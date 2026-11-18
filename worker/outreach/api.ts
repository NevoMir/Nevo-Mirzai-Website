// The JSON API under /api/outreach: for the founder's page and for AI agents. Routing, validation and the write paths.
// The rules for who may be written to are in rules.ts and src/client-outreach/shared/core.ts; the guide for agents in guide.ts.
//
// What an agent key reaches: with "full read", every person and the whole research; without it, only the people it holds
// and the people already written to (it needs those to check the mailbox). It changes only what it took: its drafts, its
// sends, notes and the opening of people it holds, and replies, stop requests and bounces from people already written to.

import {
    CLOSED_STATUSES,
    FOLLOWUP_ORDER,
    LANGS,
    OUTCOMES,
    STATUS_VALUES,
    isClosed,
    isValidTimeZone,
    nextEmail,
    sentPatch,
    statusOf,
    statusPatch,
    type Lang,
    type Settings,
    type StatusDoc,
    type StatusValue,
    type Which,
} from "../../src/client-outreach/shared/core.ts";
import { HttpError, isRecord, readJsonObject } from "../util.ts";
import { authenticate, failureKey, newAgentKey, noteFailure, randomToken, sameOriginWrite, sha256Hex, tooManyFailures, type Actor } from "./auth.ts";
import { guideMarkdown } from "./guide.ts";
import { Refusal, apiError, json, rawJson, text, unauthorized } from "./http.ts";
import {
    CLAIM_MINUTES,
    DRAFT_HOLD_DAYS,
    INBOX_FRESH_HOURS,
    MAX_CLAIM_MINUTES,
    REPLY_KINDS,
    claimStatements,
    dailyLimit,
    evaluate,
    evaluateMany,
    lawFor,
    lintEmail,
    notReady,
    pickCandidates,
    readiness,
    replyPatch,
    sendingHolds,
    shiftDay,
    timezoneOf,
    todayOf,
    usageToday,
    type Ctx,
    type Evaluation,
    type ReplyItem,
} from "./rules.ts";
import {
    currentRev,
    logRows,
    logStatement,
    metaJson,
    metaWrite,
    patchStatements,
    pinnedStatements,
    pruneLogStatement,
    readCompanies,
    readPeople,
    researchOf,
    settingsOf,
    stateText,
    type PatchItem,
    type Person,
} from "./store.ts";
import { handleAdmin } from "./admin.ts";
import type { OutreachEnv } from "./types.ts";

export const API = "/api/outreach";
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/i;
const OWNER_BULK = 500;
const AGENT_BULK = 50;
/** People already written to and still in a thread: the ones a reply, a stop request or a bounce can come from. */
const WRITTEN = ["sent", "followup", "replied", "meeting"];
/** Everyone ever written to, including those who said no or asked to stop (they can still write back, for example to ask
 * for their data to be deleted), so a key without full read still sees them for the mailbox check. */
const WRITTEN_ANY = [...WRITTEN, "declined", "optout", "bounced"];

export async function handleOutreachApi(request: Request, env: OutreachEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.slice(API.length).replace(/\/+$/, "") || "/";
    const db = env.OUTREACH_DB as D1Database;
    const isAdmin = path.startsWith("/admin/");

    const auth = await authenticate(request, env, isAdmin);
    if (!auth.actor) {
        if (auth.refused) {
            const fk = failureKey("key", request);
            if (await tooManyFailures(db, fk)) return apiError(429, "Too many failed attempts from this address. Wait 15 minutes.", undefined, { "Retry-After": "900" });
            await noteFailure(db, fk);
        }
        return unauthorized();
    }
    const actor = auth.actor;
    if (!sameOriginWrite(request, actor)) return apiError(403, "This write must come from the outreach page itself.");
    if (request.method !== "GET" && request.method !== "HEAD") {
        const type = request.headers.get("Content-Type") || "";
        if (!isAdmin && !/^application\/json\b/i.test(type)) return apiError(415, "Send the body as JSON (Content-Type: application/json).");
    }
    if (isAdmin) {
        if (actor.role !== "owner") return apiError(403, "Only the founder can upload data.");
        return handleAdmin(request, env, actor, path.slice("/admin".length));
    }

    const settings = await settingsOf(db);
    const tz = timezoneOf(settings);
    const now = new Date();
    const base = { db, actor, settings, tz, today: todayOf(settings, now), now };
    const m = request.method;
    const seg = path.split("/").filter(Boolean);

    // Readable by every signed-in caller.
    if (m === "GET" && path === "/") return overview(base, await researchOf(db));
    if (m === "GET" && path === "/guide") return text(guideMarkdown(new URL(request.url).origin), 200, "text/markdown; charset=utf-8");
    if (m === "GET" && path === "/state") {
        if (actor.role === "agent") return apiError(403, "Agents read people with /contacts, /awaiting-reply and /contacts/<id>.");
        return stateResponse(base, url);
    }
    if (m === "GET" && seg[0] === "data" && seg.length === 2) return dataFile(env, actor, seg[1], request);
    if (m === "GET" && path === "/log") return logResponse(base, url);

    const research = await researchOf(db);
    if (!research) return apiError(503, "The research data has not been uploaded yet.");
    const ctx: Ctx = { ...base, research };

    if (m === "GET" && path === "/contacts") return listContacts(ctx, url);
    if (m === "GET" && path === "/awaiting-reply") return awaitingReply(ctx);
    if (m === "GET" && seg[0] === "contacts" && seg.length === 2) return contactDetail(ctx, requireId(seg[1]));
    if (m === "GET" && path === "/next") return nextResponse(ctx, url);

    const body = m === "GET" ? {} : await readJsonObject(request);
    if (m === "PATCH" && seg[0] === "contacts" && seg.length === 2) return patchContact(ctx, requireId(seg[1]), body);
    if (m === "POST") {
        switch (path) {
            case "/claim":
                return claim(ctx, body);
            case "/renew":
                return renew(ctx, body);
            case "/release":
                return release(ctx, body);
            case "/drafted":
                return drafted(ctx, body);
            case "/sent":
                return sent(ctx, body);
            case "/replies":
                return replies(ctx, body);
            case "/optout":
                return closeWith(ctx, body, "optout");
            case "/bounced":
                return closeWith(ctx, body, "bounced");
            case "/inbox-checked":
                return inboxChecked(ctx, body);
            case "/lint":
                return lint(ctx, body);
            case "/status":
                return setStatus(ctx, body);
        }
    }
    if (m === "PUT" && path === "/meta/sync") return putSync(ctx, body);
    if (actor.role !== "owner") return apiError(403, "Not available with an agent key.");

    // The founder only.
    if (m === "PUT" && path === "/meta/settings") return putSettings(ctx, body);
    if (m === "GET" && path === "/keys") return listKeys(ctx);
    if (m === "POST" && path === "/keys") return createKey(ctx, body);
    if (m === "POST" && seg[0] === "keys" && seg.length === 3 && seg[2] === "revoke") return revokeKey(ctx, seg[1]);
    if (m === "POST" && seg[0] === "keys" && seg.length === 3 && seg[2] === "link") return sessionLink(ctx, seg[1], request);
    if (m === "POST" && path === "/erase") return erase(ctx, body);
    if (m === "POST" && path === "/signout-all") return signoutAll(ctx);
    return apiError(404, "No such endpoint. GET /api/outreach lists them.");
}

/* ---------- small parsers ---------- */

function requireId(v: unknown): string {
    if (typeof v !== "string" || !ID_RE.test(v)) throw new HttpError(400, "Invalid contact id");
    return v;
}
const isWhich = (v: unknown): v is Which => typeof v === "string" && (FOLLOWUP_ORDER as readonly string[]).includes(v);
/** A real calendar day (2026-02-31 is not one). */
function isDay(v: unknown): v is string {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)));
    return d.toISOString().slice(0, 10) === v;
}

function str(v: unknown, field: string, max: number): string {
    if (typeof v !== "string") throw new HttpError(400, `${field} must be text`);
    if (v.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
    return v;
}

/** {ids:[...]} or {items:[{id, ...}]}, deduplicated, at most `max`. */
function parseItems(body: Record<string, unknown>, max: number): Record<string, unknown>[] {
    const raw = Array.isArray(body.items) ? body.items : Array.isArray(body.ids) ? body.ids.map((id) => ({ id })) : null;
    if (!raw || raw.length === 0) throw new HttpError(400, "Send {ids: [...]} or {items: [{id, ...}]}");
    if (raw.length > max) throw new HttpError(400, `At most ${max} people per request`);
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const it of raw) {
        const item = typeof it === "string" ? { id: it } : it;
        if (!isRecord(item)) throw new HttpError(400, "Each item must be an id or an object with an id");
        const id = requireId(item.id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ ...item, id });
    }
    return out;
}
const bulkMax = (actor: Actor) => (actor.role === "owner" ? OWNER_BULK : AGENT_BULK);

/** An opening or angle an agent writes goes into emails to third parties: plain words only, no links or addresses. */
function agentText(v: unknown, field: string): string {
    const t = str(v ?? "", field, 800).trim();
    if (/https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.-]+/i.test(t)) throw new HttpError(400, `${field} must not contain links or email addresses`);
    return t;
}

interface ClaimRow {
    contact_id: string;
    key_id: string;
    state: string;
    which: string;
    until: string;
}

async function claimsOf(ctx: Ctx, ids: string[]): Promise<Map<string, ClaimRow>> {
    if (!ids.length) return new Map();
    const { results } = await ctx.db
        .prepare("SELECT contact_id, key_id, state, which, until FROM claims WHERE contact_id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all<ClaimRow>();
    return new Map(results.map((r) => [r.contact_id, r]));
}

/** This caller holds the person: the founder always, an agent when its own claim is active or a draft. */
const holds = (ctx: Ctx, c: ClaimRow | undefined): boolean =>
    ctx.actor.role === "owner" || (!!c && c.key_id === ctx.actor.keyId && (c.state === "active" || c.state === "drafted"));

const fullReader = (actor: Actor) => actor.role === "owner" || actor.fullRead;

/** A key without full read sees the people it holds and the people already written to, nobody else. */
const mayOpen = (ctx: Ctx, p: Person, c: ClaimRow | undefined): boolean =>
    fullReader(ctx.actor) || holds(ctx, c) || WRITTEN_ANY.includes(statusOf(p.st));

function wordsAboveSignature(body: string): number {
    const top = body.split(/\n(?:Best regards|Meilleures salutations|Cordiali saluti),?\n/)[0].trim();
    return top ? top.split(/\s+/).length : 0;
}

/* ---------- reads ---------- */

async function overview(ctx: Omit<Ctx, "research">, research: Awaited<ReturnType<typeof researchOf>>): Promise<Response> {
    const { db, actor } = ctx;
    const [counts, sync, data, needs] = await Promise.all([
        db
            .prepare(
                "SELECT COALESCE(json_extract(s.data, '$.status'), 'todo') AS status, COUNT(*) AS n FROM contacts c LEFT JOIN status s ON s.id = c.id WHERE c.erased_at IS NULL GROUP BY 1",
            )
            .all<{ status: string; n: number }>(),
        metaJson<Record<string, unknown>>(db, "sync"),
        metaJson<Record<string, unknown>>(db, "data"),
        db
            .prepare(
                `SELECT c.id, json_extract(c.mail, '$.name') AS name, json_extract(c.mail, '$.company') AS company FROM status s JOIN contacts c ON c.id = s.id
                 WHERE c.erased_at IS NULL AND json_extract(s.data, '$.needsAction') = 1 ORDER BY s.updated_at DESC LIMIT 20`,
            )
            .all<{ id: string; name: string; company: string }>(),
    ]);
    const ready = readiness(ctx.settings, research);
    const usage = research ? await usageToday({ ...ctx, research }) : null;
    const byStatus = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));
    return json({
        you: { name: actor.name, role: actor.role, may_send_emails: actor.role === "owner" || actor.canSend, full_read: fullReader(actor) },
        what_to_do:
            actor.role === "owner"
                ? "You are the founder. Everything is open to you."
                : actor.role === "reply-check"
                  ? "You record replies from the founder's mailbox (POST /api/outreach/replies) and the 'Email checked' line (PUT /api/outreach/meta/sync)."
                  : actor.canSend
                    ? "You may send emails yourself, one at a time, from the founder's mailbox. Follow the steps in the guide."
                    : "You prepare drafts in the founder's mailbox; the founder sends them. Never press Send. Follow the steps in the guide.",
        ready_for_agents: ready,
        today: usage,
        inbox_checked_at: actor.inboxCheckedAt,
        reply_check: sync ? { last_run: sync.lastRunAt ?? null, last_success: sync.lastSuccessAt ?? null, error: sync.lastError || null } : null,
        data: data
            ? {
                  version: data.version,
                  people: data.count,
                  uploaded_at: data.uploaded_at,
                  erased_waiting_for_upload: data.pending_erase || 0,
                  ...(data.pending_erase ? { erased_note: "People erased at their request are still in the stored research file until the founder uploads it again; /data/contacts.json is closed to agents until then." } : {}),
              }
            : null,
        people_by_status: byStatus,
        needs_founder_reply: { count: needs.results.length, people: needs.results, note: "Report these to the founder; do not answer them yourself." },
        guide: "/client-outreach/agents (also GET /api/outreach/guide as markdown)",
        endpoints: ENDPOINTS,
        rules: research
            ? {
                  every_email_must_have: research.checklist ?? [],
                  cadence: research.cadence ?? [],
                  never: [
                      "Write to anyone /claim did not give you, or to anyone with a 'stop' or 'hold' check.",
                      "Write to someone who asked to stop, said no, bounced, or replied (the founder answers in their thread).",
                      "Send to several people in one email, use BCC, mail merge, a sequencer, tracking pixels or tracked links.",
                      "Invent or fill in the founder's details (startup name, legal entity, postal address, privacy notice).",
                      "Send a confirmation or sales email to someone who asked to stop.",
                  ],
              }
            : null,
    });
}

const ENDPOINTS = [
    "GET  /api/outreach                     this overview: are you allowed to work now, today's limit, rules",
    "GET  /api/outreach/awaiting-reply      everyone already written to: the addresses and subjects to search the mailbox for",
    "GET  /api/outreach/next?n=5            who would be next (nothing is reserved)",
    "POST /api/outreach/claim {n} or {ids}  take people for 30 minutes so no other agent writes to them; returns their emails",
    "POST /api/outreach/lint {id, subject, body}   check an email you edited before it goes out",
    "POST /api/outreach/drafted {ids}       you left drafts in the founder's mailbox (draft-only keys)",
    "POST /api/outreach/sent {items:[{id, which, message_id}]}   you sent these (or saw your draft in the Sent folder)",
    "POST /api/outreach/release {ids}       give back people you will not write to",
    "POST /api/outreach/renew {ids}         keep people another 30 minutes",
    "POST /api/outreach/replies {items}     record replies you found in the mailbox",
    "POST /api/outreach/optout {items:[{id, said, channel}]}   someone asked to stop",
    "POST /api/outreach/bounced {items:[{id, reason}]}         an address bounced or the person left",
    "POST /api/outreach/inbox-checked {note}   you searched the mailbox for replies, bounces and stop requests",
    "GET  /api/outreach/contacts?status=&country=&batch=&mine=1&limit=&offset=   the list, compact",
    "GET  /api/outreach/contacts/<id>       one person: research, status, the next email and its checks",
    "PATCH /api/outreach/contacts/<id> {notes, custom:{hook, angle}}   add a note or improve the opening (people you hold)",
    "GET  /api/outreach/data/contacts.json  the whole research (keys with full read only)",
    "GET  /api/outreach/log                 what you did, newest first",
];

async function stateResponse(ctx: Omit<Ctx, "research">, url: URL): Promise<Response> {
    const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
    if (url.searchParams.get("rev_only") === "1") return json({ rev: await currentRev(ctx.db) });
    return rawJson(await stateText(ctx.db, since));
}

const DATA_FILES = new Set(["contacts.json", "messages.json", "playbook.json"]);

async function dataFile(env: OutreachEnv, actor: Actor, name: string, request: Request): Promise<Response> {
    if (!DATA_FILES.has(name)) return apiError(404, "No such file.");
    const db = env.OUTREACH_DB as D1Database;
    const data = await metaJson<{ version?: string; pending_erase?: number }>(db, "data");
    if (name === "contacts.json" && !fullReader(actor))
        return apiError(403, "This key cannot download the whole list. Use GET /api/outreach/awaiting-reply, /claim and /contacts/<id>.");
    // The founder's page hides erased people itself; anyone else waits for the upload that removes them from the file.
    if (name === "contacts.json" && actor.role !== "owner" && (data?.pending_erase || 0) > 0)
        return apiError(409, "The stored list still holds someone the founder erased. Use /api/outreach/contacts until the founder uploads the data again.");
    if (!data?.version || !env.OUTREACH_KV) return apiError(503, "The research data has not been uploaded yet.");
    const etag = `"${data.version}-${name}"`;
    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
    const body = await env.OUTREACH_KV.get(`data/${data.version}/${name}`, "stream");
    if (!body) return apiError(503, "The research data is incomplete. Upload it again.");
    if (actor.role !== "owner") await logStatement(db, new Date().toISOString(), actor.name, null, "read_file", { file: name }).run();
    return new Response(body, {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-cache",
            ETag: etag,
            "X-Robots-Tag": "noindex, nofollow",
            "Referrer-Policy": "same-origin",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

async function logResponse(ctx: Omit<Ctx, "research">, url: URL): Promise<Response> {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const before = Number(url.searchParams.get("before")) || null;
    const rows = await logRows(ctx.db, limit, before, ctx.actor.role === "owner" ? null : ctx.actor.name);
    return json({ log: rows });
}

async function listContacts(ctx: Ctx, url: URL): Promise<Response> {
    const p = url.searchParams;
    const where: string[] = ["c.erased_at IS NULL"];
    const binds: unknown[] = [];
    if (!fullReader(ctx.actor)) {
        where.push(`((k.key_id = ? AND k.state IN ('active', 'drafted')) OR COALESCE(json_extract(s.data, '$.status'), 'todo') IN ('sent', 'followup', 'replied', 'meeting', 'declined', 'optout', 'bounced'))`);
        binds.push(ctx.actor.keyId ?? "");
    }
    const status = p.get("status");
    if (status) {
        const list = status.split(",");
        if (!list.every((x) => (STATUS_VALUES as readonly string[]).includes(x))) throw new HttpError(400, "Unknown status");
        where.push(`COALESCE(json_extract(s.data, '$.status'), 'todo') IN (SELECT value FROM json_each(?))`);
        binds.push(JSON.stringify(list));
    }
    const country = p.get("country");
    if (country) {
        where.push("c.country = ?");
        binds.push(country.toUpperCase().slice(0, 3));
    }
    const batch = p.get("batch");
    if (batch !== null && batch !== "") {
        where.push("c.batch = ?");
        binds.push(Number(batch) || 0);
    }
    if (p.get("primary") === "1") where.push("c.is_primary = 1");
    if (p.get("law") === "ok") where.push("c.law_level = 'ok'");
    if (p.get("mine") === "1") {
        where.push("k.key_id = ? AND k.state IN ('active', 'drafted')");
        binds.push(ctx.actor.keyId ?? "owner");
    }
    if (p.get("written") === "1") where.push("COALESCE(json_extract(s.data, '$.status'), 'todo') IN ('sent', 'followup', 'replied', 'meeting', 'declined', 'optout', 'bounced')");
    const limit = Math.min(fullReader(ctx.actor) ? 500 : 100, Math.max(1, Number(p.get("limit")) || 100));
    const offset = Math.max(0, Number(p.get("offset")) || 0);
    const { results } = await ctx.db
        .prepare(
            `SELECT c.id, c.rank, c.batch, c.company_id, c.country, c.is_primary, c.law_level,
               json_extract(c.mail, '$.name') AS name, json_extract(c.mail, '$.role') AS role, json_extract(c.mail, '$.company') AS company,
               json_extract(c.mail, '$.city') AS city, json_extract(c.mail, '$.lang') AS lang, json_extract(c.mail, '$.kind') AS kind,
               json_extract(c.mail, '$.best_channel') AS best_channel, json_extract(c.mail, '$.fit') AS fit,
               json_extract(c.mail, '$.email_status') AS address_kind, COALESCE(json_extract(c.mail, '$.email'), json_extract(c.mail, '$.generic_email')) AS address,
               COALESCE(json_extract(s.data, '$.subject'), json_extract(c.mail, '$.subject')) AS subject,
               COALESCE(json_extract(s.data, '$.status'), 'todo') AS status, json_extract(s.data, '$.sentAt') AS sent_at,
               json_extract(s.data, '$.lastSentAt') AS last_sent_at, json_extract(s.data, '$.followups') AS followups,
               json_extract(s.data, '$.outcome') AS outcome, json_extract(s.data, '$.needsAction') AS needs_reply,
               k.agent AS taken_by, k.state AS taken_state, k.until AS taken_until
             FROM contacts c LEFT JOIN status s ON s.id = c.id LEFT JOIN claims k ON k.contact_id = c.id AND k.state IN ('active', 'drafted')
             WHERE ${where.join(" AND ")} ORDER BY c.rank DESC LIMIT ? OFFSET ?`,
        )
        .bind(...binds, limit, offset)
        .all();
    if (ctx.actor.role !== "owner") await logStatement(ctx.db, ctx.now.toISOString(), ctx.actor.name, null, "read_list", { n: results.length }).run();
    return json({ people: results, limit, offset, next_offset: results.length === limit ? offset + limit : null });
}

/** Everyone already written to, with what to search the mailbox for: the address, the subject, the dates, the Message-IDs. */
async function awaitingReply(ctx: Ctx): Promise<Response> {
    const [people, sends] = await ctx.db.batch<Record<string, unknown>>([
        ctx.db.prepare(
            `SELECT c.id, json_extract(c.mail, '$.name') AS name, json_extract(c.mail, '$.company') AS company,
               COALESCE(json_extract(c.mail, '$.email'), json_extract(c.mail, '$.generic_email')) AS address,
               COALESCE(json_extract(s.data, '$.subject'), json_extract(c.mail, '$.subject')) AS subject,
               json_extract(s.data, '$.status') AS status, json_extract(s.data, '$.sentAt') AS sent_at,
               json_extract(s.data, '$.lastSentAt') AS last_sent_at, json_extract(s.data, '$.needsAction') AS needs_reply
             FROM status s JOIN contacts c ON c.id = s.id
             WHERE c.erased_at IS NULL AND json_extract(s.data, '$.status') IN ('sent', 'followup', 'replied', 'meeting', 'declined', 'optout')
             ORDER BY last_sent_at DESC`,
        ),
        ctx.db.prepare(
            `SELECT contact_id, which, day, at, message_id FROM sends WHERE contact_id IN
               (SELECT id FROM status WHERE json_extract(data, '$.status') IN ('sent', 'followup', 'replied', 'meeting', 'declined', 'optout')) ORDER BY at`,
        ),
    ]);
    const byId = new Map<string, { which: string; day: string; at: string; message_id: string | null }[]>();
    for (const r of sends.results as { contact_id: string; which: string; day: string; at: string; message_id: string | null }[])
        byId.set(r.contact_id, [...(byId.get(r.contact_id) || []), { which: r.which, day: r.day, at: r.at, message_id: r.message_id }]);
    const group = (st: string) => (["sent", "followup"].includes(st) ? "waiting for an answer" : ["replied", "meeting"].includes(st) ? "answered: the founder replies" : "said no or asked to stop");
    if (ctx.actor.role !== "owner") await logStatement(ctx.db, ctx.now.toISOString(), ctx.actor.name, null, "read_awaiting", { n: people.results.length }).run();
    return json({
        order: "newest email first",
        how_to: "Search the mailbox for messages from each address since its sent date (subjects start with 'Re:' or 'RE:' or 'AW:'), and for bounces mentioning it. Record what you find with /replies, /bounced or /optout, then POST /inbox-checked. People who said no or asked to stop are listed too: a later 'delete my data' from them is an /optout.",
        people: (people.results as Record<string, unknown>[])
            .map((p) => {
                const emails = byId.get(p.id as string) || [];
                const last = emails.length ? emails[emails.length - 1].at : null;
                return { ...p, group: group(String(p.status)), last_email_at: last ?? p.last_sent_at ?? null, emails };
            })
            .sort((a, b) => String(b.last_email_at || "").localeCompare(String(a.last_email_at || ""))),
    });
}

async function contactDetail(ctx: Ctx, id: string): Promise<Response> {
    const [people, row, claims, sends] = await Promise.all([
        readPeople(ctx.db, [id]),
        ctx.db.prepare("SELECT data FROM contacts WHERE id = ? AND erased_at IS NULL").bind(id).first<{ data: string }>(),
        claimsOf(ctx, [id]),
        ctx.db.prepare("SELECT which, day, at, actor, message_id, subject FROM sends WHERE contact_id = ? ORDER BY at").bind(id).all(),
    ]);
    const p = people.get(id);
    if (!p || !row || p.row.erased_at) return apiError(404, "No such person.");
    const claim = claims.get(id);
    if (!mayOpen(ctx, p, claim)) return apiError(403, "This key opens only the people it took and the people already written to.");
    const ev = (await evaluateMany(ctx, [p])).get(id) as Evaluation;
    const checks = [...ev.checks, ...sendingHolds(p, ctx)];
    if (ctx.actor.role !== "owner") await logStatement(ctx.db, ctx.now.toISOString(), ctx.actor.name, id, "read_person", null).run();
    return json({
        id,
        research: JSON.parse(row.data),
        status: p.st,
        version: p.version,
        taken: claim ? { by_you: holds(ctx, claim), state: claim.state, which: claim.which, until: claim.until } : null,
        thread: sends.results,
        law: lawFor(ctx.research, p.c.country),
        next_email: {
            which: ev.which,
            to: ev.to,
            address_kind: ev.address_kind,
            lang: ev.lang,
            subject: ev.subject,
            body: ev.body,
            words_above_signature: wordsAboveSignature(ev.body),
            send_as: ev.which === "first" ? "A new email to this one address." : "A reply in the thread of the first email (find it by its subject).",
        },
        checks,
        founder_may_send: !checks.some((k) => k.level === "stop"),
        agent_may_take: !checks.some((k) => k.level !== "warn"),
    });
}

/** People an agent may take now, best first. Shared by /next (a look) and /claim (a reservation). */
async function pickable(ctx: Ctx, n: number, batch: number | null): Promise<{ person: Person; ev: Evaluation }[]> {
    const ids = await pickCandidates(ctx, Math.min(60, n * 4 + 10), batch);
    const people = await readPeople(ctx.db, ids);
    const list = ids.map((id) => people.get(id)).filter((p): p is Person => !!p);
    const evs = await evaluateMany(ctx, list);
    const out: { person: Person; ev: Evaluation }[] = [];
    const companies = new Set<string>();
    for (const p of list) {
        const ev = evs.get(p.c.id) as Evaluation;
        if (!ev.agent_ok || sendingHolds(p, ctx).length) continue;
        if (companies.has(p.row.company_id)) continue;
        companies.add(p.row.company_id);
        out.push({ person: p, ev });
        if (out.length >= n) break;
    }
    return out;
}

function emailView(ev: Evaluation, p: Person, withAddress = true) {
    return {
        id: p.c.id,
        name: p.c.name,
        role: p.c.role,
        company: p.c.company,
        which: ev.which,
        to: withAddress ? ev.to : undefined,
        address_kind: ev.address_kind,
        lang: ev.lang,
        subject: ev.subject,
        body: withAddress ? ev.body : undefined,
        words_above_signature: wordsAboveSignature(ev.body),
        send_as: ev.which === "first" ? "new email" : "reply in the thread of the first email",
        warnings: ev.checks.filter((k) => k.level === "warn"),
        research: "GET /api/outreach/contacts/" + p.c.id,
    };
}

async function nextResponse(ctx: Ctx, url: URL): Promise<Response> {
    const n = Math.min(10, Math.max(1, Number(url.searchParams.get("n")) || 5));
    const batch = url.searchParams.get("batch") ? Number(url.searchParams.get("batch")) : null;
    const ready = readiness(ctx.settings, ctx.research);
    const usage = await usageToday(ctx);
    const picks = ready.ready ? await pickable(ctx, n, batch) : [];
    return json({
        ready_for_agents: ready,
        today: usage,
        note: "Nothing is reserved yet: take people with POST /api/outreach/claim before writing." + (fullReader(ctx.actor) ? "" : " This key sees the address and the text after taking them."),
        people: picks.map(({ person, ev }) => emailView(ev, person, fullReader(ctx.actor))),
    });
}

/* ---------- taking people ---------- */

function inboxFresh(ctx: Ctx, sync: Record<string, unknown> | null): boolean {
    if (ctx.actor.role === "owner") return true;
    const cutoff = ctx.now.getTime() - INBOX_FRESH_HOURS * 3600_000;
    const mine = ctx.actor.inboxCheckedAt ? Date.parse(ctx.actor.inboxCheckedAt) : 0;
    const check = sync && typeof sync.lastSuccessAt === "string" ? Date.parse(sync.lastSuccessAt) : 0;
    return Math.max(mine, check) > cutoff;
}

async function claim(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    if (ctx.actor.role === "reply-check") return apiError(403, "The reply-check key cannot take people.");
    const ready = readiness(ctx.settings, ctx.research);
    if (!ready.ready) throw notReady(ready);
    if (!inboxFresh(ctx, await metaJson(ctx.db, "sync")))
        throw new Refusal(409, `Check the mailbox first: in the last ${INBOX_FRESH_HOURS} hours nobody looked for replies, bounces and stop requests.`, {
            do_this:
                "GET /api/outreach/awaiting-reply, search the founder's mailbox for replies, bounces and stop requests from those people, record them with POST /api/outreach/replies, /bounced or /optout, then POST /api/outreach/inbox-checked and claim again. If you cannot read the founder's mailbox, stop and tell the founder.",
        });
    const minutes = Math.min(MAX_CLAIM_MINUTES, Math.max(5, Number(body.minutes) || CLAIM_MINUTES));
    let chosen: { person: Person; ev: Evaluation }[];
    if (Array.isArray(body.ids)) {
        const items = parseItems(body, 10);
        const people = await readPeople(ctx.db, items.map((i) => String(i.id)));
        const list = items.map((i) => people.get(String(i.id))).filter((p): p is Person => !!p && !p.row.erased_at);
        const evs = await evaluateMany(ctx, list);
        chosen = [];
        const refused: unknown[] = [];
        for (const p of list) {
            const ev = evs.get(p.c.id) as Evaluation;
            const extra = sendingHolds(p, ctx);
            if ((ctx.actor.role !== "owner" && !ev.agent_ok) || !ev.sendable || extra.length) refused.push({ id: p.c.id, checks: [...ev.checks, ...extra].filter((k) => k.level !== "warn") });
            else chosen.push({ person: p, ev });
        }
        if (!chosen.length) return json({ taken: [], refused, message: "None of these people can be taken now." }, 409);
    } else {
        const n = Math.min(10, Math.max(1, Number(body.n) || 1));
        const batch = body.batch === undefined || body.batch === null ? null : Number(body.batch);
        chosen = await pickable(ctx, n, batch);
        if (!chosen.length) return json({ taken: [], message: "Nobody can be taken now: everyone left is held, taken by another agent, waiting for a follow-up date, or the daily limit is reached.", today: await usageToday(ctx) });
    }
    const stmts = claimStatements(ctx, chosen.map(({ person, ev }) => ({ id: person.c.id, company_id: person.row.company_id, which: ev.which })), minutes);
    const results = await ctx.db.batch([...stmts, logStatement(ctx.db, ctx.now.toISOString(), ctx.actor.name, null, "claim", { n: chosen.length })]);
    const taken = chosen.filter((_, i) => (results[i].meta.changes ?? 0) > 0);
    const missed = chosen.filter((_, i) => (results[i].meta.changes ?? 0) === 0).map(({ person }) => person.c.id);
    const usage = await usageToday(ctx);
    return json({
        taken: taken.map(({ person, ev }) => ({ ...emailView(ev, person), until: new Date(ctx.now.getTime() + minutes * 60_000).toISOString() })),
        not_taken: missed,
        not_taken_why: missed.length ? (usage.remaining === 0 ? "The daily limit is reached." : "Another agent took them, or someone at the same company is being written to.") : undefined,
        today: usage,
        then:
            ctx.actor.canSend || ctx.actor.role === "owner"
                ? "Send each email on its own from the founder's mailbox, then POST /api/outreach/sent. Release anyone you will not write to."
                : "Create each email as a draft in the founder's mailbox (do not send), then POST /api/outreach/drafted. Release anyone you will not draft.",
        warnings_policy: "A warning does not stop you. Inferred address: draft or send it as given and say so in your report; a bounce is then recorded with /bounced. Generic mailbox: the email already says who it is for.",
    });
}

async function renew(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const ids = parseItems(body, AGENT_BULK).map((i) => String(i.id));
    const minutes = Math.min(MAX_CLAIM_MINUTES, Math.max(5, Number(body.minutes) || CLAIM_MINUTES));
    const until = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
    const res = await ctx.db
        .prepare("UPDATE claims SET until = ? WHERE state = 'active' AND key_id = ? AND contact_id IN (SELECT value FROM json_each(?))")
        .bind(until, ctx.actor.keyId ?? "owner", JSON.stringify(ids))
        .run();
    return json({ renewed: res.meta.changes ?? 0, until });
}

async function release(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const ids = parseItems(body, bulkMax(ctx.actor)).map((i) => String(i.id));
    const [claims, people] = await Promise.all([claimsOf(ctx, ids), readPeople(ctx.db, ids)]);
    const mine = ids.filter((id) => holds(ctx, claims.get(id)) && ["active", "drafted"].includes(claims.get(id)?.state || ""));
    if (!mine.length) return json({ released: [], today: await usageToday(ctx) });
    const now = ctx.now.toISOString();
    // A first-email draft that is given back returns the person to "To contact"; the agent must delete the draft itself.
    const patches: PatchItem[] = mine
        .filter((id) => statusOf(people.get(id)?.st) === "drafted")
        .map((id) => ({ id, patch: { status: "todo", draft: null } as Partial<StatusDoc>, detail: { released: true } }));
    await ctx.db.batch([
        ctx.db.prepare("UPDATE claims SET state = 'released' WHERE contact_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(mine)),
        ...patchStatements(ctx.db, patches, ctx.actor.name, "release", now),
        logStatement(ctx.db, now, ctx.actor.name, null, "release", { n: mine.length }),
    ]);
    return json({ released: mine, note: patches.length ? "Delete the drafts you made for these people from the mailbox." : undefined, today: await usageToday(ctx) });
}

/* ---------- recording what happened ---------- */

async function drafted(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const items = parseItems(body, bulkMax(ctx.actor));
    const ids = items.map((i) => String(i.id));
    const [claims, people] = await Promise.all([claimsOf(ctx, ids), readPeople(ctx.db, ids)]);
    const now = ctx.now.toISOString();
    const results: unknown[] = [];
    const patches: PatchItem[] = [];
    const ok: string[] = [];
    for (const it of items) {
        const id = String(it.id);
        const p = people.get(id);
        const cl = claims.get(id);
        if (!p || p.row.erased_at) results.push({ id, result: "not_found" });
        else if (!holds(ctx, cl) || cl?.state !== "active") results.push({ id, result: "refused", why: "Take this person with POST /api/outreach/claim first." });
        else if (isWhich(it.which) && it.which !== cl.which) results.push({ id, result: "refused", why: `You took this person for the ${cl.which} email.` });
        else if (isClosed(p.st)) results.push({ id, result: "refused", why: "This person may not be written to." });
        else {
            const which = cl.which as Which;
            const ref = typeof it.draft_ref === "string" ? it.draft_ref.slice(0, 200) : undefined;
            const patch: Partial<StatusDoc> = { draft: { which, by: ctx.actor.name, at: now, ...(ref ? { ref } : {}) } };
            if (which === "first" && statusOf(p.st) === "todo") patch.status = "drafted";
            patches.push({ id, patch, detail: { which } });
            ok.push(id);
            results.push({ id, result: "recorded", which });
        }
    }
    if (ok.length) {
        const until = new Date(ctx.now.getTime() + DRAFT_HOLD_DAYS * 86400_000).toISOString();
        await ctx.db.batch([
            ...patchStatements(ctx.db, patches, ctx.actor.name, "drafted", now),
            ctx.db.prepare("UPDATE claims SET state = 'drafted', until = ? WHERE contact_id IN (SELECT value FROM json_each(?))").bind(until, JSON.stringify(ok)),
        ]);
    }
    return json({ results, today: await usageToday(ctx), then: "The founder reviews and sends the drafts. When one shows in the Sent folder, POST /api/outreach/sent for it." });
}

async function sent(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    if (ctx.actor.role === "reply-check") return apiError(403, "The reply-check key cannot record sends.");
    const items = parseItems(body, bulkMax(ctx.actor));
    for (let attempt = 0; ; attempt++) {
        try {
            return await recordSends(ctx, items);
        } catch (err) {
            // Two callers recorded the same email at once: read again, and the second one reports "already_recorded".
            if (attempt === 0 && err instanceof Error && /UNIQUE constraint failed: sends/.test(err.message)) continue;
            throw err;
        }
    }
}

async function recordSends(ctx: Ctx, items: Record<string, unknown>[]): Promise<Response> {
    const ids = items.map((i) => String(i.id));
    const [people, claims, sendRows] = await Promise.all([
        readPeople(ctx.db, ids),
        claimsOf(ctx, ids),
        ctx.db.prepare("SELECT contact_id, which, day FROM sends WHERE contact_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ contact_id: string; which: string; day: string }>(),
    ]);
    const already = new Map(sendRows.results.map((r) => [`${r.contact_id}|${r.which}`, r.day]));
    const isAgent = ctx.actor.role !== "owner";
    const list = ids.map((id) => people.get(id)).filter((p): p is Person => !!p && !p.row.erased_at);
    const evs = isAgent ? await evaluateMany(ctx, list) : new Map<string, Evaluation>();
    const now = ctx.now.toISOString();
    const minDay = shiftDay(ctx.today, -14);
    const results: unknown[] = [];
    const patches: PatchItem[] = [];
    const sends: unknown[] = [];
    const closedSends: string[] = [];
    for (const it of items) {
        const id = String(it.id);
        const p = people.get(id);
        if (!p || p.row.erased_at) {
            results.push({ id, result: "not_found" });
            continue;
        }
        const cl = claims.get(id);
        // Without "which": an agent records the email it took; the founder records the first email. Never a silent follow-up.
        const which: Which = isWhich(it.which) ? it.which : isAgent && cl && isWhich(cl.which) ? (cl.which as Which) : isAgent ? nextEmail(p.st) : "first";
        const day = isDay(it.sent_at) && it.sent_at <= ctx.today && it.sent_at >= (isAgent ? minDay : "2020-01-01") ? it.sent_at : ctx.today;
        if (already.has(`${id}|${which}`) || (which === "first" && WRITTEN.includes(statusOf(p.st)))) {
            results.push({ id, result: "already_recorded", which, day: already.get(`${id}|${which}`) ?? p.st.sentAt ?? null });
            continue;
        }
        if (isClosed(p.st) && !(isAgent && holds(ctx, cl) && cl && cl.which === which)) {
            results.push({ id, result: "refused", why: "This person asked to stop, said no, or bounced." });
            continue;
        }
        if (isClosed(p.st)) {
            // The agent held the person and the email went out before the stop arrived: keep the fact, not a new status.
            sends.push({ id, which, day, message_id: typeof it.message_id === "string" ? it.message_id.slice(0, 300) : null, subject: null, body_sha256: null });
            closedSends.push(id);
            results.push({ id, result: "recorded", which, day, founder_should_look_at: [{ code: "closed_meanwhile", level: "stop", text: "This person asked to stop, said no or bounced after you took them. The status stays closed." }] });
            continue;
        }
        let warnings: unknown[] = [];
        if (isAgent) {
            if (!holds(ctx, cl) || !cl || cl.which !== which) {
                results.push({ id, result: "refused", why: "Record only the email you took: take this person with POST /api/outreach/claim first, and send the email it gave you." });
                continue;
            }
            if (!ctx.actor.canSend && cl.state !== "drafted") {
                results.push({ id, result: "refused", why: "This key prepares drafts only. Record a send only for your own draft once it shows in the Sent folder." });
                continue;
            }
            // The email is out: record it whatever changed since the claim, and say what the founder should look at.
            const ev = evs.get(id) as Evaluation;
            warnings = ev.checks.filter((k) => k.level !== "warn" && !["drafted", "followup_not_due", "already_sent"].includes(k.code));
        }
        const lang = typeof it.lang === "string" && (LANGS as readonly string[]).includes(it.lang) ? (it.lang as Lang) : undefined;
        const subject = typeof it.subject === "string" ? it.subject.slice(0, 300) : undefined;
        let custom: { hook: string; angle: string } | undefined;
        if (!isAgent && which === "first" && isRecord(it.custom)) custom = { hook: str(it.custom.hook ?? "", "custom.hook", 1500).trim(), angle: str(it.custom.angle ?? "", "custom.angle", 1500).trim() };
        const patch = sentPatch(p.st, which, { day, lang, subject, custom, by: ctx.actor.name });
        if (!patch) {
            results.push({ id, result: "refused", why: "This person may not be written to." });
            continue;
        }
        patch.draft = null;
        patches.push({ id, patch, detail: { which, day, ...(warnings.length ? { look_at: warnings.map((w) => (w as { code: string }).code) } : {}) } });
        const bodyText = typeof it.body === "string" ? it.body : "";
        sends.push({
            id,
            which,
            day,
            message_id: typeof it.message_id === "string" ? it.message_id.slice(0, 300) : null,
            subject: subject ?? null,
            body_sha256: bodyText ? await sha256Hex(bodyText) : null,
        });
        results.push({ id, result: "recorded", which, day, ...(warnings.length ? { founder_should_look_at: warnings } : {}) });
    }
    if (patches.length || closedSends.length) {
        const recorded = JSON.stringify([...patches.map((x) => x.id), ...closedSends]);
        await ctx.db.batch([
            ...patchStatements(ctx.db, patches, ctx.actor.name, "sent", now),
            ctx.db
                .prepare(
                    `INSERT INTO sends (contact_id, which, day, at, actor, message_id, subject, body_sha256)
                     SELECT value->>'$.id', value->>'$.which', value->>'$.day', ?1, ?2, value->>'$.message_id', value->>'$.subject', value->>'$.body_sha256' FROM json_each(?3)`,
                )
                .bind(now, ctx.actor.name, JSON.stringify(sends)),
            ctx.db.prepare("UPDATE claims SET state = 'done' WHERE state IN ('active', 'drafted') AND contact_id IN (SELECT value FROM json_each(?))").bind(recorded),
            pruneLogStatement(ctx.db),
        ]);
    }
    return json({ results, docs: await docsOf(ctx, patches.map((x) => x.id)), rev: await currentRev(ctx.db), today: await usageToday(ctx) });
}

async function docsOf(ctx: Ctx, ids: string[]): Promise<Record<string, unknown>> {
    if (!ids.length) return {};
    const { results } = await ctx.db
        .prepare("SELECT id, data, version, updated_by, updated_at FROM status WHERE id IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(ids))
        .all<{ id: string; data: string; version: number; updated_by: string; updated_at: string }>();
    return Object.fromEntries(results.map((r) => [r.id, { doc: JSON.parse(r.data), v: r.version, by: r.updated_by, at: r.updated_at }]));
}

/**
 * Writes patches that were computed from what was read (notes appended to, replies added to), so each one only applies if
 * the document has not changed since; the ones that lost a race are computed again from a fresh read, up to three times.
 */
async function writePinned(ctx: Ctx, ids: string[], action: string, build: (p: Person) => PatchItem | null): Promise<string[]> {
    let todo = ids;
    const done: string[] = [];
    for (let round = 0; round < 4 && todo.length; round++) {
        const people = await readPeople(ctx.db, todo);
        const patches = todo
            .map((id) => people.get(id))
            .filter((p): p is Person => !!p)
            .map((p) => {
                const it = build(p);
                return it ? { ...it, version: p.version } : null;
            })
            .filter((x): x is PatchItem & { version: number } => !!x);
        if (!patches.length) break;
        const now = ctx.now.toISOString();
        const { statements, first } = pinnedStatements(ctx.db, patches, ctx.actor.name, now);
        const res = await ctx.db.batch(statements);
        // Each UPDATE says itself whether it applied: no guessing from versions read afterwards.
        const won = patches.filter((_, i) => (res[first + i].meta.changes ?? 0) > 0);
        if (won.length) await ctx.db.batch(won.map((x) => logStatement(ctx.db, now, ctx.actor.name, x.id, action, x.detail)));
        done.push(...won.map((x) => x.id));
        todo = patches.filter((x) => !won.includes(x)).map((x) => x.id);
    }
    return done;
}

async function replies(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const raw = Array.isArray(body.items) ? body.items : null;
    if (!raw || !raw.length) throw new HttpError(400, "Send {items: [{id, kind, summary, date, from, message_id, optout}]}");
    if (raw.length > 100) throw new HttpError(400, "At most 100 replies per request");
    const byId = new Map<string, ReplyItem[]>();
    for (const r of raw) {
        if (!isRecord(r)) throw new HttpError(400, "Each reply must be an object");
        const id = requireId(r.id);
        const kind = String(r.kind);
        if (!REPLY_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${REPLY_KINDS.join(", ")}`);
        const date = typeof r.date === "string" && !Number.isNaN(Date.parse(r.date)) ? new Date(r.date).toISOString() : ctx.now.toISOString();
        const summary = str(r.summary ?? "", "summary", 1000).trim();
        if (kind !== "auto-reply" && summary.length < 3) throw new HttpError(400, "Each reply needs a summary: one plain sentence saying what they wrote");
        const item: ReplyItem = {
            kind,
            summary,
            date,
            from: typeof r.from === "string" ? r.from.slice(0, 120) : "",
            message_id: typeof r.message_id === "string" && r.message_id.trim() ? r.message_id.trim().slice(0, 300) : undefined,
            message_url: typeof r.message_url === "string" ? r.message_url.slice(0, 400) : undefined,
            optout: r.optout === true && kind === "declined",
        };
        byId.set(id, [...(byId.get(id) || []), item]);
    }
    const ids = [...byId.keys()];
    if (ids.length > 40) throw new HttpError(400, "Replies for at most 40 people per request; send the rest in another one");
    const people = await readPeople(ctx.db, ids);
    const results = new Map<string, Record<string, unknown>>();
    const eligible: string[] = [];
    for (const id of ids) {
        const p = people.get(id);
        if (!p || p.row.erased_at || p.st.erased) results.set(id, { id, result: "not_found" });
        else if (![...WRITTEN, "declined", "optout"].includes(statusOf(p.st))) results.set(id, { id, result: "refused", why: "Nothing was sent to this person, so this cannot be a reply." });
        else eligible.push(id);
    }
    let recordedReal = 0;
    const now = ctx.now.toISOString();
    const outcomes = new Map<string, { status: string; recorded: number }>();
    const done = await writePinned(ctx, eligible, "reply", (p) => {
        const { patch, recorded } = replyPatch(p.st, byId.get(p.c.id) || [], now, ctx.actor.name);
        if (!patch) {
            results.set(p.c.id, { id: p.c.id, result: "already_recorded" });
            return null;
        }
        outcomes.set(p.c.id, { status: (patch.status as string) ?? statusOf(p.st), recorded });
        return { id: p.c.id, patch, detail: { replies: (byId.get(p.c.id) || []).length } };
    });
    for (const id of done) {
        const o = outcomes.get(id) as { status: string; recorded: number };
        recordedReal += o.recorded;
        results.set(id, {
            id,
            result: "recorded",
            status: o.status,
            follow_ups: ["replied", "meeting", "declined", "optout"].includes(o.status) ? "cancelled: the founder answers from here" : "unchanged",
        });
    }
    for (const id of eligible) if (!results.has(id)) results.set(id, { id, result: "conflict", why: "The record kept changing; try again." });
    if (done.some((id) => ["declined", "optout"].includes(outcomes.get(id)?.status || ""))) {
        await ctx.db.prepare("UPDATE claims SET state = 'released' WHERE state IN ('active', 'drafted') AND contact_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(done)).run();
    }
    return json({ results: ids.map((id) => results.get(id)), recorded_replies: recordedReal });
}

async function closeWith(ctx: Ctx, body: Record<string, unknown>, status: "optout" | "bounced"): Promise<Response> {
    const items = parseItems(body, bulkMax(ctx.actor));
    const ids = items.map((i) => String(i.id));
    const [people, claims] = await Promise.all([readPeople(ctx.db, ids), claimsOf(ctx, ids)]);
    const results = new Map<string, Record<string, unknown>>();
    const rows: { id: string; patch: Partial<StatusDoc>; line: string }[] = [];
    for (const it of items) {
        const id = String(it.id);
        const p = people.get(id);
        if (!p || p.row.erased_at || p.st.erased) {
            results.set(id, { id, result: "not_found" });
            continue;
        }
        if (statusOf(p.st) === status) {
            results.set(id, { id, result: "already_recorded" });
            continue;
        }
        if (ctx.actor.role !== "owner" && !holds(ctx, claims.get(id)) && ![...WRITTEN, "declined"].includes(statusOf(p.st))) {
            results.set(id, { id, result: "refused", why: "Record this only for people already written to, or that you took." });
            continue;
        }
        const said = typeof it.said === "string" ? it.said.slice(0, 300) : typeof it.reason === "string" ? it.reason.slice(0, 300) : "";
        const channel = typeof it.channel === "string" ? it.channel.slice(0, 40) : "email";
        const line =
            status === "optout"
                ? `${ctx.today}: asked to stop (${channel})${said ? ": " + said : ""}. Recorded by ${ctx.actor.name}. No confirmation or sales email.`
                : `${ctx.today}: ${said || "the address bounced"}. Recorded by ${ctx.actor.name}.`;
        const patch: Partial<StatusDoc> = { status, needsAction: false, draft: null };
        if (status === "optout") patch.outcome = "declined";
        rows.push({ id, patch, line });
    }
    if (rows.length) {
        const now = ctx.now.toISOString();
        const payload = JSON.stringify(rows);
        // The status and the note change together, and only where the status is not already the new one: a repeat or a
        // second caller at the same moment cannot add the note twice. The note is appended in SQL, never rebuilt.
        await ctx.db.batch([
            ctx.db.prepare("UPDATE counter SET value = value + 1 WHERE name = 'rev'"),
            ctx.db.prepare("INSERT OR IGNORE INTO status (id, data, version, rev, updated_at, updated_by) SELECT value->>'$.id', '{}', 0, 0, ?1, ?2 FROM json_each(?3)").bind(now, ctx.actor.name, payload),
            ctx.db
                .prepare(
                    `UPDATE status SET
                       data = json_set(json_patch(status.data, j.patch), '$.notes',
                         substr(CASE WHEN COALESCE(json_extract(status.data, '$.notes'), '') = '' THEN j.line ELSE json_extract(status.data, '$.notes') || char(10) || j.line END, -4000)),
                       version = status.version + 1, rev = (SELECT value FROM counter WHERE name = 'rev'), updated_at = ?1, updated_by = ?2
                     FROM (SELECT value->>'$.id' AS id, value->>'$.patch' AS patch, value->>'$.line' AS line FROM json_each(?3)) AS j
                     WHERE status.id = j.id AND COALESCE(json_extract(status.data, '$.status'), 'todo') != ?4`,
                )
                .bind(now, ctx.actor.name, payload, status),
            ctx.db.prepare("INSERT INTO log (at, actor, contact_id, action, detail) SELECT ?1, ?2, value->>'$.id', ?3, NULL FROM json_each(?4)").bind(now, ctx.actor.name, status, payload),
            ctx.db.prepare("UPDATE claims SET state = 'released' WHERE state IN ('active', 'drafted') AND contact_id IN (SELECT value->>'$.id' FROM json_each(?))").bind(payload),
        ]);
        // Where the status was already the new one (someone recorded it at the same moment), the end state is the same.
        for (const r of rows) results.set(r.id, { id: r.id, result: "recorded" });
    }
    return json({ results: ids.map((id) => results.get(id)), note: status === "optout" ? "Do not send any confirmation or sales email to them, and nobody at their company is written to again." : undefined });
}

async function inboxChecked(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
    if (ctx.actor.keyId) await ctx.db.prepare("UPDATE agent_keys SET inbox_checked_at = ? WHERE id = ?").bind(ctx.now.toISOString(), ctx.actor.keyId).run();
    await logStatement(ctx.db, ctx.now.toISOString(), ctx.actor.name, null, "inbox_checked", note ? { note } : null).run();
    return json({ inbox_checked_at: ctx.now.toISOString(), valid_for_hours: INBOX_FRESH_HOURS });
}

async function lint(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const id = requireId(body.id);
    const [people, claims] = await Promise.all([readPeople(ctx.db, [id]), claimsOf(ctx, [id])]);
    const p = people.get(id);
    if (!p || p.row.erased_at) return apiError(404, "No such person.");
    if (!mayOpen(ctx, p, claims.get(id))) return apiError(403, "This key checks only emails to people it took.");
    const ev = (await evaluateMany(ctx, [p])).get(id) as Evaluation;
    const which = isWhich(body.which) ? body.which : ev.which;
    const evFor = which === ev.which ? ev : evaluate(p, (await readCompanies(ctx.db, [p.row.company_id])).get(p.row.company_id) || [p], ctx, which);
    const result = lintEmail(evFor, ctx, str(body.subject ?? "", "subject", 300), str(body.body ?? "", "body", 20000));
    return json({ ok: result.problems.length === 0, words_above_signature: wordsAboveSignature(String(body.body ?? "")), ...result });
}

/* ---------- edits ---------- */

/** What a status change means for the person's open claim and draft marker. */
function claimFollowUp(ctx: Ctx, ids: string[], value: StatusValue): D1PreparedStatement[] {
    if (!ids.length) return [];
    const list = JSON.stringify(ids);
    if (value === "sent" || value === "followup")
        return [ctx.db.prepare("UPDATE claims SET state = 'done' WHERE state IN ('active', 'drafted') AND contact_id IN (SELECT value FROM json_each(?))").bind(list)];
    if (["todo", "drafted", "skip", ...CLOSED_STATUSES].includes(value))
        return [ctx.db.prepare("UPDATE claims SET state = 'released' WHERE state IN ('active', 'drafted') AND contact_id IN (SELECT value FROM json_each(?))").bind(list)];
    return [];
}

async function patchContact(ctx: Ctx, id: string, body: Record<string, unknown>): Promise<Response> {
    if (ctx.actor.role === "reply-check") return apiError(403, "Not available with this key.");
    const [people, claims] = await Promise.all([readPeople(ctx.db, [id]), claimsOf(ctx, [id])]);
    const p = people.get(id);
    if (!p || p.row.erased_at || p.st.erased) return apiError(404, "No such person.");
    const owner = ctx.actor.role === "owner";
    const patch: Partial<StatusDoc> = {};
    let extra: D1PreparedStatement[] = [];
    if (!owner) {
        // An agent changes the opening only for people it holds and who may be written to; it may add a note (signed, never
        // replacing anything) to someone it holds or someone already written to.
        const held = holds(ctx, claims.get(id));
        if ("custom" in body && (!held || isClosed(p.st))) return apiError(403, "Take this person with POST /api/outreach/claim before changing their email.");
        if (!held && !WRITTEN_ANY.includes(statusOf(p.st))) return apiError(403, "Take this person with POST /api/outreach/claim before editing them.");
        const allowed = ["notes", "custom"];
        if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, "Agents may add a note and change custom {hook, angle}, nothing else");
        if ("notes" in body) {
            const add = str(body.notes ?? "", "notes", 1000).trim();
            if (add) patch.notes = [p.st.notes, `${ctx.today} ${ctx.actor.name}: ${add}`].filter(Boolean).join("\n").slice(-4000);
        }
        if ("custom" in body) {
            if (!isRecord(body.custom)) throw new HttpError(400, "custom must be {hook, angle}");
            const cur = { hook: (p.st.custom && p.st.custom.hook) ?? p.c.hook ?? "", angle: (p.st.custom && p.st.custom.angle) ?? p.c.angle ?? "" };
            patch.custom = {
                hook: "hook" in body.custom ? agentText(body.custom.hook, "custom.hook") : cur.hook,
                angle: "angle" in body.custom ? agentText(body.custom.angle, "custom.angle") : cur.angle,
            };
        }
    } else {
        if ("notes" in body) patch.notes = str(body.notes ?? "", "notes", 4000);
        if ("custom" in body) {
            if (body.custom === null) patch.custom = null;
            else if (isRecord(body.custom)) patch.custom = { hook: str(body.custom.hook ?? "", "custom.hook", 1500).trim(), angle: str(body.custom.angle ?? "", "custom.angle", 1500).trim() };
            else throw new HttpError(400, "custom must be {hook, angle} or null");
        }
        if ("outcome" in body) {
            const o = body.outcome;
            if (o !== "none" && !(typeof o === "string" && o in OUTCOMES)) throw new HttpError(400, "Unknown outcome");
            patch.outcome = o as string;
        }
        if ("needsAction" in body) patch.needsAction = body.needsAction === true;
        if ("meeting" in body) {
            const mt = body.meeting;
            if (mt === null) patch.meeting = null;
            else if (isRecord(mt) && typeof mt.when === "string" && !Number.isNaN(Date.parse(mt.when)))
                patch.meeting = { when: new Date(mt.when).toISOString(), state: "fixed", platform: typeof mt.platform === "string" ? mt.platform.slice(0, 80) : undefined, note: typeof mt.note === "string" ? mt.note.slice(0, 500) : undefined };
            else throw new HttpError(400, "meeting must be {when} or null");
        }
        if ("subject" in body) patch.subject = str(body.subject ?? "", "subject", 300);
        if ("status" in body) {
            const s = body.status as StatusValue;
            if (!(STATUS_VALUES as readonly string[]).includes(s)) throw new HttpError(400, "Unknown status");
            if (isClosed(p.st) && !isClosed({ status: s }) && body.override !== true)
                throw new Refusal(409, "This person asked to stop, said no or bounced. Send override: true to change that.", { needs_override: true });
            patch.status = s;
            extra = claimFollowUp(ctx, [id], s);
        }
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change");
    const now = ctx.now.toISOString();
    await ctx.db.batch([...patchStatements(ctx.db, [{ id, patch, detail: { fields: Object.keys(patch) } }], ctx.actor.name, "edit", now), ...extra]);
    return json({ docs: await docsOf(ctx, [id]), rev: await currentRev(ctx.db) });
}

/** The status menu, for one person or many (founder only). Same meaning as on the claude.ai page. */
async function setStatus(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    if (ctx.actor.role !== "owner") return apiError(403, "Agents record what happened with /sent, /drafted, /replies, /optout and /bounced.");
    const value = body.status as StatusValue;
    if (!(STATUS_VALUES as readonly string[]).includes(value)) throw new HttpError(400, "Unknown status");
    const items = parseItems(body, OWNER_BULK);
    const ids = items.map((i) => String(i.id));
    const people = await readPeople(ctx.db, ids);
    const now = ctx.now.toISOString();
    const day = isDay(body.day) ? body.day : ctx.today;
    const results: unknown[] = [];
    const patches: PatchItem[] = [];
    const sends: unknown[] = [];
    const unsend: string[] = [];
    for (const id of ids) {
        const p = people.get(id);
        if (!p || p.row.erased_at || p.st.erased) {
            results.push({ id, result: "not_found" });
            continue;
        }
        const st = p.st;
        if (isClosed(st) && !isClosed({ status: value }) && body.override !== true) {
            results.push({ id, result: "refused", why: "Asked to stop, said no or bounced. Send override: true to change that.", needs_override: true });
            continue;
        }
        const patch = statusPatch(st, value, day);
        if (value === "sent" || value === "followup") {
            patch.sentBy = ctx.actor.name;
            patch.draft = null;
            const which: Which = value === "sent" ? "first" : FOLLOWUP_ORDER[Math.min(Number(patch.followups ?? st.followups ?? 1), FOLLOWUP_ORDER.length - 1)];
            sends.push({ id, which, day: (patch.lastSentAt as string) || day });
        }
        if (value === "todo") patch.draft = null;
        if ((value === "todo" || value === "drafted") && st.sentAt) unsend.push(id);
        patches.push({ id, patch, detail: { status: value } });
        results.push({ id, result: "recorded" });
    }
    if (patches.length) {
        await ctx.db.batch([
            ...patchStatements(ctx.db, patches, ctx.actor.name, "status", now),
            ...(sends.length
                ? [
                      ctx.db
                          .prepare("INSERT OR IGNORE INTO sends (contact_id, which, day, at, actor) SELECT value->>'$.id', value->>'$.which', value->>'$.day', ?1, ?2 FROM json_each(?3)")
                          .bind(now, ctx.actor.name, JSON.stringify(sends)),
                  ]
                : []),
            ...(unsend.length ? [ctx.db.prepare("DELETE FROM sends WHERE contact_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(unsend))] : []),
            ...claimFollowUp(ctx, patches.map((x) => x.id), value),
        ]);
    }
    return json({ results, docs: await docsOf(ctx, patches.map((x) => x.id)), rev: await currentRev(ctx.db) });
}

async function putSettings(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const cur = ctx.settings;
    const next: Settings = { ...cur };
    if ("startup" in body) next.startup = str(body.startup ?? "", "startup", 120).trim();
    if ("signature" in body) next.signature = str(body.signature ?? "", "signature", 1000).trim();
    if ("privacy" in body) {
        const v = str(body.privacy ?? "", "privacy", 300).trim();
        if (v && !/^https:\/\/\S+$/i.test(v)) throw new HttpError(400, "The privacy notice link must start with https://");
        next.privacy = v;
    }
    if ("use_credential" in body) next.use_credential = body.use_credential !== false;
    if ("use_check_offer" in body) next.use_check_offer = body.use_check_offer !== false;
    if ("daily_limit" in body) {
        const n = Number(body.daily_limit);
        if (!Number.isInteger(n) || n < 0 || n > 30) throw new HttpError(400, "The daily limit must be a whole number from 0 to 30");
        next.daily_limit = n;
    }
    if ("timezone" in body) {
        if (!isValidTimeZone(body.timezone)) throw new HttpError(400, "Unknown time zone (for example Europe/Zurich or America/New_York)");
        next.timezone = body.timezone as string;
    }
    if ("from_address" in body) {
        const v = str(body.from_address ?? "", "from_address", 200).trim();
        if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, "That is not an email address");
        next.from_address = v;
    }
    if ("mail_ready" in body) next.mail_ready = body.mail_ready === true;
    if ("agents_paused" in body) next.agents_paused = body.agents_paused === true;
    const now = ctx.now.toISOString();
    await ctx.db.batch([...metaWrite(ctx.db, "settings", next, ctx.actor.name, now), logStatement(ctx.db, now, ctx.actor.name, null, "settings", { fields: Object.keys(body) })]);
    return json({ settings: next, daily_limit: dailyLimit(next), ready_for_agents: readiness(next, ctx.research) });
}

async function putSync(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    if (ctx.actor.role === "agent") return apiError(403, "Only the reply check writes this.");
    const latest = ctx.now.getTime() + 5 * 60_000;
    const stamp = (k: string) => {
        const v = body[k];
        if (v === undefined || v === null) return undefined;
        if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || Date.parse(v) > latest) throw new HttpError(400, `${k} must be a time, and not in the future`);
        return new Date(v).toISOString();
    };
    const count = (k: string) => {
        const v = body[k];
        if (v === undefined || v === null) return undefined;
        if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100000) throw new HttpError(400, `${k} must be a whole number`);
        return v as number;
    };
    const words = (k: string, max: number) => {
        const v = body[k];
        if (v === undefined || v === null) return v === null ? null : undefined;
        if (typeof v !== "string") throw new HttpError(400, `${k} must be text`);
        return v.slice(0, max);
    };
    const data: Record<string, unknown> = {
        lastRunAt: stamp("lastRunAt"),
        lastSuccessAt: stamp("lastSuccessAt"),
        lastError: words("lastError", 500),
        newReplies: count("newReplies"),
        watched: count("watched"),
        account: words("account", 200),
        summary: words("summary", 2000),
        checkedThrough: stamp("checkedThrough"),
    };
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
    const now = ctx.now.toISOString();
    await ctx.db.batch(metaWrite(ctx.db, "sync", data, ctx.actor.name, now));
    return json({ sync: data });
}

/* ---------- agent keys ---------- */

async function listKeys(ctx: Ctx): Promise<Response> {
    const { results } = await ctx.db
        .prepare("SELECT id, name, role, can_send, full_read, created_at, expires_at, last_used_at, revoked_at, inbox_checked_at FROM agent_keys ORDER BY created_at DESC")
        .all();
    return json({ keys: results });
}

async function createKey(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const name = str(body.name ?? "", "name", 60).trim();
    if (!name) throw new HttpError(400, "Give the agent a name");
    if (/^you$/i.test(name)) throw new HttpError(400, "Pick another name: 'you' means the founder in the log");
    const role = body.role === "reply-check" ? "reply-check" : "agent";
    const canSend = role === "agent" && body.can_send === true;
    if (canSend && body.acknowledged !== true) throw new HttpError(400, "Letting an agent send by itself needs the acknowledgement of the legal note.");
    const days = Math.min(365, Math.max(1, Number(body.expires_days) || 30));
    const key = await newAgentKey();
    const now = ctx.now.toISOString();
    const expires = new Date(ctx.now.getTime() + days * 86400_000).toISOString();
    await ctx.db.batch([
        ctx.db
            .prepare("INSERT INTO agent_keys (id, name, hash, role, can_send, full_read, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(key.id, name, key.hash, role, canSend ? 1 : 0, body.full_read === false ? 0 : 1, now, expires),
        logStatement(ctx.db, now, ctx.actor.name, null, "key_created", { key: key.id, name, role, can_send: canSend, acknowledged_legal_note: canSend }),
    ]);
    return json({ id: key.id, key: key.token, name, role, can_send: canSend, full_read: body.full_read !== false, expires_at: expires, shown_once: true });
}

async function revokeKey(ctx: Ctx, id: string): Promise<Response> {
    const now = ctx.now.toISOString();
    const res = await ctx.db.prepare("UPDATE agent_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, id).run();
    await ctx.db.batch([
        ctx.db.prepare("UPDATE claims SET state = 'released' WHERE key_id = ? AND state = 'active'").bind(id),
        ctx.db.prepare("UPDATE session_links SET used_at = ? WHERE key_id = ? AND used_at IS NULL").bind(now, id),
        logStatement(ctx.db, now, ctx.actor.name, null, "key_revoked", { key: id }),
    ]);
    return json({ revoked: (res.meta.changes ?? 0) > 0 });
}

const LINK_MINUTES = 30;

async function sessionLink(ctx: Ctx, id: string, request: Request): Promise<Response> {
    const row = await ctx.db.prepare("SELECT id, revoked_at, expires_at, role FROM agent_keys WHERE id = ?").bind(id).first<{ id: string; revoked_at: string | null; expires_at: string | null; role: string }>();
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at) <= ctx.now)) return apiError(404, "No live key with that id.");
    if (row.role !== "agent") return apiError(400, "Browser sessions are for agent keys.");
    const token = randomToken(32);
    const now = ctx.now.toISOString();
    await ctx.db
        .prepare("INSERT INTO session_links (token_hash, key_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex(token), id, now, new Date(ctx.now.getTime() + LINK_MINUTES * 60_000).toISOString())
        .run();
    return json({ link: `${new URL(request.url).origin}/client-outreach/s/${token}`, valid_minutes: LINK_MINUTES, single_use: true });
}

/* ---------- erasing a person, signing everyone out ---------- */

async function erase(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
    const id = requireId(body.id);
    const row = await ctx.db.prepare("SELECT erased_at FROM contacts WHERE id = ?").bind(id).first<{ erased_at: string | null }>();
    if (!row) return apiError(404, "No such person.");
    if (row.erased_at) return json({ erased: id, already: true });
    const now = ctx.now.toISOString();
    const stub = JSON.stringify({ id, erased: true });
    await ctx.db.batch([
        ctx.db.prepare("UPDATE contacts SET data = ?, mail = ?, erased_at = ? WHERE id = ?").bind(stub, stub, now, id),
        // Only the status stays (asked to stop, erased), so nobody at the company is written to and an upload cannot bring them back.
        ctx.db.prepare("UPDATE status SET data = '{}' WHERE id = ?").bind(id),
        ...patchStatements(ctx.db, [{ id, patch: { status: "optout", erased: true, erasedAt: ctx.today } as unknown as Partial<StatusDoc> }], ctx.actor.name, "erase", now),
        ctx.db.prepare("DELETE FROM claims WHERE contact_id = ?").bind(id),
        ctx.db.prepare("DELETE FROM sends WHERE contact_id = ?").bind(id),
        ctx.db.prepare("UPDATE log SET contact_id = NULL, detail = NULL WHERE contact_id = ?").bind(id),
        ctx.db
            .prepare("UPDATE meta SET data = json_set(data, '$.pending_erase', COALESCE(json_extract(data, '$.pending_erase'), 0) + 1), rev = (SELECT value FROM counter WHERE name = 'rev') WHERE key = 'data'"),
    ]);
    return json({ erased: id, note: "Gone from the page and the API now. Run the data upload again to remove them from the stored research files too." });
}

async function signoutAll(ctx: Ctx): Promise<Response> {
    const cur = (await metaJson<{ epoch?: number }>(ctx.db, "auth"))?.epoch || 1;
    const now = ctx.now.toISOString();
    await ctx.db.batch([...metaWrite(ctx.db, "auth", { epoch: cur + 1 }, ctx.actor.name, now), logStatement(ctx.db, now, ctx.actor.name, null, "signout_all", null)]);
    return json({ signed_out: true, note: "Every browser session, yours included, now needs to sign in again. Agent keys still work; revoke them separately." });
}
