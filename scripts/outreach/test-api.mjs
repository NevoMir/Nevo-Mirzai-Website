#!/usr/bin/env node
// End-to-end test of the outreach API against a LOCAL `npx wrangler dev` with uploaded data (scripts/outreach/upload-data.mjs).
// It wipes the local outreach statuses, keys and log first, so never point it at the live site (it refuses anything but localhost).
// It erases one person; run the upload again afterwards to bring them back locally.
//
//   node scripts/outreach/test-api.mjs --key-file <file with the dev owner key from .dev.vars> [--base http://127.0.0.1:8787]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const base = (args.base || "http://127.0.0.1:8787").replace(/\/+$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error("This test wipes data: localhost only");
const ownerKey = readFileSync(args["key-file"], "utf8").trim();
let failures = 0;
const ok = (cond, what, extra) => {
    if (cond) console.log("  ok   " + what);
    else {
        failures++;
        console.log("  FAIL " + what + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : ""));
    }
};

// ---------- reset the local database (statuses, claims, sends, keys, log, settings) ----------
execFileSync("npx", ["wrangler", "d1", "execute", "llo-outreach", "--local", "--command",
    "DELETE FROM status; DELETE FROM claims; DELETE FROM sends; DELETE FROM agent_keys; DELETE FROM session_links; DELETE FROM log; DELETE FROM auth_failures; DELETE FROM meta WHERE key IN ('settings','sync','auth'); DELETE FROM contacts WHERE erased_at IS NOT NULL; UPDATE meta SET data = json_remove(data, '$.pending_erase') WHERE key = 'data';"], { stdio: "ignore" });

// ---------- helpers ----------
let cookie = "";
async function owner(method, path, body, extraHeaders = {}) {
    const res = await fetch(base + path, {
        method,
        headers: { Cookie: cookie, Origin: base, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "manual",
    });
    return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
function agent(key) {
    return async (method, path, body) => {
        const res = await fetch(base + "/api/outreach" + path, {
            method,
            headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, data: await res.json().catch(() => null) };
    };
}

console.log("Sign-in");
{
    const bad = await fetch(base + "/client-outreach/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + "x".repeat(40), redirect: "manual" });
    ok(bad.status === 401, "a wrong owner key is refused");
    const noOrigin = await fetch(base + "/client-outreach/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + encodeURIComponent(ownerKey), redirect: "manual" });
    ok(noOrigin.status === 403, "a login post without Origin is refused");
    const good = await fetch(base + "/client-outreach/login", { method: "POST", headers: { Origin: base, "Content-Type": "application/x-www-form-urlencoded" }, body: "key=" + encodeURIComponent(ownerKey), redirect: "manual" });
    ok(good.status === 303, "the owner key signs in");
    cookie = (good.headers.get("set-cookie") || "").split(";")[0];
    ok(/^llo_dev=v1\.owner\./.test(cookie), "an owner session cookie is set");
    const page = await fetch(base + "/client-outreach", { headers: { Cookie: cookie } });
    const html = await page.text();
    ok(page.status === 200 && html.includes('id="view-agents"'), "the founder's page is served after sign-in");
    ok((page.headers.get("content-security-policy") || "").includes("frame-ancestors 'none'"), "the page carries the CSP");
    const anon = await fetch(base + "/client-outreach");
    ok((await anon.text()).includes("Owner key"), "without a session the login form is shown");
    const bearerOwner = await fetch(base + "/api/outreach", { headers: { Authorization: `Bearer ${ownerKey}` } });
    ok(bearerOwner.status === 401, "the owner key is not accepted as a Bearer token outside the upload endpoints");
}

console.log("Settings and readiness");
let r = await owner("GET", "/api/outreach");
ok(r.status === 200 && r.data.ready_for_agents.ready === false, "not ready before the sender details", r.data && r.data.ready_for_agents);
r = await owner("PUT", "/api/outreach/meta/settings", { startup: "Testco", signature: "Test Founder\nTestco SA, Rue du Test 1, 1000 Lausanne\nhttps://testco.example", privacy: "https://testco.example/privacy", from_address: "founder@testco.example", mail_ready: true, daily_limit: 5 });
ok(r.status === 200 && r.data.ready_for_agents.ready === true, "ready once the details and the setup are confirmed", r.data);
r = await owner("PUT", "/api/outreach/meta/settings", { from_address: "someone@gmail.com" });
ok(r.data.ready_for_agents.ready === false, "a Gmail sending address is refused for agents");
await owner("PUT", "/api/outreach/meta/settings", { from_address: "founder@testco.example" });
r = await owner("PUT", "/api/outreach/meta/settings", { daily_limit: 99 });
ok(r.status === 400, "a daily limit over 30 is refused");
const csrf = await fetch(base + "/api/outreach/meta/settings", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ startup: "evil" }) });
ok(csrf.status === 403, "a cookie write without Origin is refused (CSRF)");
const notJson = await fetch(base + "/api/outreach/meta/settings", { method: "PUT", headers: { Cookie: cookie, Origin: base, "Content-Type": "text/plain" }, body: JSON.stringify({ startup: "x" }) });
ok(notJson.status === 415, "a write that is not JSON is refused");

console.log("Keys");
r = await owner("POST", "/api/outreach/keys", { name: "Drafter", role: "agent", full_read: false });
ok(r.status === 200 && /^llo_[a-z2-9]{10}_[A-Za-z0-9_-]{43}$/.test(r.data.key), "a draft-only agent key is created", r.data);
const drafter = agent(r.data.key);
const drafterId = r.data.id;
r = await owner("POST", "/api/outreach/keys", { name: "Sender", role: "agent", can_send: true });
ok(r.status === 400, "a sending key needs the acknowledgement");
r = await owner("POST", "/api/outreach/keys", { name: "Sender", role: "agent", can_send: true, acknowledged: true });
const sender = agent(r.data.key);
r = await owner("POST", "/api/outreach/keys", { name: "Reply check", role: "reply-check" });
const replyCheck = agent(r.data.key);
r = await owner("GET", "/api/outreach/keys");
ok(r.data.keys.length === 3 && !JSON.stringify(r.data).includes("llo_"), "keys are listed without their secrets");

console.log("Agent permissions");
r = await drafter("GET", "");
ok(r.status === 200 && r.data.you.may_send_emails === false, "the drafter sees it may not send");
r = await drafter("PUT", "/meta/settings", { daily_limit: 30 });
ok(r.status === 403, "an agent cannot change settings");
r = await drafter("POST", "/keys", { name: "x" });
ok(r.status === 403, "an agent cannot create keys");
r = await drafter("GET", "/data/contacts.json");
ok(r.status === 403, "a key without full read cannot download the whole list");
r = await drafter("POST", "/status", { ids: ["x"], status: "sent" });
ok(r.status === 403, "an agent cannot use the founder's status menu");
const wrong = await fetch(base + "/api/outreach", { headers: { Authorization: "Bearer llo_aaaaaaaaaa_" + "A".repeat(43) } });
ok(wrong.status === 401, "a wrong agent key is refused");

console.log("Taking people");
r = await drafter("POST", "/claim", { n: 3 });
ok(r.status === 409 && /mailbox/i.test(r.data.error), "taking is refused until the mailbox was checked", r.data);
r = await drafter("POST", "/inbox-checked", {});
ok(r.status === 200, "inbox-checked is recorded");
r = await drafter("POST", "/claim", { n: 3 });
ok(r.status === 200 && r.data.taken.length === 3, "three people are taken", r.data);
const taken = r.data.taken || [];
ok(new Set(taken.map((t) => t.company)).size === taken.length, "one person per company");
ok(taken.every((t) => t.to && t.subject && t.body && !/\[(startup name|your opening|signature|privacy notice link)\]|\{\{/.test(t.body)), "each email is complete, with no placeholders");
ok(taken.every((t) => t.body.includes("https://testco.example/privacy") && t.body.includes("Testco SA, Rue du Test 1")), "each email has the privacy link and the legal signature");
const people = await (await fetch(base + "/api/outreach/contacts?limit=500", { headers: { Cookie: cookie } })).json();
const byId = Object.fromEntries(people.people.map((p) => [p.id, p]));
ok(taken.every((t) => byId[t.id].law_level === "ok" && byId[t.id].is_primary === 1), "only countries that allow it, only the first person at a company");
r = await sender("POST", "/claim", { ids: [taken[0].id] });
ok(r.status === 409 || (r.data.taken || []).length === 0, "another agent cannot take the same person", r.data);

console.log("What a key without full read sees");
r = await drafter("GET", "/contacts?limit=500");
ok(r.status === 200 && r.data.people.length === taken.length, "the list shows only the people it holds (nobody written to yet)", r.data && r.data.people.length);
r = await drafter("GET", "/contacts/" + people.people.find((p) => !taken.some((t) => t.id === p.id)).id);
ok(r.status === 403, "it cannot open someone it does not hold");
r = await drafter("GET", "/state");
ok(r.status === 403, "agents cannot read the whole state");
r = await drafter("PATCH", "/contacts/" + taken[0].id, { custom: { hook: "See https://evil.example" } });
ok(r.status === 400, "an opening with a link is refused");
r = await drafter("PATCH", "/contacts/" + taken[0].id, { custom: { hook: "A better opening sentence." }, notes: "Checked the role on the company site." });
ok(r.status === 200 && r.data.docs[taken[0].id].doc.custom.hook === "A better opening sentence." && /Drafter: Checked the role/.test(r.data.docs[taken[0].id].doc.notes), "it can improve the opening and add a note for someone it holds", r.data);
r = await drafter("GET", "/contacts/" + taken[0].id);
ok(r.data.next_email.body.includes("A better opening sentence."), "the email now uses the new opening");

console.log("Drafts and sends (draft-only key)");
r = await drafter("POST", "/sent", { items: [{ id: taken[0].id, which: "first" }] });
ok(r.data.results[0].result === "refused", "a draft-only key cannot record a send before a draft", r.data.results);
r = await drafter("POST", "/drafted", { ids: taken.map((t) => t.id) });
ok(r.data.results.every((x) => x.result === "recorded"), "drafts are recorded", r.data.results);
r = await sender("POST", "/sent", { items: [{ id: taken[0].id, which: "first" }] });
ok(r.data.results[0].result === "refused", "another agent cannot record this agent's draft as sent", r.data.results);
r = await drafter("POST", "/sent", { items: [{ id: taken[0].id, which: "follow1" }] });
ok(r.data.results[0].result === "refused", "a draft cannot be recorded as another email than the one taken", r.data.results);
r = await drafter("POST", "/sent", { items: [{ id: taken[0].id, which: "first", message_id: "<m1@test>" }] });
ok(r.data.results[0].result === "recorded", "a drafted email can be recorded as sent once it is in the Sent folder", r.data.results);
r = await drafter("POST", "/sent", { items: [{ id: taken[0].id, which: "first" }] });
ok(r.data.results[0].result === "already_recorded", "recording the same send twice changes nothing", r.data.results);
r = await drafter("POST", "/release", { ids: [taken[2].id] });
ok((r.data.released || []).includes(taken[2].id), "a drafted person can be given back");
r = await drafter("GET", "/contacts/" + taken[2].id);
ok(r.status === 403, "given back, the agent can no longer open them");
r = await owner("GET", "/api/outreach/contacts/" + taken[2].id);
ok(r.data.status.status === "todo", "given back, the draft status returns to To contact", r.data.status);

console.log("The daily limit (5): one sent, one drafted so far");
r = await drafter("POST", "/claim", { n: 10 });
const second = r.data.taken || [];
ok(second.length === 3, "only 3 more can be taken today (limit 5)", { taken: second.length, today: r.data.today });
r = await drafter("POST", "/claim", { n: 1 });
ok((r.data.taken || []).length === 0, "nothing more once the limit is reached", r.data);
await drafter("POST", "/release", { ids: second.map((t) => t.id) });

console.log("Concurrency: two agents race for the limit");
await owner("PUT", "/api/outreach/meta/settings", { daily_limit: 4 });
await sender("POST", "/inbox-checked", {});
const [a, b] = await Promise.all([drafter("POST", "/claim", { n: 5 }), drafter("POST", "/claim", { n: 5 })]);
const total = (a.data.taken || []).length + (b.data.taken || []).length;
ok(total <= 2, `the two claims together stay within the limit (${total} taken, 2 left)`, { a: a.data.today, b: b.data.today });
const ids = [...(a.data.taken || []), ...(b.data.taken || [])].map((t) => t.id);
ok(new Set(ids).size === ids.length, "nobody is taken twice");
if (ids.length) await drafter("POST", "/release", { ids });
await owner("PUT", "/api/outreach/meta/settings", { daily_limit: 5 });

console.log("Replies, stop requests, bounces");
r = await replyCheck("POST", "/replies", { items: [{ id: taken[0].id, kind: "meeting", summary: "Proposes a call on Tuesday at 10, write to bob@example.com", date: new Date().toISOString(), from: "Them", message_id: "<r1@test>" }] });
ok(r.data.results[0].result === "recorded" && r.data.results[0].status === "meeting", "a meeting reply moves the person to Meeting", r.data);
r = await owner("GET", "/api/outreach/contacts/" + taken[0].id);
ok(r.data.status.needsAction === true && !/bob@example/.test(r.data.status.lastReply.summary), "the reply needs the founder, and its summary carries no address", r.data.status.lastReply);
r = await replyCheck("POST", "/replies", { items: [{ id: taken[0].id, kind: "meeting", summary: "same", date: new Date().toISOString(), message_id: "<r1@test>" }] });
ok(r.data.results[0].result === "already_recorded", "the same reply is not recorded twice");
r = await drafter("POST", "/replies", { items: [{ id: taken[0].id, kind: "positive", summary: "", from: "Them" }] });
ok(r.status === 400, "a reply needs a summary");
await Promise.all([0, 1, 2, 3, 4, 5].map((i) => replyCheck("POST", "/replies", { items: [{ id: taken[0].id, kind: "neutral", summary: "Parallel reply " + i, message_id: "<par" + i + "@test>" }] })));
r = await owner("GET", "/api/outreach/contacts/" + taken[0].id);
ok(["0", "1", "2", "3", "4", "5"].every((i) => (r.data.status.replies || []).some((x) => x.messageId === "<par" + i + "@test>")), "six replies saved at the same moment are all kept", (r.data.status.replies || []).length);
r = await drafter("POST", "/replies", { items: [{ id: taken[0].id, kind: "positive", summary: "Asks for a price list", from: "Them" }] });
const again2 = await drafter("POST", "/replies", { items: [{ id: taken[0].id, kind: "positive", summary: "Asks for a price list", from: "Them" }] });
ok(r.data.results[0].result === "recorded" && again2.data.results[0].result === "already_recorded", "a reply without a Message-ID is not recorded twice on a retry", [r.data.results, again2.data.results]);
r = await drafter("GET", "/awaiting-reply");
ok(r.status === 200 && r.data.people.some((p) => p.id === taken[0].id && p.address && p.subject), "awaiting-reply lists the people written to, with address and subject", r.data && r.data.people && r.data.people.length);
r = await drafter("GET", "/contacts/" + taken[0].id);
ok(r.status === 200, "a key without full read can open someone already written to");
r = await replyCheck("POST", "/claim", { n: 1 });
ok(r.status === 403, "the reply-check key cannot take people");
r = await drafter("POST", "/replies", { items: [{ id: taken[1].id, kind: "neutral", summary: "A short reply", date: new Date().toISOString() }] });
ok(r.data.results[0].result === "refused", "a reply cannot be recorded for someone never written to (still a draft)");
r = await drafter("POST", "/optout", { items: [{ id: people.people.find((p) => p.status === "todo" && !taken.some((t) => t.id === p.id)).id, said: "x" }] });
ok(r.data.results[0].result === "refused", "an agent cannot close someone never written to and not held");
r = await owner("POST", "/api/outreach/optout", { items: [{ id: taken[1].id, said: "Please stop", channel: "email" }] });
const twice = await owner("POST", "/api/outreach/optout", { items: [{ id: taken[1].id, said: "Please stop", channel: "email" }] });
ok(twice.data.results[0].result === "already_recorded", "recording the same stop request twice changes nothing");
const noted = await owner("GET", "/api/outreach/contacts/" + taken[1].id);
ok((noted.data.status.notes.match(/asked to stop/g) || []).length === 1, "the stop request is noted once", noted.data.status.notes);
r = await owner("POST", "/api/outreach/optout", { items: [{ id: "nobody-like-this" }] });
ok(r.data.results[0].result === "not_found", "an unknown id is not recorded");
r = await owner("GET", "/api/outreach/contacts/" + taken[1].id);
ok(r.data.status.status === "optout" && r.data.checks.some((k) => k.code === "opted_out"), "a stop request closes the person", r.data.status);
r = await owner("POST", "/api/outreach/status", { ids: [taken[1].id], status: "sent" });
ok(r.data.results[0].result === "refused" && r.data.results[0].needs_override, "a closed person cannot be set back to Sent without override");
r = await owner("POST", "/api/outreach/sent", { items: [{ id: taken[1].id }] });
ok(r.data.results[0].result === "refused", "nobody can record a send to someone who asked to stop");

console.log("Founder bulk actions");
const bulk = people.people.filter((p) => p.status === "todo" && p.law_level === "ok" && p.address && !taken.some((t) => t.id === p.id)).slice(0, 6).map((p) => p.id);
r = await owner("POST", "/api/outreach/sent", { ids: bulk });
ok(r.data.results.filter((x) => x.result === "recorded").length === 6, "the founder marks six as sent at once", r.data.results);
ok(Object.keys(r.data.docs || {}).length === 6 && Object.values(r.data.docs).every((d) => d.doc.status === "sent"), "the answer carries the new documents");
r = await owner("POST", "/api/outreach/status", { ids: bulk.slice(0, 2), status: "skip" });
ok(r.data.results.every((x) => x.result === "recorded"), "the founder sets two to Skip at once");
r = await owner("PATCH", "/api/outreach/contacts/" + bulk[2], { notes: "A note", outcome: "interested", status: "replied" });
ok(r.status === 200 && r.data.docs[bulk[2]].doc.notes === "A note", "notes and outcome are saved", r.data);
r = await drafter("PATCH", "/contacts/" + bulk[2], { custom: { hook: "A different opening." } });
ok(r.status === 403, "an agent cannot change the email of someone it does not hold");
r = await drafter("PATCH", "/contacts/" + bulk[2], { notes: "Saw their reply land in spam." });
ok(r.status === 200 && /Drafter: Saw their reply/.test(r.data.docs[bulk[2]].doc.notes) && r.data.docs[bulk[2]].doc.notes.includes("A note"), "an agent may add a signed note to someone already written to, keeping the founder's note", r.data && r.data.docs);

console.log("State polling");
const s0 = await owner("GET", "/api/outreach/state?since=0");
ok(s0.status === 200 && s0.data.rev > 1 && Object.keys(s0.data.status).length >= 9, "the full state parses", { rev: s0.data && s0.data.rev });
const s1 = await owner("GET", "/api/outreach/state?since=" + s0.data.rev);
ok(Object.keys(s1.data.status).length === 0, "nothing changed since the last revision");
await owner("PATCH", "/api/outreach/contacts/" + bulk[3], { notes: "changed" });
const s2 = await owner("GET", "/api/outreach/state?since=" + s0.data.rev);
ok(Object.keys(s2.data.status).length === 1 && s2.data.status[bulk[3]], "only the changed person comes back", Object.keys(s2.data.status));

console.log("Lint");
const one = (await owner("GET", "/api/outreach/contacts/" + taken[2].id)).data;
r = await owner("POST", "/api/outreach/lint", { id: taken[2].id, subject: one.next_email.subject, body: one.next_email.body });
ok(r.data.ok === true, "the composed email passes", r.data);
r = await owner("POST", "/api/outreach/lint", { id: taken[2].id, subject: one.next_email.subject, body: one.next_email.body.replace(/https:\/\/testco\.example\/privacy/g, "") + "\nhttps://tracker.example/x" });
ok(r.data.ok === false && r.data.problems.length >= 2, "an email without the privacy link and with a tracking link fails", r.data.problems);

console.log("Browser session link");
r = await owner("POST", `/api/outreach/keys/${drafterId}/link`, {});
ok(/\/client-outreach\/s\/[A-Za-z0-9_-]{43}$/.test(r.data.link), "a one-time link is made");
const linkPath = new URL(r.data.link).pathname;
const preview = await fetch(base + linkPath);
ok(preview.status === 200 && (await preview.text()).includes("Start"), "opening the link shows a Start button (a preview cannot use it up)");
const start = await fetch(base + linkPath, { method: "POST", headers: { Origin: base }, redirect: "manual" });
ok(start.status === 303 && /llo_dev=v1\.agent\./.test(start.headers.get("set-cookie") || ""), "Start opens an agent session");
const agentCookie = (start.headers.get("set-cookie") || "").split(";")[0];
const again = await fetch(base + linkPath, { method: "POST", headers: { Origin: base }, redirect: "manual" });
ok(again.status === 410, "the link works only once");
const console1 = await fetch(base + "/client-outreach/agent", { headers: { Cookie: agentCookie } });
ok(console1.status === 200 && (await console1.text()).includes("Outreach console"), "the agent console is served to the agent session");
const ownerPage = await fetch(base + "/client-outreach", { headers: { Cookie: agentCookie }, redirect: "manual" });
ok(ownerPage.status === 303, "an agent session is sent to the console, not the founder's page");
const agentSettings = await fetch(base + "/api/outreach/meta/settings", { method: "PUT", headers: { Cookie: agentCookie, Origin: base, "Content-Type": "application/json" }, body: "{}" });
ok(agentSettings.status === 403, "an agent browser session cannot change settings");

console.log("Revoking, erasing, signing out everywhere");
await owner("POST", `/api/outreach/keys/${drafterId}/revoke`, {});
r = await drafter("GET", "");
ok(r.status === 401, "a revoked key stops working at once");
const afterRevoke = await fetch(base + "/client-outreach/agent", { headers: { Cookie: agentCookie } });
ok((await afterRevoke.text()).includes("Owner key"), "and so does its browser session");
r = await owner("POST", "/api/outreach/erase", { id: bulk[5] });
const s3 = await owner("GET", "/api/outreach/state?since=0");
ok(s3.data.erased.some((e) => e.id === bulk[5] && e.company_id) && s3.data.status[bulk[5]].doc.status === "optout" && !s3.data.status[bulk[5]].doc.notes, "an erased person is listed as erased (with the company), with only the stop left", s3.data.status[bulk[5]]);
r = await owner("GET", "/api/outreach/contacts/" + bulk[5]);
ok(r.status === 404, "and is gone from the API");
r = await replyCheck("POST", "/replies", { items: [{ id: bulk[5], kind: "neutral", summary: "A short reply", from: "Them" }] });
ok(r.data.results[0].result === "not_found", "no reply can be written back onto an erased person");
r = await owner("GET", "/api/outreach");
ok(r.data.data.erased_waiting_for_upload === 1, "the overview says the stored file still needs an upload");
r = await owner("POST", "/api/outreach/signout-all", {});
const afterSignout = await owner("GET", "/api/outreach");
ok(afterSignout.status === 401, "signing out everywhere ends the founder's session too");

console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
process.exit(failures ? 1 : 0);
