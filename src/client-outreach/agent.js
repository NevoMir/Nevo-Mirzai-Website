// The console for an AI agent working in a browser (nevomirzai.com/client-outreach/agent, after a one-time link from the
// founder). Every step of the guide is a button here, so the agent never needs to script requests or see a key.

const API = "/api/outreach";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const state = { me: null, mine: [], emails: {}, written: [], replyFor: null };

function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3000);
}
function copy(text, label = "Copied") {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(label), () => toast("Copy is blocked: select the text instead"));
    else toast("Copy is blocked: select the text instead");
}

async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
        method, credentials: "same-origin",
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.assign("/client-outreach"); throw new Error("Signed out"); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok && res.status !== 409) { const err = new Error((data && data.error) || "HTTP " + res.status); err.data = data; throw err; }
    return { status: res.status, data };
}

const fmt = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); };

function renderStatus() {
    const o = state.me;
    if (!o) return;
    $("who").textContent = `Signed in as the agent "${o.you.name}"`;
    const r = o.ready_for_agents, t = o.today;
    $("status-box").innerHTML =
        (r.ready ? `<p class="ok">The founder's setup is complete: you can take people.</p>` : `<div class="stop"><strong>Stop: you cannot take anyone yet.</strong> Tell the founder this is missing:<ul>${r.missing.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>Never invent or fill in these details yourself.</div>`) +
        (t ? `<p class="muted">Today: ${t.sent_today} sent, ${t.taken_today} taken, ${t.remaining} left of ${t.limit}.</p>` : "");
    $("mode-line").textContent = o.you.may_send_emails
        ? "Your key may send: send each email on its own from the founder's mailbox (plain text, one address in To, no CC or BCC), then press \"I sent it\". A follow-up goes as a reply in the thread of the first email."
        : "Your key prepares drafts only: create each email as a draft in the founder's mailbox, do NOT press Send, then press \"I made the draft\". The founder sends them.";
    $("inbox-when").textContent = o.inbox_checked_at ? "You last checked " + fmt(o.inbox_checked_at) : "Not checked yet";
    $("bulk-done").textContent = o.you.may_send_emails ? "I sent all of these" : "I made all these drafts";
}

function renderWritten() {
    const list = state.written;
    if (!list.length) { $("written").innerHTML = `<p class="muted">Nobody has been written to yet, so there is nothing to look for. Press "I checked the mailbox".</p>`; return; }
    $("written").innerHTML = list.map((p) => `<div class="person" data-id="${esc(p.id)}">
        <div class="row"><h3>${esc(p.name)}</h3><span class="muted">${esc(p.company)} · ${esc(p.group || p.status)}${p.last_email_at ? " · last email " + esc(fmt(p.last_email_at) || p.last_email_at) : ""}${p.subject ? " · subject: " + esc(p.subject) : ""}</span></div>
        <div class="row"><span class="addr">${esc(p.address || "no address")}</span>${p.address ? `<button class="btn" data-copy="${esc(p.address)}">Copy address</button>` : ""}
          <button class="btn" data-reply="${esc(p.id)}">Record a reply</button>
          <button class="btn" data-bounced="${esc(p.id)}">Bounced or left</button>
          <button class="btn" data-optout="${esc(p.id)}">Asked to stop</button></div>
        ${state.replyFor === p.id ? `<form class="reply" data-reply-form="${esc(p.id)}">
          <label>What kind of reply <select name="kind" class="field"><option value="meeting">Proposes or accepts a meeting</option><option value="positive">Interested, asks for details</option><option value="redirect">Points to someone else or a process</option><option value="neutral">A real reply, neither yes nor no</option><option value="declined">Not interested</option><option value="auto-reply">Automatic reply</option></select></label>
          <label>One plain sentence for the founder (no addresses, numbers or links) <input name="summary" class="field" required maxlength="240"></label>
          <label>When it arrived <input name="date" type="datetime-local" class="field"></label>
          <label><input name="optout" type="checkbox"> They asked to stop writing or to delete their data</label>
          <div class="row"><button class="btn primary" type="submit">Record</button><button class="btn" type="button" data-reply-cancel>Cancel</button></div>
        </form>` : ""}
      </div>`).join("");
}

function renderMine() {
    const may = state.me && state.me.you.may_send_emails;
    $("bulk-row").hidden = state.mine.length < 2;
    if (!state.mine.length) { $("mine").innerHTML = `<p class="muted">You have taken nobody.</p>`; return; }
    $("mine").innerHTML = state.mine.map((p) => {
        const e = state.emails[p.id];
        const text = e ? `To: ${e.to}\nSubject: ${e.subject}\n\n${e.body}` : "";
        const draftWaits = p.taken_state === "drafted";
        return `<div class="person" data-id="${esc(p.id)}">
          <div class="row"><h3>${esc(p.name)}</h3><span class="muted">${esc(p.role || "")} · ${esc(p.company)}${p.taken_until ? " · yours until " + esc(fmt(p.taken_until)) : ""}</span></div>
          ${draftWaits ? `<p class="muted">Your draft waits in the founder's mailbox. When it shows in the Sent folder, press "It was sent".</p>` : ""}
          ${e ? `${(e.warnings || []).map((w) => `<div class="warn">${esc(w.text)}</div>`).join("")}
            <div class="row"><span class="muted">${e.which === "first" ? "A new email to" : "A reply in the thread of the first email, to"}</span><span class="addr">${esc(e.to)}</span><button class="btn" data-copy="${esc(e.to)}">Copy address</button></div>
            <div class="row"><span class="muted">Subject</span><strong>${esc(e.subject)}</strong><button class="btn" data-copy="${esc(e.subject)}">Copy subject</button></div>
            <pre class="mail">${esc(e.body)}</pre>
            <div class="row"><button class="btn" data-copy="${esc(e.body)}">Copy email text</button><button class="btn" data-copy="${esc(text)}">Copy To, subject and text</button>
              ${draftWaits ? `<button class="btn primary" data-done="sent" data-for="${esc(p.id)}" data-which="${esc(e.which)}">It was sent</button>`
                : may ? `<button class="btn primary" data-done="sent" data-for="${esc(p.id)}" data-which="${esc(e.which)}">I sent it</button>`
                    : `<button class="btn primary" data-done="drafted" data-for="${esc(p.id)}" data-which="${esc(e.which)}">I made the draft</button>`}
              <button class="btn" data-release="${esc(p.id)}">Give back</button></div>` : `<p class="muted">Loading the email…</p>`}
        </div>`;
    }).join("");
}

async function loadAll() {
    try {
        const [me, mine, awaiting] = await Promise.all([api(""), api("/contacts?mine=1&limit=50"), api("/awaiting-reply")]);
        state.me = me.data;
        state.mine = (mine.data && mine.data.people) || [];
        state.written = (awaiting.data && awaiting.data.people) || [];
        renderStatus(); renderWritten(); renderMine();
        await Promise.all(state.mine.filter((p) => !state.emails[p.id]).map(async (p) => {
            const r = await api("/contacts/" + encodeURIComponent(p.id));
            if (r.data && r.data.next_email) state.emails[p.id] = { ...r.data.next_email, warnings: (r.data.checks || []).filter((k) => k.level === "warn") };
        }));
        renderMine();
    } catch (e) {
        toast("Couldn't load: " + e.message);
    }
}

async function take() {
    const n = Number($("take-n").value) || 1;
    const r = await api("/claim", { method: "POST", body: { n } });
    const d = r.data || {};
    if (r.status === 409) { toast(d.error || "Not possible now"); if (d.missing) loadAll(); return; }
    (d.taken || []).forEach((e) => { state.emails[e.id] = e; });
    toast(d.taken && d.taken.length ? `Took ${d.taken.length}` : d.message || "Nobody can be taken now");
    loadAll();
}

async function done(kind, items) {
    const r = await api("/" + kind, { method: "POST", body: { items } });
    const res = (r.data && r.data.results) || [];
    const bad = res.filter((x) => x.result === "refused");
    toast(bad.length ? `Refused for ${bad.length}: ${bad[0].why || ""}` : kind === "sent" ? "Recorded as sent" : "Recorded as drafted");
    loadAll();
}

document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    const d = b.dataset;
    try {
        if (d.copy !== undefined) { copy(d.copy); return; }
        if (b.id === "take") { b.disabled = true; await take().finally(() => { b.disabled = false; }); return; }
        if (b.id === "refresh") { loadAll(); return; }
        if (b.id === "inbox-done") { await api("/inbox-checked", { method: "POST", body: {} }); toast("Noted: the mailbox was checked"); loadAll(); return; }
        if (d.done) { await done(d.done, [{ id: d.for, which: d.which }]); return; }
        if (d.release) { await api("/release", { method: "POST", body: { ids: [d.release] } }); toast("Given back. Delete any draft you made for them."); loadAll(); return; }
        if (b.id === "bulk-done") {
            const may = state.me && state.me.you.may_send_emails;
            const items = state.mine.filter((p) => state.emails[p.id]).map((p) => ({ id: p.id, which: state.emails[p.id].which }));
            const drafted = state.mine.filter((p) => p.taken_state === "drafted");
            if (!confirm(may ? `Record all ${items.length} as sent?` : drafted.length === items.length ? `Record all ${items.length} as sent (they show in the Sent folder)?` : `Record all ${items.length} as drafted?`)) return;
            await done(may || drafted.length === items.length ? "sent" : "drafted", items);
            return;
        }
        if (b.id === "bulk-release") { if (!confirm("Give everyone back?")) return; await api("/release", { method: "POST", body: { ids: state.mine.map((p) => p.id) } }); loadAll(); return; }
        if (d.reply) { state.replyFor = d.reply; renderWritten(); return; }
        if (d.replyCancel !== undefined) { state.replyFor = null; renderWritten(); return; }
        if (d.bounced) {
            const reason = prompt("What happened? (for example: hard bounce, user unknown; or: out of office says they left)");
            if (reason === null) return;
            await api("/bounced", { method: "POST", body: { items: [{ id: d.bounced, reason }] } }); toast("Recorded as bounced"); loadAll(); return;
        }
        if (d.optout) {
            const said = prompt("What did they say, in a few words?");
            if (said === null) return;
            await api("/optout", { method: "POST", body: { items: [{ id: d.optout, said, channel: "email" }] } }); toast("Recorded. Send them nothing, not even a confirmation."); loadAll(); return;
        }
    } catch (e) {
        toast("Refused: " + e.message);
    }
});

document.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("form[data-reply-form]"); if (!form) return;
    ev.preventDefault();
    const f = new FormData(form);
    const when = f.get("date") ? new Date(String(f.get("date"))).toISOString() : new Date().toISOString();
    try {
        const r = await api("/replies", { method: "POST", body: { items: [{ id: form.dataset.replyForm, kind: f.get("kind"), summary: String(f.get("summary") || ""), date: when, optout: f.get("optout") === "on" }] } });
        const res = (r.data && r.data.results) || [];
        toast(res[0] && res[0].result === "recorded" ? "Reply recorded" : (res[0] && res[0].why) || "Not recorded");
        state.replyFor = null;
        loadAll();
    } catch (e) { toast("Refused: " + e.message); }
});

loadAll();
setInterval(() => { if (document.visibilityState === "visible") loadAll(); }, 60000);
