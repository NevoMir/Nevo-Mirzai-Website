// The founder's outreach page on nevomirzai.com/client-outreach (served only after the owner sign-in, worker/outreach/pages.ts).
// Moved from the private claude.ai page: the same filters, cards, composer, message versions and playbook. The data comes from
// /api/outreach instead of the claude.ai database, and the page asks for changes every 20 seconds, so what agents do shows up.
// New here: copy buttons on every card, ticking people to mark many as sent at once, and the Agents tab.

import {
    DEFAULT_TIMEZONE,
    FOLLOWUP_ORDER,
    LANG_LABEL,
    OUTCOMES,
    STATUSES,
    addressOf,
    checksFor,
    composeBody as coreComposeBody,
    dayIn,
    followupDue as coreFollowupDue,
    isClosed as coreIsClosed,
    nextEmail as coreNextEmail,
    outcomeOf as coreOutcomeOf,
    partsFor as corePartsFor,
    placeholdersIn,
    roleInDoubt,
    senderOf,
    statusOf as coreStatusOf,
    subjectFor as coreSubjectFor,
} from "./shared/core.ts";

const API = "/api/outreach";
const POLL_MS = 20000;
const STATUS_ORDER = Object.fromEntries(STATUSES.map((s, i) => [s.v, i]));
const REGIONS = ["Romandie and Ticino", "German-speaking Switzerland", "France, Italy, Belgium", "Rest of Europe"];
const EMAIL_KINDS = [
    ["published", "Published address"],
    ["pattern", "Inferred address"],
    ["generic", "Generic mailbox only"],
    ["none", "No address"],
];
const HW_LABEL = { confirmed: "Hardware confirmed", likely: "Hardware likely", unknown: "Hardware unknown" };
const KIND_LABEL = { client: "Could buy", channel: "Partner route", reference: "Reference, not a sale" };
const RUBRIC = [["hardware", "Hardware"], ["idle", "Idle time"], ["no_cloud", "Reason to avoid the cloud"], ["skills_gap", "Skills gap"], ["reach", "Reach"]];
const CHANNEL_LABEL = { email: "Email", linkedin: "LinkedIn", warm_intro: "Warm intro", event: "At an event", form: "Contact form", phone: "Phone" };
const PLAY_VIEWS = [["plan", "Start here"], ["segments", "Segments"], ["routes", "Contact routes"], ["law", "Law by country"], ["email", "Email setup"], ["market", "Market and objections"], ["events", "Events"]];
const VIEWS = ["contacts", "messages", "playbook", "agents"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const safeMailUrl = (u) => (/^message:/i.test(String(u || "")) ? String(u) : safeUrl(u));
const extLink = (u, text, attrs = "") => { const s = safeUrl(u); return s ? `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer"${attrs}>${esc(text)}</a>` : esc(text); };

const state = {
    contacts: [], messages: null, playbook: null, byCompany: {}, lawBy: {},
    status: {}, docMeta: {}, settings: {}, sync: null, claims: [], erased: new Set(), rev: 0, statusLoaded: false,
    filters: { region: "", seg: "", first: false, cat: "", status: "", email: "", hw: "", fit: "", kind: "", country: "", lang: "", primary: "", q: "", sort: "rank", outcome: "" },
    playView: "plan", msgLang: "en",
    view: "contacts", composerId: null, currentParts: null,
    selected: new Set(), pending: new Map(), booted: false, needFull: false, dataMeta: null, erasedInfo: [],
    overview: null, keys: null, log: null, newKey: null, links: {},
};

try {
    const saved = JSON.parse(localStorage.getItem("llo-filters") || "null");
    if (saved && typeof saved === "object") Object.assign(state.filters, saved);
    const savedPlay = localStorage.getItem("llo-play");
    if (savedPlay && PLAY_VIEWS.some(([k]) => k === savedPlay)) state.playView = savedPlay;
} catch (e) { /* storage unavailable */ }
function saveFilters() { try { localStorage.setItem("llo-filters", JSON.stringify(state.filters)); } catch (e) { /* ignore */ } }

function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function copyText(text, fallbackEl, done = "Copied") {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => toast(done), () => selectFallback(fallbackEl));
    } else selectFallback(fallbackEl);
}
function selectFallback(el) {
    if (el && el.select) { el.focus(); el.select(); toast("Selected. Press Cmd/Ctrl+C to copy"); }
    else toast("Copy is blocked here. Select the text manually");
}

/* ---------- the API ---------- */

async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
        method,
        credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.assign("/client-outreach"); throw new Error("Signed out"); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
        const err = new Error((data && data.error) || "HTTP " + res.status);
        err.status = res.status; err.data = data;
        throw err;
    }
    return data;
}

function applyDocs(docs) {
    for (const [id, d] of Object.entries(docs || {})) {
        state.status[id] = d.doc || {};
        state.docMeta[id] = { v: d.v, by: d.by, at: d.at };
    }
}

/** Runs a write for these people; their documents are not overwritten by a poll while it is in flight. */
async function write(ids, run) {
    ids.forEach((id) => state.pending.set(id, (state.pending.get(id) || 0) + 1));
    try {
        const r = await run();
        if (r && r.docs) applyDocs(r.docs);
        return r;
    } finally {
        ids.forEach((id) => { const n = (state.pending.get(id) || 1) - 1; if (n <= 0) state.pending.delete(id); else state.pending.set(id, n); });
        renderCounters();
        // Claims (a draft pill, "taken by") and anything a poll skipped while this write was in flight.
        setTimeout(refreshState, 0);
    }
}

/* ---------- status ---------- */

const st = (id) => state.status[id] || {};
const statusOf = (id) => coreStatusOf(st(id));
const outcomeOf = (id) => coreOutcomeOf(st(id));
const isClosed = (id) => coreIsClosed(st(id));
const tz = () => state.settings.timezone || DEFAULT_TIMEZONE;
const today = () => dayIn(new Date(), tz());
const followupDue = (id) => coreFollowupDue(st(id), state.messages, today(), tz());
const nextEmail = (id) => coreNextEmail(st(id));
const sender = () => senderOf(state.messages, state.settings);
const partsFor = (c) => corePartsFor(c, st(c.id));
const subjectFor = (c, which) => coreSubjectFor(c, st(c.id), which);
const composeBody = (c, parts, which, lang) => coreComposeBody(c, parts, which, lang, state.messages, sender());
const claimOf = (id) => state.claims.find((k) => k.contact_id === id) || null;

function nextMeeting(id) {
    const m = st(id).meeting;
    if (!m || !m.when) return null;
    const t = new Date(m.when);
    if (isNaN(t) || t.getTime() < Date.now() - 2 * 3600 * 1000) return null;
    return Object.assign({}, m, { t });
}
function fmtWhen(t) { return t.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? String(iso || "") : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function ocRank(o) { return { interested: 0, needs_more: 1, pending: 2, declined: 3 }[o] ?? 4; }

/* ---------- rendering ---------- */

function renderCounters() {
    const counts = {}; STATUSES.forEach((s) => { counts[s.v] = 0; });
    state.contacts.forEach((c) => { counts[statusOf(c.id)]++; });
    const emailed = counts.sent + counts.followup + counts.replied + counts.meeting + counts.declined + counts.optout + counts.bounced;
    const replies = counts.replied + counts.meeting + counts.declined + counts.optout;
    const companies = new Set(state.contacts.map((c) => c.company_id)).size;
    const due = state.contacts.filter((c) => followupDue(c.id)).length;
    const drafts = state.claims.filter((k) => k.state === "drafted").length;
    $("counters").innerHTML =
        `<span class="counter"><b>${state.contacts.length}</b>contacts</span>` +
        `<span class="counter"><b>${companies}</b>companies</span>` +
        `<span class="counter"><b>${emailed}</b>emailed</span>` +
        `<span class="counter"><b>${replies}</b>replies</span>` +
        `<span class="counter c-yes"><b>${state.contacts.filter((c) => outcomeOf(c.id) === "interested").length}</b>interested</span>` +
        `<span class="counter c-meet"><b>${state.contacts.filter((c) => nextMeeting(c.id)).length}</b>meetings</span>` +
        `<span class="counter c-due"><b>${due}</b>follow-ups due</span>` +
        (drafts ? `<span class="counter"><b>${drafts}</b>drafts to send</span>` : "") +
        `<span class="counter"><b>${state.contacts.filter((c) => st(c.id).needsAction).length}</b>need your reply</span>`;
}

function renderSync() {
    const el = $("sync-line");
    const m = state.sync;
    if (!m) { el.textContent = ""; el.className = "sync"; return; }
    if (m.lastError) { el.textContent = "Email check failed " + fmtDate(m.lastRunAt) + ": " + m.lastError; el.className = "sync err"; return; }
    el.textContent = "Email checked " + fmtDate(m.lastRunAt) + (m.newReplies ? " · " + m.newReplies + " new repl" + (m.newReplies === 1 ? "y" : "ies") : " · no new replies");
    el.className = "sync";
}

function segments() { return (state.playbook && state.playbook.segments) || []; }
const segLabel = (k) => (segments().find((s) => s.key === k) || { label: k }).label;

function renderFilterControls() {
    const f = state.filters;
    const batchN = (b) => state.contacts.filter((c) => c.batch === b).length;
    $("region-chips").innerHTML =
        [[1, "First batch"], [2, "Second batch"]].map(([b, label]) =>
            `<button class="chip strong" data-first="${b}" aria-pressed="${Number(f.first) === b}">${label}<span class="n">${batchN(b)}</span></button>`).join("") +
        [["", "All regions"], ...REGIONS.map((r) => [r, r])].map(([k, label]) =>
            `<button class="chip" data-region="${esc(k)}" aria-pressed="${f.region === k}">${esc(label)}<span class="n">${k ? state.contacts.filter((c) => c.region === k).length : state.contacts.length}</span></button>`).join("");
    const bySeg = {}; state.contacts.forEach((c) => { bySeg[c.segment] = (bySeg[c.segment] || 0) + 1; });
    $("seg-chips").innerHTML = [["", "All segments"], ...segments().map((s) => [s.key, s.label])].map(([k, label]) =>
        `<button class="chip" data-seg="${esc(k)}" aria-pressed="${f.seg === k}">${esc(label)}<span class="n">${k ? (bySeg[k] || 0) : state.contacts.length}</span></button>`).join("");
    $("email-chips").innerHTML = [["", "Any email"], ...EMAIL_KINDS].map(([k, label]) =>
        `<button class="chip" data-emailkind="${esc(k)}" aria-pressed="${f.email === k}">${esc(label)}<span class="n">${k ? state.contacts.filter((c) => c.email_status === k).length : state.contacts.length}</span></button>`).join("");
    const ocCount = (k) => state.contacts.filter((c) => (k === "none" ? !outcomeOf(c.id) : outcomeOf(c.id) === k)).length;
    $("outcome-chips").innerHTML = [["", "Any reply"], ["interested", "Interested"], ["needs_more", "Needs more"], ["declined", "Not interested"], ["pending", "No decision yet"], ["none", "No answer"]].map(([k, label]) =>
        `<button class="chip oc" data-outcome="${k}" aria-pressed="${f.outcome === k}">${k ? `<i class="oc-${k}"></i>` : ""}${esc(label)}<span class="n">${k ? ocCount(k) : state.contacts.length}</span></button>`).join("");
    const cats = [...new Set(state.contacts.flatMap((c) => c.categories || []))].sort();
    $("f-cat").innerHTML = `<option value="">All tags</option>` + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    const countries = [...new Set(state.contacts.map((c) => c.country))].sort();
    $("f-country").innerHTML = `<option value="">All countries</option>` + countries.map((c) => `<option value="${esc(c)}">${esc(((state.lawBy[c] || {}).country_name) || c)}</option>`).join("");
    $("f-status").innerHTML = `<option value="">Any status</option><option value="needs">Needs your reply</option><option value="due">Follow-up due</option><option value="meet-next">Meeting coming up</option><option value="anyreply">Replied (any answer)</option><option value="taken">Taken by an agent</option><option value="draftwait">Draft waiting to be sent</option>` + STATUSES.map((s) => `<option value="${s.v}">${esc(s.label)}</option>`).join("");
    $("f-cat").value = f.cat; $("f-country").value = f.country; $("f-hw").value = f.hw; $("f-fit").value = f.fit; $("f-kind").value = f.kind; $("f-lang").value = f.lang; $("f-primary").value = f.primary;
    $("f-status").value = f.status; $("f-sort").value = f.sort; $("q").value = f.q;
    $("bulk-status").innerHTML = `<option value="">Set status…</option>` + STATUSES.map((s) => `<option value="${s.v}">${esc(s.label)}</option>`).join("");
}

function filtered() {
    const f = state.filters, q = f.q.trim().toLowerCase();
    const list = state.contacts.filter((c) => {
        if (f.first && c.batch !== Number(f.first)) return false;
        if (f.region && c.region !== f.region) return false;
        if (f.seg && c.segment !== f.seg) return false;
        if (f.cat && !(c.categories || []).includes(f.cat)) return false;
        if (f.email && c.email_status !== f.email) return false;
        if (f.hw && c.hardware_level !== f.hw) return false;
        if (f.fit && c.fit < Number(f.fit)) return false;
        if (f.kind && c.kind !== f.kind) return false;
        if (f.country && c.country !== f.country) return false;
        if (f.lang && c.lang !== f.lang) return false;
        if (f.primary && !c.is_primary) return false;
        if (f.outcome === "none" && outcomeOf(c.id)) return false;
        if (f.outcome && f.outcome !== "none" && outcomeOf(c.id) !== f.outcome) return false;
        if (f.status === "needs") { if (!st(c.id).needsAction) return false; }
        else if (f.status === "due") { if (!followupDue(c.id)) return false; }
        else if (f.status === "meet-next") { if (!nextMeeting(c.id)) return false; }
        else if (f.status === "anyreply") { if (!outcomeOf(c.id) && !["replied", "meeting", "declined", "optout"].includes(statusOf(c.id))) return false; }
        else if (f.status === "taken") { const k = claimOf(c.id); if (!k || k.state !== "active") return false; }
        else if (f.status === "draftwait") { const k = claimOf(c.id); if (!k || k.state !== "drafted") return false; }
        else if (f.status && statusOf(c.id) !== f.status) return false;
        if (q) {
            const hay = [c.name, c.company, c.role, c.sector, c.city, c.summary, c.hardware, c.ai_posture, c.hook, c.email, c.generic_email, ...(c.categories || []), ...(c.signals || []).map((s) => s.title + " " + s.one_liner)].join(" ").toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
    const by = {
        rank: (a, b) => (b.rank - a.rank) || a.name.localeCompare(b.name),
        name: (a, b) => a.name.localeCompare(b.name),
        company: (a, b) => a.company.localeCompare(b.company) || a.name.localeCompare(b.name),
        status: (a, b) => (STATUS_ORDER[statusOf(a.id)] - STATUS_ORDER[statusOf(b.id)]) || (b.rank - a.rank),
        reply: (a, b) => (ocRank(outcomeOf(a.id)) - ocRank(outcomeOf(b.id))) || (b.rank - a.rank),
    };
    return list.sort(by[f.sort] || by.rank);
}

function statusSelect(c) {
    const cur = statusOf(c.id);
    return `<select class="status st-${cur}" data-status-for="${esc(c.id)}" aria-label="Status for ${esc(c.name)}">` +
        STATUSES.map((s) => `<option value="${s.v}"${s.v === cur ? " selected" : ""}>${esc(s.label)}</option>`).join("") + `</select>`;
}

function replyBlock(c, s) {
    const r = s.lastReply;
    if (!r) return "";
    const link = safeMailUrl(r.messageUrl || r.threadUrl);
    const oc = outcomeOf(c.id);
    const kinds = { meeting: "proposes a meeting", positive: "positive", neutral: "replied", redirect: "points you elsewhere", declined: "declined", "auto-reply": "auto-reply" };
    return `<div class="reply${oc ? " oc-" + oc : (s.needsAction ? " st-needs" : "")}">
      <div class="label">Reply ${esc(fmtDate(r.date))}${r.from ? " from " + esc(r.from) : ""}${!oc && r.kind ? " · " + esc(kinds[r.kind] || r.kind) : ""}</div>
      <p>${esc(r.summary || "")}</p>
      <div class="row">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open in Mail</a>` : ""}${s.needsAction ? `<button class="btn small" data-handled="${esc(c.id)}">Mark handled</button>` : ""}</div>
    </div>`;
}

function emailBadge(c) {
    const v = c.verify || {};
    if (c.email_status === "published") return v.email_seen === false
        ? `<span class="conf low" title="${esc(c.email_evidence)}">published, could not re-check</span>`
        : `<span class="conf high" title="${esc(c.email_evidence)}">published</span>`;
    if (c.email_status === "pattern") return `<span class="conf low" title="${esc(c.email_evidence)}">inferred, check first</span>`;
    return "";
}
function emailRow(c) {
    const links = [
        safeUrl(c.linkedin_url) ? extLink(c.linkedin_url, "LinkedIn") : "",
        safeUrl(c.contact_form_url) ? extLink(c.contact_form_url, "Contact form") : "",
    ].filter(Boolean).join(" · ");
    if (c.email) return `<div class="row"><span class="email">${esc(c.email)}</span>${emailBadge(c)}<button class="btn small" data-copy-text="${esc(c.email)}">Copy address</button>${links ? `<span class="src">${links}</span>` : ""}</div>`;
    if (c.generic_email) return `<div class="row"><span class="email">${esc(c.generic_email)}</span><span class="conf">generic mailbox</span><button class="btn small" data-copy-text="${esc(c.generic_email)}">Copy address</button>${links ? `<span class="src">${links}</span>` : ""}</div>`;
    return `<div class="row"><span class="src">No public email found${c.channel_note ? ". " + esc(c.channel_note) : ""}</span>${links ? `<span class="src">${links}</span>` : ""}</div>`;
}
function lawBanner(c) {
    const r = state.lawBy[c.country];
    if (!r || r.level !== "consent") return "";
    return `<div class="hold"><strong>Do not cold email: ${esc(r.country_name)} needs prior consent</strong><span>${esc(r.what_to_do)}</span>${safeUrl(r.source_url) ? `<span class="src"><a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">Source</a></span>` : ""}</div>`;
}
function isHeld(c) { const r = state.lawBy[c.country]; return !!(r && r.level === "consent"); }
function lawLine(c) {
    const r = state.lawBy[c.country];
    return r ? `<div><div class="label">Law in ${esc(r.country_name)} <span class="lvl ${esc(r.level)}">${esc(r.level)}</span></div>${esc(r.rule)} ${esc(r.what_to_do)}${safeUrl(r.source_url) ? " · " + extLink(r.source_url, "source") : ""}</div>` : "";
}

function emailParts(c) {
    const p = partsFor(c);
    if (!p.hook && !p.angle) return "";
    return `<div><div class="label">What your email says</div><div class="hook">${esc(p.hook)}${p.angle ? "<br><br>" + esc(p.angle) : ""}</div></div>`;
}

// What the independent second check found, in plain words.
function checkLine(c) {
    const k = c.check; if (!k) return "";
    const role = { confirmed: "role confirmed", probably_current: "role probably current", doubtful: "role doubtful", unverifiable: "role could not be checked", left_or_wrong: "the earlier record named the wrong person or title, so this was corrected" }[k.role_status];
    const email = { confirmed: "address confirmed", changed: "address corrected", unverifiable: "address could not be checked" }[k.email_checked];
    const hw = { supported: "hardware evidence holds", overstated: "hardware evidence was overstated and corrected", unsupported: "hardware evidence did not hold and was corrected", unverifiable: "hardware evidence could not be checked" }[k.hardware_checked];
    const facts = { ok: "facts in the email hold", fixed: "facts in the email corrected", unverifiable: "facts in the email could not be checked" }[k.facts_checked];
    const parts = [role, email, hw, facts].filter(Boolean).join(", ");
    return `<div><div class="label">Second check</div>${esc(parts.charAt(0).toUpperCase() + parts.slice(1))}.${k.why ? " " + esc(k.why) : ""}</div>`;
}

function researchLine(label, text) { return text ? `<div><div class="label">${esc(label)}</div>${esc(text)}</div>` : ""; }

function takenPill(id) {
    const k = claimOf(id);
    if (!k) return "";
    if (k.state === "drafted") return `<span class="taken" title="Send it from your mailbox, then mark it as sent">Draft by ${esc(k.agent)} waiting in your mailbox</span>`;
    const stale = new Date(k.until).getTime() < Date.now();
    return stale
        ? `<span class="taken stale" title="The agent stopped before saying what happened. Check your Sent folder, then mark it as sent or set the status back.">Taken by ${esc(k.agent)}, no result: check if it went out</span>`
        : `<span class="taken">Taken by ${esc(k.agent)} until ${esc(fmtTime(k.until))}</span>`;
}

function card(c) {
    const s = st(c.id);
    const fitDots = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= c.fit ? "on" : ""}"></i>`).join("");
    const signals = (c.signals || []).map((p) => {
        const u = safeUrl(p.url);
        const t = u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>` : esc(p.title);
        return `<li>${t}${p.year ? ` <span class="src">(${esc(p.year)})</span>` : ""}<br>${esc(p.one_liner)}</li>`;
    }).join("");
    const prof = safeUrl(c.profile_url);
    const sentLine = s.sentAt ? `<span class="src">Sent ${esc(s.sentAt)}${s.sentBy && s.sentBy !== "you" ? " by " + esc(s.sentBy) : ""}${s.followups ? " · " + esc(s.followups) + " follow-up" + (s.followups > 1 ? "s" : "") : ""}</span>` : "";
    const oc = outcomeOf(c.id);
    const due = followupDue(c.id);
    const meet = nextMeeting(c.id);
    const others = (state.byCompany[c.company_id] || []).filter((x) => x.id !== c.id && !x._erased);
    const route = [CHANNEL_LABEL[c.best_channel] ? "Best route: " + CHANNEL_LABEL[c.best_channel] : "", c.channel_note].filter(Boolean).join(". ");
    const verify = c.verify || {};
    const sources = [
        safeUrl(c.role_source_url) ? extLink(c.role_source_url, "role source") : "",
        safeUrl(c.email_source_url) ? extLink(c.email_source_url, "email source") : "",
    ].filter(Boolean).join(" · ");
    const picked = state.selected.has(c.id);
    const canEmail = !!(c.email || c.generic_email);
    return `<article class="card${oc ? " oc-" + oc : ""}${statusOf(c.id) === "skip" ? " is-done" : ""}${isHeld(c) ? " is-hold" : ""}${picked ? " is-picked" : ""}" data-id="${esc(c.id)}">
      <div class="plate">
        ${c.batch ? `<span class="batch${c.batch === 2 ? " second" : ""}" title="${c.batch === 1 ? "In the first batch of emails" : "In the second batch of emails"}">${c.batch === 1 ? "first batch" : "second batch"}</span>` : ""}
        <span class="where">${esc(c.country)}${c.city ? " · " + esc(c.city) : ""}${c.sector ? " · " + esc(c.sector) : ""}</span>
        <span class="co">${extLink(c.company_url, c.company)}</span>
        <span class="led ${esc(c.hardware_level)}" title="${esc(c.hardware)}"><i></i>${esc(HW_LABEL[c.hardware_level] || "")}</span>
      </div>
      <div class="body">
        <label class="pick"><input type="checkbox" data-select="${esc(c.id)}"${picked ? " checked" : ""}> Select</label>
        ${oc ? `<div class="outcome oc-${oc}">${esc(OUTCOMES[oc].label)}</div>` : ""}
        ${meet ? `<div class="meet-pill">Meeting ${esc(fmtWhen(meet.t))}${meet.platform ? " · " + esc(meet.platform) : ""}</div>` : ""}
        ${lawBanner(c)}
        ${roleInDoubt(c) ? `<div class="hold info"><strong>Check the role first</strong><span>The sources for this role are old or unclear. Confirm the person is still there.</span></div>` : ""}
        <div class="who">
          <h3>${prof ? `<a href="${esc(prof)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${esc(c.name)}</a>` : esc(c.name)}</h3>
          <div class="meta">${esc(c.role)}</div>
        </div>
        <p class="summary">${esc(c.summary)}</p>
        <div class="tags">${(c.categories || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <div class="row">
          <span class="fit" title="${esc(c.fit_reason)}">${fitDots}<span>fit</span></span>
          ${statusSelect(c)}
          <span class="lang-tag">Write in ${esc(LANG_LABEL[c.lang] || c.lang)}</span>
          ${c.kind && c.kind !== "client" ? `<span class="tag kind">${esc(KIND_LABEL[c.kind])}</span>` : ""}
          ${s.needsAction ? `<span class="needs">Needs your reply</span>` : ""}
          ${due ? `<span class="due">Follow-up due</span>` : ""}
          ${sentLine}
          ${takenPill(c.id)}
        </div>
        ${replyBlock(c, s)}
        ${emailRow(c)}
        <div class="row">
          <button class="btn${isHeld(c) ? "" : " primary"}" data-compose="${esc(c.id)}">${due ? "Write the follow-up" : "Compose email"}</button>
          ${canEmail ? `<button class="btn small" data-copy-email="${esc(c.id)}" title="The next email to this person: To, subject and text">Copy email</button>` : ""}
          <button class="btn small" data-copy-all="${esc(c.id)}" title="Everything on this person, as text">Copy all info</button>
        </div>
        <details class="more">
          <summary>The research, your email and notes</summary>
          <div class="more-in">
            ${c.rubric ? `<div><div class="label">Fit ${esc(c.fit)} of 5, from one rubric for everyone</div><div class="rubric">${RUBRIC.map(([k, label]) => `<span>${esc(label)}</span><span class="pips" aria-label="${c.rubric[k]} of 2"><i class="${c.rubric[k] > 0 ? "on" : ""}"></i><i class="${c.rubric[k] > 1 ? "on" : ""}"></i></span>`).join("")}</div></div>` : ""}
            ${researchLine("Why this fits", c.fit_reason)}
            ${researchLine("Size", c.size)}
            ${researchLine("Hardware (" + (c.hardware_level || "") + ")", c.hardware)}
            ${researchLine("Why it may sit idle", c.idle_reason)}
            ${researchLine("Why not a cloud LLM", c.no_cloud_reason)}
            ${researchLine("Team and skills", c.skills_gap)}
            ${researchLine("What they do with AI today", c.ai_posture)}
            ${signals ? `<div><div class="label">Sources and signals</div><ul class="projects">${signals}</ul></div>` : ""}
            ${emailParts(c)}
            ${researchLine("Likely pushback", c.objection)}
            ${researchLine("How to reach them", route)}
            ${c.warm_path ? `<div><div class="label">Warm path</div>${esc(c.warm_path)}${safeUrl(c.warm_path_url) ? " · " + extLink(c.warm_path_url, "source") : ""}</div>` : ""}
            ${c.switchboard ? `<div><div class="label">Switchboard</div><span class="email">${esc(c.switchboard)}</span></div>` : ""}
            ${c.generic_email && c.email ? `<div><div class="label">Generic mailbox</div><span class="email">${esc(c.generic_email)}</span></div>` : ""}
            ${c.email_evidence ? `<div><div class="label">Where the address comes from</div>${esc(c.email_evidence)}${verify.email_seen === true ? " Re-checked on the source page in November 2026." : ""}${verify.email_seen === false ? " The address did not show up when a script re-read the page, so look at it yourself." : ""}${verify.mx === false ? " The domain has no mail server on record." : ""}</div>` : ""}
            ${lawLine(c)}
            ${others.length ? `<div><div class="label">Also at ${esc(c.company)}</div>${others.map((x) => `<button class="btn small" data-goto="${esc(x.id)}">${esc(x.name)}, ${esc(x.role)}</button>`).join(" ")}</div>` : ""}
            ${researchLine("Before you write", c.notes)}
            ${checkLine(c)}
            <div><div class="label">If they replied</div>
              <div class="row">
                <select class="field" data-outcome-for="${esc(c.id)}" aria-label="Reply outcome for ${esc(c.name)}">
                  <option value="">Not set</option>
                  ${Object.entries(OUTCOMES).map(([k, o]) => `<option value="${k}"${oc === k ? " selected" : ""}>${esc(o.short)}</option>`).join("")}
                </select>
                <input type="datetime-local" class="field" data-meeting-for="${esc(c.id)}" aria-label="Meeting time for ${esc(c.name)}" value="${esc(localInput(s.meeting && s.meeting.when))}">
              </div>
            </div>
            <div><div class="label">Your notes</div><textarea class="field notes" data-notes-for="${esc(c.id)}" aria-label="Notes for ${esc(c.name)}">${esc(s.notes || "")}</textarea></div>
            <div class="row"><button class="btn small" data-erase="${esc(c.id)}" title="When the person asks you to delete their data">Erase this person</button><span class="src">At their request: removes them from the page and the agents for good.</span></div>
            <div class="src">${sources}${verify.checked ? (sources ? " · " : "") + "checked " + esc(fmtDate(verify.checked)) : ""}${state.docMeta[c.id] && state.docMeta[c.id].by && state.docMeta[c.id].by !== "you" ? " · last change by " + esc(state.docMeta[c.id].by) : ""}</div>
          </div>
        </details>
      </div>
    </article>`;
}
function localInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderReplies() {
    const el = $("replies-panel");
    const meetings = state.contacts.map((c) => ({ c, m: nextMeeting(c.id) })).filter((x) => x.m).sort((a, b) => a.m.t - b.m.t);
    const waiting = state.contacts.filter((c) => st(c.id).needsAction)
        .sort((a, b) => String((st(b.id).lastReply || {}).date || "").localeCompare(String((st(a.id).lastReply || {}).date || "")));
    const dueList = state.contacts.map((c) => ({ c, d: followupDue(c.id) })).filter((x) => x.d).sort((a, b) => b.d.late - a.d.late);
    if (!meetings.length && !waiting.length && !dueList.length) { el.hidden = true; return; }
    el.hidden = false;
    const soon = Date.now() + 36 * 3600 * 1000;
    const meetHtml = meetings.length ? `<ul>${meetings.map(({ c, m }) => `<li class="${m.t.getTime() < soon ? "soon" : ""}"><span class="when">${esc(fmtWhen(m.t))}</span><span class="what"><button data-goto="${esc(c.id)}">${esc(c.name)}</button> · ${esc(c.company)}${m.platform ? " · " + esc(m.platform) : ""}</span>${m.note ? `<p>${esc(m.note)}</p>` : ""}</li>`).join("")}</ul>` : `<p class="empty-line">No meeting fixed yet.</p>`;
    const waitHtml = waiting.length ? `<ul>${waiting.map((c) => { const r = st(c.id).lastReply || {}; const oc = outcomeOf(c.id);
        return `<li><span class="dot ${oc ? "oc-" + oc : ""}"></span><span class="what"><button data-goto="${esc(c.id)}">${esc(c.name)}</button> · ${esc(c.company)}${r.date ? " · " + esc(fmtDate(r.date)) : ""}</span><p>${esc(r.summary || "")}</p></li>`; }).join("")}</ul>` : `<p class="empty-line">You have answered everyone.</p>`;
    const dueHtml = dueList.length ? `<ul>${dueList.map(({ c, d }) => `<li class="${d.late > 2 ? "late" : "soon"}"><span class="when">${d.late ? d.late + "d late" : "today"}</span><span class="what"><button data-goto="${esc(c.id)}">${esc(c.name)}</button> · ${esc(c.company)}</span><p>${esc((state.messages.emails[d.key] || {}).label || "Follow-up")}</p></li>`).join("")}</ul>` : `<p class="empty-line">No follow-up is due.</p>`;
    el.innerHTML = `<article class="panel"><h2>Follow-ups due <span class="n">${dueList.length}</span></h2>${dueHtml}</article>
      <article class="panel"><h2>Upcoming meetings <span class="n">${meetings.length}</span></h2>${meetHtml}</article>
      <article class="panel"><h2>Needs your reply <span class="n">${waiting.length}</span></h2>${waitHtml}</article>`;
}

function renderGrid() {
    const list = filtered();
    $("result-line").textContent = list.length === state.contacts.length ? `${list.length} people` : `${list.length} of ${state.contacts.length} people`;
    $("grid").innerHTML = list.length ? list.map(card).join("") : `<div class="empty">${state.contacts.length ? "No one matches these filters." : "No contacts loaded."}</div>`;
    renderReplies();
    renderBulkBar();
}

function renderBulkBar() {
    const n = selectedContacts().length;
    const hidden = state.selected.size - n;
    $("bulkbar").hidden = state.selected.size === 0;
    document.body.classList.toggle("has-bulk", state.selected.size > 0);
    $("bulk-n").textContent = `${n} selected` + (hidden > 0 ? ` (${hidden} more hidden by the filters, left out)` : "");
}

/* ---------- message versions ---------- */
function highlightTokens(text) {
    return esc(text).replace(/(\{\{[a-z_]+\}\}|\[[a-zA-Z][a-zA-Z ,']+\])/g, '<span class="ph-token">$1</span>');
}
function renderMessages() {
    const m = state.messages; if (!m) return;
    const s = sender();
    $("msg-intro").textContent = m.guide || "";
    const langChips = ["en", "fr", "it"].map((l) => `<button class="chip" data-msglang="${l}" aria-pressed="${state.msgLang === l}">${LANG_LABEL[l]}</button>`).join("");
    const emails = FOLLOWUP_ORDER.filter((k) => m.emails[k]).map((k) => {
        const e = m.emails[k];
        const body = e[state.msgLang] || e.en;
        return `<article class="panel">
        <h2>${esc(e.label)}</h2>
        <p class="for">${esc(e.when || "")}</p>
        ${k === "first" ? `<p class="msg-subject">Subject: written per person, for example “${esc(((state.contacts.find((c) => c.lang === state.msgLang) || state.contacts[0]) || {}).subject || "")}”</p>` : `<p class="msg-subject">Subject: Re: the first email's subject</p>`}
        <p class="msg-body">${highlightTokens(body)}</p>
        <div class="row" style="margin-top:12px"><button class="btn small" data-copy-text="${esc(body)}">Copy template</button></div>
      </article>`;
    }).join("");
    $("msg-list").innerHTML = `
      <article class="panel">
        <h2>Your details</h2>
        <p class="for">These fill in every email, for you and for agents. Fill them in before sending anything: the law research asks for your company's legal name, a postal address and a privacy notice in each one. Agents are given no email until they are complete.</p>
        <div class="settings">
          <label>Startup name <input id="s-startup" class="field" value="${esc(s.startup || "")}" placeholder="[startup name]"></label>
          <label>Signature: your name and role, the company's legal name, its postal address, your website <textarea id="s-signature" class="field" rows="4">${esc(s.signature || "")}</textarea></label>
          <label>Link to your privacy notice <input id="s-privacy" class="field" value="${esc(s.privacy || "")}" placeholder="https://…"></label>
          <label class="check"><input id="s-credential" type="checkbox"${s.use_credential !== false ? " checked" : ""}><span>Mention SwissGPU in the first email: “${esc((m.credential || {})[state.msgLang] || (m.credential || {}).en || "")}” Hosts and integrators always get this line, because some will see SwissGPU as a competitor.</span></label>
          <label class="check"><input id="s-check" type="checkbox"${s.use_check_offer !== false ? " checked" : ""}><span>Offer a free hardware check to possible clients: “${esc((m.check_offer || {})[state.msgLang] || (m.check_offer || {}).en || "")}” This is a promise, so untick it until you can deliver it.</span></label>
        </div>
      </article>
      <article class="panel">
        <h2>Language</h2>
        <p class="for">Each contact already has a language. French for Romandie and France, Italian for Ticino and Italy, English elsewhere. Switch here to read the three versions.</p>
        <div class="chips">${langChips}</div>
      </article>
      ${emails}`;
}

/* ---------- playbook ---------- */
function srcLink(u, label) {
    const s = safeUrl(u);
    if (s) return `<a class="src" href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(label || "Source")}</a>`;
    return u ? `<span class="src">${esc(u)}</span>` : "";
}
const factList = (arr) => `<ul class="facts">${(arr || []).map((f) => `<li><div><strong>${esc(f.topic)}</strong> <span class="conf ${esc(f.confidence)}">${esc(f.confidence)} confidence</span></div><div>${esc(f.finding)}</div>${srcLink(f.source_url)}</li>`).join("")}</ul>`;
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<)]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const plainList = (arr) => `<ul class="plain">${(arr || []).map((t) => `<li>${linkify(t)}</li>`).join("")}</ul>`;
const orderedList = (arr) => `<ol class="timeline">${(arr || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ol>`;
const panel = (title, inner, opts = {}) => `<article class="panel${opts.wide ? " wide" : ""}"><h2>${esc(title)}</h2>${opts.for ? `<p class="for">${esc(opts.for)}</p>` : ""}${inner}</article>`;
function tableOf(cols, rows, narrow = []) {
    const cls = (i) => (narrow.includes(i) ? ' class="narrow"' : "");
    return `<div class="table-wrap"><table><thead><tr>${cols.map((c, i) => `<th${cls(i)}>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => `<td${cls(i)}>${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderPlaybook() {
    const P = state.playbook;
    $("play-switch").innerHTML = PLAY_VIEWS.map(([k, label]) => `<button class="chip strong" data-play="${k}" aria-pressed="${state.playView === k}">${esc(label)}</button>`).join("");
    if (!P) { $("play").innerHTML = `<div class="empty">The playbook is not loaded.</div>`; return; }
    const L = P.law || {}, E = P.email || {}, M = P.market || {}, C = P.channels || {};
    const views = {
        plan() {
            return panel("Where to start", plainList(P.start_here), { wide: true }) +
                panel("Plan from now", orderedList(C.timeline)) +
                panel("Before the first email", orderedList(E.setup_checklist)) +
                panel("Every email must have", plainList(L.checklist), { for: L.disclaimer }) +
                panel("How this list was checked", plainList(P.method));
        },
        segments() {
            return segments().map((s) => {
                const n = state.contacts.filter((c) => c.segment === s.key).length;
                const line = (k, v) => (v ? `<div><strong>${esc(k)}.</strong> ${esc(v)}</div>` : "");
                const meet = (s.where_to_meet || []).map((w) => extLink(w.url, w.name)).join(" · ");
                return `<article class="panel"><h2>${esc(s.label)}</h2><p class="for">${esc(s.verdict || "")}</p>
            <div class="seg-facts">${line("They own", s.owns)}${line("Idle because", s.idle)}${line("Not the cloud because", s.no_cloud)}${line("Who decides", s.buyers)}${line("How they buy", s.budget)}${line("Pitch", s.angle)}${line("Risks", s.risks)}${meet ? `<div><strong>Where to meet them.</strong> ${meet}</div>` : ""}</div>
            <div class="row" style="margin-top:12px"><button class="btn small" data-show-seg="${esc(s.key)}">See the ${n} contacts</button></div></article>`;
            }).join("");
        },
        routes() {
            const ranked = [...(C.channels || [])].sort((a, b) => (a.rank || 99) - (b.rank || 99));
            return panel("Routes, best return on your hours first", tableOf(["#", "Route", "When", "How", "Cost and hours", "Watch out"], ranked.map((c) => [esc(c.rank), safeUrl(c.source_url) ? extLink(c.source_url, c.name) : esc(c.name), esc(c.when), esc(c.how), esc([c.cost, c.hours].filter(Boolean).join(" · ")), esc(c.watch_out)]), [0]), { wide: true, for: "The ranking is judgement based on the research, not measured data." }) +
                panel("Warm routes", tableOf(["Who", "What they do", "What to ask", "Deadline"], (C.warm_routes || []).map((w) => [extLink(w.url, w.name), esc(w.what), esc(w.ask), esc(w.deadline || "")])), { wide: true }) +
                panel("Associations and chambers", tableOf(["Name", "What", "Cost", "Use"], (C.associations || []).map((a) => [extLink(a.url, a.name), esc(a.what), esc(a.cost), esc(a.use)])), { wide: true }) +
                panel("Public tenders", factList(C.tenders)) +
                panel("LinkedIn", factList(E.linkedin));
        },
        law() {
            const order = { ok: 0, caution: 1, consent: 2 };
            const rules = [...(L.rules || [])].sort((a, b) => order[a.level] - order[b.level]);
            return panel("Can you cold email there?", tableOf(["Country", "Level", "Rule", "What to do", "Source"], rules.map((r) => [esc(r.country_name), `<span class="lvl ${esc(r.level)}">${esc(r.level)}</span>`, esc(r.rule), esc(r.what_to_do), `${srcLink(r.source_url, r.source_title || "Source")} <span class="conf ${esc(r.confidence)}">${esc(r.confidence)}</span>`])), { wide: true, for: L.disclaimer }) +
                panel("Across all countries", factList(L.general)) +
                panel("Every email must have", plainList(L.checklist));
        },
        email() {
            return panel("Setup, in order", orderedList(E.setup_checklist)) +
                panel("Follow-up plan", orderedList(E.cadence)) +
                panel("Finding and checking addresses", factList(E.finding)) +
                panel("Getting into the inbox", factList(E.deliverability)) +
                panel("Tools", tableOf(["Tool", "What", "Price", "GDPR", "Verdict"], (E.tools || []).map((t) => [extLink(t.url, t.name), esc(t.what), esc(t.price), esc(t.gdpr_note), esc(t.verdict)])), { wide: true }) +
                panel("Writing the email", factList(E.writing)) +
                panel("What reply rates to expect", factList(E.benchmarks));
        },
        market() {
            return panel("Is anyone already doing this?", `<p>${esc(M.closest || "")}</p>`, { wide: true }) +
                panel("Who prospects will compare you with", tableOf(["Name", "What", "For", "Price", "What it leaves open"], (M.competitors || []).map((c) => [extLink(c.url, c.name), esc(c.what), esc(c.who_for), esc(c.price), esc(c.gap)])), { wide: true }) +
                panel("Answers to pushback", `<ul class="facts">${(M.objections || []).map((o) => `<li><strong>${esc(o.objection)}</strong><div>${esc(o.answer)}</div>${srcLink(o.source_url)}</li>`).join("")}</ul>`) +
                panel("Numbers you can use", factList(M.stats)) +
                panel("What hardware can run", tableOf(["Hardware", "Can run", "Speed", "Evidence"], (M.hardware || []).map((h) => [esc(h.hardware), esc(h.can_run), esc(h.speed), `<span class="conf ${h.measured ? "high" : "low"}">${h.measured ? "measured" : "estimate"}</span> ${srcLink(h.source_url)}`])), { wide: true }) +
                panel("Questions for the first call", orderedList(M.qualification)) +
                panel("When a server is a poor fit", plainList(M.poor_fit)) +
                panel("Pricing anchors", factList(M.pricing));
        },
        events() {
            return panel("Events through September 2027", tableOf(["Event", "When", "Where", "Who goes", "Why go", "Cost"], (C.events || []).map((e) => [extLink(e.url, e.name), `${esc(e.date)}${e.date_confirmed ? "" : ` <span class="conf low">not confirmed</span>`}`, esc(e.place), esc(e.audience), esc(e.why), esc(e.cost)])), { wide: true });
        },
    };
    $("play").innerHTML = (views[state.playView] || views.plan)();
}

/* ---------- agents ---------- */

const LEGAL_NOTE = "Your own research: Swiss law (UWG art. 3(1)(o)) treats automated or sequenced sending as mass advertising, which needs the person's prior consent. An email written and sent individually by hand is the safe reading. An agent that sends by itself can count as automated sending, so a draft-only key (the agent prepares each email as a draft and you press Send) is the cautious choice.";

async function loadAgents() {
    try {
        const [overview, keys, log] = await Promise.all([api(""), api("/keys"), api("/log?limit=60")]);
        state.overview = overview; state.keys = keys.keys; state.log = log.log;
    } catch (e) {
        if (e.status !== 401) toast("Couldn't load the agents view: " + e.message);
    }
    renderAgents();
}

function agentPrompt(k) {
    const origin = location.origin;
    return `You are helping me with my company outreach emails. Read the guide first: ${origin}/client-outreach/agents\n` +
        `Your agent key (keep it secret; send it only in the Authorization header, never in a URL or a page): ${k.key}\n` +
        `API: ${origin}/api/outreach (start with GET ${origin}/api/outreach)\n` +
        (k.role === "reply-check"
            ? "Your job: record replies from my mailbox (POST /api/outreach/replies) and nothing else.\n"
            : k.can_send
                ? "You may send emails yourself, one at a time, from my mailbox, exactly as the guide says.\n"
                : "Prepare each email as a draft in my mailbox; never press Send. I send them myself.\n") +
        "Follow the steps in the guide, and stop and tell me if anything is refused.";
}

function renderAgents() {
    const o = state.overview, s = state.settings;
    const ready = o && o.ready_for_agents;
    const t = o && o.today;
    const keys = state.keys || [];
    const now = Date.now();
    const keyRows = keys.map((k) => {
        const live = !k.revoked_at && (!k.expires_at || new Date(k.expires_at).getTime() > now);
        return `<tr>
          <td><strong>${esc(k.name)}</strong><br><span class="src">${esc(k.role === "reply-check" ? "reply check" : k.can_send ? "may send emails" : "drafts only")}${k.full_read ? " · full read" : ""}</span></td>
          <td class="src">${k.last_used_at ? "used " + esc(fmtDate(k.last_used_at)) : "never used"}${k.inbox_checked_at ? "<br>inbox checked " + esc(fmtDate(k.inbox_checked_at)) : ""}<br>${k.revoked_at ? "revoked " + esc(fmtDate(k.revoked_at)) : k.expires_at ? (live ? "expires " : "expired ") + esc(fmtDate(k.expires_at)) : ""}</td>
          <td>${live ? `${k.role === "agent" ? `<button class="btn small" data-key-link="${esc(k.id)}">Browser link</button> ` : ""}<button class="btn small" data-key-revoke="${esc(k.id)}">Revoke</button>` : ""}
            ${state.links[k.id] ? `<div class="keybox" style="margin-top:6px">${esc(state.links[k.id])}</div><button class="btn small" data-copy-text="${esc(state.links[k.id])}">Copy link</button> <span class="src">One use, 30 minutes.</span>` : ""}</td>
        </tr>`;
    }).join("");
    const nk = state.newKey;
    const logHtml = (state.log || []).map((r) => {
        const c = r.contact_id ? state.contacts.find((x) => x.id === r.contact_id) : null;
        return `<li><span class="src">${esc(fmtDate(r.at))} ${esc(fmtTime(r.at))}</span> · <strong>${esc(r.actor)}</strong> · ${esc(r.action.replace(/_/g, " "))}${c ? ` · <button class="btn small" data-goto="${esc(c.id)}">${esc(c.name)}</button>` : ""}${r.detail && r.detail.which ? " · " + esc(r.detail.which) : ""}${r.detail && r.detail.n ? " · " + esc(r.detail.n) : ""}</li>`;
    }).join("");
    $("agents").innerHTML = `
      <article class="panel wide">
        <h2>Can agents work now?</h2>
        ${!o ? `<p class="for">Loading…</p>` : ready.ready ? `<p class="ready-yes">Yes. Agents can take people now.</p>` : `<p class="ready-no">Not yet. Agents can read everything, but they are given no email until this is done:</p><ul class="missing">${ready.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`}
        ${t ? `<p class="for">Today (${esc(t.day)}): ${t.sent_today} sent, ${t.taken_today} taken or drafted by agents and not finished, ${t.remaining} left of the daily limit of ${t.limit}. Your own sends count too.</p>` : ""}
        ${(state.dataMeta && state.dataMeta.pending_erase) || (o && o.data && o.data.erased_waiting_for_upload) ? `<p class="ready-no">${esc((state.dataMeta && state.dataMeta.pending_erase) || o.data.erased_waiting_for_upload)} erased ${((state.dataMeta && state.dataMeta.pending_erase) || o.data.erased_waiting_for_upload) === 1 ? "person is" : "people are"} still in the stored research file. Run the data upload again to remove them (agents cannot download the file until then).</p>` : ""}
        <label class="check" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ag-paused"${s.agents_paused ? " checked" : ""}> Pause all agents (they can still read, but take nobody)</label>
        <p class="for"><a href="/client-outreach/agents" target="_blank" rel="noopener">The guide agents follow</a> · <button class="btn small" id="ag-refresh">Refresh</button></p>
      </article>
      <article class="panel">
        <h2>Sending setup</h2>
        <div class="form-grid">
          <label>Mailbox the emails go out from <input id="ag-from" class="field" value="${esc(s.from_address || "")}" placeholder="you@your-company.ch"></label>
          <label class="check"><input type="checkbox" id="ag-mailready"${s.mail_ready ? " checked" : ""}><span>The sending setup is done: the company's own domain is at least 32 days old, SPF, DKIM and DMARC pass, open and click tracking is off, and the mailbox above is on that domain.</span></label>
          <label>Emails per day, yours and agents' together (0 to 30) <input id="ag-limit" class="field" type="number" min="0" max="30" value="${esc(s.daily_limit ?? 5)}"></label>
          <p class="src">Your research: week 1 at 3 to 5 cold emails a day, week 2 up to 10, later 15 to 20, never more than 30.</p>
          <label>Your time zone <input id="ag-tz" class="field" value="${esc(s.timezone || DEFAULT_TIMEZONE)}"></label>
        </div>
      </article>
      <article class="panel">
        <h2>New agent key</h2>
        <form id="ag-new" class="form-grid">
          <label>Name of the agent <input name="name" class="field" required maxlength="60" placeholder="e.g. Claude in Chrome"></label>
          <label>What it does <select name="role" class="field"><option value="agent">Writes emails (drafts, or sends if allowed below)</option><option value="reply-check">Reply check: records replies only</option></select></label>
          <label class="check"><input type="checkbox" name="full_read" checked><span>May download the whole list at once</span></label>
          <label class="check"><input type="checkbox" name="can_send" id="ag-cansend"><span>May send emails by itself (otherwise it only prepares drafts)</span></label>
          <p class="legal" id="ag-legal" hidden>${esc(LEGAL_NOTE)}</p>
          <label class="check" id="ag-ack-wrap" hidden><input type="checkbox" name="acknowledged"><span>I have read this and want this agent to send by itself.</span></label>
          <label>Valid for (days) <input name="expires_days" class="field" type="number" min="1" max="365" value="30"></label>
          <button class="btn primary" type="submit">Create the key</button>
        </form>
        ${nk ? `<div style="margin-top:12px"><p class="for"><strong>Key for ${esc(nk.name)}</strong>. Shown once: copy it now.</p><div class="keybox">${esc(nk.key)}</div>
          <div class="row" style="margin-top:8px"><button class="btn small" data-copy-text="${esc(nk.key)}">Copy key</button><button class="btn small primary" data-copy-text="${esc(agentPrompt(nk))}">Copy instructions for the agent</button><button class="btn small" id="ag-hide">Done</button></div></div>` : ""}
      </article>
      <article class="panel wide">
        <h2>Keys</h2>
        ${keys.length ? `<div class="table-wrap"><table class="keylist"><tbody>${keyRows}</tbody></table></div>` : `<p class="for">No keys yet.</p>`}
        <p class="for">Give each agent its own key, so you can see what it did and revoke it alone. An agent in a browser gets a one-time link instead of the key.</p>
        <button class="btn small" id="ag-signout-all">Sign out every browser session</button>
      </article>
      <article class="panel wide">
        <h2>Activity</h2>
        ${logHtml ? `<ul class="loglist">${logHtml}</ul>` : `<p class="for">Nothing yet.</p>`}
      </article>`;
}

/* ---------- composer ---------- */
function composerWarnings(c) {
    const others = (state.byCompany[c.company_id] || []).filter((x) => x.id !== c.id);
    return checksFor(c, { st: st(c.id), colleagues: others.map((x) => ({ c: x, st: st(x.id) })), law: state.lawBy[c.country] || null, sender: sender() })
        .map((k) => ({ stop: k.level === "stop", text: k.text }));
}
function refreshBody() {
    const c = state.contacts.find((x) => x.id === state.composerId); if (!c) return;
    $("c-body").value = composeBody(c, state.currentParts, $("c-which").value, $("c-lang").value);
    countWords();
}
// Words above the sign-off, since that is what the research on length is about.
function countWords() {
    const top = $("c-body").value.split(/\n(?:Best regards|Meilleures salutations|Cordiali saluti),?\n/)[0].trim();
    const n = top ? top.split(/\s+/).length : 0;
    const which = $("c-which").value;
    const c = state.contacts.find((x) => x.id === state.composerId);
    const mixed = which === "first" && c && $("c-lang").value !== c.lang ? ` The opening and the line about them are in ${LANG_LABEL[c.lang] || c.lang}, so rewrite them in the language you chose.` : "";
    $("c-count").textContent = (which === "first" ? `${n} words above the signature. Aim for 50 to 125.` : `${n} words above the signature.`) + mixed;
    $("c-count").className = "src" + (which === "first" && n > 150 ? " over" : "");
}
function updateSentButton() {
    const id = state.composerId;
    $("c-sent").disabled = !state.statusLoaded || (!!id && isClosed(id));
}
function loadComposer(id) {
    const c = state.contacts.find((x) => x.id === id); if (!c) return;
    flushParts();
    state.composerId = id;
    state.currentParts = partsFor(c);
    $("c-contact").value = id;
    $("c-to").value = c.email || c.generic_email || "";
    const m = state.messages;
    $("c-which").innerHTML = FOLLOWUP_ORDER.filter((k) => m.emails[k]).map((k) => `<option value="${k}">${esc(m.emails[k].label)}</option>`).join("");
    $("c-which").value = nextEmail(id);
    // A thread stays in the language it started in.
    const sentLang = ["sent", "followup"].includes(statusOf(id)) && st(id).lang;
    $("c-lang").value = sentLang || c.lang || "en";
    $("c-subject").value = subjectFor(c, $("c-which").value);
    $("c-hook").value = state.currentParts.hook;
    $("c-angle").value = state.currentParts.angle;
    $("c-parts").hidden = $("c-which").value !== "first";
    refreshBody();
    const warn = composerWarnings(c);
    const box = $("c-warn");
    box.hidden = !warn.length;
    box.className = "warnbox" + (warn.some((w) => w.stop) ? " stop" : "");
    box.textContent = warn.map((w) => w.text).join(" ");
    $("c-hint").textContent = c.notes ? "Before you write: " + c.notes : "";
    updateSentButton();
}
function openComposer(id) {
    if (!state.messages) return;
    $("c-contact").innerHTML = [...state.contacts].sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.company)}</option>`).join("");
    loadComposer(id);
    $("scrim").hidden = false; $("drawer").hidden = false;
    $("drawer-close").focus();
}
let saveTimer = null, pendingSave = null;
function flushParts() {
    clearTimeout(saveTimer);
    const p = pendingSave; pendingSave = null;
    if (!p || !p.id) return Promise.resolve();
    return write([p.id], () => api("/contacts/" + encodeURIComponent(p.id), { method: "PATCH", body: { custom: p.parts } })).catch(() => toast("Couldn't save your edit. Try again"));
}
function cancelParts() { clearTimeout(saveTimer); pendingSave = null; }
function partsChanged() {
    const parts = { hook: $("c-hook").value.trim(), angle: $("c-angle").value.trim() };
    state.currentParts = parts;
    refreshBody();
    clearTimeout(saveTimer);
    pendingSave = { id: state.composerId, parts };
    saveTimer = setTimeout(flushParts, 900);
}
function closeComposer() { flushParts(); $("scrim").hidden = true; $("drawer").hidden = true; state.composerId = null; }

/** Why this person must not get an email now (a stop-level check), or "" when they may. */
function stopReason(c) {
    const stop = composerWarnings(c).find((w) => w.stop);
    return stop ? stop.text : "";
}
/** The next email to a person as plain text, ready to paste. */
function emailText(c) {
    const which = nextEmail(c.id);
    const lang = (["sent", "followup"].includes(statusOf(c.id)) && st(c.id).lang) || c.lang || "en";
    const to = addressOf(c).to;
    return `To: ${to}\nSubject: ${subjectFor(c, which)}\n\n${composeBody(c, partsFor(c), which, lang)}`;
}
function allInfoText(c) {
    const s = st(c.id);
    const line = (k, v) => (v ? `${k}: ${v}\n` : "");
    return line("Name", c.name) + line("Role", c.role) + line("Company", c.company) + line("Where", [c.city, c.country].filter(Boolean).join(", ")) +
        line("Address", c.email || c.generic_email) + line("Address kind", c.email_status) + line("Where the address comes from", c.email_evidence) +
        line("LinkedIn", c.linkedin_url) + line("Switchboard", c.switchboard) + line("Status", statusOf(c.id)) + line("Sent", s.sentAt) +
        line("Summary", c.summary) + line("Why this fits", c.fit_reason) + line("Hardware", c.hardware) + line("Why it may sit idle", c.idle_reason) +
        line("Why not a cloud LLM", c.no_cloud_reason) + line("Team and skills", c.skills_gap) + line("AI today", c.ai_posture) + line("Likely pushback", c.objection) +
        line("How to reach them", c.channel_note) + line("Warm path", c.warm_path) + line("Before you write", c.notes) + line("Your notes", s.notes) +
        "\n--- The next email ---\n" + emailText(c) + "\n";
}

/* ---------- writes ---------- */

async function setStatuses(ids, value, override = false) {
    try {
        const r = await write(ids, () => api("/status", { method: "POST", body: { ids, status: value, override } }));
        r.recorded = (r.results || []).filter((x) => x.result === "recorded").length;
        const refused = (r.results || []).filter((x) => x.result === "refused");
        if (refused.length && !override && refused.some((x) => x.needs_override)) {
            const names = refused.map((x) => (state.contacts.find((c) => c.id === x.id) || {}).name || x.id).join(", ");
            if (confirm(`${names} asked to stop, said no or bounced. Change their status anyway?`)) {
                const again = await setStatuses(refused.map((x) => x.id), value, true);
                if (again) r.recorded += again.recorded;
            }
        }
        return r;
    } catch (e) {
        toast("Couldn't save: " + e.message);
        return null;
    } finally {
        redraw();
    }
}

async function markSent(items, done) {
    try {
        const r = await write(items.map((x) => x.id), () => api("/sent", { method: "POST", body: { items } }));
        const res = r.results || [];
        const n = (k) => res.filter((x) => x.result === k).length;
        const parts = [`${n("recorded")} marked as sent`];
        if (n("already_recorded")) parts.push(`${n("already_recorded")} already recorded`);
        if (n("refused")) parts.push(`${n("refused")} not changed (asked to stop, said no or bounced)`);
        toast(parts.join(", "));
        if (done) done(r);
        return r;
    } catch (e) {
        toast("Couldn't mark as sent: " + e.message);
        return null;
    } finally {
        redraw();
    }
}

function patchContact(id, body, after) {
    return write([id], () => api("/contacts/" + encodeURIComponent(id), { method: "PATCH", body }))
        .then((r) => { if (after) after(r); return r; })
        .catch((e) => { toast("Couldn't save: " + e.message); return null; });
}

let settingsTimer = null, settingsPatch = {};
function saveSettings(patch) {
    Object.assign(state.settings, patch);
    Object.assign(settingsPatch, patch);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
        const body = settingsPatch; settingsPatch = {};
        try {
            const r = await api("/meta/settings", { method: "PUT", body });
            state.settings = r.settings;
            if (state.overview) { state.overview.ready_for_agents = r.ready_for_agents; if (state.view === "agents") renderAgents(); }
            toast("Saved");
        } catch (e) {
            toast("Not saved: " + e.message);
            // Show what is really stored again, instead of the value the server refused.
            state.needFull = true;
            await refreshState(true);
            renderMessages(); if (state.view === "agents") renderAgents();
        }
    }, 400);
}

/* ---------- redraws that never swallow what you are typing ---------- */
let renderPending = false, pointerDown = false;
function redraw() { renderPending = false; renderCounters(); renderFilterControls(); renderGrid(); }
function renderWhenIdle() {
    const a = document.activeElement;
    if (pointerDown || (a && /^(TEXTAREA|SELECT|INPUT)$/.test(a.tagName))) { renderPending = true; return; }
    redraw();
}
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
["pointerup", "pointercancel"].forEach((type) => document.addEventListener(type, () => {
    pointerDown = false;
    if (renderPending) setTimeout(renderWhenIdle, 0);
}, true));

/* ---------- CSV export (made here, in the browser) ---------- */
function csv(list) {
    const cols = ["batch", "company", "name", "role", "segment", "kind", "region", "country", "city", "lang", "email", "email_status", "generic_email", "linkedin_url", "best_channel", "fit", "hardware_level", "status", "sentAt", "followups", "outcome", "notes", "subject", "hook", "angle", "next_email_to", "next_email_subject", "next_email_body", "company_url", "role_source_url", "email_source_url"];
    const rows = list.map((c) => {
        const s = st(c.id);
        const p = partsFor(c);
        const which = nextEmail(c.id);
        const lang = s.lang || c.lang;
        const val = Object.assign({}, c, {
            segment: segLabel(c.segment), lang, status: statusOf(c.id), sentAt: s.sentAt || "", followups: s.followups || 0, outcome: outcomeOf(c.id), notes: s.notes || "",
            subject: s.subject || c.subject || "", hook: p.hook, angle: p.angle,
            next_email_to: addressOf(c).to, next_email_subject: subjectFor(c, which), next_email_body: composeBody(c, p, which, lang),
        });
        const cell = (v) => { let x = String(v ?? ""); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return `"${x.replace(/"/g, '""')}"`; };
        return cols.map((k) => cell(val[k])).join(",");
    });
    return [cols.join(","), ...rows].join("\n");
}
function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- events ---------- */
function resetFilters() { Object.assign(state.filters, { region: "", seg: "", first: false, cat: "", status: "", email: "", hw: "", fit: "", kind: "", country: "", lang: "", primary: "", outcome: "", q: "" }); }
/** The ticked people the filters still show: a bulk action never touches someone you cannot see. */
const selectedContacts = () => filtered().filter((c) => state.selected.has(c.id));
const namesOf = (list) => list.slice(0, 5).map((c) => c.name).join(", ") + (list.length > 5 ? ` and ${list.length - 5} more` : "");
const addressList = (list) => list.filter((c) => addressOf(c).to).map((c) => `${c.name} <${addressOf(c).to}>`).join("\n");

document.addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    const d = t.dataset;
    if (d.view) { switchView(d.view); return; }
    if (d.first !== undefined) { state.filters.first = Number(state.filters.first) === Number(d.first) ? 0 : Number(d.first); saveFilters(); renderFilterControls(); renderGrid(); return; }
    if (d.region !== undefined) { state.filters.region = d.region; saveFilters(); renderFilterControls(); renderGrid(); return; }
    if (d.seg !== undefined) { state.filters.seg = d.seg; saveFilters(); renderFilterControls(); renderGrid(); return; }
    if (d.emailkind !== undefined) { state.filters.email = d.emailkind; saveFilters(); renderFilterControls(); renderGrid(); return; }
    if (d.outcome !== undefined) { state.filters.outcome = d.outcome; saveFilters(); renderFilterControls(); renderGrid(); return; }
    if (d.play) { state.playView = d.play; try { localStorage.setItem("llo-play", d.play); } catch (err) { /* ignore */ } renderPlaybook(); return; }
    if (d.msglang) { state.msgLang = d.msglang; renderMessages(); return; }
    if (d.showSeg) { resetFilters(); state.filters.seg = d.showSeg; saveFilters(); renderFilterControls(); renderGrid(); switchView("contacts"); window.scrollTo(0, 0); return; }
    if (d.goto) {
        switchView("contacts");
        resetFilters(); saveFilters();
        renderFilterControls(); renderGrid();
        const el = document.querySelector(`.card[data-id="${CSS.escape(d.goto)}"]`);
        if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.animate([{ outline: "3px solid var(--accent)" }, { outline: "3px solid transparent" }], { duration: 1600 }); }
        return;
    }
    if (d.compose) { openComposer(d.compose); return; }
    if (d.copyEmail) {
        const c = state.contacts.find((x) => x.id === d.copyEmail); if (!c) return;
        const why = stopReason(c);
        if (why && !/Fill in Your details/.test(why)) { toast("Not copied: " + why); return; }
        const text = emailText(c);
        copyText(text, null, placeholdersIn(text).length ? "Copied, but Your details are incomplete: placeholders are still in it" : "Copied the email");
        return;
    }
    if (d.copyAll) { const c = state.contacts.find((x) => x.id === d.copyAll); if (c) copyText(allInfoText(c), null, "Copied everything on " + c.name); return; }
    if (d.handled) { patchContact(d.handled, { needsAction: false }, () => { renderGrid(); toast("Marked as handled"); }); return; }
    if (d.copyText !== undefined) { copyText(d.copyText, null); return; }
    if (d.copy) { const el = $(d.copy); copyText(el.value, el); return; }
    if (d.erase) {
        const c = state.contacts.find((x) => x.id === d.erase);
        if (!c || !confirm(`Erase ${c.name}? Their research, address and history are removed from the page and from agents, and they are never added back. This cannot be undone.`)) return;
        api("/erase", { method: "POST", body: { id: d.erase } })
            .then(() => {
                state.erased.add(d.erase);
                state.erasedInfo = [...(state.erasedInfo || []), { id: d.erase, company_id: c.company_id }];
                state.status[d.erase] = { status: "optout", erased: true };
                state.contacts = state.contacts.filter((x) => x.id !== d.erase);
                rebuildCompanies();
                state.selected.delete(d.erase);
                redraw();
                toast(`${c.name} was erased. Run the data upload again to drop them from the stored files too.`);
            })
            .catch((err) => toast("Couldn't erase: " + err.message));
        return;
    }
    if (d.keyRevoke) {
        if (!confirm("Revoke this key? The agent loses access at once, and people it had taken are given back.")) return;
        api(`/keys/${encodeURIComponent(d.keyRevoke)}/revoke`, { method: "POST", body: {} }).then(() => { toast("Revoked"); loadAgents(); }).catch((err) => toast("Couldn't revoke: " + err.message));
        return;
    }
    if (d.keyLink) {
        api(`/keys/${encodeURIComponent(d.keyLink)}/link`, { method: "POST", body: {} }).then((r) => { state.links[d.keyLink] = r.link; renderAgents(); }).catch((err) => toast("Couldn't make a link: " + err.message));
        return;
    }
    switch (t.id) {
        case "drawer-close": closeComposer(); return;
        case "select-shown": filtered().forEach((c) => state.selected.add(c.id)); renderGrid(); return;
        case "copy-shown-addresses": copyText(addressList(filtered()), null, "Copied the addresses shown"); return;
        case "bulk-clear": state.selected.clear(); renderGrid(); return;
        case "bulk-copy-addr": copyText(addressList(selectedContacts()), null, "Copied the addresses"); return;
        case "bulk-copy-emails": {
            const list = selectedContacts().filter((c) => addressOf(c).to);
            const ok = list.filter((c) => { const why = stopReason(c); return !why || /Fill in Your details/.test(why); });
            const left = list.length - ok.length;
            if (!ok.length) { toast("None of the selected people may be emailed now"); return; }
            const text = ok.map(emailText).join("\n\n----------\n\n");
            copyText(text, null, `Copied ${ok.length} email${ok.length === 1 ? "" : "s"}, one after the other` + (left ? `; ${left} left out (asked to stop, said no, bounced, or a country that needs consent)` : "") + (placeholdersIn(text).length ? ". Your details are incomplete: placeholders are still in them" : ""));
            return;
        }
        case "bulk-sent": {
            const list = selectedContacts();
            if (!list.length) return;
            if (!confirm(`Mark the first email to ${list.length} ${list.length === 1 ? "person" : "people"} (${namesOf(list)}) as sent today? Anyone already emailed stays as they are, and so does anyone who asked to stop, said no or bounced.`)) return;
            markSent(list.map((c) => ({ id: c.id, which: "first" })), () => { state.selected.clear(); });
            return;
        }
        case "bulk-followup": {
            const list = selectedContacts().filter((c) => ["sent", "followup"].includes(statusOf(c.id)) && nextEmail(c.id) !== "first");
            const skipped = selectedContacts().length - list.length;
            if (!list.length) { toast("None of the selected people has had a first email yet"); return; }
            if (!confirm(`Mark the follow-up to ${list.length} ${list.length === 1 ? "person" : "people"} (${namesOf(list)}) as sent today?${skipped ? ` ${skipped} without a first email are left out.` : ""}`)) return;
            markSent(list.map((c) => ({ id: c.id, which: nextEmail(c.id) })), () => { state.selected.clear(); });
            return;
        }
        case "export": download("local-llm-contacts.csv", csv(filtered()), "text/csv"); return;
        case "c-copy-all": copyText(`To: ${$("c-to").value}\nSubject: ${$("c-subject").value}\n\n${$("c-body").value}`, $("c-body"), "Copied To, subject and email"); return;
        case "ag-refresh": loadAgents(); return;
        case "ag-hide": state.newKey = null; renderAgents(); return;
        case "ag-signout-all":
            if (!confirm("Sign out every browser session, yours included? Agent keys keep working.")) return;
            api("/signout-all", { method: "POST", body: {} }).then(() => location.assign("/client-outreach")).catch((err) => toast("Couldn't: " + err.message));
            return;
    }
    if (t.id === "c-reset" && state.composerId) {
        const c = state.contacts.find((x) => x.id === state.composerId);
        cancelParts();
        state.currentParts = { hook: c.hook || "", angle: c.angle || "" };
        $("c-hook").value = state.currentParts.hook; $("c-angle").value = state.currentParts.angle;
        refreshBody();
        if (st(c.id).custom) patchContact(c.id, { custom: null });
        toast("Reset to the suggestion"); return;
    }
    if (t.id === "c-sent" && state.composerId) {
        const id = state.composerId, which = $("c-which").value;
        if (isClosed(id)) { toast("This person asked you not to write, so this stays as it is"); return; }
        const item = which === "first" ? { id, which, lang: $("c-lang").value, subject: $("c-subject").value, custom: state.currentParts } : { id, which };
        t.disabled = true;
        cancelParts();
        markSent([item], (r) => { const res = (r.results || [])[0] || {}; if (res.result !== "refused") closeComposer(); }).finally(() => { t.disabled = false; });
    }
});
$("scrim").addEventListener("click", closeComposer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) closeComposer(); });
$("c-contact").addEventListener("change", () => loadComposer($("c-contact").value));
$("c-which").addEventListener("change", () => {
    const c = state.contacts.find((x) => x.id === state.composerId); if (!c) return;
    $("c-subject").value = subjectFor(c, $("c-which").value);
    $("c-parts").hidden = $("c-which").value !== "first";
    refreshBody();
});
$("c-lang").addEventListener("change", refreshBody);
$("c-body").addEventListener("input", countWords);
$("c-hook").addEventListener("input", partsChanged);
$("c-angle").addEventListener("input", partsChanged);

document.addEventListener("submit", (e) => {
    if (e.target.id !== "ag-new") return;
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
        name: String(f.get("name") || "").trim(), role: f.get("role"), full_read: f.get("full_read") === "on",
        can_send: f.get("can_send") === "on", acknowledged: f.get("acknowledged") === "on", expires_days: Number(f.get("expires_days")) || 30,
    };
    if (body.can_send && !body.acknowledged) { toast("Tick the acknowledgement, or untick 'May send emails by itself'"); return; }
    api("/keys", { method: "POST", body }).then((r) => { state.newKey = { ...r }; loadAgents(); }).catch((err) => toast("Couldn't create the key: " + err.message));
});

document.addEventListener("change", (e) => {
    const el = e.target, d = el.dataset;
    if (d.select) {
        if (el.checked) state.selected.add(d.select); else state.selected.delete(d.select);
        const cardEl = el.closest(".card"); if (cardEl) cardEl.classList.toggle("is-picked", el.checked);
        renderBulkBar();
        return;
    }
    if (d.statusFor) {
        el.className = "status st-" + el.value;
        setStatuses([d.statusFor], el.value);
        return;
    }
    if (d.notesFor) {
        const id = d.notesFor, text = el.value.slice(0, 4000), before = st(id).notes;
        state.status[id] = Object.assign({}, st(id), { notes: text });
        patchContact(id, { notes: text }, renderWhenIdle).then((r) => { if (!r) { state.status[id] = Object.assign({}, st(id), { notes: before }); renderWhenIdle(); } });
        return;
    }
    if (d.outcomeFor) {
        const id = d.outcomeFor, s = st(id), cur = statusOf(id);
        const body = { outcome: el.value || "none", override: true };
        if (el.value === "declined") body.status = "declined";
        else if (el.value) body.status = cur === "meeting" ? "meeting" : "replied";
        else if (["replied", "declined"].includes(cur) && s.sentAt) body.status = s.followups ? "followup" : "sent";
        patchContact(id, body, redraw);
        return;
    }
    if (d.meetingFor) { el.dataset.dirty = "1"; return; }
    if (el.id === "bulk-status") {
        const value = el.value; el.value = "";
        const list = selectedContacts();
        if (!value || !list.length) return;
        const label = (STATUSES.find((s) => s.v === value) || {}).label || value;
        if (!confirm(`Set ${list.length} ${list.length === 1 ? "person" : "people"} (${namesOf(list)}) to "${label}"?`)) return;
        setStatuses(list.map((c) => c.id), value).then((r) => { if (r) { state.selected.clear(); toast(`${r.recorded} changed`); redraw(); } });
        return;
    }
    if (el.id === "s-startup") { saveSettings({ startup: el.value.trim() }); return; }
    if (el.id === "s-signature") { saveSettings({ signature: el.value.trim() }); return; }
    if (el.id === "s-privacy") { saveSettings({ privacy: el.value.trim() }); return; }
    if (el.id === "s-credential") { saveSettings({ use_credential: el.checked }); return; }
    if (el.id === "s-check") { saveSettings({ use_check_offer: el.checked }); return; }
    if (el.id === "ag-from") { saveSettings({ from_address: el.value.trim() }); return; }
    if (el.id === "ag-mailready") { saveSettings({ mail_ready: el.checked }); return; }
    if (el.id === "ag-paused") { saveSettings({ agents_paused: el.checked }); return; }
    if (el.id === "ag-limit") { const n = Math.max(0, Math.min(30, Math.round(Number(el.value) || 0))); saveSettings({ daily_limit: n }); return; }
    if (el.id === "ag-tz") { saveSettings({ timezone: el.value.trim() }); return; }
    if (el.id === "ag-cansend") { $("ag-legal").hidden = !el.checked; $("ag-ack-wrap").hidden = !el.checked; return; }
    const map = { "f-cat": "cat", "f-status": "status", "f-sort": "sort", "f-hw": "hw", "f-fit": "fit", "f-kind": "kind", "f-country": "country", "f-lang": "lang", "f-primary": "primary" };
    if (!map[el.id]) return;
    state.filters[map[el.id]] = el.value;
    saveFilters(); renderGrid();
});
function saveMeeting(el) {
    delete el.dataset.dirty;
    const id = el.dataset.meetingFor, s = st(id);
    if (el.value && new Date(el.value).getFullYear() < 2020) { toast("Check the year of that meeting"); el.value = localInput(s.meeting && s.meeting.when); return; }
    const body = el.value
        ? { meeting: { when: new Date(el.value).toISOString(), platform: (s.meeting || {}).platform, note: (s.meeting || {}).note }, status: "meeting", override: true }
        : { meeting: null };
    patchContact(id, body, renderWhenIdle);
}
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset && e.target.dataset.meetingFor) e.target.blur(); });
document.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.meetingFor && el.dataset.dirty) saveMeeting(el);
    if (renderPending) setTimeout(renderWhenIdle, 0);
});
let qTimer;
$("q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.filters.q = e.target.value; saveFilters(); renderGrid(); }, 150); });

function switchView(v) {
    state.view = v;
    document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    VIEWS.forEach((k) => { $("view-" + k).hidden = k !== v; });
    try { localStorage.setItem("llo-view", v); } catch (e) { /* ignore */ }
    if (v === "agents") { renderAgents(); loadAgents(); }
}

/* ---------- keeping up with agents ---------- */
/**
 * Everyone per company, plus a placeholder for each erased person: their stop request must keep holding back the rest of
 * their company in the composer, the copy buttons and the warnings. Placeholders never show in the grid or the counters.
 */
function rebuildCompanies() {
    state.byCompany = {};
    state.contacts.forEach((c) => { (state.byCompany[c.company_id] = state.byCompany[c.company_id] || []).push(c); });
    (state.erasedInfo || []).forEach((e) => {
        if (!e.company_id || !state.byCompany[e.company_id]) return;
        const mate = state.byCompany[e.company_id][0];
        state.byCompany[e.company_id].push({ id: e.id, name: "someone (erased at their request)", company_id: e.company_id, company: mate.company, _erased: true });
    });
}
async function refreshState(force) {
    if (refreshState.busy && !force) return;
    refreshState.busy = true;
    try {
        const full = state.needFull;
        state.needFull = false;
        const s = await api("/state?since=" + (full ? 0 : state.rev));
        let changed = false;
        for (const [id, d] of Object.entries(s.status || {})) {
            // A write in flight wins; ask for everything again next time so nothing it hid is lost.
            if (state.pending.has(id)) { state.needFull = true; continue; }
            state.status[id] = d.doc || {};
            state.docMeta[id] = { v: d.v, by: d.by, at: d.at };
            changed = true;
        }
        if (s.meta && s.meta.settings) {
            const a = document.activeElement;
            state.settings = s.meta.settings;
            if (!(a && /^(s-|ag-)/.test(a.id || ""))) { renderMessages(); if (state.view === "agents") renderAgents(); }
        }
        if (s.meta && s.meta.sync) { state.sync = s.meta.sync; renderSync(); }
        if (s.meta && s.meta.data) { state.dataMeta = s.meta.data; if (state.view === "agents") renderAgents(); }
        if (JSON.stringify(s.claims) !== JSON.stringify(state.claims)) { state.claims = s.claims || []; changed = true; }
        const erasedList = (s.erased || []).map((e) => (typeof e === "string" ? { id: e } : e));
        const erased = new Set(erasedList.map((e) => e.id));
        if (erased.size !== state.erased.size || [...erased].some((id) => !state.erased.has(id))) {
            state.erased = erased;
            state.erasedInfo = erasedList;
            state.contacts = state.contacts.filter((c) => !erased.has(c.id));
            erased.forEach((id) => state.selected.delete(id));
            rebuildCompanies();
            changed = true;
        }
        state.rev = s.rev;
        if (!state.statusLoaded) { state.statusLoaded = true; changed = true; }
        if (changed && state.booted) { renderCounters(); renderWhenIdle(); }
    } catch (e) {
        if (e.status && e.status !== 401) console.warn("refresh failed", e.message);
    } finally {
        refreshState.busy = false;
    }
}
setInterval(() => { if (document.visibilityState === "visible") refreshState(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshState(); });
window.addEventListener("focus", () => refreshState());

/* ---------- boot ---------- */
async function boot() {
    const hash = (location.hash || "").replace("#", "");
    let v = VIEWS.includes(hash) ? hash : null;
    if (!v) { try { v = localStorage.getItem("llo-view"); } catch (e) { v = null; } }
    try {
        const [contacts, messages, playbook] = await Promise.all([api("/data/contacts.json"), api("/data/messages.json"), api("/data/playbook.json").catch(() => null)]);
        state.contacts = contacts; state.messages = messages; state.playbook = playbook;
    } catch (e) {
        $("grid").innerHTML = `<div class="empty">${e.status === 503 ? "The research data has not been uploaded yet (scripts/outreach/upload-data.mjs)." : "The contact data didn't load. Reload the page."}</div>`;
        switchView(VIEWS.includes(v) ? v : "contacts");
        return;
    }
    ((state.playbook && state.playbook.law && state.playbook.law.rules) || []).forEach((r) => { state.lawBy[r.country] = r; });
    await refreshState();
    state.contacts = state.contacts.filter((c) => !state.erased.has(c.id));
    rebuildCompanies();
    state.booted = true;
    renderCounters(); renderFilterControls(); renderGrid(); renderMessages(); renderPlaybook(); renderSync();
    switchView(VIEWS.includes(v) ? v : "contacts");
}

boot();
