// The user flows, end to end, with the REAL stores, analysis engine (runAnalysis), stabilizer, GLB reader and a REAL running worker:
//   npx wrangler dev --port 8787 --local     (MOCK_PROVIDER=1, migrations applied; dist/ built so /assignment_alex/examples is served)
//   BASE=http://127.0.0.1:8787 node scripts/assignment/smoke-flows.mjs
//
//   A  open an example -> original active on the Analysis tab -> stress and verdict -> "Stabilized version ready" -> Compare
//   B  a generated (offline demo) model -> Stabilize (the real search, streamed steps and live preview) -> upload -> Models
//      grouping -> chat card -> reload keeps it -> same upload twice is one model -> delete puts the original back
//
// No browser: React hooks are not run (the modules are bundled with esbuild like test-store.mjs does, with the same two shims),
// so what this proves is everything below the components: wiring between stores, engine, API and storage. It creates its own
// projects and removes them. The mock job takes about 12 s.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-flows-smoke");
mkdirSync(path.join(outDir, "vendor"), { recursive: true });
const wasm = path.join(root, "src/assignment/analysis/fem/vendor/lSolver.wasm");
copyFileSync(wasm, path.join(outDir, "vendor/lSolver.wasm"));
const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");

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
export * from "@/assignment/store/persist";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/analysisLogic";
export * from "@/assignment/store/analysisSave";
export * from "@/assignment/store/stabilize";
export * from "@/assignment/store/stabilizeLogic";
export * from "@/assignment/store/examples";
export * from "@/assignment/store/models";
export * from "@/assignment/lib/api";
export * from "@/assignment/components/workspace/modelGroups";
export { runAnalysis, clearAnalysisCache } from "@/assignment/analysis/runAnalysis";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
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
                // Vite's ?url import of the WASM: in Node the "URL" is the file path (loadSolver reads it from disk).
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
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(typeof url === "string" && url.startsWith("/") ? BASE + url : url, init);

const S = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const engine = await import(pathToFileURL(path.join(root, "scripts/assignment/examples/lib/engine.mjs")).href);

let passed = 0;
const failures = [];
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms, what) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
};
const ws = S.useWorkspaceStore;
const an = S.useAnalysisStore;
const st = S.useStabilizeStore;

/** What the analysis runner does for a model in the viewer: the triangles in the viewer's frame -> runAnalysis -> store. */
async function analyseLikeTheRunner(model) {
    const bytes = new Uint8Array(await (await fetch(model.glb_url)).arrayBuffer());
    const { soup } = await engine.loadSoupLikeTheApp(bytes);
    let assembly = null;
    const read = S.readAssemblyGlb(bytes, null);
    if (read && read.descriptor) assembly = read.descriptor;
    an.getState().runStarted(model.id);
    const result = await S.runAnalysis(() => soup, an.getState().settings, { cacheKey: model.glb_url, assembly });
    an.getState().runSucceeded(model.id, result);
    await S.saveSummary(model.id, an.getState().settings, result.summary);
    return { result, assembly, bytes };
}
async function pollJob(id) {
    for (let i = 0; i < 80; i++) {
        const job = await S.getJob(id);
        if (job.status === "succeeded") return job;
        if (job.status === "failed" || job.status === "canceled") throw new Error(`job ${job.status}: ${job.error}`);
        await sleep(1000);
    }
    throw new Error("job did not finish");
}

console.log(`Flows against ${BASE}`);
const cleanup = [];

// =====================================================================================================================
console.log("\n== flow A: example -> Analysis -> Stabilized version ready -> Compare");
let exProject;
await test("openExample(desk-lamp): project in the store, original active, Analysis tab, router told, hub told", async () => {
    S.clearAnalysisCache();
    const nav = [];
    const out = await S.openExample("desk-lamp", { navigate: (to) => nav.push(to) });
    assert.equal(out.ok, true, JSON.stringify(out));
    const s = ws.getState();
    exProject = s.project;
    cleanup.push(exProject.id);
    assert.equal(s.activeProjectId, exProject.id);
    assert.equal(s.models.length, 2);
    const original = s.models.find((m) => m.kind === "example");
    const stabilized = s.models.find((m) => m.kind === "stabilized");
    assert.ok(original && stabilized && stabilized.source_model_id === original.id);
    assert.equal(s.activeModelId, original.id, "the original is the model in the viewer");
    assert.equal(s.workspaceTab, "analysis");
    assert.equal(nav.length, 1);
    assert.ok(nav[0].endsWith(`${exProject.id}?tab=analysis`), nav[0]);
    const last = s.messages[s.messages.length - 1];
    assert.equal(last.role, "assistant");
    assert.deepEqual([...last.model_ids].sort(), [original.id, stabilized.id].sort());
    assert.match(last.content, /./);
});

let exOriginal, exStabilized;
await test("the original is analysed like the viewer does it: stress, problems, verdict; the card offers the stabilized version", async () => {
    const s = ws.getState();
    exOriginal = s.models.find((m) => m.kind === "example");
    exStabilized = s.models.find((m) => m.kind === "stabilized");
    an.getState().modelChanged(exOriginal.id, exOriginal.glb_url);
    const { result } = await analyseLikeTheRunner(exOriginal);
    assert.ok(result.stress, "the stress stage ran");
    assert.ok(result.summary.errors > 0, "the lamp has problems");
    const verdict = S.verdictOf(result.summary);
    assert.notEqual(verdict.kind, "pass");
    const offer = S.stabilizeOffer({ model: exOriginal, models: ws.getState().models, result, verdict, analysing: false });
    assert.ok(offer, "the Stabilize card is shown");
    assert.equal(offer.child?.id, exStabilized.id, "... as 'Stabilized version ready' (a stabilized version exists)");
    assert.equal(offer.blocked, null);
    // the server saved the summary with the model
    const fresh = await S.getProject(exProject.id);
    assert.ok(fresh.models.find((m) => m.id === exOriginal.id).analysis, "summary saved with the model");
    // ... and it agrees with the manifest's verdict for the original (same engine, same numbers)
    const manifest = (await S.listExamples()).find((e) => e.slug === "desk-lamp");
    assert.equal(result.summary.blocks, manifest.original.analysis.blocks);
    assert.equal(result.summary.errors, manifest.original.analysis.errors);
});

await test("Compare: the card's request for the stabilized model survives the model change and lands as Overlay on its analysis", async () => {
    // WorkspaceShell effect order: the card sets the request, then the model changes.
    an.getState().requestCompare(exStabilized.id, "overlay");
    ws.getState().setActiveModel(exStabilized.id);
    an.getState().modelChanged(exStabilized.id, exStabilized.glb_url);
    assert.deepEqual(an.getState().pendingCompare, { modelId: exStabilized.id, mode: "overlay" }, "not dropped by the model change");
    const { result, assembly } = await analyseLikeTheRunner(exStabilized);
    assert.ok(assembly, "the stabilized GLB declares its blocks");
    assert.equal(an.getState().view.compare, "overlay");
    assert.equal(an.getState().view.colorBy, "role", "Overlay paints by role");
    assert.equal(result.summary.errors, 0);
    assert.equal(result.summary.warnings, 0);
    assert.ok(result.assembly && result.assembly.steps > 0, "the added blocks carry the step that added them");
    assert.ok(result.summary.stress && result.summary.stress.max_utilisation <= S.STRESS_WARN, `peak stress ${result.summary.stress?.max_utilisation}`);
    // the shipped log and the live analysis agree
    const manifest = (await S.listExamples()).find((e) => e.slug === "desk-lamp");
    assert.equal(result.summary.blocks, manifest.stabilized.analysis.blocks);
    assert.equal(exStabilized.derived.added_blocks, manifest.stabilized.added_blocks);
});

await test("a Compare asked for another model is dropped when that model is not the one opened", () => {
    an.getState().requestCompare("00000000-0000-4000-8000-000000000000", "overlay");
    an.getState().modelChanged(exOriginal.id, exOriginal.glb_url);
    assert.equal(an.getState().pendingCompare, null);
});

await test("Original | Stabilized | Overlay: the stage result follows the chip, the original half has no added blocks", async () => {
    an.getState().modelChanged(exStabilized.id, exStabilized.glb_url);
    await analyseLikeTheRunner(exStabilized);
    an.getState().setCompare("stabilized");
    assert.equal(S.selectStageResult(an.getState()), an.getState().result);
    an.getState().setCompare("original");
    await until(() => an.getState().originalResult !== null, 10000, "the original half");
    const half = S.selectStageResult(an.getState());
    assert.equal(half, an.getState().originalResult);
    assert.ok(half.blocks.length < an.getState().result.blocks.length, "fewer blocks than the stabilized version");
    assert.equal(half.assembly?.steps ?? 0, 0, "nothing added in the original half");
    assert.ok(half.stress, "the original half has its own stress estimate");
    an.getState().setCompare("overlay");
    assert.equal(S.selectStageResult(an.getState()), an.getState().result);
});

// =====================================================================================================================
console.log("\n== flow B: generated (demo) model -> Stabilize -> timeline -> upload -> Models grouping -> chat card -> reload");
let demoProject, demoModel, savedModel;
await test("a demo generation finishes with a plain-mesh model (this is a real mock job: ~12 s)", async () => {
    S.clearAnalysisCache();
    ws.getState().startNewChat();
    an.getState().modelChanged(null, null);
    const project = await S.createProject({ name: "int e2e demo" });
    cleanup.push(project.id);
    const [job] = await S.generate(project.id, { prompt: "a desk lamp", providers: ["mock"] });
    const done = await pollJob(job.id);
    assert.equal(done.status, "succeeded");
    const detail = await S.getProject(project.id);
    ws.getState().setProject(detail);
    demoProject = detail;
    demoModel = ws.getState().models[0];
    assert.equal(demoModel.kind, "generated");
    assert.equal(ws.getState().activeModelId, demoModel.id);
});

let demoResult;
await test("analysis of the demo model finds the floating lamp parts", async () => {
    an.getState().modelChanged(demoModel.id, demoModel.glb_url);
    ({ result: demoResult } = await analyseLikeTheRunner(demoModel));
    assert.ok(demoResult.summary.errors > 0);
    assert.ok(demoResult.summary.floating_blocks > 0);
});

const previews = [];
await test("Stabilize: the steps stream into the timeline and the stage preview, then the version saves itself", async () => {
    const stop = an.subscribe((state) => {
        if (state.preview) previews.push(state.preview.result.blocks.length);
    });
    const stepsSeen = [];
    const stopS = st.subscribe((s) => {
        if (s.steps.length !== (stepsSeen[stepsSeen.length - 1] ?? 0)) stepsSeen.push(s.steps.length);
    });
    assert.equal(st.getState().start(demoModel, demoResult), true);
    assert.equal(st.getState().status, "running");
    await until(() => ["saved", "error", "canceled"].includes(st.getState().status) || (st.getState().status === "finished" && st.getState().result), 120000, "the run to finish");
    // a complete run saves itself
    await until(() => ["saved", "error"].includes(st.getState().status) || st.getState().status === "finished", 30000, "the save");
    stop();
    stopS();
    const s = st.getState();
    assert.equal(s.status, "saved", `status ${s.status} ${s.error ?? ""}`);
    assert.ok(stepsSeen.length >= 2 && stepsSeen[stepsSeen.length - 1] === s.steps.length, `timeline grew step by step: ${stepsSeen}`);
    assert.ok(previews.length >= 2, `the stage preview was updated while it ran: ${previews}`);
    assert.ok(previews.some((n, i) => i > 0 && n > previews[0]), "... and the preview grows");
    assert.equal(an.getState().preview, null, "preview gone once saved");
    assert.ok(s.savedModelId);
    savedModel = ws.getState().models.find((m) => m.id === s.savedModelId);
    assert.equal(savedModel.kind, "stabilized");
    assert.equal(savedModel.source_model_id, demoModel.id);
    assert.equal(ws.getState().activeModelId, savedModel.id, "the new version is the one in the viewer");
    const last = ws.getState().messages[ws.getState().messages.length - 1];
    assert.deepEqual(last.model_ids, [savedModel.id]);
    assert.ok(S.toasts.some((t) => t.title === "Saved as a stabilized version"));
});

await test("both models are in the project: grouping puts the version under its source", () => {
    const groups = S.groupModels(ws.getState().models);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source.id, demoModel.id);
    assert.deepEqual(groups[0].versions.map((v) => [v.model.id, v.depth]), [[savedModel.id, 1]]);
    const pair = S.pairOf(demoModel, ws.getState().models);
    assert.equal(pair.model.id, savedModel.id);
    assert.equal(pair.label, "Stabilized");
    assert.equal(S.pairOf(savedModel, ws.getState().models).label, "Original");
});

await test("the saved version is stable when analysed from its own file, and its summary is saved with it", async () => {
    an.getState().modelChanged(savedModel.id, savedModel.glb_url);
    const { result, assembly } = await analyseLikeTheRunner(savedModel);
    assert.ok(assembly);
    assert.equal(result.summary.errors, 0);
    assert.equal(result.summary.warnings, 0);
    assert.ok(result.summary.stress.max_utilisation <= S.STRESS_WARN);
    assert.equal(result.summary.blocks, savedModel.derived.after ? savedModel.derived.after.blocks : result.summary.blocks);
    // The stored log says what the fresh analysis says.
    assert.equal(savedModel.derived.after.errors, 0);
    assert.equal(savedModel.derived.after.warnings, 0);
    assert.equal(savedModel.derived.depth, 1);
});

await test("reload: the project comes back with both models, the chat cards, the active model and the saved summaries", async () => {
    await S.saveNow();
    await S.whenSaved(demoProject.id);
    const fresh = await S.getProject(demoProject.id);
    assert.equal(fresh.models.length, 2);
    const a = fresh.models.find((m) => m.id === demoModel.id);
    const b = fresh.models.find((m) => m.id === savedModel.id);
    assert.equal(a.kind, "generated");
    assert.equal(b.kind, "stabilized");
    assert.equal(b.source_model_id, a.id);
    assert.ok(b.derived && b.derived.steps.length > 0 && b.derived.added_blocks > 0);
    assert.equal(fresh.data.active_model_id, b.id);
    const withCards = fresh.data.messages.filter((m) => m.model_ids && m.model_ids.includes(b.id));
    assert.equal(withCards.length, 1);
    assert.ok(b.analysis, "analysis summary stored with the version");
    assert.ok(b.analysis.stress, "... with its stress");
    assert.ok(a.analysis, "... and for the original");
    // opening it again puts the same state in the store
    ws.getState().startNewChat();
    ws.getState().setProject(fresh);
    assert.equal(ws.getState().activeModelId, b.id);
    assert.equal(ws.getState().models.length, 2);
    assert.equal(ws.getState().messages.filter((m) => m.model_ids?.includes(b.id)).length, 1);
});

await test("stabilizing the same model again returns the same stored version (idempotent upload)", async () => {
    const bytes = new Uint8Array(await (await fetch(savedModel.glb_url)).arrayBuffer());
    const again = await S.createDerivedModel(demoModel.id, bytes);
    assert.equal(again.id, savedModel.id);
});

await test("deleting the version leaves the original and puts the viewer back on it", async () => {
    ws.getState().setActiveModel(savedModel.id);
    const out = await S.deleteStabilized(savedModel);
    assert.equal(out.ok, true);
    assert.deepEqual(ws.getState().models.map((m) => m.id), [demoModel.id]);
    assert.equal(ws.getState().activeModelId, demoModel.id);
    const fresh = await S.getProject(demoProject.id);
    assert.equal(fresh.models.length, 1);
});

// ---------- cleanup ----------
try {
    await S.bulkProjects(cleanup, "trash");
    await S.bulkProjects(cleanup, "purge");
} catch (error) {
    console.log("  (cleanup failed:", String(error), ")");
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
