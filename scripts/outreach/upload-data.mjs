#!/usr/bin/env node
// Uploads the outreach research (contacts.json, messages.json, playbook.json) to the site, through the founder-only admin API.
// The files hold personal data, so they live outside this public repo; pass their folder with --data.
//
//   OUTREACH_KEY=... node scripts/outreach/upload-data.mjs --data "/path/to/page/data" [--base https://nevomirzai.com]
//   (or --key-file /path/to/file-with-the-owner-key)
//
// Statuses, sends, claims and the log are never touched. People the founder erased on the page are left out of the files.
// Safe to run again: the same files make the same version.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : acc), []),
);
const base = (args.base || "https://nevomirzai.com").replace(/\/+$/, "");
if (!args.data) fail("Pass --data <folder with contacts.json, messages.json and playbook.json>");
const key = (args["key-file"] ? readFileSync(args["key-file"], "utf8") : process.env.OUTREACH_KEY || "").trim();
if (key.length < 32) fail("Set OUTREACH_KEY (the owner key, at least 32 characters) or pass --key-file");
const auth = { Authorization: `Bearer ${key}` };

function fail(msg) {
    console.error("upload-data: " + msg);
    process.exit(1);
}

async function call(method, path, body, headers = {}) {
    const res = await fetch(base + "/api/outreach/admin" + path, { method, headers: { ...auth, ...headers }, body });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = { raw: text.slice(0, 200) };
    }
    if (!res.ok) fail(`${method} ${path} answered ${res.status}: ${data.error || data.raw || ""}`);
    return data;
}

const read = (name) => JSON.parse(readFileSync(join(args.data, name), "utf8"));
const contactsAll = read("contacts.json");
const messages = read("messages.json");
const playbook = read("playbook.json");
if (!Array.isArray(contactsAll) || !messages.emails || !playbook.law) fail("These do not look like the outreach data files.");

const { erased } = await call("GET", "/erased");
const gone = new Set(erased);
const contacts = contactsAll.filter((c) => !gone.has(c.id));
const files = {
    "contacts.json": JSON.stringify(contacts),
    "messages.json": JSON.stringify(messages),
    "playbook.json": JSON.stringify(playbook),
};
const version = "v" + createHash("sha256").update(files["contacts.json"]).update(files["messages.json"]).update(files["playbook.json"]).digest("hex").slice(0, 20);
console.log(`Uploading to ${base}: ${contacts.length} people (${gone.size} erased, left out), version ${version}`);

for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text, "utf8");
    await call("PUT", `/blob/${name}?version=${version}`, body, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    console.log(`  stored ${name} (${body.length} bytes)`);
}

const law = Object.fromEntries((playbook.law.rules || []).map((r) => [r.country, r.level]));
let upserted = 0;
for (let i = 0; i < contacts.length; i += 25) {
    const r = await call("POST", "/contacts", JSON.stringify({ version, law, contacts: contacts.slice(i, i + 25) }), { "Content-Type": "application/json" });
    upserted += r.upserted;
}
console.log(`  ${upserted} research records written`);

const research = {
    law: (playbook.law.rules || []).map((r) => ({ country: r.country, country_name: r.country_name, level: r.level, rule: r.rule, what_to_do: r.what_to_do, source_url: r.source_url })),
    messages,
    checklist: playbook.law.checklist || [],
    cadence: (playbook.email && playbook.email.cadence) || [],
};
const done = await call("POST", "/commit", JSON.stringify({ version, research }), { "Content-Type": "application/json" });
console.log(`Live: version ${done.live}, ${done.people} people${done.removed_from_list ? `, ${done.removed_from_list} no longer in the research` : ""}.`);
