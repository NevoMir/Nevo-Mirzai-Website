// The integration scenario of the edit and optimize work (spec 8.2), end to end with the REAL stores (workspace, edit, block edit, optimizer,
// stabilizer, version tree, work guard, router), the real analysis engine and mesh editor, and a REAL running worker with the offline
// editor (MOCK_PROVIDER=1: every answer of the AI editor is the canned one, nothing is sent to OpenRouter):
//
//   npx wrangler dev --port 8760 --local            # a scratch config whose .dev.vars has MOCK_PROVIDER=1; migrations 0001-0006 applied
//   BASE=http://127.0.0.1:8760 node scripts/assignment/smoke-scenario.mjs
//
//   1  Muse bench -> "make the backrest taller" through the composer's router -> Edited v2, its card, the new design in the file -> Undo
//   2  Hunyuan rocking chair (the local fixture, see edit-test-support.mjs) -> the same words -> the plan -> the editor runs it in this process
//      (28 MB through the real upload) -> v2 -> Stabilize v2 -> v3 (a first run: a mesh source)
//   3  Stability tab on v3 -> "add a shelf" -> proposal -> Apply -> Save (and stabilize) -> v4 (blocks edited) -> v5 stabilized (not a first run, depth 2)
//   4  Optimization on v3 -> a button -> the real optimizer -> Keep -> v6 optimized; the stage shows the mesh when no outside block was taken out;
//      the Stability verdict of the saved file equals the result card
//   5  Delete v2 -> every version made from it goes, on the server and in the bucket
//   7  LIMIT=1 (a server started with DAILY_LLM_LIMIT=2): the 429 of all four tasks, with the sentences the page shows
//
// No browser: React hooks are not run (esbuild bundles the stores like smoke-flows.mjs does). The 28 MB fixture is not part of the repo; without
// it steps 2 to 5 are skipped with a note. Everything it makes is removed at the end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
globalThis.self ??= globalThis; // three's loaders look for `self`

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-scenario-smoke");
mkdirSync(path.join(outDir, "vendor"), { recursive: true });
const wasm = path.join(root, "src/assignment/analysis/fem/vendor/lSolver.wasm");
copyFileSync(wasm, path.join(outDir, "vendor/lSolver.wasm"));
const BASE = (process.env.BASE ?? "http://127.0.0.1:8760").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const EXPLORER = `${BASE}/cdn-cgi/local/explorer/api`;
const BUCKET = "assignment-alex-models";
const LIMIT_MODE = process.env.LIMIT === "1";

const SHIM = `
export const effects = [];
export const useEffect = (fn, deps) => { effects.push({ fn, deps }); };
export const useSyncExternalStore = (_s, get) => get();
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
export const toast = Object.assign(make("message"), { info: make("info"), success: make("success"), warning: make("warning"), error: make("error") });
export const Toaster = () => null;
`;
const ENTRY = `
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/stabilize";
export { deleteVersion } from "@/assignment/store/models";
export { refreshProviders } from "@/assignment/store/providers";
export { useEditStore, setEditDeps, startDesignOrMeshEdit, undoEdit, applyStoredPlan } from "@/assignment/store/edit";
export { cardStateOf } from "@/assignment/store/editLogic";
export { useVoxelEditStore, setVoxelEditDeps } from "@/assignment/store/voxelEdit";
export { useOptimizeStore, setOptimizeDeps } from "@/assignment/store/optimize";
export { submitEdit } from "@/assignment/store/editRouter";
export { applyJob } from "@/assignment/store/jobs";
export { currentWork } from "@/assignment/store/workGuard";
export { stageOf, forestOf, representation, meshBaseOf, versionTitle, stabilizationsOfModel, subtreeIds } from "@/assignment/shared/versionTree";
export { getJob, getProject, createProject, createDerivedModel, bulkProjects, listExamples } from "@/assignment/lib/api";
export { requestOptimizeSpec } from "@/assignment/lib/optimizeApi";
export { requestVoxelEdit } from "@/assignment/lib/voxelEditApi";
export { startEdit } from "@/assignment/lib/editApi";
export { openSession } from "@/assignment/edit/session";
export { runAnalysis, clearAnalysisCache } from "@/assignment/analysis/runAnalysis";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { designFromGlb } from "@/assignment/shared/partsEdit";
export { buildPartsGlb } from "@/assignment/shared/partsGlb";
export { saveNow } from "@/assignment/store/persist";
export { saveSummary } from "@/assignment/store/analysisSave";
export { STRESS_WARN } from "@/assignment/analysis/materials";
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
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                // Vite's ?url import of the WASM: in Node the "URL" is the file path (the solver loader reads it from disk).
                b.onResolve({ filter: /lSolver\.wasm\?url$/ }, () => ({ path: "wasm-url", namespace: "shim" }));
                b.onLoad({ filter: /^wasm-url$/, namespace: "shim" }, () => ({ contents: `export default ${JSON.stringify(wasm)};`, loader: "js" }));
                b.onLoad({ filter: /^react-shim$/, namespace: "shim" }, () => ({ contents: SHIM, loader: "js" }));
                b.onLoad({ filter: /^toast-shim$/, namespace: "shim" }, () => ({ contents: TOAST_SHIM, loader: "js" }));
            },
        },
    ],
});

// ---------- a browser, as far as these modules look ----------
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, String(v)), removeItem: (k) => void storage.delete(k) };
globalThis.sessionStorage = { getItem: (k) => storage.get(`s:${k}`) ?? null, setItem: (k, v) => void storage.set(`s:${k}`, String(v)), removeItem: (k) => void storage.delete(`s:${k}`) };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, init);

const S = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const engine = await import(pathToFileURL(path.join(root, "scripts/assignment/examples/lib/engine.mjs")).href);
const support = await import(pathToFileURL(path.join(root, "scripts/assignment/edit-test-support.mjs")).href);
const { representationOf } = await import(pathToFileURL(path.join(root, "src/assignment/shared/versionMeta.ts")).href);
const { MAX_VERSIONS_PER_SOURCE } = await import(pathToFileURL(path.join(root, "src/assignment/shared/contract.ts")).href);

let passed = 0;
const failures = [];
const notes = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}
const note = (text) => {
    notes.push(text);
    console.log(`  note ${text}`);
};
const section = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms, what) => {
    const t0 = Date.now();
    while (!(await cond())) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
};
const ws = S.useWorkspaceStore;
const an = S.useAnalysisStore;
const st = S.useStabilizeStore;
const jsonHeaders = { "content-type": "application/json" };

// ---------- the local database and bucket (wrangler dev only) ----------
let DB_ID = "";
try {
    DB_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"))?.[1] ?? "";
} catch {
    // no wrangler.jsonc
}
async function sql(statement) {
    try {
        const res = await realFetch(`${EXPLORER}/d1/database/${DB_ID}/raw`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ sql: statement }) });
        const body = await res.json();
        if (!body.success) return null;
        const results = body.result?.[0]?.results;
        if (!results?.columns) return [];
        return results.rows.map((row) => Object.fromEntries(results.columns.map((c, i) => [c, row[i]])));
    } catch {
        return null;
    }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
async function putObject(key, bytes) {
    try {
        const res = await realFetch(`${EXPLORER}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
        return res.ok;
    } catch {
        return false;
    }
}
async function hasObject(key) {
    const res = await realFetch(`${EXPLORER}/r2/buckets/${BUCKET}/objects?prefix=${encodeURIComponent(key)}&limit=10`);
    const body = await res.json();
    const items = body.result?.objects ?? body.result ?? body.objects ?? [];
    return items.some((o) => (o.key ?? o.name) === key);
}
async function seedModel(projectId, { provider, glb, prompt, partCount }) {
    const id = crypto.randomUUID();
    const key = `models/${id}.glb`;
    if (!(await putObject(key, glb))) return null;
    const row = await sql(
        `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind)
         VALUES (${q(id)}, ${q(projectId)}, ${q(crypto.randomUUID())}, ${q(provider)}, ${q(prompt)}, ${q(key)}, ${glb.byteLength}, ${partCount}, ${q(new Date().toISOString())}, 'generated')`,
    );
    return row === null ? null : id;
}

const BENCH = {
    name: "Wooden Garden Bench",
    parts: [
        ["rear leg left", [60, 60, 900], [-400, -190, 450], "#6e4a2a"],
        ["rear leg right", [60, 60, 900], [400, -190, 450], "#6e4a2a"],
        ["front leg left", [60, 60, 450], [-400, 190, 225], "#6e4a2a"],
        ["front leg right", [60, 60, 450], [400, 190, 225], "#6e4a2a"],
        ["seat", [900, 460, 40], [0, 0, 460], "#8f6238"],
        ["backrest", [900, 25, 300], [0, -232.5, 650], "#8f6238"],
    ].map(([name, size, position, color]) => ({ name, shape: "box", size, position, rotation: [0, 0, 0], color })),
};

/** The workspace opens a project the way the page does. */
async function openProject(id) {
    ws.getState().startNewChat();
    S.clearAnalysisCache();
    an.getState().modelChanged(null, null);
    ws.getState().setProject(await S.getProject(id));
    await S.refreshProviders();
}
/** What the analysis runner does for the model in the viewer: its triangles (or its blocks) -> runAnalysis -> store -> the summary saved with the model. */
async function analyseLikeTheRunner(model) {
    const bytes = new Uint8Array(await (await fetch(model.glb_url)).arrayBuffer());
    const read = S.readAssemblyGlb(bytes, null);
    const assembly = read && read.descriptor ? read.descriptor : null;
    const { soup } = assembly ? { soup: { positions: new Float32Array(0) } } : await engine.loadSoupLikeTheApp(bytes);
    an.getState().runStarted(model.id);
    const result = await S.runAnalysis(() => soup, an.getState().settings, { cacheKey: model.glb_url, assembly });
    an.getState().runSucceeded(model.id, result);
    return { result, assembly, bytes };
}
/** The page's polling loop, for the jobs of the open project. */
async function pollEdit(jobId, ms = 60_000) {
    await until(async () => {
        const job = await S.getJob(jobId);
        S.applyJob(job);
        return ["succeeded", "failed", "canceled"].includes(job.status);
    }, ms, `job ${jobId}`);
    return ws.getState().jobs[jobId];
}
const cleanup = [];
const toastTitles = () => S.toasts.map((t) => t.title);
const api = async (method, p, body, headers = {}) => {
    const res = await realFetch(`${API}${p}`, { method, headers: { ...(body === undefined ? {} : jsonHeaders), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null;
    try {
        json = await res.json();
    } catch {
        // not JSON
    }
    return { status: res.status, json };
};

console.log(`Scenario against ${BASE}${LIMIT_MODE ? " (LIMIT=1: the daily-limit run)" : ""}`);
if (!DB_ID || (await sql("SELECT 1 AS ok")) === null) {
    console.log("The local explorer API (D1 SQL, R2 PUT) is not reachable: this scenario needs wrangler dev --local.");
    process.exit(2);
}

if (!LIMIT_MODE) {
    // ====================================================================================================================================
    section("step 1: a Muse bench -> \"make the backrest taller\" -> Edited v2 -> Undo");
    let projectA, bench, v2;
    await test("the composer's router sends the words to the design editor and the job makes a new version", async () => {
        const created = await api("POST", "/projects", { name: "scenario muse" });
        projectA = created.json.project.id;
        cleanup.push(projectA);
        const glb = S.buildPartsGlb(BENCH);
        const benchId = await seedModel(projectA, { provider: "muse", glb, prompt: "a wooden garden bench", partCount: BENCH.parts.length });
        assert.ok(benchId, "seeded the bench");
        await openProject(projectA);
        bench = ws.getState().models.find((m) => m.id === benchId);
        assert.ok(bench);
        ws.getState().setActiveModel(bench.id);
        ws.getState().setWorkspaceTab("3d");
        assert.ok(ws.getState().providers?.assist?.available, "the editor is available");
        const out = await S.submitEdit("make the backrest taller");
        assert.deepEqual(out, { ok: true });
        const first = ws.getState().messages;
        assert.equal(first[0].role, "user");
        assert.equal(first[0].content, "make the backrest taller");
        const reply = first.find((m) => m.role === "assistant" && m.job_ids?.length === 1);
        assert.ok(reply, "the assistant's message points at the job");
        const job = await pollEdit(reply.job_ids[0]);
        assert.equal(job.status, "succeeded", job.error ?? "");
        assert.equal(job.kind, "edit");
        v2 = ws.getState().models.find((m) => m.kind === "edited");
        assert.ok(v2, "the new version is in the project");
        assert.equal(v2.source_model_id, bench.id);
        assert.equal(v2.edit.target, "design");
        assert.equal(v2.provider, "muse", "still a Muse model");
        assert.equal(ws.getState().activeModelId, v2.id, "the edit is on the stage");
        assert.equal(S.stageOf(ws.getState().models, v2).display.id, v2.id, "an edited design shows its own mesh");
        assert.match(S.versionTitle(ws.getState().models, v2), /v2/);
    });
    await test("the card reads the job: done, with the model's sentence and the changed parts; the file carries the new design", async () => {
        const job = Object.values(ws.getState().jobs).find((j) => j.kind === "edit");
        const state = S.cardStateOf({ job, run: undefined, models: ws.getState().models, undone: {} });
        assert.equal(state.kind, "done");
        assert.ok(state.summary.length > 0);
        assert.equal(state.source.id, bench.id);
        const bytes = new Uint8Array(await (await fetch(v2.glb_url)).arrayBuffer());
        const design = S.designFromGlb(bytes);
        assert.ok(design && design.parts.length === BENCH.parts.length, "the design is recovered from the new file");
        // the version is on the server, with its record
        const fresh = await S.getProject(projectA);
        const stored = fresh.models.find((m) => m.id === v2.id);
        assert.equal(stored.edit.target, "design");
        assert.equal(stored.edit.depth, 1);
        assert.ok(stored.edit.entries.length === 1);
        assert.equal(fresh.jobs.find((j) => j.kind === "edit").model?.id, v2.id);
    });
    await test("Undo deletes the version, the viewer goes back to the bench, and the card says Undone (then 'Version deleted' after a reload)", async () => {
        const out = await S.undoEdit(v2);
        assert.equal(out, "undone");
        assert.deepEqual(ws.getState().models.map((m) => m.id), [bench.id]);
        assert.equal(ws.getState().activeModelId, bench.id);
        const fresh = await S.getProject(projectA);
        assert.equal(fresh.models.length, 1, "gone from the server");
        assert.ok(!(await hasObject(`models/${v2.id}.glb`)), "its file is gone from the bucket");
        const job = Object.values(ws.getState().jobs).find((j) => j.kind === "edit");
        assert.equal(S.cardStateOf({ job, run: undefined, models: ws.getState().models, undone: { [v2.id]: true } }).kind, "undone");
        // a reload: the job has no model any more and no stored result is sent with it
        const reloadedJob = fresh.jobs.find((j) => j.kind === "edit");
        assert.equal(reloadedJob.model, null);
        assert.equal(reloadedJob.edit.result, null, "a finished job that made a version does not carry its result");
        assert.equal(S.cardStateOf({ job: reloadedJob, run: undefined, models: fresh.models, undone: {} }).kind, "gone");
    });
    await test("an edit that changes nothing keeps its reason after a reload (a design edit with no model carries its result)", async () => {
        // The offline editor repaints every part; asking for the colour the bench already has changes nothing is not what the mock does, so a
        // job row is written the way the consumer writes a "nothing changed" end and read back through the project payload.
        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();
        const plan = JSON.stringify({ target: "design", applied: false, summary: "That is not about this object.", notes: ["nothing to change"] });
        const wrote = await sql(
            `INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, created_at, updated_at, finished_at, kind, source_model_id, edit_target, plan)
             VALUES (${q(jobId)}, ${q(projectA)}, 'muse', 'openrouter', 'sing', 'succeeded', 100, ${q(now)}, ${q(now)}, ${q(now)}, 'edit', ${q(bench.id)}, 'design', ${q(plan)})`,
        );
        assert.notEqual(wrote, null, "seeded the job row");
        const fresh = await S.getProject(projectA);
        const job = fresh.jobs.find((j) => j.id === jobId);
        assert.equal(job.model, null);
        assert.equal(job.edit.result?.applied, false, "the reason survives a reload");
        const card = S.cardStateOf({ job, run: undefined, models: fresh.models, undone: {} });
        assert.equal(card.kind, "noop");
        assert.match(card.summary, /not about this object/);
    });

    // ====================================================================================================================================
    if (!support.hasHunyuan()) {
        note(`the Hunyuan fixture is not at ${support.HUNYUAN_GLB}: steps 2 to 5 are skipped`);
    } else {
        section("step 2: the Hunyuan rocking chair -> the same words -> plan -> run here -> upload (28 MB) -> v2 -> Stabilize -> v3");
        const codec = await support.sharpCodec();
        let projectB, chair, meshV2, v3;
        S.setEditDeps({
            // The browser opens the file in a worker (or on the page); here the same session code runs in this process with sharp for the picture.
            openMeshEdit: async (bytes, options) => {
                const session = await S.openSession(new Uint8Array(bytes), codec, options.originalPrompt ?? null);
                return {
                    info: session.info,
                    inWorker: false,
                    describe: (format = "png", signal, size) => session.describe(format, size),
                    zoom: (program, format = "png") => session.zoom(program, format),
                    run: (o) => session.run(o),
                    dispose: () => undefined,
                };
            },
            pictureFormat: () => "png",
        });
        await test("the plan comes back from the queue, the editor applies it to the real file and the 28 MB result is stored as v2", async () => {
            const created = await api("POST", "/projects", { name: "scenario hunyuan" });
            projectB = created.json.project.id;
            cleanup.push(projectB);
            const chairId = await seedModel(projectB, { provider: "hunyuan", glb: support.readHunyuan(), prompt: "a wooden rocking chair", partCount: 1 });
            assert.ok(chairId, "seeded the chair");
            await openProject(projectB);
            chair = ws.getState().models.find((m) => m.id === chairId);
            ws.getState().setActiveModel(chair.id);
            ws.getState().setWorkspaceTab("3d");
            const t0 = Date.now();
            const out = await S.submitEdit("make the backrest taller");
            assert.deepEqual(out, { ok: true });
            const reply = ws.getState().messages.find((m) => m.role === "assistant" && m.job_ids?.length === 1);
            assert.ok(reply, "the reply points at the plan's job");
            const jobId = reply.job_ids[0];
            // the page's polling loop feeds the edit store, which runs the plan when the job is done
            await until(async () => {
                const job = await S.getJob(jobId);
                S.applyJob(job);
                const run = S.useEditStore.getState().runs[jobId];
                return Boolean(run && (run.status === "saved" || run.status === "error" || run.status === "noop"));
            }, 180_000, "the edit to be applied and saved");
            const run = S.useEditStore.getState().runs[jobId];
            assert.equal(run.status, "saved", `${run.status}: ${run.error ?? ""}`);
            meshV2 = ws.getState().models.find((m) => m.id === run.savedModelId);
            assert.ok(meshV2, "the model is in the project");
            assert.equal(meshV2.kind, "edited");
            assert.equal(meshV2.edit.target, "mesh");
            assert.equal(meshV2.source_model_id, chair.id);
            assert.equal(meshV2.provider, "hunyuan", "still a Hunyuan model");
            assert.ok(meshV2.size_bytes > 10 * 1024 * 1024, `a large file (${meshV2.size_bytes})`);
            assert.equal(ws.getState().activeModelId, meshV2.id);
            note(`the mesh edit took ${((Date.now() - t0) / 1000).toFixed(1)} s end to end (pictures, plan, run, ${(meshV2.size_bytes / 1048576).toFixed(1)} MB upload)`);
            const state = S.cardStateOf({ job: ws.getState().jobs[jobId], run, models: ws.getState().models, undone: {} });
            assert.equal(state.kind, "done");
            const stored = (await S.getProject(projectB)).models.find((m) => m.id === meshV2.id);
            assert.equal(stored.edit.target, "mesh");
            assert.equal(stored.edit.job_id, jobId);
            assert.ok(stored.edit.ops && stored.edit.ops.length >= 1, "the record names what was done");
        });
        await test("Stabilize v2: the model is a mesh source, so the first stabilization is accepted (v3)", async () => {
            an.getState().modelChanged(meshV2.id, meshV2.glb_url);
            const { result } = await analyseLikeTheRunner(meshV2);
            assert.ok(result.summary.errors > 0, `the chair has problems (${result.summary.errors} errors)`);
            assert.equal(st.getState().start(meshV2, result), true);
            await until(() => ["saved", "error", "canceled"].includes(st.getState().status), 180_000, "the stabilizer");
            const s = st.getState();
            assert.equal(s.status, "saved", `${s.status} ${s.error ?? ""}`);
            v3 = ws.getState().models.find((m) => m.id === s.savedModelId);
            assert.equal(v3.kind, "stabilized");
            assert.equal(v3.source_model_id, meshV2.id);
            assert.equal(v3.derived.depth, 1);
            assert.equal(representationOf(v3), "blocks");
            assert.equal(S.stabilizationsOfModel(v3), 1);
            assert.equal(S.stageOf(ws.getState().models, v3).display.id, meshV2.id, "the blocks sit on the edited mesh");
        });

        // ================================================================================================================================
        section("step 3: Stability tab on v3 -> \"add a shelf\" -> proposal -> Apply -> Save -> v4 -> Stabilize -> v5");
        let v4, v5;
        await test("the words go to the block editor through the router; the proposal comes back with the change of verdict", async () => {
            ws.getState().setActiveModel(v3.id);
            ws.getState().setWorkspaceTab("analysis");
            an.getState().modelChanged(v3.id, v3.glb_url);
            await analyseLikeTheRunner(v3);
            const out = await S.submitEdit("add a shelf under the seat");
            assert.deepEqual(out, { ok: true });
            const e = S.useVoxelEditStore.getState();
            assert.equal(e.status, "proposal", `${e.status} ${JSON.stringify(e.notice)}`);
            assert.ok(e.proposal.added > 0, "blocks were added");
            assert.match(e.proposal.change.text, /./);
            assert.ok(S.currentWork()?.kind === "blocks", "the work guard is held while the proposal waits");
            assert.equal(S.currentWork()?.waiting, true, "... and says it waits for a decision (the Draft chip)");
            assert.equal(an.getState().preview?.owner ?? "blocks", "blocks");
            // The router wrote the person's words; the editor wrote its sentence.
            const texts = ws.getState().messages.map((m) => `${m.role}: ${m.content}`);
            assert.ok(texts.some((t) => t === "user: add a shelf under the seat"), texts.join(" | "));
            assert.ok(texts.some((t) => t.startsWith("assistant:") && /proposal is on the Stability tab/.test(t)), texts.join(" | "));
        });
        await test("Apply puts it in the draft, Save writes ONE version (a block version made by the editor), and the stage shows it", async () => {
            S.useVoxelEditStore.getState().apply();
            let e = S.useVoxelEditStore.getState();
            assert.equal(e.draft?.count, 1);
            assert.equal(S.currentWork()?.waiting, true);
            await S.useVoxelEditStore.getState().save();
            e = S.useVoxelEditStore.getState();
            assert.equal(e.status, "idle", `${e.status} ${e.error ?? ""}`);
            assert.equal(S.currentWork(), null, "the guard is free again");
            v4 = ws.getState().models.find((m) => m.kind === "edited" && m.edit?.target === "voxel");
            assert.ok(v4, "v4 is in the project");
            assert.equal(v4.source_model_id, v3.id);
            assert.equal(v4.provider, "editor");
            assert.equal(v4.edit.stabilized_depth, 1);
            assert.equal(v4.edit.depth, 3, "made from v3, which is two below the root");
            assert.equal(ws.getState().activeModelId, v4.id);
            assert.equal(S.representation(v4), "blocks");
            assert.equal(S.stageOf(ws.getState().models, v4).display.id, v4.id, "a block edit never sits on the mesh any more");
            const stored = (await S.getProject(projectB)).models.find((m) => m.id === v4.id);
            assert.equal(stored.edit.target, "voxel");
            assert.ok(stored.analysis, "the summary is saved with the version");
            assert.ok(S.toasts.some((t) => /new version/.test(t.title)));
        });
        await test("the person asked to stabilize after saving: v4 stabilized is v5, not a first run, depth 2", async () => {
            // The shelf the offline editor adds stands on the chair, so v4 may not need anything. Make it need something: one more change, made
            // the way a model's answer would (a layer taken out of the middle), then stabilize that.
            an.getState().modelChanged(v4.id, v4.glb_url);
            const { result: before } = await analyseLikeTheRunner(v4);
            note(`v4 (shelf added) checks: ${before.summary.errors} errors, ${before.summary.warnings} warnings, ${before.summary.blocks} blocks`);
            S.setVoxelEditDeps({
                ask: async () => ({
                    answer: { summary: "Cut the chair in two.", notes: "", clarification: "", ops: [{ op: "remove", region: "all", box: [0, 0, 3, 9, 9, 3], dirs: [], amount: 0, axis: "i", at: 0, offset: [0, 0, 0], plane: 0, wall: 1, include_added: true }] },
                    model: "scenario/answer", cost_usd: null, prompt_tokens: null, completion_tokens: null, ms: 1,
                }),
            });
            try {
                const out = await S.submitEdit("cut a gap in the middle");
                assert.deepEqual(out, { ok: true });
            } finally {
                S.setVoxelEditDeps();
            }
            let e = S.useVoxelEditStore.getState();
            assert.equal(e.status, "proposal", `${e.status} ${JSON.stringify(e.notice)}`);
            assert.ok(e.proposal.removed > 0);
            S.useVoxelEditStore.getState().apply();
            S.useVoxelEditStore.getState().setStabilizeAfter(true);
            // the page's runner analyses the version the moment it is on the stage; the store then starts the stabilizer
            const watcher = (async () => {
                await until(() => ws.getState().models.some((m) => m.kind === "edited" && m.source_model_id === v4.id), 30_000, "the second block version");
                const next = ws.getState().models.find((m) => m.kind === "edited" && m.source_model_id === v4.id);
                an.getState().modelChanged(next.id, next.glb_url);
                await analyseLikeTheRunner(next);
            })();
            await S.useVoxelEditStore.getState().save();
            await watcher;
            const v4b = ws.getState().models.find((m) => m.kind === "edited" && m.source_model_id === v4.id);
            assert.ok(v4b, "the second block version was saved");
            assert.equal(v4b.edit.stabilized_depth, 1);
            assert.equal(v4b.edit.depth, 4);
            await until(() => st.getState().sourceModelId === v4b.id && ["saved", "error", "canceled", "finished"].includes(st.getState().status), 180_000, "the stabilizer on the edited version");
            const s = st.getState();
            assert.equal(s.status, "saved", `${s.status} ${s.error ?? ""}`);
            v5 = ws.getState().models.find((m) => m.id === s.savedModelId);
            assert.equal(v5.kind, "stabilized");
            assert.equal(v5.source_model_id, v4b.id);
            assert.equal(v5.derived.depth, 2, "the second stabilization on the chain");
            assert.equal(S.stabilizationsOfModel(v5), 2);
            assert.ok(v5.derived.added_blocks > 0, "it added supports");
            // The steps of the blocks that were there before are kept (a first run would have started from step 0).
            const bytes = new Uint8Array(await (await fetch(v5.glb_url)).arrayBuffer());
            const read = S.readAssemblyGlb(bytes, null);
            assert.ok(read.ok && read.meta);
            assert.equal(read.meta.depth, 2);
            const roles = new Set();
            for (let n = 0; n < read.descriptor.cells.length; n += 5) roles.add(read.descriptor.cells[n + 3]);
            assert.ok(roles.has(6), "the person's own blocks (role 'user') are still there");
            assert.ok([...roles].some((r) => r >= 1 && r <= 5), "... next to what the stabilizer added");
        });

        await test("the ORIGINAL mesh (an unstable block version) is edited too: the log's 'before' agrees with the summary the server holds for it", async () => {
            // As the page does: the analysis of the mesh, its summary saved with the model, then the words on the Stability tab.
            ws.getState().setActiveModel(chair.id);
            ws.getState().setWorkspaceTab("analysis");
            an.getState().modelChanged(chair.id, chair.glb_url);
            const { result } = await analyseLikeTheRunner(chair);
            await S.saveSummary(chair.id, an.getState().settings, result.summary);
            const stored = (await S.getProject(projectB)).models.find((m) => m.id === chair.id);
            assert.equal(stored.analysis.blocks, result.summary.blocks, "the server holds the mesh's summary");
            const out = await S.submitEdit("add a shelf under the seat");
            assert.deepEqual(out, { ok: true });
            assert.equal(S.useVoxelEditStore.getState().status, "proposal", JSON.stringify(S.useVoxelEditStore.getState().notice));
            S.useVoxelEditStore.getState().apply();
            await S.useVoxelEditStore.getState().save();
            const e = S.useVoxelEditStore.getState();
            assert.equal(e.status, "idle", `${e.status}: ${e.error ?? ""}`);
            const v = ws.getState().models.find((m) => m.kind === "edited" && m.edit?.target === "voxel" && m.source_model_id === chair.id);
            assert.ok(v, "saved on the original mesh");
            assert.equal(v.edit.base_steps, 0, "a mesh has no steps of its own");
            assert.equal(v.edit.stabilized_depth, 0);
            assert.equal(v.edit.depth, 1);
            assert.equal(S.stageOf(ws.getState().models, v).display.id, v.id, "block edits show their own blocks");
            ws.getState().setActiveModel(chair.id);
        });

        // ================================================================================================================================
        section("step 4: Optimization on v3 -> a button -> run -> result -> Keep -> v6 optimized");
        let v6, resultCard;
        await test("a button fills the controls without a network call; the run goes through the real optimizer", async () => {
            const O = S.useOptimizeStore;
            O.getState().leave();
            ws.getState().setActiveModel(v3.id);
            ws.getState().setWorkspaceTab("optimize");
            an.getState().modelChanged(v3.id, v3.glb_url);
            const { result } = await analyseLikeTheRunner(v3);
            const calls = [];
            const watch = (url) => calls.push(String(url));
            const wrapped = globalThis.fetch;
            globalThis.fetch = (url, init) => (watch(url), wrapped(url, init));
            try {
                await O.getState().chooseChip(v3, result, "lightest");
            } finally {
                globalThis.fetch = wrapped;
            }
            assert.equal(O.getState().phase, "ready", `${O.getState().phase} ${O.getState().notice ?? ""}`);
            assert.ok(!calls.some((u) => u.includes("/llm/")), `no AI call for a button: ${calls.join(",")}`);
            O.getState().setEffort("quick");
            O.getState().run();
            await until(() => ["result", "error"].includes(O.getState().phase), 180_000, "the optimizer");
            const o = O.getState();
            assert.equal(o.phase, "result", `${o.phase} ${o.error ?? ""}`);
            resultCard = o.result;
            assert.ok(resultCard.result.feasible, "a result that can be kept");
            note(`lightest: ${resultCard.meta.before.blocks} -> ${resultCard.meta.after.blocks} blocks, stop "${resultCard.meta.stop}", ${resultCard.meta.history.length} history rows, ${resultCard.meta.solves} solves, ${(resultCard.meta.duration_ms / 1000).toFixed(1)} s, changed=${resultCard.changed}`);
        });
        await test("Keep this version saves an optimized version (kind optimized, provider optimizer); its stage rule follows shape_changed", async () => {
            const O = S.useOptimizeStore;
            if (!resultCard.changed) {
                // Nothing to keep for a chair that is already as light as this goal allows: the other direction makes a change to keep.
                note("lightest changed nothing on this model (the result card says so and offers no save): trying the 'most stable' button");
                O.getState().discard();
                const { result } = await analyseLikeTheRunner(v3);
                await O.getState().chooseChip(v3, result, "most-stable");
                O.getState().setEffort("quick");
                O.getState().run();
                await until(() => ["result", "error"].includes(O.getState().phase), 180_000, "the optimizer");
                resultCard = O.getState().result;
                assert.ok(resultCard.changed, "most stable changes the model");
            }
            await O.getState().keep();
            const o = O.getState();
            assert.equal(o.phase, "saved", `${o.phase} ${o.error ?? ""}`);
            v6 = ws.getState().models.find((m) => m.id === o.savedModelId);
            assert.equal(v6.kind, "optimized");
            assert.equal(v6.provider, "optimizer");
            assert.equal(v6.source_model_id, v3.id);
            assert.equal(v6.optimization.shape_changed, false, "the outside of the chair is as it was");
            assert.equal(v6.optimization.stabilized_depth, 1);
            assert.equal(ws.getState().activeModelId, v6.id);
            const stage = S.stageOf(ws.getState().models, v6);
            assert.equal(stage.display.id, meshV2.id, "shape_changed=false: the blocks sit on the edited mesh (the 3D tab shows the chair)");
            assert.equal(S.meshBaseOf(ws.getState().models, v6)?.id, meshV2.id);
            const stored = (await S.getProject(projectB)).models.find((m) => m.id === v6.id);
            assert.equal(stored.optimization.after.blocks, resultCard.meta.after.blocks);
        });
        await test("an optimization that may take out any block changes the outside: shape_changed is true and the stage shows its own blocks, not the mesh", async () => {
            const O = S.useOptimizeStore;
            ws.getState().setActiveModel(v3.id);
            an.getState().modelChanged(v3.id, v3.glb_url);
            const { result } = await analyseLikeTheRunner(v3);
            await O.getState().chooseChip(v3, result, "lightest");
            O.getState().editSpec((spec) => ({ ...spec, moves: { ...spec.moves, removable: "any" }, constraints: { ...spec.constraints, min_blocks_pct: 80 } }));
            O.getState().setEffort("quick");
            O.getState().run();
            await until(() => ["result", "error"].includes(O.getState().phase), 180_000, "the optimizer");
            assert.equal(O.getState().phase, "result", `${O.getState().phase} ${O.getState().error ?? ""}`);
            const card = O.getState().result;
            assert.ok(card.changed && card.result.feasible);
            note(`any block: ${card.meta.before.blocks} -> ${card.meta.after.blocks} blocks (floor 80%), shape_changed=${card.meta.shape_changed}`);
            await O.getState().keep();
            assert.equal(O.getState().phase, "saved", `${O.getState().phase} ${O.getState().error ?? ""}`);
            const v7 = ws.getState().models.find((m) => m.id === O.getState().savedModelId);
            assert.equal(v7.kind, "optimized");
            assert.equal(v7.optimization.shape_changed, true);
            assert.equal(S.meshBaseOf(ws.getState().models, v7), null, "no mesh describes these blocks any more");
            assert.equal(S.stageOf(ws.getState().models, v7).display.id, v7.id, "the 3D tab shows the blocks themselves");
            ws.getState().setActiveModel(v6.id);
        });
        await test("the Stability tab on the saved version says what the result card said", async () => {
            an.getState().modelChanged(v6.id, v6.glb_url);
            const { result } = await analyseLikeTheRunner(v6);
            const card = resultCard.meta.after;
            assert.equal(result.summary.blocks, card.blocks);
            assert.equal(result.summary.errors, card.errors);
            assert.equal(result.summary.warnings, card.warnings);
            assert.equal(result.summary.errors, 0);
            assert.ok(result.summary.stress.max_utilisation <= S.STRESS_WARN + 1e-9);
        });

        // ================================================================================================================================
        section("step 6: the page is closed after the plan came back -> after a reload the card offers \"Plan ready, apply?\" -> Apply");
        await test("a plan nobody applied is offered again after a reload; Apply runs it on the file and stores the version", async () => {
            // The page made the pictures and started the plan; then the tab was closed (nothing ran here).
            const session = await S.openSession(new Uint8Array(await (await fetch(chair.glb_url)).arrayBuffer()), codec, chair.prompt);
            const pkg = await session.describe("png");
            const job = await S.startEdit(chair.id, { instruction: "make the seat darker", target: "mesh", mesh: pkg });
            await until(async () => ["succeeded", "failed"].includes((await S.getJob(job.id)).status), 60_000, "the plan");
            assert.equal((await S.getJob(job.id)).status, "succeeded");
            // a reload: nothing of the earlier page is left
            S.useEditStore.setState({ runs: {}, undone: {} });
            await openProject(projectB);
            const reloaded = ws.getState().jobs[job.id];
            assert.ok(reloaded, "the job comes back with the project");
            assert.equal(reloaded.model, null);
            assert.equal(reloaded.edit.result?.applied, true, "the plan is carried with a job that has no model");
            const card = S.cardStateOf({ job: reloaded, run: undefined, models: ws.getState().models, undone: {} });
            assert.equal(card.kind, "plan-ready");
            await S.applyStoredPlan(job.id);
            await until(() => ["saved", "error"].includes(S.useEditStore.getState().runs[job.id]?.status), 120_000, "the plan to be applied and saved");
            const run = S.useEditStore.getState().runs[job.id];
            assert.equal(run.status, "saved", `${run.status}: ${run.error ?? ""}`);
            const made = ws.getState().models.find((m) => m.id === run.savedModelId);
            assert.equal(made.kind, "edited");
            assert.equal(made.edit.job_id, job.id);
            const after = (await S.getProject(projectB)).jobs.find((j) => j.id === job.id);
            assert.equal(after.model?.id, made.id, "the job points at the version it made");
            assert.equal(after.edit.result, null, "... and no longer carries the plan");
            // sending the file again is the same version (the upload is idempotent per job; the answer comes before the body is read, so a small body will do)
            const again = await realFetch(`${API}/models/${chair.id}/edited?job=${job.id}`, { method: "POST", headers: { "content-type": "model/gltf-binary" }, body: new Uint8Array(100) });
            assert.equal(again.status, 200);
            assert.equal((await again.json()).model.id, made.id);
        });

        // ================================================================================================================================
        section("step 5: delete v2 -> every version made from it goes, on the server and in the bucket");
        await test("deleting the edited mesh removes v3, v4, v5, v6 (and the blocks edited in between) with their files", async () => {
            const family = S.subtreeIds(ws.getState().models, meshV2.id);
            assert.ok(family.length >= 5, `the family is ${family.length} versions`);
            const keys = ws.getState().models.filter((m) => family.includes(m.id)).map((m) => new URL(m.glb_url, BASE).pathname.split("/").pop());
            ws.getState().setActiveModel(v6.id); // the person is looking at a version made from it
            const outcome = await S.deleteVersion(meshV2);
            assert.equal(outcome.ok, true);
            assert.deepEqual(new Set(outcome.removed), new Set(family));
            const survivors = ws.getState().models.map((m) => m.id).filter((id) => id !== chair.id);
            assert.ok(ws.getState().models.some((m) => m.id === chair.id));
            assert.ok(survivors.every((id) => !family.includes(id)), "only what was made from v2 went");
            assert.equal(ws.getState().activeModelId, chair.id, "back on the model the edit was made from");
            const fresh = await S.getProject(projectB);
            assert.deepEqual(new Set(fresh.models.map((m) => m.id)), new Set([chair.id, ...survivors]));
            const left = await sql("SELECT id FROM models WHERE project_id = " + q(projectB));
            assert.equal(left.length, 1 + survivors.length);
            for (const id of family) assert.ok(!(await hasObject(`models/${id}.glb`)), `models/${id}.glb is gone from the bucket`);
            assert.ok(await hasObject(`models/${chair.id}.glb`), "the original's file stays");
            assert.ok(keys.length === family.length);
        });
    }
} else {
    // ====================================================================================================================================
    section("step 7: DAILY_LLM_LIMIT=2 -> the 429 of all four tasks");
    const created = await api("POST", "/projects", { name: "scenario limit" });
    const projectId = created.json.project.id;
    cleanup.push(projectId);
    const bench = await seedModel(projectId, { provider: "muse", glb: S.buildPartsGlb(BENCH), prompt: "a bench", partCount: BENCH.parts.length });
    const hunyuan = await seedModel(projectId, { provider: "hunyuan", glb: S.buildPartsGlb(BENCH), prompt: "a rocking chair", partCount: 1 });
    const PICTURE = `data:image/jpeg;base64,${Buffer.from("not really a jpeg").toString("base64")}`;
    const PACKAGE = {
        version: 1,
        frame: { size_mm: [643, 851, 1000], facing: "-Y" },
        facts: "Model facts: size X 643 mm, Y 851 mm, Z 1000 mm; 499,808 triangles; textured.",
        views: ["FRONT", "SIDE", "TOP"].map((id) => ({ id, caption: `${id} view`, image: PICTURE })),
        pieces: null,
        extras: null,
        original_prompt: "a rocking chair",
    };
    // A real brief: the facts of a bundled example, the way the page sends them.
    const L = await import(pathToFileURL(path.join(root, "scripts/assignment/optimize-lib.mjs")).href);
    const { ctx } = await L.ctxFor("pencil-leg-chair");
    const brief = L.SPEC.briefOf(ctx);
    const usedToday = async () => (await api("GET", "/providers")).json.assist.used_today;
    const limit = (await api("GET", "/providers")).json.assist.daily_limit;
    assert.equal(limit, 2, `start the server with --var DAILY_LLM_LIMIT:2 (the limit is ${limit})`);
    await test("the first two AI calls of the day are answered (a design edit and a block edit)", async () => {
        const first = await api("POST", `/models/${bench}/edits`, { instruction: "paint it red", target: "design" });
        assert.equal(first.status, 201, JSON.stringify(first.json));
        const second = await S.requestVoxelEdit({ instruction: "add a shelf", scene: "MODEL: x\nLAYERS\n" }, undefined).catch((e) => e);
        assert.ok(second && !(second instanceof Error), second instanceof Error ? second.message : "");
        assert.equal(await usedToday(), 2);
        await until(async () => (await api("GET", `/jobs/${first.json.job.id}`)).json.job.status === "succeeded", 30_000, "the first edit job");
    });
    await test("the third call of each of the four tasks is a 429 with a plain sentence", async () => {
        const design = await api("POST", `/models/${bench}/edits`, { instruction: "paint it blue", target: "design" });
        assert.equal(design.status, 429, JSON.stringify(design.json));
        assert.match(design.json.error, /limit|today/i);
        const mesh = await api("POST", `/models/${hunyuan}/edits`, { instruction: "make it taller", target: "mesh", mesh: PACKAGE });
        assert.ok(mesh.status === 429 || mesh.status === 409, `${mesh.status} ${JSON.stringify(mesh.json)}`);
        const voxel = await api("POST", "/llm/voxel-edit", { instruction: "add a shelf", scene: "MODEL: x\nLAYERS\n" });
        assert.equal(voxel.status, 429, JSON.stringify(voxel.json));
        assert.match(voxel.json.error, /limit|today/i);
        const spec = await api("POST", "/llm/optimize-spec", { goal: "as light as possible", brief });
        assert.equal(spec.status, 429, JSON.stringify(spec.json));
        assert.match(spec.json.error, /limit|today/i);
        assert.equal(await usedToday(), 2, "refused calls took no slot");
        note(`design: "${design.json.error}"`);
        note(`block edit: "${voxel.json.error}"`);
        note(`optimization spec: "${spec.json.error}"`);
        note(`mesh plan: ${mesh.status} "${mesh.json?.error}"`);
    });
    await test("the page's own words: the router and the stores turn a 429 into a plain message, the buttons still work", async () => {
        await openProject(projectId);
        const model = ws.getState().models.find((m) => m.id === bench);
        ws.getState().setActiveModel(model.id);
        ws.getState().setWorkspaceTab("3d");
        const out = await S.submitEdit("paint it green");
        assert.equal(out.ok, false, "refused before the words left the box (the day's count is known to be used up)");
        assert.ok(toastTitles().includes("Daily limit reached"), toastTitles().join(", "));
        await assert.rejects(S.requestOptimizeSpec({ goal: "lighter", brief }), /limit|today/i);
    });
    // the block editor and the optimizer's buttons need no AI call: a chip still fills the controls
    await test("the optimizer's four buttons need no AI call, so they work when the day's calls are used up", async () => {
        const { presetSpec } = await import(pathToFileURL(path.join(root, "src/assignment/shared/optimizeSpec.ts")).href);
        for (const kind of ["lightest", "strongest", "most-stable", "stiffest"]) assert.equal(presetSpec(kind, { blocks: 103 }).actionable, true, kind);
    });
    void MAX_VERSIONS_PER_SOURCE;
}

// ---------- cleanup ----------
try {
    if (cleanup.length > 0) {
        await S.bulkProjects(cleanup, "trash");
        await S.bulkProjects(cleanup, "purge");
    }
} catch (error) {
    console.log("  (cleanup failed:", String(error), ")");
}
console.log(`\n${passed} passed, ${failures.length} failed, ${notes.length} note(s)`);
if (failures.length) console.log("Failures:\n" + failures.map((f) => ` - ${f}`).join("\n"));
process.exit(failures.length ? 1 : 0);
