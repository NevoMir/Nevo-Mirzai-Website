// Rendered tests of the Optimization tab (src/assignment/components/optimize, store/optimize.ts): what a student reads in every state of the panel,
// and the run from a goal to a saved version, with the real optimizer and the real analysis (only Muse and the server are played).
//
//   node scripts/assignment/test-optimize-ui.mjs        (about a minute)
//
// The same approach as test-panel.mjs: one esbuild bundle with real React and react-dom/server, the stores set to the state under test and the
// components rendered to a string. `zustand` becomes a wrapper whose hooks read the current state, the toast library becomes a log, the
// optimizer's WASM url is the file in the repo. No DOM and no network (fetch is replaced by one that fails the test if it is called).
//
// What is pinned here (design-edit-optimize.md 6.4, 8.1 D):
//   - a base with problems is blocked ("Fix the problems first" and a way to the Stability tab); unsaved block changes ("Save your changes first");
//     the version caps; no model, no analysis yet
//   - the idle panel: the goal field and the four buttons, no filled button but none is needed; the buttons fill the controls WITHOUT a network call
//   - Muse's reading becomes controls one for one (and a goal it cannot work on keeps Run off); every control edits the spec the run will use
//   - a run follows the optimizer: the stage gets a preview (owner "optimize") and what changed, the work guard is held, Stop keeps the best state
//   - the result card: the sentence, the stop reason, Before | After | Change, Keep this version; Keep creates a version, puts it on the stage and
//     in the chat, and frees the guard; a failed save keeps the result (Retry, Download); Discard and Try again
//   - the words: no technical term in the visible text of any state
//   - the review's fixes: the Settings block budget in the plan and the run; a run that changed nothing says why (a Stop, a time-out, few blocks that
//     may go) and what to try; the plan's name follows the button and the controls; the goal's own figure (balance, sag) on the counters and the chart;
//     Stop says it was heard; a plan made before the Stability settings changed is dropped
import { build } from "esbuild";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node < 22.18 only strips types behind a flag (the helpers import the .ts sources); run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-optimize-ui-test");
mkdirSync(outDir, { recursive: true });
const WASM = path.join(root, "src/assignment/analysis/fem/vendor/lSolver.wasm");

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
export { React, renderToStaticMarkup };
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export { IDLE_RUN, sanitizeSettings, indexIssuesByBlock } from "@/assignment/store/analysisLogic";
export { verdictSentence } from "@/assignment/store/analysisBrief";
export { useStabilizeStore, setStabilizeDeps } from "@/assignment/store/stabilize";
export { acquireWork, currentWork, resetWorkGuard, workBusyMessage } from "@/assignment/store/workGuard";
export { useVoxelEditStore } from "@/assignment/store/voxelEdit";
export * from "@/assignment/store/optimize";
export * as Logic from "@/assignment/store/optimizeLogic";
export * as ChartLogic from "@/assignment/components/optimize/chartLogic";
export { default as OptimizePanel } from "@/assignment/components/optimize/OptimizePanel";
export { ResultCard } from "@/assignment/components/optimize/ResultCard";
export { RunStrip } from "@/assignment/components/optimize/RunStrip";
export { SpecControls } from "@/assignment/components/optimize/SpecControls";
export { GoalField } from "@/assignment/components/optimize/GoalField";
export { ConvergenceChart } from "@/assignment/components/optimize/ConvergenceChart";
export { runOptimize } from "@/assignment/analysis/optimize/runOptimize";
export * as RunOptimizeModule from "@/assignment/analysis/optimize/runOptimize";
export { analyzeAssembly } from "@/assignment/analysis/assembly";
export { applyStress, computeStress } from "@/assignment/analysis/stress";
export { solveFrameTs } from "@/assignment/analysis/fem/index";
export { descriptorFromBlocks, assemblyHash } from "@/assignment/shared/assembly";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { summarizeOptimize, crossCheckOptimized } from "@/assignment/shared/optimizeMeta";
export { presetSpec, repairSpec } from "@/assignment/shared/optimizeSpec";
export { technicalWordsIn } from "@/assignment/components/analysis/vocabulary";
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
    // REACT_DEV=1 builds React in development mode, which reports invalid markup (a button inside a button, a block in a paragraph) on console.error.
    define: { "process.env.NODE_ENV": process.env.REACT_DEV === "1" ? '"development"' : '"production"' },
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "error",
    plugins: [
        {
            name: "shims",
            setup(b) {
                b.onResolve({ filter: /^zustand$/ }, () => ({ path: "zustand-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                // Vite's `?url` import of the solver's WASM is the file itself in this test.
                b.onResolve({ filter: /lSolver\.wasm\?url$/ }, () => ({ path: "wasm-url", namespace: "shim" }));
                b.onLoad({ filter: /^wasm-url$/, namespace: "shim" }, () => ({ contents: `export default ${JSON.stringify(WASM)};`, loader: "js" }));
                b.onLoad({ filter: /^zustand-shim$/, namespace: "shim" }, () => ({ contents: ZUSTAND_SHIM, loader: "js", resolveDir: root }));
                b.onLoad({ filter: /^toast-shim$/, namespace: "shim" }, () => ({ contents: TOAST_SHIM, loader: "js" }));
            },
        },
    ],
});

// ---------- a browser, as far as these modules look ----------

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, String(v)), removeItem: (k) => void storage.delete(k) };
globalThis.window = {
    innerWidth: 1440,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
const reactWarnings = [];
if (process.env.REACT_DEV === "1") {
    const original = console.error;
    console.error = (...args) => {
        reactWarnings.push(args.map(String).join(" ").slice(0, 400));
        original(...args);
    };
}
let fetchCalls = 0;
globalThis.fetch = async (url, init) => {
    // The project is saved in the background when the chat gets a line that points at a model: that is not what is being counted.
    if (/\/projects\//.test(String(url)) && init?.method === "PATCH") return new Response(JSON.stringify({ project: { modified_at: iso() } }), { status: 200, headers: { "content-type": "application/json" } });
    fetchCalls++;
    throw new Error("the network is not used in this test");
};

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const { React, renderToStaticMarkup, Logic } = lib;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

const L = await import("./optimize-lib.mjs");

let passed = 0;
const failures = [];
async function test(name, fn) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
    resetAll();
    const t0 = performance.now();
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ").slice(0, 2400)}`);
    }
}

// ---------- reading the markup the way a student reads the screen ----------

const decode = (text) => text.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const visibleText = (html) =>
    decode(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, " ").replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const has = (html, testId) => html.includes(`data-testid="${testId}"`);
const countOf = (html, re) => (html.match(re) ?? []).length;
const tagOf = (html, id) => {
    const tag = html.match(new RegExp(`<[a-z0-9]+\\b[^<>]*data-testid="${id}"[^<>]*>`))?.[0];
    assert.ok(tag, `no element with data-testid="${id}"`);
    return tag;
};
const isDisabled = (tag) => /\sdisabled(=""|\s|>)/.test(tag);
const EXTRA_TECHNICAL = /compliance|objective|coordinate|voxel|\bFEM\b|utilis|cantilever|centre.of.gravity|\bCOG\b|kPa|MPa/i;
const assertPlain = (html, where) => {
    const text = visibleText(html);
    assert.deepEqual(lib.technicalWordsIn(text), [], `${where}: technical words in the visible text`);
    assert.doesNotMatch(text, EXTRA_TECHNICAL, `${where}: a technical word in "${text.match(EXTRA_TECHNICAL)?.[0]}"`);
};

// ---------- fixtures ----------

const S = () => lib.useWorkspaceStore.getState();
const AS = () => lib.useAnalysisStore.getState();
const OS = () => lib.useOptimizeStore.getState();
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const TS = { solve: lib.solveFrameTs, backend: "ts" };
const measured = (desc, settings = lib.sanitizeSettings(null)) => {
    const base = lib.analyzeAssembly(desc, null, settings);
    return lib.applyStress(base, lib.computeStress(base, TS));
};
const model = (id, over = {}) => ({
    id, project_id: "p1", job_id: "j1", provider: "hunyuan", prompt: "a wooden rocking chair", glb_url: `/${id}.glb`, thumbnail_url: null, size_bytes: 1000,
    part_count: 1, created_at: iso(), analysis: null, kind: "generated", source_model_id: null, example_slug: null, derived: null, edit: null, optimization: null, ...over,
});
const metrics = (over = {}) => ({ blocks: 28, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 0, cog_margin_mm: 120, max_utilisation: 0.5, overstressed_blocks: 0, ...over });
const derivedMeta = (over = {}) => ({
    version: 1, depth: 1, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.75, cantilever_limit: 4, fill_threshold: 0.3,
    complete: true, stop: "stable", added_blocks: 4, added_by_role: { column: 4 }, before: metrics({ errors: 2, max_utilisation: 1.06 }), after: metrics(),
    steps: [], duration_ms: 20, assembly_hash: "x", after_summary: null, created_at: iso(), ...over,
});

/** A bundled example, stabilized: a model with an assembly, no problem, something to take out. */
const example = (slug) => {
    const r = L.loadStabilized(slug);
    const m = model("m-" + slug, { kind: "stabilized", provider: "stabilizer", source_model_id: "root-" + slug, derived: derivedMeta() });
    const root = model("root-" + slug, { prompt: "a " + slug });
    return { r, m, root, result: measured(r.descriptor) };
};

const INITIAL_VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [], focus: null };
function resetAll() {
    lib.setOptimizeDeps();
    lib.resetOptimizeStore();
    lib.resetWorkGuard();
    lib.setStabilizeDeps();
    lib.useAnalysisStore.setState({
        settings: lib.sanitizeSettings(null), loaded: null, viewerFailure: null, run: lib.IDLE_RUN, result: null, resultModelId: null,
        blockIssues: new Map(), summaries: {}, view: INITIAL_VIEW, colorChoice: "status", preview: null, selection: null, stepSelection: null,
        selectionSerial: 0, layerRaised: false, hoverIssueId: null, attempt: 0, panelOpen: true, sheetOpen: false, openRequest: 0,
    });
    lib.useWorkspaceStore.setState({ models: [], activeModelId: null, activeProjectId: null, messages: [], jobs: {}, providers: null, workspaceTab: "optimize" });
    lib.toasts.length = 0;
    storage.clear();
    fetchCalls = 0;
}

/** Put `result` on screen for `m`, as the Stability tab would have it once its analysis landed. */
function show(m, result, others = []) {
    lib.useWorkspaceStore.setState({ models: [...others, m], activeModelId: m.id, activeProjectId: "p1" });
    // A stabilized version is drawn over the mesh it was made from: that is the file the viewer has loaded.
    let display = m;
    while (display.source_model_id && (display.kind === "stabilized" || display.kind === "optimized")) display = others.find((o) => o.id === display.source_model_id) ?? display;
    lib.useAnalysisStore.setState({
        loaded: { url: display.glb_url, assembly: null, extractTriangles: () => ({ positions: new Float32Array(0) }) },
        result, resultModelId: m.id, blockIssues: result ? lib.indexIssuesByBlock(result.issues) : new Map(),
    });
}
const panel = () => render(h(lib.OptimizePanel));

/** The deps of a test: the real optimizer and engine, part labels of a fixture, Muse and the upload played. */
function deps(over = {}) {
    const log = { plans: [], uploads: [], runs: 0 };
    lib.setOptimizeDeps({
        parts: async () => ({}),
        plan: async (body) => {
            log.plans.push(body);
            const spec = lib.presetSpec("lightest", { blocks: body.brief.blocks });
            return { spec: { ...spec, title: "Lightest, keep it standing", summary: "Take out hidden blocks and keep it standing.", notes: ["Read “cheaper” as fewer blocks."] }, changes: [], model: "meta/muse-spark-1.3-contributor", cost_usd: 0.0004, ms: 5 };
        },
        upload: async (sourceId, bytes) => {
            const read = L.glb.readAssemblyGlb(bytes);
            assert.ok(read.ok && read.optimization, "the file carries the log");
            log.uploads.push({ sourceId, bytes, log: read.optimization });
            const id = "opt-" + log.uploads.length;
            return model(id, {
                kind: "optimized", provider: "optimizer", source_model_id: sourceId, optimization: lib.summarizeOptimize(read.optimization), analysis: read.optimization.after_summary,
            });
        },
        ...over,
    });
    return log;
}

const until = async (cond, what, ms = 60000) => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (phase ${OS().phase})`);
        await new Promise((r) => setTimeout(r, 10));
    }
};

// ================= before there is a plan =================

await test("no model, no analysis yet, an unavailable view: the tab says so and offers nothing to press", () => {
    let html = panel();
    assert.equal(tagOf(html, "optimize-panel").includes('data-eligibility="none"'), true);
    assert.match(visibleText(html), /No model to optimize yet/);
    assert.ok(!has(html, "optimize-goal") && !has(html, "optimize-run"));
    const e = example("cantilever-house");
    lib.useWorkspaceStore.setState({ models: [e.root, e.m], activeModelId: e.m.id, activeProjectId: "p1" });
    html = panel();
    assert.match(tagOf(html, "optimize-panel"), /data-eligibility="waiting"/);
    assert.match(visibleText(html), /Reading the model/);
    lib.useAnalysisStore.setState({ viewerFailure: { url: e.root.glb_url, message: "WebGL is not available." } });
    html = panel();
    assert.match(tagOf(html, "optimize-panel"), /data-eligibility="unavailable"/);
    assert.match(visibleText(html), /cannot show this model/);
    assertPlain(html, "no model");
});

await test("a base with problems is blocked: 'Fix the problems first' and a way to the Stability tab", () => {
    const bad = lib.descriptorFromBlocks([[0, 0, 0], ...Array.from({ length: 7 }, (_, i) => [i, 0, 1]), [8, 8, 5], [8, 8, 6]].map((cell) => ({ cell })));
    const m = model("bad");
    show(m, measured(bad));
    assert.ok(AS().result.summary.errors > 0);
    const html = panel();
    assert.match(tagOf(html, "optimize-panel"), /data-eligibility="errors"/);
    const text = visibleText(html);
    assert.match(text, /Fix the problems first/);
    assert.match(text, /Optimization starts from a structure that stands/);
    assert.ok(has(html, "optimize-go-stability"));
    assert.ok(!has(html, "optimize-goal") && !has(html, "optimize-chips"), "no goal field on a base with problems");
    assertPlain(html, "blocked");
});

await test("unsaved block changes are blocked: 'Save your changes first' with a Save version button", () => {
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    lib.useVoxelEditStore.setState({ sourceModelId: e.m.id, draft: { count: 2, redo: 0, last: "Added a shelf.", full: false, blocks: 150, baseBlocks: 139 } });
    try {
        const html = panel();
        assert.match(tagOf(html, "optimize-panel"), /data-eligibility="draft"/);
        assert.match(visibleText(html), /Save your changes first/);
        assert.ok(has(html, "optimize-save-draft"));
        assert.ok(!has(html, "optimize-chips"));
    } finally {
        lib.useVoxelEditStore.setState({ sourceModelId: null, draft: null });
    }
});

await test("the version caps block a run with a sentence that says what to do", () => {
    const e = example("cantilever-house");
    const siblings = Array.from({ length: 10 }, (_, i) => model("v" + i, { kind: "optimized", provider: "optimizer", source_model_id: e.m.id, created_at: iso(i + 1), optimization: null }));
    show(e.m, e.result, [e.root, ...siblings]);
    const html = panel();
    assert.match(tagOf(html, "optimize-panel"), /data-eligibility="limit"/);
    assert.match(visibleText(html), /10 versions have been made from this one already\. Delete one in the Models tab/);
    assert.ok(!has(html, "optimize-chips"));
});

await test("an eligible version: the goal field and the four buttons, the figures of now, nothing to run yet", () => {
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    const html = panel();
    assert.match(tagOf(html, "optimize-panel"), /data-eligibility="ok"/);
    assert.ok(has(html, "optimize-goal") && has(html, "optimize-goal-input"));
    assert.equal(countOf(html, /data-testid="optimize-chip-[a-z-]+"/g), 4);
    for (const label of ["Lightest", "Strongest", "Best balanced", "Stiffest"]) assert.match(visibleText(html), new RegExp(label));
    assert.match(visibleText(html), /Now 139 blocks · 334 kg · strength used 6\d%/);
    assert.match(visibleText(html), /e\.g\. “as light as possible, keep the seat”|What should it do\?/);
    assert.ok(!has(html, "optimize-run"), "no run before there is a plan");
    assert.ok(isDisabled(tagOf(html, "optimize-plan")), "the sparkle waits for words");
    assert.match(tagOf(html, "optimize-subtitle"), /title="a wooden rocking chair"/);
    assertPlain(html, "idle");
    // Muse is not set up on the server: the sparkle is off and says so, the buttons are on
    lib.useWorkspaceStore.setState({ providers: { providers: [], default_provider: null, access_required: false, daily_limit: null, used_today: 0, assist: { available: false, queued: false, images: false, model: "", daily_limit: null, used_today: 0 } } });
    lib.useOptimizeStore.setState({ goalText: "make it light" });
    const off = panel();
    assert.ok(isDisabled(tagOf(off, "optimize-plan")));
    assert.match(visibleText(off), /Pick one of the four goals/);
    assert.ok(!isDisabled(tagOf(off, "optimize-chip-lightest")));
});

// ================= a button fills the controls at once =================

await test("a button fills the controls with no network call; the controls are the spec, one for one", async () => {
    const log = deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    assert.equal(fetchCalls, 0);
    assert.equal(log.plans.length, 0, "no call to Muse");
    assert.equal(OS().phase, "ready");
    assert.equal(OS().goalLabel, "Lightest");
    const html = panel();
    assert.match(tagOf(html, "optimize-plan"), /data-actionable="true"/);
    assert.equal(visibleText(html).includes("“Lightest”"), true);
    for (const id of ["optimize-controls", "optimize-aim", "optimize-group-limits", "optimize-limit-strength", "optimize-limit-balance", "optimize-limit-overhang", "optimize-blocks", "optimize-removable", "optimize-may", "optimize-protect", "optimize-today", "optimize-run", "optimize-reset"]) {
        assert.ok(has(html, id), `${id} is on the panel`);
    }
    // the aim, the limits and the scope say what the spec says
    assert.match(html, /role="radio" aria-checked="true"[^>]*>Lightest</);
    assert.match(tagOf(html, "optimize-limit-strength-value") ? html : "", /75%/);
    assert.match(visibleText(html), /Strength used at most 75%/);
    assert.match(visibleText(html), /Weight inside the base by 100 mm/);
    assert.match(visibleText(html), /Longest overhang 4 blocks/);
    assert.match(html, /data-testid="optimize-removable-inner"[^>]*checked/);
    // the Today rows hold the limits against the start
    assert.equal(countOf(html, /data-row="(strength|balance|overhang|blocks)"/g), 4);
    assert.doesNotMatch(html, /data-ok="false"/);
    assertPlain(html, "ready (chip)");
    // every chip works the same, and a second chip replaces the first plan
    for (const [chip, aim, allow] of [["strongest", "peak_stress", "both"], ["most-stable", "cog_margin", "both"], ["stiffest", "deflection", "both"]]) {
        await OS().chooseChip(e.m, AS().result, chip);
        assert.equal(OS().phase, "ready");
        assert.ok(OS().spec.objective.some((t) => t.metric === aim), chip);
        assert.equal(OS().spec.moves.allow, allow);
    }
    assert.equal(fetchCalls, 0);
});

await test("a control edits the spec and the page cleans it again: the figures it will use follow", async () => {
    deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    const { Logic: Lg } = lib;
    OS().editSpec((s) => Lg.withConstraint(s, "max_stress_pct", 60));
    assert.equal(OS().spec.constraints.max_stress_pct, 60);
    assert.equal(OS().effective.maxStressPct, 60);
    OS().editSpec((s) => Lg.withAim(s, "balanced"));
    assert.equal(Lg.aimOf(OS().spec), "balanced");
    assert.equal(OS().spec.moves.allow, "both", "a goal that adds blocks needs adding allowed");
    assert.ok(OS().warnings.some((w) => /No block budget/.test(w)), "and gets a budget with a warning");
    OS().editSpec((s) => Lg.withBlocks(s, "extra", 12, 139));
    assert.equal(OS().effective.maxBlocks, 139 + 12);
    OS().editSpec((s) => Lg.withMay(s, "add", false));
    assert.equal(OS().spec.moves.allow, "remove");
    OS().editSpec((s) => Lg.withMay(s, "remove", false));
    assert.equal(OS().spec.moves.allow, "remove", "at least one switch stays on");
    OS().editSpec((s) => Lg.withAim(Lg.withAim(s, "lightest"), "mix"));
    assert.equal(OS().spec.objective.length, 2);
    OS().editSpec((s) => Lg.withShare(s, "blocks", 80));
    assert.deepEqual(Lg.sharesOf(OS().spec).map((x) => x.share), [80, 20]);
    OS().editSpec((s) => Lg.withMetricAdded(s, "deflection"));
    assert.equal(OS().spec.objective.length, 3);
    OS().editSpec((s) => Lg.withMetricAdded(s, "cog_margin"));
    assert.equal(OS().spec.objective.length, 3, "three at most");
    // junk through a control is cleaned (a stress limit of 500 % is 100 %)
    OS().editSpec((s) => ({ ...s, constraints: { ...s.constraints, max_stress_pct: 500 } }));
    assert.equal(OS().spec.constraints.max_stress_pct, 100);
    // the mix is on the panel with its priorities
    const html = panel();
    assert.equal(countOf(html, /data-testid="optimize-mix-[a-z_]+"/g), 3);
    assertPlain(html, "ready (mix)");
    // reset puts Muse's (here: the button's) plan back
    OS().resetSpec();
    assert.equal(Lg.aimOf(OS().spec), "lightest");
    // the protection chips and their menu
    const a = lib.useOptimizeStore.getState();
    OS().editSpec((s) => Lg.withProtection(s, { mode: "keep", part: null, box: Lg.layerBox("top", 2, a.brief) }));
    assert.equal(OS().spec.protected.length, 1);
    assert.match(visibleText(panel()), /top 2 layers/);
    // the pointer on its chip lights its blocks on the stage; off again when it leaves; a pick of the person's is not replaced
    OS().peekProtection(0);
    const lit = AS().view.highlight;
    assert.ok(lit.length > 0 && lit.every((i) => AS().result.blocks[i].cell[2] >= a.brief.extent.max[2] - 1), "the top two layers");
    OS().peekProtection(null);
    assert.deepEqual(AS().view.highlight, []);
    lib.useAnalysisStore.setState((s) => ({ view: { ...s.view, highlight: [3] } }));
    OS().peekProtection(0);
    assert.deepEqual(AS().view.highlight, [3], "the person's own pick stays");
    lib.useAnalysisStore.setState((s) => ({ view: { ...s.view, highlight: [] } }));
    OS().peekProtection(0);
    OS().editSpec((s) => Lg.withoutProtection(s, 0));
    assert.deepEqual(AS().view.highlight, [], "a chip that goes takes its light with it");
    assert.equal(OS().spec.protected.length, 0);
});

await test("Muse's reading becomes controls: its notes in amber, the changes the cleaning made, a goal it cannot work on keeps Run off", async () => {
    const log = deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    lib.useOptimizeStore.setState({ goalText: "make it cheaper but don't touch the roof" });
    await OS().planGoal(e.m, AS().result);
    assert.equal(log.plans.length, 1);
    assert.equal(log.plans[0].goal, "make it cheaper but don't touch the roof");
    assert.ok(log.plans[0].brief.blocks === 139 && Array.isArray(log.plans[0].brief.parts));
    assert.ok(JSON.stringify(log.plans[0]).length < 6 * 1024, "within the Worker's body limit");
    assert.equal(OS().phase, "ready");
    assert.equal(OS().goalLabel, "make it cheaper but don't touch the roof");
    let html = panel();
    assert.match(visibleText(html), /“make it cheaper but don't touch the roof”/);
    assert.match(visibleText(html), /Take out hidden blocks and keep it standing/);
    assert.match(visibleText(html), /Read “cheaper” as fewer blocks/);
    assert.ok(!isDisabled(tagOf(html, "optimize-run")));
    assertPlain(html, "ready (muse)");
    // not actionable
    lib.setOptimizeDeps({ parts: async () => ({}), plan: async () => ({ spec: { ...lib.presetSpec("lightest", { blocks: 139 }), actionable: false, notes: ["Colours are not something this can change."] }, changes: [], model: "m", cost_usd: null, ms: 1 }) });
    OS().discard();
    lib.useOptimizeStore.setState({ goalText: "paint it red" });
    await OS().planGoal(e.m, AS().result);
    html = panel();
    assert.match(tagOf(html, "optimize-plan"), /data-actionable="false"/);
    assert.ok(isDisabled(tagOf(html, "optimize-run")));
    assert.ok(has(html, "optimize-not-actionable"));
    assert.match(visibleText(html), /Colours are not something this can change/);
    // taking over a control makes it a plan
    OS().editSpec((s) => lib.Logic.withAim(s, "stiffest"));
    html = panel();
    assert.match(tagOf(html, "optimize-plan"), /data-actionable="true"/);
    assert.ok(!isDisabled(tagOf(html, "optimize-run")));
});

await test("when Muse cannot be reached the words stay, the buttons still work, and the notice says so", async () => {
    deps({ plan: async () => { const e = new Error("down"); e.status = 504; throw e; } });
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    lib.useOptimizeStore.setState({ goalText: "as light as possible" });
    await OS().planGoal(e.m, AS().result);
    assert.equal(OS().phase, "idle");
    assert.equal(OS().goalText, "as light as possible");
    const html = panel();
    assert.match(visibleText(html), /Muse did not answer\. The four buttons below still work\./);
    assert.ok(!isDisabled(tagOf(html, "optimize-chip-lightest")));
    for (const [status, word] of [[429, /limit/], [503, /not set up/], [422, /could not take/]]) {
        assert.match(lib.Logic.planErrorMessage(Object.assign(new Error("x"), { status })), word);
    }
    // Stop while it is reading
    let release;
    deps({ plan: (_, signal) => new Promise((_, reject) => { release = () => reject(new DOMException("stopped", "AbortError")); signal.addEventListener("abort", release); }) });
    const reading = OS().planGoal(e.m, AS().result);
    await until(() => OS().phase === "planning", "planning");
    const html2 = panel();
    assert.match(visibleText(html2), /Reading your goal/);
    assert.ok(has(html2, "optimize-stop-plan"));
    OS().cancel();
    await reading;
    assert.equal(OS().phase, "idle");
    assert.equal(OS().notice, null, "stopping is not an error");
});

// ================= a run, from the first round to a saved version =================

await test("a run: the stage gets a preview and what changed, the work guard is held, the result is a card that can be kept", async () => {
    const log = deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    const sawPreview = { owner: null, diff: null, work: null, running: null };
    const unsubscribe = lib.useAnalysisStore.subscribe((s) => {
        if (s.preview) sawPreview.owner = s.preview.owner;
        if (s.view.diff && (s.view.diff.removed.length > 0 || s.view.diff.added.length > 0)) sawPreview.diff = s.view.diff;
    });
    OS().run();
    assert.equal(OS().phase, "running");
    sawPreview.work = lib.currentWork();
    assert.equal(sawPreview.work.kind, "optimize");
    assert.equal(sawPreview.work.label, "Optimizing");
    assert.match(lib.workBusyMessage("stabilize", "p1"), /Finish or discard the optimization first/);
    assert.equal(lib.acquireWork("stabilize", "p1"), null, "the stabilizer may not start meanwhile");
    await until(() => OS().history.length > 1, "a first round");
    const running = panel();
    assert.ok(has(running, "optimize-running"));
    assert.match(visibleText(running), /Optimizing · \d+ s of ~10 s/);
    assert.ok(has(running, "optimize-stop") && has(running, "optimize-chart"));
    assert.match(visibleText(running), /Round \d+ · 139 → \d+ blocks/);
    assertPlain(running, "running");
    await until(() => OS().phase === "result", "the result");
    unsubscribe();
    assert.equal(sawPreview.owner, "optimize", "the preview slot is the optimizer's");
    assert.ok(sawPreview.diff && sawPreview.diff.removed.length > 0, "what was taken out is marked on the stage while it runs");
    const wire = OS().result;
    assert.equal(wire.result.stop, "converged");
    assert.ok(wire.meta.feasible && wire.changed && wire.meta.after.blocks < wire.meta.before.blocks);
    assert.ok(Math.abs(wire.meta.after.blocks - 119) <= 3, `${wire.meta.after.blocks} blocks`);
    // the stage: the result as a preview, the changes marked, the rest dimmed
    assert.equal(AS().preview.modelId, e.m.id);
    assert.equal(AS().preview.result.stats.blockCount, wire.meta.after.blocks);
    const diff = AS().view.diff;
    assert.equal(diff.dimRest, true);
    assert.deepEqual(diff.removed.length, wire.meta.removed.length);
    assert.equal(lib.currentWork().waiting, true, "the guard is held while the result waits (the tab shows a dot)");
    // the card
    const html = panel();
    assert.ok(has(html, "optimize-result"));
    assert.match(tagOf(html, "optimize-result"), /data-keepable="true"/);
    const text = visibleText(html);
    assert.match(text, /Lighter by \d+ blocks \(−\d+%\) and still stands\./);
    assert.match(text, /No single block can change without breaking a limit or making the goal worse\./);
    for (const row of ["blocks", "weight", "strength", "balance", "overhang", "sag", "checks"]) assert.ok(html.includes(`data-row="${row}"`), `row ${row}`);
    assert.match(text, /Before After Change/);
    assert.match(text, /Blocks 139 \d+ −\d+/);
    assert.match(text, /Strength used rises, up to the limit you set \(75%\)/);
    assert.ok(has(html, "optimize-keep") && has(html, "optimize-discard") && has(html, "optimize-try-again") && has(html, "optimize-download"));
    assert.match(text, /An estimate, not a certificate/);
    assertPlain(html, "result");
    // Before | After | Changes
    OS().setCompare("before");
    assert.equal(AS().preview, null, "before: the version itself");
    assert.equal(AS().view.diff, null);
    OS().setCompare("after");
    await until(() => AS().preview !== null, "after");
    assert.equal(AS().view.diff, null);
    OS().setCompare("changes");
    await until(() => AS().view.diff !== null, "changes");
    assert.equal(AS().view.diff.removed.length, wire.meta.removed.length);
    // the round slider
    OS().scrubTo(1);
    await until(() => AS().preview?.result.stats.blockCount !== wire.meta.after.blocks, "round 1");
    assert.ok(AS().preview.result.stats.blockCount > wire.meta.after.blocks && AS().preview.result.stats.blockCount < wire.meta.before.blocks);
    OS().scrubTo(null);
    await until(() => AS().preview?.result.stats.blockCount === wire.meta.after.blocks, "the end");

    // Keep this version
    await OS().keep();
    assert.equal(OS().phase, "saved");
    assert.equal(log.uploads.length, 1);
    assert.equal(log.uploads[0].sourceId, e.m.id);
    const sent = L.glb.readAssemblyGlb(log.uploads[0].bytes);
    assert.equal(L.MC.crossCheckOptimized(sent.descriptor, sent.optimization, { kind: "stabilized", assembly_hash: await L.asm.assemblyHash(e.r.descriptor) }), null, "the server would accept it");
    const saved = S().models.find((m) => m.kind === "optimized");
    assert.ok(saved, "the version is in the project");
    assert.equal(S().activeModelId, saved.id, "and on the stage");
    assert.equal(AS().preview, null); assert.equal(AS().view.diff, null);
    assert.equal(lib.currentWork(), null, "the guard is free");
    const note = S().messages.find((m) => m.model_ids?.includes(saved.id));
    assert.ok(note, "the chat presents it");
    assert.match(note.content, /^Optimized v\d+ · Lightest — 139 → 1\d\d blocks \(−\d+%\)\.$/);
    assert.deepEqual(lib.toasts.map((t) => t.title), ["Switched to the optimized version"]);
    const after = visibleText(panel());
    assert.match(after, /This is the optimized version/);
    assert.match(after, /Optimize again…/);
    assert.equal(fetchCalls, 0);
});

await test("Stop keeps the best state it had: the result says you stopped it, and it can be kept", async () => {
    const log = deps();
    const e = example("mushroom-pavilion");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().history.length > 3, "some rounds");
    assert.equal(OS().stopping, false);
    OS().cancel();
    // until the run answers, the button says it was heard (it used to invite a second click) and cannot be pressed again
    assert.equal(OS().stopping, true);
    const stopping = panel();
    assert.match(visibleText(stopping), /Stopping…/);
    assert.ok(isDisabled(tagOf(stopping, "optimize-stop")));
    await until(() => OS().phase === "result", "the result after Stop");
    assert.equal(OS().stopping, false);
    const wire = OS().result;
    assert.equal(wire.result.stop, "canceled");
    assert.ok(wire.meta.feasible && wire.meta.after.blocks < wire.meta.before.blocks && wire.meta.after.errors === 0);
    const html = panel();
    assert.match(visibleText(html), /You stopped it at round \d+\. This is the best valid state it had reached\./);
    assert.ok(has(html, "optimize-keep"));
    await OS().keep();
    assert.equal(OS().phase, "saved");
    assert.equal(log.uploads.length, 1);
});

await test("a result that changes nothing, or breaks a limit, cannot be kept: it says why and the guard is free", async () => {
    deps();
    const e = example("desk-lamp");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().phase === "result", "the result");
    assert.equal(OS().result.changed, false);
    let html = panel();
    assert.match(tagOf(html, "optimize-result"), /data-keepable="false"/);
    assert.match(visibleText(html), /Already as good as this goal allows\./);
    assert.ok(!has(html, "optimize-keep"));
    assert.ok(has(html, "optimize-try-again") && has(html, "optimize-discard"));
    assert.equal(lib.currentWork(), null, "nothing to decide, nothing held");
    assert.equal(AS().preview, null);
    assertPlain(html, "result (nothing)");
    // Try again goes back to the limits; an impossible limit is infeasible
    OS().tryAgain();
    assert.equal(OS().phase, "ready");
    OS().editSpec((s) => lib.Logic.withConstraint(s, "max_stress_pct", 20));
    OS().run();
    await until(() => OS().phase === "result", "the infeasible result");
    assert.equal(OS().result.meta.feasible, false);
    html = panel();
    assert.match(visibleText(html), /could not meet every limit/);
    assert.ok(!has(html, "optimize-keep"));
    await OS().keep();
    assert.equal(OS().phase, "result", "keep does nothing for a result that cannot be kept");
    assertPlain(html, "result (infeasible)");
});

await test("a failed save keeps the result: Retry and Download; the retry saves it", async () => {
    let calls = 0;
    const log = deps({
        upload: async (sourceId, bytes) => {
            calls++;
            if (calls === 1) throw new Error("The server took too long to answer.");
            const read = L.glb.readAssemblyGlb(bytes);
            log.uploads.push({ sourceId });
            return model("opt-ok", { kind: "optimized", provider: "optimizer", source_model_id: sourceId, optimization: lib.summarizeOptimize(read.optimization) });
        },
    });
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().phase === "result", "the result");
    await OS().keep();
    assert.equal(OS().phase, "error");
    assert.equal(OS().errorKind, "save");
    const html = panel();
    assert.match(visibleText(html), /Could not save to the project/);
    assert.match(visibleText(html), /The server took too long to answer\./);
    assert.ok(has(html, "optimize-retry") && /Download GLB anyway/.test(visibleText(html)));
    assert.ok(OS().result, "the result is still in hand");
    assert.equal(lib.currentWork().kind, "optimize", "and the guard still held");
    assert.deepEqual(lib.toasts.map((t) => t.kind), ["error"]);
    await OS().keep();
    assert.equal(OS().phase, "saved");
    assert.ok(S().models.some((m) => m.id === "opt-ok"));
});

await test("a run that throws is an error with a way back; Discard frees everything", async () => {
    deps({ run: async () => { throw new Error("The optimizer ran out of memory."); } });
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().phase === "error", "the error");
    assert.equal(OS().errorKind, "run");
    assert.equal(lib.currentWork(), null);
    const html = panel();
    assert.match(visibleText(html), /The optimization failed/);
    assert.match(visibleText(html), /ran out of memory/);
    assert.equal(AS().preview, null);
    OS().tryAgain();
    assert.equal(OS().phase, "ready");
    OS().discard();
    assert.equal(OS().phase, "idle");
    assert.equal(OS().spec, null);
});

await test("one piece of work at a time: Run is refused while the stabilizer or another run holds the guard", async () => {
    deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    const release = lib.acquireWork("stabilize", "p1");
    assert.ok(release);
    OS().run();
    assert.equal(OS().phase, "ready", "the run did not start");
    assert.match(OS().notice, /Finish or discard the stabilizing first/);
    assert.match(visibleText(panel()), /Finish or discard the stabilizing first/);
    release();
    OS().run();
    assert.equal(OS().phase, "running");
    OS().cancel();
    await until(() => OS().phase !== "running", "the end");
    assert.notEqual(OS().phase, "error");
    assert.equal(lib.currentWork() === null || OS().phase === "result", true);
});

await test("a run belongs to its version and its project: another version sees a strip, another project stops it", async () => {
    deps();
    const e = example("cantilever-house");
    const other = model("other", { prompt: "a second model" });
    show(e.m, e.result, [e.root, other]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().history.length > 2, "rounds");
    // the person looks at another version: the run goes on, the panel there says so, the marks of the changes are not drawn on it
    lib.useWorkspaceStore.setState({ activeModelId: other.id });
    assert.equal(OS().phase, "running");
    const html = panel();
    assert.ok(has(html, "optimize-elsewhere"));
    assert.match(visibleText(html), /Optimizing another version/);
    assert.ok(has(html, "optimize-go-source"));
    assert.ok(!AS().view.diff, "no marks on another version");
    // and back
    lib.useWorkspaceStore.setState({ activeModelId: e.m.id });
    assert.ok(has(panel(), "optimize-running"));
    // another project stops it
    lib.useWorkspaceStore.setState({ activeProjectId: "p2" });
    assert.equal(OS().phase, "idle");
    assert.equal(lib.currentWork(), null);
    assert.equal(AS().preview, null);
    assert.ok(!AS().view.diff);
});

await test("a plan made for one version is dropped when another is opened", async () => {
    deps();
    const e = example("cantilever-house");
    const other = model("other", { prompt: "a second model" });
    show(e.m, e.result, [e.root, other]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    assert.equal(OS().phase, "ready");
    lib.useWorkspaceStore.setState({ activeModelId: other.id });
    assert.equal(OS().phase, "idle");
    assert.equal(OS().spec, null);
});

await test("from an original mesh: the log records no source hash and no stabilization", async () => {
    const log = deps();
    const r = L.loadStabilized("pencil-leg-chair");
    // the original mesh's own blocks (role original, step 0) as the analysis of a generated model
    const plain = lib.descriptorFromBlocks(Array.from({ length: r.descriptor.cells.length / 5 }, (_, i) => ({ cell: [r.descriptor.cells[5 * i], r.descriptor.cells[5 * i + 1], r.descriptor.cells[5 * i + 2]] })));
    const m = model("gen");
    const result = measured(plain);
    show(m, result);
    if (result.summary.errors > 0) return; // the fixture needs a standing original; the chair's blocks with the supports kept as plain blocks stand
    await OS().chooseChip(m, AS().result, "most-stable");
    OS().run();
    await until(() => OS().phase === "result", "the result");
    const meta = OS().result.meta;
    assert.equal(meta.source_hash, null);
    assert.equal(meta.stabilized_depth, 0);
    assert.equal(meta.goal, "Best balanced");
    await OS().keep();
    assert.equal(log.uploads[0].log.source_hash, null);
});

await test("a saved optimized version: a note of what it did, and 'Show what changed' marks what the log took out and put in", async () => {
    const e = example("cantilever-house");
    const solver = await L.getSolver();
    const settings = L.settingsMod.normalizeSettings({});
    const ctx = L.OA.specContextOf(e.r.descriptor, settings, solver, {});
    const spec = L.SL.presetSpec("most-stable", ctx.start);
    const run = await L.OA.optimizeAssembly({ assembly: e.r.descriptor, settings, spec, goal: "Best balanced", source: "blocks", parts: {}, stabilizedDepth: 1 }, { solver });
    assert.ok(run.meta.added > 0 || run.meta.removed.length > 0);
    const m = model("opt1", { kind: "optimized", provider: "optimizer", source_model_id: e.m.id, optimization: lib.summarizeOptimize(run.meta) });
    deps({ readLog: async () => run.meta });
    show(m, measured(run.descriptor), [e.root, e.m]);
    let html = panel();
    assert.ok(has(html, "optimize-version-note"));
    assert.match(visibleText(html), /Made by optimizing for “Best balanced” ?: 139 → \d+ blocks/);
    assert.match(visibleText(html), /Show what changed/);
    await OS().toggleChanges(m);
    const diff = AS().view.diff;
    assert.ok(diff && diff.dimRest === true);
    assert.equal(diff.removed.length, run.meta.removed.length);
    assert.equal(diff.added.length, run.meta.added, "the new blocks are the ones of the log's own step");
    html = panel();
    assert.match(visibleText(html), /Hide what changed/);
    assert.match(tagOf(html, "optimize-show-changes"), /aria-pressed="true"/);
    // another version on screen: the marks are off
    lib.useWorkspaceStore.setState({ activeModelId: e.m.id });
    assert.equal(AS().view.diff, null);
    assert.equal(OS().changesOf, null);
    // the same again hides; a log that cannot be read says so
    lib.useWorkspaceStore.setState({ activeModelId: m.id });
    await OS().toggleChanges(m);
    assert.ok(AS().view.diff);
    await OS().toggleChanges(m);
    assert.equal(AS().view.diff, null);
    deps({ readLog: async () => null });
    await OS().toggleChanges(m);
    assert.equal(AS().view.diff, null);
    assert.match(visibleText(panel()), /could not be read/);
    assertPlain(panel(), "saved version note");
    // a version that is not an optimized one has no note
    show(e.m, e.result, [e.root]);
    assert.ok(!has(panel(), "optimize-version-note"));
});

// ================= the review's fixes =================

await test("the block budget of the Stability tab is the plan's limit and the run keeps to it (the review's OPT-1)", async () => {
    deps();
    const e = example("pencil-leg-chair");
    const n0 = e.r.descriptor.cells.length / 5;
    const settings = lib.sanitizeSettings({ maxBlocks: n0 + 2 });
    lib.useAnalysisStore.setState({ settings });
    show(e.m, measured(e.r.descriptor, settings), [e.root]);
    await OS().chooseChip(e.m, AS().result, "strongest");
    assert.equal(OS().effective.maxBlocks, n0 + 2);
    const text = visibleText(panel());
    assert.match(text, new RegExp(`Blocks ${n0} \\(up to ${n0 + 2}\\)`), "the Today row reads against the budget, not against +10");
    assert.match(text, /block budget in Settings is \d+/);
    OS().run();
    await until(() => OS().phase === "result", "the result");
    const wire = OS().result;
    assert.ok(wire.meta.after.blocks <= n0 + 2, `${wire.meta.after.blocks} blocks over a budget of ${n0 + 2}`);
    assert.equal(wire.meta.after.errors, 0, "the Stability tab marks nothing in it");
    assert.match(tagOf(panel(), "optimize-result"), /data-keepable="true"/);
});

await test("a result that changed nothing says why, and what to try (the review's OPT-4)", async () => {
    deps();
    // the lamp: everything that may go was tried, and the run proved it
    const lamp = example("desk-lamp");
    show(lamp.m, lamp.result, [lamp.root]);
    await OS().chooseChip(lamp.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().phase === "result", "the lamp");
    assert.equal(OS().result.changed, false);
    let text = visibleText(panel());
    assert.match(text, /Already as good as this goal allows\. No single block can change without breaking a limit or making the goal worse\./);
    assert.doesNotMatch(text, /Only \d+ of \d+ blocks may be taken out/);
    OS().discard();
    // the crane: almost nothing may go, and that is the reason
    const crane = example("harbour-crane");
    show(crane.m, crane.result, [crane.root]);
    await OS().chooseChip(crane.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().phase === "result", "the crane");
    assert.equal(OS().result.changed, false);
    const wire = OS().result;
    const html = panel();
    assert.match(visibleText(html), /Already as good as this goal allows\. Only 2 of 65 blocks may be taken out with these settings\. Choose “Any block” under May change to free more\./);
    assertPlain(html, "result (nothing, few removable)");
    // a Stop, a time-out and a spent budget are not "as good as it gets": the reason comes first
    for (const [stop, headline, next] of [
        ["canceled", /You stopped it before it changed anything\./, /You stopped it at round \d+\. Press Optimize again and give it a few seconds\./],
        ["time-budget", /It ran out of time before it found a change\./, /Try Thorough, which gives it more time, or loosen a limit\./],
        ["max-solves", /It used up its checks before it found a change\./, /Loosen a limit, or let more blocks change, and try again\./],
        ["budget-used", /There is no room to put more blocks in\./, /Raise the block limit, or let it take blocks away\./],
    ]) {
        lib.useOptimizeStore.setState({ result: { ...wire, result: { ...wire.result, stop, complete: false } } });
        const card = panel();
        text = visibleText(card);
        assert.match(text, headline, stop);
        assert.match(text, next, stop);
        assert.doesNotMatch(text, /Already as good as this goal allows/, stop);
        assert.ok(!has(card, "optimize-keep"), "nothing to keep");
        assertPlain(card, `result (nothing, ${stop})`);
    }
    // a run that stopped on its own accord without proof does not claim the proof
    lib.useOptimizeStore.setState({ result: { ...wire, result: { ...wire.result, stop: "converged", complete: false } } });
    text = visibleText(panel());
    assert.match(text, /It stopped when the changes it tried no longer helped\./);
    assert.doesNotMatch(text, /No single block can change/);
    // the words themselves
    const Lg = lib.Logic;
    assert.equal(Lg.stopWords({ stop: "converged", complete: true }), Lg.SWEEP_COMPLETE_WORDS);
    assert.equal(Lg.stopWords({ stop: "converged", complete: false }), Lg.STOP_WORDS.converged);
    assert.equal(Lg.stopWords({ stop: "converged" }), Lg.STOP_WORDS.converged);
    assert.equal(Lg.stopWords({ stop: "time-budget", complete: true }), Lg.STOP_WORDS["time-budget"]);
    assert.match(Lg.noChangeWords({ stop: "converged", complete: true, rounds: 0, blocks: 65, effective: { allow: "remove", removable: "any", removableBlocks: 1 } }).detail, /Loosening a protection frees more/);
    assert.doesNotMatch(Lg.noChangeWords({ stop: "converged", complete: true, rounds: 0, blocks: 65, effective: { allow: "add", removable: "inner", removableBlocks: 0 } }).detail, /Only/, "adding only: how many may go does not matter");
});

await test("the plan's name follows the button and the controls, so the saved version says what was run (the review's OPT-5)", async () => {
    deps();
    const Lg = lib.Logic;
    const e = example("pencil-leg-chair");
    show(e.m, e.result, [e.root]);
    for (const [chip, title] of [["lightest", "Lightest"], ["strongest", "Strongest"], ["most-stable", "Best balanced"], ["stiffest", "Stiffest"]]) {
        await OS().chooseChip(e.m, AS().result, chip);
        assert.equal(OS().spec.title, title, "the button's own name");
        assert.equal(OS().spec.summary, lib.presetSpec(chip, { blocks: 103 }).summary, "the preset's sentence while nothing was touched");
    }
    await OS().chooseChip(e.m, AS().result, "most-stable");
    const first = OS().spec;
    OS().editSpec((x) => Lg.withBlocks(x, "extra", 40, 103));
    assert.equal(OS().spec.title, "Best balanced, +40 blocks");
    assert.match(OS().spec.summary, /Up to 40 extra blocks\./);
    assert.notEqual(OS().spec.summary, first.summary, "the old sentence would describe a plan that is gone");
    assert.match(visibleText(panel()), /Up to 40 extra blocks\./);
    OS().editSpec((x) => Lg.withAim(x, "lightest"));
    assert.equal(OS().spec.title, "Lightest");
    assert.match(OS().spec.summary, /^Use as few blocks as possible\. Blocks are only taken away\. The outside shape stays the same\.$/);
    OS().editSpec((x) => ({ ...x, moves: { ...x.moves, removable: "any" } }));
    assert.equal(OS().spec.title, "Lightest, any block");
    assert.match(OS().spec.summary, /Any block may go, so the shape may change\./);
    OS().editSpec((x) => lib.Logic.withAim(Lg.withMay(x, "add", true), "mix"));
    assert.match(OS().spec.title, /^Lightest \+ Strongest/);
    // back to what the plan was: its own name and sentence again
    OS().resetSpec();
    assert.equal(OS().spec.title, "Best balanced");
    OS().editSpec((x) => Lg.withBlocks(x, "extra", 40, 103));
    OS().editSpec((x) => Lg.withBlocks(x, "extra", first.constraints.max_added_blocks, 103));
    assert.equal(OS().spec.title, "Best balanced");
    assert.equal(OS().spec.summary, first.summary);
    // a reading of Muse keeps its title until a control is touched
    OS().discard();
    lib.useOptimizeStore.setState({ goalText: "make it cheaper" });
    await OS().planGoal(e.m, AS().result);
    assert.equal(OS().spec.title, "Lightest, keep it standing");
    OS().editSpec((x) => Lg.withConstraint(x, "min_blocks_pct", 70));
    assert.equal(OS().spec.title, "Lightest", "Muse's words no longer describe a plan the person changed");
    assert.doesNotMatch(OS().spec.summary, /hidden blocks/);
    OS().editSpec((x) => Lg.withBlocks(x, "most", 90, 103));
    assert.equal(OS().spec.title, "Lightest, up to 90 blocks");
    assert.ok(OS().spec.title.length <= 48 && OS().spec.summary.length <= 240);
    // the saved version carries the name of the button: "Optimized v4 · Strongest"
    OS().discard();
    const log = deps();
    await OS().chooseChip(e.m, AS().result, "strongest");
    OS().run();
    await until(() => OS().phase === "result", "the result");
    assert.equal(OS().result.meta.spec.title, "Strongest");
    await OS().keep();
    assert.equal(log.uploads.length, 1);
    const saved = S().models.find((m) => m.kind === "optimized");
    assert.ok(saved && saved.optimization.title === "Strongest");
    const note = S().messages.find((m) => m.model_ids?.includes(saved.id));
    assert.match(note.content, /^Optimized v\d+ · Strongest — 103 → \d+ blocks \(\+\d+%\)\.$/);
});

await test("the goal's own figure is on the counters and the chart while it runs (the review's OPT-6)", async () => {
    const Lg = lib.Logic;
    const C = lib.ChartLogic;
    const start = { blocks: 60, cogMarginMm: 139, maxDeflectionMm: 0.2 };
    const now = { iteration: 9, blocks: 66, util: 0.518, margin: 261, deflection: 0.124 };
    // a goal about strength reads as it always did; balance and sag come before the strength used
    assert.equal(Lg.counterLine(start, now, 2.4, ["peak_stress"]), "Round 9 · 60 → 66 blocks · 144 → 158 kg · 52% strength used");
    assert.equal(Lg.counterLine(start, now, 2.4), "Round 9 · 60 → 66 blocks · 144 → 158 kg · 52% strength used");
    assert.equal(Lg.counterLine(start, now, 2.4, ["cog_margin"]), "Round 9 · 60 → 66 blocks · 144 → 158 kg · Weight inside the base 139 → 261 mm · 52% strength used");
    assert.equal(Lg.counterLine(start, now, 2.4, ["deflection"]), "Round 9 · 60 → 66 blocks · 144 → 158 kg · Sag 62% of before · 52% strength used");
    assert.equal(Lg.counterLine({ blocks: 60 }, now, 2.4, ["cog_margin", "deflection"]), "Round 9 · 60 → 66 blocks · 144 → 158 kg · Weight inside the base 261 mm · 52% strength used", "no start figure: no sag, no arrow");
    assert.equal(Lg.counterLine(start, { ...now, margin: null, deflection: null }, 2.4, ["cog_margin", "deflection"]), "Round 9 · 60 → 66 blocks · 144 → 158 kg · 52% strength used");
    assert.deepEqual(Lg.rowOfRecord({ iteration: 2, blocks: 7, maxUtil: 0.4, cogMarginMm: 120, maxDeflectionMm: 0.05 }), { iteration: 2, blocks: 7, util: 0.4, margin: 120, deflection: 0.05 });
    // which figure the second line follows
    assert.deepEqual([["blocks"], ["peak_stress"], ["cog_margin"], ["deflection"], ["cog_margin", "peak_stress"], ["deflection", "cog_margin"], ["blocks", "deflection"]].map((o) => Lg.focusOf(o)), ["strength", "strength", "balance", "sag", "strength", "balance", "sag"]);
    // the chart: the second line is the balance (mm) or the sag (against before), on an axis that fits it
    const rows = Array.from({ length: 11 }, (_, i) => ({ iteration: i, blocks: 60 + i, util: 0.52, margin: 139 + i * 12, deflection: 0.2 - i * 0.008 }));
    const strength = C.chartPaths(rows, 2.4, 0.75);
    assert.equal(strength.focus, "strength"); assert.deepEqual(strength.rightTicks, ["100%", "50%", "0%"]); assert.equal(strength.rightTitle, "used");
    const balance = C.chartPaths(rows, 2.4, 0.75, 12, C.CHART_WIDTH, C.CHART_HEIGHT, "balance");
    assert.equal(balance.focus, "balance"); assert.deepEqual(balance.rightTicks, ["300", "150", "0"]); assert.equal(balance.rightTitle, "mm");
    assert.equal(balance.limitY, null, "the strength limit is not drawn on a line that is not strength");
    const ys = (d) => [...d.matchAll(/[ML]\S+ (\S+)/g)].map((m) => Number(m[1]));
    assert.ok(ys(balance.strength)[10] < ys(balance.strength)[0], "a balance that grows climbs");
    const sag = C.chartPaths(rows, 2.4, null, 12, C.CHART_WIDTH, C.CHART_HEIGHT, "sag");
    assert.deepEqual(sag.rightTicks, ["100%", "50%", "0%"]);
    assert.ok(ys(sag.strength)[10] > ys(sag.strength)[0], "a sag that shrinks falls");
    assert.equal(C.chartPaths([{ ...rows[0], margin: null }, { ...rows[1], margin: null }], 2.4, null, 12, C.CHART_WIDTH, C.CHART_HEIGHT, "balance").strength, "", "no figure, no line");
    assert.match(C.chartSummary(rows, 2.4, null, "balance"), /the weight sits 259 mm inside the base, it was 139 mm/);
    assert.match(C.chartSummary(rows, 2.4, null, "sag"), /it sags 60% of what it did before/);
    assert.match(C.chartSummary(rows, 2.4, 0.75), /strength used is 52%, the limit is 75%/);
    // on the panel: a balance goal shows the balance, and the legend and the numbers name it
    lib.useOptimizeStore.setState({
        phase: "running", modelId: "m", startedAt: Date.now(), effort: "quick", history: rows, latest: rows[10], recent: [], kgPer: 2.4, goalLabel: "Best balanced", stopping: false,
        spec: lib.presetSpec("most-stable", { blocks: 60 }), startMetrics: { blocks: 60, floating: 0, overLimit: 0, longestReach: 1, bodies: 1, cogMarginMm: 139, maxUtil: 0.5, maxDeflectionMm: 0.2, compliance: 1 }, effective: { maxStressPct: 75 },
    });
    let html = render(h(lib.RunStrip));
    assert.match(visibleText(html), /Weight inside the base 139 → 259 mm · 52% strength used/);
    assert.match(visibleText(html), /weight strength used limit 75%/, "strength is still in the goal, so it stays on the chart");
    lib.useOptimizeStore.setState({ spec: lib.Logic.withAim(lib.presetSpec("most-stable", { blocks: 60 }), "balanced") });
    html = render(h(lib.RunStrip));
    assert.match(visibleText(html), /weight weight inside the base Show numbers/);
    assert.doesNotMatch(html, /data-series="limit"/);
    assertPlain(html, "running (balance)");
    lib.useOptimizeStore.setState({ spec: lib.Logic.withAim(lib.presetSpec("stiffest", { blocks: 60 }), "stiffest") });
    html = render(h(lib.RunStrip));
    assert.match(visibleText(html), /Sag 60% of before/);
    assert.match(visibleText(html), /sag, against before/);
    const table = render(h(lib.ConvergenceChart, { rows, kgPerBlock: 2.4, limit: null, focus: "balance" }));
    assert.ok(table.includes('data-testid="optimize-chart-numbers"'));
    assertPlain(table, "chart (balance)");
});

await test("Stop says it was heard, and a plan whose Stability settings changed is dropped instead of run (the review's OPT-7 and OPT-8)", async () => {
    deps();
    const e = example("cantilever-house");
    show(e.m, e.result, [e.root]);
    await OS().chooseChip(e.m, AS().result, "lightest");
    // the same settings again, in a new object: nothing to say
    lib.useAnalysisStore.setState({ settings: { ...AS().settings } });
    assert.equal(OS().phase, "ready");
    AS().updateSettings({ material: AS().settings.material });
    assert.equal(OS().phase, "ready");
    // other ones: the plan is gone, the words stay, and the person is told
    AS().updateSettings({ cantileverLimit: 3 });
    assert.equal(OS().phase, "idle");
    assert.equal(OS().spec, null);
    assert.equal(OS().notice, lib.SETTINGS_CHANGED_NOTICE);
    const html = panel();
    assert.match(visibleText(html), /The settings in the Stability tab changed, so the plan was cleared\. Choose a goal again\./);
    assert.ok(!has(html, "optimize-run") && has(html, "optimize-chips"));
    assert.equal(lib.currentWork(), null);
    assertPlain(html, "idle (settings changed)");
    // the analysis on screen is still the old one (the tab checks again a moment after a change): a button does not plan from it
    await OS().chooseChip(e.m, AS().result, "lightest");
    assert.equal(OS().phase, "idle");
    assert.match(OS().notice, /settings in the Stability tab changed and the model is being checked again/);
    assert.equal(OS().preparing, false);
    lib.useOptimizeStore.setState({ goalText: "as light as possible" });
    await OS().planGoal(e.m, AS().result);
    assert.equal(OS().phase, "idle");
    assert.match(OS().notice, /being checked again/);
    assert.doesNotMatch(OS().notice, /Muse/, "the version is the problem, not Muse");
    // a plan being read by Muse is dropped too, and its late answer is ignored
    lib.useAnalysisStore.setState({ settings: lib.sanitizeSettings(null) });
    let release;
    deps({ plan: (_, signal) => new Promise((_, reject) => { release = () => reject(new DOMException("stopped", "AbortError")); signal.addEventListener("abort", release); }) });
    lib.useOptimizeStore.setState({ goalText: "as light as possible" });
    const reading = OS().planGoal(e.m, AS().result);
    await until(() => OS().phase === "planning", "planning");
    AS().updateSettings({ maxBlocks: 500 });
    await reading;
    assert.equal(OS().phase, "idle");
    assert.equal(OS().goalText, "as light as possible");
    assert.equal(OS().notice, lib.SETTINGS_CHANGED_NOTICE);
    // a run under way keeps the settings it started with; Stop is heard at once
    lib.useAnalysisStore.setState({ settings: lib.sanitizeSettings(null) });
    deps();
    const big = example("mushroom-pavilion");
    show(big.m, big.result, [big.root]);
    await OS().chooseChip(big.m, AS().result, "lightest");
    OS().run();
    await until(() => OS().history.length > 1, "a first round");
    AS().updateSettings({ maxBlocks: 400 });
    assert.equal(OS().phase, "running", "a run is not stopped by a settings change");
    OS().cancel();
    assert.equal(OS().stopping, true);
    OS().cancel();
    await until(() => OS().phase === "result", "the result after Stop");
    assert.equal(OS().stopping, false);
    OS().discard();
    assert.equal(OS().stopping, false);
    assert.ok(lib.RunOptimizeModule.STOP_GRACE_MS >= 5000);
});

// ================= the pieces =================

await test("the chart: paths grow with the rounds, the limit line sits at the limit, a table repeats the numbers", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ iteration: i, blocks: 100 - i * 2, util: 0.5 + i * 0.01, margin: 120 }));
    const p = lib.ChartLogic.chartPaths(rows, 2.4, 0.75);
    assert.match(p.weight, /^M/);
    assert.ok(p.area.endsWith("Z"));
    assert.ok(p.strength.startsWith("M"));
    assert.ok(p.limitY !== null && p.limitY > 0 && p.limitY < lib.ChartLogic.CHART_HEIGHT);
    assert.equal(p.ticks.length, 3);
    assert.ok(p.end.x > 200, "ends at the right for a long run");
    const short = lib.ChartLogic.chartPaths(rows.slice(0, 3), 2.4, null);
    assert.ok(short.end.x < p.end.x, "a short run does not stretch over the whole width");
    assert.equal(short.limitY, null);
    assert.equal(lib.ChartLogic.chartPaths([], 2.4, null).end, null);
    const gap = lib.ChartLogic.chartPaths([{ iteration: 0, blocks: 5, util: null, margin: null }, { iteration: 1, blocks: 4, util: 0.4, margin: 1 }, { iteration: 2, blocks: 3, util: null, margin: 1 }], 2.4, 0.75);
    assert.equal((gap.strength.match(/M/g) ?? []).length, 1, "a missing figure is a break, not a zero");
    const html = render(h(lib.ConvergenceChart, { rows, kgPerBlock: 2.4, limit: 0.75 }));
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="After 20 rounds, 100 blocks became 60/);
    assert.match(visibleText(html), /weight strength used limit 75% Show numbers/);
    assert.equal(lib.ChartLogic.sampleRows(rows, 5).length, 5);
    assert.equal(lib.ChartLogic.sampleRows(rows, 5)[4].iteration, 20);
    assertPlain(html, "chart");
});

await test("the words: the sentences of the result, the stop reasons, the saved line", () => {
    const Lg = lib.Logic;
    const before = { blocks: 100, weight_kg: 240, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 2, cog_margin_mm: 130, max_utilisation: 0.63, max_deflection_um: 4 };
    const light = { ...before, blocks: 61, weight_kg: 146.4, max_utilisation: 0.75, max_deflection_um: 7 };
    assert.equal(Lg.verdictLine(before, light, ["blocks"]), "Lighter by 39 blocks (−39%) and still stands.");
    assert.equal(Lg.verdictLine(before, { ...before, blocks: 116, max_utilisation: 0.38, cog_margin_mm: 300 }, ["peak_stress", "cog_margin"]), "Strength used 63% → 38%, weight 130 → 300 mm inside the base — and still stands.");
    assert.equal(Lg.verdictLine(before, { ...before, max_deflection_um: 2 }, ["deflection"]), "Sags 50% less and still stands.");
    assert.equal(Lg.verdictLine(before, before, ["blocks"]), "Nothing got better.");
    assert.equal(Lg.verdictLine(before, { ...light, errors: 1 }, ["blocks"]), "Lighter by 39 blocks (−39%) with 1 problem left.");
    assert.match(Lg.verdictLine(before, light, ["blocks"], { shape_changed: true }), /The outside shape changed\.$/);
    const rows = Lg.compareRows(before, light, ["blocks"]);
    assert.deepEqual(rows.find((r) => r.key === "blocks"), { key: "blocks", label: "Blocks", tip: rows[0].tip, before: "100", after: "61", change: "−39", better: true });
    assert.equal(rows.find((r) => r.key === "strength").better, false, "the trade-off is not dressed as a win");
    assert.equal(rows.find((r) => r.key === "sag").change, "+75%");
    assert.equal(Lg.targetLine({ stop: { reduce_blocks_by_pct: 50 } }, before, light), "39% of the 50% asked for.");
    assert.equal(Lg.targetLine({ stop: { reduce_blocks_by_pct: 30 } }, before, light), null);
    assert.equal(Lg.savedMessage({ title: "Lightest", before, after: light }), "Optimized “Lightest” — 100 → 61 blocks (−39%).");
    assert.equal(Lg.savedMessage({ title: "Lightest", before, after: light }, "v5 · Lightest"), "Optimized v5 · Lightest — 100 → 61 blocks (−39%).");
    assert.equal(Lg.moveSentence({ iteration: 4, removed: 3, added: 0 }), "Round 4: took out 3 blocks");
    assert.equal(Lg.moveSentence({ iteration: 5, removed: 2, added: 2 }), "Round 5: swapped: took out 2 blocks, put in 2");
    assert.equal(Lg.counterLine({ blocks: 103 }, { iteration: 23, blocks: 71, util: 0.61, margin: 100 }, 2.4), "Round 23 · 103 → 71 blocks · 247 → 170 kg · 61% strength used");
    assert.equal(Lg.runningTitle(12_400, "thorough"), "Optimizing · 12 s of ~30 s");
    for (const stop of Object.keys(Lg.STOP_WORDS)) assert.doesNotMatch(Lg.STOP_WORDS[stop], EXTRA_TECHNICAL);
    assert.deepEqual(Lg.partsFromLabels({ names: ["Seat", "Back"], owner: [-1, 0, 1, 0] }), { Seat: [1, 3], Back: [2] });
});

await test("fitBrief keeps a request under the Worker's limit by leaving the smallest parts out", () => {
    const parts = Array.from({ length: 26 }, (_, i) => ({ name: `A fairly long part name number ${i}`, blocks: i + 1, box: { min: [0, 0, 0], max: [9, 9, 9] } }));
    const brief = { grid: "g", blocks: 500, extent: { min: [0, 0, 0], max: [9, 9, 9] }, blocks_per_layer: Array(10).fill(50), added_by_stabilizer: 0, hidden_inner_blocks: 0, parts, current: { cog_margin_mm: 1, peak_stress_pct: 1, longest_cantilever: 1, max_cantilever_blocks: 4, symmetric: [] } };
    const fitted = lib.Logic.fitBrief(brief, "x".repeat(600), 2800);
    assert.ok(fitted.parts.length < 26 && fitted.parts.length > 5);
    assert.ok(fitted.parts.every((p) => p.blocks > 1), "the smallest went first");
    assert.ok(new TextEncoder().encode(JSON.stringify({ goal: "x".repeat(600), brief: fitted })).length <= 2800);
    assert.equal(lib.Logic.fitBrief(brief, "short", 100_000).parts.length, 26);
});

if (reactWarnings.length > 0) failures.push(`${reactWarnings.length} React warnings`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
