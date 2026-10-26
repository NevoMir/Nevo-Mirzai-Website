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
export * from "@/assignment/store/analysisBrief";
export * from "@/assignment/components/analysis/vocabulary";
export { placeOf, placeAtPoint } from "@/assignment/analysis/plain";
export * from "@/assignment/store/analysisSave";
export * from "@/assignment/store/stabilize";
export * from "@/assignment/store/stabilizeLogic";
export { MATERIAL_FACTS, materialLine, solverLine } from "@/assignment/components/analysis/stressText";
export { STRESS_MATERIALS, STRESS_WARN, STRESS_FAIL } from "@/assignment/analysis/materials";
export { analyzeAssembly, originalOf, soupBoundsOf, sourceTransformOf } from "@/assignment/analysis/assembly";
export { buildReport, buildReportJson, technicalLine, technicalSummary } from "@/assignment/analysis/report";
export { analyze } from "@/assignment/analysis/analyze";
export { COVERAGE_WARN, EDGE_MARGIN_MM } from "@/assignment/analysis/issues";
export { placementForBounds, transformForBounds } from "@/assignment/analysis/voxelize";
export { describeSupport } from "@/assignment/viewer/supports";
export { addedWhen } from "@/assignment/viewer/analysisGeometry";
export * from "@/assignment/store/versions";
export * from "@/assignment/store/versionTree";
export * from "@/assignment/store/workGuard";
export * from "@/assignment/store/chatNotes";
export * from "@/assignment/store/models";
export * from "@/assignment/components/chat/composerLogic";
export { applyStress, computeStress } from "@/assignment/analysis/stress";
export { solveFrameTs } from "@/assignment/analysis/fem/index";
export { descriptorFromBlocks } from "@/assignment/shared/assembly";
export { readAssemblyGlb, writeAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { useAnalysisRunner, NOT_READY_RETRY_MS } from "@/assignment/components/analysis/useAnalysisRunner";
export { useAnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
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
    files: {}, // url -> { bytes, hits }: a file the fake server has (a stabilized model's GLB)
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
    const file = fake.files[String(url)];
    if (file) {
        file.hits += 1;
        const { bytes } = file;
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
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
    fake.files = {};
    lib.forgetAssemblies();
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
    S().setQueuedPrompt({ text: "next lamp", mode: "new" });
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
        blockIssues: new Map(), summaries: {}, view: INITIAL_VIEW, colorChoice: "status",
        preview: null, selection: null, stepSelection: null, selectionSerial: 0, layerRaised: false,
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
    AS().selectBlocks(lib.cantileveredBlocks(r1.blocks), { check: "cantilevered", label: "Overhanging blocks: 3 blocks" });
    assert.deepEqual(AS().view.highlight, [3, 4, 5]);
    assert.deepEqual(AS().selection.ids, []);
    assert.deepEqual(AS().view.focus.mm, r1.blocks[4].centerMm, "the camera looks at the block nearest the group's centre");
    AS().runSucceeded("m1", withStatus({ 7: "cantilever", 8: "cantilever" }));
    assert.deepEqual(AS().view.highlight, [7, 8], "a re-run with other settings shows the new cantilevered blocks");
    assert.equal(AS().selection.label, "Overhanging blocks: 2 blocks", "the pick keeps its plain name when a re-run recounts it");
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
    AS().selectBlocks([8, 9], { check: "cantilevered", label: "Overhanging blocks: 2 blocks" });
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
    const group = { ids: [], check: "cantilevered", label: "Overhanging blocks: 2 blocks" };
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

await test("stageWords: the panel speaks from the engine's step, so none of its labels reaches a student with a banned word", () => {
    assert.deepEqual(["voxelize", "flood", "analyze", "stress"].map((step) => lib.stageWords(step, "ignored")), ["Building the blocks", "Filling the inside", "Checking the structure", "Estimating stress"]);
    assert.equal(lib.stageWords("voxelize", "Voxelising the model"), "Building the blocks", "the engine's label is not shown");
    for (const words of Object.values(lib.STAGE_WORDS)) assert.deepEqual(lib.technicalWordsIn(words), [], words);
    assert.equal(lib.stageWords(undefined, "Placing the blocks"), "Placing the blocks", "a stage with no step keeps a label that is plain");
    assert.equal(lib.stageWords("later", "Voxelising again"), "Checking the model", "a new stage with a technical label does not leak it");
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
    assert.ok(!("passingSentence" in lib), "the passing state is the sentence 'Will stand.' (store/analysisBrief.ts), not a paragraph of numbers");
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

    // Every stage the first-run panel is shown while the real engine works, in the panel's words (no "voxel": vocabulary.ts bans it).
    const stagesSeen = new Set();
    const unsubscribe = lib.useAnalysisStore.subscribe((state) => stagesSeen.add(state.run.stage));
    AS().setLoaded(loadedModel("/run-1.glb"));
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(model));
    await until(() => AS().resultModelId === "run-1");
    unsubscribe();
    assert.ok(stagesSeen.has("Building the blocks"), `the first stage reads in plain words: ${[...stagesSeen].join(" | ")}`);
    for (const stage of stagesSeen) assert.deepEqual(lib.technicalWordsIn(stage), [], `"${stage}" is shown to a student`);
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
const warnCells = () => uniq([...armCells(4), [4, 1, 6]]);
/**
 * The four chips against the sentence over the same result: a model the sentence passes has no failing or warning chip, one it fails
 * has the chip of each reason it names failing (a floating part: no tick on balance or strength), and a warning has its chip amber.
 */
function assertChipsAgree(name, result) {
    const sentence = lib.verdictSentence(result);
    const mark = Object.fromEntries(lib.keyFigures(result).map((figure) => [figure.key, figure.mark]));
    const where = `${name}: "${sentence.text}" with chips ${JSON.stringify(mark)}`;
    if (sentence.kind === "pass") {
        for (const [key, m] of Object.entries(mark)) assert.ok(m === "pass" || m === "none", `${where} (${key})`);
        return;
    }
    if (sentence.kind === "empty") {
        assert.ok(Object.values(mark).every((m) => m === "none"), where);
        return;
    }
    const says = (re) => re.test(sentence.text);
    if (sentence.kind === "fail") {
        if (says(/tip over/)) assert.equal(mark.balance, "fail", where);
        if (says(/nothing touches the ground/)) assert.equal(mark.balance, "fail", where);
        if (says(/floating/)) {
            assert.notEqual(mark.balance, "pass", where);
            assert.notEqual(mark.strength, "pass", where);
        }
        if (says(/too long/)) assert.equal(mark.overhang, "fail", where);
        if (says(/overloaded/)) assert.equal(mark.strength, "fail", where);
        if (says(/block budget/)) assert.equal(mark.blocks, "fail", where);
        // And a failing model never reads as four ticks.
        assert.ok(Object.values(mark).some((m) => m !== "pass"), where);
        return;
    }
    if (says(/very edge/)) assert.equal(mark.balance, "warn", where);
    if (says(/heavily loaded/)) assert.equal(mark.strength, "warn", where);
    for (const m of Object.values(mark)) assert.notEqual(m, "fail", where);
}

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

await test("a percentage is whole; a block assembly is not 'scaled'", () => {
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

await test("added blocks: only a block assembly has the role colouring; it is a colour choice like the others, it survives a model change and a pick stays through it", () => {
    resetAnalysis();
    AS().runSucceeded("m1", mkResult());
    AS().setColorBy("role");
    assert.equal(AS().view.colorBy, "status", "a mesh model has no added blocks to colour");
    const stab = measured(addedDesc(armCells(5), TIP_COLUMN));
    assert.equal(lib.hasAddedBlocks(stab), true);
    assert.equal(lib.addedBlockCount(stab), 4);
    assert.equal(lib.addedBlockCount(mkResult()), 0);
    assert.equal(lib.hasAddedBlocks(measured(plainDesc(armCells(5)))), false, "an assembly with nothing added has no role colouring either");
    assert.equal(lib.addedBlockCount(measured(plainDesc(armCells(5)))), 0);
    AS().runSucceeded("s1", stab);
    assert.equal(AS().colorChoice, "role", "the choice made on the mesh takes effect where it can be drawn");
    assert.equal(AS().view.colorBy, "role");
    AS().setColorBy("layer");
    assert.equal(AS().view.colorBy, "layer", "any other colouring simply replaces it");
    AS().setColorBy("stress");
    assert.equal(AS().view.colorBy, "stress");
    AS().setColorBy("role");
    assert.equal(AS().colorChoice, "role");
    // A pick is not lost by changing the colours.
    const withIssues = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    AS().runSucceeded("s3", withIssues);
    AS().selectIssues([withIssues.issues[0].id]);
    const picked = AS().view.highlight;
    assert.ok(picked.length > 0);
    AS().setColorBy("status");
    assert.deepEqual(AS().view.highlight, picked, "the pick stays through a colour change");
    assert.equal(AS().selection.ids[0], withIssues.issues[0].id);
    assert.equal(lib.stageResultOf({ result: stab, resultModelId: "s1", preview: null }), stab);
});

await test("the store has no compare machinery any more: no Original half, no Overlay mode, no pending Compare; the original is a model of its own (the bar's switch)", () => {
    resetAnalysis();
    const stab = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    AS().runSucceeded("s1", stab);
    assert.equal(lib.selectStageResult(AS()), stab, "the stage draws the model's own result");
    assert.equal(AS().result, stab);
    for (const gone of ["originalResult", "originalFor", "originalState", "ensureOriginal", "setCompare", "requestCompare", "pendingCompare"]) assert.ok(!(gone in AS()), `${gone} is gone from the store`);
    assert.ok(!("compare" in AS().view), "and the view has no compare mode");
    assert.ok(!("compare" in lib.DEFAULT_ANALYSIS_VIEW));
    assert.ok(!("compareInfo" in lib), "and the Original | Stabilized | Overlay summary with it");
    assert.equal(lib.openAnalysisFor.length, 1, "opening a model's analysis takes the model, nothing about a view");
    // A pick the user made stays across a model change to the same result.
    AS().selectIssues([stab.issues[0].id]);
    assert.ok(AS().selection && AS().view.highlight.length > 0);
});

await test("the Added blocks colouring is the user's colouring: it stays through a re-run, and any other colouring replaces it", () => {
    resetAnalysis();
    AS().runSucceeded("s1", measured(addedDesc(armCells(5), TIP_COLUMN)));
    AS().setColorBy("role");
    assert.equal(AS().view.colorBy, "role");
    assert.equal(AS().colorChoice, "role", "it is the user's colouring now: it stays through a re-run");
    AS().runSucceeded("s1", measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.equal(AS().view.colorBy, "role");
    AS().setColorBy("layer");
    assert.equal(AS().view.colorBy, "layer", "and any other colouring replaces it");
    assert.ok(!("showAdded" in AS()), "one way in: setColorBy (the Colour menu, the row's button and the end of a run use it)");
});

await test("focusPoint: the camera and a callout at a point, no highlight; it is a pick (layer cut, phone sheet, clear) with an empty selection", () => {
    resetAnalysis();
    const stab = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    AS().runSucceeded("s1", stab);
    AS().focusPoint([450, 250, 350], "Where the weight balances");
    assert.deepEqual(AS().view.focus.mm, [450, 250, 350]);
    assert.equal(AS().view.focus.label, "Where the weight balances");
    assert.deepEqual(AS().view.highlight, [], "nothing is highlighted");
    assert.deepEqual(AS().selection, { ids: [], check: null, label: "Where the weight balances" });
    assert.equal(AS().selectionSerial, 1, "a new pick: a phone closes its sheet");
    const token = AS().view.focus.token;
    AS().focusPoint([450, 250, 350], "Where the weight balances");
    assert.ok(AS().view.focus.token > token, "asking again flies again");
    assert.equal(AS().selectionSerial, 2);
    // A pick that was on show is let go of: the callout is the new one's.
    AS().selectIssues([stab.issues[0].id]);
    assert.ok(AS().view.highlight.length > 0);
    AS().focusPoint([450, 250, 350], "Where the weight balances");
    assert.deepEqual(AS().view.highlight, []);
    assert.deepEqual(AS().selection.ids, []);
    // The layer cut rises to show the point's layer (like any pick), and the panel says so.
    AS().setLayerMax(1);
    AS().focusPoint([450, 250, 450], "Where the weight balances");
    assert.equal(AS().view.layerMax, 4);
    assert.equal(AS().layerRaised, true);
    // Esc / Clear lets go of it.
    AS().clearSelection();
    assert.equal(AS().view.focus, null);
    assert.equal(AS().selection, null);
    // A re-run drops it (a point of the old result is not a pick of the new one).
    AS().focusPoint([450, 250, 350], "Where the weight balances");
    AS().runSucceeded("s1", measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k]))));
    assert.equal(AS().view.focus, null);
    assert.equal(AS().selection, null);
    // Nothing on screen: nothing to look at.
    resetAnalysis();
    AS().focusPoint([450, 250, 350], "Where the weight balances");
    assert.equal(AS().view.focus, null);
    assert.equal(AS().selection, null);
});

await test("a block of another result is found by its cell: hovering and clicking in the live preview reach the issue of the model's own result", () => {
    resetAnalysis();
    // A 7-block arm with a column under its tip: still too long at the root, so there are issues on original blocks.
    const stab = measured(addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k])));
    assert.ok(stab.issues.length > 0);
    AS().runSucceeded("s1", stab);
    // The preview of a run draws another assembly (its blocks are numbered differently), in the same frame.
    const preview = { ...measured(addedDesc(armCells(7), [1, 2, 3].map((k) => [7, 1, k]))), transform: stab.transform };
    AS().setPreview("s1", preview);
    assert.equal(lib.selectStageResult(AS()), preview);
    const issue = stab.issues.find((i) => i.blocks.some((b) => stab.blocks[b].role === "original"));
    assert.ok(issue, "an issue with an original block");
    const sIndex = issue.blocks.find((b) => stab.blocks[b].role === "original");
    const cell = stab.blocks[sIndex].cell;
    const pIndex = preview.blocks.findIndex((b) => b.cell.join() === cell.join());
    assert.notEqual(pIndex, -1);
    assert.deepEqual(lib.mapBlockIndices(preview, stab, [pIndex]), [sIndex]);
    AS().hoverBlock(pIndex);
    assert.equal(AS().hoverIssueId, AS().blockIssues.get(sIndex), "the hover lights the issue of the same cell");
    AS().clickBlock(pIndex);
    assert.equal(AS().selection.ids.length, 1);
    const shown = AS().view.highlight.map((i) => preview.blocks[i].cell.join());
    assert.ok(shown.length > 0 && shown.every((c) => stab.issues.some((it) => it.blocks.some((b) => stab.blocks[b].cell.join() === c))), "the highlight is in the preview's own numbers");
    AS().setPreview("s1", null);
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
// ================= the brief: the sentence, the four figures, the problem rows, the checks, in plain words =================

/** Words and shapes that belong to the exported report and the glossary, not to the panel's default text. */
const CELL_COORDS = /\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/;
const AXES = /(?:^|[\s(,/])[+\-−][XYZ]\b/;
const assertPlainText = (text, where) => {
    assert.deepEqual(lib.technicalWordsIn(text), [], `${where}: ${text}`);
    assert.doesNotMatch(text, CELL_COORDS, `${where}: a cell coordinate in ${text}`);
    assert.doesNotMatch(text, AXES, `${where}: an axis name in ${text}`);
    assert.doesNotMatch(text, /\bkPa\b|\bMPa\b/, `${where}: ${text}`);
};
/** What the sentence reads: issues, the stability (null: nothing on the ground) and the block count. */
const brief = (issues, { grounded = true, blocks = 28 } = {}) => ({ issues, stability: grounded ? { inside: true } : null, stats: { blockCount: blocks } });
const iss = (kind, severity = "error", id = `${kind}-${Math.random().toString(36).slice(2, 6)}`) => ({ id, kind, severity, title: `title ${id}`, detail: `detail ${id}`, blocks: [], focusMm: [0, 0, 0] });
const many = (n, kind, severity = "error") => Array.from({ length: n }, (_, i) => iss(kind, severity, `${kind}-${i}`));

await test("verdictSentence: one plain sentence for every case of the spec", () => {
    const say = (issues, opts) => lib.verdictSentence(brief(issues, opts));
    assert.equal(say([iss("cog-outside")]).text, "Will tip over.");
    assert.equal(say([iss("cog-outside"), ...many(2, "cantilever-too-long")]).text, "Will tip over and 2 arms are too long.");
    assert.equal(say([...many(1, "floating"), ...many(2, "cantilever-too-long")]).text, "Won't stand: 1 part is floating and 2 arms are too long.");
    assert.equal(say([...many(2, "floating")], { grounded: false }).text, "Won't stand: nothing touches the ground.", "nothing grounded says it once, not twice");
    assert.equal(say([...many(1, "highly-stressed", "warning")]).text, "Will stand, but 1 joint is heavily loaded.");
    assert.equal(say([...many(3, "highly-stressed", "warning")]).text, "Will stand, but 3 joints are heavily loaded.");
    assert.equal(say([iss("cog-outside", "warning")]).text, "Will stand, but it is balanced on the very edge.");
    assert.equal(say([iss("thin-features", "warning")]).text, "Will stand, but thin parts were left out.");
    assert.deepEqual(say([]), { kind: "pass", text: "Will stand.", sub: "All checks pass.", pill: "Stable", more: 0 });
    assert.deepEqual(lib.verdictSentence(brief([], { blocks: 0 })), { kind: "empty", text: "Nothing to check: the model has no blocks.", sub: null, pill: "No blocks", more: 0 });
    assert.equal(lib.verdictSentence(brief([iss("empty")], { blocks: 0, grounded: false })).kind, "empty");
    // The grammar follows the count.
    // A long arm breaks a rule rather than gravity: alone it is not "won't stand"; next to a reason that is, the sentence says so.
    assert.equal(say([...many(1, "cantilever-too-long")]).text, "1 arm is too long.");
    assert.equal(say([...many(1, "overstressed")]).text, "Won't stand: 1 joint is overloaded.");
    assert.equal(say([...many(2, "overstressed")]).text, "Won't stand: 2 joints are overloaded.");
    assert.equal(say([...many(2, "floating")]).text, "Won't stand: 2 parts are floating.");
});

await test("verdictSentence: it names at most two reasons, the rest are '(+N more)'; errors speak for a failing model, warnings only for one that stands", () => {
    const say = (issues, opts) => lib.verdictSentence(brief(issues, opts));
    const everything = [iss("cog-outside"), ...many(1, "floating"), ...many(2, "cantilever-too-long"), ...many(1, "overstressed")];
    const tip = say(everything);
    assert.equal(tip.text, "Will tip over and 1 part is floating (+2 more).");
    assert.equal(tip.more, 2);
    assert.equal(tip.pill, "Will tip over");
    const noTip = say(everything.slice(1));
    assert.equal(noTip.text, "Won't stand: 1 part is floating and 2 arms are too long (+1 more).");
    assert.equal(noTip.more, 1);
    assert.equal(noTip.pill, "1 part floating");
    // Warnings next to errors are not in the sentence, and not in the count.
    const mixed = say([...many(2, "cantilever-too-long"), iss("cog-outside", "warning"), ...many(1, "highly-stressed", "warning")]);
    assert.equal(mixed.text, "2 arms are too long.");
    assert.equal(mixed.more, 0);
    // Warnings: the edge first, then loaded joints, then thin parts; also at most two.
    const warn = say([iss("thin-features", "warning"), ...many(2, "highly-stressed", "warning"), iss("cog-outside", "warning")]);
    assert.equal(warn.text, "Will stand, but it is balanced on the very edge and 2 joints are heavily loaded (+1 more).");
    assert.equal(warn.kind, "warn");
    assert.equal(warn.pill, "Balanced on the edge");
    // A budget alone is not "won't stand"; with a real problem it is one of the reasons.
    assert.equal(say([iss("too-many-blocks")]).text, "It is over the block budget.");
    assert.equal(say([iss("too-many-blocks")]).pill, "Over the block budget");
    assert.equal(say([...many(2, "cantilever-too-long"), iss("too-many-blocks")]).text, "2 arms are too long and it is over the block budget.");
    assert.equal(say([...many(2, "cantilever-too-long"), ...many(1, "overstressed")]).text, "Won't stand: 2 arms are too long and 1 joint is overloaded.");
    // An error of a kind it does not know still fails the model.
    const odd = say([iss("something-new")]);
    assert.equal(odd.kind, "fail");
    assert.match(odd.text, /^There are problems to fix\.$/);
    // The pill forms.
    assert.equal(say([...many(2, "cantilever-too-long")]).pill, "2 arms too long");
    assert.equal(say([...many(1, "overstressed")]).pill, "1 joint overloaded");
    assert.equal(say([...many(1, "highly-stressed", "warning")]).pill, "1 joint heavily loaded");
    assert.equal(say([...many(2, "floating")], { grounded: false }).pill, "Nothing on the ground");
});

await test("verdictSentence on the engine's own results: the shelf with a long arm, the same shelf with a column under it, and a tipping lean", () => {
    const shelf = measured(plainDesc(armCells(6)));
    assert.equal(lib.verdictSentence(shelf).text, "Won't stand: 1 arm is too long and 1 joint is overloaded.");
    const fixed = measured(addedDesc(armCells(5), TIP_COLUMN));
    assert.equal(fixed.issues.length, 0);
    assert.equal(lib.verdictSentence(fixed).text, "Will stand.");
    const lean = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]]));
    assert.match(lib.verdictSentence(lean).text, /^Will tip over/);
    for (const r of [shelf, fixed, lean]) {
        const sentence = lib.verdictSentence(r);
        assertPlainText(sentence.text, "sentence");
        assertPlainText(sentence.pill, "pill");
        assertPlainText(sentence.sub ?? "", "sub");
        assert.ok(sentence.text.endsWith("."), sentence.text);
    }
});

await test("the snapshot carries the sentence of the model's result (null before there is one)", () => {
    resetAnalysis();
    const model = { id: "m1", glb_url: "/m1.glb", kind: "generated", source_model_id: null, derived: null };
    S().setProject(detail(crypto.randomUUID()));
    S().addModel({ ...modelFor(makeJob(crypto.randomUUID())), ...model });
    S().setActiveModel("m1");
    assert.equal(lib.useAnalysisSnapshot(model).sentence, null);
    const shelf = measured(plainDesc(armCells(6)));
    AS().runSucceeded("m1", shelf);
    const snapshot = lib.useAnalysisSnapshot(model);
    assert.equal(snapshot.sentence.text, "Won't stand: 1 arm is too long and 1 joint is overloaded.");
    assert.equal(snapshot.sentence.pill, "1 arm too long");
    assert.equal(snapshot.result, shelf);
    assert.equal(snapshot.viewResult, shelf, "the stage draws the model's own result");
    // Another model's result is not this one's.
    assert.equal(lib.useAnalysisSnapshot({ ...model, id: "other" }).sentence, null);
});

/** A result with the parts keyFigures reads. */
const figResult = ({ issues = [], stability = { inside: true, marginMm: 142, cogMm: [450, 300, 250] }, longest = 0, limit = 4, stress = undefined, blocks = 237, budget = null, roleCounts = null, floating = 0 } = {}) => ({
    issues,
    stability,
    stats: { blockCount: blocks, longestCantilever: longest, floatingCount: floating },
    settings: { cantileverLimit: limit, maxBlocks: budget },
    stress: stress === undefined ? { maxUtilisation: 0.54, unsupportedBlocks: floating } : stress,
    assembly: roleCounts ? { roleCounts } : null,
    cantilevers: [],
});
const figs = (over) => Object.fromEntries(lib.keyFigures(figResult(over)).map((f) => [f.key, f]));

await test("keyFigures: four figures in order, each with a value, a unit and a mark (symbol as well as colour)", () => {
    const list = lib.keyFigures(figResult());
    assert.deepEqual(list.map((f) => f.key), ["balance", "overhang", "strength", "blocks"]);
    assert.deepEqual(list.map((f) => f.label), ["Balance", "Longest overhang", "Strength used", "Blocks used"]);
    const [balance, overhang, strength, blocks] = list;
    assert.deepEqual([balance.value, balance.unit, balance.mark], ["142 mm", "inside", "pass"]);
    assert.equal(balance.summary, "Balance: passes. 142 mm inside the base.");
    assert.deepEqual([overhang.value, overhang.unit, overhang.mark], ["none", "", "pass"]);
    assert.deepEqual([strength.value, strength.unit, strength.mark], ["54%", "worst joint", "pass"]);
    assert.equal(strength.summary, "Strength used: passes. 54% used at the worst joint.");
    assert.deepEqual([blocks.value, blocks.unit, blocks.mark], ["237", "", "none"]);
    assert.equal(blocks.summary, "Blocks used: 237 blocks.");
    // Every figure has a tooltip with the technical term, and none shows the technical term itself.
    for (const f of list) {
        assert.match(f.tip, /Technical term: /, f.key);
        assert.ok(f.tech.length > 0);
        for (const text of [f.label, f.value, f.unit, f.summary]) assertPlainText(text, f.key);
    }
    assert.match(balance.tip, /centre-of-gravity margin/i);
    assert.equal(balance.tech, "Centre-of-gravity margin to the support base");
    assert.match(overhang.tip, /cantilever/i);
    assert.match(strength.tip, /utilisation/i);
    assert.match(blocks.tip, /components/i);
});

await test("keyFigures: balance fails outside the base or with nothing on the ground, warns on the very edge (the report's 1 mm), passes inside", () => {
    const outside = figs({ stability: { inside: false, marginMm: -85, cogMm: [0, 0, 0] }, issues: [iss("cog-outside")] }).balance;
    assert.deepEqual([outside.value, outside.unit, outside.mark], ["85 mm", "outside", "fail"]);
    assert.equal(outside.summary, "Balance: fails. 85 mm outside the base.");
    const hair = figs({ stability: { inside: false, marginMm: -0.4, cogMm: [0, 0, 0] }, issues: [iss("cog-outside")] }).balance;
    assert.deepEqual([hair.value, hair.mark], ["< 1 mm", "fail"], "never '0 mm'");
    const edge = figs({ stability: { inside: true, marginMm: 0.3, cogMm: [0, 0, 0] }, issues: [iss("cog-outside", "warning")] }).balance;
    assert.deepEqual([edge.value, edge.unit, edge.mark], ["< 1 mm", "on the edge", "warn"]);
    assert.equal(edge.summary, "Balance: has a warning. On the very edge of the base.");
    const roomy = figs({ stability: { inside: true, marginMm: 1, cogMm: [0, 0, 0] } }).balance;
    assert.deepEqual([roomy.value, roomy.mark], ["1 mm", "pass"], "1 mm of margin and no warning: inside");
    const nothing = figs({ stability: null, issues: many(1, "floating") }).balance;
    assert.deepEqual([nothing.value, nothing.unit, nothing.mark], ["-", "nothing on the ground", "fail"]);
    const empty = figs({ stability: null, blocks: 0 }).balance;
    assert.deepEqual([empty.value, empty.unit, empty.mark], ["-", "no blocks", "none"]);
    assert.equal(figs({ stability: { inside: true, marginMm: 1234, cogMm: [0, 0, 0] } }).balance.value, "1,234 mm");
});

await test("keyFigures: the longest overhang against the limit; strength used at 75% and 100%; blocks used against a budget", () => {
    const o = (longest, limit = 4) => figs({ longest, limit }).overhang;
    assert.deepEqual([o(0).value, o(0).mark], ["none", "pass"]);
    assert.deepEqual([o(1).value, o(1).unit, o(1).mark], ["1 block", "max 4", "pass"]);
    assert.deepEqual([o(4).value, o(4).mark], ["4 blocks", "pass"], "at the limit is allowed");
    assert.deepEqual([o(5).value, o(5).mark], ["5 blocks", "fail"], "one past is not");
    assert.deepEqual([o(6).unit, o(6).mark, o(6, 6).mark], ["max 4", "fail", "pass"]);
    assert.equal(o(6).summary, "Longest overhang: fails. 6 blocks, the most allowed is 4.");
    assert.equal(figs({ longest: 3, stability: { inside: true, marginMm: 5, cogMm: [0, 0, 0] }, blocks: 0 }).overhang.mark, "none", "no blocks: nothing to judge");
    const u = (v) => figs({ stress: { maxUtilisation: v } }).strength;
    assert.equal(u(0.5).mark, "pass");
    assert.equal(u(0.75).mark, "pass", "75% exactly is not above the warning level");
    assert.equal(u(0.7501).mark, "warn");
    assert.equal(u(1).mark, "warn", "100% exactly is not past the limit");
    assert.equal(u(1.0001).mark, "fail");
    assert.deepEqual([u(1.32).value, u(1.32).unit], ["132%", "worst joint"]);
    assert.equal(u(1.32).summary, "Strength used: fails. 132% used at the worst joint.");
    assert.equal(u(0.004).value, "0%");
    const none = figs({ stress: null }).strength;
    assert.deepEqual([none.value, none.unit, none.mark], ["-", "no estimate", "none"]);
    // Blocks used: a number, unless there is a budget; the stabilizer's added blocks are said.
    const b = (opts) => figs(opts).blocks;
    assert.deepEqual([b({}).value, b({}).unit, b({}).mark], ["237", "", "none"]);
    assert.deepEqual([b({ budget: 300 }).unit, b({ budget: 300 }).mark], ["of 300", "pass"]);
    assert.deepEqual([b({ budget: 237 }).mark, b({ budget: 236 }).mark], ["pass", "fail"], "at the budget is within it");
    assert.equal(b({ budget: 236 }).summary, "Blocks used: fails. 237 blocks, the budget is 236.");
    assert.deepEqual([b({ roleCounts: [237, 10, 4, 2, 0, 0] }).unit, b({ roleCounts: [237, 10, 4, 2, 0, 0] }).mark], ["+16 added", "none"]);
    assert.equal(b({ budget: 300, roleCounts: [237, 16, 0, 0, 0, 0] }).unit, "of 300 · +16 added");
    assert.equal(lib.addedBlockCount({ assembly: { roleCounts: [237, 10, 4, 2, 0, 0] } }), 16);
    assert.equal(lib.addedBlockCount({ assembly: null }), 0);
});

await test("keyFigures on the engine's results: the shelf fails two chips, the same shelf with a column under the arm passes them", () => {
    const shelf = lib.keyFigures(measured(plainDesc(armCells(6))));
    assert.deepEqual(shelf.map((f) => f.mark), ["pass", "fail", "fail", "none"]);
    assert.equal(shelf[1].value, "6 blocks");
    assert.match(shelf[2].value, /^\d+%$/);
    const fixed = lib.keyFigures(measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.deepEqual(fixed.map((f) => f.mark), ["pass", "pass", "pass", "none"]);
    assert.equal(fixed[3].unit, "+4 added");
    for (const f of [...shelf, ...fixed]) for (const text of [f.label, f.value, f.unit, f.summary]) assertPlainText(text, f.key);
});

await test("keyFigures with floating parts: balance and strength are the grounded part's alone, so neither is a green tick; a real reading stays as it is", () => {
    const sky = { floating: 3, issues: many(1, "floating") };
    const f = figs({ ...sky, stress: { maxUtilisation: 0.004, unsupportedBlocks: 3 } });
    // Balance keeps its number and says whose it is.
    assert.deepEqual([f.balance.value, f.balance.unit, f.balance.mark], ["142 mm", "base only", "none"]);
    assert.match(f.balance.tip, /Only the grounded part is counted: the floating parts are not\./);
    assert.match(f.balance.tip, /Technical term: /);
    assert.equal(f.balance.summary, "Balance: For information only: 142 mm inside the base, counting only the grounded part.");
    // Strength has no reading at all: "0%" would say the model is fine.
    assert.deepEqual([f.strength.value, f.strength.unit, f.strength.mark], ["-", "floating parts not counted", "none"]);
    assert.match(f.strength.tip, /only the grounded part was checked/);
    assert.match(f.strength.summary, /^Strength used: No reading: the floating parts are not analysed/);
    for (const figure of [f.balance, f.strength]) for (const text of [figure.value, figure.unit, figure.summary]) assert.doesNotMatch(text, /\b0%/, figure.key);
    for (const figure of Object.values(f)) for (const text of [figure.label, figure.value, figure.unit, figure.summary]) assertPlainText(text, figure.key);
    // The same model without anything in the air: the ticks are back.
    const grounded = figs({ stress: { maxUtilisation: 0.004, unsupportedBlocks: 0 } });
    assert.deepEqual([grounded.balance.unit, grounded.balance.mark, grounded.strength.value, grounded.strength.mark], ["inside", "pass", "0%", "pass"]);
    // Blocks the estimate left out count even when the result says none float (the two rules agree with the stabilizer's log).
    assert.equal(figs({ stress: { maxUtilisation: 0.01, unsupportedBlocks: 2 } }).strength.mark, "none");
    // A real reading is never hidden: a joint at 90% warns and one at 120% fails, floating parts or not.
    const heavy = figs({ ...sky, stress: { maxUtilisation: 0.9, unsupportedBlocks: 3 } }).strength;
    assert.deepEqual([heavy.value, heavy.mark], ["90%", "warn"]);
    const over = figs({ ...sky, stress: { maxUtilisation: 1.2, unsupportedBlocks: 3 } }).strength;
    assert.deepEqual([over.value, over.mark], ["120%", "fail"]);
    // A centre of gravity that is outside, on the edge, or over nothing is a finding of its own and stays as it is.
    const tips = figs({ ...sky, stability: { inside: false, marginMm: -30, cogMm: [0, 0, 0] }, issues: [iss("cog-outside"), ...sky.issues] }).balance;
    assert.deepEqual([tips.unit, tips.mark], ["outside", "fail"]);
    const edge = figs({ ...sky, stability: { inside: true, marginMm: 0.4, cogMm: [0, 0, 0] }, issues: [iss("cog-outside", "warning"), ...sky.issues] }).balance;
    assert.deepEqual([edge.unit, edge.mark], ["on the edge", "warn"]);
    const nothing = figs({ ...sky, stability: null, stress: null }).balance;
    assert.deepEqual([nothing.unit, nothing.mark], ["nothing on the ground", "fail"]);
    assert.deepEqual([figs({ ...sky, stress: null }).strength.unit, figs({ ...sky, stress: null }).strength.mark], ["no estimate", "none"]);
    // The overhang and blocks chips are not about the floating parts.
    assert.equal(f.overhang.mark, "pass");
    assert.equal(f.blocks.mark, "none");
});

/** A 3 x 3 base on the ground, a part in the air: "Won't stand: 1 part is floating", and a strength reading of 0.01 % for the base alone. */
const FLOATY = uniq([...box(0, 3, 0, 3, 0, 2), [8, 8, 5]]);
const TIPPY = uniq([[0, 0, 0], ...range(7).map((i) => [i, 0, 1]), [8, 8, 5], [8, 8, 6]]);

await test("keyFigures on the engine's results with a part in the air: the four chips never contradict the sentence", () => {
    const result = measured(plainDesc(FLOATY));
    assert.ok(result.stats.floatingCount > 0 && result.stress.maxUtilisation < 0.01);
    assert.equal(lib.verdictSentence(result).text, "Won't stand: 1 part is floating.");
    const [balance, overhang, strength, blocks] = lib.keyFigures(result);
    assert.deepEqual([balance.mark, strength.mark, strength.value], ["none", "none", "-"]);
    assert.deepEqual([overhang.mark, blocks.mark], ["pass", "none"]);
    // One property over fixtures of every kind: what the sentence says is wrong is not a tick in the chip it is about.
    const fixtures = {
        floaty: result,
        tippy: measured(plainDesc(TIPPY)),
        shelf: measured(plainDesc(armCells(6))),
        fixed: measured(addedDesc(armCells(5), TIP_COLUMN)),
        warn: measured(plainDesc(warnCells())),
        lean: measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]])),
        budget: lib.analyzeAssembly(plainDesc(armCells(5)), null, lib.sanitizeSettings({ maxBlocks: 20 })),
        hanging: measured(plainDesc([[1, 1, 3], [1, 1, 4]])),
        empty: lib.analyzeAssembly(plainDesc([]), null, lib.sanitizeSettings(null)),
    };
    for (const [name, r] of Object.entries(fixtures)) assertChipsAgree(name, r);
});

await test("issueBrief: what, where and why for every kind of issue, in plain words and never a cell coordinate", () => {
    const lean = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]]));
    const shelf = measured(plainDesc(armCells(6)));
    const floating = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 2], [2, 0, 2]]));
    const budget = lib.analyzeAssembly(plainDesc(armCells(5)), null, lib.sanitizeSettings({ maxBlocks: 20 }));
    const edge = measured(plainDesc([[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 2]]));
    const heavy = measured(plainDesc([...box(0, 4, 0, 3, 0, 1), ...box(0, 1, 1, 2, 1, 5), ...box(1, 5, 1, 2, 4, 5), [1, 1, 5], [2, 1, 5]]), lib.sanitizeSettings({ cantileverLimit: 10 }));
    const seen = new Set();
    for (const [name, r] of Object.entries({ lean, shelf, floating, budget, edge, heavy })) {
        for (const issue of r.issues) {
            const b = lib.issueBrief(issue, r);
            seen.add(`${issue.kind}/${issue.severity}`);
            assert.equal(b.what, issue.title);
            assert.equal(b.why, issue.detail);
            assert.equal(b.tone, issue.severity === "error" ? "fail" : "warn");
            for (const [field, text] of [["what", b.what], ["where", b.where], ["why", b.why]]) assertPlainText(text, `${name} ${issue.id} ${field}`);
        }
    }
    for (const k of ["cog-outside/error", "cog-outside/warning", "cantilever-too-long/error", "floating/error", "too-many-blocks/error", "overstressed/error", "highly-stressed/warning"]) assert.ok(seen.has(k), `${k} was looked at`);
    const where = (r, kind) => lib.issueBrief(r.issues.find((i) => i.kind === kind), r).where;
    assert.equal(where(lean, "cog-outside"), "weight pulls to the right", "a tip says which way");
    assert.match(where(shelf, "cantilever-too-long"), /^500-600 mm up, (right side|back right|front right)$/);
    assert.match(where(floating, "floating"), /^200-300 mm up, (right side|back right|front right|in the middle)$/);
    assert.equal(where(budget, "too-many-blocks"), "", "a whole-model issue has no place");
    assert.equal(where(edge, "cog-outside"), "weight is at the right edge");
    // A stress issue is about one joint, at the peak block.
    const stress = shelf.issues.find((i) => i.kind === "overstressed");
    const peak = shelf.blocks[stress.blocks[0]];
    assert.match(lib.issueBrief(stress, shelf).where, new RegExp(`^${peak.cell[2] * 100}-${(peak.cell[2] + 1) * 100} mm up, `));
    // The headings and rows read the same at every width: short enough for one line each.
    for (const issue of [...shelf.issues, ...lean.issues]) assert.ok(lib.issueBrief(issue, shelf).what.length <= 48, issue.title);
});

await test("issueBrief: a tip without a direction, thin parts left out (a point, no blocks), and a result with no stability", () => {
    const base = { blocks: Array.from({ length: 4 }, (_, i) => ({ index: i, cell: [i, 0, 0], centerMm: [i * 100 + 50, 50, 50] })), settings: { blockSizeMm: 100 }, stability: null };
    const tip = { id: "cog", kind: "cog-outside", severity: "error", title: "Tips over: 5 mm past the base", detail: "d", blocks: [], focusMm: [0, 0, 0] };
    assert.equal(lib.issueBrief(tip, base).where, "weight is past the base");
    assert.equal(lib.issueBrief(tip, { ...base, stability: { tipDirection: [0, -1] } }).where, "weight pulls to the front");
    assert.equal(lib.issueBrief(tip, { ...base, stability: { tipDirection: [-1, 1] } }).where, "weight pulls to the back left");
    const edge = { ...tip, severity: "warning", title: "Balanced on the edge of the base" };
    // The base is the square (0..100); the weight is 0.5 mm from its right edge.
    const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
    assert.equal(lib.issueBrief(edge, { ...base, stability: { supportHull: square, groundPointMm: [99.5, 50] } }).where, "weight is at the right edge");
    assert.equal(lib.issueBrief(edge, { ...base, stability: { supportHull: square, groundPointMm: [50, 0.5] } }).where, "weight is at the front edge", "-Y is towards you");
    assert.equal(lib.issueBrief(edge, { ...base, stability: { supportHull: [], groundPointMm: [0, 0] } }).where, "weight is on the edge of the base");
    assert.equal(lib.issueBrief(edge, base).where, "weight is on the edge of the base");
    const thin = { id: "thin-features", kind: "thin-features", severity: "warning", title: "Thin parts left out: 62% of the model kept", detail: "d", blocks: [], focusMm: [350, 50, 250] };
    assert.equal(lib.issueBrief(thin, base).where, "200-300 mm up, right side");
    assert.equal(lib.issueBrief({ ...thin, focusMm: [200, 50, 0] }, base).where, "0-100 mm up, in the middle");
});

await test("the exported report keeps the technical terms: each issue has the engine's sentence and a technical summary (kind, measured value against its limit, cells)", () => {
    const lean = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]]));
    const shelf = measured(plainDesc(armCells(6)));
    const floating = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 2], [2, 0, 2]]));
    const budget = lib.analyzeAssembly(plainDesc(armCells(5)), null, lib.sanitizeSettings({ maxBlocks: 20 }));
    const edge = measured(plainDesc([[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 2]]));
    const heavy = measured(plainDesc([...box(0, 4, 0, 3, 0, 1), ...box(0, 1, 1, 2, 1, 5), ...box(1, 5, 1, 2, 4, 5), [1, 1, 5], [2, 1, 5]]), lib.sanitizeSettings({ cantileverLimit: 10 }));
    const seen = new Map();
    for (const [name, r] of Object.entries({ lean, shelf, floating, budget, edge, heavy })) {
        // Through JSON, as the file is written: nothing in the summary is lost to a NaN.
        const doc = JSON.parse(JSON.stringify(lib.buildReport(r)));
        assert.equal(doc.issues.length, r.issues.length, name);
        for (const issue of doc.issues) {
            const t = issue.technical_summary;
            assert.ok(t, `${name} ${issue.id}: a technical summary`);
            assert.equal(t.kind, issue.kind);
            assert.ok(t.metric.length > 8 && ["mm", "blocks", "ratio"].includes(t.unit), `${issue.id}: ${t.metric} / ${t.unit}`);
            assert.ok(t.measured === null || Number.isFinite(t.measured), issue.id);
            assert.ok(t.limit === null || Number.isFinite(t.limit), issue.id);
            assert.equal(t.bound === null, t.limit === null, "a limit has a direction");
            assert.ok(t.cells.every((c) => c.length === 3 && c.every(Number.isInteger)), `${issue.id}: cells are [i, j, k]`);
            // The screen's words are untouched, and the report has the sentence in the engine's terms next to the summary.
            assert.equal(issue.title, r.issues.find((i) => i.id === issue.id).title);
            assert.ok(issue.technical.length > 10);
            seen.set(`${name}:${issue.kind}/${issue.severity}`, { issue, t, doc });
        }
    }
    // Every kind the engine raises here is covered, by severity.
    for (const key of ["lean:cog-outside/error", "edge:cog-outside/warning", "shelf:cantilever-too-long/error", "floating:floating/error", "budget:too-many-blocks/error", "shelf:overstressed/error", "heavy:highly-stressed/warning"]) assert.ok(seen.has(key), `${key} in the fixtures`);

    // Measured against the limit, in the engine's units.
    const arm = seen.get("shelf:cantilever-too-long/error");
    assert.deepEqual([arm.t.metric, arm.t.measured, arm.t.limit, arm.t.unit, arm.t.bound], ["Cantilever reach", shelf.stats.longestCantilever, 4, "blocks", "max"]);
    assert.equal(shelf.stats.longestCantilever, 6);
    assert.match(arm.issue.title, /6 blocks/, "the screen's title and the summary agree");
    assert.deepEqual(arm.t.cells, arm.issue.cells, "the blocks past the limit");
    const tip = seen.get("lean:cog-outside/error");
    assert.equal(tip.t.metric, "Centre-of-gravity margin to the support base");
    assert.deepEqual([tip.t.unit, tip.t.limit, tip.t.bound], ["mm", 0, "min"]);
    assert.ok(tip.t.measured < 0, "negative: outside the base");
    assert.equal(tip.t.measured, tip.doc.stability.margin_mm);
    const hair = seen.get("edge:cog-outside/warning");
    assert.deepEqual([hair.t.limit, hair.t.bound], [1, "min"], "the edge warning is held to the report's 1 mm");
    assert.ok(hair.t.measured >= 0 && hair.t.measured < 1);
    const air = seen.get("floating:floating/error");
    assert.deepEqual([air.t.measured, air.t.limit, air.t.unit, air.t.bound], [2, 0, "blocks", "max"]);
    const over = seen.get("budget:too-many-blocks/error");
    assert.deepEqual([over.t.metric, over.t.measured, over.t.limit], ["Components used", shelfBlocks(budget), 20]);
    const joint = seen.get("shelf:overstressed/error");
    assert.deepEqual([joint.t.unit, joint.t.limit, joint.t.bound], ["ratio", 1, "max"]);
    assert.ok(joint.t.measured > 1);
    assert.equal(joint.t.cells.length, 1, "a joint is its peak block");
    assert.deepEqual(joint.t.cells[0], joint.issue.cells[0]);
    assert.match(joint.issue.technical, new RegExp(`utilisation ${Math.round(joint.t.measured * 100)}%`), "the sentence and the summary say the same number");
    const heavyJoint = seen.get("heavy:highly-stressed/warning");
    assert.deepEqual([heavyJoint.t.limit, heavyJoint.t.unit], [lib.STRESS_WARN, "ratio"]);
    assert.ok(heavyJoint.t.measured > lib.STRESS_WARN && heavyJoint.t.measured <= lib.STRESS_FAIL);
    function shelfBlocks(r) {
        return r.stats.blockCount;
    }
});

await test("technicalSummary: the findings a mesh run raises (thin parts, thin joints, no blocks) and a model with nothing on the ground", () => {
    const base = { settings: lib.sanitizeSettings(null), cantilevers: [], bodies: [], blocks: [], stability: null, stress: null };
    const issue = (kind, over = {}) => ({ id: kind, kind, severity: "warning", title: "", detail: "", blocks: [], focusMm: [0, 0, 0], ...over });
    const thin = lib.technicalSummary(issue("thin-features"), { ...base, stats: { coverage: 0.55, blockCount: 12 } }, []);
    assert.deepEqual([thin.metric, thin.measured, thin.limit, thin.unit, thin.bound], ["Coverage (share of the model's volume inside blocks)", 0.55, 0.8, "ratio", "min"]);
    // At full coverage the same kind is the "thin joints" finding: floating blocks a lower fill threshold would connect.
    const joints = lib.technicalSummary(issue("thin-features", { blocks: [0, 1, 2] }), { ...base, stats: { coverage: 0.93, blockCount: 12 } }, [[0, 0, 3], [1, 0, 3], [2, 0, 3]]);
    assert.deepEqual([joints.metric, joints.measured, joints.limit, joints.unit, joints.bound], ["Floating blocks a lower fill threshold would connect", 3, 0, "blocks", "max"]);
    assert.equal(joints.cells.length, 3);
    const empty = lib.technicalSummary(issue("empty", { severity: "error" }), { ...base, stats: { coverage: 0, blockCount: 0 } }, []);
    assert.match(empty.metric, /^Blocks filled to at least 10% \(fill threshold\)$/);
    assert.deepEqual([empty.measured, empty.limit, empty.bound], [0, 1, "min"]);
    // Nothing on the ground: there is no margin to report, only the rule it is held to.
    const hanging = lib.technicalSummary(issue("cog-outside", { severity: "error" }), { ...base, stats: { coverage: 1, blockCount: 4 } }, []);
    assert.deepEqual([hanging.measured, hanging.limit, hanging.bound], [null, 0, "min"]);
    // A budget that is not set holds nothing.
    const free = lib.technicalSummary(issue("too-many-blocks", { severity: "error" }), { ...base, stats: { coverage: 1, blockCount: 30 } }, []);
    assert.deepEqual([free.measured, free.limit, free.bound], [30, null, null]);
});

await test("report: a thin-features finding reads the same in `technical` and `technical_summary`, whichever of its two forms it is", () => {
    // The engine's own results (a mesh is needed for both). A closed box as a triangle soup.
    const pushBox = (out, x0, y0, z0, x1, y1, z1) => {
        const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        for (const [a, b, c, d] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]) for (const i of [a, b, c, a, c, d]) out.push(...v[i]);
    };
    const soupOf = (floats) => ({ positions: new Float32Array(floats) });
    const thinOf = (result) => {
        const issue = result.issues.find((i) => i.kind === "thin-features");
        assert.ok(issue, `a thin-features finding among ${result.issues.map((i) => i.kind).join(", ")}`);
        const entry = JSON.parse(lib.buildReportJson(result)).issues.find((i) => i.kind === "thin-features");
        return { issue, entry, line: lib.technicalLine(issue, result) };
    };
    // 1. Thin joints: a 1000 mm slab on a 36 mm post (31% filled with the grazing layer, so a 35% threshold drops it). Coverage is 99%.
    const post = [];
    pushBox(post, 0, 0, 100, 1000, 1000, 1000);
    pushBox(post, 32, 32, 0, 68, 68, 100);
    const joints = lib.analyze(soupOf(post), { fillThreshold: 0.35 });
    assert.ok(joints.stats.coverage >= lib.COVERAGE_WARN, `coverage ${joints.stats.coverage}`);
    const j = thinOf(joints);
    assert.match(j.issue.title, /^Thin joints left out: 1 floating part would connect$/);
    assert.doesNotMatch(j.entry.technical, /warning below|Coverage \d+%/, "a 99% coverage is not a warning below 80%");
    assert.match(j.entry.technical, new RegExp(`^${j.issue.blocks.length} floating blocks? would be connected at a lower fill threshold \\(now 35%\\); coverage is ${Math.round(joints.stats.coverage * 100)}%\\.$`));
    assert.equal(j.entry.technical, j.line);
    assert.equal(j.entry.technical_summary.metric, "Floating blocks a lower fill threshold would connect");
    assert.equal(j.entry.technical_summary.measured, j.issue.blocks.length, "the number the sentence names is the one the summary measures");
    // 2. Thin parts: a solid base with five 8 mm walls (8% of a block: dropped at any threshold the app offers above that). Coverage is under 80%.
    const sheet = [];
    pushBox(sheet, 0, 0, 0, 1000, 1000, 100);
    for (const y of [100, 300, 500, 700, 900]) pushBox(sheet, 0, y, 100, 1000, y + 8, 1000);
    const thin = lib.analyze(soupOf(sheet), { fillThreshold: 0.5 });
    assert.ok(thin.stats.coverage < lib.COVERAGE_WARN, `coverage ${thin.stats.coverage}`);
    const t = thinOf(thin);
    assert.equal(t.entry.technical, `Coverage ${Math.round(thin.stats.coverage * 100)}% (warning below ${Math.round(lib.COVERAGE_WARN * 100)}%) at a fill threshold of 50%.`, "the limit is the engine's constant, not a literal");
    assert.equal(t.entry.technical_summary.metric, "Coverage (share of the model's volume inside blocks)");
    assert.equal(t.entry.technical_summary.limit, lib.COVERAGE_WARN);
    // Singular and plural, on a made-up result.
    const fake = (n) => lib.technicalLine({ kind: "thin-features", severity: "warning", id: "thin-features", title: "", detail: "", blocks: range(n), focusMm: [0, 0, 0] }, { settings: lib.sanitizeSettings(null), stats: { coverage: 0.93, blockCount: 12 } });
    assert.equal(fake(1), "1 floating block would be connected at a lower fill threshold (now 10%); coverage is 93%.");
    assert.equal(fake(3), "3 floating blocks would be connected at a lower fill threshold (now 10%); coverage is 93%.");
});

await test("sortIssuesForList: tipping, floating, long arms, overload, other errors, then the warnings; the engine's order within a kind", () => {
    const list = [
        iss("thin-features", "warning", "thin"), iss("highly-stressed", "warning", "loaded"), iss("cog-outside", "warning", "edge"),
        iss("too-many-blocks", "error", "budget"), iss("overstressed", "error", "over1"), iss("overstressed", "error", "over2"),
        iss("cantilever-too-long", "error", "arm1"), iss("cantilever-too-long", "error", "arm2"), iss("floating", "error", "float"), iss("cog-outside", "error", "tip"),
    ];
    const sorted = lib.sortIssuesForList(list);
    assert.deepEqual(sorted.map((i) => i.id), ["tip", "float", "arm1", "arm2", "over1", "over2", "budget", "edge", "loaded", "thin"]);
    assert.notEqual(sorted, list, "a new array");
    assert.equal(list[0].id, "thin", "the engine's list is not changed");
    assert.deepEqual(lib.sortIssuesForList([]), []);
    // Errors before warnings whatever the kind (an unknown one is an "other error").
    assert.deepEqual(lib.sortIssuesForList([iss("highly-stressed", "warning", "w"), iss("brand-new", "error", "e")]).map((i) => i.id), ["e", "w"]);
});

await test("checkLabel and checkValue: the six checks in plain words; the engine's own values (and the report) keep the technical ones", () => {
    const shelf = measured(plainDesc(armCells(6)));
    assert.deepEqual(["cog", "cantilevered", "long-cantilevers", "components", "floating", "stress"].map(lib.checkLabel), ["Balance", "Overhanging blocks", "Overhangs too long", "Blocks used", "Floating parts", "Strength used"]);
    const plain = Object.fromEntries(shelf.checks.map((row) => [row.key, lib.checkValue(row, shelf)]));
    assert.match(plain.cog, /^Inside the base, \d+ mm from the edge$/);
    assert.equal(plain.cantilevered, "6 blocks");
    assert.equal(plain["long-cantilevers"], "1 arm longer than 4 blocks");
    assert.equal(plain.components, "29 blocks");
    assert.equal(plain.floating, "None");
    assert.match(plain.stress, /^Worst joint uses \d+% of its strength$/);
    // The engine's row says it the technical way, and still does.
    assert.match(shelf.checks.find((r) => r.key === "cog").value, /^Inside the base · \d+ mm margin$/);
    assert.match(shelf.checks.find((r) => r.key === "stress").value, /^Peak \d+% of allowable at block \(\d+, \d+, \d+\)/);
    for (const [key, value] of Object.entries(plain)) assertPlainText(`${lib.checkLabel(key)}: ${value}`, key);
    // A tip, nothing on the ground, a budget, floating parts and a missing estimate.
    const lean = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]]));
    const tips = lib.checkValue(lean.checks[0], lean);
    assert.match(tips, /^Outside the base by \d+ mm, tips to the right$/);
    const budgeted = lib.analyzeAssembly(plainDesc(armCells(5)), null, lib.sanitizeSettings({ maxBlocks: 20 }));
    assert.equal(lib.checkValue(budgeted.checks.find((r) => r.key === "components"), budgeted), "28 blocks (budget 20)");
    const floating = measured(plainDesc([[0, 0, 0], [1, 0, 0], [1, 0, 2], [2, 0, 2]]));
    assert.equal(lib.checkValue(floating.checks.find((r) => r.key === "floating"), floating), "2 blocks in 1 floating part");
    assert.match(lib.checkValue(floating.checks[0], floating), /1? ?floating blocks? not counted|2 floating blocks not counted/);
    const noStress = { ...shelf, stress: null };
    assert.equal(lib.checkValue({ key: "stress", value: "Stress could not be estimated" }, noStress), "Stress could not be estimated", "the engine's plain line is used when there is no estimate");
    const hanging = lib.analyzeAssembly(plainDesc([[1, 1, 1], [1, 1, 2]]), null, lib.sanitizeSettings(null));
    assert.equal(lib.checkValue(hanging.checks[0], hanging), "Nothing touches the ground");
    assert.equal(lib.checkValue({ key: "cog", value: "x" }, lib.analyzeAssembly(plainDesc([]), null, lib.sanitizeSettings(null))), "No blocks");
});

await test("the vocabulary: every term has a plain label, a technical term and a tooltip that names it; the words the stage and lists use", () => {
    for (const [key, term] of Object.entries(lib.TERMS)) {
        assert.ok(term.label && term.tech && term.tip, key);
        assert.notEqual(term.label.toLowerCase(), term.tech.toLowerCase(), `${key}: the plain word differs from the technical one`);
        assert.ok(term.tip.includes("Technical term: "), `${key}: the tooltip names the technical term`);
        assertPlainText(term.label, `${key} label`);
    }
    assert.equal(lib.GLOSSARY.length, new Set(lib.GLOSSARY.map((t) => t.label)).size, "no term twice");
    assert.ok(lib.GLOSSARY.includes(lib.TERMS.overhang) && lib.GLOSSARY.includes(lib.TERMS.strengthUsed));
    assert.deepEqual(Object.keys(lib.CHECK_TERMS), ["cog", "cantilevered", "long-cantilevers", "components", "floating", "stress"]);
    assert.deepEqual(lib.STATUS_WORDS, { supported: "Supported", cantilever: "Overhang", overreach: "Overhang too long", floating: "Floating" });
    assert.deepEqual(lib.COLOR_WORDS, { status: "Status", reach: "Overhang", stress: "Strength", layer: "Layers", role: "Added blocks" });
    assert.deepEqual(lib.ROLE_WORDS, { original: "Original blocks", column: "Columns", footing: "Footings", bracket: "Brackets", bridge: "Bridges", reinforcement: "Thicker joints", user: "Your edits" });
    assert.deepEqual(lib.STRESS_MODE_WORDS, { tension: "being pulled apart", compression: "being crushed", shear: "being sheared" });
    // The check for jargon itself.
    assert.deepEqual(lib.technicalWordsIn("A cantilever with a high Utilisation, in kPa, by FEM."), ["cantilever", "utilisation", "kPa", "FEM"]);
    assert.deepEqual(lib.technicalWordsIn("Arm too long: 6 blocks (max 4). Strength used 132%."), []);
    assert.deepEqual(lib.technicalWordsIn("the Centre of Gravity"), ["centre of gravity"]);
    assert.deepEqual(lib.technicalWordsIn("a COGnitive load"), [], "COG is a whole word");
    assert.deepEqual(lib.technicalWordsIn("Comparing the compass, a hemp-fem, an impact"), [], "kPa, MPa and FEM are not found inside other words");
    assert.deepEqual(lib.technicalWordsIn("143 of 200kPa, or 0.2 MPa"), ["kPa", "MPa"], "a unit against its number still counts");
});

// ---------- the stabilizer: pure rules ----------

await test("the stabilizer's choices are clamped; its block budget is the analysis settings' one, so there is one budget", () => {
    assert.deepEqual(lib.sanitizeChoices(null), { target: 0.75 });
    assert.deepEqual(lib.sanitizeChoices({ target: 5, maxBlocks: 5000 }), { target: 0.75 }, "the target stops at the warning level; a budget of its own is not a choice any more");
    assert.deepEqual(lib.sanitizeChoices({ target: 0.1 }), { target: 0.4 });
    assert.equal(lib.sanitizeChoices({ target: 0.553 }).target, 0.55);
    assert.equal(lib.sanitizeChoices({ target: "x" }).target, 0.75);
    assert.deepEqual(lib.DEFAULT_CHOICES, { target: 0.75 });
    const o = lib.optionsFor({ target: 0.6 }, { maxBlocks: 120 });
    assert.equal(o.targetUtilisation, 0.6);
    assert.equal(o.maxBlocks, 120, "the block budget of the settings, which also decides the verdict");
    assert.equal(lib.optionsFor({ target: 0.6, maxBlocks: 80 }, { maxBlocks: 120 }).maxBlocks, 120, "a stale choice cannot override it");
    assert.equal(lib.optionsFor(lib.DEFAULT_CHOICES, { maxBlocks: null }).maxBlocks, 1000, "no budget: the 1000 cells of the grid");
    assert.equal(lib.optionsFor(lib.DEFAULT_CHOICES, { maxBlocks: 5000 }).maxBlocks, 1000, "never above the grid");
    assert.equal(o.maxSteps, 40);
    // The words that send the user to raise it point at Settings.
    const line = lib.nothingLine({ stop: "max-blocks", before: { blocks: 85, max_utilisation: null } }, { targetUtilisation: 0.75, maxBlocks: 50 });
    assert.match(line, /Raise the block budget in Settings\./);
    assert.doesNotMatch(line, /Options/);
});

await test("what the stabilizer can do about a verdict: thin parts alone are nothing for it, heavily loaded joints are 'Reduce stress', the rest is 'Stabilize'", () => {
    const issue = (kind, severity) => mkIssue(`${kind}-${severity}`, kind, severity, [1]);
    const fix = (...pairs) => lib.fixOfIssues(pairs.map(([kind, severity]) => issue(kind, severity)));
    assert.equal(fix(), "none", "no issue: nothing to fix");
    assert.equal(fix(["thin-features", "warning"]), "none", "thin parts left out: the stabilizer never moves on coverage");
    assert.equal(fix(["highly-stressed", "warning"]), "stress");
    assert.equal(fix(["highly-stressed", "warning"], ["highly-stressed", "warning"]), "stress");
    assert.equal(fix(["thin-features", "warning"], ["highly-stressed", "warning"]), "stress", "the thin parts do not take the stress away");
    assert.equal(fix(["cog-outside", "warning"]), "stabilize", "balanced on the edge: widening the base is what it does");
    assert.equal(fix(["cog-outside", "warning"], ["highly-stressed", "warning"]), "stabilize");
    assert.equal(fix(["thin-features", "warning"], ["cog-outside", "warning"]), "stabilize");
    assert.equal(fix(["floating", "error"]), "stabilize");
    assert.equal(fix(["floating", "error"], ["thin-features", "warning"]), "stabilize", "a problem is always offered");
    assert.equal(fix(["overstressed", "error"], ["highly-stressed", "warning"]), "stabilize");
    // The button's words, from the verdict.
    const label = (kind, fixOf) => lib.stabilizeLabelOf(kind === null ? null : { kind, fix: fixOf });
    assert.equal(label(null), null);
    assert.equal(label("pass", "none"), null);
    assert.equal(label("fail", "stabilize"), "Stabilize");
    assert.equal(label("fail", "none"), "Stabilize", "an error is offered whatever the fix says");
    assert.equal(label("warn", "stress"), "Reduce stress");
    assert.equal(label("warn", "stabilize"), "Stabilize");
    assert.equal(label("warn", "none"), null, "a warning the stabilizer cannot act on has no button");
    assert.equal(label("warn", undefined), "Stabilize", "a verdict that does not say is offered under the plain word, never under a claim about the cause");
    // verdictOf carries it: given outright for a result, inferred for a saved summary.
    assert.equal(lib.verdictOf({ errors: 0, warnings: 1, blocks: 9, fix: "none" }).fix, "none");
    assert.equal(lib.verdictOf({ errors: 0, warnings: 0, blocks: 9 }).fix, "none");
    assert.equal(lib.verdictOf({ errors: 2, warnings: 0, blocks: 9 }).fix, "stabilize");
});

await test("the fix of a saved summary: its counts and figures tell thin parts, the edge and the stress apart", () => {
    const stressed = (max_utilisation) => ({ material: "concrete", max_utilisation });
    const fix = (over) => lib.verdictOf(mkSummary({ warnings: 1, ...over })).fix;
    assert.equal(fix({ coverage: 0.5 }), "none", "one warning and coverage under 80%: thin parts, nothing else");
    assert.equal(fix({ coverage: 0.5, stress: stressed(0.44) }), "none", "the stress is fine");
    assert.equal(fix({ coverage: 0.9, stress: stressed(0.8) }), "stress", "the peak is over the warning level");
    assert.equal(fix({ coverage: 0.5, warnings: 2, stress: stressed(0.8) }), "stress", "thin parts and heavily loaded joints: the joints are what it can act on");
    assert.equal(fix({ cog_margin_mm: 0.4 }), "stabilize", "balanced on the edge");
    assert.equal(fix({ cog_margin_mm: 0.4, stress: stressed(0.8) }), "stabilize");
    assert.equal(fix({ coverage: 0.5, warnings: 2 }), "stabilize", "two warnings, one of them unexplained (a summary from before the stress estimate): offered");
    assert.equal(fix({ coverage: 0.95 }), "stabilize", "a warning nothing explains is offered, not hidden");
    assert.equal(lib.verdictOf(mkSummary({ errors: 1, warnings: 1, coverage: 0.5 })).fix, "stabilize", "an error is always offered");
    assert.equal(lib.verdictOf(mkSummary()).fix, "none", "a clean summary");
    // The same decision from the summary of a real analysis and from its issues.
    const thin = lib.analyzeAssembly(plainDesc(box(0, 3, 0, 3, 0, 2)), null, lib.sanitizeSettings(null));
    const grafted = { ...thin, issues: [mkIssue("thin-features", "thin-features", "warning", [])], summary: { ...thin.summary, warnings: 1, coverage: 0.7 } };
    assert.equal(lib.verdictOf(grafted.summary).fix, lib.fixOfIssues(grafted.issues), "summary and issues agree: nothing to fix");
    const warnResult = measured(plainDesc(warnCells()));
    assert.deepEqual([...new Set(warnResult.issues.map((i) => i.kind))], ["highly-stressed"], "the fixture: a joint at 99% of what it takes");
    assert.equal(lib.fixOfIssues(warnResult.issues), "stress");
    assert.equal(lib.verdictOf(warnResult.summary).fix, "stress", "and the summary says the same");
});

await test("the mirrored limits are the engine's own", () => {
    assert.equal(lib.COVERAGE_WARN_SHARE, lib.COVERAGE_WARN);
    assert.equal(lib.EDGE_WARN_MM, lib.EDGE_MARGIN_MM);
});

await test("the Stabilize card is offered for a model with something to fix, and says why when it cannot run", () => {
    const stats = { blockCount: 28 };
    const base = { model: { id: "a", derived: null }, models: [], result: { stats, stress: null }, verdict: { kind: "fail" }, analysing: false };
    assert.deepEqual(lib.stabilizeOffer(base), { label: "Stabilize", child: null, blocked: null });
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "warn" } }).label, "Stabilize", "a warning-only verdict that does not say what it is about: the plain word");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "warn", fix: "stress" } }).label, "Reduce stress", "only heavily loaded joints are left");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "warn", fix: "none" } }), null, "only thin parts left out: the stabilizer has nothing to do, so no card");
    // The result's issues are the authority on which warnings there are.
    const withIssues = (...kinds) => ({ ...base, verdict: { kind: "warn" }, result: { stats, stress: null, issues: kinds.map((k) => mkIssue(k, k, "warning", [1])) } });
    assert.equal(lib.stabilizeOffer(withIssues("highly-stressed")).label, "Reduce stress");
    assert.equal(lib.stabilizeOffer(withIssues("thin-features", "highly-stressed")).label, "Reduce stress");
    assert.equal(lib.stabilizeOffer(withIssues("cog-outside")).label, "Stabilize", "balanced on the edge");
    assert.equal(lib.stabilizeOffer(withIssues("thin-features")), null, "thin parts left out and nothing else: no button, not a run that adds nothing");
    assert.equal(lib.stabilizeOffer({ ...withIssues("thin-features"), verdict: { kind: "warn", fix: "stress" } }), null, "the issues win over a verdict that was made elsewhere");
    assert.equal(lib.stabilizeOffer({ ...withIssues("thin-features"), verdict: { kind: "fail" }, result: { stats, stress: null, issues: [mkIssue("floating-1", "floating", "error", [1]), mkIssue("thin-features", "thin-features", "warning", [])] } }).label, "Stabilize");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: { kind: "pass" } }), null, "nothing to fix: no card");
    assert.equal(lib.stabilizeOffer({ ...base, verdict: null }), null);
    assert.equal(lib.stabilizeOffer({ ...base, result: { stats: { blockCount: 0 }, stress: null } }), null);
    assert.match(lib.stabilizeOffer({ ...base, analysing: true }).blocked, /analysis to finish/);
    assert.match(lib.stabilizeOffer({ ...base, model: { id: "a", derived: { depth: 3 } } }).blocked, /maximum number of times/);
    const kids = (n) => range(n).map((i) => ({ id: `k${i}`, kind: "stabilized", source_model_id: "a", created_at: iso(i) }));
    const offer = lib.stabilizeOffer({ ...base, models: kids(2) });
    assert.equal(offer.child.id, "k1", "the newest version is the one to open");
    assert.equal(offer.blocked, null, "and a new run is still possible");
    assert.match(lib.stabilizeOffer({ ...base, models: kids(10) }).blocked, /10 versions already/);
    const many = range(40).map((i) => ({ id: `x${i}`, kind: "stabilized", source_model_id: `o${i % 7}`, created_at: iso(i) }));
    assert.match(lib.stabilizeOffer({ ...base, models: many }).blocked, /40 versions already/);
});

await test("the card's 'Open stabilized version' is the bar's: through a chain of versions an original opens the family's, a version opens its own", () => {
    const stats = { blockCount: 28 };
    const base = { model: { id: "r", derived: null }, models: [], result: { stats, stress: null }, verdict: { kind: "fail" }, analysing: false };
    const at = (id, kind, source, ms) => ({ id, kind, source_model_id: source, created_at: iso(ms) });
    const R = at("r", "generated", null, 0);
    const A = at("a", "stabilized", "r", 10);
    const B = at("b", "stabilized", "a", 20);
    const chain = [R, A, B];
    // generated -> A -> B: A is the only version made directly from R, but the bar's Stabilized half (the family's newest) is B.
    assert.equal(lib.stabilizeOffer({ ...base, models: chain }).child.id, "b");
    // A version offers the one made from it, and the last of a chain none.
    assert.equal(lib.stabilizeOffer({ ...base, model: { id: "a", derived: { depth: 1 } }, models: chain }).child.id, "b");
    assert.equal(lib.stabilizeOffer({ ...base, model: { id: "b", derived: { depth: 2 } }, models: chain }).child, null);
    // The version the bar remembers wins, when it is one of this original's; anything else is ignored.
    assert.equal(lib.stabilizeOffer({ ...base, models: chain, opens: { id: "a" } }).child.id, "a");
    assert.equal(lib.stabilizeOffer({ ...base, models: chain, opens: { id: "elsewhere" } }).child.id, "b");
    assert.equal(lib.stabilizeOffer({ ...base, models: chain, opens: null }).child.id, "b");
    // Another original's versions are not this one's, wherever they sit in the list or however new they are.
    const Q = at("q", "generated", null, 5);
    const QA = at("qa", "stabilized", "q", 30);
    assert.equal(lib.stabilizeOffer({ ...base, models: [R, A, Q, B, QA] }).child.id, "b");
    assert.equal(lib.stabilizeOffer({ ...base, model: { id: "q", derived: null }, models: [R, A, Q, B, QA] }).child.id, "qa");
    // Two siblings: the newest (by time, then by place in the list).
    const A2 = at("a2", "stabilized", "r", 40);
    assert.equal(lib.stabilizeOffer({ ...base, models: [R, A, B, A2] }).child.id, "a2");
    // An example and its twin made in the same instant: the later in the list.
    const E = at("e", "example", null, 0);
    const twin = at("t", "stabilized", "e", 0);
    assert.equal(lib.stabilizeOffer({ ...base, model: { id: "e", derived: null }, models: [E, twin] }).child.id, "t");
    // The limits still count the versions made directly from the model.
    assert.equal(lib.stabilizeOffer({ ...base, models: chain }).blocked, null, "one direct version of three");
    // descendantsOf is the same tree: newest first, below the root only, not looping on a broken chain.
    assert.deepEqual(lib.descendantsOf([R, A, Q, B, QA, A2], "r").map((m) => m.id), ["a2", "b", "a"]);
    assert.deepEqual(lib.descendantsOf([R], "r"), []);
    assert.deepEqual(lib.descendantsOf([A, B], "elsewhere"), [], "a chain that does not reach the root is not below it");
    const loopA = at("la", "stabilized", "lb", 1);
    const loopB = at("lb", "stabilized", "la", 2);
    assert.deepEqual(lib.descendantsOf([loopA, loopB], "r"), []);
});

await test("a chain's blocks are named by the run on screen: the offset is the highest step minus the model's own log, and without it every version's steps read as the newest's", () => {
    // generated -> A (steps 1 and 2) -> B (one step): B's blocks are numbered 1..3, its own log has one step.
    const added = [
        { cell: [6, 0, 0], role: "footing", step: 1 },
        { cell: [6, 1, 0], role: "footing", step: 2 },
        { cell: [6, 2, 0], role: "column", step: 3 },
    ];
    const desc = lib.descriptorFromBlocks([...armCells(5).map((cell) => ({ cell })), ...added]);
    const result = lib.analyzeAssembly(desc, null, lib.sanitizeSettings(null));
    const offset = lib.savedStepOffset(result, 1);
    assert.equal(offset, 2, "the steps of the versions before B");
    const block = (n) => result.blocks.find((b) => b.step === n);
    const tip = (n, off) => lib.describeSupport(block(n), result.settings, off).tooltip;
    assert.deepEqual([1, 2, 3].map((n) => tip(n, offset)), ["Footing · added in an earlier version", "Footing · added in an earlier version", "Column · added in step 1"]);
    assert.deepEqual([1, 2, 3].map((n) => lib.addedWhen(n, offset)), ["in an earlier version", "in an earlier version", "in step 1"]);
    // The offset 0 of a viewer that does not know it: A's steps read as B's and B's own block as its third.
    assert.deepEqual([1, 2, 3].map((n) => tip(n, 0)), ["Footing · added in step 1", "Footing · added in step 2", "Column · added in step 3"]);
    // A first stabilization needs no offset, and a model that is not a chain's end is not asked for one.
    assert.equal(lib.savedStepOffset(measured(addedDesc(armCells(5), TIP_COLUMN)), 1), 0);
    assert.equal(lib.savedStepOffset(null, 0), 0);
    assert.equal(lib.savedStepOffset(measured(plainDesc(armCells(5))), 0), 0, "nothing added: no steps");
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
    assert.deepEqual(lib.stepChips(steps[0]), ["problems 2 → 1", "strength used 106% → 72%", "+5"], "only what the move changed, then its size");
    // Balance is said the way the panel's chip says it, on both sides of the arrow: how far inside or outside the base.
    assert.deepEqual(lib.stepChips(stepLog(4, "footing", 6, { before: mt({ cog_margin_mm: -40 }), after: mt({ cog_margin_mm: 25 }) })), ["balance 40 mm outside → 25 mm inside", "+6"]);
    assert.deepEqual(lib.stepChips(stepLog(4, "footing", 6, { before: mt({ cog_margin_mm: 60 }), after: mt({ cog_margin_mm: 110 }) })), ["balance 60 mm inside → 110 mm inside", "+6"]);
    assert.deepEqual(lib.stepChips(stepLog(3, "bridge", 2, { before: mt({ floating_blocks: 16, errors: 0, max_utilisation: null, longest_cantilever: 2 }), after: mt({ floating_blocks: 0, errors: 0, max_utilisation: null, longest_cantilever: 2 }) })), ["floating blocks 16 → 0", "+2"]);
    // The sentence of a step: what was added and why, in the panel's words (the stored text, with coordinates and the engine's terms, stays in the report).
    const sentence = (move, reason, added, before = {}, after = {}) => lib.stepSentence(stepLog(1, move, added, { reason, before: mt(before), after: mt(after) }));
    assert.equal(sentence("column", "cantilever", 4), "Held up an arm that was too long with a 4-block column.");
    // A column that joins a floating part to the ground says so: other figures can get worse before they get better.
    assert.equal(
        sentence("column", "cantilever", 4, { floating_blocks: 6 }, { floating_blocks: 0 }),
        "Held up an arm that was too long with a 4-block column. It also joins the floating part to the ground, so other figures can rise before they fall.",
    );
    assert.equal(sentence("column", "cantilever", 4, { floating_blocks: 6 }, { floating_blocks: 6 }), "Held up an arm that was too long with a 4-block column.");
    assert.equal(sentence("column", "cantilever", 4, { floating_blocks: 0 }, { floating_blocks: 0 }), "Held up an arm that was too long with a 4-block column.");
    // The article follows how the number is said: "an 8-block", "an 11-block", "an 18-block", "an 83-block", but "a 9-block" and "a 12-block".
    for (const [n, article] of [[1, "a"], [3, "a"], [8, "an"], [9, "a"], [11, "an"], [12, "a"], [18, "an"], [19, "a"], [80, "an"], [83, "an"], [89, "an"], [90, "a"], [100, "a"]]) {
        assert.equal(sentence("column", "floating", n), `Held up a floating part with ${article} ${n}-block column.`, `${article} ${n}-block`);
    }
    assert.equal(sentence("column", "floating", 3), "Held up a floating part with a 3-block column.");
    assert.equal(sentence("bridge", "floating", 2), "Joined a floating part to the rest of the model with a 2-block bridge.");
    assert.equal(sentence("footing", "cog", 6, { cog_margin_mm: -40 }), "Widened the base with a 6-block footing so the model no longer tips over.");
    assert.equal(sentence("footing", "cog", 6, { cog_margin_mm: 0.5 }), "Widened the base with a 6-block footing so the model is no longer balanced on the edge.");
    assert.equal(sentence("bracket", "stress", 3), "Held up a joint that was carrying too much with a 3-block bracket.");
    assert.equal(sentence("reinforcement", "stress", 1), "Thickened a joint that was carrying too much with 1 block.");
    for (const move of ["column", "footing", "bracket", "bridge", "reinforcement"]) {
        for (const reason of ["floating", "cantilever", "cog", "stress"]) {
            const text = sentence(move, reason, 2, { cog_margin_mm: -10 });
            assert.deepEqual(lib.technicalWordsIn(text), [], text);
            assert.doesNotMatch(text, /\bx = |\(\d+, \d+, \d+\)|[+-][XY]\b/, `no coordinates or axes: ${text}`);
        }
    }
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
    assert.deepEqual(lib.remainingProblems(after, 0.75, 4), ["an arm of 5 blocks is over the limit of 4", "strength used 90%, aim for under 75%"]);
    // One pair of brackets: the reasons inside them carry none of their own.
    const headline = lib.partialHeadline(after, 0.75, 4);
    assert.equal(headline, "Improved, not fully stable: 1 problem remains (an arm of 5 blocks is over the limit of 4; strength used 90%, aim for under 75%)");
    assert.equal(headline.split("(").length, 2, "no nested brackets");
    assert.equal(lib.partialHeadline({ ...after, errors: 2 }, 0.75, 4).split(" (")[0], "Improved, not fully stable: 2 problems remain");
    assert.deepEqual(lib.remainingProblems({ ...after, over_limit: 0, max_utilisation: 0.5, floating_blocks: 3, cog_margin_mm: -20 }, 0.75, 4), ["3 floating blocks", "it still tips over"]);
    assert.equal(lib.stabilizedLine({ added_blocks: 14, before: { ...after, max_utilisation: 1.8 }, after: { ...after, errors: 0, warnings: 0, max_utilisation: 0.54 } }), "+14 blocks · all checks pass · strength used 180% → 54%");
    assert.equal(lib.stabilizedLine({ added_blocks: 1, before: { ...after, max_utilisation: null }, after: { ...after, errors: 0, warnings: 2, max_utilisation: null } }), "+1 block · 2 warnings");
    assert.equal(lib.savedMessage("a shelf", { added_blocks: 14, complete: true, after }), "Stabilized version of **a shelf**: +14 blocks, passes all checks.");
    assert.equal(lib.savedMessage("a shelf", { added_blocks: 3, complete: false, after }), "Improved version of **a shelf**: +3 blocks, 1 problem left.");
});

await test("answerIsBeforeRun: the answer is the 'before' only while the run holds blocks; a failed run or one with nothing to add leaves the report as it was", () => {
    const states = [
        // [status, errorKind, outcome, expected]
        ["idle", null, null, false],
        ["saved", null, null, false],
        ["running", null, null, true],
        ["saving", null, "complete", true],
        ["saving", null, "partial", true],
        ["finished", null, "complete", true],
        ["finished", null, "partial", true],
        ["finished", null, "nothing", false],
        ["canceled", null, null, true],
        ["error", "save", "partial", true],
        ["error", "save", "complete", true],
        ["error", "run", null, false],
    ];
    for (const [status, errorKind, outcome, expected] of states) {
        assert.equal(lib.answerIsBeforeRun(status, errorKind, outcome), expected, `${status} / ${errorKind} / ${outcome}`);
    }
    // It never says "before" for a state in which no badge speaks of added blocks to keep.
    for (const status of ["idle", "saved"]) assert.equal(lib.runBadge({ status, steps: 0, outcome: null, errorKind: null }), null);
    assert.equal(lib.runBadge({ status: "finished", steps: 1, outcome: "nothing", errorKind: null }).kind, "nothing");
    assert.equal(lib.runBadge({ status: "error", steps: 1, outcome: null, errorKind: "run" }).kind, "failed");
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
    assert.ok(lib.toasts.some((t) => t.kind === "success" && t.title === "Switched to the stabilized version"), "the toast says the viewer moved to it");
    assert.equal(AS().preview, null);
    assert.equal(ST().preview, null);
    // The version that replaces the preview keeps the Added-blocks colouring (spec 4.4): the supports must not turn into blocks that look
    // like the original's the moment the toast says it is shown. It is drawn that way as soon as its analysis lands.
    assert.equal(AS().colorChoice, "role", "the switch picks the Added-blocks colouring");
    AS().runSucceeded(saved.id, measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.equal(AS().view.colorBy, "role", "and the new version's added blocks are painted by what they are");
    AS().runSucceeded(model.id, result);
    assert.equal(AS().view.colorBy, "status", "the original, which has none, falls back to the status colours (the choice itself stays)");
    assert.equal(AS().colorChoice, "role");
    assert.ok(S().revision > 0, "the chat message is an edit the autosave picks up");
    ST().discard();
    assert.equal(ST().status, "idle", "the banner is dismissed");
    assert.equal(ST().endedAt, null, "and forgets when the run ended");
});

await test("a saved version is put on the stage in the tab the user is in; a user who moved to another model is not pulled away", async () => {
    // The tab stays where it is (the Analysis tab, the Models tab, 3D).
    for (const tab of ["analysis", "3d", "models"]) {
        const { pid, model, result } = begin();
        S().setWorkspaceTab(tab);
        const complete = await answerFor(result, [COLUMN_MOVE()]);
        fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: complete });
        assert.equal(ST().start(model, result), true);
        await until(() => ST().status === "saved");
        const saved = S().models.find((m) => m.kind === "stabilized");
        assert.equal(S().activeModelId, saved.id, `${tab}: the new version is the model on the stage`);
        assert.equal(S().workspaceTab, tab, `${tab}: and the tab did not move`);
        assert.deepEqual(lib.toasts.filter((t) => /stabilized version/i.test(t.title)).map((t) => t.title), ["Switched to the stabilized version"]);
        lib.toasts.length = 0;
        ST().discard();
    }
    // The user went to another model of the project while the run was going: it is saved, not shown.
    const { pid, model, result } = begin();
    const other = { ...model, id: crypto.randomUUID(), prompt: "a lamp", glb_url: "/other.glb" };
    S().addModel(other);
    const complete = await answerFor(result, [COLUMN_MOVE()]);
    const hold = {};
    fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: complete, hold });
    assert.equal(ST().start(model, result), true);
    await until(() => ST().steps.length === 1);
    S().setActiveModel(other.id);
    hold.release();
    await until(() => ST().status === "saved");
    const saved = S().models.find((m) => m.kind === "stabilized");
    assert.ok(saved, "the version is in the project");
    assert.equal(S().activeModelId, other.id, "the user keeps looking at the model they chose");
    assert.deepEqual(lib.toasts.filter((t) => /stabilized version/i.test(t.title)).map((t) => t.title), ["Saved a stabilized version"]);
    assert.match(lib.toasts.find((t) => t.title === "Saved a stabilized version").options.description, /Models tab/);
    ST().discard();
    // A user on another VERSION of the same model is on the family: they are moved to the new one.
    lib.toasts.length = 0;
    const r2 = begin();
    const sibling = { ...r2.model, id: crypto.randomUUID(), kind: "stabilized", source_model_id: r2.model.id, derived: { depth: 1 }, glb_url: "/sib.glb" };
    S().addModel(sibling);
    const answer2 = await answerFor(r2.result, [COLUMN_MOVE()]);
    const hold2 = {};
    fakeStabilizer(r2.pid, { moves: [COLUMN_MOVE()], answer: answer2, hold: hold2 });
    assert.equal(ST().start(r2.model, r2.result), true);
    await until(() => ST().steps.length === 1);
    S().setActiveModel(sibling.id);
    hold2.release();
    await until(() => ST().status === "saved");
    const made = S().models.find((m) => m.kind === "stabilized" && m.id !== sibling.id);
    assert.equal(S().activeModelId, made.id, "a version of the same family: still the family the run belongs to");
    ST().discard();
});

await test("a user's own colouring gives way to Added blocks only when the version is switched to; a user who stayed elsewhere keeps theirs", async () => {
    const { pid, model, result } = begin();
    AS().setColorBy("layer");
    const complete = await answerFor(result, [COLUMN_MOVE()]);
    fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: complete });
    assert.equal(ST().start(model, result), true);
    await until(() => ST().status === "saved");
    assert.equal(AS().colorChoice, "role", "switched: the new version is shown by what was added, over the colouring the user had");
    ST().discard();
    // Moved to another model of the project while it ran: the run is only saved, so nothing about the stage changes.
    const second = begin();
    AS().setColorBy("layer");
    const other = { ...second.model, id: crypto.randomUUID(), prompt: "a lamp", glb_url: "/other.glb" };
    S().addModel(other);
    const hold = {};
    fakeStabilizer(second.pid, { moves: [COLUMN_MOVE()], answer: await answerFor(second.result, [COLUMN_MOVE()]), hold });
    assert.equal(ST().start(second.model, second.result), true);
    await until(() => ST().steps.length === 1);
    S().setActiveModel(other.id);
    AS().setColorBy("layer"); // the preview of the run was forcing role; this is the user's own pick afterwards
    hold.release();
    await until(() => ST().status === "saved");
    assert.equal(S().activeModelId, other.id);
    assert.equal(AS().colorChoice, "layer", "not switched: the user's colouring is theirs");
    ST().discard();
});

await test("the end of a saved run is renewed once the new version's analysis lands, so the row that appears takes the focus after a slow load; not for a version that is not shown", async () => {
    const FRESH = 2000;
    const age = () => Date.now() - ST().endedAt;
    // The window counts from the row's appearance: the analysis of a switched-to version needs its file fetched first.
    const { pid, model, result } = begin();
    fakeStabilizer(pid, { moves: [COLUMN_MOVE()], answer: await answerFor(result, [COLUMN_MOVE()]) });
    assert.equal(ST().start(model, result), true);
    await until(() => ST().status === "saved");
    const saved = S().models.find((m) => m.kind === "stabilized");
    assert.equal(S().activeModelId, saved.id);
    assert.ok(age() < FRESH, "stamped at the save");
    lib.useStabilizeStore.setState({ endedAt: Date.now() - 10_000 }); // the fetch took long: the stamp is old by now
    AS().runSucceeded(model.id, result);
    assert.ok(age() >= 10_000, "the analysis of another model is not the row's");
    AS().runSucceeded(saved.id, measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.ok(age() < FRESH, "the new version's analysis landed: its row is on screen now, and the run's end counts from there");
    lib.useStabilizeStore.setState({ endedAt: Date.now() - 10_000 });
    AS().runSucceeded(saved.id, measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.ok(age() >= 10_000, "once: a re-run of the analysis (a settings change) never takes the focus again");
    ST().discard();

    // The user went to look at another model before it landed: the run's end is not renewed for a row they are not looking at.
    const second = begin();
    const other = { ...second.model, id: crypto.randomUUID(), prompt: "a lamp", glb_url: "/other.glb" };
    S().addModel(other);
    fakeStabilizer(second.pid, { moves: [COLUMN_MOVE()], answer: await answerFor(second.result, [COLUMN_MOVE()]) });
    assert.equal(ST().start(second.model, second.result), true);
    await until(() => ST().status === "saved");
    const savedTwo = S().models.find((m) => m.kind === "stabilized");
    assert.equal(S().activeModelId, savedTwo.id);
    S().setActiveModel(other.id);
    lib.useStabilizeStore.setState({ endedAt: Date.now() - 10_000 });
    AS().runSucceeded(savedTwo.id, measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.ok(age() >= 10_000, "moved away first: not renewed");
    ST().discard();

    // A version that was not switched to (the user stayed on another model) is not waited for either.
    const third = begin();
    const elsewhere = { ...third.model, id: crypto.randomUUID(), prompt: "a lamp", glb_url: "/other2.glb" };
    S().addModel(elsewhere);
    const hold = {};
    fakeStabilizer(third.pid, { moves: [COLUMN_MOVE()], answer: await answerFor(third.result, [COLUMN_MOVE()]), hold });
    assert.equal(ST().start(third.model, third.result), true);
    await until(() => ST().steps.length === 1);
    S().setActiveModel(elsewhere.id);
    hold.release();
    await until(() => ST().status === "saved");
    const savedThree = S().models.find((m) => m.kind === "stabilized");
    lib.useStabilizeStore.setState({ endedAt: Date.now() - 10_000 });
    AS().runSucceeded(savedThree.id, measured(addedDesc(armCells(5), TIP_COLUMN)));
    assert.ok(age() >= 10_000, "not switched to: nothing to renew");
    ST().discard();
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

// ---------- a stabilized model shown over the mesh it was made from ----------

/** A project with a generated model and a stabilized version of it (`desc`: its blocks, served as its GLB), the stabilized one active. */
function withSourceAndVersion(desc) {
    resetAnalysis();
    lib.setStabilizeDeps();
    ST().discard();
    const pid = crypto.randomUUID();
    S().setProject(detail(pid));
    const source = { ...modelFor(makeJob(pid)), id: "ov-src", glb_url: "/ov-src.glb", analysis: null };
    const stab = { ...modelFor(makeJob(pid)), id: "ov-stab", provider: "stabilizer", glb_url: "/ov-stab.glb", analysis: null, kind: "stabilized", source_model_id: "ov-src", derived: { depth: 1 } };
    S().addModel(source);
    S().addModel(stab);
    S().setActiveModel("ov-stab");
    fake.files["/ov-stab.glb"] = { bytes: lib.writeAssemblyGlb(desc), hits: 0 };
    return { pid, source: S().models.find((m) => m.id === "ov-src"), stab: S().models.find((m) => m.id === "ov-stab") };
}

await test("the runner shows a stabilized model over the mesh it was made from: its blocks come from its own file, the source's transform places them", async () => {
    const desc = addedDesc(armCells(5), TIP_COLUMN);
    const { source, stab } = withSourceAndVersion(desc);
    // The viewer loads the SOURCE's GLB for the stabilized model; WorkspaceShell may still pass the model's own url.
    const mesh = loadedModel("/ov-src.glb");
    AS().setLoaded(mesh);
    AS().modelChanged("ov-stab", "/ov-stab.glb");
    assert.equal(AS().loaded, mesh, "the handle of the mesh on stage stays");
    let stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().resultModelId === "ov-stab");
    const r = AS().result;
    const T = lib.transformForBounds(lib.soupBoundsOf(CRANE.positions), r.settings);
    assert.deepEqual(r.transform, T, "the source mesh's own transform");
    // Its size is the mesh's scaled box (what the original voxelised from the same mesh reports), not the lattice's extent.
    const box = lib.placementForBounds(lib.soupBoundsOf(CRANE.positions), r.settings).sizeMm;
    assert.deepEqual(r.sizeMm, box);
    assert.deepEqual(r.summary.size_mm, box.map((v) => Math.round(v * 10) / 10), "and so is the saved summary's");
    assert.notDeepEqual(r.sizeMm, lib.analyzeAssembly(desc, null, r.settings).sizeMm, "which is not the lattice's own extent");
    assert.equal(r.blocks.length, desc.cells.length / 5, "the blocks of the stabilized model's file, not a voxelisation of the mesh on stage");
    assert.deepEqual(r.assembly.roleCounts.slice(0, 2), [28, 4]);
    assert.equal(r.assembly.descriptor.cells.length, desc.cells.length);
    assert.ok(r.stress, "the stress estimate came with it");
    assert.equal(fake.files["/ov-stab.glb"].hits, 1);
    // The summary is the stabilized model's, saved under its id.
    await until(() => calls.some((c) => c.method === "PUT"));
    assert.deepEqual(calls.filter((c) => c.method === "PUT").map((c) => c.path), ["/models/ov-stab/analysis"]);
    assert.equal(AS().summaries["ov-stab"].blocks, r.stats.blockCount);
    assert.equal(AS().summaries["ov-src"], undefined);
    assert.equal(S().models.find((m) => m.id === "ov-stab").analysis.blocks, r.stats.blockCount);
    // The original: the same mesh, the same handle, voxelised; it shares the frame the stabilized blocks were placed in.
    S().setActiveModel("ov-src");
    AS().modelChanged("ov-src", "/ov-src.glb");
    assert.equal(AS().loaded, mesh);
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(source));
    await until(() => AS().resultModelId === "ov-src");
    assert.equal(AS().result.assembly, null, "a mesh");
    assert.deepEqual(AS().result.transform, T, "the original's voxelisation and the stabilized model's placement are one frame");
    assert.deepEqual(AS().result.sizeMm, r.sizeMm, "and one size: switching versions does not change how big the model is");
    assert.deepEqual(AS().result.summary.size_mm, r.summary.size_mm);
    assert.notEqual(AS().result.blocks.length, r.blocks.length);
    // Back to the stabilized version: its file is not fetched again, and its result is the cached one.
    S().setActiveModel("ov-stab");
    AS().modelChanged("ov-stab", "/ov-stab.glb");
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(S().models.find((m) => m.id === "ov-stab")));
    await until(() => AS().resultModelId === "ov-stab");
    assert.equal(AS().result, r, "cached for these blocks over this mesh");
    assert.equal(fake.files["/ov-stab.glb"].hits, 1);
    // A setting moves: the blocks are analysed again, over the same mesh.
    AS().updateSettings({ cantileverLimit: 2 });
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(S().models.find((m) => m.id === "ov-stab")));
    await until(() => AS().result.settings.cantileverLimit === 2);
    assert.deepEqual(AS().result.transform, T);
    assert.equal(fake.files["/ov-stab.glb"].hits, 1, "the file is kept");
    stop();
});

await test("a stabilized model whose file cannot be read is an error of its own run; Try again reads it", async () => {
    const desc = addedDesc(armCells(5), TIP_COLUMN);
    const { stab } = withSourceAndVersion(desc);
    delete fake.files["/ov-stab.glb"];
    AS().setLoaded(loadedModel("/ov-src.glb"));
    let stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().run.status === "error");
    assert.equal(AS().run.modelId, "ov-stab");
    assert.match(AS().run.error, /file was not found/);
    assert.equal(AS().result, null);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "nothing is saved for a failed run");
    fake.files["/ov-stab.glb"] = { bytes: lib.writeAssemblyGlb(desc), hits: 0 };
    AS().retry();
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().resultModelId === "ov-stab");
    assert.equal(AS().result.blocks.length, desc.cells.length / 5);
    stop();
});

await test("a stabilized model keeps the handle of the mesh it is shown on; without its source it is shown as its own blocks", () => {
    const desc = addedDesc(armCells(5), TIP_COLUMN);
    withSourceAndVersion(desc);
    AS().setLoaded(stubHandle("/ov-src.glb"));
    AS().modelChanged("ov-stab", "/ov-stab.glb");
    assert.equal(AS().loaded.url, "/ov-src.glb", "the viewer is showing the source");
    AS().setLoaded(stubHandle("/ov-stab.glb"));
    AS().modelChanged("ov-stab", "/ov-stab.glb");
    assert.equal(AS().loaded, null, "the stabilized file's own handle is not what the viewer is about to show");
    AS().setLoaded(stubHandle("/ov-src.glb"));
    AS().modelChanged("ov-src", "/ov-src.glb");
    assert.equal(AS().loaded.url, "/ov-src.glb");
    // The original is gone from the project: the stabilized file is what the viewer shows.
    S().removeModels(["ov-src"]);
    AS().setLoaded(stubHandle("/ov-stab.glb"));
    AS().modelChanged("ov-stab", "/ov-stab.glb");
    assert.equal(AS().loaded.url, "/ov-stab.glb");
    assert.equal(lib.versionFamily(S().models, "ov-stab").display.id, "ov-stab");
});

await test("stabilizing a stabilized model shown over its source: the stabilizer gets its blocks, the preview is in the source's frame, the new version is analysed under its own id", async () => {
    // The stabilized version still has an arm that is too long (7 blocks): a bracket is the next move.
    const desc = addedDesc(armCells(7), [1, 2, 3, 4].map((k) => [7, 1, k]));
    const { pid, stab } = withSourceAndVersion(desc);
    const mesh = loadedModel("/ov-src.glb");
    AS().setLoaded(mesh);
    let stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().resultModelId === "ov-stab");
    const r = AS().result;
    const move = { step: stepLog(1, "bracket", 1), cells: [[3, 1, 4]], roles: ["bracket"] };
    const seen = fakeStabilizer(pid, { moves: [move], answer: await answerFor(r, [move]), hold: {} });
    assert.equal(ST().start(stab, r), true);
    await until(() => AS().preview && AS().preview.result.blocks.length === r.blocks.length + 1);
    assert.deepEqual(seen.input.assembly, r.assembly.descriptor, "its blocks, roles and steps go to the stabilizer");
    assert.equal(seen.input.cells.length, r.blocks.length);
    assert.equal(seen.sourceDepth, 1);
    assert.deepEqual(AS().preview.result.transform, r.transform, "drawn over the mesh on stage with the source's transform");
    assert.equal(AS().preview.modelId, "ov-stab");
    ST().cancel();
    await ST().save();
    assert.equal(ST().status, "saved");
    assert.equal(seen.uploads[0].sourceId, "ov-stab", "the new version is made from the stabilized one");
    const saved = S().models.find((m) => m.id === ST().savedModelId);
    assert.equal(saved.source_model_id, "ov-stab");
    assert.equal(S().activeModelId, saved.id);
    // The family: both versions, the new one first; the viewer keeps showing the original mesh.
    const family = lib.versionFamily(S().models, saved.id);
    assert.equal(family.root.id, "ov-src");
    assert.deepEqual(family.versions.map((m) => m.id), ["ov-stab", saved.id], "oldest first");
    assert.equal(family.display.id, "ov-src");
    // Its file is served by the fake server; the runner reads it and analyses it under its own id, over the same mesh.
    fake.files[saved.glb_url] = { bytes: seen.uploads[0].glb, hits: 0 };
    AS().modelChanged(saved.id, saved.glb_url);
    assert.equal(AS().loaded, mesh, "still the original mesh on stage");
    stop();
    stop = mountHook(() => lib.useAnalysisRunner(saved));
    await until(() => AS().resultModelId === saved.id);
    assert.equal(AS().result.blocks.length, r.blocks.length + 1);
    assert.deepEqual(AS().result.transform, r.transform, "the same frame as the version it was made from");
    assert.equal(AS().result.assembly.roleCounts[2], 0);
    assert.equal(AS().result.blocks.find((b) => b.cell.join() === "3,1,4").role, "bracket");
    assert.ok(AS().summaries[saved.id], "its summary is its own");
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


// ================= versions: the tree, the work guard, edits =================

const asEdited = (base, over = {}) => ({
    ...base, kind: "edited", provider: "editor", source_model_id: over.source ?? null,
    edit: { version: 1, target: over.target ?? "voxel", label: over.label ?? "Shelf", summary: "x", entries: [], changes: null, ops: null, notes: [], stabilized_depth: over.depth ?? 0, depth: 1, base_steps: 0, engine: "", job_id: null, created_at: iso() },
});
const asOptimized = (base, over = {}) => ({
    ...base, kind: "optimized", provider: "optimizer", source_model_id: over.source ?? null,
    optimization: { version: 1, title: "Lightest", goal: "lightest", shape_changed: over.shapeChanged ?? false, stabilized_depth: over.depth ?? 1, before: {}, after: {} },
});

await test("an edit job that ends with a version puts it on screen at once (the Models tab has no stage, so it moves to 3D); a plan with no model leaves the plan on the job", () => {
    const P = crypto.randomUUID();
    const original = { ...modelFor(makeJob(P)), id: "o1" };
    S().setProject(detail(P, { models: [original] }));
    S().setActiveModel("o1");
    S().setWorkspaceTab("models");
    const edit = makeJob(P, { provider: "muse", kind: "edit", edit: { source_model_id: "o1", target: "design", result: null }, status: "running" });
    lib.applyJob(edit);
    const done = { ...edit, status: "succeeded", progress: 100, updated_at: iso(10), model: asEdited({ ...modelFor(edit), id: "e1" }, { source: "o1", target: "design" }) };
    lib.applyJob(done);
    assert.equal(S().activeModelId, "e1", "the change is what the person asked to see");
    assert.equal(S().workspaceTab, "3d");
    assert.ok(S().models.some((m) => m.id === "e1"));
    // From the Stability tab it stays where it is; and a second edit job does not wait for "the first of its prompt".
    S().setWorkspaceTab("analysis");
    const second = makeJob(P, { provider: "muse", kind: "edit", edit: { source_model_id: "e1", target: "design", result: null }, status: "running" });
    lib.applyJob(second);
    lib.applyJob({ ...second, status: "succeeded", updated_at: iso(20), model: asEdited({ ...modelFor(second), id: "e2" }, { source: "e1", target: "design" }) });
    assert.equal(S().activeModelId, "e2");
    assert.equal(S().workspaceTab, "analysis");
    // A plan and no model (a mesh edit whose page was closed): nothing is added, nothing is shown, the plan stays on the job.
    const plan = makeJob(P, { provider: "hunyuan", kind: "edit", edit: { source_model_id: "e2", target: "mesh", result: null }, status: "running" });
    lib.applyJob(plan);
    const result = { target: "mesh", applied: true, summary: "Raise the back.", notes: [] };
    lib.applyJob({ ...plan, status: "succeeded", updated_at: iso(30), edit: { source_model_id: "e2", target: "mesh", result } });
    assert.equal(S().activeModelId, "e2");
    assert.equal(S().models.length, 3);
    assert.deepEqual(S().jobs[plan.id].edit.result, result);
    assert.equal(lib.isTerminalJob(S().jobs[plan.id]), true);
});

await test("a generated model that lands makes the composer edit it again; a person's choice of New lasts until then", () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    S().setComposerChoice("new");
    const job = makeJob(P);
    lib.applyJob(job);
    assert.equal(S().composerChoice, "new", "still running: the choice stands");
    lib.applyJob({ ...job, status: "succeeded", updated_at: iso(10), model: modelFor(job) });
    assert.equal(S().composerChoice, null, "the new model is what the next words are about");
    S().setComposerChoice("new");
    S().startNewChat();
    assert.equal(S().composerChoice, null, "a new chat starts fresh");
    S().setComposerChoice("new");
    S().setProject(detail(crypto.randomUUID()));
    assert.equal(S().composerChoice, null, "so does an opened project");
});

await test("the reply line of a change says how the change went; a generation's is as it was", () => {
    const info = [{ id: "muse", label: "Muse Spark 1.3", available: true }, { id: "hunyuan", label: "Hunyuan 3D 3.1", available: true }];
    const P = "p";
    const edit = (status, extra = {}) => makeJob(P, { provider: "muse", kind: "edit", edit: { source_model_id: "o", target: "design", result: null }, status, ...extra });
    assert.equal(lib.replyLine("Editing with **Muse Spark**.", [edit("running")], info), "Editing with **Muse Spark**.", "while it runs the saved text stands");
    assert.equal(lib.replyLine("x", [edit("succeeded", { model: modelFor({ id: "j", project_id: P, provider: "muse", prompt: "a" }) })], info), "Changed with **Muse Spark 1.3**.");
    assert.equal(lib.replyLine("x", [edit("succeeded", { edit: { source_model_id: "o", target: "mesh", result: { target: "mesh", applied: false, summary: "no", notes: [] } } })], info), "**Muse Spark 1.3** could not make that change.");
    assert.equal(lib.replyLine("x", [edit("succeeded", { edit: { source_model_id: "o", target: "mesh", result: { target: "mesh", applied: true, summary: "ok", notes: [] } } })], info), "**Muse Spark 1.3** planned the change.");
    assert.equal(lib.replyLine("x", [edit("failed")], info), "**Muse Spark 1.3** could not make this change.");
    assert.equal(lib.replyLine("x", [edit("canceled")], info), "Stopped **Muse Spark 1.3**.");
    assert.equal(lib.replyLine("x", [makeJob(P, { status: "failed" })], info), "**Hunyuan 3D 3.1** could not generate this model.");
});

await test("the Stabilize card on an edited or optimized version: the stabilizations on its path count, the caps count versions of every kind, a stabilized child is the one it offers", () => {
    const stats = { blockCount: 28 };
    const base = { model: { id: "r", derived: null }, models: [], result: { stats, stress: null }, verdict: { kind: "fail" }, analysing: false };
    const at = (id, kind, source, ms, extra = {}) => ({ id, kind, source_model_id: source, created_at: iso(ms), derived: null, edit: null, optimization: null, ...extra });
    const R = at("r", "generated", null, 0);
    // A block edit made from a stabilized version carries the count: stabilized twice already, once more is the limit.
    const S1 = at("s1", "stabilized", "r", 10, { derived: { depth: 1 } });
    const E1 = at("e1", "edited", "s1", 20, { edit: { target: "voxel", stabilized_depth: 2 } });
    const E2 = at("e2", "edited", "s1", 25, { edit: { target: "voxel", stabilized_depth: 3 } });
    const O1 = at("o1", "optimized", "s1", 30, { optimization: { shape_changed: false, stabilized_depth: 3 } });
    assert.equal(lib.stabilizeOffer({ ...base, model: E1, models: [R, S1, E1] }).blocked, null, "two of three");
    assert.match(lib.stabilizeOffer({ ...base, model: E2, models: [R, S1, E2] }).blocked, /maximum number of times/);
    assert.match(lib.stabilizeOffer({ ...base, model: O1, models: [R, S1, O1] }).blocked, /maximum number of times/);
    // An original with only an edited version: nothing to open, the button is offered; a stabilized child of the edit is opened, an optimized one is not "ready".
    assert.equal(lib.stabilizeOffer({ ...base, models: [R, E1] }).child, null);
    const SE = at("se", "stabilized", "e1", 40, { derived: { depth: 3 } });
    assert.equal(lib.stabilizeOffer({ ...base, model: E1, models: [R, S1, E1, SE] }).child.id, "se");
    assert.equal(lib.stabilizeOffer({ ...base, models: [R, S1, E1, SE, O1] }).child.id, "se", "the original opens the newest STABILIZED version of the family");
    assert.equal(lib.stabilizeOffer({ ...base, model: S1, models: [R, S1, O1] }).child, null, "an optimized child is the bar's, not this card's");
    // Ten versions of every kind made from one model are the limit, and the project's forty.
    const kids = (n) => Array.from({ length: n }, (_, i) => at(`k${i}`, i % 3 === 0 ? "stabilized" : i % 3 === 1 ? "edited" : "optimized", "r", i));
    assert.match(lib.stabilizeOffer({ ...base, models: [R, ...kids(10)] }).blocked, /10 versions already/);
    assert.equal(lib.stabilizeOffer({ ...base, models: [R, ...kids(9)] }).blocked, null);
    const many = Array.from({ length: 40 }, (_, i) => at(`x${i}`, "edited", `o${i % 7}`, i, { edit: { target: "voxel" } }));
    assert.match(lib.stabilizeOffer({ ...base, models: [R, ...many] }).blocked, /40 versions already/);
    // A chain twelve steps from the original is too deep to build on.
    const chain = [R];
    for (let n = 1; n <= 12; n++) chain.push(at(`c${n}`, "edited", n === 1 ? "r" : `c${n - 1}`, n, { edit: { target: "voxel", stabilized_depth: 0 } }));
    assert.match(lib.stabilizeOffer({ ...base, model: chain[12], models: chain }).blocked, /too many steps/);
    assert.equal(lib.stabilizeOffer({ ...base, model: chain[11], models: chain }).blocked, null);
});

await test("a preview is taken off only by the store that put it on: the stabilizer, a block edit and the optimizer each keep to their own", () => {
    resetAnalysis();
    const preview = lib.analyzeAssembly(lib.descriptorFromBlocks([[0, 0, 0], [1, 0, 0]].map((cell) => ({ cell }))), null, lib.sanitizeSettings(null));
    AS().setPreview("m1", preview);
    assert.equal(AS().preview.owner, "stabilize", "the stabilizer by default");
    AS().setPreview("m1", null, "blocks");
    assert.notEqual(AS().preview, null, "a block edit does not clear the stabilizer's picture");
    AS().setPreview("m1", null, "optimize");
    assert.notEqual(AS().preview, null);
    AS().setPreview("m1", null, "stabilize");
    assert.equal(AS().preview, null);
    AS().setPreview("m1", preview, "blocks");
    assert.deepEqual([AS().preview.owner, AS().preview.modelId], ["blocks", "m1"]);
    AS().setPreview("m1", null);
    assert.notEqual(AS().preview, null, "the default owner is not 'blocks'");
    AS().setPreview("m1", preview, "optimize");
    assert.equal(AS().preview.owner, "optimize", "a new picture replaces whatever was there");
    AS().setPreview("m1", null, "optimize");
    assert.equal(AS().preview, null);
    AS().setPreview("m1", null, "blocks");
    assert.equal(AS().preview, null, "nothing to clear is no change");
});

await test("a stabilizer run takes the work guard and gives it back when it is saved, discarded or has failed; a block edit in the way refuses it", async () => {
    const desc = addedDesc(armCells(5), TIP_COLUMN);
    const { pid, stab } = withSourceAndVersion(desc);
    const mesh = loadedModel("/ov-src.glb");
    AS().setLoaded(mesh);
    const stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().resultModelId === "ov-stab");
    const r = AS().result;
    lib.resetWorkGuard();
    const blocks = lib.acquireWork("blocks", pid);
    assert.equal(ST().start(stab, r), false, "a block edit is in the way");
    assert.equal(ST().status, "idle");
    blocks();
    const move = { step: stepLog(1, "bracket", 1), cells: [[3, 1, 4]], roles: ["bracket"] };
    fakeStabilizer(pid, { moves: [move], answer: await answerFor(r, [move]), hold: {} });
    assert.equal(ST().start(stab, r), true);
    assert.equal(lib.currentWork().kind, "stabilize");
    assert.equal(lib.currentWork().label, "Stabilizing");
    assert.equal(typeof lib.currentWork().stop, "function", "the run chip's Stop");
    assert.equal(lib.workBusyMessage("optimize", pid), "Finish or discard the stabilizing first.");
    await until(() => ST().steps.length === 1);
    ST().cancel();
    assert.equal(lib.currentWork()?.kind, "stabilize", "stopped with a step: it waits for Save or Discard");
    await ST().save();
    assert.equal(ST().status, "saved");
    assert.equal(lib.currentWork(), null, "saved: the work is over");
    // Discard, and a run that fails.
    resetAnalysis();
    lib.resetWorkGuard();
    stop();
});

await test("stabilizing an edited version counts the stabilizations along its path, not its own depth", async () => {
    const desc = addedDesc(armCells(5), TIP_COLUMN);
    const { pid, stab } = withSourceAndVersion(desc);
    AS().setLoaded(loadedModel("/ov-src.glb"));
    const stop = mountHook(() => lib.useAnalysisRunner(stab));
    await until(() => AS().resultModelId === "ov-stab");
    const r = AS().result;
    stop();
    const edited = asEdited({ ...modelFor(makeJob(pid)), id: "ov-edit", glb_url: "/ov-edit.glb", analysis: null }, { source: "ov-stab", depth: 2 });
    S().addModel(edited);
    assert.equal(lib.stabilizationsOfModel(S().models.find((m) => m.id === "ov-edit")), 2);
    const move = { step: stepLog(1, "bracket", 1), cells: [[3, 1, 4]], roles: ["bracket"] };
    const seen = fakeStabilizer(pid, { moves: [move], answer: await answerFor(r, [move]), hold: {} });
    assert.equal(ST().start(S().models.find((m) => m.id === "ov-edit"), r), true);
    await until(() => seen.sourceDepth !== null);
    assert.equal(seen.sourceDepth, 2, "two stabilizations on the way here: the run is the third");
    ST().leave();
    assert.equal(lib.currentWork(), null, "left: the work is over");
});

await test("a block version sits on its mesh unless a block edit made with words changed it: the family's display follows the tree", () => {
    const P = crypto.randomUUID();
    S().setProject(detail(P));
    const root = { ...modelFor(makeJob(P)), id: "r" };
    const s1 = { ...modelFor(makeJob(P)), id: "s1", kind: "stabilized", source_model_id: "r", derived: { depth: 1 } };
    const e1 = asEdited({ ...modelFor(makeJob(P)), id: "e1" }, { source: "s1", depth: 1 });
    const o1 = asOptimized({ ...modelFor(makeJob(P)), id: "o1" }, { source: "s1", shapeChanged: false });
    const o2 = asOptimized({ ...modelFor(makeJob(P)), id: "o2" }, { source: "s1", shapeChanged: true });
    const d1 = asEdited({ ...modelFor(makeJob(P)), id: "d1" }, { source: "r", target: "design" });
    const sd = { ...modelFor(makeJob(P)), id: "sd", kind: "stabilized", source_model_id: "d1", derived: { depth: 1 } };
    for (const m of [root, s1, e1, o1, o2, d1, sd]) S().addModel(m);
    const display = (id) => lib.versionFamily(S().models, id, lib.meshFailures())?.display.id;
    assert.equal(display("s1"), "r", "stabilized: on the original's mesh");
    assert.equal(display("e1"), "e1", "a block edit: its own blocks");
    assert.equal(display("o1"), "r", "an optimization that kept the outside: on the mesh");
    assert.equal(display("o2"), "r", "one that thinned the outside: still on the original mesh (only edits with words leave it)");
    assert.equal(display("d1"), "d1", "a design edit is its own mesh");
    assert.equal(display("sd"), "d1", "the stabilizer worked on the edited mesh");
    assert.equal(lib.versionFamily(S().models, "o1").onSource, true);
    assert.equal(lib.versionFamily(S().models, "o2").onSource, true);
    // A mesh that would not load: the version shows its own blocks until it is tried again.
    lib.markMeshFailed("r");
    assert.equal(display("s1"), "s1");
    assert.equal(display("o1"), "o1");
    lib.clearMeshFailures();
    assert.equal(display("s1"), "r");
    assert.deepEqual(lib.versionFamily(S().models, "o1").versions.map((m) => m.id).sort(), ["d1", "e1", "o1", "o2", "s1", "sd"], "every version below the original");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
