// Regression tests for the UX review fixes (ux-1 .. ux-12): the wording and limits of the Stabilize flow
// (store/stabilizeLogic.ts), the stores behind it, and the markup of the components that changed.
//
//   node scripts/assignment/test-ux-fixes.mjs
//
// One esbuild bundle with real React and react-dom/server: the components are rendered to a string with the stores set
// to the state under test. Two stand-ins: `zustand` becomes a tiny wrapper whose hooks read the *current* state (zustand's
// own server snapshot is the initial state, which would hide what a test set), and the toast library becomes a log. No DOM,
// no network (`fetch` is a small fake). Effects do not run in a server render, so the behaviour that lives in effects (the
// timeline following a run, the banner taking focus) is covered by its pure parts and by reading the code.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-ux-test");
mkdirSync(outDir, { recursive: true });
mkdirSync(path.join(outDir, "vendor"), { recursive: true });
copyFileSync(path.join(root, "src/assignment/analysis/fem/vendor/lSolver.wasm"), path.join(outDir, "vendor/lSolver.wasm"));

const ZUSTAND_SHIM = `
import { createStore } from "zustand/vanilla";
function build(init) {
    const api = createStore(init);
    const use = (selector = (s) => s) => selector(api.getState());
    return Object.assign(use, api);
}
export function create(init) { return init ? build(init) : build; }
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
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
export { React, renderToStaticMarkup, MemoryRouter };
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/analysisLogic";
export * from "@/assignment/store/stabilize";
export * from "@/assignment/store/stabilizeLogic";
export * from "@/assignment/store/examples";
export * from "@/assignment/lib/api";
export { analyzeAssembly } from "@/assignment/analysis/assembly";
export { applyStress, computeStress } from "@/assignment/analysis/stress";
export { solveFrameTs } from "@/assignment/analysis/fem/index";
export { descriptorFromBlocks } from "@/assignment/shared/assembly";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { STRESS_WARN_SHARE } from "@/assignment/viewer/analysisGeometry";
export { StabilizeCard } from "@/assignment/components/analysis/StabilizeCard";
export { StabilizeTimeline } from "@/assignment/components/analysis/StabilizeTimeline";
export { StressSection } from "@/assignment/components/analysis/StressSection";
export { AnalysisPeek, AnalysisDock } from "@/assignment/components/analysis/AnalysisDock";
export { CompareNotice } from "@/assignment/components/analysis/CompareNotice";
export { HeroStart } from "@/assignment/components/chat/HeroStart";
export { ModelCard } from "@/assignment/components/chat/ModelCard";
export { toasts } from "@/assignment/components/ui/sonner";
`;

await build({
    stdin: { contents: ENTRY, resolveDir: root, sourcefile: "entry.tsx", loader: "tsx" },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: path.join(outDir, "bundle.mjs"),
    tsconfig: path.join(root, "tsconfig.app.json"),
    nodePaths: [path.join(root, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    // react-dom/server is CommonJS and asks for node's own modules.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "error",
    plugins: [
        {
            name: "shims",
            setup(b) {
                b.onResolve({ filter: /^zustand$/ }, () => ({ path: "zustand-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                // The stabilizer's runner (a Web Worker plus Vite's ?url import of the WASM) is replaced by the tests with fakes.
                b.onResolve({ filter: /analysis\/stabilize\/runStabilize$/ }, () => ({ path: "stabilize-run-stub", namespace: "shim" }));
                b.onLoad({ filter: /^stabilize-run-stub$/, namespace: "shim" }, () => ({
                    contents: 'export const runStabilize = async () => { throw new Error("the real stabilizer is not used here"); };',
                    loader: "js",
                }));
                b.onLoad({ filter: /^zustand-shim$/, namespace: "shim" }, () => ({ contents: ZUSTAND_SHIM, loader: "js", resolveDir: root }));
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
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };

// ---------- a fake server ----------

const calls = [];
const fake = { derived: null }; // (request) => Promise<Response-like>
globalThis.fetch = async (url, init = {}) => {
    const apiPath = String(url).replace("/api/assignment_alex", "");
    const method = init.method ?? "GET";
    calls.push({ method, path: apiPath, signal: init.signal, body: init.body });
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (method === "POST" && /^\/models\/[^/]+\/derived$/.test(apiPath) && fake.derived) return fake.derived({ apiPath, init, reply });
    return reply(404, { error: `no fake for ${method} ${apiPath}` });
};

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const { React, renderToStaticMarkup, MemoryRouter } = lib;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

let passed = 0;
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await sleep(15);
    }
};
async function test(name, fn) {
    resetAll();
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}

// ---------- fixtures ----------

const S = () => lib.useWorkspaceStore.getState();
const AS = () => lib.useAnalysisStore.getState();
const ST = () => lib.useStabilizeStore.getState();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const box = (x0, x1, y0, y1, z0, z1) => range(x1 - x0, x0).flatMap((i) => range(y1 - y0, y0).flatMap((j) => range(z1 - z0, z0).map((k) => [i, j, k])));
const uniq = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];
/** A 5-block column on a 6 x 3 base with an arm of `n` blocks off its top: 5 blocks is past the limit of 4 (2 errors, 106 %). */
const armCells = (n) => uniq([...box(0, 6, 0, 3, 0, 1), ...box(0, 1, 1, 2, 1, 6), ...range(n, 1).map((i) => [i, 1, 5])]);
const TS = { solve: lib.solveFrameTs, backend: "ts" };
const plainDesc = (cells) => lib.descriptorFromBlocks(cells.map((cell) => ({ cell })));
const addedDesc = (cells, added, role = "column", step = 1) => lib.descriptorFromBlocks([...cells.map((cell) => ({ cell })), ...added.map((cell) => ({ cell, role, step }))]);
const measured = (desc, settings = lib.sanitizeSettings(null)) => {
    const base = lib.analyzeAssembly(desc, null, settings);
    return lib.applyStress(base, lib.computeStress(base, TS));
};
const TIP_COLUMN = [1, 2, 3, 4].map((k) => [5, 1, k]);

const mt = (over = {}) => ({ blocks: 28, errors: 2, floating_blocks: 0, over_limit: 1, longest_cantilever: 5, cog_margin_mm: 120, max_utilisation: 1.06, ...over });
const metrics = (over = {}) => ({ blocks: 28, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 0, cog_margin_mm: 120, max_utilisation: 0.5, overstressed_blocks: 0, ...over });
function stepLog(n, move, added, over = {}) {
    return {
        n, move, reason: "cantilever", added,
        text: `Added a ${added}-block ${move} under the arm tip because the cantilever reached 5 > 4 blocks.`,
        at_mm: [550, 150, 250], before: mt(), after: mt({ blocks: 28 + added, errors: 0, over_limit: 0, longest_cantilever: 0, max_utilisation: 0.11 }), ...over,
    };
}
const model = (id, over = {}) => ({
    id, project_id: "p1", job_id: "j1", provider: "hunyuan", prompt: "a shelf", glb_url: `/${id}.glb`, thumbnail_url: null, size_bytes: 1000,
    part_count: 1, created_at: iso(), analysis: null, kind: "generated", source_model_id: null, example_slug: null, derived: null, ...over,
});
const derivedMeta = (over = {}) => ({
    version: 1, depth: 1, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.75, cantilever_limit: 4, fill_threshold: 0.3,
    complete: true, stop: "stable", added_blocks: 4, added_by_role: { column: 4 }, before: metrics({ errors: 2, max_utilisation: 1.06 }), after: metrics(),
    steps: [stepLog(1, "column", 4)], duration_ms: 20, assembly_hash: "x", after_summary: null, created_at: iso(), ...over,
});
const stub = (over = {}) => ({
    complete: true, stop: "stable", glb: new Uint8Array([1, 2, 3]), before: metrics({ blocks: 85 }), after: metrics(),
    meta: derivedMeta(), ...over,
});
const VERDICT = (kind, short) => ({ kind, errors: kind === "fail" ? 2 : 0, warnings: kind === "warn" ? 1 : 0, blocks: 28, custom: null, headline: short, short });

const INITIAL_VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [], compare: "stabilized", focus: null };
function resetAll() {
    lib.setStabilizeDeps();
    if (ST().status === "running") ST().cancel();
    ST().discard();
    lib.useStabilizeStore.setState({
        status: "idle", sourceModelId: null, projectId: null, sourcePrompt: "", steps: [], moves: [], progress: null, result: null, preview: null,
        errorKind: null, error: null, savedModelId: null, endedAt: null, startMetrics: null, options: null, choices: lib.DEFAULT_CHOICES,
    });
    lib.useAnalysisStore.setState({
        settings: lib.sanitizeSettings(null), loaded: null, viewerFailure: null, run: lib.IDLE_RUN, result: null, resultModelId: null,
        blockIssues: new Map(), summaries: {}, view: INITIAL_VIEW, colorChoice: "status", originalResult: null, originalFor: null,
        originalState: "idle", pendingCompare: null, preview: null, selection: null, stepSelection: null, selectionSerial: 0, layerRaised: false,
        hoverIssueId: null, attempt: 0, panelOpen: true, sheetOpen: false, openRequest: 0,
    });
    lib.useWorkspaceStore.setState({ models: [], activeModelId: null, activeProjectId: null, messages: [], providers: null });
    lib.useExamplesStore.setState({ status: "idle", examples: [], error: null });
    lib.toasts.length = 0;
    calls.length = 0;
    storage.clear();
    fake.derived = null;
}

// ================= ux-1: the target stops at the warning level, and the words follow the report =================

await test("ux-1: the target cannot be set above the warning level, so a 'complete' run never leaves a stress warning", () => {
    assert.equal(lib.TARGET_RANGE.max, lib.STRESS_WARN_SHARE);
    assert.equal(lib.TARGET_RANGE.max, 0.75);
    assert.equal(lib.sanitizeChoices({ target: 0.9 }).target, 0.75);
    assert.equal(lib.sanitizeChoices({ target: 0.7 }).target, 0.7);
    assert.equal(lib.sanitizeChoices(null).target, lib.DEFAULT_CHOICES.target);
});

await test("ux-1: the chat line does not say 'passes all checks' for a version the report still warns about", () => {
    const after = metrics({ errors: 0, warnings: 1 });
    assert.equal(lib.savedMessage("a lamp", { added_blocks: 2, complete: true, after }), "Stabilized version of **a lamp**: +2 blocks, no problems left, 1 warning to look at.");
    assert.equal(lib.savedMessage("a lamp", { added_blocks: 2, complete: true, after: metrics({ warnings: 3 }) }), "Stabilized version of **a lamp**: +2 blocks, no problems left, 3 warnings to look at.");
    assert.equal(lib.savedMessage("a lamp", { added_blocks: 2, complete: true, after: metrics() }), "Stabilized version of **a lamp**: +2 blocks, passes all checks.");
});

await test("ux-1: one remaining problem reads 'remains', several 'remain'", () => {
    const line = (errors, warnings = 0) => lib.stabilizedLine({ added_blocks: 2, before: metrics({ max_utilisation: null }), after: metrics({ errors, warnings, max_utilisation: null }) });
    assert.equal(line(1), "+2 blocks · 1 problem remains");
    assert.equal(line(2), "+2 blocks · 2 problems remain");
    assert.equal(line(0, 1), "+2 blocks · 1 warning");
    assert.equal(line(0, 0), "+2 blocks · all checks pass");
});

await test("ux-1: a run that added nothing says why, from the way it stopped", () => {
    const options = { targetUtilisation: 0.9, maxBlocks: 50 };
    const stable = lib.nothingLine({ stop: "stable", before: metrics({ blocks: 85, max_utilisation: 0.846 }) }, { ...options, targetUtilisation: 0.9 });
    assert.match(stable, /already meets the target \(peak stress 85% against 90%\)/);
    assert.doesNotMatch(stable, /no move/i);
    assert.match(lib.nothingLine({ stop: "stable", before: metrics({ max_utilisation: null }) }, options), /^This model already meets the target\. /);
    const budget = lib.nothingLine({ stop: "max-blocks", before: metrics({ blocks: 85 }) }, options);
    assert.match(budget, /block budget \(50 blocks\) leaves no room: the model has 85 blocks already/);
    assert.match(budget, /Raise the budget in Options/);
    assert.match(lib.nothingLine({ stop: "no-improving-move", before: metrics() }, { targetUtilisation: 0.75, maxBlocks: 120 }), /no move that improves this model within the options \(target stress 75%, up to 120 blocks\)/);
    assert.match(lib.nothingLine({ stop: "time-budget", before: metrics() }, options), /stopped before it added anything\. It ran out of time\./);
    assert.match(lib.nothingLine({ stop: "no-improving-move", before: metrics() }, null), /target stress 75%, up to the block budget/, "without options the defaults are named");
});

await test("ux-1: the banner for a run that added nothing names the reason (rendered)", () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1" });
    lib.useStabilizeStore.setState({
        status: "finished", sourceModelId: "m1", sourcePrompt: "a shelf", result: stub({ stop: "max-blocks", meta: derivedMeta({ added_blocks: 0 }), before: metrics({ blocks: 85 }) }),
        options: { targetUtilisation: 0.75, maxBlocks: 50, maxSteps: 40, timeBudgetMs: 30000 }, steps: [], moves: [],
    });
    const html = render(h(lib.StabilizeCard, { model: m, result: measured(plainDesc(armCells(5))), verdict: VERDICT("fail", "2 problems"), analysing: false }));
    assert.match(html, /data-testid="stabilize-nothing"/);
    assert.match(html, /block budget \(50 blocks\) leaves no room/);
    assert.doesNotMatch(html, /found no move/);
});

await test("ux-1: the saved banner is green only when the report has nothing left to say", () => {
    const m = model("m1");
    const kid = model("s1", { kind: "stabilized", source_model_id: "m1", derived: derivedMeta() });
    lib.useWorkspaceStore.setState({ models: [m, kid], activeModelId: "s1" });
    const base = { status: "saved", sourceModelId: "m1", sourcePrompt: "a shelf", savedModelId: "s1", steps: [], moves: [] };
    const card = () => render(h(lib.StabilizeCard, { model: kid, result: measured(plainDesc(armCells(5))), verdict: VERDICT("pass", "Stable"), analysing: false }));
    lib.useStabilizeStore.setState({ ...base, result: stub({ after: metrics({ warnings: 1 }), meta: derivedMeta({ after: metrics({ warnings: 1 }) }) }) });
    const warned = card();
    assert.match(warned, /data-testid="stabilize-saved"/);
    assert.match(warned, /1 warning/);
    assert.doesNotMatch(warned, /all checks pass/);
    lib.useStabilizeStore.setState({ result: stub() });
    assert.match(card(), /all checks pass/);
});

// ================= ux-2: the run is visible from the pill, and the sheet gets out of its way =================

await test("ux-2: the pill says what the run is doing, and a run waiting for a decision", () => {
    const b = (status, extra = {}) => lib.runBadge({ status, steps: 0, outcome: null, errorKind: null, ...extra });
    assert.equal(b("idle"), null);
    assert.equal(b("saved"), null, "a saved run: the pill is back to the verdict");
    assert.deepEqual(b("running"), { kind: "running", text: "Stabilizing…" });
    assert.equal(b("running", { steps: 1 }).text, "Stabilizing… 1 step");
    assert.equal(b("running", { steps: 3 }).text, "Stabilizing… 3 steps");
    assert.equal(b("saving").kind, "saving");
    assert.deepEqual(b("canceled"), { kind: "stopped", text: "Stopped: save or discard" });
    assert.deepEqual(b("error", { errorKind: "save" }), { kind: "failed", text: "Could not save" });
    assert.deepEqual(b("error", { errorKind: "run" }), { kind: "failed", text: "Stabilizing failed" });
    assert.deepEqual(b("finished", { outcome: "partial" }), { kind: "review", text: "Review stabilized version" });
    assert.deepEqual(b("finished", { outcome: "nothing" }), { kind: "nothing", text: "Nothing to add" });
    assert.equal(b("finished", { outcome: "complete" }).kind, "saving", "it is about to be saved");
});

await test("ux-2: a decision is pending for a stopped, failed, partial or empty run, not for one that saves itself", () => {
    assert.equal(lib.needsDecision("canceled", null), true);
    assert.equal(lib.needsDecision("error", null), true);
    assert.equal(lib.needsDecision("finished", "partial"), true);
    assert.equal(lib.needsDecision("finished", "nothing"), true);
    assert.equal(lib.needsDecision("finished", "complete"), false);
    for (const status of ["idle", "running", "saving", "saved"]) assert.equal(lib.needsDecision(status, null), false, status);
});

await test("ux-2: starting a run folds the phone's report sheet away so the stage shows it", () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1", activeProjectId: "p1" });
    const result = measured(plainDesc(armCells(5)));
    lib.useAnalysisStore.setState({ result, resultModelId: "m1", sheetOpen: true });
    lib.setStabilizeDeps({ run: (input, hooks) => new Promise((_, reject) => hooks.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))) });
    assert.equal(AS().sheetOpen, true);
    assert.equal(ST().start(m, result), true);
    assert.equal(AS().sheetOpen, false);
    ST().cancel();
});

await test("ux-2: the collapsed pill and the phone's pill carry the run, and Stop only while it runs (rendered)", () => {
    const snapshot = { phase: "ready", result: null, verdict: VERDICT("fail", "3 problems"), run: lib.IDLE_RUN, viewResult: null, previewResult: null, ready: true, unavailable: null };
    const peek = () => render(h(lib.AnalysisPeek, { snapshot }));
    const dock = () => render(h(lib.AnalysisDock, { model: null, snapshot }));
    lib.useAnalysisStore.setState({ panelOpen: false });
    assert.match(peek(), /3 problems/);
    assert.doesNotMatch(peek(), /analysis-stop/);
    lib.useStabilizeStore.setState({ status: "running", steps: [stepLog(1, "column", 4), stepLog(2, "footing", 1)] });
    for (const html of [peek(), dock()]) {
        assert.match(html, /Stabilizing… 2 steps/);
        assert.match(html, /data-testid="analysis-stop"/);
        assert.doesNotMatch(html, /3 problems/, "the run is the news");
    }
    lib.useStabilizeStore.setState({ status: "canceled" });
    for (const html of [peek(), dock()]) {
        assert.match(html, /Stopped: save or discard/);
        assert.doesNotMatch(html, /analysis-stop/);
    }
    lib.useStabilizeStore.setState({ status: "finished", result: stub({ complete: false, meta: derivedMeta({ complete: false }) }) });
    assert.match(peek(), /Review stabilized version/);
    lib.useStabilizeStore.setState({ status: "error", errorKind: "save", result: stub() });
    assert.match(dock(), /Could not save/);
});

// ================= ux-3: the live list is a box of its own =================

await test("ux-3: while it runs the timeline scrolls inside its own box; once over it is a plain list", () => {
    const steps = range(8, 1).map((n) => stepLog(n, "column", 2));
    const html = (running) => render(h(lib.StabilizeTimeline, { steps, running, selected: null, onSelect() {} }));
    assert.match(html(true), /data-testid="stabilize-timeline-scroll"[^>]*/);
    assert.match(html(true), /class="[^"]*max-h-64[^"]*overflow-y-auto/);
    assert.doesNotMatch(html(false), /max-h-64/);
    assert.equal((html(true).match(/data-testid="timeline-step"/g) ?? []).length, 8);
});

// ================= ux-4: the stress estimate can be seen on the model =================

function stressedResult() {
    const result = measured(plainDesc(armCells(5)));
    assert.ok(result.stress && result.stress.points.length > 0, "the shelf has stress points");
    return result;
}

await test("ux-4: the Stress section has a switch for the heat map, with its legend once it is on (rendered)", () => {
    const result = stressedResult();
    lib.useAnalysisStore.setState({ result, resultModelId: "m1" });
    const before = render(h(lib.StressSection, { result }));
    assert.match(before, /Colour blocks by stress/);
    assert.match(before, /role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
    assert.doesNotMatch(before, /data-testid="stress-legend"/);
    AS().setColorBy("stress");
    assert.equal(AS().view.colorBy, "stress");
    const after = render(h(lib.StressSection, { result }));
    assert.match(after, /aria-checked="true"/);
    assert.match(after, /data-testid="stress-legend"/);
});

await test("ux-4: 'Show' on a stress point (or the stress check, or a stress issue) paints the model by stress", () => {
    const result = stressedResult();
    const rows = (check) => result.checks.find((c) => c.key === check);
    assert.ok(rows("stress"));
    lib.useAnalysisStore.setState({ result, resultModelId: "m1" });
    AS().selectBlocks(result.stress.points[0].blocks, { check: "stress", label: "Stress point 1" });
    assert.equal(AS().view.colorBy, "stress", "a stress point");
    assert.equal(AS().view.highlight.length > 0, true);
    // The user's choice is kept: leaving it is one switch away, and a later model is painted the same way.
    assert.equal(AS().colorChoice, "stress");
    AS().setColorBy("layer");
    AS().clearSelection();
    const issue = result.issues.find((i) => i.kind === "overstressed" || i.kind === "highly-stressed");
    assert.ok(issue, "the shelf has a stress issue");
    AS().selectIssues([issue.id]);
    assert.equal(AS().view.colorBy, "stress", "a stress issue card");
    AS().setColorBy("layer");
    AS().clearSelection();
    AS().selectIssues([issue.id], { check: "stress" });
    assert.equal(AS().view.colorBy, "stress", "the Joint stress check row");
});

await test("ux-4: other picks, a click in the viewer, Overlay and the preview keep their own colours", () => {
    const result = stressedResult();
    const flat = result.issues.find((i) => i.kind !== "overstressed" && i.kind !== "highly-stressed");
    lib.useAnalysisStore.setState({ result, resultModelId: "m1" });
    if (flat) {
        AS().selectIssues([flat.id]);
        assert.equal(AS().view.colorBy, "status", "an issue that is not about stress");
        AS().clearSelection();
    }
    const stressIssue = result.issues.find((i) => i.kind === "overstressed" || i.kind === "highly-stressed");
    AS().selectIssues([stressIssue.id], { focus: false });
    assert.equal(AS().view.colorBy, "status", "a click on a block is already looking at it");
    AS().clearSelection();
    // Overlay and the preview paint by role: showing a stress point must not take them away.
    lib.useAnalysisStore.setState({ view: { ...AS().view, compare: "overlay", colorBy: "role" } });
    AS().showStress();
    assert.equal(AS().view.compare, "overlay");
    lib.useAnalysisStore.setState({ view: { ...AS().view, compare: "stabilized", colorBy: "role" }, preview: { modelId: "m1", result } });
    AS().showStress();
    assert.equal(AS().colorChoice, "status");
    // No estimate (nothing on the ground): nothing to show.
    lib.useAnalysisStore.setState({ preview: null, result: { ...result, stress: null } });
    AS().showStress();
    assert.equal(AS().colorChoice, "status");
});

// ================= ux-5: a banner for another model's run says whose it is =================

const ownershipSetup = () => {
    const a = model("a", { prompt: "a tall shelf with a very long description that goes on and on" });
    const b = model("b", { prompt: "a lamp" });
    lib.useWorkspaceStore.setState({ models: [a, b], activeModelId: "b" });
    lib.useStabilizeStore.setState({
        status: "canceled", sourceModelId: "a", sourcePrompt: a.prompt, steps: [stepLog(1, "column", 4)], moves: [{ step: stepLog(1, "column", 4), cells: [[1, 1, 1]], roles: ["column"] }],
    });
    return { a, b };
};

await test("ux-5: on another model the banner names the model the run is for, offers to go back, and leaves the steps out", () => {
    const { a, b } = ownershipSetup();
    const card = (m) => render(h(lib.StabilizeCard, { model: m, result: measured(plainDesc(armCells(5))), verdict: VERDICT("fail", "2 problems"), analysing: false }));
    const other = card(b);
    assert.match(other, /For “a tall shelf with a very long descripti…”\. Nothing is saved yet\./);
    assert.match(other, /data-testid="stabilize-open-source"/);
    assert.match(other, /Open that model/);
    assert.doesNotMatch(other, /data-testid="stabilize-timeline"/, "the steps are blocks of the other model");
    assert.match(other, /Save partial/);
    const own = card(a);
    assert.doesNotMatch(own, /For “/);
    assert.doesNotMatch(own, /stabilize-open-source/);
    assert.match(own, /data-testid="stabilize-timeline"/);
    assert.match(own, /The blocks added so far are shown in the viewer/);
    assert.equal(lib.clipText("  a   lamp \n with   space "), "a lamp with space");
    assert.equal(lib.clipText("x".repeat(60), 10).length, 10);
});

await test("ux-5: the same holds for a failed save and a partial result", () => {
    const { b } = ownershipSetup();
    const card = () => render(h(lib.StabilizeCard, { model: b, result: measured(plainDesc(armCells(5))), verdict: VERDICT("fail", "2 problems"), analysing: false }));
    lib.useStabilizeStore.setState({ status: "error", errorKind: "save", error: "The server is down.", result: stub() });
    let html = card();
    assert.match(html, /For “a tall shelf/);
    assert.match(html, /The server is down\./);
    assert.match(html, /stabilize-open-source/);
    lib.useStabilizeStore.setState({ status: "finished", errorKind: null, error: null, result: stub({ complete: false, stop: "no-improving-move", after: metrics({ errors: 1 }), meta: derivedMeta({ complete: false }) }) });
    html = card();
    assert.match(html, /data-testid="stabilize-partial"/);
    assert.match(html, /For “a tall shelf/);
    assert.match(html, /stabilize-open-source/);
});

// ================= ux-6: nothing points at a deleted version =================

await test("ux-6: setActiveModel ignores a model the project does not have", () => {
    lib.useWorkspaceStore.setState({ models: [model("a"), model("b")], activeModelId: "a" });
    const rev = S().revision;
    S().setActiveModel("gone");
    assert.equal(S().activeModelId, "a");
    assert.equal(S().revision, rev, "and nothing to autosave");
    S().setActiveModel("b");
    assert.equal(S().activeModelId, "b");
    S().setActiveModel(null);
    assert.equal(S().activeModelId, null, "null still clears");
});

await test("ux-6: deleting the version a 'Stabilized' banner is about dismisses the banner; other deletions leave it", () => {
    const m = model("m1");
    const kid = model("s1", { kind: "stabilized", source_model_id: "m1", derived: derivedMeta() });
    const other = model("s2", { kind: "stabilized", source_model_id: "m1", derived: derivedMeta() });
    lib.useWorkspaceStore.setState({ models: [m, kid, other], activeModelId: "s1", activeProjectId: "p1" });
    lib.useStabilizeStore.setState({ status: "saved", sourceModelId: "m1", projectId: "p1", savedModelId: "s1", result: stub(), steps: [], moves: [] });
    S().removeModels(["s2"], "m1");
    assert.equal(ST().status, "saved", "another version going leaves the banner");
    S().removeModels(["s1"], "m1");
    assert.equal(ST().status, "idle");
    assert.equal(ST().savedModelId, null);
    assert.equal(S().activeModelId, "m1");
});

await test("ux-6: a saved banner whose version is gone renders nothing (and Open cannot blank the viewer)", () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1" });
    lib.useStabilizeStore.setState({ status: "saved", sourceModelId: "m1", savedModelId: "ghost", result: stub(), steps: [], moves: [] });
    const html = render(h(lib.StabilizeCard, { model: m, result: measured(plainDesc(armCells(5))), verdict: VERDICT("pass", "Stable"), analysing: false }));
    assert.equal(html, "");
});

// ================= ux-7: the finished banner does not flash 'not fully stable' =================

await test("ux-7: a run that reached its goal shows the saving banner, not the partial one, while it is being saved", () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1" });
    lib.useStabilizeStore.setState({ status: "finished", sourceModelId: "m1", sourcePrompt: "a shelf", result: stub(), steps: [], moves: [], endedAt: Date.now() });
    const html = render(h(lib.StabilizeCard, { model: m, result: measured(plainDesc(armCells(5))), verdict: VERDICT("fail", "2 problems"), analysing: false }));
    assert.match(html, /data-testid="stabilize-saving"/);
    assert.match(html, /Saving the stabilized version/);
    assert.doesNotMatch(html, /not fully stable|stabilize-partial/);
});

// ================= ux-8: Original while the half is made, and when it cannot be =================

await test("ux-8: the notice says the stage has not changed yet, then that the report is about the stabilized model (rendered)", () => {
    assert.equal(render(h(lib.CompareNotice)), "", "nothing on the stabilized view");
    const result = measured(addedDesc(armCells(5), TIP_COLUMN));
    lib.useAnalysisStore.setState({ result, resultModelId: "s1", view: { ...INITIAL_VIEW, compare: "original" }, originalState: "loading" });
    let html = render(h(lib.CompareNotice));
    assert.match(html, /data-loading="true"/);
    assert.match(html, /Preparing the original blocks/);
    assert.match(html, /Show stabilized/);
    lib.useAnalysisStore.setState({ originalState: "idle", originalFor: result, originalResult: result });
    html = render(h(lib.CompareNotice));
    assert.match(html, /data-loading="false"/);
    assert.match(html, /report below is about the stabilized model/);
});

await test("ux-8: when the original half cannot be made, Original goes back to the stabilized view and says so", async () => {
    const good = measured(addedDesc(armCells(5), TIP_COLUMN));
    // A descriptor the engine cannot read: the half's analysis throws.
    const broken = { ...good, assembly: { ...good.assembly, descriptor: { ...good.assembly.descriptor, cells: null } } };
    lib.useAnalysisStore.setState({ result: broken, resultModelId: "s1" });
    AS().setCompare("original");
    assert.equal(AS().view.compare, "original", "the chip moves at once");
    await until(() => AS().originalState === "error");
    assert.equal(AS().view.compare, "stabilized");
    assert.ok(lib.toasts.some((t) => t.kind === "error" && /original blocks/i.test(t.title)));
    // A model that never asked for Original is not touched by a failure of an earlier ask.
    AS().ensureOriginal();
    await until(() => AS().originalState === "error");
    assert.equal(AS().view.compare, "stabilized");
});

await test("ux-8: when the original half is made, Original shows it", async () => {
    const good = measured(addedDesc(armCells(5), TIP_COLUMN));
    lib.useAnalysisStore.setState({ result: good, resultModelId: "s1" });
    AS().setCompare("original");
    await until(() => AS().originalResult !== null);
    assert.equal(AS().view.compare, "original");
    assert.equal(AS().originalState, "idle");
    assert.equal(AS().originalFor, good);
    assert.equal(lib.toasts.length, 0);
});

// ================= ux-9: a stabilized twin that added nothing =================

await test("ux-9: a stabilized version that added no block says 'same blocks' and offers no Compare (rendered)", () => {
    const original = model("o", { kind: "example", example_slug: "arch" });
    const twin = model("t", { kind: "stabilized", source_model_id: "o", example_slug: "arch", derived: derivedMeta({ added_blocks: 0, added_by_role: {}, steps: [] }) });
    const withBlocks = model("w", { kind: "stabilized", source_model_id: "o", derived: derivedMeta({ added_blocks: 4 }) });
    const router = (el) => h(MemoryRouter, null, el);
    lib.useWorkspaceStore.setState({ models: [original, twin, withBlocks] });
    const same = render(router(h(lib.ModelCard, { model: twin, models: [original, twin], active: false, onView() {} })));
    assert.match(same, /Same blocks as the original/);
    assert.doesNotMatch(same, /Compare/);
    assert.doesNotMatch(same, /\+0 blocks/);
    const more = render(router(h(lib.ModelCard, { model: withBlocks, models: [original, withBlocks], active: false, onView() {} })));
    assert.match(more, /\+4 blocks/);
    assert.match(more, /Compare/);
});

// ================= ux-10: the hero does not start on the wrong row =================

const info = (id, available) => ({ id, label: id, vendor: "x", via: id === "mock" ? null : "fal", available, description: "", parts: false, textured: false, approx_seconds: 60 });

await test("ux-10: the default waits for the model list and the examples; until then the last visit's default, else nothing", () => {
    const paid = [info("tripo", true)];
    const demo = [info("mock", true)];
    const base = { picked: null, remembered: null, providers: undefined, examplesStatus: "idle", examplesCount: 0, timedOut: false };
    assert.deepEqual(lib.resolveStartMode(base), { mode: null, known: false }, "nothing known: a placeholder, not a guess");
    assert.deepEqual(lib.resolveStartMode({ ...base, providers: paid, examplesStatus: "loading" }), { mode: null, known: false }, "the examples are still on their way");
    assert.deepEqual(lib.resolveStartMode({ ...base, examplesStatus: "ready", examplesCount: 3 }), { mode: null, known: false }, "the model list is");
    assert.deepEqual(lib.resolveStartMode({ ...base, remembered: "prompts" }), { mode: "prompts", known: false }, "the last default paints at once");
    assert.deepEqual(lib.resolveStartMode({ ...base, providers: paid, examplesStatus: "ready", examplesCount: 3 }), { mode: "prompts", known: true });
    assert.deepEqual(lib.resolveStartMode({ ...base, providers: demo, examplesStatus: "ready", examplesCount: 3 }), { mode: "examples", known: true });
    assert.deepEqual(lib.resolveStartMode({ ...base, providers: demo, examplesStatus: "error" }), { mode: "prompts", known: true }, "no examples to show");
    assert.deepEqual(lib.resolveStartMode({ ...base, providers: demo, examplesStatus: "ready", examplesCount: 0 }), { mode: "prompts", known: true });
    // The visitor's own pick wins, known or not.
    assert.deepEqual(lib.resolveStartMode({ ...base, picked: "examples", providers: paid, examplesStatus: "ready", examplesCount: 3 }), { mode: "examples", known: true });
    assert.deepEqual(lib.resolveStartMode({ ...base, picked: "prompts" }), { mode: "prompts", known: true });
    // A list that never arrives must not leave the hero blank: after the wait it decides with what it has (the live site: examples).
    assert.deepEqual(lib.resolveStartMode({ ...base, timedOut: true }), { mode: "examples", known: false });
    assert.deepEqual(lib.resolveStartMode({ ...base, timedOut: true, examplesStatus: "error" }), { mode: "prompts", known: false });
});

await test("ux-10: the last default is remembered apart from the visitor's own pick", () => {
    assert.equal(lib.loadStartDefault(), null);
    lib.saveStartDefault("prompts");
    assert.equal(lib.loadStartDefault(), "prompts");
    assert.equal(lib.loadStartMode(), null, "it is not a choice the visitor made");
    storage.set("assembly-studio-start-default", "nonsense");
    assert.equal(lib.loadStartDefault(), null);
});

await test("ux-10: the hero shows a placeholder until the answers are in, then the row (rendered)", () => {
    const hero = () => render(h(MemoryRouter, null, h(lib.HeroStart, { onPick() {} })));
    let html = hero();
    assert.match(html, /data-testid="hero-start-pending"/);
    assert.doesNotMatch(html, /data-mode=/);
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 0, "neither row is pressed");
    storage.set("assembly-studio-start-default", "prompts");
    html = hero();
    assert.match(html, /data-mode="prompts"/);
    assert.doesNotMatch(html, /hero-start-pending/);
    storage.clear();
    lib.useWorkspaceStore.setState({ providers: { providers: [info("tripo", true)], default_provider: "tripo", access_required: false, daily_limit: 40, used_today: 0 } });
    lib.useExamplesStore.setState({ status: "ready", examples: [], error: null });
    assert.match(hero(), /data-mode="prompts"/, "no examples to show: prompts");
});

// ================= ux-11: a stalled save ends in Retry =================

/** The result a stabilizer that made `moves` would answer with, written by the real GLB writer. */
async function answerFor(source, moves) {
    const options = lib.optionsFor(lib.DEFAULT_CHOICES, source.settings);
    const built = await lib.buildStoppedResult({ source, moves, sourceDepth: 0, options, elapsedMs: 12 });
    return { ...built, stop: built.complete ? "stable" : "no-improving-move" };
}
const COLUMN_MOVE = () => ({ step: stepLog(1, "column", 4), cells: TIP_COLUMN.map((c) => [...c]), roles: TIP_COLUMN.map(() => "column") });

await test("ux-11: the upload is given a timeout; when it fires the card offers Retry, and Retry saves", async () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1", activeProjectId: "p1" });
    const source = measured(plainDesc(armCells(5)));
    const answer = await answerFor(source, [COLUMN_MOVE()]);
    assert.equal(answer.complete, true);
    lib.setStabilizeDeps({ run: async () => answer }); // the real upload (createDerivedModel -> fetch) stays
    // The timeout of the real run is 30 s: use a short one for the test, and remember what was asked.
    const asked = [];
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => (asked.push(ms), realTimeout.call(AbortSignal, 25));
    let attempt = 0;
    fake.derived = async ({ init, reply }) => {
        attempt += 1;
        if (attempt === 1) {
            // The server never answers: the request ends when its signal fires.
            await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
        }
        const bytes = new Uint8Array(await init.body.arrayBuffer());
        const read = lib.readAssemblyGlb(bytes, null);
        assert.ok(read.ok, read.error);
        return reply(201, { model: model("s1", { kind: "stabilized", source_model_id: "m1", derived: read.meta, analysis: read.meta.after_summary }) });
    };
    try {
        assert.equal(ST().start(m, source), true);
        await until(() => ST().status === "error");
        assert.deepEqual(asked, [lib.UPLOAD_TIMEOUT_MS]);
        assert.equal(lib.UPLOAD_TIMEOUT_MS, 30_000);
        assert.equal(ST().errorKind, "save");
        assert.match(ST().error, /took too long/i);
        assert.ok(ST().result, "the run's result is still there to retry or download");
        const html = render(h(lib.StabilizeCard, { model: m, result: source, verdict: VERDICT("fail", "2 problems"), analysing: false }));
        assert.match(html, /data-testid="stabilize-retry"/);
        assert.match(html, /Download GLB anyway/);
        await ST().save();
        assert.equal(ST().status, "saved");
        assert.equal(attempt, 2);
        assert.equal(S().models.some((x) => x.id === "s1"), true);
    } finally {
        AbortSignal.timeout = realTimeout;
    }
});

await test("ux-11: the Saving banner keeps Download GLB in reach", () => {
    const m = model("m1");
    lib.useWorkspaceStore.setState({ models: [m], activeModelId: "m1" });
    lib.useStabilizeStore.setState({ status: "saving", sourceModelId: "m1", sourcePrompt: "a shelf", result: stub(), steps: [], moves: [] });
    const html = render(h(lib.StabilizeCard, { model: m, result: measured(plainDesc(armCells(5))), verdict: VERDICT("fail", "2 problems"), analysing: false }));
    assert.match(html, /data-testid="stabilize-saving"/);
    assert.match(html, /data-testid="stabilize-download"/);
    assert.doesNotMatch(html, /data-testid="stabilize-discard"/, "it cannot be discarded while it uploads");
});

// ================= ux-12: the log of a saved run is one button away =================

await test("ux-12: the saved banner offers the steps of the run behind 'View n steps', once the version is on screen", () => {
    const m = model("m1");
    const kid = model("s1", { kind: "stabilized", source_model_id: "m1", derived: derivedMeta() });
    lib.useWorkspaceStore.setState({ models: [m, kid], activeModelId: "s1" });
    const steps = [stepLog(1, "column", 3), stepLog(2, "footing", 1)];
    lib.useStabilizeStore.setState({ status: "saved", sourceModelId: "m1", sourcePrompt: "a shelf", savedModelId: "s1", result: stub(), steps, moves: [] });
    const saved = measured(addedDesc(armCells(5), TIP_COLUMN));
    const card = () => render(h(lib.StabilizeCard, { model: kid, result: saved, verdict: VERDICT("pass", "Stable"), analysing: false }));
    // The new version's analysis has not landed yet: its steps cannot be shown.
    assert.doesNotMatch(card(), /stabilize-steps-toggle/);
    lib.useAnalysisStore.setState({ result: saved, resultModelId: "s1" });
    const html = card();
    assert.match(html, /data-testid="stabilize-steps-toggle"/);
    assert.match(html, /View 2 steps/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /data-testid="timeline-step"/, "collapsed by default");
});

// ================= the timeline's offset for a saved run =================

await test("the saved run's steps count from the steps the version already had", () => {
    const first = measured(addedDesc(armCells(5), TIP_COLUMN));
    assert.equal(lib.savedStepOffset(first, 1), 0);
    assert.equal(lib.savedStepOffset(first, 3), 0, "never negative");
    assert.equal(lib.stepOffsetOf(first), 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
