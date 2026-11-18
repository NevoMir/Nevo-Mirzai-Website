// The outreach rules shared by the page (src/client-outreach/app.js, in the browser) and the Worker (worker/outreach/, the API that
// AI agents use). Both compose emails and judge who may be written to with these functions, so an agent gets exactly the email the
// founder sees in the composer. Pure functions only: no DOM, no fetch, no clock (callers pass "today").
//
// Moved here from the private claude.ai page (research_notes/.../page/index.html); the behaviour is the same, except that day
// counts are calendar days in a named time zone instead of the browser's local clock, so they also hold in the Worker.

export type Lang = "en" | "fr" | "it";
export type Which = "first" | "follow1" | "follow2";
export type StatusValue = "todo" | "drafted" | "sent" | "followup" | "replied" | "meeting" | "declined" | "optout" | "bounced" | "skip";
export type OutcomeValue = "interested" | "needs_more" | "declined" | "pending";

export const FOLLOWUP_ORDER: readonly Which[] = ["first", "follow1", "follow2"];
export const LANGS: readonly Lang[] = ["en", "fr", "it"];
export const LANG_LABEL: Record<Lang, string> = { en: "English", fr: "French", it: "Italian" };

export const STATUSES: readonly { v: StatusValue; label: string }[] = [
    { v: "todo", label: "To contact" },
    { v: "drafted", label: "Drafted" },
    { v: "sent", label: "Sent" },
    { v: "followup", label: "Follow-up sent" },
    { v: "replied", label: "Replied" },
    { v: "meeting", label: "Meeting" },
    { v: "declined", label: "Declined" },
    { v: "optout", label: "Asked to stop" },
    { v: "bounced", label: "Bounced" },
    { v: "skip", label: "Skip" },
];
export const STATUS_VALUES: readonly StatusValue[] = STATUSES.map((s) => s.v);

// Reply outcome: green = interested, orange = needs more first, red = not interested.
export const OUTCOMES: Record<OutcomeValue, { label: string; short: string }> = {
    interested: { label: "Interested, wants to meet", short: "Interested" },
    needs_more: { label: "Needs something more before meeting", short: "Needs more" },
    declined: { label: "Not interested", short: "Not interested" },
    pending: { label: "Replied, no decision yet", short: "No decision yet" },
};
const KIND_TO_OUTCOME: Record<string, OutcomeValue> = {
    meeting: "interested",
    positive: "interested",
    declined: "declined",
    redirect: "needs_more",
    needs_more: "needs_more",
    neutral: "pending",
};

export interface Reply {
    date?: string;
    from?: string;
    kind?: string;
    summary?: string;
    messageUrl?: string;
    threadUrl?: string;
    messageId?: string;
}
export interface Meeting {
    when?: string;
    state?: string;
    platform?: string;
    note?: string;
}
/** One person's outreach record: the same shape the claude.ai page stored as outreach/<id>. Unknown fields are kept as they are. */
export interface StatusDoc {
    status?: StatusValue;
    sentAt?: string | null;
    lastSentAt?: string | null;
    followups?: number;
    lang?: Lang;
    subject?: string;
    custom?: { hook?: string; angle?: string } | null;
    notes?: string;
    outcome?: string;
    meeting?: Meeting | null;
    lastReply?: Reply;
    needsAction?: boolean;
    updatedAt?: string;
    /** Who last marked an email as sent ("you" or an agent's name). */
    sentBy?: string;
    [key: string]: unknown;
}

/** The fields of a contact this module reads. The research records carry many more. */
export interface Contact {
    id: string;
    name: string;
    first_name?: string;
    salutation?: string;
    role?: string;
    company: string;
    company_short?: string;
    company_id: string;
    company_url?: string;
    kind?: string;
    segment?: string;
    region?: string;
    country: string;
    lang: Lang;
    email?: string;
    generic_email?: string;
    email_status?: string;
    email_source_url?: string;
    email_evidence?: string;
    hook?: string;
    angle?: string;
    subject?: string;
    batch?: number;
    rank: number;
    is_primary?: boolean;
    notes?: string;
    channel_note?: string;
    best_channel?: string;
    role_confidence?: string;
    check?: { role_status?: string } | null;
}

export interface EmailTemplate {
    label: string;
    when?: string;
    wait_days?: number;
    queue?: boolean;
    en: string;
    fr?: string;
    it?: string;
}
export interface Messages {
    guide?: string;
    sender_defaults?: Sender;
    credential?: Partial<Record<Lang, string>>;
    optout?: Record<string, Partial<Record<Lang, string>>>;
    emails: Record<string, EmailTemplate>;
    check_offer?: Partial<Record<Lang, string>>;
    english_note?: string;
}
/** "Your details" on the page: they fill in every email. */
export interface Sender {
    startup?: string;
    signature?: string;
    privacy?: string;
    use_credential?: boolean;
    use_check_offer?: boolean;
}
/** Sender details plus how agents may work. Stored as meta/settings. Whether an agent may send by itself is set per key. */
export interface Settings extends Sender {
    /** Emails per day, first emails and follow-ups together, counting what the founder sends by hand. */
    daily_limit?: number;
    /** The founder's time zone: "today" for sent dates, follow-up timing and the daily limit. */
    timezone?: string;
    /** The mailbox the emails go out from (on the company's own domain). */
    from_address?: string;
    /** The founder confirmed the sending setup: own domain at least 32 days old, SPF, DKIM and DMARC passing, no tracking. */
    mail_ready?: boolean;
    /** Stops every agent from taking anyone. */
    agents_paused?: boolean;
}
export const DEFAULT_TIMEZONE = "Europe/Zurich";
export const DEFAULT_DAILY_LIMIT = 5;
export const MAX_DAILY_LIMIT = 50;

/** One row of the law research (playbook.law.rules). */
export interface LawRule {
    country: string;
    country_name: string;
    level: "ok" | "caution" | "consent";
    rule?: string;
    what_to_do?: string;
    source_url?: string;
}

/* ---------- status ---------- */

export const statusOf = (st?: StatusDoc | null): StatusValue => (st && st.status && STATUS_VALUES.includes(st.status) ? st.status : "todo");

export function outcomeOf(st?: StatusDoc | null): OutcomeValue | "" {
    const s = st || {};
    if (s.outcome === "none") return "";
    if (s.outcome && s.outcome in OUTCOMES) return s.outcome as OutcomeValue;
    const k = s.lastReply && s.lastReply.kind;
    return (k && KIND_TO_OUTCOME[k]) || "";
}

/** Someone who asked to stop, said no, or whose address bounced stays that way: nothing turns them back into "sent". */
export const CLOSED_STATUSES: readonly StatusValue[] = ["optout", "declined", "bounced"];
export const isClosed = (st?: StatusDoc | null): boolean => CLOSED_STATUSES.includes(statusOf(st));

/** Which email comes next for this person, given what has been sent. */
export function nextEmail(st?: StatusDoc | null): Which {
    const s = st || {};
    if (!["sent", "followup"].includes(statusOf(s)) || !s.sentAt) return "first";
    return FOLLOWUP_ORDER[Math.min((s.followups || 0) + 1, FOLLOWUP_ORDER.length - 1)];
}

/* ---------- days ---------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function dayIn(instant: Date, timeZone: string): string {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
    } catch {
        parts = new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
    }
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar day of a stored date: a plain YYYY-MM-DD stays as it is; a timestamp is read in the time zone. */
export function toDay(value: string | null | undefined, timeZone: string): string | null {
    if (!value) return null;
    const v = String(value).trim();
    if (DAY_RE.test(v)) return v;
    const t = new Date(v);
    return Number.isNaN(t.getTime()) ? null : dayIn(t, timeZone);
}

/** Whole calendar days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
    const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
    const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
    return Math.round((b - a) / 86400000);
}

export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * A follow-up is due when the last email has been out for the wait set on the next one and nobody has answered.
 * `today` is YYYY-MM-DD in the founder's time zone.
 */
export function followupDue(st: StatusDoc | null | undefined, messages: Messages | null, today: string, timeZone: string): { key: Which; late: number } | null {
    const s = st || {};
    if (!["sent", "followup"].includes(statusOf(s)) || !s.sentAt || outcomeOf(s)) return null;
    const n = s.followups || 0;
    if (n >= FOLLOWUP_ORDER.length - 1) return null;
    const key = FOLLOWUP_ORDER[n + 1];
    const next: Partial<EmailTemplate> = (messages && messages.emails[key]) || {};
    if (next.queue === false) return null;
    const wait = next.wait_days || 5;
    const last = toDay(s.lastSentAt || s.sentAt, timeZone);
    if (!last) return null;
    const since = daysBetween(last, today);
    if (since < wait) return null;
    return { key, late: since - wait };
}

/** Days until the next follow-up is due (0 = today), or null when no follow-up is queued. */
export function followupIn(st: StatusDoc | null | undefined, messages: Messages | null, today: string, timeZone: string): number | null {
    const s = st || {};
    if (!["sent", "followup"].includes(statusOf(s)) || !s.sentAt || outcomeOf(s)) return null;
    const n = s.followups || 0;
    if (n >= FOLLOWUP_ORDER.length - 1) return null;
    const next: Partial<EmailTemplate> = (messages && messages.emails[FOLLOWUP_ORDER[n + 1]]) || {};
    if (next.queue === false) return null;
    const last = toDay(s.lastSentAt || s.sentAt, timeZone);
    if (!last) return null;
    return Math.max(0, (next.wait_days || 5) - daysBetween(last, today));
}

/* ---------- sender ---------- */

export function senderOf(messages: Messages | null, settings: Settings | null): Sender {
    return Object.assign({}, (messages && messages.sender_defaults) || {}, settings || {});
}

/** What is still missing from Your details, in plain words. An email with a gap would go out with a placeholder in it. */
export function senderGaps(s: Sender): string[] {
    const gaps: string[] = [];
    if (!s.startup || !s.startup.trim()) gaps.push("the startup name");
    if (!s.privacy || !/^https?:\/\/\S+$/i.test(s.privacy.trim())) gaps.push("the link to your privacy notice");
    const sig = (s.signature || "").split("[startup name]").join("");
    if (!sig.trim()) gaps.push("the signature");
    else if (/\[[a-z]/i.test(sig)) gaps.push("the parts of the signature still in brackets (the company's legal name, postal address, website)");
    return gaps;
}

/* ---------- composing ---------- */

/** The person-specific parts of the first email: the founder's edits if any, else the research's suggestion. */
export function partsFor(c: Contact, st?: StatusDoc | null): { hook: string; angle: string } {
    const cu = (st && st.custom) || {};
    return {
        hook: typeof cu.hook === "string" ? cu.hook : c.hook || "",
        angle: typeof cu.angle === "string" ? cu.angle : c.angle || "",
    };
}

const safeHttpUrl = (u: unknown): string => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

/** Where the address was found, for the opt-out line. */
export function sourceHost(c: Contact): string {
    const u = safeHttpUrl(c.email_source_url) || safeHttpUrl(c.company_url);
    try {
        return new URL(u).hostname.replace(/^www\./, "");
    } catch {
        return "[where you found the address]";
    }
}

export function subjectFor(c: Contact, st: StatusDoc | null | undefined, which: Which): string {
    const first = (st && st.subject) || c.subject || "";
    return which === "first" ? first : "Re: " + first;
}

/** The language of the next email: a thread stays in the language it started in. */
export function langFor(c: Contact, st?: StatusDoc | null): Lang {
    const sentLang = ["sent", "followup"].includes(statusOf(st)) && st && st.lang;
    return (sentLang && LANGS.includes(sentLang) ? sentLang : LANGS.includes(c.lang) ? c.lang : "en") as Lang;
}

export function composeBody(c: Contact, parts: { hook: string; angle: string }, which: Which, lang: Lang, m: Messages, s: Sender): string {
    const e = m.emails[which] || m.emails.first;
    const t = e[lang] || e.en;
    // A host or integrator may see SwissGPU as a competitor, so the link is always disclosed to them.
    const credential = s.use_credential !== false || c.kind === "channel" || c.segment === "hosting-channel" ? (m.credential || {})[lang] || "" : "";
    const offersCheck = s.use_check_offer !== false && (!c.kind || c.kind === "client");
    const checkOffer = offersCheck ? (m.check_offer || {})[lang] || "" : "";
    const englishNote = lang === "en" && c.region === "German-speaking Switzerland" ? m.english_note || "" : "";
    const startup = s.startup || "[startup name]";
    const kind = c.email_status === "published" || c.email_status === "pattern" ? c.email_status : "generic";
    const optout = ((m.optout || {})[kind] || {})[lang] || "";
    const fill: Record<string, string> = {
        // The saved greeting is in the contact's language, so another language gets its own.
        greeting: lang === c.lang ? c.salutation || "" : ({ en: "Dear ", fr: "Bonjour ", it: "Gentile " }[lang] || "") + c.name + ",",
        first_name: c.first_name || "",
        hook: parts.hook || "[your opening]",
        angle: parts.angle || "[what it could do for them]",
        credential: credential ? " " + credential : "",
        check_offer: checkOffer ? " " + checkOffer : "",
        english_note: englishNote ? " " + englishNote : "",
        signature: (s.signature || "[signature]").split("[startup name]").join(startup),
        optout,
        startup,
        company: c.company_short || c.company || "",
        source: sourceHost(c),
        privacy: s.privacy || "[privacy notice link]",
    };
    // split/join rather than a replacement string, which would read $' or $& in typed text as a pattern.
    return Object.keys(fill)
        .reduce((text, k) => text.split("{{" + k + "}}").join(fill[k]), t)
        .replace(/\n{3,}/g, "\n\n");
}

/** A placeholder left in a composed email ([startup name], [your opening], {{token}}). */
export function placeholdersIn(text: string): string[] {
    return [...new Set(text.match(/\{\{[a-z_]+\}\}|\[(?:startup name|your opening|what it could do for them|signature|privacy notice link|where you found the address|company legal name[^\]]*|website)\]/gi) || [])];
}

/** The address an email goes to, and what kind it is. */
export function addressOf(c: Contact): { to: string; kind: "published" | "pattern" | "generic" | "none" } {
    if (c.email && (c.email_status === "published" || c.email_status === "pattern")) return { to: c.email, kind: c.email_status };
    if (c.email) return { to: c.email, kind: "published" };
    if (c.generic_email) return { to: c.generic_email, kind: "generic" };
    return { to: "", kind: "none" };
}

/* ---------- who may be written to ---------- */

/**
 * level "stop": nobody should send this email (the page shows it in red).
 * level "hold": the founder may send it after a look, but an agent must leave it (the page shows it as a warning).
 * level "warn": worth knowing before sending.
 */
export interface Check {
    code: string;
    level: "stop" | "hold" | "warn";
    text: string;
}

export interface CheckContext {
    st?: StatusDoc | null;
    /** The other people at the same company, each with their status. */
    colleagues: { c: Contact; st?: StatusDoc | null }[];
    law?: LawRule | null;
    sender: Sender;
    /** The email about to be written (default: the next one). */
    which?: Which;
    /** The page's read-only shared copy hides addresses; it has no use for the address checks. */
    shared?: boolean;
}

export const roleInDoubt = (c: Contact): boolean => c.role_confidence === "low" || !!(c.check && c.check.role_status === "doubtful");

export function checksFor(c: Contact, ctx: CheckContext): Check[] {
    const out: Check[] = [];
    const st = ctx.st || {};
    const cur = statusOf(st);
    const r = ctx.law;
    const which = ctx.which || nextEmail(st);
    if (cur === "optout") out.push({ code: "opted_out", level: "stop", text: "This person asked you to stop. Do not write again." });
    if (cur === "declined") out.push({ code: "declined", level: "stop", text: "This person said no. Do not write again unless they ask you to." });
    if (cur === "bounced") out.push({ code: "bounced", level: "stop", text: "An email to this address bounced. Find a working address before writing again." });
    if (cur === "replied" || cur === "meeting")
        out.push({ code: "replied", level: "hold", text: "This person has already answered, so answer them in that thread instead of using this draft." });
    if (cur === "skip") out.push({ code: "skipped", level: "hold", text: "You set this contact to Skip." });
    if (["sent", "followup"].includes(cur) && (st.followups || 0) >= FOLLOWUP_ORDER.length - 1)
        out.push({ code: "sequence_done", level: "stop", text: "You have already sent the last note. Treat silence as a no." });
    const stopped = ctx.colleagues.find((x) => statusOf(x.st) === "optout");
    if (stopped) out.push({ code: "company_opted_out", level: "stop", text: stopped.c.name + " at " + c.company + " asked you to stop, so leave this company alone." });
    const active = ctx.colleagues.find((x) => ["sent", "followup", "replied", "meeting"].includes(statusOf(x.st)));
    if (active && which === "first")
        out.push({ code: "company_thread_active", level: "hold", text: "You already wrote to " + active.c.name + " here. Wait until that thread ends before writing to a second person at this company." });
    if (r && r.level === "consent") out.push({ code: "consent_country", level: "stop", text: r.country_name + " needs prior consent for cold email. " + (r.what_to_do || "") });
    else if (r && r.level === "caution") out.push({ code: "caution_country", level: "hold", text: r.country_name + ": " + (r.what_to_do || "") });
    if (!ctx.shared) {
        if (!c.email && !c.generic_email) out.push({ code: "no_address", level: "stop", text: "No address for this person. " + (c.channel_note || "") });
        if (c.email_status === "pattern") out.push({ code: "inferred_address", level: "warn", text: "This address is inferred, not published. Check it before sending. " + (c.email_evidence || "") });
    }
    if (c.email_status === "generic") out.push({ code: "generic_mailbox", level: "warn", text: "This is a generic mailbox. Open with who the email is for, and ask them to pass it on." });
    if (roleInDoubt(c)) out.push({ code: "role_doubtful", level: "hold", text: "The sources for this role are old or unclear. Confirm the person is still there." });
    if (which === "first" && c.best_channel && c.best_channel !== "email")
        out.push({ code: "other_route_first", level: "hold", text: "The research suggests another route first (" + c.best_channel.replace("_", " ") + "). " + (c.channel_note || "") });
    if (which === "first" && !c.is_primary && !active)
        out.push({ code: "second_person", level: "hold", text: "Another person at " + c.company + " comes first. Write to a second person only after that thread ends." });
    const gaps = senderGaps(ctx.sender);
    if (gaps.length) out.push({ code: "sender_details_missing", level: "stop", text: "Fill in Your details first (" + gaps.join(", ") + "), or the email will go out with placeholders in it." });
    return out;
}

/* ---------- status changes ---------- */

/** What a status picked by hand means for the dates and the reply outcome. `day` is today (YYYY-MM-DD). */
export function statusPatch(st: StatusDoc | null | undefined, value: StatusValue, day: string): Partial<StatusDoc> {
    const s = st || {};
    const cur = statusOf(s);
    const patch: Partial<StatusDoc> = { status: value };
    if (value === "followup" && cur !== "followup") {
        patch.sentAt = s.sentAt || day;
        patch.lastSentAt = day;
        patch.followups = Math.min((s.followups || 0) + 1, FOLLOWUP_ORDER.length - 1);
    } else if (value === "sent" && ["todo", "drafted", "skip"].includes(cur)) {
        patch.sentAt = day;
        patch.lastSentAt = day;
        patch.followups = 0;
    } else if (value === "sent" && !s.sentAt) {
        patch.sentAt = day;
        patch.lastSentAt = day;
        patch.followups = 0;
    } else if (value === "sent" && cur === "followup") {
        patch.followups = 0;
    } else if (["todo", "drafted"].includes(value) && s.sentAt) {
        patch.sentAt = null;
        patch.lastSentAt = null;
        patch.followups = 0;
    }
    // An outcome only belongs with a reply.
    if (value === "declined") patch.outcome = "declined";
    else if (!["replied", "meeting"].includes(value) && (s.outcome || s.lastReply)) patch.outcome = "none";
    return patch;
}

/**
 * "Mark as sent" for one email: the first one or a follow-up. Returns null for someone who asked not to be written to.
 * An answer in a live thread doesn't send the contact back to the start of the sequence.
 */
export function sentPatch(
    st: StatusDoc | null | undefined,
    which: Which,
    opts: { day: string; lang?: Lang; subject?: string; custom?: { hook: string; angle: string } | null; by?: string },
): Partial<StatusDoc> | null {
    const s = st || {};
    if (isClosed(s)) return null;
    const cur = statusOf(s);
    const patch: Partial<StatusDoc> =
        which === "first"
            ? { status: "sent", sentAt: s.sentAt || opts.day, lastSentAt: opts.day, followups: 0 }
            : { status: "followup", sentAt: s.sentAt || opts.day, lastSentAt: opts.day, followups: FOLLOWUP_ORDER.indexOf(which) };
    if (which === "first") {
        if (opts.lang) patch.lang = opts.lang;
        if (opts.subject !== undefined) patch.subject = opts.subject;
        if (opts.custom !== undefined) patch.custom = opts.custom;
    }
    if (opts.by) patch.sentBy = opts.by;
    if (cur === "replied" || cur === "meeting") {
        delete patch.status;
        delete patch.followups;
        delete patch.sentAt;
    }
    return patch;
}

/** Applies a patch the way the page's database merge did: `null` clears a field, anything else replaces it. */
export function mergeDoc(prev: StatusDoc | null | undefined, patch: Partial<StatusDoc>): StatusDoc {
    const next: StatusDoc = Object.assign({}, prev || {});
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (v === null) delete next[k];
        else next[k] = v;
    }
    return next;
}
