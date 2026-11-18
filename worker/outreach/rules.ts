// What an agent may do, decided on the server from the founder's own research (playbook.json: law.rules, law.checklist,
// email.cadence, email.setup_checklist). The page shows the same checks to the founder; here a "hold" also stops an agent.

import {
    DEFAULT_DAILY_LIMIT,
    DEFAULT_TIMEZONE,
    FOLLOWUP_ORDER,
    MAX_DAILY_LIMIT,
    addressOf,
    checksFor,
    composeBody,
    dayIn,
    followupDue,
    followupIn,
    langFor,
    nextEmail,
    partsFor,
    placeholdersIn,
    senderGaps,
    senderOf,
    statusOf,
    subjectFor,
    type Check,
    type LawRule,
    type Settings,
    type StatusDoc,
    type Which,
} from "../../src/client-outreach/shared/core.ts";
import type { Actor } from "./auth.ts";
import { Refusal } from "./http.ts";
import { readCompanies, type Person, type Research } from "./store.ts";

export const CLAIM_MINUTES = 30;
export const MAX_CLAIM_MINUTES = 120;
export const DRAFT_HOLD_DAYS = 7;
/** An unfinished claim keeps its person away from other agents for this long: the email may have gone out. */
export const STALE_HOURS = 24;
export const INBOX_FRESH_HOURS = 12;

export interface Ctx {
    db: D1Database;
    actor: Actor;
    settings: Settings;
    research: Research;
    tz: string;
    today: string;
    now: Date;
}

export function lawFor(research: Research, country: string): LawRule | null {
    return research.law.find((r) => r.country === country) || null;
}

export function dailyLimit(settings: Settings): number {
    const n = Number(settings.daily_limit);
    return Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_DAILY_LIMIT) : DEFAULT_DAILY_LIMIT;
}

export const timezoneOf = (settings: Settings): string => settings.timezone || DEFAULT_TIMEZONE;
export const todayOf = (settings: Settings, now = new Date()): string => dayIn(now, timezoneOf(settings));

/* ---------- is the founder's side ready for agents? ---------- */

// Never send cold email from these (the setup checklist): a personal or student mailbox.
const PERSONAL_DOMAINS = /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|proton|protonmail|gmx|web|bluewin|hispeed)\.|@[^@]*\.onmicrosoft\.com$|@(epfl\.ch|mit\.edu|ethz\.ch|unil\.ch)$/i;

export interface Readiness {
    ready: boolean;
    missing: string[];
}

export function readiness(settings: Settings, research: Research | null): Readiness {
    const missing: string[] = [];
    if (!research) missing.push("The research data has not been uploaded yet.");
    if (settings.agents_paused) missing.push("The founder has paused all agents.");
    const sender = senderOf(research ? research.messages : null, settings);
    for (const g of senderGaps(sender)) missing.push(`Your details: ${g}.`);
    const from = (settings.from_address || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) missing.push("The mailbox the emails go out from (a mailbox on the company's own domain).");
    else if (PERSONAL_DOMAINS.test(from)) missing.push("The sending mailbox is a personal or student address; the research says never to send from one.");
    if (!settings.mail_ready)
        missing.push("The founder has not confirmed the sending setup: own domain at least 32 days old, SPF, DKIM and DMARC passing, no open or click tracking.");
    return { ready: missing.length === 0, missing };
}

/* ---------- the working hours of the recipient ---------- */

const COUNTRY_TZ: Record<string, string> = {
    CH: "Europe/Zurich", LI: "Europe/Vaduz", FR: "Europe/Paris", IT: "Europe/Rome", DE: "Europe/Berlin", AT: "Europe/Vienna",
    BE: "Europe/Brussels", NL: "Europe/Amsterdam", LU: "Europe/Luxembourg", ES: "Europe/Madrid", PT: "Europe/Lisbon",
    UK: "Europe/London", GB: "Europe/London", IE: "Europe/Dublin", SE: "Europe/Stockholm", NO: "Europe/Oslo",
    DK: "Europe/Copenhagen", FI: "Europe/Helsinki", PL: "Europe/Warsaw", CZ: "Europe/Prague",
};

/** First emails go out on weekdays between 08:00 and 17:00 where the person works (the cadence in the research). */
export function inWorkingHours(country: string, now: Date): boolean {
    const tz = COUNTRY_TZ[country] || DEFAULT_TIMEZONE;
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(now);
    const wd = parts.find((p) => p.type === "weekday")?.value || "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return !["Sat", "Sun"].includes(wd) && hour >= 8 && hour < 17;
}

/* ---------- one person ---------- */

export interface Evaluation {
    id: string;
    which: Which;
    lang: string;
    to: string;
    address_kind: string;
    subject: string;
    body: string;
    checks: Check[];
    /** Nothing at stop level: the founder may send it. */
    sendable: boolean;
    /** Nothing at stop or hold level: an agent may take it. */
    agent_ok: boolean;
}

export function evaluate(p: Person, colleagues: Person[], ctx: Ctx, which?: Which): Evaluation {
    const { c, st } = p;
    const w = which ?? nextEmail(st);
    const law = lawFor(ctx.research, c.country);
    const sender = senderOf(ctx.research.messages, ctx.settings);
    const checks = checksFor(c, {
        st,
        colleagues: colleagues.filter((x) => x.c.id !== c.id).map((x) => ({ c: x.c, st: x.st })),
        law,
        sender,
        which: w,
    });
    const lang = langFor(c, st);
    const parts = partsFor(c, st);
    const body = composeBody(c, parts, w, lang, ctx.research.messages, sender);
    const subject = subjectFor(c, st, w);
    const addr = addressOf(c);
    const kind = c.email_status === "published" || c.email_status === "pattern" ? c.email_status : "generic";
    if (!(((ctx.research.messages.optout || {})[kind] || {}) as Record<string, string>)[lang])
        checks.push({ code: "no_optout_text", level: "stop", text: `There is no opt-out line in this language (${lang}).` });
    const left = placeholdersIn(body + "\n" + subject).filter((x) => !checks.some((k) => k.code === "sender_details_missing") || !/startup|signature|privacy|legal|website/i.test(x));
    if (left.length) checks.push({ code: "placeholders", level: "stop", text: "The email still has placeholders: " + left.join(", ") });
    if (!subject.replace(/^Re:\s*/, "").trim()) checks.push({ code: "no_subject", level: "stop", text: "There is no subject for this person yet." });
    if (w !== "first") {
        const due = followupDue(st, ctx.research.messages, ctx.today, ctx.tz);
        if (!due || due.key !== w) {
            const inDays = followupIn(st, ctx.research.messages, ctx.today, ctx.tz);
            checks.push({
                code: "followup_not_due",
                level: "hold",
                text: inDays === null ? "No follow-up is queued for this person." : `The follow-up is due in ${inDays} day${inDays === 1 ? "" : "s"}.`,
            });
        }
    }
    if (w === "first" && ["sent", "followup", "replied", "meeting"].includes(statusOf(st)))
        checks.push({ code: "already_sent", level: "stop", text: "The first email has already gone to this person." });
    if (statusOf(st) === "drafted" && w === "first")
        checks.push({ code: "drafted", level: "hold", text: "A draft for this person is already waiting in the mailbox." });
    return {
        id: c.id,
        which: w,
        lang,
        to: addr.to,
        address_kind: addr.kind,
        subject,
        body,
        checks,
        sendable: !checks.some((k) => k.level === "stop"),
        agent_ok: !checks.some((k) => k.level !== "warn"),
    };
}

/* ---------- picking the next people ---------- */

interface CandidateRow {
    id: string;
    company_id: string;
}

/** Due follow-ups first (oldest first), then first emails: first batch, second batch, then the rest, best fit first. */
export async function pickCandidates(ctx: Ctx, limit: number, batch: number | null): Promise<string[]> {
    const { db } = ctx;
    const staleCutoff = new Date(ctx.now.getTime() - STALE_HOURS * 3600_000).toISOString();
    const queued = FOLLOWUP_ORDER.slice(1)
        .map((k, i) => ({ e: ctx.research.messages.emails[k], n: i + 1 }))
        .filter((x) => x.e && x.e.queue !== false);
    const minWait = queued.length ? Math.min(...queued.map((x) => x.e.wait_days || 5)) : null;
    // Follow-ups already sent, up to which the sequence still has a queued one (follow1 only: fewer than 1).
    const maxFollowups = queued.length ? Math.max(...queued.map((x) => x.n)) : 0;
    const freeClaim = `(k.contact_id IS NULL OR k.state IN ('released', 'done') OR k.until < ?1)`;
    const statements: D1PreparedStatement[] = [];
    if (minWait !== null) {
        const cutoffDay = shiftDay(ctx.today, -minWait);
        statements.push(
            db
                .prepare(
                    `SELECT c.id, c.company_id FROM status s JOIN contacts c ON c.id = s.id LEFT JOIN claims k ON k.contact_id = c.id
                     WHERE c.erased_at IS NULL AND c.law_level = 'ok' AND c.has_address = 1
                       AND json_extract(s.data, '$.status') IN ('sent', 'followup')
                       AND COALESCE(json_extract(s.data, '$.followups'), 0) < ?4
                       AND (json_extract(s.data, '$.outcome') = 'none' OR (json_extract(s.data, '$.outcome') IS NULL
                            AND COALESCE(json_extract(s.data, '$.lastReply.kind'), 'auto-reply') NOT IN ('meeting', 'positive', 'declined', 'redirect', 'needs_more', 'neutral')))
                       AND COALESCE(json_extract(s.data, '$.lastSentAt'), json_extract(s.data, '$.sentAt')) <= ?2
                       AND ${freeClaim} ${batch !== null ? "AND c.batch = ?5" : ""}
                     ORDER BY COALESCE(json_extract(s.data, '$.lastSentAt'), json_extract(s.data, '$.sentAt')) ASC LIMIT ?3`,
                )
                .bind(...(batch !== null ? [staleCutoff, cutoffDay, limit, maxFollowups, batch] : [staleCutoff, cutoffDay, limit, maxFollowups])),
        );
    }
    statements.push(
        db
            .prepare(
                `SELECT c.id, c.company_id FROM contacts c LEFT JOIN status s ON s.id = c.id LEFT JOIN claims k ON k.contact_id = c.id
                 WHERE c.erased_at IS NULL AND c.law_level = 'ok' AND c.has_address = 1 AND c.is_primary = 1
                   AND COALESCE(json_extract(s.data, '$.status'), 'todo') = 'todo'
                   AND ${freeClaim}
                   AND NOT EXISTS (SELECT 1 FROM claims k2 WHERE k2.company_id = c.company_id AND k2.contact_id != c.id AND k2.state IN ('active', 'drafted') AND k2.until > ?1)
                   ${batch !== null ? "AND c.batch = ?3" : ""}
                 ORDER BY CASE c.batch WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 2 END, c.rank DESC LIMIT ?2`,
            )
            .bind(...(batch !== null ? [staleCutoff, limit, batch] : [staleCutoff, limit])),
    );
    const results = await db.batch<CandidateRow>(statements);
    const ids: string[] = [];
    for (const r of results) for (const row of r.results) if (!ids.includes(row.id)) ids.push(row.id);
    return ids;
}

export function shiftDay(day: string, delta: number): string {
    const t = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + delta * 86400000;
    return new Date(t).toISOString().slice(0, 10);
}

/** Evaluates people with their colleagues loaded in one query. */
export async function evaluateMany(ctx: Ctx, people: Person[]): Promise<Map<string, Evaluation>> {
    const companies = await readCompanies(ctx.db, people.map((p) => p.row.company_id));
    const out = new Map<string, Evaluation>();
    for (const p of people) out.set(p.c.id, evaluate(p, companies.get(p.row.company_id) || [p], ctx));
    return out;
}

/** Holds that only apply to an agent that sends by itself. */
export function sendingHolds(p: Person, ctx: Ctx): Check[] {
    if (!ctx.actor.canSend || ctx.actor.role === "owner") return [];
    return inWorkingHours(p.c.country, ctx.now)
        ? []
        : [{ code: "outside_working_hours", level: "hold", text: "Outside weekday working hours (08:00 to 17:00) where this person works. Try again then." }];
}

/* ---------- the daily limit ---------- */

export interface Usage {
    day: string;
    limit: number;
    /** Emails recorded as sent today, by anyone. */
    sent_today: number;
    /** People taken or drafted by agents and not finished: they count until they are sent or given back. */
    taken_today: number;
    remaining: number;
    how_it_counts: string;
}

export async function usageToday(ctx: Ctx): Promise<Usage> {
    // Today's sends, plus everyone taken or drafted and not finished yet (whatever day they were taken).
    const [sent, taken] = await ctx.db.batch<{ n: number }>([
        ctx.db.prepare("SELECT COUNT(*) AS n FROM sends WHERE day = ?").bind(ctx.today),
        ctx.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE state IN ('active', 'drafted') AND until > ?").bind(ctx.now.toISOString()),
    ]);
    const s = Number(sent.results[0]?.n ?? 0);
    const t = Number(taken.results[0]?.n ?? 0);
    const limit = dailyLimit(ctx.settings);
    return {
        day: ctx.today,
        limit,
        sent_today: s,
        taken_today: t,
        remaining: Math.max(0, limit - s - t),
        how_it_counts: "remaining = limit - emails sent today (by anyone) - people taken or drafted and not yet sent or given back",
    };
}

/**
 * One statement per person, all in one atomic batch: the claim only goes in while today's sends plus open claims stay under
 * the limit, nobody else holds the person, and no other person at the company is being written to. D1 runs a batch as one
 * transaction, in order, so two agents can never pass the limit together.
 */
export function claimStatements(ctx: Ctx, items: { id: string; company_id: string; which: Which }[], minutes: number): D1PreparedStatement[] {
    const nowIso = ctx.now.toISOString();
    const until = new Date(ctx.now.getTime() + minutes * 60_000).toISOString();
    const staleCutoff = new Date(ctx.now.getTime() - STALE_HOURS * 3600_000).toISOString();
    const limit = dailyLimit(ctx.settings);
    return items.map((it) =>
        ctx.db
            .prepare(
                `INSERT INTO claims (contact_id, company_id, key_id, agent, which, day, created_at, until, state)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active'
                 WHERE (SELECT COUNT(*) FROM sends WHERE day = ?6) + (SELECT COUNT(*) FROM claims WHERE state IN ('active', 'drafted') AND until > ?7) < ?9
                   AND NOT EXISTS (SELECT 1 FROM claims k WHERE k.company_id = ?2 AND k.contact_id != ?1 AND k.state IN ('active', 'drafted') AND k.until > ?10)
                 ON CONFLICT(contact_id) DO UPDATE SET key_id = excluded.key_id, agent = excluded.agent, which = excluded.which, day = excluded.day,
                   created_at = excluded.created_at, until = excluded.until, state = 'active'
                 WHERE claims.state IN ('released', 'done') OR claims.until < ?10`,
            )
            .bind(it.id, it.company_id, ctx.actor.keyId ?? "owner", ctx.actor.name, it.which, ctx.today, nowIso, until, limit, staleCutoff),
    );
}

/* ---------- checking an email before it goes out ---------- */

export function lintEmail(ev: Evaluation, ctx: Ctx, subject: string, body: string): { problems: string[]; warnings: string[] } {
    const problems: string[] = [];
    const warnings: string[] = [];
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const b = norm(body);
    const sender = senderOf(ctx.research.messages, ctx.settings);
    if (!subject.trim()) problems.push("The subject is empty.");
    const left = placeholdersIn(subject + "\n" + body);
    if (left.length) problems.push("Placeholders are still in the email: " + left.join(", "));
    // The opt-out paragraph of the composed email must survive editing word for word (it names the source and the privacy notice).
    const optoutPara = ev.body.split(/\n\n/).pop() || "";
    if (optoutPara && !b.includes(norm(optoutPara))) problems.push("The opt-out paragraph (where the address was found, how to say stop, the privacy notice link) is missing or changed.");
    if (sender.privacy && !b.includes(sender.privacy.trim())) problems.push("The link to the privacy notice is missing.");
    const sig = norm((sender.signature || "").split("[startup name]").join(sender.startup || ""));
    if (sig && !b.includes(sig)) problems.push("The signature (name, company's legal name, postal address, website) is missing or changed.");
    const allowed = new Set([sender.privacy || "", ...((sender.signature || "").match(/https?:\/\/\S+/g) || [])].map((u) => u.replace(/[).,]+$/, "")));
    const links = (body.match(/https?:\/\/[^\s)>\]]+/g) || []).map((u) => u.replace(/[).,]+$/, ""));
    const extra = links.filter((u) => !allowed.has(u) && !(sender.privacy && u.startsWith(sender.privacy)));
    if (extra.length) problems.push("Links other than your privacy notice and website are not allowed (no tracking links): " + extra.join(", "));
    if (/<img|<a\s/i.test(body)) problems.push("The email must be plain text: no HTML, images or tracking pixels.");
    const top = body.split(/\n(?:Best regards|Meilleures salutations|Cordiali saluti),?\n/)[0].trim();
    const words = top ? top.split(/\s+/).length : 0;
    if (ev.which === "first" && words > 150) warnings.push(`${words} words above the signature; the research says 50 to 125.`);
    if (/just checking in|never heard back|je me permets de relancer|volevo solo/i.test(body)) warnings.push("A follow-up should add one new fact or a narrower question, not 'just checking in'.");
    return { problems, warnings };
}

/* ---------- replies ---------- */

const KIND_OUTCOME: Record<string, string> = { meeting: "interested", positive: "interested", redirect: "needs_more", neutral: "pending", declined: "declined" };
export const REPLY_KINDS = [...Object.keys(KIND_OUTCOME), "auto-reply"];

export interface ReplyItem {
    kind: string;
    summary: string;
    date: string;
    from?: string;
    message_id?: string;
    message_url?: string;
    optout?: boolean;
}

function nextStatusAfterReply(cur: string, kind: string, optout: boolean): string {
    if (kind === "declined") return optout || cur === "optout" ? "optout" : "declined";
    if (cur === "optout") return "optout";
    if (cur === "meeting") return "meeting";
    return kind === "meeting" ? "meeting" : "replied";
}

/** Plain words only: no addresses, links or phone numbers in a stored summary. */
export function cleanSummary(s: string): string {
    return s
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[address]")
        .replace(/https?:\/\/\S+/g, "[link]")
        .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
}

/** The same fields the daily reply check writes (research_notes/.../reply-check/check.py build_payload). */
export function replyPatch(doc: StatusDoc, items: ReplyItem[], now: string, by: string): { patch: Partial<StatusDoc> | null; recorded: number } {
    const replies = (Array.isArray(doc.replies) ? doc.replies : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
    const known = new Set(replies.map((r) => String(r.messageId || "")).filter(Boolean));
    // Without a Message-ID the same reply sent twice must still be recognised, so its key leaves out the time.
    const keyOf = (it: ReplyItem) => it.message_id || `${it.kind}|${cleanSummary(it.summary).slice(0, 60).toLowerCase()}|${(it.from || "").toLowerCase()}`;
    const fresh = [...items].sort((a, b) => a.date.localeCompare(b.date)).filter((it) => {
        const id = keyOf(it);
        if (known.has(id)) return false;
        known.add(id);
        return true;
    });
    if (!fresh.length) return { patch: null, recorded: 0 };
    const nextReplies = [
        ...replies,
        ...fresh.map((it) => ({
            date: it.date,
            kind: it.kind,
            messageId: keyOf(it),
            ...(it.kind !== "auto-reply" ? { outcome: KIND_OUTCOME[it.kind] } : {}),
        })),
    ];
    const patch: Partial<StatusDoc> = { replies: nextReplies, updatedAt: now, updatedBy: by };
    const cur = statusOf(doc);
    const prev = doc.lastReply && typeof doc.lastReply === "object" ? doc.lastReply : null;
    const real = fresh.filter((it) => it.kind !== "auto-reply");
    const lastReply = (it: ReplyItem) => {
        let summary = cleanSummary(it.summary);
        if (it.kind === "declined" && it.optout && !/^asked/i.test(summary)) summary = cleanSummary("Asked you to stop: " + summary);
        if (cur === "optout" && it.kind !== "declined") summary = cleanSummary("After asking you to stop: " + summary);
        return { date: it.date, from: (it.from || "").slice(0, 120), kind: it.kind, messageUrl: it.message_url && /^message:/i.test(it.message_url) ? it.message_url : undefined, summary };
    };
    if (real.length) {
        const newest = real[real.length - 1];
        const prevReal = prev && prev.kind && prev.kind !== "auto-reply" ? prev.date || "" : "";
        if (!prevReal || prevReal <= newest.date) {
            patch.lastReply = lastReply(newest);
            patch.outcome = KIND_OUTCOME[newest.kind];
            patch.needsAction = newest.kind !== "declined" || !!newest.optout;
            const status = nextStatusAfterReply(cur, newest.kind, !!newest.optout);
            if (status !== cur) patch.status = status as StatusDoc["status"];
        }
    } else if (!prev || prev.kind === "auto-reply") {
        patch.lastReply = lastReply(fresh[fresh.length - 1]);
    }
    return { patch, recorded: real.length };
}

/** A refusal for an agent when the founder's side is not ready, with the list to pass on. */
export function notReady(r: Readiness): Refusal {
    return new Refusal(409, "Agents cannot take people yet. Tell the founder what is missing; never invent or fill in these details yourself.", {
        ready: false,
        missing: r.missing,
        tell_the_founder: true,
    });
}
