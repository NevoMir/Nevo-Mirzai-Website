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
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-store-test");
mkdirSync(outDir, { recursive: true });
// The bundle looks for Awatif's solver beside itself (as the browser does beside the page's script): put it there.
mkdirSync(path.join(outDir, "vendor"), { recursive: true });
copyFileSync(path.join(root, "src/assignment/analysis/fem/vendor/lSolver.wasm"), path.join(outDir, "vendor/lSolver.wasm"));

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
export * from "@/assignment/store/stabilize";
export * from "@/assignment/store/stabilizeLogic";
export { MATERIAL_FACTS, materialLine, pointLine, solverLine } from "@/assignment/components/analysis/stressText";
export { STRESS_MATERIALS, STRESS_WARN, STRESS_FAIL } from "@/assignment/analysis/materials";
export { analyzeAssembly, originalOf } from "@/assignment/analysis/assembly";
export { applyStress, computeStress } from "@/assignment/analysis/stress";
export { solveFrameTs } from "@/assignment/analysis/fem/index";
export { descriptorFromBlocks } from "@/assignment/shared/assembly";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
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
                // The stabilizer's runner (a Web Worker plus Vite's ?url import of the WASM) is replaced by the tests with fakes.
                b.onResolve({ filter: /analysis\/stabilize\/runStabilize$/ }, () => ({ path: "stabilize-run-stub", namespace: "shim" }));
                b.onLoad({ filter: /^stabilize-run-stub$/, namespace: "shim" }, () => ({
                    contents: 'export const runStabilize = async () => { throw new Error("the real stabilizer is not used here"); };',
                    loader: "js",
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
const INITIAL_VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [], compare: "stabilized", focus: null };
const resetAnalysis = () => {
    lib.forgetSavedSummaries();
    fake.putDelay = 0;
    fake.putAnalysis = (id, summary) => ({ status: 200, json: { model: { ...(S().models.find((m) => m.id === id) ?? modelFor(makeJob(crypto.randomUUID()))), id, analysis: summary } } });
    lib.useAnalysisStore.setState({
        settings: lib.sanitizeSettings(null), loaded: null, viewerFailure: null, run: lib.IDLE_RUN, result: null, resultModelId: null,
        blockIssues: new Map(), summaries: {}, view: INITIAL_VIEW, colorChoice: "status", originalResult: null, originalFor: null,
        originalState: "idle", pendingCompare: null, preview: null, selection: null, stepSelection: null, selectionSerial: 0, layerRaised: false,
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
    assert.deepEqual(wild, { targetSizeMm: 1000, blockSizeMm: 100, fillThreshold: 0.9, cantileverLimit: 10, maxBlocks: null, material: "concrete" });
    assert.equal(lib.sanitizeSettings({ material: "timber" }).material, "timber");
    assert.equal(lib.sanitizeSettings({ material: "gold" }).material, "concrete", "an unknown material is the default");
    assert.equal(lib.sanitizeSettings({ material: 7 }).material, "concrete");
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
    assert.deepEqual(JSON.parse(storage.get("assembly-studio-analysis-settings")), { fillThreshold: 0.5, cantileverLimit: 3, maxBlocks: 120, material: "concrete" });
    AS().updateSettings({ material: "timber" });
    assert.equal(JSON.parse(storage.get("assembly-studio-analysis-settings")).material, "timber", "the material is remembered");
    assert.equal(lib.loadSettings().material, "timber");
    AS().updateSettings({ material: "concrete" });
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
    assert.deepEqual(JSON.parse(storage.get("assembly-studio-analysis-settings")), { fillThreshold: 0.1, cantileverLimit: 4, maxBlocks: null, material: "concrete" });
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
    assert.equal(lib.settingsKey(lib.DEFAULT_ANALYSIS_SETTINGS), "1000|100|0.1|4|-|concrete");
    assert.notEqual(lib.settingsKey({ ...lib.DEFAULT_ANALYSIS_SETTINGS, material: "timber" }), lib.settingsKey(lib.DEFAULT_ANALYSIS_SETTINGS), "another material is another analysis");
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


// ================= stress, compare and the stabilizer =================

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const box = (x0, x1, y0, y1, z0, z1) => range(x1 - x0, x0).flatMap((i) => range(y1 - y0, y0).flatMap((j) => range(z1 - z0, z0).map((k) => [i, j, k])));
const uniq = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];
/** A 5-block column on a 6 x 3 base with an arm of `n` blocks off its top: 5 blocks is past the limit of 4 (2 errors, 106 %). */
const armCells = (n) => uniq([...box(0, 6, 0, 3, 0, 1), ...box(0, 1, 1, 2, 1, 6), ...range(n, 1).map((i) => [i, 1, 5])]);
const TS = { solve: lib.solveFrameTs, backend: "ts" };
const plainDesc = (cells) => lib.descriptorFromBlocks(cells.map((cell) => ({ cell })));
const addedDesc = (cells, added, role = "column", step = 1) => lib.descriptorFromBlocks([...cells.map((cell) => ({ cell })), ...added.map((cell) => ({ cell, role, step }))]);
/** The engine's own result for an assembly, with the stress estimate (what the runner leaves in the store). */
const measured = (desc, settings = lib.sanitizeSettings(null)) => {
    const base = lib.analyzeAssembly(desc, null, settings);
    return lib.applyStress(base, lib.computeStress(base, TS));
};
const TIP_COLUMN = [1, 2, 3, 4].map((k) => [5, 1, k]);

await test("the material is named when it is not concrete: the settings note and the verdict", () => {
    assert.equal(lib.customSettingsNote({ material: "timber" }), "material timber");
    assert.equal(lib.customSettingsNote({ cantileverLimit: 9, material: "timber" }), "limit 9, material timber");
    assert.equal(lib.customSettingsNote({ material: "concrete" }), null);
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9, stress: { material: "timber" } }).custom, "material timber", "a saved summary says it in its stress part");
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9, stress: { material: "concrete" } }).custom, null);
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9, material: "timber" }).custom, "material timber");
});

await test("two summaries differ when their stress differs; one saved before the estimate existed is not the same as one with it", () => {
    const stress = { material: "concrete", max_utilisation: 0.5, max_at: [1, 1, 0], stressed_blocks: 0, overstressed_blocks: 0, analysed_blocks: 20, unsupported_blocks: 0 };
    assert.equal(lib.sameSummary(mkSummary({ stress }), mkSummary({ stress: { ...stress } })), true);
    assert.equal(lib.sameSummary(mkSummary({ stress }), mkSummary({ stress: { ...stress, max_utilisation: 0.9 } })), false);
    assert.equal(lib.sameSummary(mkSummary({ stress }), mkSummary({ stress: { ...stress, material: "timber" } })), false);
    assert.equal(lib.sameSummary(mkSummary(), mkSummary({ stress })), false, "an old stored summary is saved again with its stress");
    assert.equal(lib.sameSummary(mkSummary(), mkSummary({ stress: null })), true, "nothing on the ground: no stress, nothing to add");
});

await test("the report's words: the passing sentence names the peak stress, a block assembly is not 'scaled'", () => {
    const standing = mkResult({ stability: { inside: true, marginMm: 120.4 }, stats: { ...mkResult().stats, longestCantilever: 3 }, stress: { maxUtilisation: 0.543 } });
    assert.equal(lib.passingSentence(standing), "The centre of gravity sits 120 mm inside the support base. The longest cantilever is 3 blocks of the 4 allowed. The highest joint stress is 54% of what the joints allow.");
    assert.equal(lib.fmtPct(0.734), "73%");
    assert.equal(lib.scaleLine(mkResult({ assembly: { roleCounts: [20, 0, 0, 0, 0, 0], steps: 0 } })), "Block assembly · 20 blocks of 100 mm");
    assert.equal(lib.scaleLine(mkResult({ assembly: { roleCounts: [16, 4, 0, 0, 0, 0], steps: 1 } })), "Block assembly built by the stabilizer · 20 blocks of 100 mm");
});

await test("the screen's material words are the solver's numbers (they are kept apart so the panel does not load the solver)", () => {
    for (const id of ["concrete", "timber"]) {
        const f = lib.MATERIAL_FACTS[id];
        const m = lib.STRESS_MATERIALS[id];
        assert.equal(f.label, m.label, id);
        assert.equal(f.detail, m.detail, id);
        assert.equal(f.density, m.fem.rho, id);
        assert.equal(f.youngGPa * 1e9, m.fem.E, id);
        assert.equal(f.tensionMPa * 1e6, m.fem.jointTension, id);
        assert.equal(f.compressionMPa * 1e6, m.fem.compression, id);
        assert.equal(f.shearMPa * 1e6, m.fem.shear, id);
    }
    assert.equal(lib.materialLine("concrete"), "Concrete blocks, mortar joints (2400 kg/m³, E 30 GPa; joints take 0.2 MPa tension, 20 MPa compression, 1 MPa shear)");
    assert.match(lib.solverLine({ backend: "wasm", ms: 12.4 }), /^Solved in 12 ms in your browser with Awatif FEM \(open source, MIT\), one beam per shared face\.$/);
    assert.match(lib.solverLine({ backend: "ts", ms: 0.4 }), /under 1 ms.*Awatif FEM \(open source, MIT\) \(TypeScript build of its solver\)/);
    assert.equal(lib.STRESS_WARN, 0.75, "the warning level the screen and the viewer share");
    assert.equal(lib.STRESS_FAIL, 1);
});

await test("stress points are described the way the list shows them", () => {
    const line = lib.pointLine({ mode: "tension", joint: [[4, 5, 6], [5, 5, 6]], cell: [4, 5, 6], utilisation: 0.73, allowableKPa: 200 });
    assert.equal(line, "Tension · joint (4, 5, 6)–(5, 5, 6) · 146 of 200 kPa");
    assert.equal(lib.pointLine({ mode: "shear", joint: null, cell: [1, 2, 3], utilisation: 0.5, allowableKPa: 1000 }), "Shear · block (1, 2, 3) · 500 of 1000 kPa");
});

await test("the colour mode: stress and role fall back to status when they cannot be drawn, and come back when they can", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult());
    AS().setColorBy("stress");
    assert.equal(AS().colorChoice, "stress", "the choice is remembered");
    assert.equal(AS().view.colorBy, "status", "no stress estimate: the stage keeps the status colours");
    AS().setColorBy("role");
    assert.equal(AS().view.colorBy, "status", "no added blocks: nothing to colour by role");
    const withStress = measured(plainDesc(armCells(4)));
    assert.ok(withStress.stress, "the engine made an estimate");
    AS().setColorBy("stress");
    AS().runSucceeded("m1", withStress);
    assert.equal(AS().view.colorBy, "stress", "the estimate arrived: the choice takes effect");
    AS().runSucceeded("m1", mkResult());
    assert.equal(AS().view.colorBy, "status", "and goes again when a re-run has none");
    assert.equal(lib.resolveColorBy("stress", { stress: true, roles: false, forceRole: false }), "stress");
    assert.equal(lib.resolveColorBy("layer", { stress: false, roles: false, forceRole: true }), "role", "a forced role colouring beats the choice");
});

await test("compare: only a block assembly has it; Overlay paints by role and leaves with any other colouring; the choice survives", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult());
    AS().setCompare("overlay");
    assert.equal(AS().view.compare, "stabilized", "a mesh model has no overlay");
    const stab = measured(addedDesc(armCells(5), TIP_COLUMN));
    assert.equal(lib.hasAddedBlocks(stab), true);
    assert.deepEqual(lib.compareInfo(stab), { originalCount: 28, addedCount: 4, originalAvailable: true });
    assert.equal(lib.compareInfo(mkResult()), null);
    assert.equal(lib.hasAddedBlocks(measured(plainDesc(armCells(5)))), false, "an assembly with nothing added has no role colouring either");
    AS().runSucceeded("s1", stab);
    AS().setColorBy("layer");
    AS().setCompare("overlay");
    assert.equal(AS().view.compare, "overlay");
    assert.equal(AS().view.colorBy, "role", "Overlay forces the role colours");
    assert.equal(AS().colorChoice, "layer", "without forgetting the user's choice");
    AS().setColorBy("stress");
    assert.equal(AS().view.compare, "stabilized", "another colouring is the stabilized view");
    assert.equal(AS().view.colorBy, "stress");
    AS().setCompare("overlay");
    AS().setColorBy("role");
    assert.equal(AS().view.compare, "overlay", "the role colouring is what Overlay is");
    AS().setCompare("stabilized");
    assert.equal(AS().view.colorBy, "role", "the choice made inside Overlay stays");
    AS().setColorBy("layer");
    AS().setCompare("overlay");
    AS().setCompare("stabilized");
    assert.equal(AS().view.colorBy, "layer", "leaving Overlay gives the colouring back");
    // Another model starts on its own view.
    AS().setCompare("overlay");
    AS().modelChanged("s2", "/s2.glb");
    assert.equal(AS().view.compare, "stabilized");
    assert.equal(lib.stageResultOf({ result: stab, resultModelId: "s1", compare: "overlay", originalResult: null, originalFor: null, preview: null }), stab);
});

await test("the original half of a stabilized model is analysed once, in the same frame, with its own stress; a re-run makes it again", async () => {
    resetAnalysis();
    const stab = measured(addedDesc(armCells(5), TIP_COLUMN));
    AS().runSucceeded("s1", stab);
    AS().setCompare("original");
    assert.equal(AS().view.compare, "original");
    assert.equal(AS().originalState, "loading");
    assert.equal(lib.selectStageResult(AS()), stab, "until it is ready the stage keeps the stabilized model");
    await until(() => AS().originalResult !== null);
    const orig = AS().originalResult;
    assert.equal(AS().originalFor, stab);
    assert.equal(orig.blocks.length, 28, "only the blocks the stabilizer was given");
    assert.ok(orig.blocks.every((b) => b.role === "original" && b.step === 0));
    assert.deepEqual(orig.transform, stab.transform, "the same frame, so the camera and the ghost do not move");
    assert.ok(orig.stress && orig.stress.maxUtilisation > 1, "the original is overstressed: that is what Compare shows");
    assert.ok(orig.issues.some((i) => i.kind === "cantilever-too-long"), "and its long arm");
    assert.equal(lib.selectStageResult(AS()), orig);
    assert.equal(stab.stats.blockCount, 32);
    AS().ensureOriginal();
    assert.equal(AS().originalResult, orig, "asked again: nothing is computed twice");
    // Back and forth does not recompute either.
    AS().setCompare("overlay");
    AS().setCompare("original");
    assert.equal(AS().originalResult, orig);
    // A re-run (a setting moved) is another result: the stage falls back, the half is made again for it.
    const rerun = measured(addedDesc(armCells(5), TIP_COLUMN), lib.sanitizeSettings({ material: "timber" }));
    AS().runSucceeded("s1", rerun);
    assert.equal(AS().view.compare, "original", "the compare mode stays through a re-run of the same model");
    assert.equal(lib.selectStageResult(AS()), rerun);
    await until(() => AS().originalFor === rerun);
    assert.equal(AS().originalResult.settings.material, "timber");
    assert.equal(lib.selectStageResult(AS()), AS().originalResult);
    // Another model drops it.
    AS().runSucceeded("other", mkResult());
    assert.equal(AS().originalResult, null);
    assert.equal(AS().view.compare, "stabilized");
});

await test("a model with nothing left of its original has no Original half", () => {
    resetAnalysis();
    const stab = measured(addedDesc(armCells(5), TIP_COLUMN));
    AS().runSucceeded("s1", { ...stab, assembly: { ...stab.assembly, roleCounts: [0, 32, 0, 0, 0, 0] } });
    assert.equal(lib.compareInfo(AS().result).originalAvailable, false);
    AS().setCompare("original");
    assert.equal(AS().view.compare, "stabilized");
});

await test("a block of another half is found by its cell: hovering and clicking in the Original view reach the issue of the stabilized model", async () => {
    resetAnalysis();
    // A 7-block arm with a column under its tip: still too long at the root, so there are issues on original blocks.
    const stab = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    assert.ok(stab.issues.length > 0);
    AS().runSucceeded("s1", stab);
    AS().setCompare("original");
    await until(() => AS().originalResult !== null);
    const orig = AS().originalResult;
    const issue = stab.issues.find((i) => i.blocks.some((b) => stab.blocks[b].role === "original"));
    assert.ok(issue, "an issue with an original block");
    const sIndex = issue.blocks.find((b) => stab.blocks[b].role === "original");
    const cell = stab.blocks[sIndex].cell;
    const oIndex = orig.blocks.findIndex((b) => b.cell.join() === cell.join());
    assert.notEqual(oIndex, -1);
    assert.deepEqual(lib.mapBlockIndices(orig, stab, [oIndex]), [sIndex]);
    AS().hoverBlock(oIndex);
    assert.equal(AS().hoverIssueId, AS().blockIssues.get(sIndex), "the hover lights the issue of the same cell");
    AS().clickBlock(oIndex);
    assert.equal(AS().selection.ids.length, 1);
    assert.equal(AS().view.compare, "original", "a click in the viewer stays on the half the user looks at");
    const shown = AS().view.highlight.map((i) => orig.blocks[i].cell.join());
    assert.ok(shown.length > 0 && shown.every((c) => stab.issues.some((it) => it.blocks.some((b) => stab.blocks[b].cell.join() === c))), "the highlight is in the original's own numbers");
    // A card pressed in the panel is about the stabilized model: it shows that half.
    AS().selectIssues([issue.id]);
    assert.equal(AS().view.compare, "stabilized");
    assert.deepEqual(AS().view.highlight, [...issue.blocks].sort((a, b) => a - b));
});

await test("the stabilizer's preview: drawn by role while it is for the model on screen, a pick starts afresh, a step selection follows the growth", () => {
    resetAnalysis();
    const source = measured(plainDesc(armCells(5)));
    AS().runSucceeded("m1", source);
    AS().setColorBy("stress");
    assert.equal(AS().view.colorBy, "stress");
    AS().selectIssues([source.issues[0].id]);
    assert.ok(AS().view.highlight.length > 0);
    const previewOf = (added, step = 1) => ({ ...measured(addedDesc(armCells(5), added, "column", step)), transform: source.transform });
    const p1 = previewOf(TIP_COLUMN.slice(0, 2));
    AS().setPreview("m1", p1);
    assert.equal(AS().view.colorBy, "role", "the stage paints what is being added");
    assert.equal(AS().colorChoice, "stress", "the user's choice is kept for later");
    assert.equal(AS().selection, null, "block numbers differ in the preview: the pick starts afresh");
    assert.equal(lib.selectStageResult(AS()), p1);
    assert.equal(AS().result, source, "the report still reads the model's own result");
    // A step selection: the blocks of step 1 in the preview, and they move as blocks are added.
    AS().selectStepBlocks(1, { atMm: [550, 150, 250], label: "Step 1: column" });
    assert.equal(AS().stepSelection, 1);
    assert.deepEqual(AS().view.highlight, lib.stepBlocks(p1, 1));
    assert.equal(AS().view.highlight.length, 2);
    assert.deepEqual(AS().view.focus.mm, [550, 150, 250]);
    const p2 = previewOf(TIP_COLUMN);
    AS().setPreview("m1", p2);
    assert.equal(AS().stepSelection, 1);
    assert.deepEqual(AS().view.highlight, lib.stepBlocks(p2, 1));
    assert.equal(AS().view.highlight.length, 4, "the selection follows the blocks of the step");
    // Block hover in the preview: an added block is in no issue of the report; a source block is.
    const added = p2.blocks.findIndex((b) => b.role === "column");
    AS().hoverBlock(added);
    assert.equal(AS().hoverIssueId, null);
    AS().setPreview("m1", null);
    assert.equal(AS().view.colorBy, "stress", "the choice is back");
    assert.equal(AS().selection, null);
    assert.equal(AS().stepSelection, null);
    // A preview of another model changes nothing on this one.
    AS().setPreview("elsewhere", p1);
    assert.equal(AS().view.colorBy, "stress");
    assert.equal(lib.selectStageResult(AS()), source);
});

await test("a step that no block belongs to selects nothing; clearing the pick clears the step", () => {
    resetAnalysis();
    const stab = measured(addedDesc(armCells(5), TIP_COLUMN));
    AS().runSucceeded("s1", stab);
    AS().selectStepBlocks(7, { atMm: [0, 0, 0], label: "Step 7" });
    assert.equal(AS().selection, null);
    AS().selectStepBlocks(1, { atMm: [550, 150, 250], label: "Step 1: column" });
    assert.equal(AS().view.highlight.length, 4);
    assert.equal(AS().selection.label, "Step 1: column");
    const serial = AS().selectionSerial;
    AS().selectStepBlocks(1, { atMm: [550, 150, 250], label: "Step 1: column" });
    assert.ok(AS().selectionSerial > serial, "each click is a new pick (a phone closes its sheet)");
    AS().clearSelection();
    assert.equal(AS().stepSelection, null);
    assert.deepEqual(AS().view.highlight, []);
});

await test("a Compare asked for before the model is open takes effect when its analysis lands", () => {
    resetAnalysis();
    AS().runSucceeded("src", mkResult());
    AS().requestCompare("s1", "overlay");
    assert.deepEqual(AS().pendingCompare, { modelId: "s1", mode: "overlay" });
    assert.equal(AS().view.compare, "stabilized");
    AS().runSucceeded("s1", measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.equal(AS().view.compare, "overlay");
    assert.equal(AS().view.colorBy, "role");
    assert.equal(AS().pendingCompare, null);
    AS().requestCompare("s1", "stabilized");
    assert.equal(AS().view.compare, "stabilized", "for the model already on screen it is immediate");
});

await test("a Compare asked for a model survives that model being opened, and is dropped when another model is opened instead", () => {
    resetAnalysis();
    AS().runSucceeded("src", mkResult());
    AS().requestCompare("s1", "overlay");
    AS().modelChanged("s1", "/s1.glb"); // the Compare button sets the request, then the workspace shows the model
    assert.deepEqual(AS().pendingCompare, { modelId: "s1", mode: "overlay" }, "still wanted");
    AS().modelChanged("src", "/src.glb"); // the user went somewhere else first
    assert.equal(AS().pendingCompare, null, "no longer wanted");
    AS().runSucceeded("s1", measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.equal(AS().view.compare, "stabilized", "visiting s1 later does not jump to Overlay");
});

const mt = (over = {}) => ({ blocks: 28, errors: 2, floating_blocks: 0, over_limit: 1, longest_cantilever: 5, cog_margin_mm: 120, max_utilisation: 1.06, ...over });
function stepLog(n, move, added, over = {}) {
    return {
        n, move, reason: "cantilever", added,
        text: `Added a ${added}-block ${move} under the arm tip at x = 550 mm, y = 150 mm because the cantilever reached 5 > 4 blocks. Longest cantilever 5 → 0; peak stress 106% → 11%.`,
        at_mm: [550, 150, 250],
        before: mt(),
        after: mt({ blocks: 28 + added, errors: 0, over_limit: 0, longest_cantilever: 0, max_utilisation: 0.11 }),
        ...over,
    };
}
// ---------- the stabilizer: pure rules ----------

await test("the Options popover's choices are clamped and become the stabilizer's options", () => {
    assert.deepEqual(lib.sanitizeChoices(null), { target: 0.75, maxBlocks: null });
    assert.deepEqual(lib.sanitizeChoices({ target: 5, maxBlocks: 5000 }), { target: 0.75, maxBlocks: 1000 }, "the target stops at the warning level");
    assert.deepEqual(lib.sanitizeChoices({ target: 0.1, maxBlocks: 0 }), { target: 0.4, maxBlocks: null });
    assert.equal(lib.sanitizeChoices({ target: 0.553 }).target, 0.55);
    assert.equal(lib.sanitizeChoices({ target: "x" }).target, 0.75);
    const o = lib.optionsFor({ target: 0.6, maxBlocks: null }, { maxBlocks: 120 });
    assert.equal(o.targetUtilisation, 0.6);
    assert.equal(o.maxBlocks, 120, "the analysis budget when none is chosen");
    assert.equal(lib.optionsFor({ target: 0.6, maxBlocks: 80 }, { maxBlocks: 120 }).maxBlocks, 80);
    assert.equal(lib.optionsFor(lib.DEFAULT_CHOICES, { maxBlocks: null }).maxBlocks, 1000);
    assert.equal(o.maxSteps, 40);
});

await test("the Stabilize card is offered for a model with something to fix, and says why when it cannot run", () => {
    const stats = { blockCount: 28 };
    const base = { model: { id: "a", derived: null }, models: [], result: { stats, stress: null }, verdict: { kind: "fail" }, analysing: false };
    assert.deepEqual(lib.stabilizeOffer(base), { label: "Stabilize", child: null, blocked: null });
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "warn" } }).label, "Reduce stress", "a warning-only model");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "pass" } }), null, "nothing to fix: no card");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: null }), null);
    assert.equal(lib.stabilizeOffer({ ...base, result: { stats: { blockCount: 0 }, stress: null } }), null);
    assert.match(lib.stabilizeOffer({ ...base, analysing: true }).blocked, /analysis to finish/);
    assert.match(lib.stabilizeOffer({ ...base, model: { id: "a", derived: { depth: 3 } } }).blocked, /maximum number of times/);
    const kids = (n) => range(n).map((i) => ({ id: `k${i}`, kind: "stabilized", source_model_id: "a", created_at: iso(i) }));
    const offer = lib.stabilizeOffer({ ...base, models: kids(2) });
    assert.equal(offer.child.id, "k1", "the newest version is the one to open");
    assert.equal(offer.blocked, null, "and a new run is still possible");
    assert.match(lib.stabilizeOffer({ ...base, models: kids(5) }).blocked, /5 stabilized versions already/);
    const many = range(20).map((i) => ({ id: `x${i}`, kind: "stabilized", source_model_id: `o${i % 7}`, created_at: iso(i) }));
    assert.match(lib.stabilizeOffer({ ...base, models: many }).blocked, /20 stabilized versions/);
});

await test("progress and results in words", () => {
    assert.equal(lib.progressLine(null, 0), "Step 1 · looking for the next move…");
    assert.equal(lib.progressLine({ candidatesTotal: 24 }, 2), "Step 3 · evaluating 24 moves…");
    assert.equal(lib.progressLine({ candidatesTotal: 1 }, 0), "Step 1 · evaluating 1 move…");
    const start = { errors: 3, max_utilisation: 1.98 };
    const steps = [stepLog(1, "column", 5, { after: mt({ errors: 1, max_utilisation: 0.72 }) }), stepLog(2, "footing", 2, { after: mt({ errors: 0, max_utilisation: 0.54 }) })];
    assert.deepEqual(lib.runChips(start, []), { added: 0, problems: [3, 3], stress: [1.98, 1.98] });
    assert.deepEqual(lib.runChips(start, steps), { added: 7, problems: [3, 0], stress: [1.98, 0.54] });
    assert.equal(lib.stressArrow(1.98, 0.544), "198% → 54%");
    assert.equal(lib.stressArrow(null, null), "n/a → n/a");
    assert.deepEqual(lib.stepChips(steps[0]), ["errors 2 → 1", "peak 106% → 72%", "+5"], "only what the move changed, then its size");
    assert.deepEqual(lib.stepChips(stepLog(3, "bridge", 2, { before: mt({ floating_blocks: 16, errors: 0, max_utilisation: null, longest_cantilever: 2 }), after: mt({ floating_blocks: 0, errors: 0, max_utilisation: null, longest_cantilever: 2 }) })), ["floating 16 → 0", "+2"]);
    assert.equal(lib.stabilizedFileName("a-shelf-meshy.glb"), "a-shelf-meshy-stabilized.glb");
    assert.match(lib.uploadErrorMessage(new Error("The file has unexpected content")), /Reload the page/);
    assert.equal(lib.uploadErrorMessage(new Error("Too many versions")), "Too many versions");
    assert.equal(lib.uploadErrorMessage(null), "The version could not be saved.");
});

await test("a finished run is complete, partial or empty, and says what is left", () => {
    const meta = (over) => ({ added_blocks: 4, ...over });
    assert.equal(lib.outcomeOf({ complete: true, meta: meta({}) }), "complete");
    assert.equal(lib.outcomeOf({ complete: false, meta: meta({}) }), "partial");
    assert.equal(lib.outcomeOf({ complete: true, meta: meta({ added_blocks: 0 }) }), "nothing");
    const after = { blocks: 30, errors: 1, warnings: 0, floating_blocks: 0, over_limit: 2, longest_cantilever: 5, cog_margin_mm: 40, max_utilisation: 0.9, overstressed_blocks: 0 };
    assert.deepEqual(lib.remainingProblems(after, 0.75, 4), ["a cantilever of 5 blocks (limit 4)", "peak stress 90% against the 75% target"]);
    assert.equal(lib.partialHeadline(after, 0.75, 4), "Improved, not fully stable: 1 problem remains (a cantilever of 5 blocks (limit 4); peak stress 90% against the 75% target)");
    assert.equal(lib.partialHeadline({ ...after, errors: 2 }, 0.75, 4).split(" (")[0], "Improved, not fully stable: 2 problems remain");
    assert.deepEqual(lib.remainingProblems({ ...after, over_limit: 0, max_utilisation: 0.5, floating_blocks: 3, cog_margin_mm: -20 }, 0.75, 4), ["3 floating blocks", "the centre of gravity is outside the base"]);
    assert.equal(lib.stabilizedLine({ added_blocks: 14, before: { ...after, max_utilisation: 1.8 }, after: { ...after, errors: 0, warnings: 0, max_utilisation: 0.54 } }), "+14 blocks · all checks pass · peak stress 180% → 54%");
    assert.equal(lib.stabilizedLine({ added_blocks: 1, before: { ...after, max_utilisation: null }, after: { ...after, errors: 0, warnings: 2, max_utilisation: null } }), "+1 block · 2 warnings");
    assert.equal(lib.savedMessage("a shelf", { added_blocks: 14, complete: true, after }), "Stabilized version of **a shelf**: +14 blocks, passes all checks.");
    assert.equal(lib.savedMessage("a shelf", { added_blocks: 3, complete: false, after }), "Improved version of **a shelf**: +3 blocks, 1 problem left.");
});

await test("the assembly of a run: a model's own blocks stay as they are and the moves are numbered after the steps it already has", () => {
    const first = measured(addedDesc(armCells(5), TIP_COLUMN));
    assert.equal(lib.stepOffsetOf(first), 1);
    assert.equal(lib.stepOffsetOf(null), 0);
    const move = { step: stepLog(1, "footing", 1), cells: [[6, 1, 0]], roles: ["footing"] };
    const desc = lib.previewDescriptor(first, [move]);
    const asm = lib.analyzeAssembly(desc, null, first.settings);
    assert.equal(asm.blocks.length, 33);
    const by = (cell) => asm.blocks.find((b) => b.cell.join() === cell.join());
    assert.deepEqual([by([5, 1, 2]).role, by([5, 1, 2]).step], ["column", 1], "the first stabilization's column keeps its role and step");
    assert.deepEqual([by([0, 0, 0]).role, by([0, 0, 0]).step], ["original", 0]);
    assert.deepEqual([by([6, 1, 0]).role, by([6, 1, 0]).step], ["footing", 2], "the new step 1 is step 2 on the blocks");
    assert.equal(lib.savedStepOffset(asm, 1), 1, "a saved model: its highest step minus its own log");
    assert.equal(lib.savedStepOffset(first, 1), 0);
    // From a mesh (no roles on its blocks) every block of the source is an original.
    const plain = measured(plainDesc(armCells(5)));
    const fromMesh = lib.analyzeAssembly(lib.previewDescriptor({ blocks: plain.blocks.map((b) => ({ cell: b.cell })), assembly: null }, [move]), null, plain.settings);
    assert.equal(fromMesh.blocks.filter((b) => b.role === "original").length, 28);
    assert.equal(fromMesh.blocks.find((b) => b.cell.join() === "6,1,0").step, 1);
});

// ---------- the stabilizer: the run ----------

const abortErr = () => Object.assign(new Error("The stabilizer was stopped."), { name: "AbortError" });
const ST = () => lib.useStabilizeStore.getState();
const COLUMN_MOVE = () => ({ step: stepLog(1, "column", 4), cells: TIP_COLUMN.map((c) => [...c]), roles: TIP_COLUMN.map(() => "column") });
const FOOTING_MOVE = () => ({ step: stepLog(1, "footing", 1, { after: mt({ blocks: 29 }) }), cells: [[6, 1, 0]], roles: ["footing"] });

/** A project with one generated model, analysed: the starting point of every run below. */
function begin(cells = armCells(5), prompt = "a shelf") {
    resetAnalysis();
    lib.setStabilizeDeps();
    ST().discard();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid, { prompt })), id: crypto.randomUUID(), prompt, glb_url: "/src.glb", analysis: null, kind: "generated", source_model_id: null, example_slug: null, derived: null };
    S().addModel(model);
    S().setActiveModel(model.id);
    // A model made from a mesh: its result has no assembly, and its blocks no role or step.
    const measuredCells = measured(plainDesc(cells));
    const result = { ...measuredCells, assembly: null, blocks: measuredCells.blocks.map(({ role, step, ...b }) => b) };
    AS().runSucceeded(model.id, result);
    return { pid, model, result };
}
/** The result a stabilizer that made `moves` would answer with, written by the real GLB writer. */
async function answerFor(source, moves, over = {}) {
    const options = lib.optionsFor(lib.DEFAULT_CHOICES, source.settings);
    const built = await lib.buildStoppedResult({ source, moves, sourceDepth: 0, options, elapsedMs: 12 });
    return { ...built, stop: built.complete ? "stable" : "no-improving-move", ...over };
}
const storedModel = (sourceId, glb, pid) => {
    const read = lib.readAssemblyGlb(glb, null);
    assert.ok(read.ok, read.error);
    return { ...modelFor(makeJob(pid)), id: crypto.randomUUID(), provider: "stabilizer", prompt: "a shelf", glb_url: "/d.glb", kind: "stabilized", source_model_id: sourceId, example_slug: null, derived: read.meta, analysis: read.meta.after_summary };
};
/**
 * A stabilizer that reports `moves` one by one, then waits for `hold.release()` (or Stop) and answers with `answer`.
 * `uploadFails`: that many uploads fail first. `uploadHold`: uploads wait for uploadHold.release().
 */
function fakeStabilizer(pid, { moves = [], answer = null, hold = null, runFails = null, uploadFails = 0, uploadHold = null } = {}) {
    const seen = { input: null, sourceDepth: null, signal: null, uploads: [], stopped: [] };
    let failures = uploadFails;
    lib.setStabilizeDeps({
        run: async (input, hooks) => {
            seen.input = input;
            seen.sourceDepth = hooks.sourceDepth;
            seen.signal = hooks.signal;
            for (const m of moves) {
                await sleep(5);
                if (hooks.signal.aborted) throw abortErr();
                hooks.onProgress({ kind: "progress", phase: "evaluating", candidatesDone: 3, candidatesTotal: 24, steps: m.step.n - 1, blocks: 28, elapsedMs: 4 });
                hooks.onStep({ kind: "step", step: m.step, cells: m.cells, roles: m.roles, blocks: 28 + m.cells.length, elapsedMs: 5 });
            }
            if (hold) {
                await new Promise((resolve, reject) => {
                    hold.release = resolve;
                    hooks.signal.addEventListener("abort", () => reject(abortErr()), { once: true });
                });
            }
            if (runFails) throw runFails;
            return typeof answer === "function" ? answer() : answer;
        },
        upload: async (sourceId, glb) => {
            seen.uploads.push({ sourceId, glb });
            if (uploadHold) await new Promise((resolve) => (uploadHold.release = resolve));
            if (failures > 0) {
                failures -= 1;
                throw new Error("The server is down.");
            }
            return storedModel(sourceId, glb, pid);
        },
    });
    return seen;
}

await test("a run that reaches its goal shows its work as it goes, then saves itself: the version is open, in the chat, and the preview is gone", async () => {
    const { pid, model, result } = begin();
    const hold = {};
    const complete = await answerFor(result, [COLUMN_MOVE()]);
    assert.equal(complete.complete, true, "the column under the tip fixes this shelf");
    const seen = fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: complete, hold });
    assert.equal(ST().start(model, result), true);
    assert.equal(ST().start(model, result), false, "one run at a time");
    assert.equal(ST().status, "running");
    assert.equal(ST().sourceModelId, model.id);
    await until(() => ST().steps.length === 1 && AS().preview !== null && AS().preview.result.blocks.length === 32);
    assert.equal(seen.sourceDepth, 0);
    assert.equal(seen.input.cells.length, 28);
    assert.equal(seen.input.assembly, null, "a model made from a mesh has no assembly to keep");
    assert.equal(seen.input.options.targetUtilisation, 0.75);
    assert.equal(AS().preview.modelId, model.id);
    assert.deepEqual(AS().preview.result.transform, result.transform, "drawn in the frame of the model on screen");
    assert.equal(AS().preview.result.assembly.roleCounts[1], 4);
    assert.equal(ST().preview, AS().preview.result, "the same object is in both stores");
    assert.equal(AS().view.colorBy, "role");
    assert.equal(AS().result, result, "the report keeps reading the model's own analysis");
    assert.deepEqual(lib.runChips(ST().startMetrics, ST().steps), { added: 4, problems: [2, 0], stress: [1.059, 0.11] }, "the start is the model's own analysis, rounded as the log rounds it");
    assert.equal(ST().progress, null, "a step ends the progress that led to it");
    // Selecting a step shows its blocks and flies there.
    ST().selectStep(1);
    assert.equal(AS().stepSelection, 1);
    assert.equal(AS().view.highlight.length, 4);
    assert.deepEqual(AS().view.focus.mm, [550, 150, 250]);
    ST().selectStep(1);
    assert.equal(AS().stepSelection, null, "the same step again clears it");
    assert.equal(ST().endedAt, null, "nothing has ended yet");
    hold.release();
    await until(() => ST().status === "saved");
    assert.ok(Date.now() - ST().endedAt < 2000, "the end is stamped, so the banner that appears takes the keyboard focus");
    assert.equal(seen.uploads.length, 1);
    assert.equal(seen.uploads[0].sourceId, model.id);
    const saved = S().models.find((m) => m.kind === "stabilized");
    assert.ok(saved, "the version joined the project's models");
    assert.equal(saved.source_model_id, model.id);
    assert.equal(S().activeModelId, saved.id, "and is the one on screen");
    assert.equal(ST().savedModelId, saved.id);
    const message = S().messages[S().messages.length - 1];
    assert.equal(message.role, "assistant");
    assert.deepEqual(message.model_ids, [saved.id], "the chat presents it as a model card");
    assert.equal(message.content, "Stabilized version of **a shelf**: +4 blocks, passes all checks.");
    assert.ok(lib.toasts.some((t) => t.kind === "success" && /stabilized version/i.test(t.title)));
    assert.equal(AS().preview, null);
    assert.equal(ST().preview, null);
    assert.equal(AS().view.colorBy, "status", "the stage is back to the user's colouring");
    assert.ok(S().revision > 0, "the chat message is an edit the autosave picks up");
    ST().discard();
    assert.equal(ST().status, "idle", "the banner is dismissed");
    assert.equal(ST().endedAt, null, "and forgets when the run ended");
});

await test("a run that falls short waits for the user: Save as new version keeps it, Discard drops it", async () => {
    const { pid, model, result } = begin();
    const partial = await answerFor(result, [FOOTING_MOVE()]);
    assert.equal(partial.complete, false);
    const seen = fakeStabilizer(pid, { moves: [FOOTING_MOVE()], answer: partial });
    ST().start(model, result);
    await until(() => ST().status === "finished");
    await sleep(30);
    assert.equal(seen.uploads.length, 0, "nothing is saved unasked");
    assert.equal(lib.outcomeOf(ST().result), "partial");
    assert.equal(AS().preview.result.blocks.length, 29, "the stage keeps showing what it made");
    await ST().save();
    assert.equal(ST().status, "saved");
    assert.equal(seen.uploads.length, 1);
    assert.equal(S().messages[S().messages.length - 1].content, "Improved version of **a shelf**: +1 block, 2 problems left.");
    // The other way out.
    const second = begin();
    fakeStabilizer(second.pid, { moves: [FOOTING_MOVE()], answer: await answerFor(second.result, [FOOTING_MOVE()]) });
    ST().start(second.model, second.result);
    await until(() => ST().status === "finished");
    ST().discard();
    assert.equal(ST().status, "idle");
    assert.equal(AS().preview, null);
    assert.equal(S().models.filter((m) => m.kind === "stabilized").length, 0);
});

await test("a run that finds nothing to add says so and saves nothing", async () => {
    const { pid, model, result } = begin();
    const none = { ...(await answerFor(result, [FOOTING_MOVE()])) };
    none.meta = { ...none.meta, added_blocks: 0 };
    const seen = fakeStabilizer(pid, { answer: none });
    ST().start(model, result);
    await until(() => ST().status === "finished");
    assert.equal(lib.outcomeOf(ST().result), "nothing");
    await sleep(30);
    assert.equal(seen.uploads.length, 0);
});

await test("Stop: with no step yet the card is simply back; with steps they are kept and can be saved as a partial version", async () => {
    let r = begin();
    let hold = {};
    let seen = fakeStabilizer(r.pid, { hold });
    ST().start(r.model, r.result);
    await until(() => hold.release);
    ST().cancel();
    assert.equal(ST().status, "idle");
    assert.equal(seen.signal.aborted, true, "the worker is told to stop");
    assert.equal(AS().preview, null);

    r = begin();
    hold = {};
    seen = fakeStabilizer(r.pid, { moves: [COLUMN_MOVE()], hold });
    ST().start(r.model, r.result);
    await until(() => ST().steps.length === 1 && hold.release);
    ST().cancel();
    assert.equal(ST().status, "canceled");
    assert.equal(seen.signal.aborted, true);
    await sleep(20);
    assert.equal(ST().status, "canceled", "the aborted run's rejection changes nothing");
    assert.equal(ST().result, null);
    assert.equal(AS().preview.result.blocks.length, 32, "what was added so far stays on the stage");
    assert.equal(seen.uploads.length, 0);
    await ST().save();
    assert.equal(ST().status, "saved");
    assert.equal(seen.uploads.length, 1);
    const read = lib.readAssemblyGlb(seen.uploads[0].glb, null);
    assert.ok(read.ok, read.error);
    assert.equal(read.meta.stop, "canceled");
    assert.equal(read.meta.added_blocks, 4);
    assert.equal(read.meta.steps.length, 1);
    assert.equal(read.meta.depth, 1);
    assert.equal(read.meta.after.errors, 0, "measured by the engine: the column fixed it");
    assert.equal(read.meta.complete, true);
    assert.equal(read.descriptor.cells.length / 5, 32);
    assert.deepEqual(S().messages[S().messages.length - 1].model_ids, [S().activeModelId]);
});

await test("a save that fails keeps the result: Retry saves it, and the page that is older than the server is told to reload", async () => {
    const { pid, model, result } = begin();
    const complete = await answerFor(result, [COLUMN_MOVE()]);
    const seen = fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: complete, uploadFails: 1 });
    ST().start(model, result);
    await until(() => ST().status === "error");
    assert.equal(ST().errorKind, "save");
    assert.equal(ST().error, "The server is down.");
    assert.ok(ST().result.glb instanceof Uint8Array, "the bytes are in memory: Download GLB anyway");
    assert.ok(lib.toasts.some((t) => t.kind === "error"));
    assert.equal(S().models.filter((m) => m.kind === "stabilized").length, 0);
    assert.equal(AS().preview !== null, true, "the stage still shows the version");
    await ST().save();
    assert.equal(ST().status, "saved");
    assert.equal(seen.uploads.length, 2);
    assert.equal(S().models.filter((m) => m.kind === "stabilized").length, 1);
});

await test("a run that fails is an error of the run, not of a save; Discard clears it", async () => {
    const { pid, model, result } = begin();
    fakeStabilizer(pid, { runFails: new RangeError("There are no blocks to stabilize.") });
    ST().start(model, result);
    await until(() => ST().status === "error");
    assert.equal(ST().errorKind, "run");
    assert.equal(ST().error, "There are no blocks to stabilize.");
    await ST().save();
    assert.equal(ST().status, "error", "there is nothing to save");
    ST().discard();
    assert.equal(ST().status, "idle");
    assert.equal(AS().preview, null);
});

await test("leaving the project stops a run; a save already under way finishes but is not put on another project's screen", async () => {
    // Opening another project (or a new chat) while it runs.
    let r = begin();
    let hold = {};
    let seen = fakeStabilizer(r.pid, { moves: [COLUMN_MOVE()], hold });
    ST().start(r.model, r.result);
    await until(() => ST().steps.length === 1 && hold.release);
    S().setProject(detail(crypto.randomUUID()));
    assert.equal(ST().status, "idle");
    assert.equal(seen.signal.aborted, true);
    assert.equal(AS().preview, null);
    await sleep(20);
    assert.equal(ST().status, "idle", "the aborted run does not come back");

    // The workspace itself goes (the runner's cleanup).
    r = begin();
    hold = {};
    seen = fakeStabilizer(r.pid, { hold });
    ST().start(r.model, r.result);
    await until(() => hold.release);
    const unmount = mountHook(() => lib.useAnalysisRunner(r.model));
    unmount();
    assert.equal(ST().status, "idle");
    assert.equal(seen.signal.aborted, true);

    // An upload under way when the user moves on.
    r = begin();
    const uploadHold = {};
    const complete = await answerFor(r.result, [COLUMN_MOVE()]);
    seen = fakeStabilizer(r.pid, { moves: [COLUMN_MOVE()], answer: complete, uploadHold });
    ST().start(r.model, r.result);
    await until(() => ST().status === "saving" && uploadHold.release);
    const other = crypto.randomUUID();
    S().setProject(detail(other));
    assert.equal(ST().status, "saving", "an upload is not cut off");
    uploadHold.release();
    await until(() => ST().status === "idle");
    assert.equal(S().activeProjectId, other);
    assert.equal(S().models.length, 0, "the other project did not get this project's model");
    assert.equal(S().messages.length, 0);
    assert.ok(lib.toasts.some((t) => t.kind === "info" && /stabilized version/i.test(t.title)));
});

await test("stabilizing a stabilized model keeps its blocks' roles and numbers its steps after its own", async () => {
    const { pid, model, result } = begin(armCells(5));
    // The model on screen is a stabilized one (depth 1) whose arm is still too long: 7 blocks, a column under the tip is not enough.
    const first = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    const derived = { depth: 1 };
    const stabilized = { ...model, id: crypto.randomUUID(), kind: "stabilized", source_model_id: model.id, derived };
    S().addModel(stabilized);
    S().setActiveModel(stabilized.id);
    AS().runSucceeded(stabilized.id, first);
    const move = { step: stepLog(1, "bracket", 1), cells: [[3, 1, 4]], roles: ["bracket"] };
    const seen = fakeStabilizer(pid, { moves: [move], answer: await answerFor(first, [move]), hold: {} });
    ST().start(stabilized, first);
    await until(() => AS().preview && AS().preview.result.blocks.length === first.blocks.length + 1);
    assert.equal(seen.sourceDepth, 1);
    assert.deepEqual(seen.input.assembly, first.assembly.descriptor, "the source's roles and steps go to the stabilizer");
    const p = AS().preview.result;
    assert.equal(p.assembly.roleCounts[1], 4, "its column is still a column");
    assert.equal(p.blocks.find((b) => b.cell.join() === "3,1,4").step, 2, "the new step is numbered after step 1");
    // The timeline's step 1 is the new run's step 1, which is step 2 on the blocks.
    ST().selectStep(1);
    assert.equal(AS().stepSelection, 2);
    assert.deepEqual(AS().view.highlight, [p.blocks.findIndex((b) => b.cell.join() === "3,1,4")]);
    ST().cancel();
    await ST().save();
    const read = lib.readAssemblyGlb(seen.uploads[0].glb, null);
    assert.ok(read.ok, read.error);
    assert.equal(read.meta.depth, 2);
    assert.equal(read.descriptor.cells.length / 5, first.blocks.length + 1);
});

await test("the runner analyses a stabilized model from its blocks, not by voxelising its triangles", async () => {
    resetAnalysis();
    const cells = armCells(5);
    const desc = addedDesc(cells, TIP_COLUMN);
    // What the viewer reads from the model's GLB: its triangles (cubes inset in their cells) and the descriptor in its extras.
    const soup = boxSoup(desc.cells.length ? range(desc.cells.length / 5).map((n) => {
        const i = desc.cells[n * 5], j = desc.cells[n * 5 + 1], k = desc.cells[n * 5 + 2];
        return [[(i + 0.02) * 100, (j + 0.02) * 100, (k + 0.02) * 100], [(i + 0.98) * 100, (j + 0.98) * 100, (k + 0.98) * 100]];
    }) : []);
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const model = { ...modelFor(makeJob(pid)), id: "asm-1", glb_url: "/asm-1.glb", analysis: null };
    S().addModel(model);
    AS().setLoaded({ url: "/asm-1.glb", assembly: desc, extractTriangles: () => soup });
    const stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().resultModelId === "asm-1");
    const r = AS().result;
    assert.equal(r.blocks.length, 32, "exactly the blocks of the descriptor (voxelising the cubes would give others)");
    assert.equal(r.assembly.roleCounts[1], 4);
    assert.ok(r.stress && r.stress.analysedBlocks === 32, "and the stress estimate came with it");
    assert.equal(r.summary.errors, 0);
    stop();
});

await test("metricsOf leaves the peak out while blocks float and it is under the warning level (the grounded part alone), as the stabilizer logs it", () => {
    const base = { blocks: 40, errors: 1, warnings: 0, over_limit: 0, longest_cantilever: 0, cog_margin_mm: 0 };
    const result = (floating, peak) => ({ summary: { ...base, floating_blocks: floating }, stability: null, stress: { maxUtilisation: peak, overstressedBlocks: 0 } });
    assert.equal(lib.metricsOf(result(12, 0)).max_utilisation, null, "0 % of a lamp whose arms float is not a figure");
    assert.equal(lib.metricsOf(result(12, 0.4)).max_utilisation, null);
    assert.equal(lib.metricsOf(result(12, 1.37)).max_utilisation, 1.37, "above the warning level it is a true lower bound and stays");
    assert.equal(lib.metricsOf(result(0, 0.4)).max_utilisation, 0.4, "nothing floating: the figure is the whole model's");
    assert.equal(lib.metricsOf(result(12, 0.6), 0.5).max_utilisation, 0.6, "under the run's own (lower) target the same rule applies, not above it");
    assert.equal(lib.metricsOf({ summary: { ...base, floating_blocks: 3 }, stability: null, stress: null }).max_utilisation, null);
});

await test("a stopped run never records or tests against a target above the warning level", async () => {
    resetAnalysis();
    const { result } = begin();
    const options = { ...lib.optionsFor(lib.DEFAULT_CHOICES, result.settings), targetUtilisation: 0.9 };
    const built = await lib.buildStoppedResult({ source: result, moves: [{ step: stepLog(1, "column", 4), cells: TIP_COLUMN.map((c) => [...c]), roles: TIP_COLUMN.map(() => "column") }], sourceDepth: 0, options, elapsedMs: 5 });
    assert.equal(built.meta.target_utilisation, 0.75, "the target the run really aimed for");
    assert.ok(built.meta.complete === (built.after.errors === 0 && (built.after.max_utilisation === null || built.after.max_utilisation <= 0.75 + 1e-9)));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
