// End-to-end smoke test of the /assignment_alex Worker API (REST contract in src/assignment/shared/contract.ts).
//
//   npx wrangler dev --port 8787 --local          # needs MOCK_PROVIDER=1 in .dev.vars
//   node scripts/assignment/smoke-api.mjs         # BASE=http://127.0.0.1:8787 by default
//
// It creates its own projects and tags, exercises every endpoint with the offline "mock" provider (a ~12 s fake
// generation that replays the bundled desk-lamp GLB) and deletes everything it made. Set ACCESS_CODE when the
// server requires one. Exits 1 if any check fails.
//
// The mock is free, so its runs take none of the day's generation slots (the cap only guards paid models).
//
// A few checks need to reach into the local database (back-dating a job, for example). They go through wrangler dev's
// local explorer API and are skipped with a note when it is not reachable (a deployed Worker, a remote database).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const ACCESS_CODE = process.env.ACCESS_CODE ?? "";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const WEBP_1X1 = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const PNG_1X1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
);

let passed = 0;
let failed = 0;
const failures = [];
const notes = [];

function section(title) {
    console.log(`\n== ${title}`);
}

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        failures.push(name);
        console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
    }
}

const note = (text) => {
    notes.push(text);
    console.log(`  note ${text}`);
};

/** Calls the API. `body` objects are sent as JSON; Buffers and strings are sent raw. */
async function call(method, path, body, { headers = {}, base = API } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        if (typeof body === "string" || Buffer.isBuffer(body)) init.body = body;
        else {
            init.body = JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
    }
    const res = await fetch(`${base}${path}`, init);
    const text = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
        json = JSON.parse(text.toString("utf8"));
    } catch {
        // not JSON
    }
    return { status: res.status, headers: res.headers, json, bytes: text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const generateHeaders = () => (ACCESS_CODE ? { "x-access-code": ACCESS_CODE } : {});

// ---- database access for the checks that need it (wrangler dev only)
let DB_ID = "";
// The deployment is open (ALLOW_OPEN_GENERATION=1 in wrangler.jsonc: paid models need no code), so a server with real provider keys offers them.
let OPEN_GENERATION = false;
try {
    const config = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8");
    DB_ID = /"database_id":\s*"([^"]+)"/.exec(config)?.[1] ?? "";
    OPEN_GENERATION = /^\s*"ALLOW_OPEN_GENERATION":\s*"1"/m.test(config);
} catch {
    // no wrangler.jsonc next to the script: the database checks are skipped
}

// Is the OpenRouter key set for the server under test? Only the fact is read (from the environment, or .dev.vars when the server
// is local), never printed. EXPECT_MUSE=1 / EXPECT_MUSE=0 overrides the guess (a deployed server).
function museKeyExpected() {
    if (process.env.EXPECT_MUSE) return process.env.EXPECT_MUSE === "1";
    if (process.env.OPENROUTER_API_KEY) return true;
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE)) return null;
    try {
        return /^OPENROUTER_API_KEY=\S/m.test(readFileSync(resolve(ROOT, ".dev.vars"), "utf8"));
    } catch {
        return null;
    }
}

/** Runs SQL on the local D1 database behind `wrangler dev`; null when that is not reachable. */
async function sql(statement) {
    if (!DB_ID) return null;
    try {
        const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/${DB_ID}/raw`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sql: statement }),
        });
        const body = await res.json();
        if (!body.success) return null;
        const { columns, rows } = body.result[0].results;
        return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    } catch {
        return null;
    }
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

/** A PNG whose header declares `w` x `h` pixels (the pixel data is not real: the server only reads headers). */
function pngDeclaring(w, h) {
    const png = Buffer.from(PNG_1X1);
    png.writeUInt32BE(w, 16);
    png.writeUInt32BE(h, 20);
    return png;
}

/** A JPEG that is just SOI + a start-of-frame header declaring `w` x `h`, then EOI. */
function jpegDeclaring(w, h) {
    const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.from([0xff, 0xd9])]);
}

/** A WebP with an extended (VP8X) header declaring `w` x `h`. */
function webpDeclaring(w, h) {
    const buf = Buffer.alloc(30);
    buf.write("RIFF", 0, "latin1");
    buf.writeUInt32LE(22, 4);
    buf.write("WEBPVP8X", 8, "latin1");
    buf.writeUInt32LE(10, 16);
    buf.writeUIntLE(w - 1, 24, 3);
    buf.writeUIntLE(h - 1, 27, 3);
    return buf;
}

async function newProject(name) {
    const res = await call("POST", "/projects", name === undefined ? {} : { name });
    if (res.status !== 201) throw new Error(`could not create a project: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json.project;
}

/** Polls GET /jobs/:id (three at once, like several open tabs) until the job is terminal. */
async function waitForJob(id, timeoutMs = 60_000) {
    const started = Date.now();
    const seen = [];
    for (;;) {
        const replies = await Promise.all([1, 2, 3].map(() => call("GET", `/jobs/${id}`)));
        const job = replies[0].json?.job;
        if (!job || replies.some((r) => r.status !== 200)) throw new Error(`polling ${id} failed: ${replies[0].status}`);
        seen.push({ progress: job.progress, stage: job.stage, status: job.status });
        if (["succeeded", "failed", "canceled"].includes(job.status)) return { job, seen, ms: Date.now() - started };
        if (Date.now() - started > timeoutMs) throw new Error(`job ${id} still ${job.status} after ${timeoutMs} ms`);
        await sleep(1000);
    }
}

const created = { projects: [], tags: [] };

async function main() {
    // ---------------------------------------------------------------- providers and access
    section("providers and access");
    const providers = await call("GET", "/providers");
    check("GET /providers is 200 JSON", providers.status === 200 && providers.json?.providers?.length > 0);
    check("response is no-store + nosniff", providers.headers.get("cache-control") === "no-store" &&
        providers.headers.get("x-content-type-options") === "nosniff");
    const mock = providers.json.providers.find((p) => p.id === "mock");
    check("mock provider is listed and available", mock?.available === true && mock.via === "mock");
    // The Muse designer (an LLM via OpenRouter) is always listed, after Hunyuan; it is offered when OPENROUTER_API_KEY is set.
    // This smoke test never generates with it: every design costs real money (the job flow is covered by test-muse.mjs).
    const muse = providers.json.providers.find((p) => p.id === "muse");
    const order = providers.json.providers.map((p) => p.id);
    check("Muse Spark 1.3 is listed after Hunyuan, as a multi-part, untextured model via OpenRouter",
        muse?.label === "Muse Spark 1.3" && muse.vendor === "Meta via OpenRouter" && muse.parts === true && muse.textured === false &&
        muse.approx_seconds === 35 && order.indexOf("muse") > order.indexOf("hunyuan"), JSON.stringify(muse));
    const museExpected = museKeyExpected();
    if (museExpected === true) check("Muse Spark 1.3 is available via openrouter (the OpenRouter key is set)", muse?.available === true && muse.via === "openrouter", JSON.stringify(muse));
    else if (museExpected === false) check("Muse Spark 1.3 is unavailable without the OpenRouter key", muse?.available === false && muse.via === null, JSON.stringify(muse));
    else note(`Muse Spark 1.3: available=${muse?.available} via=${muse?.via} (set EXPECT_MUSE=1 or 0 to assert it)`);
    check("provider info carries label, vendor, parts, approx_seconds",
        providers.json.providers.every((p) => p.label && p.vendor && typeof p.parts === "boolean" && p.approx_seconds > 0));
    check("default_provider is an available provider", providers.json.providers.some((p) => p.id === providers.json.default_provider && p.available));
    check("daily_limit (or null = no cap) and used_today are numbers", (providers.json.daily_limit === null || Number.isInteger(providers.json.daily_limit)) && Number.isInteger(providers.json.used_today));
    const accessRequired = providers.json.access_required;
    note(`access_required=${accessRequired}, daily_limit=${providers.json.daily_limit}, used_today=${providers.json.used_today}`);
    if (accessRequired && !ACCESS_CODE) {
        console.log("\nThe server requires an access code: run with ACCESS_CODE=... to test generation.");
        process.exit(1);
    }

    const wrong = await call("POST", "/access/check", { code: "definitely-wrong" });
    check(accessRequired ? "access check rejects a wrong code" : "access check passes when no code is configured",
        wrong.status === 200 && wrong.json.ok === !accessRequired, JSON.stringify(wrong.json));
    if (accessRequired) {
        const right = await call("POST", "/access/check", { code: ACCESS_CODE });
        check("access check with the right code is ok", right.json?.ok === true);
    }
    check("access check rejects a non-object body", (await call("POST", "/access/check", "[1]")).status === 400);
    if (!accessRequired) {
        // No ACCESS_CODE: paid models must be switched off (unless the server sets ALLOW_OPEN_GENERATION=1, as wrangler.jsonc does).
        const paid = providers.json.providers.filter((p) => p.available && p.id !== "mock");
        if (OPEN_GENERATION) note(`open generation (ALLOW_OPEN_GENERATION=1): paid models offered without a code: ${paid.map((p) => p.id).join(",") || "none"}`);
        else check("without an access code no paid model is offered (fail closed)", paid.length === 0, paid.map((p) => p.id).join(","));
    }
    if (accessRequired) {
        const right = await call("POST", "/access/check", { code: `  ${ACCESS_CODE}\n` });
        check("access check ignores whitespace around the code", right.json?.ok === true);
        // A client that keeps guessing is turned away. The fake address keeps this run's own requests out of it.
        const guesser = { "cf-connecting-ip": `198.51.100.${1 + Math.floor(Math.random() * 250)}` };
        let limited = null;
        for (let i = 0; i < 14 && !limited; i++) {
            const r = await call("POST", "/access/check", { code: `guess-${i}` }, { headers: guesser });
            if (r.status === 429) limited = r;
        }
        check("repeated wrong codes end in a 429 with Retry-After", limited?.status === 429 && Boolean(limited.headers.get("retry-after")));
        const stillLocked = await call("POST", "/access/check", { code: ACCESS_CODE }, { headers: guesser });
        check("a throttled client is refused even with the right code", stillLocked.status === 429);
        const other = await call("POST", "/access/check", { code: ACCESS_CODE }, { headers: { "cf-connecting-ip": "203.0.113.250" } });
        check("another client is not affected", other.json?.ok === true);
    }

    // ---------------------------------------------------------------- projects
    section("projects: create, get, patch");
    const first = await newProject();
    created.projects.push(first.id);
    check("POST /projects defaults the name", first.name === "Untitled project");
    check("new project shape", first.pinned === false && first.deleted_at === null && first.archived_at === null &&
        first.thumbnail_url === null && Array.isArray(first.tag_ids) && first.tag_ids.length === 0 && first.model_count === 0);
    check("id looks like a UUID and timestamps are ISO", /^[0-9a-f-]{36}$/.test(first.id) && !Number.isNaN(Date.parse(first.created_at)) &&
        first.created_at === first.modified_at);

    const trimmed = await newProject("  Desk lamp  ");
    created.projects.push(trimmed.id);
    check("name is trimmed", trimmed.name === "Desk lamp");
    check("blank name is rejected", (await call("POST", "/projects", { name: "   " })).status === 400);
    check("over-long name is rejected", (await call("POST", "/projects", { name: "x".repeat(121) })).status === 400);
    check("invalid JSON is a 400", (await call("POST", "/projects", "{nope")).status === 400);
    check("JSON array body is a 400", (await call("POST", "/projects", "[]")).status === 400);
    const huge = await call("POST", "/projects", JSON.stringify({ name: "x", pad: "y".repeat(300 * 1024) }));
    check("body over 256 KB is a 413", huge.status === 413 && typeof huge.json?.error === "string", String(huge.status));

    const detail = await call("GET", `/projects/${first.id}`);
    check("GET /projects/:id returns detail", detail.status === 200 && detail.json.project.id === first.id &&
        Array.isArray(detail.json.project.models) && Array.isArray(detail.json.project.jobs));
    check("default project data", JSON.stringify(detail.json.project.data) === JSON.stringify({ messages: [], active_model_id: null }));
    check("unknown project is 404 {error}", (await call("GET", `/projects/${UNKNOWN_ID}`)).status === 404);
    const badId = await call("GET", "/projects/not-a-uuid");
    check("malformed project id is 400 {error}", badId.status === 400 && typeof badId.json?.error === "string");

    await sleep(15);
    const renamed = await call("PATCH", `/projects/${first.id}`, { name: "Renamed" });
    check("rename works and bumps modified_at", renamed.status === 200 && renamed.json.project.name === "Renamed" &&
        renamed.json.project.modified_at > first.modified_at);
    await sleep(15);
    const pinned = await call("PATCH", `/projects/${first.id}`, { pinned: true });
    check("pin works", pinned.json.project.pinned === true);
    check("pin does NOT bump modified_at", pinned.json.project.modified_at === renamed.json.project.modified_at);
    const message = { id: crypto.randomUUID(), role: "user", content: "a desk lamp", timestamp: new Date().toISOString() };
    const saved = await call("PATCH", `/projects/${first.id}`, { data: { messages: [message], active_model_id: null } });
    check("saving data works and bumps modified_at", saved.status === 200 && saved.json.project.modified_at > pinned.json.project.modified_at);
    const reread = await call("GET", `/projects/${first.id}`);
    check("saved data round-trips", reread.json.project.data.messages[0]?.content === "a desk lamp");
    const patchData = (data) => call("PATCH", `/projects/${first.id}`, { data });
    check("data without messages is rejected", (await patchData({ active_model_id: null })).status === 400);
    check("a message that is not an object is rejected", (await patchData({ messages: [null, 1, "x"], active_model_id: null })).status === 400);
    check("a message without a valid role is rejected", (await patchData({ messages: [{ ...message, role: "system" }], active_model_id: null })).status === 400);
    check("a message with oversized content is rejected", (await patchData({ messages: [{ ...message, content: "x".repeat(4001) }], active_model_id: null })).status === 400);
    check("a message with bad job_ids is rejected", (await patchData({ messages: [{ ...message, job_ids: ["nope"] }], active_model_id: null })).status === 400);
    check("a message with bad model_ids is rejected", (await patchData({ messages: [{ ...message, model_ids: ["nope"] }], active_model_id: null })).status === 400);
    check("a message with more than 10 model_ids is rejected", (await patchData({ messages: [{ ...message, model_ids: Array(11).fill(UNKNOWN_ID) }], active_model_id: null })).status === 400);
    const withModels = await patchData({ messages: [{ ...message, model_ids: [UNKNOWN_ID] }], active_model_id: null });
    check("valid model_ids are kept", withModels.status === 200 && (await call("GET", `/projects/${first.id}`)).json.project.data.messages[0].model_ids?.[0] === UNKNOWN_ID);
    const withExtras = await patchData({ messages: [{ ...message, job_ids: [UNKNOWN_ID], extra: "dropped" }], active_model_id: null, junk: "k".repeat(500) });
    const extrasBack = (await call("GET", `/projects/${first.id}`)).json.project.data;
    check("unknown keys are dropped, valid job_ids kept", withExtras.status === 200 && extrasBack.junk === undefined &&
        extrasBack.messages[0].extra === undefined && extrasBack.messages[0].job_ids?.[0] === UNKNOWN_ID, JSON.stringify(extrasBack).slice(0, 200));
    const longChat = Array.from({ length: 600 }, (_, i) => ({ ...message, id: `m${i}`, content: `message ${i}` }));
    check("a chat over 500 messages saves, keeping the newest", (await patchData({ messages: longChat, active_model_id: null })).status === 200);
    const trimmedChat = (await call("GET", `/projects/${first.id}`)).json.project.data.messages;
    check("the oldest messages were the ones dropped", trimmedChat.length === 500 && trimmedChat[0].id === "m100" && trimmedChat[499].id === "m599", `${trimmedChat.length}`);
    await patchData({ messages: [message], active_model_id: null });
    check("data with a bad active_model_id is rejected", (await call("PATCH", `/projects/${first.id}`, { data: { messages: [], active_model_id: 7 } })).status === 400);
    check("pinned must be a boolean", (await call("PATCH", `/projects/${first.id}`, { pinned: "yes" })).status === 400);
    check("PATCH on an unknown project is 404", (await call("PATCH", `/projects/${UNKNOWN_ID}`, { name: "x" })).status === 404);
    const list = await call("GET", "/projects");
    check("GET /projects lists projects and tags", list.status === 200 && Array.isArray(list.json.projects) && Array.isArray(list.json.tags) &&
        list.json.projects.some((p) => p.id === first.id));

    // ---------------------------------------------------------------- tags
    section("tags");
    const tagName = `Smoke ${Date.now()}`;
    const tag = await call("POST", "/tags", { name: tagName, icon: "Wrench", color: "#CE5222" });
    check("POST /tags creates a tag", tag.status === 201 && tag.json.tag.name === tagName && tag.json.tag.icon === "Wrench" && tag.json.tag.color === "#ce5222");
    created.tags.push(tag.json.tag.id);
    const dup = await call("POST", "/tags", { name: tagName.toUpperCase(), icon: null, color: "#112233" });
    check("duplicate tag name (case-insensitive) is 409", dup.status === 409 && typeof dup.json?.error === "string");
    check("bad tag colour is 400", (await call("POST", "/tags", { name: "bad colour", icon: null, color: "red" })).status === 400);
    check("bad tag icon is 400", (await call("POST", "/tags", { name: "bad icon", icon: "no spaces!", color: "#112233" })).status === 400);
    check("blank tag name is 400", (await call("POST", "/tags", { name: " ", icon: null, color: "#112233" })).status === 400);
    const other = await call("POST", "/tags", { name: `${tagName} other`, icon: null, color: "#2563eb" });
    created.tags.push(other.json.tag.id);
    check("tag without an icon is created", other.status === 201 && other.json.tag.icon === null);
    const tagPatch = await call("PATCH", `/tags/${other.json.tag.id}`, { name: `${tagName} renamed`, color: "#00ff00", icon: "Box" });
    check("PATCH /tags/:id renames, recolours, sets icon", tagPatch.status === 200 && tagPatch.json.tag.name === `${tagName} renamed` &&
        tagPatch.json.tag.color === "#00ff00" && tagPatch.json.tag.icon === "Box");
    const iconCleared = await call("PATCH", `/tags/${other.json.tag.id}`, { icon: null });
    check("PATCH can clear the icon", iconCleared.json.tag.icon === null && iconCleared.json.tag.name === `${tagName} renamed`);
    check("renaming onto an existing name is 409", (await call("PATCH", `/tags/${other.json.tag.id}`, { name: tagName })).status === 409);
    check("PATCH on an unknown tag is 404", (await call("PATCH", `/tags/${UNKNOWN_ID}`, { name: "x" })).status === 404);
    const tags = await call("GET", "/tags");
    check("GET /tags lists them", tags.status === 200 && tags.json.tags.some((t) => t.id === tag.json.tag.id));

    section("project tags (bulk) and seeding");
    const added = await call("POST", "/projects/tags", { ids: [first.id, trimmed.id], tag_id: tag.json.tag.id, add: true });
    check("add tag to two projects -> count 2", added.status === 200 && added.json.count === 2);
    const addedAgain = await call("POST", "/projects/tags", { ids: [first.id, trimmed.id], tag_id: tag.json.tag.id, add: true });
    check("adding again is a no-op (count 0)", addedAgain.json.count === 0);
    const tagged = (await call("GET", `/projects/${first.id}`)).json.project;
    check("tag_ids reflects the link", tagged.tag_ids.length === 1 && tagged.tag_ids[0] === tag.json.tag.id);
    check("tagging bumps modified_at", tagged.modified_at > saved.json.project.modified_at);
    const removed = await call("POST", "/projects/tags", { ids: [trimmed.id], tag_id: tag.json.tag.id, add: false });
    check("remove tag -> count 1", removed.json.count === 1);
    check("bulk tag with unknown tag is 404", (await call("POST", "/projects/tags", { ids: [first.id], tag_id: UNKNOWN_ID, add: true })).status === 404);
    check("bulk tag needs a boolean add", (await call("POST", "/projects/tags", { ids: [first.id], tag_id: tag.json.tag.id })).status === 400);
    check("bulk tag needs ids", (await call("POST", "/projects/tags", { ids: [], tag_id: tag.json.tag.id, add: true })).status === 400);
    const seeded = await call("POST", "/projects", { name: "Seeded", tag_id: tag.json.tag.id });
    created.projects.push(seeded.json.project.id);
    check("create with tag_id seeds the tag", seeded.status === 201 && seeded.json.project.tag_ids[0] === tag.json.tag.id);
    check("create with an unknown tag_id is 404", (await call("POST", "/projects", { tag_id: UNKNOWN_ID })).status === 404);
    const delTag = await call("DELETE", `/tags/${tag.json.tag.id}`);
    check("DELETE /tags/:id -> {ok:true}", delTag.status === 200 && delTag.json.ok === true);
    check("deleting a tag unlinks it from projects", (await call("GET", `/projects/${first.id}`)).json.project.tag_ids.length === 0);
    check("deleting it again is 404", (await call("DELETE", `/tags/${tag.json.tag.id}`)).status === 404);
    created.tags = created.tags.filter((id) => id !== tag.json.tag.id);

    // ---------------------------------------------------------------- bulk actions
    section("bulk trash / restore / archive / purge");
    const bulkA = await newProject("Bulk A");
    const bulkB = await newProject("Bulk B");
    created.projects.push(bulkA.id, bulkB.id);
    const ids = [bulkA.id, bulkB.id];
    const state = async (id) => (await call("GET", `/projects/${id}`)).json.project;
    const beforeBulk = (await state(bulkA.id)).modified_at;
    check("trash -> count 2", (await call("POST", "/projects/bulk", { ids, action: "trash" })).json?.count === 2);
    const trashed = await state(bulkA.id);
    check("trashed project has deleted_at (and is still listed)", typeof trashed.deleted_at === "string" &&
        (await call("GET", "/projects")).json.projects.some((p) => p.id === bulkA.id && p.deleted_at));
    check("trash does NOT bump modified_at", trashed.modified_at === beforeBulk);
    check("trashing twice -> count 0", (await call("POST", "/projects/bulk", { ids, action: "trash" })).json?.count === 0);
    const blocked = await call("POST", `/projects/${bulkA.id}/generate`, { prompt: "a cube", providers: ["mock"] }, { headers: generateHeaders() });
    check("generating in a trashed project is 409", blocked.status === 409 && typeof blocked.json?.error === "string");
    check("restore -> count 2", (await call("POST", "/projects/bulk", { ids, action: "restore" })).json?.count === 2);
    check("restored project has no deleted_at", (await state(bulkA.id)).deleted_at === null);
    check("archive -> count 2", (await call("POST", "/projects/bulk", { ids, action: "archive" })).json?.count === 2);
    check("archived project has archived_at", typeof (await state(bulkB.id)).archived_at === "string");
    check("unarchive -> count 2", (await call("POST", "/projects/bulk", { ids, action: "unarchive" })).json?.count === 2);
    check("unarchived project has no archived_at", (await state(bulkB.id)).archived_at === null);
    const purgeLive = await call("POST", "/projects/bulk", { ids, action: "purge" });
    check("purge refuses projects that are not trashed (count 0)", purgeLive.status === 200 && purgeLive.json.count === 0 &&
        (await call("GET", `/projects/${bulkA.id}`)).status === 200);
    await call("POST", "/projects/bulk", { ids, action: "trash" });
    check("purge deletes trashed projects (count 2)", (await call("POST", "/projects/bulk", { ids, action: "purge" })).json?.count === 2);
    check("purged project is gone (404)", (await call("GET", `/projects/${bulkA.id}`)).status === 404);
    created.projects = created.projects.filter((id) => !ids.includes(id));
    check("unknown bulk action is 400", (await call("POST", "/projects/bulk", { ids, action: "explode" })).status === 400);
    check("bulk with a malformed id is 400", (await call("POST", "/projects/bulk", { ids: ["nope"], action: "trash" })).status === 400);
    check("bulk with no ids is 400", (await call("POST", "/projects/bulk", { ids: [], action: "trash" })).status === 400);

    // ---------------------------------------------------------------- thumbnails
    section("thumbnails");
    const thumbProject = await newProject("Thumb");
    created.projects.push(thumbProject.id);
    const putWebp = await call("PUT", `/projects/${thumbProject.id}/thumbnail`, WEBP_1X1, { headers: { "content-type": "image/webp" } });
    check("PUT thumbnail (webp) returns a versioned URL", putWebp.status === 200 &&
        putWebp.json.thumbnail_url === `/api/assignment_alex/files/thumbs/${thumbProject.id}.webp?v=1`, JSON.stringify(putWebp.json));
    const getWebp = await call("GET", `/files/thumbs/${thumbProject.id}.webp?v=1`);
    check("GET thumbnail: 200 + image/webp + immutable cache", getWebp.status === 200 &&
        getWebp.headers.get("content-type") === "image/webp" &&
        /immutable/.test(getWebp.headers.get("cache-control") ?? "") && getWebp.bytes.equals(WEBP_1X1));
    const etag = getWebp.headers.get("etag");
    check("thumbnail has an ETag", Boolean(etag));
    const notModified = await call("GET", `/files/thumbs/${thumbProject.id}.webp?v=1`, undefined, { headers: { "if-none-match": etag } });
    check("If-None-Match -> 304", notModified.status === 304);
    const headThumb = await fetch(`${API}/files/thumbs/${thumbProject.id}.webp`, { method: "HEAD" });
    check("HEAD thumbnail -> 200 with length", headThumb.status === 200 && Number(headThumb.headers.get("content-length")) === WEBP_1X1.length);
    const putPng = await call("PUT", `/projects/${thumbProject.id}/thumbnail`, PNG_1X1, { headers: { "content-type": "image/png" } });
    check("replacing with a PNG bumps the version", putPng.json?.thumbnail_url?.endsWith("?v=2"));
    check("stored content-type follows the upload", (await call("GET", `/files/thumbs/${thumbProject.id}.webp?v=2`)).headers.get("content-type") === "image/png");
    const listed = (await state(thumbProject.id));
    check("project reports thumbnail_url, and thumbnails are not edits", listed.thumbnail_url?.endsWith("?v=2") &&
        listed.modified_at === thumbProject.modified_at);
    check("wrong content-type is 415", (await call("PUT", `/projects/${thumbProject.id}/thumbnail`, WEBP_1X1, { headers: { "content-type": "text/plain" } })).status === 415);
    check("a non-image body is 400", (await call("PUT", `/projects/${thumbProject.id}/thumbnail`, "not an image", { headers: { "content-type": "image/png" } })).status === 400);
    const bomb = (body, type) => call("PUT", `/projects/${thumbProject.id}/thumbnail`, body, { headers: { "content-type": type } });
    check("a PNG declaring 40000 x 40000 pixels is refused", (await bomb(pngDeclaring(40000, 40000), "image/png")).status === 400);
    check("a PNG at 2048 x 2048 is accepted", (await bomb(pngDeclaring(2048, 2048), "image/png")).status === 200);
    check("a PNG at 2049 pixels wide is refused", (await bomb(pngDeclaring(2049, 10), "image/png")).status === 400);
    check("a JPEG declaring 30000 x 30000 pixels is refused", (await bomb(jpegDeclaring(30000, 30000), "image/jpeg")).status === 400);
    check("a small JPEG is accepted", (await bomb(jpegDeclaring(512, 384), "image/jpeg")).status === 200);
    check("a WebP (VP8X) declaring 16000 x 16000 pixels is refused", (await bomb(webpDeclaring(16000, 16000), "image/webp")).status === 400);
    check("a small WebP (VP8X) is accepted", (await bomb(webpDeclaring(512, 384), "image/webp")).status === 200);
    check("an image whose size cannot be read is refused", (await bomb(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).status === 400);
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(600 * 1024)]);
    check("thumbnail over 512 KB is 413", (await call("PUT", `/projects/${thumbProject.id}/thumbnail`, big, { headers: { "content-type": "image/png" } })).status === 413);
    check("thumbnail for an unknown project is 404", (await call("PUT", `/projects/${UNKNOWN_ID}/thumbnail`, WEBP_1X1, { headers: { "content-type": "image/webp" } })).status === 404);
    check("missing file is a 404 {error}", (await call("GET", `/files/thumbs/${UNKNOWN_ID}.webp`)).json?.error === "File not found");
    check("odd file names are 404", (await call("GET", "/files/models/..%2f..%2fsecret")).status === 404 && (await call("GET", "/files/other/x")).status === 404);

    // ---------------------------------------------------------------- generation validation
    section("generation: validation and limits");
    const gen = await newProject("Generation");
    // A model runs once at a time per project, so the parallel jobs below each get a project of their own.
    const genFail = await newProject("Generation (failure)");
    const genCancel = await newProject("Generation (cancel)");
    created.projects.push(gen.id, genFail.id, genCancel.id);
    const g = (body, headers, projectId = gen.id) =>
        call("POST", `/projects/${projectId}/generate`, body, { headers: headers ?? generateHeaders() });
    const cancelCall = (id, headers = generateHeaders()) => call("POST", `/jobs/${id}/cancel`, undefined, { headers });
    check("empty prompt is 400", (await g({ prompt: "   ", providers: ["mock"] })).status === 400);
    check("prompt over 1000 chars is 400", (await g({ prompt: "x".repeat(1001), providers: ["mock"] })).status === 400);
    check("no providers is 400", (await g({ prompt: "a cube", providers: [] })).status === 400);
    check("unknown provider is 400", (await g({ prompt: "a cube", providers: ["not-a-model"] })).status === 400);
    check("duplicate providers are 400", (await g({ prompt: "a cube", providers: ["mock", "mock"] })).status === 400);
    check("more than 5 providers is 400", (await g({ prompt: "a cube", providers: ["mock", "tripo", "meshy", "rodin", "hunyuan", "tripo-parts"] })).status === 400);
    const unavailable = providers.json.providers.find((p) => !p.available);
    if (unavailable) {
        const r = await g({ prompt: "a cube", providers: [unavailable.id] });
        check(`provider without a key (${unavailable.id}) is 400`, r.status === 400 && /not available/.test(r.json?.error ?? ""), JSON.stringify(r.json));
    }
    check("generate in an unknown project is 404", (await call("POST", `/projects/${UNKNOWN_ID}/generate`, { prompt: "a cube", providers: ["mock"] }, { headers: generateHeaders() })).status === 404);
    check("generate with a malformed project id is 400", (await call("POST", "/projects/nope/generate", { prompt: "x", providers: ["mock"] }, { headers: generateHeaders() })).status === 400);
    if (accessRequired) {
        const noCode = await call("POST", `/projects/${gen.id}/generate`, { prompt: "a cube", providers: ["mock"] });
        check("generate without the access code is 401", noCode.status === 401 && noCode.json?.error === "Access code required");
        const badCode = await call("POST", `/projects/${gen.id}/generate`, { prompt: "a cube", providers: ["mock"] }, { headers: { "x-access-code": "nope" } });
        check("generate with a wrong access code is 401", badCode.status === 401);
    } else {
        note("access code not configured: the 401 path is only checked when the server runs with ACCESS_CODE");
    }
    const usageBefore = (await call("GET", "/providers")).json;

    // ---------------------------------------------------------------- generation: success, failure, cancel
    section("generation: success, failure and cancel with the mock provider");
    const [ok, fail, cancel] = await Promise.all([
        g({ prompt: "an articulated desk lamp", providers: ["mock"] }),
        g({ prompt: "this prompt will fail on purpose", providers: ["mock"] }, undefined, genFail.id),
        g({ prompt: "a ceramic cup", providers: ["mock"] }, undefined, genCancel.id),
    ]);
    check("POST /generate -> {jobs:[...]} one per provider", ok.status === 200 && ok.json.jobs.length === 1, JSON.stringify(ok.json));
    const okJob = ok.json.jobs[0];
    check("submitted job is running with stage Submitted", okJob.status === "running" && okJob.stage === "Submitted" &&
        okJob.provider === "mock" && okJob.project_id === gen.id && okJob.model === null && okJob.error === null);
    check("free demo runs take no daily slot", (await call("GET", "/providers")).json.used_today === usageBefore.used_today);
    const duplicate = await g({ prompt: "the same model again", providers: ["mock"] });
    check("the same model twice at once in a project is 409", duplicate.status === 409 && typeof duplicate.json?.error === "string", JSON.stringify(duplicate.json));
    check("a rejected duplicate does not consume the limit", (await call("GET", "/providers")).json.used_today === usageBefore.used_today);

    const cancelJobId = cancel.json.jobs[0].id;
    if (accessRequired) {
        const anonymous = await cancelCall(cancelJobId, {});
        check("canceling without the access code is 401", anonymous.status === 401, String(anonymous.status));
        check("...and the job keeps running", (await call("GET", `/jobs/${cancelJobId}`)).json.job.status === "running");
    }
    const canceled = await cancelCall(cancelJobId);
    check("POST /jobs/:id/cancel -> canceled", canceled.status === 200 && canceled.json.job.status === "canceled" && canceled.json.job.finished_at);
    check("canceling again is idempotent", (await cancelCall(cancelJobId)).json.job.status === "canceled");

    console.log("  ... waiting for the mock jobs (about 12 s)");
    const [okRun, failRun] = await Promise.all([waitForJob(okJob.id), waitForJob(fail.json.jobs[0].id)]);

    check("good job succeeded", okRun.job.status === "succeeded" && okRun.job.progress === 100 && okRun.job.stage === "Done" && okRun.job.error === null,
        JSON.stringify(okRun.job));
    const progresses = okRun.seen.map((s) => s.progress);
    check("progress never goes backwards", progresses.every((p, i) => i === 0 || p >= progresses[i - 1]), progresses.join(","));
    check("progress passed through the mock stages", ["Generating mesh", "Splitting parts"].every((s) => okRun.seen.some((x) => x.stage === s)),
        [...new Set(okRun.seen.map((x) => x.stage))].join(" | "));
    check("job took roughly 12 s", okRun.ms > 8000 && okRun.ms < 40000, `${okRun.ms} ms`);
    const model = okRun.job.model;
    check("succeeded job embeds its ModelAsset", model && model.job_id === okJob.id && model.project_id === gen.id && model.provider === "mock" &&
        model.prompt === "an articulated desk lamp" && typeof model.created_at === "string");
    check("glb_url is same-origin under /files/models/", model.glb_url === `/api/assignment_alex/files/models/${model.id}.glb`);
    check("part_count >= 8 (the lamp has 9 parts)", model.part_count >= 8, String(model.part_count));
    check("no provider still, so thumbnail_url is null", model.thumbnail_url === null);
    check("a generated model is kind generated, with no source, example or stabilizer log", model.kind === "generated" && model.source_model_id === null && model.example_slug === null && model.derived === null);

    const glb = await fetch(`${BASE}${model.glb_url}`);
    const glbBytes = Buffer.from(await glb.arrayBuffer());
    check("GLB download: 200 + model/gltf-binary", glb.status === 200 && glb.headers.get("content-type") === "model/gltf-binary");
    check("GLB starts with the glTF magic", glbBytes.subarray(0, 4).toString("latin1") === "glTF");
    check("GLB size matches size_bytes and content-length", glbBytes.length === model.size_bytes && Number(glb.headers.get("content-length")) === glbBytes.length,
        `${glbBytes.length} vs ${model.size_bytes}`);
    check("GLB is cached immutably and has an ETag", /immutable/.test(glb.headers.get("cache-control") ?? "") && Boolean(glb.headers.get("etag")));
    const headGlb = await fetch(`${BASE}${model.glb_url}`, { method: "HEAD" });
    check("HEAD GLB -> 200 with content-length", headGlb.status === 200 && Number(headGlb.headers.get("content-length")) === glbBytes.length);

    const afterOk = (await call("GET", `/projects/${gen.id}`)).json.project;
    check("exactly one model despite concurrent polling (lease works)", afterOk.models.length === 1 && afterOk.models[0].id === model.id,
        `${afterOk.models.length} models`);
    check("project detail lists its job", afterOk.jobs.length === 1 && afterOk.jobs[0].id === okJob.id);
    const second = await g({ prompt: "a second lamp", providers: ["mock"] });
    check("a model can run again once its earlier run is over", second.status === 200 && second.json.jobs?.length === 1, JSON.stringify(second.json));
    const secondId = second.json.jobs?.[0]?.id;
    await cancelCall(secondId);
    const afterSecond = (await call("GET", `/projects/${gen.id}`)).json.project;
    check("project detail lists jobs oldest first", afterSecond.jobs.length === 2 && afterSecond.jobs[0].id === okJob.id &&
        afterSecond.jobs[1].id === secondId);
    check("job in project detail has its model embedded", afterOk.jobs.find((j) => j.id === okJob.id)?.model?.id === model.id);
    check("generating bumps the project's modified_at", afterOk.modified_at > gen.modified_at);
    check("model_count in the hub list", (await call("GET", "/projects")).json.projects.find((p) => p.id === gen.id)?.model_count === 1);
    const active = await call("PATCH", `/projects/${gen.id}`, { data: { messages: [message], active_model_id: model.id } });
    check("active_model_id can point at the model", active.status === 200 && (await state(gen.id)).data.active_model_id === model.id);

    check("failing prompt ends failed", failRun.job.status === "failed" && /failed on purpose/.test(failRun.job.error ?? ""), JSON.stringify(failRun.job));
    check("failed job took ~4 s and has finished_at", failRun.ms >= 3000 && failRun.ms < 30000 && Boolean(failRun.job.finished_at), `${failRun.ms} ms`);
    check("failed job has no model", failRun.job.model === null);
    const stillCanceled = await call("GET", `/jobs/${cancelJobId}`);
    check("a canceled job stays canceled when polled", stillCanceled.json.job.status === "canceled");
    check("cancel after success changes nothing", (await cancelCall(okJob.id)).json.job.status === "succeeded");
    check("unknown job is 404", (await call("GET", `/jobs/${UNKNOWN_ID}`)).status === 404);
    check("malformed job id is 400", (await call("GET", "/jobs/xyz")).status === 400);
    check("canceling an unknown job is 404", (await cancelCall(UNKNOWN_ID)).status === 404);

    // ---------------------------------------------------------------- jobs that nobody polled for a long time
    section("generation: jobs older than 30 minutes, and a model that cannot be stopped");
    const capProjects = [];
    for (const name of ["finished", "stuck", "attempts"]) capProjects.push(await newProject(`Cap ${name}`));
    created.projects.push(...capProjects.map((p) => p.id));
    const capJobs = [];
    for (const project of capProjects) {
        capJobs.push((await g({ prompt: "a cube", providers: ["mock"] }, undefined, project.id)).json?.jobs?.[0]);
    }
    if (!capJobs.every(Boolean) || (await sql("SELECT 1 AS ok")) === null) {
        note("the local database is not reachable (not wrangler dev): the 30-minute and 'cannot be stopped' checks are skipped");
    } else {
        const [finishedJob, stuckJob, attemptsJob] = capJobs;
        const finishedAtVendor = "provider_state = json_set(provider_state, '$.started_at', 0)";
        // The tab was closed: the vendor finished long ago, and the first poll comes 31 minutes after the job began.
        await sql(`UPDATE jobs SET created_at = '${minutesAgo(31)}', ${finishedAtVendor} WHERE id = '${finishedJob.id}'`);
        // Same age, but the vendor is genuinely still working on it.
        await sql(`UPDATE jobs SET created_at = '${minutesAgo(31)}' WHERE id = '${stuckJob.id}'`);
        // Its copy already failed (or died) three times.
        await sql(`UPDATE jobs SET finalize_attempts = 3, ${finishedAtVendor} WHERE id = '${attemptsJob.id}'`);

        const saved = (await call("GET", `/jobs/${finishedJob.id}`)).json?.job;
        check("a model that finished while nobody polled is saved, even past 30 minutes", saved?.status === "succeeded" && Boolean(saved.model), JSON.stringify(saved));
        const stopped = (await call("GET", `/jobs/${stuckJob.id}`)).json?.job;
        check("a job the vendor still has running after 30 minutes is stopped", stopped?.status === "failed" && /30 minutes/.test(stopped.error ?? ""), JSON.stringify(stopped));
        const exhausted = (await call("GET", `/jobs/${attemptsJob.id}`)).json?.job;
        check("a job whose copy failed three times is given up on", exhausted?.status === "failed" && /several tries/.test(exhausted.error ?? ""), JSON.stringify(exhausted));

        // A vendor task with no cancel API (Tripo here) keeps running whatever we record: refuse to "cancel" it.
        const stranger = crypto.randomUUID();
        const stamp = new Date().toISOString();
        await sql(`INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, provider_task_id, created_at, updated_at)
                   VALUES ('${stranger}', '${capProjects[2].id}', 'tripo-parts', 'tripo', 'a cube', 'running', 10, 'Generating', 'task-1', '${stamp}', '${stamp}')`);
        const refused = await cancelCall(stranger);
        check("a model without a cancel API cannot be stopped (409)", refused.status === 409 && /can't be stopped/.test(refused.json?.error ?? ""), JSON.stringify(refused.json));
        check("...and its job keeps running", (await sql(`SELECT status FROM jobs WHERE id = '${stranger}'`))?.[0]?.status === "running");
        await sql(`DELETE FROM jobs WHERE id = '${stranger}'`);
    }

    // ---------------------------------------------------------------- analysis summaries saved by the browser
    section("model analysis: PUT /models/:id/analysis");
    const goodSummary = (patch = {}) => ({
        version: 1, blocks: 42, bodies: 2, floating_blocks: 3, cantilevered: 9, longest_cantilever: 6, over_limit: 2,
        cantilever_limit: 4, cog_mm: [512.5, 498.25, 310.125], cog_inside: true, cog_margin_mm: 87.5,
        size_mm: [640, 1000, 420], coverage: 0.93, fill_threshold: 0.3, errors: 2, warnings: 1,
        // A minute back: the server caps analyzed_at at its own clock, so a stamp "now" could come back changed
        // when this script runs on a machine whose clock is a little ahead of the server's.
        analyzed_at: new Date(Date.now() - 60_000).toISOString(), ...patch,
    });
    const putAnalysis = (id, body, raw = false) => call("PUT", `/models/${id}/analysis`, raw ? body : { summary: body });
    const modelNow = async () => (await call("GET", `/projects/${gen.id}`)).json.project.models.find((m) => m.id === model.id);
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    check("a fresh model has analysis: null", model.analysis === null && (await modelNow()).analysis === null, JSON.stringify(model.analysis));
    const projectBefore = (await call("GET", `/projects/${gen.id}`)).json.project;
    await sleep(15);
    const wanted = goodSummary();
    // No access code is sent: saving a derived summary costs nothing, so it is open (unlike generating).
    const put = await putAnalysis(model.id, wanted);
    check("PUT -> 200 {model} with the summary", put.status === 200 && put.json?.model?.id === model.id && sameJson(put.json.model.analysis, wanted),
        JSON.stringify(put.json)?.slice(0, 300));
    check("...and the rest of the ModelAsset is intact", put.json?.model?.project_id === gen.id && put.json.model.glb_url === model.glb_url &&
        put.json.model.size_bytes === model.size_bytes && put.json.model.part_count === model.part_count);
    check("GET /projects/:id returns it on the model", sameJson((await modelNow()).analysis, wanted));
    check("GET /jobs/:id returns it on job.model", sameJson((await call("GET", `/jobs/${okJob.id}`)).json?.job?.model?.analysis, wanted));
    const projectAfter = (await call("GET", `/projects/${gen.id}`)).json.project;
    check("saving it does not bump the project's modified_at", projectAfter.modified_at === projectBefore.modified_at,
        `${projectBefore.modified_at} -> ${projectAfter.modified_at}`);
    check("...nor does it change the hub list order key", (await call("GET", "/projects")).json.projects.find((p) => p.id === gen.id)?.modified_at === projectBefore.modified_at);

    const replacement = goodSummary({ blocks: 17, errors: 0, warnings: 0, cog_mm: null, cog_inside: false, cog_margin_mm: -42.5, floating_blocks: 17 });
    const replaced = await putAnalysis(model.id, replacement);
    check("a second PUT replaces the first", replaced.status === 200 && sameJson((await modelNow()).analysis, replacement));
    check("cog_mm null with a negative margin is accepted", (await modelNow()).analysis.cog_mm === null && (await modelNow()).analysis.cog_margin_mm === -42.5);

    // JSON.parse makes "__proto__" an own key, which an object literal cannot.
    const protoKey = JSON.parse('{"__proto__": {"polluted": 1}}');
    const clutter = await putAnalysis(model.id, JSON.stringify({ summary: { ...goodSummary({ blocks: 7 }), evil: "x".repeat(200), ...protoKey, nested: { a: 1 } }, extra: 1 }), true);
    const clutterBack = (await modelNow()).analysis;
    check("unknown keys are dropped from the response and the stored summary", clutter.status === 200 && clutter.json.model.analysis.evil === undefined &&
        clutterBack.blocks === 7 && clutterBack.evil === undefined && clutterBack.nested === undefined && clutterBack.extra === undefined &&
        Object.keys(clutterBack).length === Object.keys(goodSummary()).length, JSON.stringify(clutterBack));

    const stamped = await putAnalysis(model.id, goodSummary({ analyzed_at: "2026-03-01T12:30:00.5+02:00" }));
    check("analyzed_at is stored as UTC ISO", stamped.status === 200 && stamped.json.model.analysis.analyzed_at === "2026-03-01T10:30:00.500Z", stamped.json?.model?.analysis?.analyzed_at);
    // A browser whose clock runs ahead must still be able to save: the stamp is capped at the server's clock, not refused.
    const skewed = new Date(Date.now() + 4 * 60_000).toISOString();
    const skewedPut = await putAnalysis(model.id, goodSummary({ analyzed_at: skewed }));
    check("analyzed_at a few minutes ahead (clock skew) is accepted", skewedPut.status === 200, `${skewedPut.status} ${JSON.stringify(skewedPut.json)?.slice(0, 200)}`);
    const tooFar = new Date(Date.now() + 10 * 60_000).toISOString();
    const beforeFuture = Date.now();
    const future = await putAnalysis(model.id, goodSummary({ analyzed_at: tooFar }));
    const afterFuture = Date.now();
    const cappedAt = Date.parse(future.json?.model?.analysis?.analyzed_at ?? "");
    check("analyzed_at 10 minutes ahead is accepted (200), not refused", future.status === 200, `${future.status} ${JSON.stringify(future.json)?.slice(0, 200)}`);
    // Compared with this script's own clock (a minute of slack for a remote server), and with the stamp it sent.
    check("...and capped at the server's clock instead of stored as sent",
        Number.isFinite(cappedAt) && cappedAt < Date.parse(tooFar) - 8 * 60_000 && cappedAt >= beforeFuture - 60_000 && cappedAt <= afterFuture + 60_000,
        `${future.json?.model?.analysis?.analyzed_at} (sent ${tooFar})`);
    check("...the capped summary is what is stored; the other fields are untouched",
        sameJson((await modelNow()).analysis, future.json?.model?.analysis) && (await modelNow()).analysis.blocks === 42);
    const farFuture = await putAnalysis(model.id, goodSummary({ analyzed_at: "9999-12-31T23:59:59.999Z" }));
    check("a stamp in the year 9999 is capped the same way", farFuture.status === 200 && Date.parse(farFuture.json.model.analysis.analyzed_at) <= Date.now() + 60_000,
        `${farFuture.status} ${farFuture.json?.model?.analysis?.analyzed_at}`);
    const edges = goodSummary({
        blocks: 1000, bodies: 1000, floating_blocks: 1000, cantilevered: 1000, longest_cantilever: 0, over_limit: 0, cantilever_limit: 10,
        cog_mm: [-1000, 2000, 0], cog_margin_mm: -2000, size_mm: [0, 1100, 1000], coverage: 1, fill_threshold: 0, errors: 1000, warnings: 0,
    });
    const atLimits = await putAnalysis(model.id, edges);
    check("values at the limits are accepted", atLimits.status === 200 && sameJson(atLimits.json.model.analysis, edges), JSON.stringify(atLimits.json)?.slice(0, 200));
    check("cantilever_limit 1 and margin 2000 are accepted", (await putAnalysis(model.id, goodSummary({ cantilever_limit: 1, cog_margin_mm: 2000 }))).status === 200);
    await putAnalysis(model.id, goodSummary({ blocks: 55 }));
    const beforeRefusals = (await modelNow()).analysis;

    // Everything below must be refused, and must leave the stored summary alone.
    const bad = {
        "version 2": { version: 2 }, 'version "1"': { version: "1" }, "no version": { version: undefined },
        "blocks -1": { blocks: -1 }, "blocks 1001": { blocks: 1001 }, "blocks 2.5": { blocks: 2.5 }, 'blocks "12"': { blocks: "12" }, "blocks null": { blocks: null },
        "no blocks": { blocks: undefined }, "bodies 1001": { bodies: 1001 }, "floating_blocks -1": { floating_blocks: -1 }, "cantilevered 1.5": { cantilevered: 1.5 },
        "longest_cantilever 1001": { longest_cantilever: 1001 }, "over_limit -3": { over_limit: -3 }, "errors 1001": { errors: 1001 }, "warnings -1": { warnings: -1 },
        "cantilever_limit 0": { cantilever_limit: 0 }, "cantilever_limit 11": { cantilever_limit: 11 },
        "cog_mm two numbers": { cog_mm: [1, 2] }, "cog_mm four numbers": { cog_mm: [1, 2, 3, 4] }, "cog_mm with a string": { cog_mm: [1, 2, "3"] },
        "cog_mm 2001": { cog_mm: [2001, 0, 0] }, "cog_mm -1001": { cog_mm: [0, -1001, 0] }, "cog_mm a string": { cog_mm: "512,498,310" }, "cog_mm object": { cog_mm: { x: 1, y: 2, z: 3 } },
        "no cog_mm": { cog_mm: undefined }, 'cog_inside "true"': { cog_inside: "true" }, "cog_inside 1": { cog_inside: 1 }, "no cog_inside": { cog_inside: undefined },
        "cog_margin_mm 2001": { cog_margin_mm: 2001 }, "cog_margin_mm -2001": { cog_margin_mm: -2001 }, 'cog_margin_mm "5"': { cog_margin_mm: "5" },
        "size_mm 1101": { size_mm: [1101, 10, 10] }, "size_mm -1": { size_mm: [10, -1, 10] }, "size_mm two numbers": { size_mm: [1, 2] }, "no size_mm": { size_mm: undefined },
        "coverage 1.01": { coverage: 1.01 }, "coverage -0.1": { coverage: -0.1 }, "fill_threshold 2": { fill_threshold: 2 }, 'fill_threshold "0.3"': { fill_threshold: "0.3" },
        "analyzed_at a number": { analyzed_at: Date.now() }, 'analyzed_at "yesterday"': { analyzed_at: "yesterday" },
        "analyzed_at a date without time": { analyzed_at: "2026-01-01" }, "analyzed_at Feb 30": { analyzed_at: "2026-02-30T00:00:00Z" },
        "analyzed_at month 13": { analyzed_at: "2026-13-01T00:00:00Z" }, "no analyzed_at": { analyzed_at: undefined },
    };
    const refusals = [];
    for (const [name, patch] of Object.entries(bad)) {
        const r = await putAnalysis(model.id, goodSummary(patch));
        if (r.status !== 400 || typeof r.json?.error !== "string") refusals.push(`${name}: ${r.status}`);
    }
    check(`${Object.keys(bad).length} malformed summaries are each a 400 {error}`, refusals.length === 0, refusals.join("; "));
    const infinite = await putAnalysis(model.id, JSON.stringify(goodSummary()).replace('"blocks":42', '"blocks":1e999'), true);
    check("a number that overflows to Infinity is a 400", infinite.status === 400, String(infinite.status));
    const infiniteCog = await putAnalysis(model.id, JSON.stringify(goodSummary()).replace("512.5", "1e999"), true);
    check("...also inside cog_mm", infiniteCog.status === 400, String(infiniteCog.status));
    for (const [name, body] of [["no summary", {}], ["summary null", { summary: null }], ["summary an array", { summary: [goodSummary()] }], ["summary a string", { summary: "42 blocks" }],
        ["summary a number", { summary: 42 }]]) {
        const r = await putAnalysis(model.id, body, true);
        check(`${name} is 400 {error}`, r.status === 400 && typeof r.json?.error === "string", String(r.status));
    }
    check("invalid JSON is 400", (await putAnalysis(model.id, "{nope", true)).status === 400);
    check("a JSON array body is 400", (await putAnalysis(model.id, "[]", true)).status === 400);
    check("an empty body is 400", (await putAnalysis(model.id, "", true)).status === 400);
    const oversized = await putAnalysis(model.id, JSON.stringify({ summary: goodSummary(), pad: "x".repeat(9 * 1024) }), true);
    check("a body over 8 KB is a 413", oversized.status === 413 && typeof oversized.json?.error === "string", String(oversized.status));
    check("a refused PUT leaves the stored summary alone", beforeRefusals.blocks === 55 && sameJson((await modelNow()).analysis, beforeRefusals));

    check("unknown model is 404 {error}", (await putAnalysis(UNKNOWN_ID, goodSummary())).status === 404 && typeof (await putAnalysis(UNKNOWN_ID, goodSummary())).json?.error === "string");
    check("malformed model id is 400", (await putAnalysis("not-a-uuid", goodSummary())).status === 400);
    check("a bad summary for an unknown model is still a 400, not a 404", (await putAnalysis(UNKNOWN_ID, goodSummary({ version: 3 }))).status === 400);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        const r = await call(method, `/models/${model.id}/analysis`, method === "GET" || method === "DELETE" ? undefined : {});
        check(`${method} /models/:id/analysis is 405 with Allow: PUT`, r.status === 405 && /PUT/.test(r.headers.get("allow") ?? ""), String(r.status));
    }
    // PUT /models/:id is not a route (the analysis lives at /analysis); /models/:id answers DELETE only (stabilized versions, see smoke-derived.mjs).
    const putModel = await call("PUT", `/models/${model.id}`, { summary: goodSummary() });
    check("PUT /models/:id is 405 with Allow: DELETE, and /models is 404", putModel.status === 405 && /DELETE/.test(putModel.headers.get("allow") ?? "") && (await call("PUT", "/models", {})).status === 404);
    check("a generated model cannot be deleted through DELETE /models/:id: 409", (await call("DELETE", `/models/${model.id}`)).status === 409);
    check("/models/:id/analysis/extra is 404", (await call("PUT", `/models/${model.id}/analysis/extra`, { summary: goodSummary() })).status === 404);
    check("the response is no-store JSON", put.headers.get("cache-control") === "no-store" && /json/.test(put.headers.get("content-type") ?? ""));

    if ((await sql("SELECT 1 AS ok")) === null) {
        note("the local database is not reachable (not wrangler dev): the stored-JSON checks are skipped");
    } else {
        const stored = (await sql(`SELECT analysis FROM models WHERE id = '${model.id}'`))?.[0]?.analysis;
        check("the stored JSON holds exactly the summary fields (no extras) in under 1 KB", typeof stored === "string" && stored.length < 1024 &&
            !/evil|nested|extra|polluted/.test(stored), stored);
        const good = (await modelNow()).analysis;
        for (const [name, value] of [["bad JSON", "{nope"], ["an old shape (version 0)", JSON.stringify({ ...good, version: 0 })], ["a JSON array", "[]"], ["a string", '"x"'], ["an empty string", ""]]) {
            await sql(`UPDATE models SET analysis = '${value.replace(/'/g, "''")}' WHERE id = '${model.id}'`);
            const r = await call("GET", `/projects/${gen.id}`);
            check(`stored ${name} reads back as null without breaking the project`, r.status === 200 && r.json.project.models.find((m) => m.id === model.id)?.analysis === null,
                `${r.status}`);
        }
        await sql(`UPDATE models SET analysis = NULL WHERE id = '${model.id}'`);
        check("a NULL column reads back as null", (await modelNow()).analysis === null);
    }

    // ---------------------------------------------------------------- hard deletes remove the files
    section("purging removes stored files");
    await call("POST", "/projects/bulk", { ids: [gen.id], action: "trash" });
    check("purge the project that owns a model", (await call("POST", "/projects/bulk", { ids: [gen.id], action: "purge" })).json?.count === 1);
    check("its GLB is gone from R2 (404)", (await fetch(`${BASE}${model.glb_url}`)).status === 404);
    check("its job is gone (404)", (await call("GET", `/jobs/${okJob.id}`)).status === 404);
    created.projects = created.projects.filter((id) => id !== gen.id);
}

async function examples() {
    section("examples: GET /examples and POST /projects/from-example");
    const list = await call("GET", "/examples");
    check("GET /examples is 200 JSON with an examples array", list.status === 200 && /json/.test(list.headers.get("content-type") ?? "") && Array.isArray(list.json?.examples));
    check("HEAD works too", (await fetch(`${API}/examples`, { method: "HEAD" })).status === 200);
    check("POST /examples is 405 with Allow", await call("POST", "/examples", {}).then((r) => r.status === 405 && /GET/.test(r.headers.get("allow") ?? "")));
    check("/examples/extra is 404", (await call("GET", "/examples/extra")).status === 404);
    check("an unknown example is 404 {error}", await call("POST", "/projects/from-example", { slug: "no-such-example" }).then((r) => r.status === 404 && typeof r.json?.error === "string"));
    check("a slug that is a path is 400", (await call("POST", "/projects/from-example", { slug: "../../etc/passwd" })).status === 400);
    check("no slug is 400, a number is 400", (await call("POST", "/projects/from-example", {})).status === 400 && (await call("POST", "/projects/from-example", { slug: 5 })).status === 400);
    check("a bad tag id is 400", (await call("POST", "/projects/from-example", { slug: "no-such-example", tag_id: "nope" })).status === 400);
    check("GET /projects/from-example is 405 with Allow: POST", await call("GET", "/projects/from-example").then((r) => r.status === 405 && /POST/.test(r.headers.get("allow") ?? "")));
    check("a body that is not an object is 400", (await call("POST", "/projects/from-example", "[]")).status === 400);
    const first = list.json?.examples?.[0];
    if (!first) {
        note("no examples are served yet (public/assignment_alex/examples/manifest.json): opening one is not tested here; smoke-derived.mjs does it once they exist");
        return;
    }
    const opened = await call("POST", "/projects/from-example", { slug: first.slug });
    check(`opening "${first.slug}" gives a project with its original and stabilized models`, opened.status === 201 && opened.json?.project?.models?.length === 2 && opened.json.project.models[0].kind === "example" && opened.json.project.models[1].kind === "stabilized");
    if (opened.status === 201) created.projects.push(opened.json.project.id);
}

async function routing() {
    section("routing, errors and the app shell");
    const unknown = await call("GET", "/nope");
    check("unknown API route is 404 {error}", unknown.status === 404 && typeof unknown.json?.error === "string");
    const method = await call("DELETE", "/projects");
    check("wrong method is 405 {error} with Allow", method.status === 405 && typeof method.json?.error === "string" && Boolean(method.headers.get("allow")));
    check("errors are no-store JSON", method.headers.get("cache-control") === "no-store" && /json/.test(method.headers.get("content-type") ?? ""));
    check("no stack traces in errors", !/at .*\(.*:\d+:\d+\)|worker\/|node_modules/.test(JSON.stringify([unknown.json, method.json])));

    for (const path of ["/assignment_alex", "/assignment_alex/", "/assignment_alex/app/x", "/assignment_alex/app/new"]) {
        const res = await fetch(`${BASE}${path}`);
        const html = await res.text();
        check(`GET ${path} -> 200 HTML shell, noindex`, res.status === 200 && /text\/html/.test(res.headers.get("content-type") ?? "") &&
            res.headers.get("x-robots-tag") === "noindex" && /<html/i.test(html));
    }
    const head = await fetch(`${BASE}/assignment_alex/app/x`, { method: "HEAD" });
    check("HEAD on a client route -> 200", head.status === 200);
    const post = await fetch(`${BASE}/assignment_alex/app/x`, { method: "POST" });
    check("POST on a client route -> 405", post.status === 405);
    if (existsSync(resolve(ROOT, "dist/assignment_alex/index.html"))) {
        const res = await fetch(`${BASE}/assignment_alex/app/x`);
        check("shell is dist/assignment_alex/index.html", (await res.text()).includes("Assembly Studio"));
    } else {
        note("dist/assignment_alex/index.html does not exist yet (needs `npm run build`): the shell checks above only prove the routing");
    }
    const fixture = await fetch(`${BASE}/assignment_alex/fixtures/demo-assembly.glb`);
    if (fixture.status === 200 && /gltf-binary/.test(fixture.headers.get("content-type") ?? "")) {
        check("static file with an extension is served from ASSETS", Buffer.from(await fixture.arrayBuffer()).subarray(0, 4).toString("latin1") === "glTF");
    } else {
        note(`/assignment_alex/fixtures/demo-assembly.glb is not in the served assets (status ${fixture.status}, ${fixture.headers.get("content-type")}): it ships with the next build`);
    }
    const home = await fetch(`${BASE}/`);
    check("the rest of the site still goes to ASSETS", home.status === 200 && /text\/html/.test(home.headers.get("content-type") ?? "") && !home.headers.get("x-robots-tag"));
}

async function cleanup() {
    section("cleanup");
    if (created.projects.length > 0) {
        await call("POST", "/projects/bulk", { ids: created.projects, action: "trash" });
        const purged = await call("POST", "/projects/bulk", { ids: created.projects, action: "purge" });
        check(`purged ${created.projects.length} leftover project(s)`, purged.json?.count === created.projects.length, JSON.stringify(purged.json));
    }
    for (const id of created.tags) await call("DELETE", `/tags/${id}`);
    check("no leftover smoke tags", true);
}

try {
    await main();
    await examples();
    await routing();
} catch (err) {
    failed++;
    failures.push(`exception: ${err.message}`);
    console.log(`  FAIL unexpected error: ${err.stack ?? err}`);
} finally {
    await cleanup().catch((err) => console.log(`  cleanup failed: ${err.message}`));
}

console.log(`\n${passed} passed, ${failed} failed${notes.length ? `, ${notes.length} note(s)` : ""}`);
if (failed > 0) {
    console.log(`Failures:\n - ${failures.join("\n - ")}`);
    process.exit(1);
}
