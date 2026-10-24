// Tests for the workspace's state and flow logic (src/assignment/store/*, hooks/useChatSizes.ts,
// lib/api.ts): sending, stopping, retrying, polling and autosave, driven against a fake server.
//
//   node scripts/assignment/test-store.mjs
//
// The modules are bundled with esbuild (the project's own) with two stand-ins: `react` becomes a
// shim that records effects so a hook can be run by hand, and the toast library becomes a log. No DOM,
// no network: `fetch` is replaced by a small in-memory server.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-store-test");
mkdirSync(outDir, { recursive: true });

// ---------- bundle the modules under test ----------

const SHIM = `
export const effects = [];
export const useEffect = (fn, deps) => { effects.push({ fn, deps }); };
export const useSyncExternalStore = (_subscribe, get) => get();
export const useState = (init) => [typeof init === "function" ? init() : init, () => {}];
export const useRef = (v) => ({ current: v });
export const useMemo = (f) => f();
export const useCallback = (f) => f;
export const useDebugValue = () => {};
export default { useEffect, useSyncExternalStore, useState, useRef, useMemo, useCallback, useDebugValue };
`;
const TOAST_SHIM = `
export const toasts = [];
const make = (kind) => (title, options) => { toasts.push({ kind, title, options }); };
export const toast = Object.assign(make("message"), {
    info: make("info"), success: make("success"), warning: make("warning"), error: make("error"),
});
export const Toaster = () => null;
`;
const ENTRY = `
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/generation";
export * from "@/assignment/store/jobs";
export * from "@/assignment/store/persist";
export * from "@/assignment/store/replies";
export * from "@/assignment/store/access";
export * from "@/assignment/store/providers";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/analysisLogic";
export * from "@/assignment/store/analysisSave";
export { useAnalysisRunner, NOT_READY_RETRY_MS } from "@/assignment/components/analysis/useAnalysisRunner";
export { DEFAULT_ANALYSIS_SETTINGS, DEFAULT_ANALYSIS_VIEW } from "@/assignment/analysis/types";
export * from "@/assignment/hooks/useChatSizes";
export * from "@/assignment/lib/api";
export { effects } from "react";
export { toasts } from "@/assignment/components/ui/sonner";
`;

await build({
    stdin: { contents: ENTRY, resolveDir: root, sourcefile: "entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(outDir, "bundle.mjs"),
    tsconfig: path.join(root, "tsconfig.app.json"),
    nodePaths: [path.join(root, "node_modules")],
    logLevel: "error",
    plugins: [
        {
            name: "shims",
            setup(b) {
                b.onResolve({ filter: /^react$/ }, () => ({ path: "react-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({
                    path: "toast-shim",
                    namespace: "shim",
                }));
                b.onLoad({ filter: /^react-shim$/, namespace: "shim" }, () => ({ contents: SHIM, loader: "js" }));
                b.onLoad({ filter: /^toast-shim$/, namespace: "shim" }, () => ({ contents: TOAST_SHIM, loader: "js" }));
            },
        },
    ],
});

// ---------- a browser, as far as these modules look ----------

const storage = new Map();
globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => void storage.set(k, String(v)),
    removeItem: (k) => void storage.delete(k),
};
const docHandlers = {};
const winHandlers = {};
const on = (table) => (type, fn) => (table[type] ??= []).push(fn);
const off = (table) => (type, fn) => void (table[type] = (table[type] ?? []).filter((f) => f !== fn));
globalThis.document = { visibilityState: "visible", addEventListener: on(docHandlers), removeEventListener: off(docHandlers) };
globalThis.window = { innerWidth: 1440, addEventListener: on(winHandlers), removeEventListener: off(winHandlers) };
const fire = (table, type) => (table[type] ?? []).forEach((fn) => fn());

// ---------- a fake server ----------

const calls = [];
const projects = new Map();
const jobsById = new Map();
const fake = {
    patchDelay: {}, // project id -> ms
    patchFails: false,
    generate: null, // (projectId, body) => { status, json }
    cancel: null, // (jobId) => { status, json }
    jobReply: null, // (jobId) => { status, json }
    createFails: false,
    createDelay: 0,
    generateDelay: 0,
    putAnalysis: null, // (modelId, summary) => { status, json }
    putDelay: 0, // ms the analysis PUT is held before it answers
    providers: {
        providers: [
            { id: "hunyuan", label: "Hunyuan 3D 3.1", vendor: "Tencent", via: "tencent", available: true, description: "", parts: false, textured: true, approx_seconds: 120 },
        ],
        default_provider: "hunyuan",
        access_required: false,
        daily_limit: 40,
        used_today: 0,
    },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = async (url, init = {}) => {
    const apiPath = String(url).replace("/api/assignment_alex", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const record = { method, path: apiPath, body, headers: init.headers ?? {}, keepalive: init.keepalive, signal: init.signal };
    calls.push(record);
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    let m;
    if (method === "POST" && apiPath === "/projects") {
        if (fake.createDelay) await sleep(fake.createDelay);
        if (fake.createFails) return reply(500, { error: "boom" });
        const id = crypto.randomUUID();
        const row = hubProject(id, body.name);
        projects.set(id, { ...row, data: { messages: [], active_model_id: null } });
        return reply(201, { project: row });
    }
    if (method === "POST" && apiPath === "/projects/bulk") return reply(200, { count: body.ids.length });
    if (method === "PATCH" && (m = apiPath.match(/^\/projects\/([^/]+)$/))) {
        await sleep(fake.patchDelay[m[1]] ?? 0);
        if (fake.patchFails) throw new TypeError("network down");
        const row = projects.get(m[1]) ?? { ...hubProject(m[1], m[1]), data: null };
        row.data = body.data;
        row.modified_at = new Date().toISOString();
        projects.set(m[1], row);
        return reply(200, { project: row });
    }
    if (method === "POST" && (m = apiPath.match(/^\/projects\/([^/]+)\/generate$/))) {
        if (fake.generateDelay) await sleep(fake.generateDelay);
        return reply(...Object.values(fake.generate(m[1], body)));
    }
    if (method === "GET" && (m = apiPath.match(/^\/jobs\/([^/]+)$/))) {
        const r = fake.jobReply ? fake.jobReply(m[1]) : { status: 200, json: { job: jobsById.get(m[1]) } };
        return reply(r.status, r.json);
    }
    if (method === "POST" && (m = apiPath.match(/^\/jobs\/([^/]+)\/cancel$/))) {
        const r = fake.cancel(m[1], record);
        return reply(r.status, r.json);
    }
    if (method === "PUT" && (m = apiPath.match(/^\/models\/([^/]+)\/analysis$/))) {
        if (fake.putDelay) await sleep(fake.putDelay);
        const r = fake.putAnalysis(m[1], body.summary);
        return reply(r.status, r.json);
    }
    if (apiPath === "/providers") return reply(200, fake.providers);
    return reply(404, { error: `no fake for ${method} ${apiPath}` });
};

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
function hubProject(id, name = "x") {
    return { id, name, created_at: iso(), modified_at: iso(), deleted_at: null, archived_at: null, pinned: false, thumbnail_url: null, tag_ids: [], model_count: 0 };
}
const detail = (id, extra = {}) => ({ ...hubProject(id), data: { messages: [], active_model_id: null }, models: [], jobs: [], ...extra });
function makeJob(projectId, over = {}) {
    const job = {
        id: crypto.randomUUID(),
        project_id: projectId,
        provider: "hunyuan",
        prompt: "a lamp",
        status: "running",
        progress: 10,
        stage: "Generating",
        error: null,
        created_at: iso(),
        updated_at: iso(),
        finished_at: null,
        model: null,
        ...over,
    };
    jobsById.set(job.id, job);
    return job;
}
const modelFor = (job) => ({
    id: crypto.randomUUID(), project_id: job.project_id, job_id: job.id, provider: job.provider, prompt: job.prompt,
    glb_url: "/x.glb", thumbnail_url: null, size_bytes: 10, part_count: 1, created_at: iso(),
});

// ---------- the modules ----------

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const S = () => lib.useWorkspaceStore.getState();
const patches = (id) => calls.filter((c) => c.method === "PATCH" && (id ? c.path === `/projects/${id}` : true));
const reset = () => {
    S().startNewChat();
    calls.length = 0;
    lib.toasts.length = 0;
    fake.patchFails = false;
    fake.patchDelay = {};
    lib.useWorkspaceStore.setState({ unstoppable: [] });
    fake.createFails = false;
    fake.createDelay = 0;
    fake.generateDelay = 0;
    fake.generate = () => ({ status: 200, json: { jobs: [] } });
    fake.jobReply = null;
    storage.clear();
    S().setProviders(fake.providers);
};
/** Run a hook that only registers effects, then run those; returns the combined cleanup. */
function mountHook(hook) {
    lib.effects.length = 0;
    hook();
    const cleanups = lib.effects.map((e) => e.fn());
    return () => cleanups.forEach((c) => c?.());
}
const send = (prompt = "a lamp", extra = {}) =>
    lib.sendPrompt({ prompt, providers: ["hunyuan"], requestAccessCode: async () => true, ...extra });

// The modules log failed saves with console.warn; the tests that make requests fail expect that.
const warned = [];
console.warn = (...args) => void warned.push(args);

let passed = 0;
const failures = [];
async function test(name, fn) {
    reset();
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}

// ================= messages saved by anyone =================

await test("setProject drops malformed saved messages instead of crashing render", () => {
    S().setProject(
        detail(crypto.randomUUID(), {
            data: {
                messages: [
                    null,
                    "text",
                    { id: 1, role: "user", content: "numeric id" },
                    { id: "a", role: "admin", content: "bad role" },
                    { id: "b", role: "assistant", content: 42, job_ids: "abc" },
                    { id: "c", role: "assistant", content: "ok", timestamp: "t", job_ids: ["j1", 7, "j2"] },
                ],
                active_model_id: null,
            },
        }),
    );
    assert.deepEqual(S().messages.map((m) => m.id), ["b", "c"]);
    assert.equal(S().messages[0].content, "");
    assert.equal(S().messages[0].job_ids, undefined);
    assert.deepEqual(S().messages[1].job_ids, ["j1", "j2"]);
    assert.deepEqual(lib.latestJobIds(S().messages), ["j1", "j2"]);
});

await test("latestJobIds skips holes and non-array job_ids", () => {
    assert.deepEqual(lib.latestJobIds([null, { id: "x", role: "assistant", content: "", timestamp: "", job_ids: "abc" }]), []);
});

await test("a non-array data.messages gives an empty chat", () => {
    S().setProject(detail(crypto.randomUUID(), { data: { messages: "oops", active_model_id: null } }));
    assert.deepEqual(S().messages, []);
});

// ================= the assistant's line follows the jobs =================

await test("replyLine: saved wording while running, then how it went", () => {
    const info = fake.providers.providers;
    const job = (status, provider = "hunyuan") => ({ provider, status });
    const saved = lib.replyContent(info, ["hunyuan"], false);
    assert.equal(saved, "Generating with **Hunyuan 3D 3.1**.");
    assert.equal(lib.replyLine(saved, [job("running")], info), saved);
    assert.equal(lib.replyLine(saved, [job("finalizing")], info), saved);
    assert.equal(lib.replyLine(saved, [job("succeeded")], info), "Generated with **Hunyuan 3D 3.1**.");
    assert.equal(lib.replyLine(saved, [job("failed")], info), "**Hunyuan 3D 3.1** could not generate this model.");
    assert.equal(lib.replyLine(saved, [job("canceled")], info), "Stopped **Hunyuan 3D 3.1**.");
    assert.equal(lib.replyLine(saved, [], info), saved, "jobs that no longer exist: the saved text");
    const two = [job("succeeded"), job("failed", "mock")];
    assert.match(lib.replyLine("Comparing", two, info), /1 of 2 produced a model/);
    assert.match(lib.replyLine("Comparing", [job("failed"), job("failed", "mock")], info), /None of/);
    assert.match(lib.replyLine("Comparing", [job("succeeded"), job("succeeded", "mock")], info), /^Compared /);
    assert.equal(lib.replyContent(info, ["hunyuan"], true), "Trying **Hunyuan 3D 3.1** again.");
});

// ================= applying jobs =================

await test("a poll that was in flight cannot bring a canceled job back", () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    const job = makeJob(P);
    lib.applyJob(job);
    lib.applyJob({ ...job, status: "canceled", stage: "Canceled", finished_at: iso(), updated_at: iso(5) });
    lib.applyJob({ ...job, progress: 40 });
    assert.equal(S().jobs[job.id].status, "canceled");
    // Same timestamp (the server did not tick between the two answers): the finished job still wins.
    const canceled = S().jobs[job.id];
    lib.applyJob({ ...canceled, status: "running", progress: 60 });
    assert.equal(S().jobs[job.id].status, "canceled");
});

await test("an older copy of a running job does not take it back in time", () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    const job = makeJob(P, { updated_at: iso(1000), progress: 50 });
    lib.applyJob(job);
    lib.applyJob({ ...job, updated_at: iso(0), progress: 20 });
    assert.equal(S().jobs[job.id].progress, 50);
    lib.applyJob({ ...job, updated_at: iso(2000), progress: 60 });
    assert.equal(S().jobs[job.id].progress, 60);
});

await test("a job of another project is ignored", () => {
    const A = crypto.randomUUID();
    S().setProject(detail(A));
    lib.applyJob(makeJob(crypto.randomUUID()));
    assert.deepEqual(Object.keys(S().jobs), []);
});

await test("a model counts as finished here only if this page watched the job end", () => {
    const P = crypto.randomUUID();
    const done = makeJob(P, { status: "succeeded", progress: 100 });
    done.model = modelFor(done);
    // Loaded already finished (a project opened later): not ours to put on the cover.
    S().setProject(detail(P, { jobs: [done], models: [done.model] }));
    assert.equal(lib.completedThisSession(done.model.id), false);
    // Watched from running to succeeded, in a project that shows nothing yet.
    const Q = crypto.randomUUID();
    S().setProject(detail(Q));
    const running = makeJob(Q);
    lib.applyJob(running);
    const finished = { ...running, status: "succeeded", progress: 100, updated_at: iso(10) };
    finished.model = modelFor(finished);
    lib.applyJob(finished);
    assert.equal(lib.completedThisSession(finished.model.id), true);
    assert.equal(S().activeModelId, finished.model.id, "the first model of a project is shown");
});

await test("updateProjectMeta for a project that is no longer open changes nothing", () => {
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    S().setProject(detail(A));
    S().setProject(detail(B));
    S().updateProjectMeta({ name: "late rename" }, A);
    assert.notEqual(S().project.name, "late rename");
    S().updateProjectMeta({ name: "right" }, B);
    assert.equal(S().project.name, "right");
});

// ================= sending =================

await test("first send: creates the project, starts the job, links the reply, saves at once", async () => {
    const jobs = [];
    fake.generate = (pid) => {
        const job = makeJob(pid);
        jobs.push(job);
        return { status: 200, json: { jobs: [job] } };
    };
    const unmount = mountHook(lib.useAutosave);
    const out = await send();
    assert.equal(out.ok, true);
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.path);
    assert.match(posts[0], /^\/projects$/);
    assert.match(posts[1], /^\/projects\/[^/]+\/generate$/);
    assert.ok(S().activeProjectId);
    const reply = S().messages.find((m) => m.role === "assistant");
    assert.deepEqual(reply.job_ids, [jobs[0].id]);
    await sleep(50);
    const saved = patches(S().activeProjectId);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].body.data.messages.map((m) => m.role), ["user", "assistant"]);
    unmount();
});

await test("a failed first send hands the prompt back and does not save an empty chat", async () => {
    fake.generate = () => ({ status: 429, json: { error: "Daily generation limit reached (40 per day)." } });
    const unmount = mountHook(lib.useAutosave);
    const out = await send();
    await sleep(1300);
    assert.deepEqual(out, { ok: false, restorePrompt: true });
    assert.equal(S().messages.length, 0);
    assert.equal(patches().length, 0, "no PATCH of an empty chat");
    assert.ok(lib.toasts.some((t) => t.title === "Daily limit reached"));
    unmount();
});

await test("a failed send in an existing chat leaves the saved chat alone", async () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P, { data: { messages: [{ id: "u1", role: "user", content: "old", timestamp: "" }], active_model_id: null } }));
    fake.generate = () => ({ status: 500, json: { error: "down" } });
    const unmount = mountHook(lib.useAutosave);
    const out = await send();
    await sleep(1300);
    assert.equal(out.ok, false);
    assert.deepEqual(S().messages.map((m) => m.id), ["u1"]);
    assert.equal(patches().length, 0);
    unmount();
});

await test("New chat pressed while the first project row is made: the row goes to the bin", async () => {
    fake.createDelay = 60;
    fake.generate = () => assert.fail("must not generate");
    const pending = send();
    await sleep(10);
    S().startNewChat();
    const out = await pending;
    await sleep(20);
    assert.deepEqual(out, { ok: false, restorePrompt: false });
    const bulk = calls.find((c) => c.path === "/projects/bulk");
    assert.equal(bulk?.body.action, "trash");
    assert.equal(calls.filter((c) => c.path.endsWith("/generate")).length, 0);
});

await test("the user opens another project while the jobs start: the chat is written to its own project", async () => {
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    projects.set(A, { ...detail(A) });
    S().setProject(detail(A, { data: { messages: [], active_model_id: "model-on-screen" }, models: [{ id: "model-on-screen", project_id: A }] }));
    fake.generate = (pid) => ({ status: 200, json: { jobs: [makeJob(pid)] } });
    fake.generateDelay = 60;
    const pending = send("second lamp");
    await sleep(10);
    S().startNewChat();
    S().setProject(detail(B));
    const out = await pending;
    assert.equal(out.ok, true);
    assert.equal(S().activeProjectId, B);
    assert.equal(S().messages.length, 0, "project B's chat is untouched");
    const written = patches(A);
    assert.equal(written.length, 1);
    assert.deepEqual(written[0].body.data.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(written[0].body.data.active_model_id, "model-on-screen", "the saved viewer choice is kept");
    assert.ok(lib.toasts.some((t) => t.title === "Generation started"));
});

await test("a send that ends after the user moved on does not clear the next send's flag", async () => {
    const first = S().beginSend();
    S().startNewChat();
    const second = S().beginSend();
    S().endSend(first);
    assert.equal(S().sending, true);
    S().endSend(second);
    assert.equal(S().sending, false);
});

await test("a 401 mid-send asks for the code once and carries on with the new one", async () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    lib.setAccessCode("old-code");
    let tries = 0;
    fake.generate = (pid) =>
        ++tries === 1 ? { status: 401, json: { error: "Access code required" } } : { status: 200, json: { jobs: [makeJob(pid)] } };
    let asked = 0;
    const out = await send("a lamp", {
        requestAccessCode: async () => {
            asked += 1;
            assert.equal(lib.getAccessCode(), null, "the refused code is forgotten before asking");
            lib.setAccessCode("new-code");
            return true;
        },
    });
    assert.equal(out.ok, true);
    assert.equal(asked, 1);
    assert.equal(tries, 2);
});

await test("a dismissed code dialog cancels the send and gives the prompt back", async () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    fake.generate = () => ({ status: 401, json: { error: "Access code required" } });
    const out = await send("a lamp", { requestAccessCode: async () => false });
    assert.deepEqual(out, { ok: false, restorePrompt: true });
    assert.equal(S().messages.length, 0);
});

await test("the access-code prompt resolves false when a newer ask supersedes it", async () => {
    const first = lib.requestAccessCode();
    const second = lib.requestAccessCode();
    assert.equal(await first, false);
    lib.settleAccessPrompt(true);
    assert.equal(await second, true);
    assert.equal(lib.useAccessPrompt.getState().open, false);
});

await test("retry in a project that is no longer open starts the job and says where it went", async () => {
    const A = crypto.randomUUID();
    S().setProject(detail(A));
    fake.generate = (pid) => ({ status: 200, json: { jobs: [makeJob(pid)] } });
    const failed = makeJob(A, { status: "failed" });
    fake.generateDelay = 60;
    const pending = lib.retryJob(failed, async () => true);
    await sleep(10);
    S().startNewChat();
    await pending;
    assert.ok(lib.toasts.some((t) => t.title === "Generation started"));
    assert.equal(S().sending, false);
});

// ================= stopping =================

function runningProject(provider = "hunyuan") {
    const P = crypto.randomUUID();
    const job = makeJob(P, { provider });
    S().setProject(
        detail(P, {
            jobs: [job],
            data: {
                messages: [
                    { id: "u", role: "user", content: "a lamp", timestamp: "" },
                    { id: "r", role: "assistant", content: "Generating with X.", timestamp: "", job_ids: [job.id] },
                ],
                active_model_id: null,
            },
        }),
    );
    return { P, job };
}

await test("Stop cancels the running job and sends the access code", async () => {
    const { job } = runningProject();
    lib.setAccessCode("secret");
    fake.cancel = (id) => ({ status: 200, json: { job: { ...jobsById.get(id), status: "canceled", updated_at: iso(50), finished_at: iso() } } });
    await lib.stopGeneration(async () => true);
    assert.equal(S().jobs[job.id].status, "canceled");
    const call = calls.find((c) => c.path === `/jobs/${job.id}/cancel`);
    assert.equal(call.headers["x-access-code"], "secret");
});

await test("Stop hands a queued prompt back to the box instead of letting it start a second run", async () => {
    const { job } = runningProject();
    S().setQueuedPrompt("next lamp");
    fake.cancel = (id) => ({ status: 200, json: { job: { ...jobsById.get(id), status: "canceled", updated_at: iso(50) } } });
    await lib.stopGeneration(async () => true);
    assert.equal(S().queuedPrompt, null);
    assert.equal(S().draft, "next lamp");
    assert.equal(S().jobs[job.id].status, "canceled");
});

await test("restoreDraft keeps what is typed and does not duplicate", () => {
    S().setDraft("typed");
    S().restoreDraft("queued");
    assert.equal(S().draft, "queued\ntyped");
    S().restoreDraft("queued\ntyped");
    S().setDraft("same");
    S().restoreDraft("same");
    assert.equal(S().draft, "same");
});

await test("Stop on a job the provider cannot cancel does not hide it", async () => {
    const { job } = runningProject();
    // The server leaves it running and says so with the unchanged job.
    fake.cancel = (id) => ({ status: 200, json: { job: jobsById.get(id) } });
    await lib.stopGeneration(async () => true);
    assert.equal(S().jobs[job.id].status, "running");
    assert.ok(lib.toasts.some((t) => t.title === "Not stopped"));
});

await test("Stop answered with a 409 says why, leaves the job running and is not offered again", async () => {
    const { job } = runningProject();
    fake.cancel = () => ({ status: 409, json: { error: "This model cannot be stopped; it will finish." } });
    await lib.stopGeneration(async () => true);
    assert.equal(S().jobs[job.id].status, "running");
    const note = lib.toasts.find((t) => t.title === "Not stopped");
    assert.match(note.options.description, /cannot be stopped/);
    assert.deepEqual(S().unstoppable, ["hunyuan"]);
    assert.equal(lib.isCancelable(S().providers.providers[0], S().unstoppable), false);
    // The next press does not go to the server at all.
    calls.length = 0;
    fake.cancel = () => assert.fail("must not be called again");
    await lib.stopGeneration(async () => true);
    assert.equal(calls.filter((c) => c.path.endsWith("/cancel")).length, 0);
    assert.ok(lib.toasts.some((t) => t.title === "This model cannot be stopped"));
});

await test("Stop does not call the server for a provider flagged non-cancelable", async () => {
    const { job } = runningProject();
    S().setProviders({
        ...fake.providers,
        providers: fake.providers.providers.map((p) => ({ ...p, cancelable: false })),
    });
    fake.cancel = () => assert.fail("must not be called");
    await lib.stopGeneration(async () => true);
    assert.equal(S().jobs[job.id].status, "running");
    assert.ok(lib.toasts.some((t) => t.title === "This model cannot be stopped"));
    assert.equal(lib.isCancelable(S().providers.providers[0]), false);
    assert.equal(lib.isCancelable(fake.providers.providers[0]), true, "no flag means yes");
});

await test("Stop on a 401 asks for the code once and tries again", async () => {
    runningProject();
    lib.setAccessCode("stale");
    let first = true;
    fake.cancel = (id) => {
        if (first) {
            first = false;
            return { status: 401, json: { error: "Access code required" } };
        }
        return { status: 200, json: { job: { ...jobsById.get(id), status: "canceled", updated_at: iso(50) } } };
    };
    let asked = 0;
    await lib.stopGeneration(async () => {
        asked += 1;
        lib.setAccessCode("fresh");
        return true;
    });
    assert.equal(asked, 1);
    assert.ok(Object.values(S().jobs).every((j) => j.status === "canceled"));
});

await test("pressing Stop twice at once sends one cancel", async () => {
    const { job } = runningProject();
    fake.cancel = (id) => ({ status: 200, json: { job: { ...jobsById.get(id), status: "canceled", updated_at: iso(50) } } });
    await Promise.all([lib.stopGeneration(async () => true), lib.stopGeneration(async () => true)]);
    assert.equal(calls.filter((c) => c.path === `/jobs/${job.id}/cancel`).length, 1);
});

// ================= leaving a project =================

await test("leaving a project with a run in progress says it only continues when reopened", () => {
    runningProject();
    lib.noteRunLeftBehind();
    assert.equal(lib.toasts.at(-1)?.title, "Still generating");
    lib.toasts.length = 0;
    S().updateProjectMeta({ deleted_at: iso() });
    lib.noteRunLeftBehind();
    assert.equal(lib.toasts.length, 0, "a project moved to the bin needs no such note");
});

await test("starting a new project clears the chat and the typed text", () => {
    runningProject();
    S().setDraft("half typed");
    lib.startNewProject();
    assert.equal(S().activeProjectId, null);
    assert.equal(S().draft, "");
});

// ================= autosave =================

await test("a save in flight for one project does not stall another project's save", async () => {
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    projects.set(A, detail(A));
    projects.set(B, detail(B));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchDelay[A] = 1800;
    S().addMessage({ id: "ea", role: "user", content: "edit in A", timestamp: "" });
    await sleep(1200); // A's PATCH is in flight
    S().startNewChat();
    S().setProject(detail(B));
    S().addMessage({ id: "eb", role: "user", content: "edit in B", timestamp: "" });
    await sleep(2400);
    assert.equal(patches(B).length, 1, "B was saved without another edit");
    assert.equal(S().revision, S().savedRevision);
    unmount();
});

await test("leaving a project mid-save: the final write waits for the one in flight", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchDelay[A] = 600;
    S().addMessage({ id: "m1", role: "user", content: "first", timestamp: "" });
    await sleep(1100); // save of m1 is in flight
    S().addMessage({ id: "m2", role: "user", content: "second", timestamp: "" });
    S().startNewChat(); // flushes A's newer chat
    await sleep(100);
    const order = [];
    const seenAtArrival = patches(A).map((c) => c.body.data.messages.length);
    order.push(...seenAtArrival);
    assert.deepEqual(order, [1], "the newer chat has not been sent while the older write is still in flight");
    await sleep(1500);
    assert.deepEqual(patches(A).map((c) => c.body.data.messages.length), [1, 2], "older first, newer last");
    assert.equal(projects.get(A).data.messages.length, 2, "the server ends with the newest chat");
    unmount();
});

await test("a save that fails is retried and the edit stays unsaved meanwhile", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchFails = true;
    S().addMessage({ id: "m", role: "user", content: "x", timestamp: "" });
    await sleep(1300);
    assert.equal(S().saveStatus, "error");
    assert.notEqual(S().revision, S().savedRevision);
    fake.patchFails = false;
    await sleep(2300);
    assert.equal(S().revision, S().savedRevision, "the retry saved it");
    unmount();
});

await test("hiding the tab with a failing request keeps the edit unsaved", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    S().addMessage({ id: "m", role: "user", content: "important", timestamp: "" });
    fake.patchFails = true;
    document.visibilityState = "hidden";
    fire(docHandlers, "visibilitychange");
    await sleep(100);
    document.visibilityState = "visible";
    assert.notEqual(S().revision, S().savedRevision, "not marked saved when the request failed");
    fake.patchFails = false;
    await sleep(2300);
    assert.equal(S().revision, S().savedRevision, "written later");
    unmount();
});

await test("hiding the tab skips a write that is already on its way with the same content", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchDelay[A] = 400;
    S().addMessage({ id: "m", role: "user", content: "x", timestamp: "" });
    await sleep(1100); // the debounced save is in flight
    document.visibilityState = "hidden";
    fire(docHandlers, "visibilitychange");
    document.visibilityState = "visible";
    await sleep(600);
    assert.equal(patches(A).length, 1);
    unmount();
});

await test("a debounced save that comes due after a tab-hide flush does not repeat it", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchDelay[A] = 1200; // the flush is still in flight when the 900 ms debounce comes due
    S().addMessage({ id: "m", role: "user", content: "x", timestamp: "" });
    document.visibilityState = "hidden";
    fire(docHandlers, "visibilitychange");
    document.visibilityState = "visible";
    await sleep(2000);
    assert.equal(patches(A).length, 1);
    assert.equal(S().revision, S().savedRevision);
    unmount();
});

await test("keepalive is used for small chats and dropped when the body would exceed 64 KB", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    S().addMessage({ id: "s", role: "user", content: "small", timestamp: "" });
    document.visibilityState = "hidden";
    fire(docHandlers, "visibilitychange");
    document.visibilityState = "visible";
    await sleep(100);
    assert.equal(patches(A).at(-1).keepalive, true);
    S().addMessage({ id: "big", role: "user", content: "x".repeat(70_000), timestamp: "" });
    document.visibilityState = "hidden";
    fire(docHandlers, "visibilitychange");
    document.visibilityState = "visible";
    await sleep(100);
    assert.equal(patches(A).at(-1).keepalive, false);
    unmount();
});

await test("whenSaved resolves once the pending write for the project has landed", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    fake.patchDelay[A] = 300;
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    S().addMessage({ id: "m", role: "user", content: "x", timestamp: "" });
    unmount(); // leaving the page flushes the edit
    let landed = false;
    const waiting = lib.whenSaved(A).then(() => assert.equal(landed, true));
    await sleep(50);
    assert.equal(patches(A).length, 1);
    landed = true; // the fake server answers after patchDelay
    await waiting;
    assert.equal(projects.get(A).data.messages.length, 1);
});

await test("a save that lands after the chat was replaced does not mark the new chat saved", async () => {
    const A = crypto.randomUUID();
    projects.set(A, detail(A));
    const unmount = mountHook(lib.useAutosave);
    S().setProject(detail(A));
    fake.patchDelay[A] = 400;
    S().addMessage({ id: "m1", role: "user", content: "x", timestamp: "" });
    S().addMessage({ id: "m2", role: "user", content: "y", timestamp: "" });
    await sleep(1100); // in flight, revision 2
    S().startNewChat();
    S().setProject(detail(A)); // the same project opened again: counters restart
    await sleep(600);
    assert.equal(S().savedRevision, 0);
    unmount();
});

// ================= polling =================

await test("polling applies the answer, uses a timeout signal and stops by itself", async () => {
    const { job } = runningProject();
    fake.jobReply = (id) => {
        const done = { ...jobsById.get(id), status: "succeeded", progress: 100, updated_at: iso(100), finished_at: iso() };
        done.model = modelFor(done);
        return { status: 200, json: { job: done } };
    };
    const stop = mountHook(lib.useJobPolling);
    await sleep(1400);
    stop();
    const polls = calls.filter((c) => c.method === "GET" && c.path === `/jobs/${job.id}`);
    assert.equal(polls.length, 1, "one look is enough; nothing is left to poll");
    assert.ok(polls[0].signal instanceof AbortSignal, "every poll carries a timeout");
    assert.equal(S().jobs[job.id].status, "succeeded");
    assert.equal(S().models.length, 1);
});

await test("a job that no longer exists is shown as failed and ends the loop", async () => {
    const { job } = runningProject();
    fake.jobReply = () => ({ status: 404, json: { error: "Job not found" } });
    const stop = mountHook(lib.useJobPolling);
    await sleep(1400);
    stop();
    assert.equal(S().jobs[job.id].status, "failed");
    assert.equal(calls.filter((c) => c.path === `/jobs/${job.id}`).length, 1);
});

await test("polling backs off after errors and the tab coming back looks at once", async () => {
    const { job } = runningProject();
    fake.jobReply = () => ({ status: 500, json: { error: "down" } });
    const stop = mountHook(lib.useJobPolling);
    await sleep(1200); // first look failed
    const before = calls.filter((c) => c.path === `/jobs/${job.id}`).length;
    assert.equal(before, 1);
    fire(docHandlers, "visibilitychange"); // visible again: no waiting for the slow beat
    await sleep(100);
    assert.equal(calls.filter((c) => c.path === `/jobs/${job.id}`).length, 2);
    fire(winHandlers, "online");
    await sleep(100);
    assert.equal(calls.filter((c) => c.path === `/jobs/${job.id}`).length, 3);
    stop();
    await sleep(100);
    const after = calls.filter((c) => c.path === `/jobs/${job.id}`).length;
    await sleep(500);
    assert.equal(calls.filter((c) => c.path === `/jobs/${job.id}`).length, after, "no leaked timer after cleanup");
});

// ================= analysis report =================

const AS = () => lib.useAnalysisStore.getState();
const INITIAL_VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [], focus: null };
const resetAnalysis = () => {
    lib.forgetSavedSummaries();
    fake.putDelay = 0;
    fake.putAnalysis = (id, summary) => ({ status: 200, json: { model: { ...(S().models.find((m) => m.id === id) ?? modelFor(makeJob(crypto.randomUUID()))), id, analysis: summary } } });
    lib.useAnalysisStore.setState({
        settings: lib.sanitizeSettings(null), loaded: null, viewerFailure: null, run: lib.IDLE_RUN, result: null, resultModelId: null,
        blockIssues: new Map(), summaries: {}, view: INITIAL_VIEW, selection: null, selectionSerial: 0, layerRaised: false,
        hoverIssueId: null, attempt: 0, panelOpen: true, sheetOpen: false, openRequest: 0,
    });
};
const mkIssue = (id, kind, severity, blocks, focusMm = [500, 500, 150]) => ({ id, kind, severity, title: `title ${id}`, detail: `detail ${id}`, blocks, focusMm });
const mkSummary = (over = {}) => ({
    version: 1, blocks: 20, bodies: 1, floating_blocks: 0, cantilevered: 0, longest_cantilever: 0, over_limit: 0,
    cantilever_limit: 4, cog_mm: [500, 500, 300], cog_inside: true, cog_margin_mm: 120, size_mm: [1000, 640, 820],
    coverage: 0.9, fill_threshold: 0.3, errors: 0, warnings: 0, analyzed_at: iso(), ...over,
});
const mkResult = ({ issues = [], layers = 10, ...over } = {}) => ({
    settings: { ...lib.DEFAULT_ANALYSIS_SETTINGS },
    gridSize: [10, 10, 10],
    transform: { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] },
    sizeMm: [1000, 640, 820],
    blocks: Array.from({ length: 20 }, (_, index) => ({ index, cell: [index % 10, 0, Math.floor(index / 10)], centerMm: [index * 100 + 50, 50, 50], status: "supported", reach: 0, body: 0, fill: 1, cantilever: null })),
    bodies: [], cantilevers: [], stability: null, issues, checks: [],
    stats: { blockCount: 20, groundBlocks: 10, cantileveredCount: 0, longestCantilever: 0, overLimitCount: 0, floatingCount: 0, bodyCount: 1, layers, coverage: 0.9 },
    summary: mkSummary(), timingsMs: { voxelize: 1, analyze: 1 }, ...over,
});

await test("analysis settings: garbage becomes valid values, and the fixed sizes cannot change", () => {
    assert.deepEqual(lib.sanitizeSettings(null), lib.DEFAULT_ANALYSIS_SETTINGS);
    assert.deepEqual(lib.sanitizeSettings("nope"), lib.DEFAULT_ANALYSIS_SETTINGS);
    const wild = lib.sanitizeSettings({ fillThreshold: 5, cantileverLimit: 99, maxBlocks: -3, targetSizeMm: 5, blockSizeMm: 7 });
    assert.deepEqual(wild, { targetSizeMm: 1000, blockSizeMm: 100, fillThreshold: 0.9, cantileverLimit: 10, maxBlocks: null });
    assert.equal(lib.sanitizeSettings({ fillThreshold: 0 }).fillThreshold, 0.1, "clamped to 10%");
    assert.equal(lib.sanitizeSettings({ fillThreshold: "x" }).fillThreshold, 0.1, "a value that is not a number falls back to the default");
    assert.equal(lib.sanitizeSettings({ fillThreshold: 0.333 }).fillThreshold, 0.33);
    assert.equal(lib.sanitizeSettings({ cantileverLimit: 2.6 }).cantileverLimit, 3);
    assert.equal(lib.sanitizeSettings({ cantileverLimit: NaN }).cantileverLimit, 4);
    assert.equal(lib.sanitizeSettings({ maxBlocks: 120.4 }).maxBlocks, 120);
    assert.equal(lib.sanitizeSettings({ maxBlocks: 5000 }).maxBlocks, 1000, "no more blocks than the grid has cells");
});

await test("analysis settings persist in this browser under their key and survive a bad value", () => {
    resetAnalysis();
    AS().updateSettings({ fillThreshold: 0.5, cantileverLimit: 3, maxBlocks: 120 });
    assert.deepEqual(JSON.parse(storage.get("assembly-studio-analysis-settings")), { fillThreshold: 0.5, cantileverLimit: 3, maxBlocks: 120 });
    assert.deepEqual(lib.loadSettings(), AS().settings, "what is stored loads back as it was");
    const before = AS().settings;
    AS().updateSettings({ fillThreshold: 0.5 });
    assert.equal(AS().settings, before, "an unchanged value does not make a new object (it would re-run the analysis)");
    AS().updateSettings({ cantileverLimit: 500 });
    assert.equal(AS().settings.cantileverLimit, 10, "typed values are clamped to what the worker accepts (1-10)");
    storage.set("assembly-studio-analysis-settings", "{not json");
    assert.deepEqual(lib.loadSettings(), lib.DEFAULT_ANALYSIS_SETTINGS);
    AS().resetSettings();
    assert.deepEqual(AS().settings, lib.DEFAULT_ANALYSIS_SETTINGS);
    assert.deepEqual(JSON.parse(storage.get("assembly-studio-analysis-settings")), { fillThreshold: 0.1, cantileverLimit: 4, maxBlocks: null });
});

await test("the verdict says problems, warnings or stable, with the right plural", () => {
    assert.equal(lib.verdictOf(null), null);
    const v = (errors, warnings, blocks = 20) => lib.verdictOf({ errors, warnings, blocks });
    assert.deepEqual([v(0, 0).kind, v(0, 0).headline, v(0, 0).short], ["pass", "Stable · all checks pass", "Stable"]);
    assert.deepEqual([v(1, 0).kind, v(1, 0).headline, v(1, 0).short], ["fail", "1 problem found", "1 problem"]);
    assert.deepEqual([v(3, 2).kind, v(3, 2).headline, v(3, 2).short], ["fail", "3 problems found", "3 problems"]);
    assert.deepEqual([v(0, 1).kind, v(0, 1).headline], ["warn", "1 warning"]);
    assert.equal(v(0, 2).short, "2 warnings");
    assert.equal(lib.plural(1, "block"), "1 block");
    assert.equal(lib.plural(2, "block"), "2 blocks");
});

await test("a failing check selects the issues of its kind; a block belongs to its first (worst) issue", () => {
    const issues = [
        mkIssue("cog", "cog-outside", "error", [4, 5]),
        mkIssue("cantilever-1", "cantilever-too-long", "error", [5, 6, 7]),
        mkIssue("cantilever-2", "cantilever-too-long", "error", [12]),
        mkIssue("thin-features", "thin-features", "warning", []),
    ];
    assert.deepEqual(lib.issuesForCheck(issues, "long-cantilevers").map((i) => i.id), ["cantilever-1", "cantilever-2"]);
    assert.deepEqual(lib.issuesForCheck(issues, "cog").map((i) => i.id), ["cog"]);
    assert.deepEqual(lib.issuesForCheck(issues, "cantilevered"), [], "the cantilevered-blocks row is informational");
    const index = lib.indexIssuesByBlock(issues);
    assert.equal(index.get(5), "cog", "block 5 is in two issues: the first one wins");
    assert.equal(index.get(6), "cantilever-1");
    assert.equal(index.get(12), "cantilever-2");
    assert.equal(index.get(99), undefined);
    const group = lib.selectionView(issues, ["cantilever-1", "cantilever-2"], "Long cantilevers: 2 places");
    assert.deepEqual(group.highlight, [5, 6, 7, 12], "the union, ascending, without duplicates");
    assert.deepEqual(group.focusMm, issues[1].focusMm, "the camera goes to the first");
    assert.equal(group.label, "Long cantilevers: 2 places");
    assert.equal(lib.selectionView(issues, ["cog"]).label, "title cog");
    assert.equal(lib.selectionView(issues, ["nope"]), null);
    assert.deepEqual(lib.keepExistingIds(issues, ["cog", "gone"]), ["cog"]);
});

await test("showing an issue highlights its blocks and flies the camera; clearing and toggling work", () => {
    resetAnalysis();
    const issues = [mkIssue("cog", "cog-outside", "error", [4, 5], [10, 20, 30]), mkIssue("floating-2", "floating", "error", [9], [90, 90, 90])];
    AS().runStarted("m1");
    AS().runSucceeded("m1", mkResult({ issues }));
    assert.equal(AS().run.status, "idle");
    assert.equal(AS().resultModelId, "m1");
    AS().toggleIssue("cog");
    assert.deepEqual(AS().view.highlight, [4, 5]);
    assert.deepEqual(AS().view.focus.mm, [10, 20, 30]);
    assert.equal(AS().view.focus.label, "title cog");
    const token = AS().view.focus.token;
    AS().toggleIssue("floating-2");
    assert.deepEqual(AS().view.highlight, [9]);
    assert.ok(AS().view.focus.token > token, "every Show asks the camera again");
    AS().toggleIssue("floating-2");
    assert.equal(AS().selection, null, "pressing the shown issue again clears it");
    assert.deepEqual(AS().view.highlight, []);
    AS().selectIssues(["cog", "floating-2"], { check: "cog", label: "both" });
    assert.deepEqual(AS().view.highlight, [4, 5, 9]);
    assert.equal(AS().selection.check, "cog");
    AS().clearSelection();
    assert.deepEqual(AS().view.highlight, []);
    AS().selectIssues(["missing"]);
    assert.equal(AS().selection, null, "an id that does not exist selects nothing");
});

await test("hovering and clicking blocks in the viewer find their issue", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("cog", "cog-outside", "error", [4, 5]), mkIssue("floating-2", "floating", "error", [9])] }));
    AS().hoverBlock(5);
    assert.equal(AS().hoverIssueId, "cog");
    AS().hoverBlock(3);
    assert.equal(AS().hoverIssueId, null, "a block that is in no issue lights no card");
    AS().hoverBlock(null);
    assert.equal(AS().hoverIssueId, null);
    AS().clickBlock(9);
    assert.deepEqual(AS().selection.ids, ["floating-2"]);
    assert.deepEqual(AS().view.highlight, [9]);
    assert.equal(AS().view.focus, null, "a click on a block does not move the camera");
    AS().clickBlock(3);
    assert.equal(AS().selection, null, "a click on a block with no issue clears the selection");
    AS().clickBlock(4);
    AS().clickBlock(null);
    assert.equal(AS().selection, null, "a click on empty space clears it too");
});

await test("the cantilevered-blocks row shows the blocks themselves, looks at their middle and follows a re-run", () => {
    resetAnalysis();
    const withStatus = (statuses) => mkResult({ blocks: mkResult().blocks.map((b) => ({ ...b, status: statuses[b.index] ?? "supported" })) });
    const r1 = withStatus({ 3: "cantilever", 4: "cantilever", 5: "overreach" });
    assert.deepEqual(lib.cantileveredBlocks(r1.blocks), [3, 4, 5]);
    AS().runSucceeded("m1", r1);
    AS().selectBlocks(lib.cantileveredBlocks(r1.blocks), { check: "cantilevered", label: "Cantilevered blocks: 3 blocks" });
    assert.deepEqual(AS().view.highlight, [3, 4, 5]);
    assert.deepEqual(AS().selection.ids, []);
    assert.deepEqual(AS().view.focus.mm, r1.blocks[4].centerMm, "the camera looks at the block nearest the group's centre");
    AS().runSucceeded("m1", withStatus({ 7: "cantilever", 8: "cantilever" }));
    assert.deepEqual(AS().view.highlight, [7, 8], "a re-run with other settings shows the new cantilevered blocks");
    assert.equal(AS().selection.label, "Cantilevered blocks: 2");
    AS().runSucceeded("m1", withStatus({}));
    assert.equal(AS().selection, null, "no cantilevered blocks left, nothing to show");
    AS().selectBlocks([], { check: "cantilevered", label: "x" });
    assert.equal(AS().selection, null, "an empty group selects nothing");
});

await test("a thin-features issue turns the original model on, because that is the only place the lost parts show", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("thin-features", "thin-features", "warning", [])] }));
    assert.equal(AS().view.showGhost, false);
    AS().toggleIssue("thin-features");
    assert.equal(AS().view.showGhost, true);
    assert.deepEqual(AS().view.highlight, []);
    assert.ok(AS().view.focus, "the camera still goes to where material was dropped");
});

await test("a re-run of the same model keeps the selection that still exists; another model starts fresh", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("a", "floating", "error", [1]), mkIssue("b", "floating", "error", [2])] }));
    AS().setColorBy("reach");
    AS().setLayerMax(3);
    AS().toggleIssue("a");
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("a", "floating", "error", [1, 8])] }));
    assert.deepEqual(AS().selection.ids, ["a"]);
    assert.deepEqual(AS().view.highlight, [1, 8], "the highlight follows the new blocks of the same issue");
    assert.equal(AS().view.colorBy, "reach", "the colour mode is the user's");
    assert.equal(AS().view.layerMax, 3, "so is the layer cut");
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("b", "floating", "error", [2])] }));
    assert.equal(AS().selection, null, "an issue that no longer exists cannot stay selected");
    assert.deepEqual(AS().view.highlight, []);
    AS().toggleIssue("b");
    AS().runSucceeded("m2", mkResult({ issues: [mkIssue("b", "floating", "error", [2])], layers: 6 }));
    assert.equal(AS().selection, null, "a different model never inherits a selection");
    assert.equal(AS().view.layerMax, 5, "or a layer cut: it shows everything");
    assert.equal(AS().view.colorBy, "reach", "but keeps the colour mode");
    assert.equal(AS().summaries.m2.errors, 0);
});

await test("the layer cut follows the model: all layers stay all layers, a partial cut is clamped", () => {
    assert.equal(lib.nextLayerMax(null, 6), 5);
    assert.equal(lib.nextLayerMax({ layerMax: 9, layers: 10 }, 7), 6, "showing everything before = showing everything now");
    assert.equal(lib.nextLayerMax({ layerMax: 3, layers: 10 }, 7), 3);
    assert.equal(lib.nextLayerMax({ layerMax: 8, layers: 10 }, 5), 4, "clamped to the new top");
    assert.equal(lib.nextLayerMax(null, 0), 0);
});

// ---- regressions: picking an issue ----

const stubHandle = (url) => ({ url, extractTriangles: () => ({ positions: new Float32Array(9) }) });

/** A tall column (block k is in layer k) with issues high up and low down, to put the layer cut in the way. */
const mkTall = (over = {}) =>
    mkResult({
        blocks: Array.from({ length: 10 }, (_, k) => ({ index: k, cell: [0, 0, k], centerMm: [50, 50, k * 100 + 50], status: "supported", reach: 0, body: 0, fill: 1, cantilever: null })),
        issues: [
            mkIssue("arm", "cantilever-too-long", "error", [8, 9], [50, 50, 850]),
            mkIssue("low", "floating", "error", [0, 1], [50, 50, 150]),
            mkIssue("thin", "thin-features", "warning", [], [50, 50, 950]),
        ],
        stats: { ...mkResult().stats, blockCount: 10, layers: 10 },
        ...over,
    });

await test("a layer cut that would hide the picked blocks is raised to show them, says so, and is never lowered", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkTall());
    AS().setLayerMax(1);
    AS().toggleIssue("arm");
    assert.equal(AS().view.layerMax, 9, "layers 9-10 are above the cut of 2: the cut rises to the highest picked layer");
    assert.equal(AS().layerRaised, true, "and the panel is told, so the slider's move is no surprise");
    assert.deepEqual(AS().view.highlight, [8, 9]);
    AS().setLayerMax(4);
    assert.equal(AS().layerRaised, false, "the user's own move of the slider ends the note");
    AS().clearSelection();
    assert.equal(AS().view.layerMax, 4, "clearing never moves the cut back or on");
    AS().toggleIssue("low");
    assert.equal(AS().view.layerMax, 4, "blocks already in view leave the cut where the user put it (it is never lowered)");
    assert.equal(AS().layerRaised, false);
    AS().setLayerMax(0);
    AS().selectBlocks([8, 9], { check: "cantilevered", label: "Cantilevered blocks: 2" });
    assert.equal(AS().view.layerMax, 9, "a group of blocks (the cantilevered row) is kept in view the same way");
    assert.equal(AS().layerRaised, true);
    // The camera's point counts too: a thin-features issue has no block, but its focus is up at 950 mm.
    AS().clearSelection();
    AS().setLayerMax(2);
    AS().toggleIssue("thin");
    assert.equal(AS().view.layerMax, 9, "the point the camera flies to must not be cut away either");
    // The cut also follows a re-run that moves the pick upwards.
    AS().clearSelection();
    AS().setLayerMax(1);
    AS().toggleIssue("low");
    assert.equal(AS().view.layerMax, 1);
    AS().runSucceeded("m1", mkTall({ issues: [mkIssue("low", "floating", "error", [0, 1, 9], [50, 50, 150])] }));
    assert.deepEqual(AS().view.highlight, [0, 1, 9]);
    assert.equal(AS().view.layerMax, 9, "a settings change that puts the kept pick above the cut raises it");
    assert.equal(lib.layerMaxForSelection(mkTall(), [], null, 3), 3, "nothing to show: the cut stays");
});

await test("the callout goes with the pick: clearing, a vanished issue, a block click or another model all remove it", () => {
    resetAnalysis();
    const issues = [mkIssue("a", "floating", "error", [1], [10, 10, 10]), mkIssue("b", "floating", "error", [2], [20, 20, 20])];
    AS().runSucceeded("m1", mkResult({ issues }));
    AS().toggleIssue("a");
    assert.ok(AS().view.focus, "showing an issue puts the callout up");
    AS().clearSelection();
    assert.equal(AS().view.focus, null, "Clear highlight (and Esc, a click on empty space, the phone chip's x) takes the callout down too");
    AS().toggleIssue("a");
    AS().toggleIssue("a");
    assert.equal(AS().view.focus, null, "toggling the shown issue off does as well");
    AS().toggleIssue("a");
    AS().runSucceeded("m1", mkResult({ issues: [issues[1]] }));
    assert.equal(AS().selection, null);
    assert.equal(AS().view.focus, null, "a re-run in which the issue is gone must not leave a bubble pointing at nothing");
    AS().toggleIssue("b");
    AS().runSucceeded("m1", mkResult({ issues }));
    assert.equal(AS().selection.ids[0], "b");
    assert.ok(AS().view.focus, "a pick that survives a re-run keeps its callout");
    AS().toggleIssue("a");
    AS().clickBlock(2);
    assert.deepEqual(AS().selection.ids, ["b"]);
    assert.equal(AS().view.focus, null, "clicking a block of issue b must not leave issue a's callout up");
    // Another model: the pick of the last model's result goes at once, not only when the new result arrives.
    AS().toggleIssue("a");
    AS().modelChanged("m1", "/x.glb");
    assert.ok(AS().selection, "the same model keeps its pick");
    AS().modelChanged("m2", "/y.glb");
    assert.equal(AS().selection, null);
    assert.deepEqual(AS().view.highlight, []);
    assert.equal(AS().view.focus, null, "the peek chip and the callout of model A do not hang over model B");
    AS().toggleIssue("a");
    assert.ok(AS().selection);
    AS().runStarted("m1");
    assert.ok(AS().selection, "a re-run of the same model keeps it");
    AS().runStarted("m2");
    assert.equal(AS().selection, null, "a run for another model starts without it");
    assert.equal(AS().view.focus, null);
});

await test("a re-run that keeps the selection is not a new pick: the same object, the same serial", () => {
    resetAnalysis();
    const issues = [mkIssue("a", "cantilever-too-long", "error", [1, 2]), mkIssue("b", "cantilever-too-long", "error", [5])];
    AS().runSucceeded("m1", mkResult({ issues }));
    AS().toggleIssue("a");
    const picked = AS().selection;
    const serial = AS().selectionSerial;
    assert.equal(serial, 1);
    AS().runSucceeded("m1", mkResult({ issues }));
    assert.equal(AS().selection, picked, "the content is the same, so the selection keeps its identity");
    assert.equal(AS().selectionSerial, serial, "a settings change is not a pick: the phone's sheet stays open for the next one");
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("a", "cantilever-too-long", "error", [1, 2, 3]), issues[1]] }));
    assert.equal(AS().selection, picked, "even when the issue gained a block");
    assert.equal(AS().selectionSerial, serial);
    // A real pick moves the serial; clearing does not.
    AS().toggleIssue("b");
    assert.equal(AS().selectionSerial, serial + 1);
    AS().selectIssues(["a", "b"], { check: "long-cantilevers" });
    assert.equal(AS().selectionSerial, serial + 2);
    AS().clickBlock(1);
    assert.equal(AS().selectionSerial, serial + 3, "a click on a block is a pick too");
    AS().clearSelection();
    assert.equal(AS().selectionSerial, serial + 3);
    const prev = { ids: ["a"], check: null, label: "title a" };
    assert.equal(lib.reconcileSelection({ issues, blocks: mkResult().blocks }, prev).selection, prev, "reconcileSelection hands back the previous object when nothing changed");
    const group = { ids: [], check: "cantilevered", label: "Cantilevered blocks: 2" };
    const blocks = mkResult().blocks.map((b) => ({ ...b, status: b.index === 3 || b.index === 4 ? "cantilever" : "supported" }));
    assert.equal(lib.reconcileSelection({ issues: [], blocks }, group).selection, group, "so does a block group with the same count");
});

await test("a model the viewer cannot show is 'unavailable', not 'loading' for ever", () => {
    const phase = (o) => lib.derivePhase({ modelId: "m1", ready: false, run: lib.IDLE_RUN, resultModelId: null, ...o });
    assert.equal(phase({}), "loading");
    assert.equal(phase({ unavailable: true }), "unavailable", "the viewer failed or has no WebGL: no triangles will arrive");
    assert.equal(phase({ unavailable: true, modelId: null }), "no-model");
    assert.equal(phase({ unavailable: true, ready: true }), "loading", "a model that did load is never unavailable");
    resetAnalysis();
    AS().modelFailed("/x.glb", "Bad GLB");
    assert.deepEqual(AS().viewerFailure, { url: "/x.glb", message: "Bad GLB" });
    AS().setLoaded(stubHandle("/x.glb"));
    assert.equal(AS().viewerFailure, null, "the viewer's Try again that worked clears it");
});

await test("a viewer handle of another model is dropped at once; the same model's handle stays", () => {
    resetAnalysis();
    AS().setLoaded(stubHandle("/a.glb"));
    AS().modelChanged("m1", "/a.glb");
    assert.equal(AS().loaded.url, "/a.glb");
    AS().modelChanged("m2", "/b.glb");
    assert.equal(AS().loaded, null, "A to B: A's handle reads an empty list once the viewer disposes its scene, so it must not count as ready");
    AS().setLoaded(stubHandle("/b.glb"));
    AS().modelChanged("m2", "/b.glb");
    assert.equal(AS().loaded.url, "/b.glb");
    AS().modelChanged(null, null);
    assert.equal(AS().loaded, null, "no model, no handle");
});

await test("floating parts are judged against the original model, and a cog row with nothing on the ground opens them", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult({ issues: [mkIssue("floating-1", "floating", "error", [3]), mkIssue("cantilever-0", "cantilever-too-long", "error", [4])] }));
    AS().toggleIssue("cantilever-0");
    assert.equal(AS().view.showGhost, false, "a long cantilever needs no mesh to be judged");
    AS().toggleIssue("floating-1");
    assert.equal(AS().view.showGhost, true, "a thin joint under the fill threshold looks like a gap in the blocks: the mesh shows which");
    const issues = [mkIssue("floating-1", "floating", "error", [3]), mkIssue("floating-2", "floating", "error", [4]), mkIssue("cantilever-0", "cantilever-too-long", "error", [5])];
    const cogFail = { key: "cog", status: "fail" };
    assert.deepEqual(lib.issuesForCheckRow({ issues, stability: null }, cogFail).map((i) => i.id), ["floating-1", "floating-2"]);
    assert.deepEqual(lib.issuesForCheckRow({ issues, stability: { inside: false } }, cogFail), [], "with a base the failing row is the cog issue's, which has its own");
    assert.deepEqual(lib.issuesForCheckRow({ issues, stability: null }, { key: "cog", status: "pass" }), []);
    assert.deepEqual(lib.issuesForCheckRow({ issues, stability: null }, { key: "long-cantilevers", status: "fail" }).map((i) => i.id), ["cantilever-0"]);
});

await test("a card of a multi-selection says 'show only this'; only a lone selection says 'clear'", () => {
    assert.equal(lib.selectionRole(null, "a"), "none");
    assert.equal(lib.selectionRole({ ids: ["a"] }, "a"), "only");
    assert.equal(lib.selectionRole({ ids: ["a", "b", "c"] }, "b"), "member");
    assert.equal(lib.selectionRole({ ids: ["a", "b"] }, "z"), "none");
    assert.equal(lib.selectionRole({ ids: [] }, "a"), "none");
    resetAnalysis();
    const issues = [mkIssue("f1", "floating", "error", [1]), mkIssue("f2", "floating", "error", [2])];
    AS().runSucceeded("m1", mkResult({ issues }));
    AS().selectIssues(["f1", "f2"], { check: "floating" });
    assert.equal(lib.selectionRole(AS().selection, "f1"), "member");
    AS().toggleIssue("f1");
    assert.deepEqual(AS().selection.ids, ["f1"], "pressing a card of a group narrows to it, as its label says");
    assert.equal(lib.selectionRole(AS().selection, "f1"), "only");
});

await test("custom settings are named: the verdict carries 'limit 9, fill 60%' when they are not the assignment's", () => {
    assert.equal(lib.customSettingsNote(lib.DEFAULT_ANALYSIS_SETTINGS), null);
    assert.equal(lib.customSettingsNote({ cantileverLimit: 9, fillThreshold: 0.6 }), "limit 9, fill 60%");
    assert.equal(lib.customSettingsNote({ cantileverLimit: 4, fillThreshold: 0.1, maxBlocks: 80 }), "budget 80");
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9 }).custom, null, "a summary without the numbers says nothing");
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9, cantilever_limit: 4, fill_threshold: 0.1 }).custom, null);
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9, cantilever_limit: 9, fill_threshold: 0.1 }).custom, "limit 9");
    assert.equal(lib.verdictOf({ errors: 1, warnings: 0, blocks: 9, cantilever_limit: 4, fill_threshold: 0.6 }).custom, "fill 60%");
});

await test("report text that names +X or -Y gets the directions line", () => {
    assert.equal(lib.mentionsAxes(["a part sticks out 5 blocks towards -Y and +X from its last support"]), true);
    assert.equal(lib.mentionsAxes(["Outside the base · 237 mm towards +X"]), true);
    assert.equal(lib.mentionsAxes(["Inside the base · 120 mm margin", "None longer than 4 blocks"]), false);
    assert.equal(lib.mentionsAxes(["a 3-X mark", "e+Y"]), false, "only a direction word, not a letter in a longer token");
});

await test("a summary that lands after the user opened another project is not added to it", async () => {
    resetAnalysis();
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    S().setProject(detail(p1));
    const mA = { ...modelFor(makeJob(p1)), id: "model-late", analysis: null };
    S().addModel(mA);
    fake.putDelay = 60;
    const pending = lib.saveSummary("model-late", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary({ errors: 3 }));
    await sleep(10);
    const mine = { ...modelFor(makeJob(p2)), id: "model-p2", analysis: null };
    S().setProject(detail(p2, { models: [mine] }));
    await pending;
    assert.equal(calls.filter((c) => c.method === "PUT").length, 1, "the summary was saved on the server");
    assert.deepEqual(S().models.map((m) => m.id), ["model-p2"], "but the project opened meanwhile did not get a foreign model");
    assert.equal(S().activeModelId, "model-p2");
});

await test("the report phase: no model, loading, running, failed, done; a run for another model never counts", () => {
    const run = (over = {}) => ({ ...lib.IDLE_RUN, ...over });
    const phase = (o) => lib.derivePhase({ modelId: "m1", ready: true, run: run(), resultModelId: null, ...o });
    assert.equal(phase({ modelId: null }), "no-model");
    assert.equal(phase({ ready: false }), "loading");
    assert.equal(phase({}), "loading", "ready but not started yet");
    assert.equal(phase({ run: run({ modelId: "m1", status: "running" }) }), "running");
    assert.equal(phase({ run: run({ modelId: "m1", status: "running" }), resultModelId: "m1" }), "running", "a re-run over an old result");
    assert.equal(phase({ run: run({ modelId: "m2", status: "running" }) }), "loading", "another model's run is not this one's");
    assert.equal(phase({ run: run({ modelId: "m1", status: "error", error: "x" }) }), "error");
    assert.equal(phase({ resultModelId: "m1" }), "done");
    assert.equal(phase({ resultModelId: "m2" }), "loading", "a result for another model is not shown");
});

await test("a run that fails is reported for its model only, and progress is only taken while running", () => {
    resetAnalysis();
    AS().runStarted("m1");
    AS().runProgress("m1", "Filling the inside", 0.5);
    assert.deepEqual([AS().run.stage, AS().run.progress], ["Filling the inside", 0.5]);
    AS().runProgress("m2", "other", 0.9);
    assert.equal(AS().run.progress, 0.5, "progress for another model is ignored");
    AS().runFailed("m2", "boom");
    assert.equal(AS().run.status, "running", "a failure for another model is ignored");
    AS().runFailed("m1", "The model has no usable geometry.");
    assert.deepEqual([AS().run.status, AS().run.error], ["error", "The model has no usable geometry."]);
    AS().runProgress("m1", "late", 0.7);
    assert.equal(AS().run.progress, 0, "a late progress after the failure changes nothing");
    const attempt = AS().attempt;
    AS().retry();
    assert.equal(AS().attempt, attempt + 1, "Retry bumps the counter the runner watches");
});

await test("the summary is saved once per model and settings, not when the server already has it", async () => {
    resetAnalysis();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid)), id: "model-a", analysis: null };
    S().addModel(model);
    const puts = () => calls.filter((c) => c.method === "PUT");
    await lib.saveSummary("model-a", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary({ errors: 2 }));
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].path, "/models/model-a/analysis");
    assert.equal(puts()[0].body.summary.errors, 2);
    assert.equal(S().models.find((m) => m.id === "model-a").analysis.errors, 2, "the model row carries the stored summary");
    await lib.saveSummary("model-a", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary({ errors: 2 }));
    assert.equal(puts().length, 1, "the same model and settings are not saved twice");
    await lib.saveSummary("model-a", { ...lib.DEFAULT_ANALYSIS_SETTINGS, fillThreshold: 0.5 }, mkSummary({ errors: 1, fill_threshold: 0.5 }));
    assert.equal(puts().length, 2, "other settings are a new summary");
    // The server already has the same numbers (an older visit): opening the project must not rewrite them.
    S().addModel({ ...model, id: "model-b", analysis: mkSummary({ analyzed_at: "2020-01-01T00:00:00Z" }) });
    await lib.saveSummary("model-b", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary());
    assert.equal(puts().length, 2);
});

await test("a summary that cannot be saved is ignored quietly and tried again on the next run", async () => {
    resetAnalysis();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    S().addModel({ ...modelFor(makeJob(pid)), id: "model-c", analysis: null });
    fake.putAnalysis = () => ({ status: 500, json: { error: "down" } });
    await lib.saveSummary("model-c", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary());
    assert.equal(lib.toasts.length, 0, "no toast for a failed save");
    assert.equal(S().models.find((m) => m.id === "model-c").analysis, null);
    let attempts = 0;
    fake.putAnalysis = (id, summary) => (++attempts, { status: 200, json: { model: { ...S().models.find((m) => m.id === id), analysis: summary } } });
    await lib.saveSummary("model-c", lib.DEFAULT_ANALYSIS_SETTINGS, mkSummary());
    assert.equal(attempts, 1);
    assert.ok(S().models.find((m) => m.id === "model-c").analysis);
});

await test("opening the analysis for a model makes it the active one, switches the tab and asks a phone to show the canvas", () => {
    resetAnalysis();
    S().setProject(detail(crypto.randomUUID()));
    S().addModel({ ...modelFor(makeJob(crypto.randomUUID())), id: "model-d" });
    S().addModel({ ...modelFor(makeJob(crypto.randomUUID())), id: "model-e" });
    S().setActiveModel("model-d");
    lib.openAnalysisFor("model-e");
    assert.equal(S().activeModelId, "model-e");
    assert.equal(S().workspaceTab, "analysis");
    assert.equal(AS().openRequest, 1);
    assert.equal(AS().sheetOpen, true);
    lib.openAnalysisFor("model-e");
    assert.equal(AS().openRequest, 2, "asking again is a new request even though nothing else changed");
});

await test("the report panel takes its full width from the viewer when the model keeps room, and overlaps the stage in a narrow window", () => {
    const dock = 344;
    // 1100 px free: the model keeps 756 px beside the panel.
    assert.equal(lib.dockFits(1100, dock), true);
    assert.equal(lib.dockInset(1100, dock), dock);
    // The least that still fits is exactly MIN_STAGE_PX of model beside the panel.
    assert.equal(lib.dockFits(dock + lib.MIN_STAGE_PX, dock), true);
    assert.equal(lib.dockFits(dock + lib.MIN_STAGE_PX - 1, dock), false);
    // 480 px free (an 800 px window beside the chat): the panel overlaps, the model keeps MIN_STAGE_PX.
    assert.equal(lib.dockInset(480, dock), 480 - lib.MIN_STAGE_PX);
    // Narrower than the model needs: no inset at all, never negative.
    assert.equal(lib.dockInset(300, dock), 0);
    assert.equal(lib.dockInset(0, dock), 0);
});

await test("two summaries are the same when the numbers agree, whatever the time says", () => {
    assert.equal(lib.sameSummary(mkSummary(), mkSummary({ analyzed_at: "1999-01-01T00:00:00Z" })), true);
    assert.equal(lib.sameSummary(mkSummary(), mkSummary({ errors: 1 })), false);
    assert.equal(lib.sameSummary(mkSummary(), mkSummary({ fill_threshold: 0.4 })), false);
    assert.equal(lib.sameSummary(null, mkSummary()), false);
    assert.equal(lib.settingsKey(lib.DEFAULT_ANALYSIS_SETTINGS), "1000|100|0.1|4|-");
    assert.equal(lib.fmtSignedMm(120.4), "+120");
    assert.equal(lib.fmtSignedMm(-45.6), "−46");
    assert.equal(lib.fmtMm(1234.4), "1,234");
    assert.equal(lib.scaleLine(mkResult()), "Scaled to 1000 × 640 × 820 mm · 20 blocks of 100 mm");
    assert.equal(lib.reportStem("a-lamp-meshy.glb"), "a-lamp-meshy-analysis");
    const standing = mkResult({ stability: { inside: true, marginMm: 120.4 }, stats: { ...mkResult().stats, longestCantilever: 3 } });
    assert.equal(lib.passingSentence(standing), "The centre of gravity sits 120 mm inside the support base. The longest cantilever is 3 blocks of the 4 allowed.");
    assert.equal(lib.passingSentence(mkResult()), "Nothing hangs without support.");
});

// The runner end to end: a real (synthetic) model through the real engine, on the main-thread fallback.
function boxSoup(boxes) {
    const tri = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const out = [];
    for (const [a, b] of boxes) {
        const v = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], b[1], a[2]], [a[0], b[1], a[2]], [a[0], a[1], b[2]], [b[0], a[1], b[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]];
        for (const t of tri) for (const i of t) out.push(...v[i]);
    }
    return { positions: new Float32Array(out) };
}
// A column with a 7-block arm at the top: the arm is a cantilever longer than 4 blocks.
const CRANE = boxSoup([[[0, 0, 0], [100, 100, 600]], [[100, 0, 500], [800, 100, 600]]]);
const loadedModel = (url, soup = CRANE) => ({ url, extractTriangles: () => soup });
const until = async (cond, ms = 4000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await sleep(20);
    }
};

await test("the runner analyses the model once it is in the viewer, saves the summary and re-runs when a setting changes", async () => {
    resetAnalysis();
    lib.useAnalysisStore.setState({ settings: lib.sanitizeSettings(null) });
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid)), id: "run-1", glb_url: "/run-1.glb", analysis: null };
    S().addModel(model);
    let stop = mountHook(() => lib.useAnalysisRunner(model));
    await sleep(60);
    assert.equal(AS().run.status, "idle", "nothing runs before the viewer reports the model");
    assert.equal(AS().result, null);

    AS().setLoaded(loadedModel("/other.glb"));
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await sleep(60);
    assert.equal(AS().result, null, "a different model's geometry is never analysed for this one");

    AS().setLoaded(loadedModel("/run-1.glb"));
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().resultModelId === "run-1");
    assert.equal(AS().run.status, "idle");
    assert.ok(AS().result.issues.some((i) => i.kind === "cantilever-too-long"), "the engine found the long arm");
    assert.equal(AS().summaries["run-1"].errors, AS().result.issues.filter((i) => i.severity === "error").length, "the summary counts the same problems the list shows");
    await until(() => calls.some((c) => c.method === "PUT"));
    assert.equal(calls.filter((c) => c.method === "PUT").length, 1);
    assert.equal(calls.find((c) => c.method === "PUT").path, "/models/run-1/analysis");
    assert.equal(S().models.find((m) => m.id === "run-1").analysis.blocks, AS().result.stats.blockCount, "the model row carries the saved summary");

    // A setting changes: the same model analysed again after a pause, and saved with the new settings.
    AS().updateSettings({ cantileverLimit: 9 });
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await sleep(120);
    assert.equal(AS().result.settings.cantileverLimit, 4, "not yet: the run waits for the pause");
    await until(() => AS().result.settings.cantileverLimit === 9);
    assert.ok(!AS().result.issues.some((i) => i.kind === "cantilever-too-long"), "a limit of 9 lets the 8-block arm stand (the model is scaled up to 1000 mm)");
    await until(() => calls.filter((c) => c.method === "PUT").length === 2);
    stop();
});

await test("leaving the model aborts its run; a failing extraction is shown as an error with its message", async () => {
    resetAnalysis();
    const model = { ...modelFor(makeJob(crypto.randomUUID())), id: "run-2", glb_url: "/run-2.glb", analysis: null };
    S().addModel(model);
    AS().setLoaded(loadedModel("/run-2.glb"));
    let stop = mountHook(() => lib.useAnalysisRunner(model));
    stop(); // the model changed before the run began: cleanup clears the timer and aborts
    await sleep(150);
    assert.equal(AS().result, null, "an aborted run never lands");
    assert.notEqual(AS().run.status, "error", "an abort is not an error");

    AS().setLoaded({ url: "/run-2.glb", extractTriangles: () => { throw new Error("The model has no geometry to read."); } });
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().run.status === "error");
    assert.equal(AS().run.error, "The model has no geometry to read.");
    assert.equal(lib.derivePhase({ modelId: "run-2", ready: true, run: AS().run, resultModelId: AS().resultModelId }), "error");
    // Retry: the counter changes, the runner starts again (and fails again here).
    const before = calls.length;
    AS().retry();
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().run.status === "error" && AS().attempt === 1);
    stop();
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "a failed run saves nothing");
    assert.ok(before >= 0);
});

await test("a viewer handle with no triangles is not analysed: no 'No blocks' result, nothing cached or saved, and a fresh handle runs", async () => {
    resetAnalysis();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid)), id: "run-3", glb_url: "/run-3.glb", analysis: null };
    S().addModel(model);
    let reads = 0;
    // The viewer disposed (or is reloading) the scene this handle reads from: it answers with an empty list.
    AS().setLoaded({ url: "/run-3.glb", extractTriangles: () => (reads++, { positions: new Float32Array(0) }) });
    let stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => reads >= 2, 3000);
    assert.equal(AS().result, null, "an empty list is a viewer with nothing to give, not a model without blocks");
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "so no bogus summary is saved to the shared model");
    assert.equal(AS().run.status, "running", "it looks again shortly");
    // The viewer finished its reload and reports a fresh handle: the runner starts again with it.
    AS().setLoaded(loadedModel("/run-3.glb"));
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().resultModelId === "run-3");
    assert.ok(AS().result.stats.blockCount > 0, "the real model was analysed: nothing empty was cached under its url");
    assert.equal(AS().result.issues.some((i) => i.kind === "empty"), false);
    stop();
});

await test("a viewer that never gives its triangles ends in an error with Try again, never a saved 'no blocks'", async () => {
    resetAnalysis();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid)), id: "run-4", glb_url: "/run-4.glb", analysis: null };
    S().addModel(model);
    const waits = [...lib.NOT_READY_RETRY_MS];
    lib.NOT_READY_RETRY_MS.splice(0, lib.NOT_READY_RETRY_MS.length, 5, 5);
    let reads = 0;
    let stop = () => {};
    try {
        AS().setLoaded({ url: "/run-4.glb", extractTriangles: () => (reads++, { positions: new Float32Array(0) }) });
        stop = mountHook(() => lib.useAnalysisRunner(model));
        await until(() => AS().run.status === "error");
        assert.equal(reads, 3, "one read and one per retry");
        assert.match(AS().run.error, /no geometry to read/);
        assert.equal(lib.derivePhase({ modelId: "run-4", ready: true, run: AS().run, resultModelId: AS().resultModelId }), "error");
        assert.equal(AS().result, null);
        assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
    } finally {
        stop();
        lib.NOT_READY_RETRY_MS.splice(0, lib.NOT_READY_RETRY_MS.length, ...waits);
    }
});

// ================= api and layout =================

await test("a poll that times out counts as a failed attempt, not an abort", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new DOMException("timed out", "TimeoutError");
    };
    try {
        await assert.rejects(lib.getJob("x"), (err) => err.name === "ApiRequestError" && err.status === 0 && /too long/.test(err.message));
    } finally {
        globalThis.fetch = original;
    }
});

await test("only printable ASCII is accepted as an access code", () => {
    assert.equal(lib.isValidAccessCode("abcDEF-123+/="), true);
    assert.equal(lib.isValidAccessCode("pässword"), false);
    assert.equal(lib.isValidAccessCode("tab\tcode"), false);
    assert.equal(lib.isValidAccessCode(""), false);
    lib.setAccessCode("pässword");
    fake.cancel = (id, record) => {
        assert.equal(record.headers["x-access-code"], undefined, "a code that cannot be a header is not sent");
        return { status: 200, json: { job: makeJob(crypto.randomUUID()) } };
    };
    return lib.cancelJob("j");
});

await test("the chat panel is at least as wide as the composer needs, at every window width", () => {
    for (let width = 768; width <= 3840; width += 16) {
        const { preferred, min } = lib.chatSizesFor(width);
        assert.ok(min <= preferred && preferred <= lib.CHAT_MAX_PCT, `ordering at ${width}`);
        const px = (preferred / 100) * width;
        assert.ok(px >= Math.min(320, 0.4 * width) - 1, `${width}px window: panel ${px}px`);
        assert.ok(px >= 330 || preferred === lib.CHAT_MAX_PCT || width > 1360, `${width}px`);
    }
    const narrow = lib.chatSizesFor(800);
    assert.ok((narrow.preferred / 100) * 800 >= 320, "320 px of chat at an 800 px window");
    assert.ok((narrow.min / 100) * 800 >= 280, "never dragged below 280 px there");
    assert.deepEqual(lib.chatSizesFor(1920), { preferred: 25, min: 18 }, "wide windows keep the old proportions");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
