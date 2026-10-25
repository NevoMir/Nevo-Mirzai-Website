// Tests for the workspace shell and the version switcher in its bar: the logic behind the switcher (status marks, labels, when
// it is shown, where a click or "V" goes), the actions on the stores (the tab is kept, also when a stabilize run saves and the new
// version opens by itself), the markup it renders, the "Stabilize…" pill's reach into the report, the places that follow the family's
// display model (the analysis snapshot), and the shell's side of the Stability tab: its name, the ?tab= link, what the stage's own
// controls hand to the store, the room the panels leave the viewer, the phone's peek card, and that the panel has no version buttons.
//
//   node scripts/assignment/test-versions-ui.mjs
//
// One esbuild bundle with real React and react-dom/server, like test-ux-fixes.mjs: components are rendered to a string with
// the stores set to the state under test. `zustand` becomes a tiny wrapper whose hooks read the current state, and the toast
// library becomes a log. No DOM; the one piece that touches elements (focusing the Stabilize card) gets a fake page.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-versions-ui-test");
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
import { MemoryRouter, Route, Routes } from "react-router";
export { React, renderToStaticMarkup, MemoryRouter, Route, Routes };
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/analysisLogic";
export * from "@/assignment/store/versions";
export * from "@/assignment/components/workspace/versionLogic";
export * from "@/assignment/components/workspace/versionActions";
export * from "@/assignment/components/workspace/shellLogic";
export * from "@/assignment/components/workspace/useShowSupports";
export * from "@/assignment/store/stabilize";
export { OPEN_EXAMPLE_QUERY } from "@/assignment/store/examples";
export * from "@/assignment/components/workspace/stageHold";
export { StabilizeCard } from "@/assignment/components/analysis/StabilizeCard";
export { ModelCard } from "@/assignment/components/chat/ModelCard";
export { ChatPanel } from "@/assignment/components/chat/ChatPanel";
export { JobCard } from "@/assignment/components/chat/JobCard";
export { ProviderOption, ProviderPicker } from "@/assignment/components/chat/ProviderPicker";
export { default as Workspace } from "@/assignment/pages/Workspace";
export * from "@/assignment/store/providers";
export * from "@/assignment/shared/versionTree";
export * from "@/assignment/store/workGuard";
export * from "@/assignment/store/chatNotes";
export * from "@/assignment/store/editRouter";
export { useAccessPrompt, settleAccessPrompt } from "@/assignment/store/access";
export * from "@/assignment/store/models";
export * from "@/assignment/store/jobs";
export * from "@/assignment/store/replies";
export * from "@/assignment/components/chat/composerLogic";
export * from "@/assignment/components/workspace/format";
export { Composer } from "@/assignment/components/chat/Composer";
export { RouteChip } from "@/assignment/components/chat/RouteChip";
export { RunChip } from "@/assignment/components/workspace/RunChip";
export { KindIcon, TreeConnector } from "@/assignment/components/workspace/KindIcon";
export { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
export { DeleteVersionDialog } from "@/assignment/components/workspace/DeleteVersionDialog";
export { StabilizerLog } from "@/assignment/components/analysis/StabilizerLog";
export * from "@/assignment/components/analysis/useStabilizerLog";
export { ModelsPanel } from "@/assignment/components/workspace/ModelsPanel";
export { ANALYSIS_PEEK_CARD_PX } from "@/assignment/components/analysis/AnalysisPeekCard";
export { WorkspaceShell } from "@/assignment/components/workspace/WorkspaceShell";
export { VersionSwitcher, VersionTreeList } from "@/assignment/components/workspace/VersionSwitcher";
export { SupportsFailedNotice } from "@/assignment/components/workspace/SupportsFailedNotice";
export { ModelPairLink } from "@/assignment/components/workspace/ModelPairLink";
export { toasts } from "@/assignment/components/ui/sonner";
export { useEditStore } from "@/assignment/store/edit";
export { useVoxelEditStore } from "@/assignment/store/voxelEdit";
export { useVersionSwitcherState } from "@/assignment/components/workspace/useVersionSwitcherState";
export { focusStabilizeCard, revealStabilizeCard } from "@/assignment/components/analysis/stabilizeFocus";
export { useAnalysisSnapshot, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
export { analyzeAssembly } from "@/assignment/analysis/assembly";
export { descriptorFromBlocks } from "@/assignment/shared/assembly";
export { sanitizeSettings } from "@/assignment/store/analysisLogic";
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
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "error",
    plugins: [
        {
            name: "shims",
            setup(b) {
                b.onResolve({ filter: /^zustand$/ }, () => ({ path: "zustand-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                // The 3D viewer needs WebGL: a stand-in that shows which props the shell hands it (and its overlay, as the viewer does).
                b.onResolve({ filter: /viewer\/GlbViewer$/ }, () => ({ path: "glb-viewer-stub", namespace: "shim" }));
                b.onLoad({ filter: /^glb-viewer-stub$/, namespace: "shim" }, () => ({
                    contents: `
                        import React from "react";
                        export default function GlbViewer(p) {
                            globalThis.__viewerLoadError = p.onLoadError;
                            globalThis.__viewerProps = p;
                            return React.createElement("div", {
                                "data-testid": "viewer-stub", "data-url": p.url ?? "", "data-download-url": p.downloadUrl === undefined ? "(omitted)" : String(p.downloadUrl),
                                "data-supports": p.supports ? "yes" : "no", "data-step-offset": p.stepOffset === undefined ? "(omitted)" : String(p.stepOffset),
                                "data-show-supports": String(p.showSupports),
                                "data-view-change": typeof p.onViewChange === "function" ? "yes" : "no", "data-layer-raised": String(p.layerRaised),
                                // The old compare/version chrome of the stage: none of it is handed over any more.
                                "data-compare-props": ["onCompareChange", "compareStatus", "derivedFrom"].filter((k) => k in p && p[k] !== undefined).join(","),
                                "data-insets": JSON.stringify(p.insets), "data-mode": p.analysisView?.mode ?? "", "data-preview-label": p.previewLabel ?? "",
                            }, p.overlay);
                        }`,
                    loader: "js",
                    resolveDir: root,
                }));
                // The cards and panels of the other owners are mounted by name here; what they render is their own tests' business.
                b.onResolve({ filter: /components\/chat\/EditCard$/ }, () => ({ path: "edit-card-stub", namespace: "shim" }));
                b.onLoad({ filter: /^edit-card-stub$/, namespace: "shim" }, () => ({
                    contents: `
                        import React from "react";
                        export function EditCard({ job }) { return React.createElement("div", { "data-testid": "edit-card", "data-job": job.id, "data-status": job.status }); }
                        export function PendingEditCards() { return null; }`,
                    loader: "js",
                    resolveDir: root,
                }));
                b.onResolve({ filter: /components\/optimize\/OptimizePanel$/ }, () => ({ path: "optimize-panel-stub", namespace: "shim" }));
                b.onLoad({ filter: /^optimize-panel-stub$/, namespace: "shim" }, () => ({
                    contents: `
                        import React from "react";
                        export default function OptimizePanel() { return React.createElement("div", { "data-testid": "optimize-panel-stub" }); }`,
                    loader: "js",
                    resolveDir: root,
                }));
                // What the router calls: recorded, and made to fail on request.
                b.onResolve({ filter: /store\/(edit|voxelEdit)$/ }, (args) =>
                    args.importer.endsWith("editRouter.ts") ? { path: args.path.endsWith("voxelEdit") ? "voxel-edit-stub" : "edit-stub", namespace: "shim" } : undefined,
                );
                b.onLoad({ filter: /^edit-stub$/, namespace: "shim" }, () => ({
                    contents: `
                        export const meshEditBusy = () => Boolean(globalThis.__meshBusy);
                        export async function startDesignOrMeshEdit(a) {
                            (globalThis.__designMeshEdits ??= []).push(a);
                            if (globalThis.__editFails) throw new Error(globalThis.__editFails);
                        }`,
                    loader: "js",
                }));
                // What the block editor shows when the request has come back (`__voxelState`: a proposal, a notice, or neither = dropped) and what the router
                // asked of it (`__voxelCalls`). A kept draft is found when `__kept` names the model.
                b.onLoad({ filter: /^voxel-edit-stub$/, namespace: "shim" }, () => ({
                    contents: `
                        import { ApiRequestError } from "./src/assignment/lib/api.ts";
                        const calls = (c) => (globalThis.__voxelCalls ??= []).push(c);
                        export const useVoxelEditStore = {
                            getState: () => ({
                                proposal: null, notice: null, resumable: null, ...(globalThis.__voxelState ?? {}),
                                findResumable(id) { calls(["findResumable", id]); if (globalThis.__kept === id) globalThis.__voxelState = { ...globalThis.__voxelState, resumable: { modelId: id, count: 2 } }; },
                                async resume() { calls(["resume"]); globalThis.__voxelState = { ...globalThis.__voxelState, resumable: null, draft: { count: 2 } }; },
                                cancel() { calls(["cancel"]); },
                            }),
                        };
                        export async function requestBlockEdit(a) {
                            (globalThis.__blockEdits ??= []).push({ ...a, held: globalThis.__heldDuringBlockEdit?.() });
                            calls(["request"]);
                            if (globalThis.__edit401 > 0) { globalThis.__edit401--; throw new ApiRequestError(401, "Access code required"); }
                            if (globalThis.__editFails) throw new Error(globalThis.__editFails);
                            globalThis.__afterRequest?.();
                        }`,
                    loader: "js",
                    resolveDir: root,
                }));
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
// Only for `box instanceof HTMLElement` in the card-focusing code; the fake elements below extend it.
globalThis.HTMLElement = class HTMLElement {};

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const { React, renderToStaticMarkup } = lib;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

let passed = 0;
const failures = [];
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
const at = (minutes) => new Date(Date.UTC(2026, 9, 24, 12, 0, 0) + minutes * 60_000).toISOString();
const summary = (errors, warnings = 0) => ({
    version: 1, blocks: 30, bodies: 1, floating_blocks: 0, cantilevered: 0, longest_cantilever: 0, over_limit: 0, cantilever_limit: 4,
    cog_mm: null, cog_inside: true, cog_margin_mm: 100, size_mm: [1000, 1000, 1000], coverage: 0.5, fill_threshold: 0.3,
    errors, warnings, stress: null, analyzed_at: at(0),
});
const model = (id, over = {}) => ({
    id, project_id: "p1", job_id: "j1", provider: "hunyuan", prompt: "a shelf", glb_url: `/${id}.glb`, thumbnail_url: null, size_bytes: 1000,
    part_count: 1, created_at: at(0), analysis: null, kind: "generated", source_model_id: null, example_slug: null, derived: null, ...over,
});
const stab = (id, sourceId, added, minutes, over = {}) =>
    model(id, { kind: "stabilized", source_model_id: sourceId, created_at: at(minutes), derived: { added_blocks: added }, ...over });

const INITIAL_VIEW = lib.useAnalysisStore.getState().view;
function resetAll() {
    lib.forgetHeads();
    lib.resetWorkGuard();
    lib.setStabilizeDeps();
    lib.useStabilizeStore.getState().discard();
    lib.useAnalysisStore.setState({
        settings: lib.sanitizeSettings(null), loaded: null, viewerFailure: null, run: lib.IDLE_RUN, result: null, resultModelId: null, summaries: {},
        view: INITIAL_VIEW, colorChoice: INITIAL_VIEW.colorBy, preview: null, layerRaised: false, selection: null, stepSelection: null,
        panelOpen: false, sheetOpen: false, openRequest: 0,
    });
    lib.useWorkspaceStore.setState({
        models: [], activeModelId: null, activeProjectId: null, messages: [], jobs: {}, workspaceTab: "3d", composerChoice: null, queuedPrompt: null, providers: null,
    });
    globalThis.__designMeshEdits = [];
    globalThis.__blockEdits = [];
    globalThis.__editFails = null;
    globalThis.__edit401 = 0;
    globalThis.__heldDuringBlockEdit = null;
    lib.useVoxelEditStore.setState({ sourceModelId: null, projectId: null, status: "idle", proposal: null, draft: null, draftResult: null, notice: null, resumable: null });
    lib.useEditStore.setState({ runs: {}, undone: {} });
    globalThis.__voxelState = { proposal: { summary: "Added a shelf." } };
    globalThis.__voxelCalls = [];
    globalThis.__kept = null;
    globalThis.__afterRequest = null;
    storage.clear();
    lib.toasts.length = 0;
}
const load = (models, activeModelId, workspaceTab = "3d") => lib.useWorkspaceStore.setState({ models, activeModelId, workspaceTab });

/** A server render of the switcher for the tab, from the stores. */
function Bar({ tab = "3d", compact = false, row = false, embedded = false }) {
    const state = lib.useVersionSwitcherState(tab);
    return h(lib.VersionSwitcher, { state, compact, row, embedded });
}
const bar = (props) => render(h(Bar, props));

// ================= the status mark =================

await test("mark: problems are red with their count, a clean model is Stable, an unknown one says so", () => {
    const verdict = (errors, warnings = 0) => lib.verdictOf({ errors, warnings, blocks: 30 });
    assert.deepEqual(lib.statusMark(verdict(4)), { tone: "fail", text: "4 problems", count: 4 });
    assert.deepEqual(lib.statusMark(verdict(1)), { tone: "fail", text: "1 problem", count: 1 });
    assert.deepEqual(lib.statusMark(verdict(0)), { tone: "pass", text: "Stable", count: null });
    assert.deepEqual(lib.statusMark(verdict(0, 2)), { tone: "warn", text: "2 warnings", count: 2 }, "warnings only: the same word the Analysis tab says");
    assert.deepEqual(lib.statusMark(null), { tone: "none", text: "Not analysed yet", count: null });
    assert.deepEqual(lib.statusMark(null, true), { tone: "none", text: "Checking…", count: null });
});

await test("mark: the accessible names say which version and its state", () => {
    assert.equal(lib.segmentLabel("original", { text: "4 problems" }), "Show the original version (4 problems)");
    assert.equal(lib.segmentLabel("head", { text: "Stable" }, "v4 · Lightest"), "Show v4 · Lightest (Stable)", "the right half names its version");
    assert.equal(lib.segmentLabel("head", { text: "Stable" }), "Show the latest version (Stable)");
    assert.match(lib.segmentTitle("original"), /V switches/);
    assert.match(lib.segmentTitle("head"), /version you are working on/);
});

await test("a11y: the tooltip carries the status in words (the compact bar shows a symbol and a number), and the key's reach", () => {
    assert.match(lib.segmentTitle("original", { text: "4 problems" }), /The original model, as it was made · 4 problems\./);
    assert.match(lib.segmentTitle("head", { text: "Stable" }, { title: "v4 · Lightest", detail: "−23% weight" }), /v4 · Lightest \(−23% weight\) · Stable\./);
    assert.match(lib.segmentTitle("original"), /V switches, \[ and \] walk the versions, while the 3D view or this switch has focus/, "not a key anywhere on the page");
});

await test("a11y: warnings and problems differ in shape, not only in colour (a triangle, a dot) in the compact mark too", () => {
    load([model("m1", { analysis: summary(0, 3) }), stab("s1", "m1", 4, 5, { analysis: summary(2) })], "m1");
    const html = bar({ compact: true });
    const mark = (tone) => html.match(new RegExp(`data-mark="${tone}"[^>]*>(.*?)</span>(?:</button>|<span)`))?.[1] ?? "";
    assert.match(mark("warn"), /lucide-triangle-alert/, "warnings: a triangle");
    assert.match(mark("warn"), />3$/, "and the number");
    assert.doesNotMatch(mark("fail"), /lucide/, "problems: a plain dot");
    assert.match(mark("fail"), /rounded-full/);
    assert.match(mark("fail"), />2$/);
});

// ================= the menu line =================

await test("menu: 'v3 · Stabilized · +16 blocks · Stable · time', today's versions without a date, older ones with it", () => {
    const now = new Date(at(0));
    const row = (m, title, mark) => lib.versionRowLine(m, title, mark, now, "en-US");
    const today = row(stab("s1", "m1", 16, 0), "v3 · Stabilized", { text: "Stable" });
    assert.match(today, /^v3 · Stabilized · \+16 blocks · Stable · \d{1,2}:\d{2}\s?[AP]M$/);
    const old = row(stab("s1", "m1", 1, -24 * 60), "v2 · Stabilized", { text: "2 problems" });
    assert.match(old, /^v2 · Stabilized · \+1 block · 2 problems · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
    assert.match(row(stab("s1", "m1", 0, 0), "v2 · Stabilized", { text: "Stable" }), /^v2 · Stabilized · No blocks added · Stable/);
    assert.equal(row(model("m1", { created_at: "not a date" }), "v1 · Original", { text: "Stable" }), "v1 · Original · Stable");
    assert.equal(lib.clockTime("nope"), null);
});

await test("menu: each kind of version says what it did, in plain words", () => {
    const edited = (target, over = {}) => model("e", { kind: "edited", source_model_id: "m1", edit: { target, label: "Taller back", summary: "x", entries: [{ n: 1, instruction: "make it taller", summary: "x", added: 12, removed: 3, moved: 0 }], changes: null, ops: null, notes: [], stabilized_depth: 0 }, ...over });
    assert.equal(lib.versionDetail(edited("voxel")), "+12 −3 blocks");
    assert.equal(lib.versionDetail(edited("voxel", { edit: { ...edited("voxel").edit, entries: [{ n: 1, instruction: "a", summary: "b", added: 1, removed: 0, moved: 0 }] } })), "+1 block");
    assert.equal(lib.versionDetail(edited("design", { edit: { ...edited("design").edit, changes: { added: ["cup holder"], changed: ["seat"], removed: [] } } })), "2 parts changed");
    assert.equal(lib.versionDetail(edited("mesh", { edit: { ...edited("mesh").edit, ops: [{ op: "stretch", label: "back" }] } })), "1 change");
    const opt = (before, after) => model("o", { kind: "optimized", source_model_id: "m1", optimization: { title: "Lightest", goal: "as light as possible", before: { blocks: 100, weight_kg: before }, after: { blocks: 80, weight_kg: after }, shape_changed: false } });
    assert.equal(lib.versionDetail(opt(100, 77)), "−23% weight");
    assert.equal(lib.versionDetail(opt(100, 110)), "+10% weight");
    assert.equal(lib.versionDetail(model("r")), null, "an original says nothing");
    assert.equal(lib.versionStory(edited("voxel")), "“make it taller” — x");
    assert.equal(lib.versionStory(opt(100, 77)), "“as light as possible” · −23% weight");
    assert.equal(lib.modelTitle(edited("voxel")), "Edited · Taller back");
    assert.equal(lib.modelTitle(opt(100, 77)), "Optimized · Lightest");
    assert.equal(lib.modelTitle(model("r")), "a shelf");
    assert.match(lib.modelFileName(opt(100, 77)), /-optimized\.glb$/);
    assert.match(lib.modelFileName(edited("mesh")), /-edited\.glb$/);
});

// ================= when the switcher is shown =================

await test("mode: a stabilized version makes it a switch, problems without one an offer, and nothing else shows it", () => {
    const root = model("m1");
    const kid = stab("s1", "m1", 4, 5);
    const family = (models, active) => lib.versionFamily(models, active);
    const mode = (fam, kind, tab = "3d", fix) => lib.switcherMode({ family: fam, rootVerdict: kind ? { kind, fix } : null, tab });
    assert.equal(mode(family([root, kid], "s1"), "pass"), "switch");
    assert.equal(mode(family([root, kid], "m1"), null), "switch", "the verdict of the original does not matter once there is a version");
    assert.equal(mode(family([root], "m1"), "fail"), "offer");
    assert.equal(mode(family([root], "m1"), "warn"), "offer");
    assert.equal(mode(family([root], "m1"), "pass"), "none", "nothing to fix: nothing to offer");
    assert.equal(mode(family([root], "m1"), null), "none", "not analysed yet: no claim about problems");
    assert.equal(mode(family([root, kid], "s1"), "fail", "models"), "none", "the Models tab has its own buttons");
    assert.equal(mode(family([kid], "s1"), "fail"), "none", "the original is gone: nothing to switch to");
    assert.equal(mode(null, "fail"), "none");
    assert.equal(lib.offerLabel({ kind: "fail" }), "Stabilize…");
    assert.equal(lib.offerLabel({ kind: "warn" }), "Stabilize…", "a warning that does not say what it is about: the plain word, not a claim about the cause");
    assert.equal(lib.offerLabel({ kind: "warn", fix: "stress" }), "Reduce stress…", "only heavily loaded joints are left");
    assert.equal(lib.offerLabel({ kind: "warn", fix: "stabilize" }), "Stabilize…", "balanced on the edge");
    assert.equal(lib.offerLabel({ kind: "fail", fix: "stress" }), "Stabilize…", "a problem is a problem");
});

await test("mode: a warning the stabilizer cannot act on (thin parts left out) offers nothing, as the card does", () => {
    const root = model("m1");
    const fam = lib.versionFamily([root], "m1");
    const mode = (kind, fix) => lib.switcherMode({ family: fam, rootVerdict: { kind, fix }, tab: "3d" });
    assert.equal(mode("warn", "none"), "none", "the pill leads to a card that would not be there");
    assert.equal(mode("warn", "stress"), "offer");
    assert.equal(mode("warn", "stabilize"), "offer");
    assert.equal(mode("warn", undefined), "offer", "a verdict that does not say is offered");
    assert.equal(mode("fail", "none"), "offer");
    // A version that exists is switched to whatever the original's verdict was.
    assert.equal(lib.switcherMode({ family: lib.versionFamily([root, stab("s1", "m1", 4, 5)], "m1"), rootVerdict: { kind: "warn", fix: "none" }, tab: "3d" }), "switch");
});

// ================= where a click or V goes =================

await test("target: V flips the original and the version you work on, and returns to the one that was on screen", () => {
    const root = model("m1");
    const v1 = stab("s1", "m1", 4, 5);
    const v2 = stab("s2", "m1", 6, 10);
    const models = [root, v1, v2];
    const fam = (active) => lib.versionFamily(models, active);
    assert.deepEqual(fam("m1").versions.map((m) => m.id), ["s1", "s2"], "oldest first (v2, v3)");
    assert.equal(fam("m1").head.id, "s2", "from the original: the newest version");
    assert.equal(lib.toggleTarget(fam("m1")).id, "s2");
    assert.equal(lib.toggleTarget(fam("s1")).id, "m1", "from a version: the original");
    assert.equal(lib.toggleTarget(fam("s2")).id, "m1");
    lib.rememberHead(models, v1);
    assert.equal(lib.toggleTarget(fam("m1")).id, "s1", "back to the one that was shown last");
    assert.equal(fam("s2").head.id, "s2", "the right half stands for the one on screen");
    assert.equal(lib.targetOf("original", fam("s2")).id, "m1");
    assert.equal(lib.targetOf("head", fam("m1")).id, "s1");
    lib.forgetHeads();
    assert.equal(lib.toggleTarget(fam("m1")).id, "s2");
    assert.equal(lib.toggleTarget(lib.versionFamily([root], "m1")), null, "nothing to flip to");
    assert.equal(lib.toggleTarget(lib.versionFamily([v1], "s1")), null, "the original is gone");
    assert.equal(lib.toggleTarget(null), null);
});

await test("target: a chain generated -> stabilized -> edited -> optimized is one family: the Original half is the generated model", () => {
    const root = model("m1");
    const v1 = stab("s1", "m1", 4, 5);
    const v2 = model("e1", { kind: "edited", source_model_id: "s1", created_at: at(10), edit: { target: "voxel", label: "Shelf", summary: "", entries: [], changes: null, ops: null, notes: [], stabilized_depth: 1 } });
    const v3 = model("o1", { kind: "optimized", source_model_id: "e1", created_at: at(15), optimization: { title: "Lightest", shape_changed: false, stabilized_depth: 1 } });
    const f = lib.versionFamily([root, v1, v2, v3], "o1");
    assert.equal(f.root.id, "m1");
    assert.equal(lib.toggleTarget(f).id, "m1");
    assert.deepEqual(f.versions.map((m) => m.id), ["s1", "e1", "o1"]);
});

await test("keys: [ and ] walk to the parent and the newest child, on any tab but Models", () => {
    const key = (over) => ({ key: "]", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...over });
    assert.equal(lib.stepKeyOf(key({})), "child");
    assert.equal(lib.stepKeyOf(key({ key: "[" })), "parent");
    assert.equal(lib.stepKeyOf(key({ key: "[", ctrlKey: true })), null, "a chord belongs to the browser");
    assert.equal(lib.stepKeyOf(key({ key: "a" })), null);
    assert.equal(lib.isOptimizeKey(key({ key: "o" })), true);
    assert.equal(lib.isOptimizeKey(key({ key: "O", metaKey: true })), false);
    const root = model("m1");
    const v1 = stab("s1", "m1", 4, 5);
    const v2 = stab("s2", "s1", 2, 10);
    load([root, v1, v2], "s1");
    assert.equal(lib.stepVersion("child"), true);
    assert.equal(S().activeModelId, "s2");
    assert.equal(lib.stepVersion("child"), false, "the last one has no child");
    assert.equal(lib.stepVersion("parent"), true);
    assert.equal(lib.stepVersion("parent"), true);
    assert.equal(S().activeModelId, "m1");
    assert.equal(lib.stepVersion("parent"), false, "the original has no parent");
    lib.useWorkspaceStore.setState({ workspaceTab: "models" });
    assert.equal(lib.stepVersion("child"), false);
    // The key handler claims a key that walked, says so (once, as a toast) when there is nowhere to go, and leaves typing alone.
    load([root, v1, v2], "m1");
    let prevented = 0;
    const press = (k, target = null) => lib.handleVersionKey({ ...key({ key: k }), target, preventDefault: () => void prevented++ });
    assert.equal(press("]"), true);
    assert.deepEqual([S().activeModelId, prevented], ["s1", 1]);
    assert.equal(press("["), true);
    assert.equal(S().activeModelId, "m1");
    assert.equal(press("["), true, "the key is handled: it says so");
    assert.equal(prevented, 2, "and is left alone");
    assert.match(lib.toasts.at(-1).title, /no earlier version/);
    assert.equal(press("]", { closest: () => ({}) }), false, "typing in a field");
});

// ================= the stores =================

await test("openVersion: the tab stays where it is (3D stays 3D, Analysis stays Analysis) unless asked", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1", "analysis");
    lib.openVersion({ id: "s1" });
    assert.equal(S().activeModelId, "s1");
    assert.equal(S().workspaceTab, "analysis");
    lib.openVersion({ id: "m1" }, { tab: "3d" });
    assert.equal(S().activeModelId, "m1");
    assert.equal(S().workspaceTab, "3d");
    lib.openVersion({ id: "gone" });
    assert.equal(S().activeModelId, "m1", "an id the project does not have is ignored");
});

await test("toggleVersion: flips on 3D and Analysis, never on the Models tab, never without a version", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1", "3d");
    assert.equal(lib.toggleVersion(), true);
    assert.equal(S().activeModelId, "s1");
    assert.equal(S().workspaceTab, "3d");
    assert.equal(lib.toggleVersion(), true);
    assert.equal(S().activeModelId, "m1");
    lib.useWorkspaceStore.setState({ workspaceTab: "analysis" });
    assert.equal(lib.toggleVersion(), true);
    assert.equal(S().activeModelId, "s1");
    assert.equal(S().workspaceTab, "analysis");
    lib.useWorkspaceStore.setState({ workspaceTab: "models" });
    assert.equal(lib.toggleVersion(), false);
    assert.equal(S().activeModelId, "s1");
    load([model("m1")], "m1");
    assert.equal(lib.toggleVersion(), false);
    load([], null);
    assert.equal(lib.toggleVersion(), false);
});

await test("V key: a bare v only", () => {
    const key = (over) => ({ key: "v", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...over });
    assert.equal(lib.isVersionKey(key({})), true);
    assert.equal(lib.isVersionKey(key({ key: "V" })), true, "caps lock");
    for (const mod of ["metaKey", "ctrlKey", "altKey", "shiftKey", "repeat", "isComposing", "defaultPrevented"]) {
        assert.equal(lib.isVersionKey(key({ [mod]: true })), false, mod);
    }
    assert.equal(lib.isVersionKey(key({ key: "a" })), false);
});

// ================= the markup =================

const optimized = (id, sourceId, minutes, over = {}) =>
    model(id, {
        kind: "optimized", provider: "optimizer", source_model_id: sourceId, created_at: at(minutes),
        optimization: { title: "Lightest", goal: "as light as possible", shape_changed: false, stabilized_depth: 1, before: { blocks: 100, weight_kg: 200 }, after: { blocks: 77, weight_kg: 154 } },
        ...over,
    });
const edited = (id, sourceId, minutes, target = "voxel", label = "Taller back", over = {}) =>
    model(id, {
        kind: "edited", provider: target === "voxel" ? "editor" : "hunyuan", source_model_id: sourceId, created_at: at(minutes),
        edit: { version: 1, target, label, summary: "Raised the back.", entries: [{ n: 1, instruction: "make the back taller", summary: "Raised the back.", added: 12, removed: 0, moved: 0 }], changes: null, ops: null, notes: [], stabilized_depth: 0, depth: 1, base_steps: 0, engine: "", job_id: null, created_at: at(minutes) },
        ...over,
    });

await test("switcher: Original | the version you work on, each half with its status, the open one checked", () => {
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 16, 5, { analysis: summary(0) })], "s1");
    const html = bar();
    assert.match(html, /data-testid="version-switcher"/);
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /aria-label="Model version"/);
    assert.match(html, /aria-label="Show the original version \(4 problems\)"/);
    assert.match(html, /aria-label="Show v2 · Stabilized \(Stable\)"/);
    assert.match(html, /data-testid="version-original"[^>]*aria-checked="false"|aria-checked="false"[^>]*data-testid="version-original"/);
    assert.match(html, /aria-checked="true"[^>]*data-testid="version-head"|data-testid="version-head"[^>]*aria-checked="true"/);
    assert.match(html, /4 problems/, "the words beside the red mark");
    assert.match(html, />Stable</, "and beside the green one");
    assert.match(html, />v2 · Stabilized</, "the right half names its version");
    assert.match(html, /Showing v2 · Stabilized/);
    assert.match(html, /aria-label="Show all versions \(2\)"/, "the tree is behind a chevron, also for one version (it walks and deletes)");
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 16, 5, { analysis: summary(0) })], "m1");
    assert.match(bar(), /Showing the original version/);
});

await test("switcher: it also shows on the Stability and Optimization tabs, and not on the Models tab", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "s1", "analysis");
    assert.match(bar({ tab: "analysis" }), /data-testid="version-switcher"/);
    assert.match(bar({ tab: "optimize" }), /data-testid="version-switcher"/);
    assert.equal(bar({ tab: "models" }), "");
});

await test("switcher: the right half is the version on screen, else the one seen last, else the newest; edited and optimized versions have names", () => {
    const root = model("m1");
    const models = [root, stab("s1", "m1", 4, 5, { analysis: summary(2) }), edited("e1", "m1", 7), optimized("p1", "s1", 10, { analysis: summary(0) })];
    load(models, "m1");
    const html = bar();
    const half = html.match(/<button[^>]*data-testid="version-head"[^>]*>/)[0];
    assert.match(half, /role="radio"/);
    assert.doesNotMatch(half, /aria-haspopup/, "the half itself opens nothing");
    const trigger = html.match(/<button[^>]*data-testid="version-menu-trigger"[^>]*>/)[0];
    assert.match(trigger, /aria-haspopup="menu"/);
    assert.doesNotMatch(trigger, /role="radio"/, "a button that opens a menu is not a radio");
    assert.match(trigger, /aria-label="Show all versions \(4\)"/);
    assert.match(html, /aria-label="Show v4 · Lightest \(Stable\)"/, "the newest version stands for the half, and says which");
    assert.match(half, /title="v4 · Lightest \(−23% weight\) · Stable\./, "its tooltip says what it did");
    lib.rememberHead(models, models[1]);
    assert.match(bar(), /aria-label="Show v2 · Stabilized \(2 problems\)"/, "or the one seen last");
    load(models, "e1");
    assert.match(bar(), /aria-label="Show v3 · Taller back \(Not analysed yet\)"/, "a change by words is named by what it did");
    assert.match(bar(), /aria-checked="true"[^>]*data-testid="version-head"|data-testid="version-head"[^>]*aria-checked="true"/);
});

await test("tree: the rows are indented under the version they were made from, the one on screen is ticked, and each row says what it did", () => {
    const models = [model("m1", { analysis: summary(0) }), stab("s1", "m1", 4, 5, { analysis: summary(0, 1) }), edited("e1", "m1", 7, "voxel", "Shelf", { analysis: summary(2) }), optimized("p1", "s1", 10)];
    load(models, "p1");
    const family = lib.versionFamily(models, "p1");
    const rows = lib.familyRows(family);
    assert.deepEqual(rows.map((r) => `${r.model.id}:${r.depth}`), ["m1:0", "s1:1", "p1:2", "e1:1"], "depth first, oldest first");
    assert.deepEqual(rows.map((r) => lib.familyTitle(family, r.model)), ["v1 · Original", "v2 · Stabilized", "v4 · Lightest", "v3 · Shelf"]);
    assert.equal(lib.versionOrdinal(family, { id: "e1" }).n, 3);
    assert.equal(lib.versionOrdinal(family, { id: "m1" }).n, 1);
    assert.equal(lib.versionOrdinal(family, { id: "nope" }), null);
    assert.equal(lib.versionOrdinal(null, { id: "e1" }), null);
});

await test("tree rows (the phone's sheet shares them with the desktop menu): indented, ticked, named, with what each did and its mark", () => {
    const models = [model("m1", { analysis: summary(0) }), stab("s1", "m1", 9, 5, { analysis: summary(0, 1) }), edited("e1", "m1", 7, "voxel", "Shelf", { analysis: summary(2) }), optimized("p1", "s1", 10, { analysis: summary(0) })];
    load(models, "p1");
    const family = lib.versionFamily(models, "p1");
    const html = render(h(lib.VersionTreeList, { family, onPick() {} }));
    assert.deepEqual([...html.matchAll(/data-testid="version-menu-item" data-active="(true|false)" data-depth="(\d)"/g)].map((m) => `${m[1]}:${m[2]}`), ["false:0", "false:1", "true:2", "false:1"]);
    const text = textOf(html);
    assert.match(text, /v1 · Original/);
    assert.match(text, /v2 · Stabilized \+9 blocks/);
    assert.match(text, /v4 · Lightest −23% weight/);
    assert.match(text, /v3 · Shelf \+12 blocks/);
    assert.match(html, /data-mark="fail"/, "the edited version has problems: a dot");
    assert.match(html, /data-mark="warn"/, "and the stabilized one a warning: a triangle");
    assert.equal((html.match(/data-testid="tree-connector"/g) ?? []).length, 3, "every row but the root has its connector");
    assert.match(html, /lucide-sliders-horizontal/);
    assert.match(html, /lucide-pencil-line/);
});

await test("switcher: no version has no chevron; the control is not there at all", () => {
    load([model("m1")], "m1");
    assert.doesNotMatch(bar(), /version-menu-trigger|aria-haspopup/);
});

await test("switcher: no analysis yet is a hollow dot and the words in the label, never invented problems", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1");
    const html = bar();
    assert.match(html, /aria-label="Show the original version \(Not analysed yet\)"/);
    assert.match(html, /data-tone="none"/);
    assert.doesNotMatch(html, /problem/);
});

await test("switcher: the live analysis wins over the saved summary", () => {
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 4, 5, { analysis: summary(3) })], "m1");
    lib.useAnalysisStore.setState({ summaries: { m1: summary(0), s1: summary(1) } });
    const html = bar();
    assert.match(html, /aria-label="Show the original version \(Stable\)"/);
    assert.match(html, /aria-label="Show v2 · Stabilized \(1 problem\)"/);
});

await test("switcher: compact keeps the marks and drops the words", () => {
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 4, 5, { analysis: summary(0) })], "m1");
    const html = bar({ compact: true });
    assert.match(html, /aria-label="Show the original version \(4 problems\)"/, "the name still has the words");
    assert.match(html, /title="The original model, as it was made · 4 problems\./, "the tooltip has the words the bar left out");
    assert.doesNotMatch(html.replace(/(aria-label|title)="[^"]*"/g, ""), /4 problems|Stable/);
    assert.match(html, /data-mark="fail"[^>]*>.*?4</);
    assert.match(html, /data-mark="pass"/);
});

await test("offer: an original with problems and no version gets a Stabilize… pill (and says what it is)", () => {
    load([model("m1", { analysis: summary(4) })], "m1");
    const html = bar();
    assert.match(html, /data-mode="offer"/);
    assert.match(html, /data-testid="version-stabilize"/);
    assert.match(html, /Stabilize…/);
    assert.match(html, /Original version \(4 problems\)/);
    assert.match(html, /<span[^>]*role="img"[^>]*aria-label="Original version \(4 problems\)"|<span[^>]*aria-label="Original version \(4 problems\)"[^>]*role="img"/, "an aria-label on a bare span is not announced: it is an image with a name");
    assert.doesNotMatch(html, /role="radiogroup"/);
    // Saved summaries have the counts and figures, not the kinds of the warnings: the words follow from them.
    load([model("m1", { analysis: { ...summary(0, 1), coverage: 0.9, stress: { material: "concrete", max_utilisation: 0.8 } } })], "m1");
    assert.match(bar(), /Reduce stress…/, "the only warning is a heavily loaded joint");
    load([model("m1", { analysis: { ...summary(0, 2), cog_margin_mm: 0.2, stress: { material: "concrete", max_utilisation: 0.8 } } })], "m1");
    assert.match(bar(), /Stabilize…/, "balanced on the edge as well: the plain word");
    assert.doesNotMatch(bar(), /Reduce stress/);
    load([model("m1", { analysis: { ...summary(0, 1), coverage: 0.5, stress: { material: "concrete", max_utilisation: 0.44 } } })], "m1");
    assert.equal(bar(), "", "thin parts left out and nothing else: the stabilizer has nothing to do, so there is no pill to lead to a card that is not there");
    load([model("m1", { analysis: summary(0) })], "m1");
    assert.equal(bar(), "", "a stable model needs no offer");
    load([model("m1")], "m1");
    assert.equal(bar(), "", "nor one that has not been analysed");
    load([model("m1", { analysis: summary(4) })], "m1", "models");
    assert.equal(bar({ tab: "models" }), "");
    load([], null);
    assert.equal(bar(), "");
});

// ================= the Stabilize pill's reach =================

/** A page with a Stabilize card: what focusStabilizeCard looks for, as far as it looks. */
function fakePage({ withButton = true } = {}) {
    const log = [];
    class El extends globalThis.HTMLElement {
        constructor(name) {
            super();
            this.name = name;
            this.attrs = new Map();
        }
        setAttribute(k, v) { this.attrs.set(k, v); log.push(`${this.name}.set ${k}=${v}`); }
        removeAttribute(k) { this.attrs.delete(k); }
        hasAttribute(k) { return this.attrs.has(k); }
        focus(o) { log.push(`${this.name}.focus ${JSON.stringify(o)}`); }
        scrollIntoView(o) { log.push(`${this.name}.scroll ${o.block}`); }
    }
    const card = new El("card");
    const box = new El("box");
    const button = new El("button");
    card.firstElementChild = box;
    card.querySelector = (sel) => (sel.includes("stabilize-start") && withButton ? button : null);
    // The offer (stabilize-card) is a wrapper around the box that rings; a strip of an ended run is the box itself.
    card.matches = (sel) => sel.includes("stabilize-card");
    const page = { querySelector: (sel) => (sel.includes("stabilize-card") ? card : null) };
    return { page, log, card, box, button };
}

/** A page whose only card is the strip of an ended run (`id`), with the buttons it has. */
function fakeStrip(id, buttons = []) {
    const log = [];
    class El extends globalThis.HTMLElement {
        constructor(name) {
            super();
            this.name = name;
            this.attrs = new Map();
        }
        setAttribute(k, v) { this.attrs.set(k, v); log.push(`${this.name}.set ${k}=${v}`); }
        removeAttribute(k) { this.attrs.delete(k); }
        hasAttribute(k) { return this.attrs.has(k); }
        focus(o) { log.push(`${this.name}.focus ${JSON.stringify(o)}`); }
        scrollIntoView(o) { log.push(`${this.name}.scroll ${o.block}`); }
    }
    const strip = new El("strip");
    const found = new Map(buttons.map((b) => [b, new El(b)]));
    strip.firstElementChild = new El("inner");
    strip.matches = () => false; // not one of the wrappers (the offer, the live run)
    strip.querySelector = (sel) => {
        for (const [b, el] of found) if (sel.includes(`"${b}"`)) return el;
        return null;
    };
    const page = { querySelector: (sel) => (sel.includes(`"${id}"`) ? strip : null) };
    return { page, log, strip, found };
}

await test("pill: focusStabilizeCard scrolls the card into view, rings it and focuses its button, and runs nothing", () => {
    const { page, log, box } = fakePage();
    assert.equal(lib.focusStabilizeCard(page), true);
    assert.ok(log.includes("card.scroll center"));
    assert.ok(log.includes('button.focus {"preventScroll":true}'));
    assert.equal(box.attrs.get("data-flash"), "true");
    assert.equal(lib.focusStabilizeCard({ querySelector: () => null }), false, "no card yet: the caller looks again");
    const bare = fakePage({ withButton: false });
    lib.focusStabilizeCard(bare.page);
    assert.equal(bare.card.attrs.get("tabindex"), "-1", "without the start button the card itself takes focus");
    assert.ok(bare.log.some((l) => l.startsWith("card.focus")));
});

await test("pill: the strip of a run that has ended is found too: the ring is on the strip itself and the keyboard goes to Save or Retry, else to the strip", () => {
    for (const id of ["stabilize-saving", "stabilize-error", "stabilize-canceled", "stabilize-nothing", "stabilize-partial"]) {
        const bare = fakeStrip(id);
        assert.equal(lib.focusStabilizeCard(bare.page), true, id);
        assert.equal(bare.strip.attrs.get("data-flash"), "true", `${id}: the ring is on the strip, not on its first child`);
        assert.equal(bare.strip.firstElementChild.attrs.get("data-flash"), undefined);
        assert.equal(bare.strip.attrs.get("tabindex"), "-1");
        assert.ok(bare.log.some((l) => l.startsWith("strip.focus")), `${id}: no button, the strip takes the focus`);
    }
    const partial = fakeStrip("stabilize-partial", ["stabilize-save"]);
    lib.focusStabilizeCard(partial.page);
    assert.ok(partial.log.includes('stabilize-save.focus {"preventScroll":true}'), "Save as new version takes the focus");
    const failed = fakeStrip("stabilize-error", ["stabilize-retry"]);
    lib.focusStabilizeCard(failed.page);
    assert.ok(failed.log.includes('stabilize-retry.focus {"preventScroll":true}'), "Retry takes the focus");
    assert.ok(!failed.log.some((l) => l.startsWith("strip.focus")));
});

await test("pill: revealStabilizeCard opens the Analysis tab and the report (and the phone's sheet) without starting a run", () => {
    load([model("m1", { analysis: summary(4) })], "m1", "3d");
    const stop = lib.revealStabilizeCard("m1");
    stop();
    assert.equal(S().workspaceTab, "analysis");
    assert.equal(S().activeModelId, "m1");
    assert.equal(AS().panelOpen, true);
    assert.equal(AS().sheetOpen, true);
    assert.equal(AS().openRequest, 1, "the page brings the canvas forward on a phone");
});

// ================= the places that follow the display model =================

function Snap({ out }) {
    const model = lib.useWorkspaceStore((s) => s.models.find((m) => m.id === s.activeModelId) ?? null);
    out.snapshot = lib.useAnalysisSnapshot(model);
    return null;
}
const snapshotOf = () => {
    const out = {};
    render(h(Snap, { out }));
    return out.snapshot;
};

await test("snapshot: a stabilized model is ready once ITS SOURCE's mesh is in the viewer, not its own file", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    lib.useAnalysisStore.setState({ loaded: { url: "/m1.glb" } });
    assert.equal(snapshotOf().ready, true);
    lib.useAnalysisStore.setState({ loaded: { url: "/s1.glb" } });
    assert.equal(snapshotOf().ready, false, "the blocks file is not what the viewer is showing");
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1");
    lib.useAnalysisStore.setState({ loaded: { url: "/m1.glb" } });
    assert.equal(snapshotOf().ready, true, "an original shows itself, as before");
});

await test("snapshot: without the source (deleted) the stabilized GLB itself is what must be loaded", () => {
    load([stab("s1", "gone", 4, 5)], "s1");
    lib.useAnalysisStore.setState({ loaded: { url: "/s1.glb" } });
    assert.equal(snapshotOf().ready, true);
    lib.useAnalysisStore.setState({ loaded: { url: "/gone.glb" } });
    assert.equal(snapshotOf().ready, false);
});

await test("snapshot: a mesh that failed to load is the reason for a stabilized model that is shown on it", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    lib.useAnalysisStore.setState({ viewerFailure: { url: "/m1.glb", message: "bad mesh" } });
    assert.equal(snapshotOf().unavailable, "bad mesh");
    lib.useAnalysisStore.setState({ viewerFailure: { url: "/s1.glb", message: "other" } });
    assert.notEqual(snapshotOf().unavailable, "other");
});

await test("verdict hook: a null model is no verdict (the bar asks before there is an original)", () => {
    function V({ out }) {
        out.v = lib.useModelVerdict(null);
        return null;
    }
    const out = {};
    render(h(V, { out }));
    assert.equal(out.v, null);
});

// ================= the supports toggle =================

await test("supports toggle: on unless the session said otherwise", () => {
    assert.equal(lib.parseShowSupports(null), true);
    assert.equal(lib.parseShowSupports(undefined), true);
    assert.equal(lib.parseShowSupports("1"), true);
    assert.equal(lib.parseShowSupports("0"), false);
    assert.equal(lib.parseShowSupports("junk"), true);
});

// ================= V is not a key of the whole page (UX-2) =================

const keyEvent = (over = {}) => {
    const event = {
        key: "v", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
        target: null, claimed: 0, preventDefault() { this.claimed += 1; }, ...over,
    };
    return event;
};
const inside = (selectors) => ({ closest: (selector) => (selectors.some((s) => selector.includes(s)) ? {} : null) });

await test("V key: typing contexts (a field, a menu, a dialog, a list, an editable) never act on it", () => {
    assert.equal(lib.inTypingContext(null), false);
    assert.equal(lib.inTypingContext({}), false, "not an element");
    assert.equal(lib.inTypingContext(inside([])), false);
    for (const where of ["input", "textarea", "select", "[contenteditable='true']", "[role='menu']", "[role='dialog']", "[role='listbox']"]) {
        assert.equal(lib.inTypingContext(inside([where])), true, where);
    }
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1");
    for (const where of ["input", "textarea", "[role='menu']", "[role='dialog']"]) {
        const e = keyEvent({ target: inside([where]) });
        assert.equal(lib.handleVersionKey(e), false, where);
        assert.equal(e.claimed, 0);
        assert.equal(S().activeModelId, "m1", `V typed in ${where} flips nothing`);
    }
});

await test("V key: handleVersionKey flips the version and claims the key, from the stage or the switch (where the shell and the switcher attach it)", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1");
    const e = keyEvent({ target: inside([]) });
    assert.equal(lib.handleVersionKey(e), true);
    assert.equal(e.claimed, 1, "the key is claimed");
    assert.equal(S().activeModelId, "s1");
    assert.equal(lib.handleVersionKey(keyEvent({ key: "V", target: inside([]) })), true, "caps lock");
    assert.equal(S().activeModelId, "m1");
    // Not a bare v: left alone for the browser or another shortcut.
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { key: "a" }]) {
        assert.equal(lib.handleVersionKey(keyEvent({ target: inside([]), ...over })), false, JSON.stringify(over));
    }
    assert.equal(S().activeModelId, "m1");
    assert.equal(lib.toasts.length, 0);
});

await test("V key: with nothing to flip to it says so (once, as one toast) instead of staying silent, and leaves the key alone", () => {
    load([model("m1", { analysis: summary(4) })], "m1");
    const e = keyEvent({ target: inside([]) });
    assert.equal(lib.handleVersionKey(e), true);
    assert.equal(e.claimed, 0, "nothing was done: the key is not claimed");
    assert.equal(S().activeModelId, "m1");
    assert.equal(lib.toasts.length, 1);
    assert.match(lib.toasts[0].title, /no other version/);
    assert.equal(lib.toasts[0].options.id, "version-none", "one toast, however often it is pressed");
    // The Models tab has its own buttons, and with no model there is nobody to tell.
    lib.toasts.length = 0;
    load([model("m1")], "m1", "models");
    lib.handleVersionKey(keyEvent({ target: inside([]) }));
    load([], null);
    lib.handleVersionKey(keyEvent({ target: inside([]) }));
    assert.equal(lib.toasts.length, 0);
});

await test("V key: no listener on the window any more (the page cannot be made to flip versions from anywhere); the stage and the switch carry it", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (file) => readFileSync(path.join(root, "src/assignment", file), "utf8");
    const page = read("pages/Workspace.tsx");
    assert.doesNotMatch(page, /isVersionKey|toggleVersion|handleVersionKey/, "the page no longer owns the key");
    assert.match(read("components/workspace/WorkspaceShell.tsx"), /handleVersionKey\(keyEvent\)/, "the stage handles it, like A");
    assert.match(read("components/workspace/VersionSwitcher.tsx"), /handleVersionKey\(versionKeyEvent\(event\)\)/, "and so does the switch");
});

// ================= the added supports that did not come (UX-1) =================

await test("supports failure: only the 3D tab of a stabilized model on its source, only when the run failed, with the reason", () => {
    const f = (over) => lib.supportsFailure({ onSource: true, tab: "3d", phase: "error", error: "The stabilized model's file was not found.", ...over });
    assert.equal(f({}), "The stabilized model's file was not found.");
    assert.equal(f({ error: null }), "This version's blocks could not be read.", "a reason is always given");
    assert.equal(f({ error: "  " }), "This version's blocks could not be read.");
    assert.equal(f({ phase: "running" }), null);
    assert.equal(f({ phase: "done" }), null);
    assert.equal(f({ phase: "loading" }), null);
    assert.equal(f({ tab: "analysis" }), null, "the report has its own error card");
    assert.equal(f({ tab: "models" }), null);
    assert.equal(f({ onSource: false }), null, "an original shows its own mesh: nothing is missing");
});

await test("supports failure: the notice says what is missing, why, that this is the original without them, and offers Try again", () => {
    const html = render(h(lib.SupportsFailedNotice, { message: "The stabilized model's file was not found", onRetry() {} }));
    assert.match(html, /role="alert"/);
    assert.match(html, /The added supports could not be loaded/);
    assert.match(html, /The stabilized model&#x27;s file was not found\. This is the original model without them\./, "the reason, ended once");
    assert.match(html, /data-testid="supports-retry"/);
    assert.match(html, />Try again</);
    assert.match(render(h(lib.SupportsFailedNotice, { message: "Offline.", onRetry() {} })), /Offline\. This is the original/, "no doubled full stop");
});

await test("supports failure: a failed run gives a failed assembly state that asks again instead of staying failed (the Try again path)", async () => {
    const before = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return { ok: false, status: 404 };
    };
    try {
        lib.forgetAssemblies();
        const target = { id: "s1", glb_url: "/s1.glb" };
        await assert.rejects(() => lib.loadAssembly(target), /not found/);
        assert.equal(lib.peekAssembly(target).status, "error");
        await assert.rejects(() => lib.loadAssembly(target), /not found/);
        assert.equal(calls, 2, "a failure is not kept: the retry fetches again");
    } finally {
        globalThis.fetch = before;
        lib.forgetAssemblies();
    }
});

// ================= where the switcher sits (UX-3, UX-4) =================

await test("layout: wide windows keep it in the bar's tab card, narrower ones drop the words, narrow ones give it a row", () => {
    const at = (freeWidth, mode = "switch", pending = false, mobile = false) => lib.switcherLayout({ mobile, freeWidth, mode, pending });
    assert.deepEqual(at(1300), { inRow: false, rowKept: false, rowPx: 0, compact: false });
    assert.equal(at(979).compact, true, "under 980: only the numbers");
    assert.equal(at(980).compact, false);
    assert.deepEqual(at(900), { inRow: false, rowKept: false, rowPx: 0, compact: true }, "still in the bar");
    assert.deepEqual(at(859), { inRow: true, rowKept: true, rowPx: lib.DESKTOP_SWITCHER_ROW_PX, compact: true }, "no room beside the tabs: a row under the bar");
    assert.equal(at(486).inRow, true, "an iPad portrait window (half the width taken by the chat)");
    assert.equal(at(1024 - 340).inRow, true, "1024 px wide with the chat at 340: 684 px free");
    assert.equal(at(960 - 340).inRow, true, "half of a 1920 screen");
    assert.equal(at(1440 - 340).inRow, false, "a laptop with the chat open: in the bar");
});

await test("layout: a row is kept for a switcher that may still appear (no verdict yet), so the model is not re-framed when it lands", () => {
    const at = (over) => lib.switcherLayout({ mobile: true, freeWidth: 375, mode: "none", pending: false, ...over });
    assert.equal(at({}).rowKept, false, "nothing to switch to: no row");
    assert.equal(at({}).rowPx, 0);
    assert.equal(at({ pending: true }).rowKept, true, "waiting for the first verdict: the room is held");
    assert.equal(at({ pending: true }).rowPx, lib.PHONE_SWITCHER_ROW_PX, "the same height the switcher will take");
    assert.equal(at({ mode: "offer" }).rowPx, lib.PHONE_SWITCHER_ROW_PX);
    assert.equal(at({ mode: "switch", pending: true }).rowPx, lib.PHONE_SWITCHER_ROW_PX);
    assert.equal(lib.switcherLayout({ mobile: false, freeWidth: 700, mode: "none", pending: true }).rowPx, lib.DESKTOP_SWITCHER_ROW_PX);
    assert.equal(lib.switcherLayout({ mobile: false, freeWidth: 1200, mode: "none", pending: true }).rowKept, false, "in the bar the tab card's spare room holds it: nothing to keep");
});

await test("layout: pending is an original in the viewer whose first verdict is not in, off the Models tab", () => {
    const root = model("m1");
    const f = (models, active) => lib.versionFamily(models, active);
    const pending = (family, rootVerdict, tab = "3d") => lib.switcherPending({ family, rootVerdict, tab });
    assert.equal(pending(f([root], "m1"), null), true);
    assert.equal(pending(f([root], "m1"), { kind: "fail" }), false, "known: the mode decides");
    assert.equal(pending(f([root], "m1"), { kind: "pass" }), false);
    assert.equal(pending(f([root], "m1"), null, "models"), false);
    assert.equal(pending(f([root, stab("s1", "m1", 4, 5)], "m1"), null), false, "it has a version: it is a switch already");
    assert.equal(pending(f([stab("s1", "gone", 4, 5)], "s1"), null), false, "the original is gone: nothing will come");
    assert.equal(pending(null, null), false);
});

await test("layout: the hook reports it (an original with no verdict is pending, one with problems an offer)", () => {
    function State({ out }) {
        out.state = lib.useVersionSwitcherState("3d");
        return null;
    }
    const read = () => {
        const out = {};
        render(h(State, { out }));
        return out.state;
    };
    load([model("m1")], "m1");
    assert.deepEqual([read().mode, read().pending], ["none", true]);
    load([model("m1", { analysis: summary(4) })], "m1");
    assert.deepEqual([read().mode, read().pending], ["offer", false]);
    load([model("m1", { analysis: summary(0) })], "m1");
    assert.deepEqual([read().mode, read().pending], ["none", false]);
});

await test("look: embedded in the tab card it is a tray without its own border or shadow (the tab card is the card); the phone row is taller for a finger", () => {
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 4, 5, { analysis: summary(0) })], "m1");
    const embedded = bar({ embedded: true });
    const card = embedded.match(/<div data-testid="version-switcher"[^>]*class="([^"]*)"/)[1];
    assert.match(card, /bg-secondary\/60/);
    assert.doesNotMatch(card, /border|shadow|h-9/, "no card of its own");
    const standalone = bar().match(/<div data-testid="version-switcher"[^>]*class="([^"]*)"/)[1];
    assert.match(standalone, /border-border\/70/);
    assert.match(standalone, /h-9/);
    const phone = bar({ row: true });
    assert.match(phone.match(/<div data-testid="version-switcher"[^>]*class="([^"]*)"/)[1], /h-10/, "a 40 px row");
    for (const tag of phone.match(/<button[^>]*data-testid="version-(original|stabilized)"[^>]*>/g)) assert.match(tag, /\bh-8\b/, "32 px controls");
    assert.doesNotMatch(phone.replace(/(aria-label|title)="[^"]*"/g, ""), /4 problems|Stable/, "compact: the numbers only");
    load([model("m1", { analysis: summary(4) }), stab("s1", "m1", 4, 5), stab("s2", "m1", 6, 9)], "m1");
    assert.match(bar({ row: true }).match(/<button[^>]*data-testid="version-menu-trigger"[^>]*>/)[0], /\bh-8 w-8\b/, "and so is the chevron");
});

// ================= the same words open the same model (UX-7) =================

await test("links: an original links to the bar's right half (Latest), a version to the original; Previous only as an extra on a version of a version", () => {
    const root = model("m1");
    const v1 = stab("s1", "m1", 4, 5);
    const v2 = stab("s2", "s1", 2, 10);
    const models = [root, v1, v2];
    const links = (id, list = models) => lib.pairLinks(lib.versionFamily(list, id), list).map((l) => `${l.label}:${l.model.id}`);
    // The original: the family's head (the newest version, here a version of a version), not its only direct child.
    assert.deepEqual(links("m1"), ["Latest:s2"]);
    lib.rememberHead(models, v1);
    assert.deepEqual(links("m1"), ["Latest:s1"], "the one seen last, like the bar");
    lib.forgetHeads();
    // A version made from the original: Original.
    assert.deepEqual(links("s1"), ["Original:m1"]);
    // A version made from a version: Original is the generated model (as the bar's), Previous the one before it.
    assert.deepEqual(links("s2"), ["Original:m1", "Previous:s1"]);
    // The original deleted: only the chain is left.
    assert.deepEqual(links("s2", [v1, v2]), ["Previous:s1"], "the original is gone: only the chain's own step back is left");
    assert.deepEqual(links("s1", [v1]), []);
    assert.deepEqual(links("m1", [root]), []);
    assert.deepEqual(lib.pairLinks(null, models), []);
});

await test("links: a card for each model renders them (the version's chat card gets its way back to the original)", () => {
    const root = model("m1");
    const v1 = stab("s1", "m1", 4, 5);
    const v2 = stab("s2", "s1", 2, 10);
    const models = [root, v1, v2];
    const link = (m) => render(h(lib.ModelPairLink, { model: m, models, onView() {} }));
    const labels = (html) => [...html.matchAll(/data-label="([^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(labels(link(root)), ["Latest"]);
    assert.deepEqual(labels(link(v1)), ["Original"]);
    assert.deepEqual(labels(link(v2)), ["Original", "Previous"]);
    assert.match(link(v2), /aria-label="Show the original version"/);
    assert.match(link(v2), /aria-label="Show the previous version"/);
    assert.match(link(root), /aria-label="Show the latest version"/);
    assert.equal(link(model("lonely")), "", "nothing to flip to");
});

const metrics = (over = {}) => ({
    blocks: 30, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 2, cog_margin_mm: 100, max_utilisation: 0.4, overstressed_blocks: 0, ...over,
});
const derivedOf = (added, over = {}) => ({
    version: 1, depth: 1, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.75, cantilever_limit: 4, fill_threshold: 0.3,
    complete: true, stop: "stable", added_blocks: added, added_by_role: { column: added }, before: metrics({ errors: 2, max_utilisation: 1.06 }), after: metrics(),
    steps: [], duration_ms: 20, assembly_hash: "x", after_summary: summary(0), created_at: at(0), ...over,
});
const planned = () => lib.analyzeAssembly(lib.descriptorFromBlocks([[0, 0, 0], [1, 0, 0], [2, 0, 0]].map((cell) => ({ cell }))), null, lib.sanitizeSettings(null));
const FAILING = { kind: "fail", errors: 2, warnings: 0, blocks: 3, custom: null, headline: "2 problems", short: "2 problems" };

await test("target: the right half of the bar is the version seen last, else the newest of the family (a version of a version counts)", () => {
    const R = model("m1");
    const S1 = stab("s1", "m1", 4, 5, { derived: derivedOf(4) });
    const S2 = stab("s2", "s1", 6, 10, { derived: derivedOf(6) });
    load([R, S1, S2], "m1");
    assert.equal(lib.versionFamily(S().models, "m1").head.id, "s2", "the newest of the family: S2 is made from S1, and the bar opens it");
    lib.rememberHead(S().models, S1);
    assert.equal(lib.versionFamily(S().models, "m1").head.id, "s1", "the one seen last");
});

await test("panel: an original that has a stabilized version gets no button that switches versions (the bar's switcher is the only way)", () => {
    const R = model("m1");
    const S1 = stab("s1", "m1", 4, 5, { derived: derivedOf(4) });
    load([R, S1], "m1", "analysis");
    const html = render(h(lib.StabilizeCard, { model: R, result: planned(), verdict: FAILING, analysing: false }));
    assert.doesNotMatch(html, /data-testid="stabilize-open"/, "no 'Open stabilized version'");
    assert.doesNotMatch(html, /stabilize-compare|stabilization-compare|stabilization-original|stabilization-previous/, "no Compare, no View original");
    assert.doesNotMatch(html, /Open stabilized version|View original|>Compare</);
});

await test("panel: components/analysis has no way to open another version, a Compare, or the old compare chrome", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = path.join(root, "src/assignment/components/analysis");
    const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));
    assert.ok(files.length > 5, "the panel's files were found");
    const offenders = (pattern) => files.filter((f) => pattern.test(readFileSync(path.join(dir, f), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "")));
    // The one place that moves between models is the strip of a run that belongs to another model ("Go to that model"): that is a
    // model, not a version of this one.
    // (And the block-edit card, which opens the version it has just saved: the model it made, not another version of this one.)
    const moves = (pattern) => offenders(pattern).filter((f) => f !== "RunStrip.tsx" && f !== "EditBlocksCard.tsx");
    assert.deepEqual(moves(/\bopenVersion\s*\(/), [], "versions are switched in the bar");
    assert.deepEqual(moves(/\bsetActiveModel\s*\(/), [], "and so are models, except from the other-model strip");
    assert.deepEqual(offenders(/\b(requestCompare|setCompare|ensureOriginal|CompareNotice|CompareChip)\b/), [], "the compare machinery is gone");
});

// ================= the whole bar, rendered (UX-1, UX-3, UX-4, UX-6) =================

globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
};
globalThis.document = { getElementById: () => null, querySelector: () => null };

/** WorkspaceShell with the viewer replaced by a stand-in; the first render only starts the lazy import, so render twice. */
async function shellHtml({ width = 1440, mobile, tab, models, active, project = true } = {}) {
    lib.useWorkspaceStore.setState({
        models, activeModelId: active, workspaceTab: tab ?? "3d",
        project: project ? { id: "p1", name: "Shelf", pinned: false } : null, activeProjectId: project ? "p1" : null,
    });
    globalThis.window.innerWidth = width;
    const element = h(lib.WorkspaceShell, { onOpenProjects() {}, chatStarted: true, mobile: mobile ? { onShowChat() {} } : undefined });
    render(element);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return render(element);
}
const attr = (html, name) => html.match(new RegExp(`data-testid="viewer-stub"[^>]*${name}="([^"]*)"`))?.[1];
const PAIR = [model("m1", { analysis: summary(4) }), stab("s1", "m1", 4, 5, { analysis: summary(0) })];
/** What is in the bar before the tab strip: if it is the same on two tabs, nothing the tabs sit beside moved. */
const beforeTabs = (html) => html.slice(html.indexOf('class="pointer-events-auto mt-3'), html.indexOf('data-testid="workspace-tab-strip"')).replace(/\s+/g, " ");

await test("bar: the switcher is inside the tab card, after the tabs, so the tabs do not move when it comes and goes (Models tab, first verdict)", async () => {
    const withSwitcher = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    const onModels = await shellHtml({ models: PAIR, active: "s1", tab: "models" });
    const tabs = withSwitcher.indexOf('data-testid="workspace-tab-strip"');
    const switcher = withSwitcher.indexOf('data-testid="version-switcher"');
    assert.ok(tabs > 0 && switcher > tabs, "after the tab strip");
    assert.doesNotMatch(onModels, /data-testid="version-switcher"/, "the Models tab has its own buttons");
    assert.equal(beforeTabs(withSwitcher), beforeTabs(onModels), "everything left of the tabs is the same with and without it");
    // Same for the first verdict landing: no switcher (not analysed) -> an offer.
    const unknown = await shellHtml({ models: [model("m1")], active: "m1", tab: "3d" });
    const offered = await shellHtml({ models: [model("m1", { analysis: summary(4) })], active: "m1", tab: "3d" });
    assert.doesNotMatch(unknown, /data-testid="version-switcher"/);
    assert.match(offered, /data-mode="offer"/);
    assert.equal(beforeTabs(unknown), beforeTabs(offered));
    // And the switcher is the tray, not a card of its own, in there.
    assert.match(withSwitcher.slice(switcher - 40, switcher + 200), /bg-secondary\/60/);
});

await test("bar: a window too narrow for it beside the tabs puts the switcher on a row under the bar; a phone always does, and holds the row while the verdict is pending", async () => {
    const narrow = await shellHtml({ width: 700, models: PAIR, active: "s1" });
    const rowAt = narrow.indexOf('class="mt-2 flex min-h-9 items-center gap-2"');
    assert.ok(rowAt > narrow.indexOf('data-testid="workspace-tab-strip"'), "under the bar");
    assert.ok(narrow.indexOf('data-testid="version-switcher"') > rowAt, "in that row");
    assert.equal(narrow.match(/data-testid="version-switcher"/g).length, 1);
    const wide = await shellHtml({ width: 1300, models: PAIR, active: "s1" });
    assert.doesNotMatch(wide, /min-h-9 items-center/, "no row when it fits in the bar");
    const between = await shellHtml({ width: 900, models: PAIR, active: "s1" });
    assert.doesNotMatch(between, /min-h-9 items-center/, "900 px: still in the bar, with only the numbers");
    assert.doesNotMatch(between.replace(/(aria-label|title)="[^"]*"/g, ""), /4 problems/);
    // A phone: the row exists while the first verdict is pending (empty), and keeps its place when the switcher lands.
    const pending = await shellHtml({ mobile: true, models: [model("m1")], active: "m1" });
    assert.match(pending, /class="mt-2 flex items-center gap-2 min-h-10"/, "room held");
    assert.doesNotMatch(pending, /data-testid="version-switcher"/);
    const landed = await shellHtml({ mobile: true, models: [model("m1", { analysis: summary(4) })], active: "m1" });
    assert.match(landed, /class="mt-2 flex items-center gap-2 min-h-10"/, "the same row");
    assert.match(landed, /data-mode="offer"/);
    const clean = await shellHtml({ mobile: true, models: [model("m1", { analysis: summary(0) })], active: "m1" });
    assert.doesNotMatch(clean, /min-h-10/, "a stable model has nothing to switch to: no row");
});

await test("bar: the 3D tab of a stabilized model gives the viewer the source mesh, the stabilized file to download, and the step offset of its own run", async () => {
    // Original m1 -> S1 (steps 1-2) -> S2 (steps 3-4, its own log has the two steps 1-2): S2's blocks are numbered 1-2 on screen.
    const log = (n) => ({ n, move: "column", at_mm: [0, 0, 0], added: 1 });
    const s1 = stab("s1", "m1", 2, 5, { derived: { added_blocks: 2, steps: [log(1), log(2)] } });
    const s2 = stab("s2", "s1", 2, 10, { derived: { added_blocks: 2, steps: [log(1), log(2)] } });
    const models = [model("m1"), s1, s2];
    const cells = [[0, 0, 0], [1, 0, 0], [2, 0, 0]].map((cell) => ({ cell }));
    const descriptor = lib.descriptorFromBlocks([...cells, { cell: [0, 0, 1], role: "column", step: 1 }, { cell: [1, 0, 1], role: "column", step: 2 }, { cell: [2, 0, 1], role: "column", step: 3 }, { cell: [0, 1, 0], role: "footing", step: 4 }]);
    const result = lib.analyzeAssembly(descriptor, null, lib.sanitizeSettings(null));
    lib.useAnalysisStore.setState({ result, resultModelId: "s2", loaded: { url: "/m1.glb" } });
    const html = await shellHtml({ models, active: "s2" });
    assert.equal(attr(html, "data-url"), "/m1.glb", "the original mesh is on stage");
    assert.equal(attr(html, "data-download-url"), "/s2.glb", "the download is the stabilized file");
    assert.equal(attr(html, "data-supports"), "yes", "with its added blocks");
    assert.equal(attr(html, "data-step-offset"), "2", "the 4 steps of the file minus the 2 of its own log");
    // The original: its own mesh, nothing added, nothing to count.
    lib.useAnalysisStore.setState({ result: null, resultModelId: null });
    const original = await shellHtml({ models, active: "m1" });
    assert.equal(attr(original, "data-url"), "/m1.glb");
    assert.equal(attr(original, "data-supports"), "no");
    assert.equal(attr(original, "data-step-offset"), "(omitted)");
    // A version with no log to count from is left to the viewer rather than guessed.
    lib.useAnalysisStore.setState({ result, resultModelId: "s1" });
    const noLog = await shellHtml({ models: [model("m1"), stab("s1", "m1", 2, 5, { derived: { added_blocks: 2 } })], active: "s1" });
    assert.equal(attr(noLog, "data-step-offset"), "(omitted)");
});

await test("bar: when the blocks of a stabilized model fail to load, the 3D tab says so with Try again (not a bare mesh that looks like nothing was added), and the tab carries a failure mark", async () => {
    const failed = { modelId: "s1", status: "error", error: "The stabilized model's file was not found.", stage: "", progress: 0 };
    lib.useAnalysisStore.setState({ loaded: { url: "/m1.glb" }, run: failed, result: null, resultModelId: null });
    const html = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.match(html, /data-testid="supports-failed"/);
    assert.match(html, /The stabilized model&#x27;s file was not found\./);
    assert.match(html, /data-testid="supports-retry"/);
    assert.match(html, /aria-label="Stability, failed"/, "the tab says it too");
    assert.match(html, /lucide-triangle-alert/);
    // The report has its own error card for the same failure; an original's own failure is the report's too.
    const onAnalysis = await shellHtml({ models: PAIR, active: "s1", tab: "analysis" });
    assert.doesNotMatch(onAnalysis, /data-testid="supports-failed"/);
    assert.match(onAnalysis, /aria-label="Stability, failed"/);
    lib.useAnalysisStore.setState({ run: { ...failed, modelId: "m1" } });
    const original = await shellHtml({ models: PAIR, active: "m1", tab: "3d" });
    assert.doesNotMatch(original, /data-testid="supports-failed"/);
    // A run for another model, or none, is no failure of this one.
    const other = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.doesNotMatch(other, /data-testid="supports-failed"/);
    assert.doesNotMatch(other, /Stability, failed/);
});

await test("bar: when the original mesh cannot be loaded, the stabilized version shows its own blocks (one file for the stage and the analysis), says so, and the original stays its own", async () => {
    lib.toasts.length = 0;
    lib.clearMeshFailures();
    lib.useAnalysisStore.setState({ loaded: null, run: { modelId: null, status: "idle", error: null, stage: "", progress: 0 }, result: null, resultModelId: null, viewerFailure: null });
    const before = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.equal(attr(before, "data-url"), "/m1.glb", "the original mesh is asked for first");
    // The viewer reports the failure of that mesh.
    globalThis.__viewerLoadError("Could not read the file.");
    assert.equal(lib.toasts.length, 1);
    assert.match(lib.toasts[0].title, /original model could not be displayed/);
    assert.match(lib.toasts[0].options.description, /this version.s blocks/);
    assert.equal(lib.useAnalysisStore.getState().viewerFailure, null, "the version is not reported failed: it can still be shown");
    assert.equal(lib.meshFailures().has("m1"), true);
    const after = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.equal(attr(after, "data-url"), "/s1.glb", "its own blocks are on stage");
    assert.equal(attr(after, "data-supports"), "no", "nothing is drawn over them: they are the whole model");
    assert.equal(attr(after, "data-download-url"), "/s1.glb");
    assert.match(after, /data-testid="version-switcher"/, "the way back to the original is still one click away");
    // The original, opened itself, loads its own file; a failure of that one is the ordinary one.
    const original = await shellHtml({ models: PAIR, active: "m1", tab: "3d" });
    assert.equal(attr(original, "data-url"), "/m1.glb");
    lib.toasts.length = 0;
    globalThis.__viewerLoadError("Could not read the file.");
    assert.match(lib.toasts[0].title, /This model could not be displayed/);
    assert.equal(lib.useAnalysisStore.getState().viewerFailure?.url, "/m1.glb");
    // Cleared (another model opened): the source is tried again.
    lib.clearMeshFailures();
    lib.useAnalysisStore.setState({ viewerFailure: null });
    const again = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.equal(attr(again, "data-url"), "/m1.glb");
});

// ================= the Stability tab: its name, its link =================

await test("tab: it is called Stability (the id stays analysis), and its accessible name carries the state", async () => {
    const html = await shellHtml({ models: PAIR, active: "m1", tab: "3d" });
    const tab = html.match(/<button[^>]*data-testid="tab-analysis"[^>]*>.*?<\/button>/)[0];
    assert.match(tab, /Stability/);
    assert.doesNotMatch(tab.replace(/<[^>]*>/g, ""), /Analysis/, "no Analysis anywhere in the tab's words");
    assert.match(tab, /title="Stability \(A while the 3D view has focus\)"/, "the key is still A");
    assert.match(tab, /aria-label="Stability"/);
    const label = (phase, short) => lib.stabilityTabLabel({ phase, verdict: short ? { short } : null });
    assert.equal(label("ready", null), "Stability");
    assert.equal(label("ready", "4 problems"), "Stability, 4 problems");
    assert.equal(label("ready", "Stable"), "Stability, stable");
    assert.equal(label("running", "Stable"), "Stability, running");
    assert.equal(label("error", null), "Stability, failed");
    assert.equal(lib.STABILITY_TAB_LABEL, "Stability");
});

await test("tab: the A key still flips between the 3D view and the tab (the stage handles it, and does not open a sheet)", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(path.join(root, "src/assignment/components/workspace/WorkspaceShell.tsx"), "utf8");
    assert.match(shell, /e\.key\.toLowerCase\(\) !== "a"/);
    assert.match(shell, /workspace\.setWorkspaceTab\("analysis"\)/);
    assert.match(shell, /aria-pressed=\{tab === id\}/);
    assert.doesNotMatch(shell.replace(/\/\/.*$/gm, ""), /setSheetOpen\(true\)/, "the key lands on the peek card; the full report is a tap on it");
});

await test("link: ?tab=analysis, 3d and models as ever, and ?tab=stability is the same tab as analysis; anything else is no tab", () => {
    assert.equal(lib.tabFromParam("analysis"), "analysis", "an opened example links here");
    assert.equal(lib.tabFromParam("stability"), "analysis");
    assert.equal(lib.tabFromParam("3d"), "3d");
    assert.equal(lib.tabFromParam("models"), "models");
    for (const junk of [null, "", "Analysis", "STABILITY", "constructor", "__proto__", "toString", "report", "3D"]) assert.equal(lib.tabFromParam(junk), null, String(junk));
});

await test("link: the page reads the tab through tabFromParam and keeps the link out of the URL afterwards", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(path.join(root, "src/assignment/pages/Workspace.tsx"), "utf8");
    assert.match(page, /tabFromParam\(tabParam\)/);
    assert.doesNotMatch(page, /WORKSPACE_TABS/, "one list of tabs, in shellLogic");
    assert.match(page, /next\.delete\("tab"\)/);
    assert.equal(lib.OPEN_EXAMPLE_QUERY, "?tab=analysis", "an opened example still lands on the tab by its id");
});

// ================= the stage owns the view controls; the bar owns the versions =================

await test("view: a change from the stage reaches the store field by field (colour, layer cut, centre of gravity, original model)", () => {
    const calls = [];
    const to = {
        setColorBy: (v) => calls.push(["colorBy", v]), setLayerMax: (v) => calls.push(["layerMax", v]),
        setShowGhost: (v) => calls.push(["showGhost", v]), setShowCog: (v) => calls.push(["showCog", v]),
    };
    lib.applyViewPatch({}, to);
    assert.deepEqual(calls.splice(0), [], "an empty patch changes nothing");
    lib.applyViewPatch({ colorBy: "layer" }, to);
    assert.deepEqual(calls.splice(0), [["colorBy", "layer"]], "only the field that is in the patch");
    lib.applyViewPatch({ layerMax: 3, showGhost: true, showCog: false }, to);
    assert.deepEqual(calls.splice(0), [["layerMax", 3], ["showGhost", true], ["showCog", false]]);
    lib.applyViewPatch({ showGhost: false, showCog: true, layerMax: 0 }, to);
    assert.deepEqual(calls.splice(0), [["layerMax", 0], ["showGhost", false], ["showCog", true]], "falsy values (0, false) are changes too");
});

await test("view: the real store takes the patch (a false and a 0 included)", () => {
    lib.applyViewPatch({ colorBy: "reach", layerMax: 4, showGhost: true, showCog: false }, AS());
    assert.equal(AS().view.colorBy, "reach");
    assert.equal(AS().view.layerMax, 4);
    assert.equal(AS().view.showGhost, true);
    assert.equal(AS().view.showCog, false);
    lib.applyViewPatch({ layerMax: 0, showGhost: false, showCog: true }, AS());
    assert.equal(AS().view.layerMax, 0);
    assert.equal(AS().view.showGhost, false);
    assert.equal(AS().view.showCog, true);
    assert.equal(AS().view.colorBy, "reach", "what is not in the patch stays");
});

await test("shell: the stage gets the view callback and the layer-cut note, and none of the old compare / version chrome", async () => {
    const html = await shellHtml({ models: PAIR, active: "s1", tab: "analysis" });
    assert.equal(attr(html, "data-view-change"), "yes");
    assert.equal(attr(html, "data-layer-raised"), "false");
    assert.equal(attr(html, "data-compare-props"), "", "no onCompareChange, compareStatus or derivedFrom");
    // What the stage reports lands in the store; a version is not something it can ask for.
    globalThis.__viewerProps.onViewChange({ showCog: false, layerMax: 2 });
    assert.equal(AS().view.showCog, false);
    assert.equal(AS().view.layerMax, 2);
    assert.equal(S().activeModelId, "s1", "the stage never changes the version");
    lib.useAnalysisStore.setState({ layerRaised: true });
    assert.equal(attr(await shellHtml({ models: PAIR, active: "s1", tab: "analysis" }), "data-layer-raised"), "true");
    // The 3D tab hands it over as well (its controls are the same stage).
    assert.equal(attr(await shellHtml({ models: PAIR, active: "s1", tab: "3d" }), "data-view-change"), "yes");
});

await test("shell: the source never builds a CompareChip, a compareStatus or a derivedFrom any more", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(path.join(root, "src/assignment/components/workspace/WorkspaceShell.tsx"), "utf8");
    assert.doesNotMatch(shell.replace(/\/\/.*$/gm, ""), /onCompareChange|compareStatus|derivedFrom|setCompare|originalState|CompareMode/);
});

// ================= the room the panels leave the viewer =================

await test("insets: nothing covers the stage off the Stability tab except the switcher's row", () => {
    const insets = { top: 60, right: 340, bottom: 0, left: 0 };
    const base = { insets, analysisOn: false, mobile: false, switcherRowPx: 0, panelOpen: true, freeWidth: 1100, dockInsetPx: 332, peekPx: 202 };
    assert.deepEqual(lib.viewerInsetsFor(base), insets);
    assert.deepEqual(lib.viewerInsetsFor({ ...base, switcherRowPx: 44 }), { ...insets, top: 104 });
    assert.deepEqual(lib.viewerInsetsFor({ ...base, mobile: true, peekPx: 300 }), insets, "the peek card is the Stability tab's: not here");
});

await test("insets: desktop: the open report takes the left, the folded pill a row at the top", () => {
    const insets = { top: 60, right: 340, bottom: 0, left: 0 };
    const base = { insets, analysisOn: true, mobile: false, switcherRowPx: 44, panelOpen: true, freeWidth: 1100, dockInsetPx: 332, peekPx: 202 };
    assert.deepEqual(lib.viewerInsetsFor(base), { ...insets, left: lib.dockInset(1100, 332) });
    assert.deepEqual(lib.viewerInsetsFor({ ...base, panelOpen: false }), { ...insets, top: 60 + 44 + lib.FOLDED_PILL_ROW_PX + 4 });
    assert.equal(lib.viewerInsetsFor({ ...base, peekPx: 999 }).bottom, 0, "no peek card on a desktop");
});

await test("insets: phone: a row at the top for the picked issue and the card's height (plus air) at the bottom, so the toolbar sits above it", () => {
    const insets = { top: 56, right: 0, bottom: 0, left: 0 };
    const base = { insets, analysisOn: true, mobile: true, switcherRowPx: 0, panelOpen: false, freeWidth: 375, dockInsetPx: 332, peekPx: 190 };
    assert.deepEqual(lib.viewerInsetsFor(base), { top: 56 + lib.PHONE_SELECTION_ROW_PX, right: 0, bottom: 190 + lib.PHONE_PEEK_GAP_PX, left: 0 });
    assert.equal(lib.viewerInsetsFor({ ...base, switcherRowPx: 48 }).top, 56 + 48, "the switcher's row is taller than the pick's: it sets the top");
    assert.equal(lib.viewerInsetsFor({ ...base, peekPx: 120 }).bottom, 120 + lib.PHONE_PEEK_GAP_PX, "a shorter card (a clean model) leaves more room");
    assert.equal(lib.PHONE_SELECTION_ROW_PX, 40, "8 px of air and the 32 px chip");
});

// ================= the phone: the peek card, the sheet, the pick =================

await test("phone tab: the first tap lands on the peek card; a tap on the open tab opens the sheet, another folds it", () => {
    const tap = (over) => lib.sheetOnTabTap({ mobile: true, tapped: "analysis", current: "3d", sheetOpen: false, ...over });
    assert.equal(tap({}), null, "from another tab: the peek card, the sheet stays shut");
    assert.equal(tap({ current: "models" }), null);
    assert.equal(tap({ current: "analysis" }), true, "the open tab again: the full report");
    assert.equal(tap({ current: "analysis", sheetOpen: true }), false, "and again: folded");
    assert.equal(tap({ tapped: "3d", current: "analysis" }), null, "other tabs have no sheet");
    assert.equal(tap({ tapped: "models", current: "analysis" }), null);
    assert.equal(tap({ mobile: false, current: "analysis" }), null, "the desktop's report is a panel");
});

await test("phone: the Stability tab shows the peek card docked at the foot of the stage, and the picked issue in the top row", async () => {
    const html = await shellHtml({ mobile: true, models: PAIR, active: "m1", tab: "analysis" });
    const dock = html.indexOf('data-testid="analysis-peek-dock"');
    assert.ok(dock > 0, "the card is docked");
    assert.match(html.slice(dock - 20, dock + 400), /absolute inset-x-0 bottom-0/);
    assert.match(html.slice(dock, dock + 1200), /pointer-events-auto touch-none/, "only the card takes touches, and none of them is taken for a pan (S5: the swipe up is a drag, not a page scroll)");
    assert.match(html.slice(dock), /data-testid="analysis-peek-card"/, "the card is what is docked");
    assert.doesNotMatch(html, /data-testid="analysis-pill"/, "no pill: the card replaces it");
    assert.doesNotMatch(html, /data-testid="analysis-selection"/, "nothing picked: no chip");
    // What is being shown on the model is a chip in the top row, above the stage, not in the card.
    lib.useAnalysisStore.setState({ selection: { label: "Arm too long" } });
    const picked = await shellHtml({ mobile: true, models: PAIR, active: "m1", tab: "analysis" });
    const chip = picked.indexOf('data-testid="analysis-selection"');
    assert.ok(chip > 0 && chip < picked.indexOf('data-testid="analysis-peek-dock"'), "the picked issue's chip is in the row at the top");
    assert.match(picked, /Arm too long/);
    lib.useAnalysisStore.setState({ selection: null });
    // The card is in the free room: the stage's bottom inset carries it (the estimate before it has been measured).
    const insets = JSON.parse(attr(html, "data-insets").replace(/&quot;/g, '"'));
    assert.equal(insets.bottom, lib.ANALYSIS_PEEK_CARD_PX + lib.PHONE_PEEK_MARGIN_PX + lib.PHONE_PEEK_GAP_PX);
    assert.ok(insets.top >= lib.PHONE_SELECTION_ROW_PX);
    // The 3D tab has neither the card nor its room.
    const flat = await shellHtml({ mobile: true, models: PAIR, active: "m1", tab: "3d" });
    assert.doesNotMatch(flat, /analysis-peek-dock/);
    assert.equal(JSON.parse(attr(flat, "data-insets").replace(/&quot;/g, '"')).bottom, 0);
});

await test("phone: the card is out of the way while the full report is open (one copy of the buttons), and its room is kept", async () => {
    lib.useAnalysisStore.setState({ sheetOpen: true });
    const html = await shellHtml({ mobile: true, models: PAIR, active: "m1", tab: "analysis" });
    assert.doesNotMatch(html, /analysis-peek-dock/);
    assert.equal(JSON.parse(attr(html, "data-insets").replace(/&quot;/g, '"')).bottom, lib.ANALYSIS_PEEK_CARD_PX + lib.PHONE_PEEK_MARGIN_PX + lib.PHONE_PEEK_GAP_PX, "the stage is not re-framed behind the sheet");
});

await test("phone: the top row keeps its height with nothing picked, and holds the version switcher beside the pick", async () => {
    const clean = await shellHtml({ mobile: true, models: [model("m1", { analysis: summary(0) })], active: "m1", tab: "analysis" });
    assert.match(clean, /class="mt-2 flex items-center gap-2 min-h-8"/, "a 32 px row under 8 px of air, so a pick does not move the stage");
    const pair = await shellHtml({ mobile: true, models: PAIR, active: "s1", tab: "analysis" });
    assert.match(pair, /class="mt-2 flex items-center gap-2 min-h-10"/, "with the switcher: its taller row");
    assert.match(pair, /data-testid="version-switcher"/);
    const flat = await shellHtml({ mobile: true, models: [model("m1", { analysis: summary(0) })], active: "m1", tab: "3d" });
    assert.doesNotMatch(flat, /min-h-8/);
});

// ================= a saved stabilize run opens the new version, on the tab that is open =================

await test("auto-switch: when a run saves, the new version opens in the viewer and the tab stays where it was (Stability stays Stability)", async () => {
    const source = model("m1", { analysis: summary(2) });
    const saved = stab("s1", "m1", 4, 5, { analysis: summary(0), derived: derivedOf(4) });
    load([source], "m1", "analysis");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1" });
    lib.useAnalysisStore.setState({ panelOpen: true });
    const answer = {
        complete: true, stop: "stable", glb: new Uint8Array([1, 2, 3]), descriptor: { cells: [] }, before: metrics({ blocks: 3, errors: 2 }),
        after: metrics(), meta: derivedOf(4),
    };
    let uploadedFor = null;
    lib.setStabilizeDeps({
        run: async () => answer,
        upload: async (sourceId) => {
            uploadedFor = sourceId;
            return saved;
        },
    });
    assert.equal(lib.useStabilizeStore.getState().start(source, planned()), true);
    const end = Date.now() + 4000;
    while (lib.useStabilizeStore.getState().status !== "saved") {
        if (Date.now() > end) throw new Error(`the run did not save (${lib.useStabilizeStore.getState().status})`);
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(uploadedFor, "m1");
    assert.equal(S().activeModelId, "s1", "the saved version is the one in the viewer");
    assert.equal(S().workspaceTab, "analysis", "on the same tab");
    assert.equal(AS().panelOpen, true, "and the panel stays as it was");
    assert.deepEqual(lib.toasts.filter((t) => t.kind === "success").map((t) => t.title), ["Switched to the stabilized version"], "and it says so, once");
    // ...and the bar says which version that is, with the way back: the same switch as everywhere else.
    const html = await shellHtml({ models: S().models, active: "s1", tab: "analysis" });
    assert.match(html, /aria-checked="true"[^>]*data-testid="version-head"|data-testid="version-head"[^>]*aria-checked="true"/);
    assert.match(html, /Showing v2 · Stabilized/);
});

/** The answer of a stabilizer that added 4 blocks, and a run for `source` that waits on `upload` (released by the caller) before it saves. */
function startRun(source, saved) {
    const answer = { complete: true, stop: "stable", glb: new Uint8Array([1]), descriptor: { cells: [] }, before: metrics(), after: metrics(), meta: derivedOf(4) };
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    lib.setStabilizeDeps({ run: async () => answer, upload: async () => (await gate, saved) });
    assert.equal(lib.useStabilizeStore.getState().start(source, planned()), true);
    return release;
}
const settled = async (done, what) => {
    const end = Date.now() + 4000;
    while (!done()) {
        if (Date.now() > end) throw new Error(`timed out: ${what} (${lib.useStabilizeStore.getState().status})`);
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
};

await test("auto-switch: from the 3D tab it stays on 3D", async () => {
    const source = model("m1", { analysis: summary(2) });
    load([source], "m1", "3d");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1" });
    const release = startRun(source, stab("s1", "m1", 4, 5, { analysis: summary(0), derived: derivedOf(4) }));
    await settled(() => lib.useStabilizeStore.getState().status === "saving", "saving");
    assert.equal(S().activeModelId, "m1", "nothing moves before the file is saved");
    release();
    await settled(() => lib.useStabilizeStore.getState().status === "saved", "saved");
    assert.equal(S().activeModelId, "s1");
    assert.equal(S().workspaceTab, "3d");
});

/** What the shell hands `useHeldStage`, from the stores (the same reading as useAnalysisSnapshot and the shell make of them). */
function stageInput() {
    const w = S();
    const a = AS();
    const active = w.models.find((m) => m.id === w.activeModelId);
    const family = lib.versionFamily(w.models, w.activeModelId);
    const url = family.display.glb_url;
    const phase = lib.derivePhase({ modelId: active.id, ready: a.loaded?.url === url, run: a.run, resultModelId: a.resultModelId });
    return {
        own: a.resultModelId === active.id ? a.result : null,
        preview: a.preview && a.preview.modelId === active.id ? a.preview.result : null,
        url,
        family: family.root?.id ?? family.active.id,
        waiting: phase === "loading" || phase === "running",
    };
}

await test("auto-switch: the stage keeps its picture across the switch (S2), and the report is not handed it", async () => {
    const source = model("m1", { analysis: summary(2) });
    load([source], "m1", "analysis");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1" });
    const result = planned();
    const finalPreview = { ...planned() };
    // The source is analysed and on stage, and the run's last preview is drawn over it.
    lib.useAnalysisStore.setState({ result, resultModelId: "m1", loaded: { url: "/m1.glb" }, preview: { modelId: "m1", result: finalPreview } });
    const before = lib.holdStage(null, stageInput());
    assert.equal(before.analysis, result);
    assert.equal(before.held.result, finalPreview, "what the stage draws while the run finishes is what is held");
    const release = startRun(source, stab("s1", "m1", 4, 5, { analysis: summary(0), derived: derivedOf(4) }));
    await settled(() => lib.useStabilizeStore.getState().status === "saving", "saving");
    release();
    await settled(() => lib.useStabilizeStore.getState().status === "saved", "saved");
    assert.equal(S().activeModelId, "s1");
    // The gap the switch opens: the new version has neither a result nor a preview of its own, and its analysis is on its way. The
    // report reads exactly this (so it shows its skeleton, not the source's verdict)...
    const gap = stageInput();
    assert.deepEqual([gap.own, gap.preview, gap.waiting], [null, null, true]);
    assert.equal(gap.url, "/m1.glb", "on the same mesh: the stabilized version is drawn over its source");
    // ...and the stage is not left with the plain mesh: it keeps drawing the last picture until the version's own result lands.
    const held = lib.holdStage(before.held, gap);
    assert.equal(held.analysis !== null, true);
    assert.equal(held.analysis, finalPreview);
    assert.equal(held.holding, true);
    // The analysis fails: no picture of a version that was never analysed.
    lib.useAnalysisStore.setState({ run: { modelId: "s1", status: "error", error: "no", stage: "", progress: 0 } });
    assert.equal(lib.holdStage(before.held, stageInput()).analysis, null);
    // It lands: the version's own result is drawn.
    const landed = planned();
    lib.useAnalysisStore.setState({ run: lib.IDLE_RUN, result: landed, resultModelId: "s1" });
    assert.equal(lib.holdStage(held.held, stageInput()).analysis, landed);
});

await test("shell: the stage is handed the model's own result and the block callbacks; the stage hold is the only thing between the two", async () => {
    const result = planned();
    lib.useAnalysisStore.setState({ result, resultModelId: "m1", loaded: { url: "/m1.glb" } });
    await shellHtml({ models: PAIR, active: "m1", tab: "analysis" });
    assert.equal(globalThis.__viewerProps.analysis, result, "its own result, as it was before the hold existed");
    assert.equal(typeof globalThis.__viewerProps.onBlockHover, "function");
    assert.equal(typeof globalThis.__viewerProps.onBlockClick, "function");
    // The version that has no result yet (nothing was held by this first render): nothing to draw, and the callbacks stay.
    await shellHtml({ models: PAIR, active: "s1", tab: "analysis" });
    assert.equal(globalThis.__viewerProps.analysis, null);
    // The wiring in the source: the viewer gets the held stage, the report keeps the snapshot, and blocks that are not the report's are not hoverable.
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(path.join(root, "src/assignment/components/workspace/WorkspaceShell.tsx"), "utf8").replace(/\/\/.*$/gm, "");
    assert.match(shell, /useHeldStage\(\{[^}]*own: snapshot\.viewResult[^}]*preview: snapshot\.previewResult/s);
    assert.match(shell, /analysis=\{stage\.analysis\}/);
    assert.doesNotMatch(shell, /analysis=\{snapshot\.viewResult\}/);
    assert.match(shell, /onBlockHover=\{stage\.holding \? undefined : handleBlockHover\}/);
    assert.match(shell, /onBlockClick=\{stage\.holding \? undefined : handleBlockClick\}/);
    assert.match(shell, /<AnalysisDock model=\{activeModel\} snapshot=\{snapshot\} \/>/, "the report reads the snapshot, never the held picture");
});

await test("auto-switch: a run that saves after the user has opened another project leaves that project alone", async () => {
    const source = model("m1", { analysis: summary(2) });
    load([source], "m1", "analysis");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1" });
    const release = startRun(source, stab("s1", "m1", 4, 5, { analysis: summary(0), derived: derivedOf(4) }));
    await settled(() => lib.useStabilizeStore.getState().status === "saving", "saving");
    // The user moves to another project (and another model) while the file uploads.
    load([model("other", { project_id: "p2" })], "other", "3d");
    lib.useWorkspaceStore.setState({ activeProjectId: "p2" });
    release();
    await settled(() => lib.useStabilizeStore.getState().status === "idle", "idle");
    assert.equal(S().activeModelId, "other");
    assert.equal(S().workspaceTab, "3d");
    assert.equal(S().models.some((m) => m.id === "s1"), false, "the version is on the server; this project's list does not get it");
    assert.deepEqual(lib.toasts.map((t) => t.title), ["Saved a stabilized version"], "it says where it went instead of switching");
});

// ================= the chat cards speak the same words =================

await test("chat: a card says Stability check, not Analysis, and has no Compare button (the bar and the stage do that)", () => {
    const original = model("o", { kind: "example", example_slug: "arch" });
    const twin = model("t", { kind: "stabilized", source_model_id: "o", example_slug: "arch", analysis: summary(1), derived: derivedOf(4, { before: metrics({ errors: 2, max_utilisation: 1.98 }), after: metrics({ max_utilisation: 0.21 }) }) });
    load([original, twin], "o");
    const card = (m) => render(h(lib.MemoryRouter, null, h(lib.ModelCard, { model: m, models: [original, twin], active: false, onView() {} })));
    const html = card(twin);
    assert.match(html, />Stability check</);
    assert.match(html, /\+4 blocks · 1 problem · open stability check/, "the verdict line says where it leads");
    assert.match(html, /aria-label="This version: [^"]*Open the stability check\."/);
    assert.match(html, /Strength used 198% → 21%/, "plain words for the load on the worst joint");
    assert.doesNotMatch(html, /Compare|Open analysis|open analysis|Highest joint stress|the structure/);
    assert.match(html, /data-label="Original"/, "the way to the other half is the pair link, the bar's switch");
    // The model it was made from: the same line in the same words.
    const first = card(original);
    assert.match(first, /data-testid="verdict-line"/);
    assert.match(first, /Check stability/, "not analysed yet");
    assert.doesNotMatch(first, /Compare|Open analysis|open analysis|the structure/);
    load([model("o", { kind: "example", example_slug: "arch", analysis: summary(3) }), twin], "o");
    const failing = card(S().models[0]);
    // (The fixture's fill threshold is not the assignment's: the line says which rule the verdict was reached with.)
    assert.match(failing, /3 problems · fill 30% · open stability check</);
    assert.match(failing, /aria-label="Stability: 3 problems · fill 30% · open stability check\. Open the stability check\."/);
    load([model("o", { kind: "example", example_slug: "arch", analysis: summary(0) }), twin], "o");
    assert.match(card(S().models[0]), /Stable · 30 blocks · fill 30%</, "a stable model says how many blocks it has");
});

await test("models list: the verdict chip speaks of the stability check, and a model not checked yet says Check", () => {
    const fresh = model("m1");
    const failing = model("m2", { analysis: summary(4) });
    load([fresh, failing], "m1", "models");
    const html = render(h(lib.ModelsPanel, { models: [fresh, failing], activeModelId: "m1", providers: undefined, onView() {}, onDelete: undefined }));
    assert.match(html, />Check</);
    assert.match(html, /aria-label="Check this model&#x27;s stability"/);
    assert.match(html, /aria-label="Open the stability check of this model: 4 problems \(custom settings: fill 30%\)"/);
    assert.doesNotMatch(html, /Analyse|Open the analysis|structure/);
});

// ================= a project that has a model is never the new-chat hero (the page, the chat panel) =================

/** A media-query stand-in: the page asks for the phone layout and the colour scheme at render. */
function withMatchMedia(matches, run) {
    const before = globalThis.window.matchMedia;
    globalThis.window.matchMedia = () => ({ matches, media: "", addEventListener() {}, removeEventListener() {} });
    return Promise.resolve(run()).finally(() => {
        if (before) globalThis.window.matchMedia = before;
        else delete globalThis.window.matchMedia;
    });
}
const PROJECT_ID = "2f6f1a43-7a3c-4a58-9a6f-0c1d2b3c4d5e";
const job = (over = {}) => ({
    id: "j-muse", project_id: PROJECT_ID, provider: "muse", prompt: "a desk lamp", status: "running", progress: 0, stage: "Designing the parts\u2026",
    error: null, created_at: new Date(Date.now() - 4000).toISOString(), updated_at: at(0), finished_at: null, model: null, ...over,
});
const MUSE = { id: "muse", label: "Muse Spark 1.3", vendor: "Meta via OpenRouter", via: "openrouter", available: true, description: "An AI model designs the object as named parts; the app builds them into a multi-part assembly", parts: true, textured: false, approx_seconds: 35 };
const HUNYUAN = { id: "hunyuan", label: "Hunyuan 3D 3.1", vendor: "Tencent", via: "tencent", available: true, description: "Text to a textured 3D mesh.", parts: false, textured: true, approx_seconds: 120 };
/** The workspace page, server-rendered at /app/<id> with the store as given; twice, because the viewer is a lazy import. */
async function pageHtml({ messages = [], models = [], jobs = {}, phone = false } = {}) {
    lib.useWorkspaceStore.setState({
        activeProjectId: PROJECT_ID, loadingProjectId: null, project: { id: PROJECT_ID, name: "Lamp", pinned: false }, messages, jobs, models,
        activeModelId: models[0]?.id ?? null, workspaceTab: "3d", chatHidden: false, providers: { providers: [MUSE, HUNYUAN], default_provider: "muse", access_required: false, daily_limit: null, used_today: 0 },
    });
    return withMatchMedia(phone, async () => {
        const element = h(lib.MemoryRouter, { initialEntries: [`/app/${PROJECT_ID}`] }, h(lib.Routes, null, h(lib.Route, { path: "/app/:projectId", element: h(lib.Workspace) })));
        render(element);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return render(element);
    });
}
/** The blank canvas that covers the viewer for a new chat: fully opaque for the hero, gone for a project with something in it. */
const heroCover = (html) => html.match(/pointer-events-none absolute inset-0 z-20 bg-canvas[^"]*(opacity-\d+)/)?.[1];
const panelHidden = (html) => /pointer-events-auto h-full py-3 pr-3 [^"]*invisible/.test(html);

await test("a project with a model and no messages shows the model and the chat panel, not the new-chat hero", async () => {
    const html = await pageHtml({ models: [model("m1", { project_id: PROJECT_ID })] });
    assert.equal(heroCover(html), "opacity-0", "the blank canvas does not cover the viewer");
    assert.match(html, /data-testid="viewer-stub"[^>]*data-url="\/m1\.glb"/, "the model is on stage");
    assert.equal(panelHidden(html), false, "the chat panel is open");
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /No messages in this project yet\./, "an empty-state line says why the chat is empty");
    assert.doesNotMatch(text, /What do you want to build\?/);
    assert.doesNotMatch(html, /data-testid="hero-start"/, "no example gallery or prompts either");
    assert.match(html, /placeholder="Describe another object"/, "the box is for the next object");
});

await test("a project with only a running job is also a conversation: the card shows, the hero stays away", async () => {
    const html = await pageHtml({ jobs: { "j-muse": job() } });
    assert.equal(heroCover(html), "opacity-0");
    assert.equal(panelHidden(html), false);
    assert.match(html, /data-testid="unlisted-jobs"/, "a run no message points at is still shown");
    assert.match(html, /data-testid="chat-empty-project"/);
    assert.doesNotMatch(html, /What do you want to build\?/);
});

await test("an unlisted run quotes its prompt (no bubble says what was asked), and the empty note does not offer 'another model' when there is none", async () => {
    // A Muse job made through the API: no message points at it.
    const running = await pageHtml({ jobs: { "j-muse": job({ prompt: "a desk lamp with a round base" }) } });
    const card = running.slice(running.indexOf('data-testid="unlisted-jobs"'));
    assert.match(card, /data-testid="job-prompt"[^>]*>\s*“a desk lamp with a round base”/, "the card says what was asked");
    const text = running.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    assert.match(text, /No messages in this project yet\. Describe an object below\./, "no model exists, so there is nothing to add another to");
    assert.doesNotMatch(text, /add another model/);
    // A failed run of it: the error and Retry now come with the question.
    const failed = await pageHtml({ jobs: { "j-muse": job({ status: "failed", error: "Muse Spark did not answer in time.", prompt: "a desk lamp with a round base", finished_at: at(0) }) } });
    assert.match(failed, /data-testid="job-prompt"[^>]*>\s*“a desk lamp with a round base”/);
    assert.match(failed, /Muse Spark did not answer in time\./);
    // With a model in the project the note keeps its offer.
    const withModel = await pageHtml({ models: [model("m1", { project_id: PROJECT_ID })] });
    assert.match(withModel.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "), /No messages in this project yet\. Describe an object below to add another model\./);
    // A job a message lists has its question in the bubble above it: not said twice.
    const listed = await pageHtml({
        messages: [{ id: "u", role: "user", content: "a desk lamp", timestamp: at(0) }, { id: "a", role: "assistant", content: "On it.", timestamp: at(1), job_ids: ["j-muse"] }],
        jobs: { "j-muse": job({ prompt: "a desk lamp" }) },
    });
    assert.match(listed, /data-testid="job-card"/);
    assert.doesNotMatch(listed, /data-testid="job-prompt"/, "the user's bubble is the question");
    assert.doesNotMatch(listed, /data-testid="unlisted-jobs"/);
});

await test("a project with messages and no model is unchanged (the chat, and a note that the model is coming)", async () => {
    const html = await pageHtml({ messages: [{ id: "a", role: "user", content: "a lamp", timestamp: at(0) }] });
    assert.equal(heroCover(html), "opacity-0");
    assert.equal(panelHidden(html), false);
    assert.doesNotMatch(html, /data-testid="chat-empty-project"/, "there is a message, so nothing is empty");
    // The stage's own placeholder (the stand-in viewer is handed it and shows it only while it has no model).
    assert.match(render(globalThis.__viewerProps.emptyState), /Your model will appear here/);
});

await test("a truly empty project is still the new-chat hero: the blank canvas, the question, the collapsed panel", async () => {
    const html = await pageHtml();
    assert.equal(heroCover(html), "opacity-100");
    assert.equal(panelHidden(html), true, "the panel is folded away until the first message");
    assert.match(html, /What do you want to build\?/);
    assert.doesNotMatch(html, /data-testid="chat-empty-project"/);
});

await test("on a phone the same project opens on the model, and its chat says it is empty instead of showing the hero", async () => {
    const html = await pageHtml({ models: [model("m1", { project_id: PROJECT_ID })], phone: true });
    assert.match(html, /data-testid="viewer-stub"[^>]*data-url="\/m1\.glb"/);
    assert.match(html, /absolute inset-0 bg-sidebar [^"]*hidden"/, "the chat sits behind the canvas, which is on show");
    assert.match(html, /data-testid="chat-empty-project"/);
    assert.doesNotMatch(html, /What do you want to build\?/);
});

// ================= Muse Spark, the AI designer, in the picker and on the card =================

await test("the picker's row for Muse Spark: the helper line, a Parts badge, who makes it and how long it takes; an ordinary model has neither", () => {
    const row = render(h(lib.ProviderOption, { provider: MUSE }));
    assert.match(row, /data-testid="provider-designer-note"[^>]*>AI designer · builds the object from named parts</);
    assert.match(row, />Parts</, "the Parts badge");
    assert.doesNotMatch(row, /Designs the object as a list/, "the helper stands in for the server's longer line");
    assert.doesNotMatch(row, />Textured</);
    assert.match(row, /Meta via OpenRouter · ~35 s</, "the key is named once: the maker's line already says it");
    assert.doesNotMatch(row.replace(/<[^>]*>/g, ""), /via OpenRouter.*via OpenRouter/, "not twice");
    assert.doesNotMatch(row, /~35 s · via/);
    assert.match(row, />Muse Spark 1.3</);
    const plain = render(h(lib.ProviderOption, { provider: HUNYUAN }));
    assert.doesNotMatch(plain, /AI designer|data-testid="provider-designer-note"|>Parts</);
    assert.match(plain, />Textured</);
    assert.match(plain, /Tencent · ~2 min · via Tencent/, "a maker whose line does not say which key runs it still gets the badge");
    const noKey = render(h(lib.ProviderOption, { provider: { ...MUSE, available: false, via: null } }));
    assert.match(noKey, /needs an API key/);
    assert.match(noKey, /AI designer/, "still described when it cannot be used");
});

await test("the picker with Muse Spark chosen names it; with it the only model it says what it does in the tooltip", () => {
    const both = render(h(lib.ProviderPicker, { providers: [MUSE, HUNYUAN], selected: ["muse"], onChange() {} }));
    assert.match(both, /aria-label="Model: Muse Spark 1\.3\. Change model"/);
    const only = render(h(lib.ProviderPicker, { providers: [MUSE, { ...HUNYUAN, available: false, via: null }], selected: ["muse"], onChange() {} }));
    assert.match(only, /title="AI designer · builds the object from named parts · An AI model designs the object as named parts; the app builds them into a multi-part assembly · via OpenRouter"/);
    assert.match(only, />Muse Spark 1\.3<span class="opacity-70"> · AI designer<\/span></, "and the label says what kind of model it is");
    const plainOnly = render(h(lib.ProviderPicker, { providers: [{ ...MUSE, available: false, via: null }, HUNYUAN], selected: ["hunyuan"], onChange() {} }));
    assert.doesNotMatch(plainOnly, /AI designer/, "an ordinary model is just its name");
});

await test("the job card of an AI designer: a Parts badge, the helper while it runs, a stage with no doubled ellipsis, then the part count", () => {
    const card = (j) => render(h(lib.JobCard, { job: j, providers: [MUSE, HUNYUAN], active: false, canRetry: true, onView() {}, onRetry() {} }));
    const designing = card(job());
    assert.match(designing, /data-testid="job-stage"[^>]*>Designing the parts</, "the dots are drawn by the card");
    assert.doesNotMatch(designing, /Designing the parts(\u2026|\.\.\.)/);
    assert.match(designing, />Parts</);
    assert.match(designing, />via OpenRouter</);
    assert.match(designing, /data-testid="job-designer-note"[^>]*>AI designer · builds the object from named parts</);
    assert.match(card(job({ stage: "Building the 3D model" })), /data-testid="job-stage"[^>]*>Building the 3D model</);
    assert.match(card(job({ status: "queued", stage: "" })), /data-testid="job-stage"[^>]*>Queued</, "a job that has not started says so");
    // An ordinary model's card has no designer line.
    assert.doesNotMatch(card(job({ provider: "hunyuan", stage: "Generating 3D model" })), /job-designer-note|>Parts</);
    // Done: how many parts it was built from, like any assembly.
    const done = card(job({ status: "succeeded", progress: 100, stage: "Done", model: model("m9", { provider: "muse", part_count: 21, size_bytes: 52_000 }) }));
    assert.match(done, /21 parts · 51 KB/);
    assert.doesNotMatch(done, /job-designer-note/, "the note is for the wait");
    // A failure reads as it did.
    assert.match(card(job({ status: "failed", error: "The designer sent no parts.", stage: "Failed" })), /The designer sent no parts\./);
});

// ================= versions, edits and the Optimization tab (the foundation of the build) =================

const ASSIST = { available: true, queued: true, images: true, model: "meta/muse-spark-1.3-contributor", daily_limit: 400, used_today: 3 };
const providersWith = (assist, extra = {}) => ({ providers: [MUSE, HUNYUAN], default_provider: "muse", access_required: false, daily_limit: null, used_today: 0, assist, ...extra });
const editJob = (over = {}) => job({ id: "j-edit", kind: "edit", edit: { source_model_id: "m1", target: "design", result: null }, prompt: "make the back taller", stage: "Designing the change", ...over });

// ---------- the work guard ----------

await test("work guard: one kind of work at a time per project, the second is told to finish or discard the first", () => {
    const release = lib.acquireWork("stabilize", "p1", { label: "Stabilizing" });
    assert.equal(typeof release, "function");
    assert.equal(lib.currentWork().kind, "stabilize");
    assert.equal(lib.acquireWork("blocks", "p1"), null);
    assert.equal(lib.acquireWork("optimize", "p1"), null);
    assert.equal(lib.workBusyMessage("blocks", "p1"), "Finish or discard the stabilizing first.");
    assert.equal(lib.workBusyMessage("stabilize", "p1"), null, "its own kind is not in its way");
    assert.equal(lib.anyWorkMessage("p1"), "Finish or discard the stabilizing first.");
    assert.equal(lib.anyWorkMessage("p2"), null, "another project's work is not this one's");
    release();
    release();
    assert.equal(lib.currentWork(), null, "given back (and a second call does nothing)");
    const again = lib.acquireWork("optimize", "p1");
    assert.ok(again);
    assert.equal(lib.workBusyMessage("blocks", "p1"), "Finish or discard the optimization first.");
    again();
    const blocks = lib.acquireWork("blocks", "p1");
    assert.equal(lib.workBusyMessage("stabilize", "p1"), "Finish or discard the block changes first.");
    blocks();
});

await test("work guard: the same work may take it twice (the router and the store); it is free when both have given it back", () => {
    const outer = lib.acquireWork("blocks", "p1", { label: "Changing the blocks" });
    const inner = lib.acquireWork("blocks", "p1", { stop: () => {} });
    assert.ok(outer && inner);
    assert.equal(typeof lib.currentWork().stop, "function", "what the second told it is kept");
    outer();
    assert.equal(lib.currentWork()?.kind, "blocks", "one taker left");
    inner();
    assert.equal(lib.currentWork(), null);
    // A release from work that was replaced does not give back the new work's hold.
    const first = lib.acquireWork("blocks", "p1");
    lib.resetWorkGuard();
    const second = lib.acquireWork("optimize", "p1");
    first();
    assert.equal(lib.currentWork()?.kind, "optimize");
    second();
});

await test("work guard: opening another project drops it; an edit job on the queue keeps all other work out; waiting turns the optimizer's mark into a dot", () => {
    lib.useWorkspaceStore.setState({ activeProjectId: "p1" });
    lib.acquireWork("stabilize", "p1");
    assert.ok(lib.currentWork());
    lib.useWorkspaceStore.setState({ activeProjectId: "p2" });
    assert.equal(lib.currentWork(), null, "the work stopped with its project");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1", jobs: { e: editJob({ project_id: "p1" }) } });
    assert.equal(lib.acquireWork("blocks", "p1"), null, "a change to the design is on its way");
    assert.equal(lib.workBusyMessage("optimize", "p1"), "Wait for the change to finish first.");
    lib.useWorkspaceStore.setState({ jobs: { e: editJob({ project_id: "p1", status: "succeeded", model: null }) } });
    const release = lib.acquireWork("optimize", "p1");
    assert.ok(release, "a finished job is no obstacle");
    assert.equal(lib.currentWork().waiting, false);
    lib.setWorkWaiting("optimize", true);
    assert.equal(lib.currentWork().waiting, true);
    lib.setWorkWaiting("blocks", false);
    assert.equal(lib.currentWork().waiting, true, "another kind's flag is not this one's");
    release();
});

// ---------- the notes ----------

await test("chat notes: the person's words and the assistant's line go in the chat of the open project, and nowhere else", () => {
    lib.useWorkspaceStore.setState({ activeProjectId: "p1", messages: [] });
    const user = lib.postUserNote("p1", "  add a shelf  ");
    const reply = lib.postAssistantNote("p1", "Added a shelf.", { modelIds: ["a", "b", ...Array.from({ length: 12 }, (_, i) => `x${i}`)] });
    const messages = S().messages;
    assert.deepEqual(messages.map((m) => [m.role, m.content]), [["user", "add a shelf"], ["assistant", "Added a shelf."]]);
    assert.equal(messages[1].model_ids.length, 10, "at most ten cards");
    assert.deepEqual(messages[1].model_ids.slice(0, 2), ["a", "b"]);
    assert.equal(messages[0].model_ids, undefined);
    assert.ok(user && reply && user !== reply);
    assert.equal(lib.postUserNote("elsewhere", "hello"), null, "another project is open");
    assert.equal(lib.postAssistantNote("p1", "   "), null, "nothing to say");
    assert.equal(S().messages.length, 2);
    lib.removeNote(user);
    lib.removeNote(null);
    assert.deepEqual(S().messages.map((m) => m.role), ["assistant"]);
});

// ---------- what the words do ----------

await test("composer state: edit by default when a model can be edited; the person's choice wins; an example or a server without the editor falls back to New with the reason", () => {
    const muse = model("m1", { provider: "muse" });
    const ex = model("ex", { kind: "example", provider: "example", example_slug: "shelf-arm" });
    const state = (models, active, over = {}) => lib.composerStateOf({ models, activeModelId: active, tab: "3d", assist: ASSIST, choice: null, ...over });
    assert.deepEqual(state([], null), { mode: "new", hasModel: false, canEdit: false, editReason: null, target: null, subject: null });
    const a = state([muse], "m1");
    assert.deepEqual([a.mode, a.canEdit, a.target, a.subject], ["edit", true, "design", "the original"]);
    assert.equal(state([muse], "m1", { choice: "new" }).mode, "new", "the choice wins");
    assert.equal(state([muse], "m1", { choice: "edit" }).mode, "edit");
    const hun = state([model("m1")], "m1");
    assert.equal(hun.target, "mesh");
    const stabilized = state([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    assert.deepEqual([stabilized.target, stabilized.subject], ["voxel", "v2 · Stabilized"]);
    const onExample = state([ex], "ex");
    assert.deepEqual([onExample.mode, onExample.canEdit, onExample.hasModel], ["new", false, true]);
    assert.match(onExample.editReason, /Edits work on models you generate/);
    assert.equal(state([ex], "ex", { tab: "analysis" }).mode, "edit", "an example's blocks can be changed on the Stability tab");
    const noEditor = state([muse], "m1", { assist: undefined });
    assert.deepEqual([noEditor.mode, noEditor.canEdit, noEditor.editReason], ["new", false, "The AI editor is not set up on the server."]);
    assert.equal(state([muse], "m1", { assist: { ...ASSIST, queued: false } }).canEdit, false, "a design needs the queue");
    assert.equal(state([model("m1"), stab("s1", "m1", 4, 5)], "s1", { assist: { ...ASSIST, queued: false } }).canEdit, true, "the blocks do not");
    assert.equal(state([muse], "m1", { assist: { ...ASSIST, available: false } }).canEdit, false);
});

await test("composer words: the placeholder follows the mode and the target, the chip says who works on what, an edit is shorter than a prompt", () => {
    const p = (over) => lib.placeholderFor({ mode: "edit", generating: false, started: true, target: "design", subject: "v3 · Stabilized", ...over });
    assert.equal(p({}), "Describe a change to v3 · Stabilized");
    assert.equal(p({ target: "voxel" }), "Describe a change to the blocks");
    assert.equal(p({ generating: true }), "Queue the next change");
    assert.equal(p({ mode: "new" }), "Describe another object");
    assert.equal(p({ mode: "new", started: false }), "Describe the object you want to build");
    assert.equal(p({ mode: "new", generating: true }), "Queue the next prompt");
    assert.deepEqual(lib.ROUTE_WORDS, { design: "Muse · edits the parts", mesh: "Muse · adjusts the model", voxel: "Muse · changes the blocks" });
    assert.equal(lib.maxCharsFor("edit", 1000), 500);
    assert.equal(lib.maxCharsFor("new", 1000), 1000);
    assert.equal(lib.assistReason(ASSIST, "mesh"), null);
    assert.equal(lib.assistLimitReached({ ...ASSIST, used_today: 400 }), true);
    assert.equal(lib.assistLimitReached({ ...ASSIST, daily_limit: null, used_today: 9999 }), false);
    assert.equal(lib.assistLimitReached(undefined), false);
});

const composerProps = (over = {}) => ({
    input: "", onInput() {}, onSubmit() {}, onStop() {}, textareaRef: { current: null }, onTextareaFocus() {}, onTextareaBlur() {}, placeholder: "Describe", locked: false,
    generating: false, stoppable: false, canSend: false, providers: [MUSE, HUNYUAN], selected: ["muse"], onSelectedChange() {}, usage: null, mode: "new", onModeChange() {},
    edit: null, onRegenerate: null, ...over,
});

await test("composer markup: the toggle is there only with a model; the Edit half is off with its reason; Edit mode swaps the picker for the route chip and shortens the box", () => {
    const none = render(h(lib.Composer, composerProps()));
    assert.doesNotMatch(none, /composer-mode/, "no model, nothing to choose");
    assert.match(none, /data-testid="provider-picker"/);
    assert.match(none, /maxLength="1000"|maxlength="1000"/i);
    const on = render(h(lib.Composer, composerProps({ mode: "edit", edit: { target: "voxel", canEdit: true, reason: null, subject: "v3 · Stabilized" } })));
    assert.match(on, /role="radiogroup"[^>]*aria-label="What your words do"/);
    assert.match(on, /data-testid="mode-edit"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="mode-edit"/);
    assert.match(on, /Edit v3 · Stabilized/);
    assert.match(on, /data-testid="route-chip"[^>]*data-target="voxel"/);
    assert.doesNotMatch(on, /data-testid="provider-picker"/, "the picker gives way to the route chip");
    assert.match(on, /Muse · changes the blocks/);
    assert.match(on, /maxLength="500"|maxlength="500"/i);
    assert.match(on, /aria-label="Describe a change"/);
    const off = render(h(lib.Composer, composerProps({ mode: "new", edit: { target: null, canEdit: false, reason: "Edits work on models you generate.", subject: "the original" } })));
    const edit = off.match(/<button[^>]*data-testid="mode-edit"[^>]*>/)[0];
    assert.match(edit, /aria-disabled="true"/);
    assert.doesNotMatch(edit, /\sdisabled(=|\s|>)/, "a disabled button takes no focus and no tap: the reason would be tooltip-only");
    assert.match(edit, /title="Edits work on models you generate\."/, "the reason is the tooltip");
    assert.match(off, /data-testid="mode-new"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-testid="mode-new"/);
    const sendEdit = render(h(lib.Composer, composerProps({ mode: "edit", canSend: true, edit: { target: "design", canEdit: true, reason: null, subject: "the original" } })));
    assert.match(sendEdit, /aria-label="Send change"/);
});

await test("route chip: a mesh edit has a menu with the second way (Hunyuan again, with the cost); the others are a plain label", () => {
    assert.doesNotMatch(render(h(lib.RouteChip, { target: "design" })), /aria-haspopup/);
    assert.doesNotMatch(render(h(lib.RouteChip, { target: "voxel", onRegenerate() {} })), /aria-haspopup/);
    assert.doesNotMatch(render(h(lib.RouteChip, { target: "mesh" })), /aria-haspopup/, "Hunyuan not usable: nothing to choose");
    const mesh = render(h(lib.RouteChip, { target: "mesh", onRegenerate() {} }));
    assert.match(mesh, /aria-haspopup="menu"/);
    assert.match(mesh, /Muse · adjusts the model/);
});

await test("the chat panel: with a model it edits by default and says so; with an example, or without the editor, it makes a new model", async () => {
    const chat = async (models, assist, extra = {}) => {
        lib.useWorkspaceStore.setState({
            activeProjectId: PROJECT_ID, project: { id: PROJECT_ID, name: "Lamp", pinned: false }, messages: [], jobs: {}, models, activeModelId: models[0]?.id ?? null,
            workspaceTab: "3d", providers: providersWith(assist), ...extra,
        });
        return withMatchMedia(false, async () => render(h(lib.ChatPanel, {})));
    };
    const muse = model("m1", { provider: "muse", project_id: PROJECT_ID });
    const html = await chat([muse], ASSIST);
    assert.match(html, /placeholder="Describe a change to the original"/);
    assert.match(html, /data-testid="route-chip"[^>]*data-target="design"/);
    assert.match(html, /data-testid="usage-hint"[^>]*>3\/400 today</, "an edit counts against the editor's own cap");
    const chosenNew = await chat([muse], ASSIST, { composerChoice: "new" });
    assert.match(chosenNew, /placeholder="Describe another object"/);
    assert.match(chosenNew, /data-testid="provider-picker"/);
    const example = await chat([model("ex", { kind: "example", provider: "example", example_slug: "shelf-arm", project_id: PROJECT_ID })], ASSIST);
    assert.match(example, /placeholder="Describe another object"/);
    assert.match(example, /Edits work on models you generate/);
    const none = await chat([muse], undefined);
    assert.match(none, /placeholder="Describe another object"/);
    assert.match(none, /The AI editor is not set up on the server\./);
    const queued = await chat([muse], ASSIST, { queuedPrompt: { text: "make it taller", mode: "edit" }, jobs: { j: job({ project_id: PROJECT_ID }) } });
    assert.match(queued, /Queued\. Changes the model when this run finishes/, "a queued change says it is a change");
    assert.match(queued, /make it taller/);
    const queuedNew = await chat([muse], ASSIST, { queuedPrompt: { text: "a red lamp", mode: "new" }, jobs: { j: job({ project_id: PROJECT_ID }) } });
    assert.match(queuedNew, /Queued\. Sends when this run finishes/);
    lib.useWorkspaceStore.setState({ queuedPrompt: null });
});

// ---------- the router ----------

const readyForEdit = (models, active, { tab = "3d", assist = ASSIST } = {}) => {
    lib.useWorkspaceStore.setState({
        activeProjectId: "p1", project: { id: "p1", name: "Lamp", pinned: false }, messages: [], jobs: {}, models, activeModelId: active, workspaceTab: tab,
        providers: providersWith(assist),
    });
};

await test("router: a Muse model's change goes to the parts editor, a Hunyuan model's to the mesh editor, both with what they need and without the router writing the chat", async () => {
    readyForEdit([model("m1", { provider: "muse" })], "m1");
    assert.deepEqual(await lib.submitEdit("  make the back taller  "), { ok: true });
    assert.deepEqual(globalThis.__designMeshEdits, [{ projectId: "p1", modelId: "m1", target: "design", instruction: "make the back taller" }]);
    assert.equal(S().messages.length, 0, "the editor writes the person's words and its card, the router must not add a second copy");
    globalThis.__designMeshEdits = [];
    readyForEdit([model("m1")], "m1");
    assert.deepEqual(await lib.submitEdit("make the back taller"), { ok: true });
    assert.equal(globalThis.__designMeshEdits[0].target, "mesh");
    assert.equal(globalThis.__blockEdits.length, 0);
});

await test("router: a change to the blocks takes the guard while the request is out, shows the Stability tab, and writes the person's words", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1", { tab: "3d" });
    globalThis.__heldDuringBlockEdit = () => lib.currentWork()?.kind;
    assert.deepEqual(await lib.submitEdit("add a shelf under the seat"), { ok: true });
    assert.deepEqual(globalThis.__blockEdits.map((e) => [e.modelId, e.instruction, e.held]), [["s1", "add a shelf under the seat", "blocks"]]);
    assert.equal(S().workspaceTab, "analysis", "the proposal is on the Stability tab, wherever the words were typed");
    assert.deepEqual(S().messages.map((m) => [m.role, m.content]), [["user", "add a shelf under the seat"]]);
    assert.equal(lib.currentWork(), null, "given back when the request has come back (the block editor keeps its own hold for the draft)");
    // From the Optimization tab, and for an original (a mesh is voxelised: the unstable block version).
    readyForEdit([model("m1")], "m1", { tab: "optimize" });
    assert.deepEqual(await lib.submitEdit("make the legs thicker"), { ok: true });
    assert.equal(globalThis.__blockEdits.length, 2);
    assert.equal(S().workspaceTab, "analysis");
});

await test("router: it refuses, with a reason in words, and gives the text back: nothing to edit, an example, no editor, the day's limit, too long, other work", async () => {
    const refused = async (text = "make it taller") => {
        const before = lib.toasts.length;
        const out = await lib.submitEdit(text);
        assert.deepEqual(out, { ok: false, restorePrompt: true }, `refused: ${text.slice(0, 20)}`);
        return lib.toasts.slice(before);
    };
    lib.useWorkspaceStore.setState({ activeProjectId: "p1", models: [], activeModelId: null, providers: providersWith(ASSIST) });
    assert.match((await refused())[0].title, /no model to change/);
    readyForEdit([model("ex", { kind: "example", provider: "example", example_slug: "shelf-arm" })], "ex");
    assert.match((await refused())[0].options.description, /Edits work on models you generate/);
    readyForEdit([model("m1", { provider: "muse" })], "m1", { assist: null });
    assert.match((await refused())[0].options.description, /AI editor is not set up/);
    readyForEdit([model("m1", { provider: "muse" })], "m1", { assist: { ...ASSIST, used_today: 400 } });
    assert.equal((await refused())[0].title, "Daily limit reached");
    readyForEdit([model("m1", { provider: "muse" })], "m1");
    assert.match((await refused("x".repeat(501)))[0].title, /too long/);
    assert.match((await refused(""))?.[0]?.title ?? "", /^$/, "empty: nothing said");
    // Other work holds the guard: a block edit while the optimizer runs, a design edit while a stabilizer run waits for a decision.
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    const hold = lib.acquireWork("optimize", "p1");
    assert.equal((await refused())[0].options.description, "Finish or discard the optimization first.");
    hold();
    readyForEdit([model("m1", { provider: "muse" })], "m1");
    const run = lib.acquireWork("stabilize", "p1");
    assert.equal((await refused())[0].options.description, "Finish or discard the stabilizing first.");
    run();
    assert.equal(globalThis.__designMeshEdits.length + globalThis.__blockEdits.length, 0, "nothing was started");
    assert.equal(S().messages.length, 0, "nothing was written");
});

await test("router: an access code the server refuses is asked for again once; with a new one the change goes through, without it nothing is kept", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    globalThis.__edit401 = 1;
    const before = globalThis.__blockEdits.length;
    const sent = lib.submitEdit("add a shelf");
    for (let i = 0; i < 20 && !lib.useAccessPrompt.getState().open; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(lib.useAccessPrompt.getState().open, true, "the dialog asks for the code");
    lib.settleAccessPrompt(true);
    assert.deepEqual(await sent, { ok: true });
    assert.equal(globalThis.__blockEdits.length, before + 2, "the same change was sent again");
    // dismissed: the refusal is what the person is told, and the words go back to the box
    lib.useWorkspaceStore.setState({ messages: [] });
    globalThis.__edit401 = 1;
    lib.toasts.length = 0;
    const second = lib.submitEdit("add a shelf");
    for (let i = 0; i < 20 && !lib.useAccessPrompt.getState().open; i++) await new Promise((r) => setTimeout(r, 5));
    lib.settleAccessPrompt(false);
    assert.deepEqual(await second, { ok: false, restorePrompt: true });
    assert.equal(S().messages.length, 0, "the words were taken back out of the chat");
    assert.match(lib.toasts.at(-1).options.description, /Access code required/);
});

await test("router: when the editor fails, the person's words are taken back out of the chat and handed back; the guard is free", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    globalThis.__editFails = "The AI editor is busy.";
    const out = await lib.submitEdit("add a shelf");
    assert.deepEqual(out, { ok: false, restorePrompt: true });
    assert.equal(S().messages.length, 0);
    assert.equal(lib.currentWork(), null);
    assert.equal(lib.toasts.at(-1).options.description, "The AI editor is busy.");
    readyForEdit([model("m1", { provider: "muse" })], "m1");
    assert.deepEqual(await lib.submitEdit("add a shelf"), { ok: false, restorePrompt: true });
    assert.match(lib.toasts.at(-1).title, /Could not start the change/);
});

await test("router: a mesh edit is refused before anything is written while another one of the project is going", async () => {
    // (A Hunyuan model is not a Muse parts model: its change is a mesh edit.)
    readyForEdit([model("m1")], "m1");
    globalThis.__meshBusy = true;
    try {
        assert.deepEqual(await lib.submitEdit("make the back taller"), { ok: false, restorePrompt: true });
        assert.equal(lib.toasts.at(-1).title, "Another edit is still running");
        assert.equal(S().messages.length, 0, "the words stay in the box, nothing is written to the chat");
        assert.equal(globalThis.__designMeshEdits.length, 0);
    } finally {
        globalThis.__meshBusy = false;
    }
    assert.deepEqual(await lib.submitEdit("make the back taller"), { ok: true });
    assert.equal(globalThis.__designMeshEdits.at(-1).target, "mesh");
});

// ---------- the run chip ----------

await test("run chip: a change on the queue, the stabilizer while it runs, and work that can be stopped are announced; nothing else is", () => {
    const base = { jobs: {}, projectId: "p1", hold: null, stabilizing: false };
    assert.equal(lib.runActivityOf(base), null);
    const e = editJob({ project_id: "p1", created_at: new Date(Date.now() - 8000).toISOString() });
    const a = lib.runActivityOf({ ...base, jobs: { e } });
    assert.deepEqual([a.words, a.stopKey], ["Muse is editing", "job"]);
    assert.ok(Math.abs(a.since - Date.parse(e.created_at)) < 1);
    assert.equal(lib.runActivityOf({ ...base, jobs: { e: { ...e, status: "succeeded" } } }), null, "a finished job is not running");
    assert.equal(lib.runActivityOf({ ...base, jobs: { e: { ...e, project_id: "other" } } }), null, "another project's");
    assert.equal(lib.runActivityOf({ ...base, jobs: { g: job({ project_id: "p1" }) } }), null, "a generation has its own card and overlay");
    const hold = (kind, extra = {}) => ({ kind, projectId: "p1", since: 1000, label: null, stop: null, waiting: false, ...extra });
    assert.deepEqual(lib.runActivityOf({ ...base, hold: hold("stabilize"), stabilizing: true }), { words: "Stabilizing", since: 1000, stopKey: "stabilize" });
    assert.equal(lib.runActivityOf({ ...base, hold: hold("stabilize"), stabilizing: false }), null, "a run that waits for Save or Discard is not running");
    assert.equal(lib.runActivityOf({ ...base, hold: hold("optimize") }), null, "no way to stop it: not announced");
    assert.deepEqual(lib.runActivityOf({ ...base, hold: hold("optimize", { stop() {}, label: "Optimizing" }) }), { words: "Optimizing", since: 1000, stopKey: "hold" });
    assert.equal(lib.runActivityOf({ ...base, hold: hold("optimize", { stop() {}, projectId: "other" }) }), null);
    assert.equal(lib.runActivityOf({ ...base, hold: hold("blocks", { stop() {}, waiting: true }) }), null, "a draft that waits for Save is not running, even if it can still be stopped");
    // A mesh edit: the pictures (no job yet), the plan applied and the result saved (the job is done) are this page's work, told here too.
    assert.deepEqual(lib.runActivityOf({ ...base, meshRun: { key: "pending-1", since: 500, stoppable: true } }), { words: "Muse is editing", since: 500, stopKey: "mesh", stopId: "pending-1" });
    assert.deepEqual(lib.runActivityOf({ ...base, meshRun: { key: "j1", since: 500, stoppable: false } }), { words: "Muse is editing", since: 500, stopKey: null, stopId: "j1" }, "saving the result cannot be stopped");
    assert.equal(lib.runActivityOf({ ...base, jobs: { e }, meshRun: { key: e.id, since: 1, stoppable: true } }).stopKey, "job", "while the plan is made the job is the thing to stop");
});

await test("run chip: on a phone's row the words are for a screen reader only, and the row holds the control, the chip and the picked issue", async () => {
    const e = editJob({ project_id: "p1" });
    lib.useWorkspaceStore.setState({ activeProjectId: "p1", jobs: { e } });
    const chip = render(h(lib.RunChip, { compact: true }));
    assert.match(chip, /class="[^"]*sr-only[^"]*" data-testid="run-chip-words"/);
    assert.match(chip, /data-testid="run-chip-stop"/);
    assert.doesNotMatch(render(h(lib.RunChip, {})), /sr-only[^"]*" data-testid="run-chip-words"/);
    lib.useWorkspaceStore.setState({ jobs: {} });
    const phone = await shellHtml({ mobile: true, models: PAIR, active: "s1", tab: "3d" });
    lib.useWorkspaceStore.setState({ jobs: { e } });
    const running = await shellHtml({ mobile: true, models: PAIR, active: "s1", tab: "3d" });
    assert.doesNotMatch(phone, /data-testid="run-chip"/);
    const row = running.slice(running.indexOf('class="mt-2 flex items-center gap-2 min-h-10"'));
    assert.ok(row.indexOf('data-testid="version-switcher"') < row.indexOf('data-testid="run-chip"'), "the chip sits beside the control, in its row");
});

await test("run chip: it shows the words, the clock and a Stop button", () => {
    assert.equal(render(h(lib.RunChip, {})), "");
    lib.useWorkspaceStore.setState({ activeProjectId: "p1", jobs: { e: editJob({ project_id: "p1" }) } });
    const html = render(h(lib.RunChip, {}));
    assert.match(html, /role="status"/);
    assert.match(html, /data-testid="run-chip-words"[^>]*>Muse is editing…</);
    assert.match(html, /data-testid="pipeline-elapsed"/);
    assert.match(html, /data-testid="run-chip-stop"[^>]*aria-label="Stop: Muse is editing"/);
});

// ---------- the bar with four tabs ----------

await test("tabs: 3D, Stability, Optimization, Models in that order; the Optimization tab names its key and carries the optimizer's mark", async () => {
    const html = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    const order = [...html.matchAll(/data-testid="tab-(3d|analysis|optimize|models)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ["3d", "analysis", "optimize", "models"]);
    assert.match(textOf(html.slice(html.indexOf('data-testid="workspace-tab-strip"'), html.indexOf("version-switcher"))), /3D Stability .*Optimization Models/);
    assert.match(html, /data-testid="tab-optimize"/);
    assert.match(html, /title="Optimization \(O while the 3D view has focus\)"/);
    assert.doesNotMatch(html, /optimize-dock|optimize-panel-stub/, "the panel is for its own tab");
    // The optimizer's work: a spinner; a result that waits: a dot.
    const release = lib.acquireWork("optimize", "p1", { label: "Optimizing" });
    const spinning = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    const tabCell = (page) => page.slice(page.indexOf('data-testid="tab-optimize"'), page.indexOf('data-testid="tab-models"'));
    assert.match(tabCell(spinning), /animate-spin/);
    lib.setWorkWaiting("optimize", true);
    const waiting = await shellHtml({ models: PAIR, active: "s1", tab: "3d" });
    assert.match(tabCell(waiting), /aria-label="A result is waiting"/);
    assert.doesNotMatch(tabCell(waiting), /animate-spin/);
    release();
    assert.doesNotMatch(tabCell(await shellHtml({ models: PAIR, active: "s1", tab: "3d" })), /animate-spin|waiting/);
});

await test("tabs: the Optimization tab mounts the optimizer's panel under the bar (a phone: docked at the foot), shows the blocks, and keeps the version control", async () => {
    const html = await shellHtml({ models: PAIR, active: "s1", tab: "optimize" });
    assert.match(html, /data-testid="optimize-dock"/);
    assert.match(html, /data-testid="optimize-panel-stub"/);
    assert.equal(attr(html, "data-mode"), "blocks", "the stage draws the blocks over the model");
    assert.match(html, /data-testid="version-switcher"/);
    assert.match(html, /aria-pressed="true"[^>]*data-testid="tab-optimize"|data-testid="tab-optimize"[^>]*aria-pressed="true"/);
    assert.equal(JSON.parse(attr(html, "data-insets").replace(/&quot;/g, '"')).left, 344, "the model is framed beside the panel, as beside the report");
    const phone = await shellHtml({ mobile: true, models: PAIR, active: "s1", tab: "optimize" });
    assert.match(phone, /data-testid="optimize-peek"/);
    assert.match(phone, /data-testid="optimize-panel-stub"/);
    assert.doesNotMatch(phone, /optimize-dock/);
    assert.doesNotMatch(phone, /analysis-peek-dock[^>]*>.*analysis-peek/, "not the report's card");
    const stability = await shellHtml({ models: PAIR, active: "s1", tab: "analysis" });
    assert.doesNotMatch(stability, /optimize-dock|optimize-panel-stub/);
    const models = await shellHtml({ models: PAIR, active: "s1", tab: "models" });
    assert.doesNotMatch(models, /optimize-panel-stub/);
});

await test("keys: O flips the 3D view and the Optimization tab like A flips Stability, only while the stage has focus; a link ?tab=optimization opens it", async () => {
    const { readFileSync } = await import("node:fs");
    const shell = readFileSync(path.join(root, "src/assignment/components/workspace/WorkspaceShell.tsx"), "utf8");
    assert.match(shell, /isOptimizeKey\(keyEvent\)/);
    assert.match(shell, /workspace\.workspaceTab === "optimize" \? "3d" : "optimize"/);
    assert.match(shell, /if \(inTypingContext\(e\.target\)\) return;\s*e\.preventDefault\(\);\s*const workspace = useWorkspaceStore\.getState\(\);\s*workspace\.setWorkspaceTab\(/, "not in a field");
    assert.equal(lib.tabFromParam("optimize"), "optimize");
    assert.equal(lib.tabFromParam("optimization"), "optimize");
    assert.equal(lib.tabFromParam("nope"), null);
    assert.equal(lib.isBlockTab("optimize"), true);
    assert.equal(lib.isBlockTab("analysis"), true);
    assert.equal(lib.isBlockTab("3d"), false);
    // The strip of the bar scrolls sideways when narrow; the run chip sits in the free room beside the control, on every tab.
    lib.useWorkspaceStore.setState({ jobs: { e: editJob({ project_id: "p1" }) } });
    for (const tab of ["3d", "analysis", "optimize", "models"]) {
        const page = await shellHtml({ models: PAIR, active: "s1", tab });
        lib.useWorkspaceStore.setState({ jobs: { e: editJob({ project_id: "p1" }) } });
        assert.match(await shellHtml({ models: PAIR, active: "s1", tab }), /data-testid="run-chip"/, `the chip is on the ${tab} tab`);
        void page;
    }
});

await test("preview: the stage's chip names whose picture it is", async () => {
    assert.equal(lib.previewLabelOf("stabilize"), "Stabilizer preview");
    assert.equal(lib.previewLabelOf("blocks"), "Preview of your change");
    assert.equal(lib.previewLabelOf("optimize"), "Optimizer preview");
    assert.equal(lib.previewLabelOf(null), "Stabilizer preview");
    const html = await shellHtml({ models: PAIR, active: "s1", tab: "analysis" });
    assert.equal(attr(html, "data-preview-label"), "Stabilizer preview");
    const preview = planned();
    lib.useAnalysisStore.getState().setPreview("s1", preview, "blocks");
    assert.equal(attr(await shellHtml({ models: PAIR, active: "s1", tab: "analysis" }), "data-preview-label"), "Preview of your change");
    lib.useAnalysisStore.getState().setPreview("s1", null, "blocks");
});

await test("tabs: the insets of the Optimization tab are the report's (beside the panel on a desktop, above the card on a phone)", () => {
    const insets = { top: 60, right: 0, bottom: 0, left: 0 };
    const input = { insets, analysisOn: true, mobile: false, switcherRowPx: 0, panelOpen: true, freeWidth: 1200, dockInsetPx: 344, peekPx: 190 };
    assert.equal(lib.viewerInsetsFor(input).left, 344);
    assert.equal(lib.viewerInsetsFor({ ...input, mobile: true }).bottom, 190 + 8);
});

// ---------- the Models tab as a tree ----------

const TREE = () => {
    const root = model("m1", { analysis: summary(0), created_at: at(0) });
    const s1 = stab("s1", "m1", 9, 5, { analysis: summary(0, 1) });
    const e1 = edited("e1", "m1", 7, "voxel", "Shelf", { analysis: summary(2) });
    const p1 = optimized("p1", "s1", 10, { analysis: summary(0) });
    return [root, s1, e1, p1];
};

await test("models tab: one tree, the versions indented under the one they were made from, numbered, with what each did in the person's words", () => {
    const models = TREE();
    const html = render(h(lib.ModelsPanel, { models, activeModelId: "p1", providers: [HUNYUAN], onView() {}, onEdit() {}, onDelete: async () => ({}) }));
    assert.equal((html.match(/data-testid="model-group"/g) ?? []).length, 1);
    assert.deepEqual([...html.matchAll(/data-testid="model-row" data-kind="(\w+)"/g)].map((m) => m[1]), ["generated", "stabilized", "optimized", "edited"], "depth first");
    assert.deepEqual([...html.matchAll(/data-testid="model-ordinal"[^>]*>v(\d)</g)].map((m) => m[1]), ["1", "2", "4", "3"]);
    assert.deepEqual([...html.matchAll(/<div[^>]*class="flex items-stretch gap-1\.5" data-depth="(\d)"/g)].map((m) => m[1]), ["0", "1", "2", "1"]);
    assert.match(html, /data-testid="tree-connector" data-depth="2"/);
    const text = textOf(html);
    assert.match(text, /Stabilized · a shelf/);
    assert.match(text, /Edited · Shelf/);
    assert.match(text, /Optimized · Lightest/);
    assert.match(text, /“make the back taller” — Raised the back\./, "an edit quotes the request and says what it did");
    assert.match(text, /“as light as possible” · −23% weight/, "an optimization quotes its goal");
    assert.match(text, /\+9 blocks/);
    assert.match(html, /data-testid="model-kind" data-kind="edited"/);
    assert.match(html, /data-testid="model-kind" data-kind="optimized"/);
});

await test("models tab: Edit… and Delete are on versions as they should be; a root cannot be deleted, an example cannot be edited, and the reason is the tooltip", () => {
    const ex = model("ex", { kind: "example", provider: "example", example_slug: "shelf-arm" });
    const models = [ex, stab("t", "ex", 4, 1), ...TREE()];
    const html = render(h(lib.ModelsPanel, { models, activeModelId: "m1", providers: [HUNYUAN], onView() {}, onEdit() {}, onDelete: async () => ({}) }));
    const rows = html.split('data-testid="model-row"').slice(1);
    const deletable = rows.map((r) => /data-testid="model-delete"/.test(r));
    assert.equal(deletable.filter(Boolean).length, 4, "the stabilized twin, the stabilized, the edited and the optimized version; not the two roots");
    const edits = rows.map((r) => r.match(/<button[^>]*data-testid="model-edit"[^>]*>/)?.[0] ?? "");
    const exRow = rows.findIndex((r) => /data-kind="example"/.test(r));
    assert.match(edits[exRow], /aria-disabled="true"/);
    assert.doesNotMatch(edits[exRow], /\sdisabled(=|\s|>)/, "not a disabled button: it takes focus and a tap, and says why");
    assert.match(edits[exRow], /title="Edits work on models you generate/);
    assert.doesNotMatch(edits.filter((_, n) => n !== exRow && /model-edit/.test(rows[n])).join(""), /\sdisabled(=|\s|>)/);
    const noEdit = render(h(lib.ModelsPanel, { models: TREE(), activeModelId: "m1", providers: [HUNYUAN], onView() {} }));
    assert.doesNotMatch(noEdit, /model-edit|model-delete/, "no handler, no button");
    assert.match(render(h(lib.ModelsPanel, { models: [], activeModelId: null, providers: [], onView() {} })), /No models yet/);
});

await test("delete dialog: says what goes and what stays, closed when there is nothing to ask", () => {
    const models = TREE();
    assert.equal(render(h(lib.DeleteVersionDialog, { model: null, models, onConfirm() {}, onCancel() {} })), "");
    const sub = lib.subtreeIds(models, "s1");
    assert.deepEqual(sub, ["s1", "p1"]);
});

await test("models list: a version's card undoes it only when nothing was made from it; chips name each kind; the optimized card quotes the saving", () => {
    const models = TREE();
    const card = (m) => render(h(lib.ModelCard, { model: m, models, active: false, onView() {} }));
    assert.match(card(models[3]), /data-testid="model-undo"/, "the optimized version is a leaf");
    assert.doesNotMatch(card(models[1]), /model-undo/, "a stabilized version is not undone by a card");
    assert.doesNotMatch(card(models[0]), /model-undo/);
    const withKid = [...models, edited("e2", "e1", 12)];
    assert.doesNotMatch(render(h(lib.ModelCard, { model: models[2], models: withKid, active: false, onView() {} })), /model-undo/, "something was made from it");
    assert.match(textOf(card(models[3])), /−23% weight · /, "the verdict line leads with what it did");
    assert.match(card(models[3]), /aria-label="This version: −23% weight/);
    assert.match(textOf(card(models[2])), /\+12 blocks/);
    assert.match(card(models[3]), /data-label="Original"/);
});

await test("job cards: a change of a design or a mesh is the edit card's, never a generation's Retry; a generation is what it was", () => {
    const card = (j) => render(h(lib.JobCard, { job: j, providers: [MUSE, HUNYUAN], active: false, canRetry: true, onView() {}, onRetry() {} }));
    const edit = card(editJob({ status: "failed", error: "nope" }));
    assert.match(edit, /data-testid="edit-card" data-job="j-edit" data-status="failed"/);
    assert.doesNotMatch(edit, /Retry|job-card/);
    assert.match(card(job({ status: "failed", error: "nope" })), /data-testid="job-card"/);
    assert.match(card(job({ kind: "generate", status: "failed", error: "nope" })), /Retry/);
});

// ---------- how this version was made ----------

await test("log: a version says how it was made in its own words: the stabilizer's steps, the requests of an edit, the optimizer's goal and figures", () => {
    const metric = (blocks, kg, util, margin) => ({ blocks, weight_kg: kg, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 3, cog_margin_mm: margin, max_utilisation: util, max_deflection_um: 5 });
    const opt = optimized("p1", "s1", 10, { optimization: { title: "Lightest", goal: "as light as possible", shape_changed: false, stabilized_depth: 1, removed: 23, added: 0, stop: "converged", before: metric(100, 200, 0.6, 136), after: metric(77, 154, 0.75, 120) } });
    const ed = edited("e1", "m1", 7, "design", "Taller back", { edit: { ...edited("e1", "m1", 7).edit, target: "design", changes: { added: ["cup holder"], changed: ["back"], removed: [] }, notes: ["scaled to 98% to fit the 1000 mm cube"] } });
    const hookOf = (m) => {
        lib.useWorkspaceStore.setState({ models: [m], activeModelId: m.id });
        let out;
        function Probe() {
            out = lib.useStabilizerLog(m);
            return null;
        }
        render(h(Probe));
        return out;
    };
    const o = hookOf(opt);
    assert.deepEqual([o.kind, o.title, lib.logSummary(o)], ["optimizer", "What the optimizer did", "Lightest"]);
    const e = hookOf(ed);
    assert.deepEqual([e.kind, e.title, lib.logSummary(e)], ["edit", "What was changed", "1 request"]);
    const s = hookOf(stab("s1", "m1", 4, 5, { derived: derivedOf(4, { steps: [{ n: 1 }] }) }));
    assert.deepEqual([s.kind, s.title, lib.logSummary(s)], ["stabilizer", "What the stabilizer did", "1 step"]);
    assert.equal(hookOf(model("m1")), null, "an original made nothing");
    assert.equal(hookOf(stab("s0", "m1", 0, 5, { derived: derivedOf(0) })), null, "a stabilizer that found nothing to add has no log");
    const result = planned();
    const optHtml = textOf(render(h(lib.StabilizerLog, { log: o, result })));
    assert.match(optHtml, /“as light as possible”/);
    assert.match(optHtml, /Blocks 100 → to 77/);
    assert.match(optHtml, /Weight 200 kg → to 154 kg/);
    assert.match(optHtml, /Strength used 60% → to 75%/);
    assert.match(optHtml, /Weight inside the base 136 mm → to 120 mm/);
    assert.match(optHtml, /Took away 23 blocks\./);
    assert.match(optHtml, /No single block can change without breaking a limit or the goal\./);
    const edHtml = textOf(render(h(lib.StabilizerLog, { log: e, result })));
    assert.match(edHtml, /“make the back taller”/);
    assert.match(edHtml, /Added: cup holder/);
    assert.match(edHtml, /Changed: back/);
    assert.match(edHtml, /scaled to 98% to fit the 1000 mm cube/);
});

// ================= the ux review (UX-1 ... UX-10) =================

/** The chat panel, server-rendered for the project with the stores as given. */
async function chatHtml(models, { assist = ASSIST, extra = {}, phone = false, during = null } = {}) {
    lib.useWorkspaceStore.setState({
        activeProjectId: PROJECT_ID, project: { id: PROJECT_ID, name: "Lamp", pinned: false }, messages: [], jobs: {}, models, activeModelId: models[0]?.id ?? null,
        workspaceTab: "3d", providers: providersWith(assist), ...extra,
    });
    // (After the project is open: opening another one drops the work guard, as it drops the work.)
    const done = during?.();
    try {
        return await withMatchMedia(phone, async () => render(h(lib.ChatPanel, {})));
    } finally {
        done?.();
    }
}
const meshRun = (over = {}) => ({
    key: "pending-1", jobId: null, projectId: PROJECT_ID, sourceModelId: "m1", instruction: "make the seat wider", target: "mesh", status: "applying", startedAt: Date.now(),
    step: null, stage: null, summary: null, notes: [], errorKind: null, error: null, savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false, ...over,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

await test("UX-1: an Undo on a card takes nothing else with it: offered for a version nothing was made from, and checked again when it is pressed", async () => {
    const models = [model("m1"), edited("e1", "m1", 7, "design"), optimized("p1", "e1", 9), stab("s2", "m1", 4, 11)];
    assert.equal(lib.canUndoVersion(models, models[2]), true, "an optimized leaf");
    assert.equal(lib.canUndoVersion(models, models[1]), false, "something was made from the edit");
    assert.equal(lib.canUndoVersion(models, models[0]), false, "a root");
    assert.equal(lib.canUndoVersion(models, models[3]), false, "a stabilized version is not undone by a card");
    const sent = [];
    const before = globalThis.fetch;
    globalThis.fetch = async (url, init) => (sent.push(`${init.method} ${url}`), { ok: true, status: 200, json: async () => ({ ok: true }) });
    try {
        load(models, "p1");
        // The card was drawn before the optimized version existed: the press is checked against the list as it is now.
        const refused = await lib.undoVersion(models[1]);
        assert.equal(refused.ok, false);
        assert.deepEqual(sent, [], "nothing was deleted");
        assert.deepEqual(S().models.map((m) => m.id), ["m1", "e1", "p1", "s2"]);
        assert.equal(lib.toasts.at(-1).title, "Other versions were made from this one");
        const done = await lib.undoVersion(models[2]);
        assert.deepEqual(done, { ok: true, removed: ["p1"] });
        assert.deepEqual(sent, ["DELETE /api/assignment_alex/models/p1"]);
        assert.equal(S().activeModelId, "e1", "back to the model it was made from");
    } finally {
        globalThis.fetch = before;
    }
    // The card itself: the optimized leaf has the button, the edit under it does not.
    const card = (m) => render(h(lib.ModelCard, { model: m, models, active: false, onView() {} }));
    assert.match(card(models[2]), /data-testid="model-undo"/);
    assert.doesNotMatch(card(models[1]), /model-undo/);
});

await test("UX-2: the chords (stop, hide the chat, new project) work from the composer's box in both of its modes, and not from other text fields", () => {
    assert.equal(lib.COMPOSER_SELECTOR, "[data-composer]");
    const none = { querySelector: () => null };
    const field = (tag, { composer = false, within = null, editable = false } = {}) => ({
        tagName: tag, isContentEditable: editable,
        closest: (selector) => (selector === lib.COMPOSER_SELECTOR ? (composer ? {} : null) : within && selector.includes(within) ? {} : null),
    });
    assert.equal(lib.shortcutBlocked(field("TEXTAREA", { composer: true }), none), false, "the composer's box");
    assert.equal(lib.shortcutBlocked(field("TEXTAREA"), none), true, "any other text area: a rename, the block field");
    assert.equal(lib.shortcutBlocked(field("INPUT"), none), true);
    assert.equal(lib.shortcutBlocked(field("INPUT", { composer: true }), none), true, "only the box itself is the prompt");
    assert.equal(lib.shortcutBlocked(field("SELECT"), none), true);
    assert.equal(lib.shortcutBlocked(field("DIV", { editable: true }), none), true);
    assert.equal(lib.shortcutBlocked(field("DIV"), none), false, "the page");
    assert.equal(lib.shortcutBlocked(field("TEXTAREA", { composer: true, within: 'role="menu"' }), none), true, "in a menu or dialog");
    assert.equal(lib.shortcutBlocked(field("BUTTON", { within: 'role="dialog"' }), none), true);
    assert.equal(lib.shortcutBlocked(field("DIV"), { querySelector: () => ({}) }), true, "a dialog is open anywhere");
    assert.equal(lib.shortcutBlocked(null, none), false);
    assert.equal(lib.shortcutBlocked({}, none), false, "not an element");
    // The box carries the mark in either mode (its label differs: "Prompt" for a new model, "Describe a change" for an edit).
    const editing = render(h(lib.Composer, composerProps({ mode: "edit", edit: { target: "design", canEdit: true, reason: null, subject: "v2" } })));
    const making = render(h(lib.Composer, composerProps({ mode: "new" })));
    for (const html of [editing, making]) assert.match(html.match(/<textarea[^>]*>/)[0], /data-composer=""/);
    assert.match(editing.match(/<textarea[^>]*>/)[0], /aria-label="Describe a change"/);
    assert.match(making.match(/<textarea[^>]*>/)[0], /aria-label="Prompt"/);
});

await test("UX-3: a change to the blocks says it is working in the chat, and its proposal is brought up on the phone (the report opens)", async () => {
    // The chat: a working card with Stop while the request is out (the run chip is on the canvas, the other screen of a phone).
    const models = [model("m1", { project_id: PROJECT_ID }), stab("s1", "m1", 4, 5, { project_id: PROJECT_ID })];
    const withStop = await chatHtml(models, {
        extra: { activeModelId: "s1" },
        phone: true,
        during: () => lib.acquireWork("blocks", PROJECT_ID, { label: "Changing the blocks", stop() {} }),
    });
    assert.match(withStop, /data-testid="block-edit-working"/);
    assert.match(textOf(withStop), /Reading the blocks to plan the change/);
    assert.match(withStop, /data-testid="block-edit-stop"/);
    const waiting = await chatHtml(models, {
        extra: { activeModelId: "s1" },
        during: () => {
            const release = lib.acquireWork("blocks", PROJECT_ID, { stop() {} });
            lib.setWorkWaiting("blocks", true);
            return release;
        },
    });
    assert.doesNotMatch(waiting, /block-edit-working/, "a proposal or a draft that waits is not work in progress");
    const noStop = await chatHtml(models, { extra: { activeModelId: "s1" }, during: () => lib.acquireWork("blocks", PROJECT_ID) });
    assert.match(noStop, /data-testid="block-edit-working"/);
    assert.doesNotMatch(noStop, /block-edit-stop/, "no way to stop it yet: no button");
    assert.doesNotMatch(await chatHtml(models), /block-edit-working/, "nothing running");
    // (Another project's hold cannot exist beside the open one: the guard belongs to the project it was taken in.)
    // The router: a proposal is asked for on the report (the page watches this request and leaves the chat for the canvas).
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1", { tab: "3d" });
    const asked = AS().openRequest;
    assert.deepEqual(await lib.submitEdit("add a shelf under the seat"), { ok: true });
    assert.equal(AS().openRequest, asked + 1, "the report is asked for");
    assert.equal(AS().sheetOpen, true, "a phone gets the whole proposal, with its warnings");
    assert.equal(S().workspaceTab, "analysis");
    assert.equal(S().activeModelId, "s1");
    // A question or a refusal is an answer in the chat: the person stays where they typed.
    globalThis.__voxelState = { notice: { kind: "ask", text: "Which shelf do you mean?", warnings: [] } };
    const kept = AS().openRequest;
    assert.deepEqual(await lib.submitEdit("make it nicer"), { ok: true });
    assert.equal(AS().openRequest, kept, "no proposal, nothing to look at");
});

await test("UX-3: a phone keeps a place for the run chip while something runs, even with no versions and the 3D tab open", async () => {
    const idle = await shellHtml({ mobile: true, models: [model("m1")], active: "m1", tab: "3d" });
    assert.doesNotMatch(idle, /data-testid="run-chip"/);
    lib.useWorkspaceStore.setState({ jobs: { e: editJob({ project_id: "p1" }) } });
    const running = await shellHtml({ mobile: true, models: [model("m1")], active: "m1", tab: "3d" });
    assert.match(running, /data-testid="run-chip"/, "a change on a model that has no versions yet is not invisible on the canvas");
    lib.useWorkspaceStore.setState({ jobs: {} });
    // A mesh edit in this page (no job yet), too.
    lib.useEditStore.setState({ runs: { k: meshRun({ projectId: "p1" }) } });
    assert.match(await shellHtml({ mobile: true, models: [model("m1")], active: "m1", tab: "3d" }), /data-testid="run-chip"/);
});

await test("UX-5: the router says so when a request for a change to the blocks came back with no answer (Stop, another version), and gives the words back", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    // Stop: neither a proposal nor a note.
    globalThis.__voxelState = {};
    assert.deepEqual(await lib.submitEdit("add a shelf"), { ok: false, restorePrompt: true });
    assert.deepEqual(S().messages.map((m) => [m.role, m.content]), [["user", "add a shelf"], ["assistant", lib.BLOCK_EDIT_STOPPED]], "the person's words stay, with the answer to them");
    assert.equal(lib.currentWork(), null);
    // The person went to another version while the editor thought.
    lib.useWorkspaceStore.setState({ messages: [] });
    globalThis.__afterRequest = () => lib.useWorkspaceStore.setState({ activeModelId: "m1" });
    assert.deepEqual(await lib.submitEdit("add a shelf"), { ok: false, restorePrompt: true });
    assert.equal(S().messages.at(-1).content, lib.BLOCK_EDIT_MOVED);
    // Another project was opened: its chat gets no line, and the words are not its to hold.
    lib.useWorkspaceStore.setState({ messages: [], activeModelId: "s1" });
    globalThis.__afterRequest = () => lib.useWorkspaceStore.setState({ activeProjectId: "p2", messages: [] });
    assert.deepEqual(await lib.submitEdit("add a shelf"), { ok: true });
    assert.equal(S().messages.length, 0);
    for (const line of [lib.BLOCK_EDIT_STOPPED, lib.BLOCK_EDIT_MOVED]) assert.doesNotMatch(line, /voxel|FEM|objective|coordinate/i, line);
});

await test("UX-5: a saved chat whose first line of a change never got its job reads 'interrupted', not 'working' for ever; live lines and jobs are left alone", () => {
    const at0 = "2026-10-24T12:00:00.000Z";
    const rows = [
        { id: "a", role: "user", content: "make the seat wider", timestamp: at0 },
        { id: "b", role: "assistant", content: lib.EDIT_START_LINES.mesh, timestamp: at0 },
        { id: "c", role: "assistant", content: lib.EDIT_START_LINES.design, timestamp: at0 },
        { id: "d", role: "assistant", content: lib.EDIT_START_LINES.design, timestamp: at0, job_ids: ["j1"] },
        { id: "e", role: "assistant", content: lib.EDIT_START_LINES.mesh, timestamp: at0, model_ids: ["m2"] },
        { id: "f", role: "user", content: lib.EDIT_START_LINES.design, timestamp: at0 },
        { id: "g", role: "assistant", content: "Generating with **Muse Spark**.", timestamp: at0 },
    ];
    // The lines are matched by their words: they must still be the ones the editor writes.
    const editSource = readFileSync(path.join(root, "src/assignment/store/edit.ts"), "utf8");
    for (const line of Object.values(lib.EDIT_START_LINES)) assert.ok(editSource.includes(`"${line}"`) || editSource.includes("EDIT_START_LINES"), `store/edit.ts writes "${line}"`);
    assert.deepEqual(lib.sanitizeMessages(rows).map((m) => m.content), [
        "make the seat wider", lib.EDIT_INTERRUPTED_LINE, lib.EDIT_INTERRUPTED_LINE, lib.EDIT_START_LINES.design, lib.EDIT_START_LINES.mesh, lib.EDIT_START_LINES.design, "Generating with **Muse Spark**.",
    ]);
});

await test("UX-6: a change queued behind a mesh edit that is still applying waits for it, and is queued rather than refused when typed then", async () => {
    const state = (over = {}) => ({ ...S(), jobs: {}, sending: false, ...over });
    assert.equal(lib.queueMustWait(state(), { meshBusy: false, loading: false }), false);
    assert.equal(lib.queueMustWait(state(), { meshBusy: true, loading: false }), true, "its job has ended, the edit has not");
    assert.equal(lib.queueMustWait(state(), { meshBusy: false, loading: true }), true);
    assert.equal(lib.queueMustWait(state({ sending: true }), { meshBusy: false, loading: false }), true);
    assert.equal(lib.queueMustWait(state({ activeProjectId: "p1", jobs: { j: job({ project_id: "p1" }) } }), { meshBusy: false, loading: false }), true, "a job is running");
    // The box says it queues while the edit is being applied.
    const models = [model("m1", { project_id: PROJECT_ID })];
    const idle = await chatHtml(models);
    assert.match(idle, /aria-label="Send change"/);
    lib.useEditStore.setState({ runs: { k: meshRun() } });
    const applying = await chatHtml(models);
    assert.match(applying, /aria-label="Queue change"/, "the send button queues");
    assert.match(applying, /placeholder="Queue the next change"/);
    lib.useEditStore.setState({ runs: { k: meshRun({ status: "saved" }) } });
    assert.match(await chatHtml(models), /aria-label="Send change"/, "done: the box sends again");
    // A new model is not held up by it.
    lib.useEditStore.setState({ runs: { k: meshRun() } });
    assert.match(await chatHtml(models, { extra: { composerChoice: "new" } }), /aria-label="Send"/);
});

await test("UX-7: the Draft chip sits on the half that stands for the version the changes belong to, wherever the person looks, and only for applied changes", () => {
    const draft = (modelId, count = 2) => lib.useVoxelEditStore.setState({ sourceModelId: modelId, draft: { count }, status: "idle" });
    assert.equal(lib.draftIsOn({ sourceModelId: "s1", draft: { count: 2 } }, "s1"), true);
    assert.equal(lib.draftIsOn({ sourceModelId: "s1", draft: { count: 2 } }, "m1"), false, "another version's");
    assert.equal(lib.draftIsOn({ sourceModelId: "s1", draft: { count: 0 } }, "s1"), false, "every change undone");
    assert.equal(lib.draftIsOn({ sourceModelId: "s1", draft: null }, "s1"), false, "a proposal nobody applied");
    load([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    assert.doesNotMatch(bar(), /version-draft/);
    // A proposal is not a draft: the work hold is waiting, but nothing is unsaved.
    lib.useVoxelEditStore.setState({ sourceModelId: "s1", proposal: { summary: "x" }, draft: null, status: "proposal" });
    const release = lib.acquireWork("blocks", "p1");
    lib.setWorkWaiting("blocks", true);
    assert.doesNotMatch(bar(), /version-draft/, "a proposal alone claims no unsaved changes");
    lib.useVoxelEditStore.setState({ proposal: null });
    // Changes to the version: its half, with the version on screen ...
    draft("s1");
    let html = bar();
    assert.equal((html.match(/data-testid="version-draft"/g) ?? []).length, 1);
    assert.ok(html.indexOf("version-draft") > html.indexOf('data-testid="version-head"'), "on the right half");
    assert.match(html, />Draft</);
    // ... and with the original on screen it stays on the version's half.
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1");
    html = bar();
    assert.equal((html.match(/data-testid="version-draft"/g) ?? []).length, 1);
    assert.ok(html.indexOf("version-draft") > html.indexOf('data-testid="version-head"'), "not on the Original that is on screen");
    // Changes to the original: the Original half, whichever is on screen.
    draft("m1");
    load([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    html = bar();
    assert.ok(html.indexOf("version-draft") < html.indexOf('data-testid="version-head"'), "on the Original");
    assert.equal((html.match(/data-testid="version-draft"/g) ?? []).length, 1);
    // The row of the tree says it too (a version that is neither half).
    const models = [model("m1"), stab("s1", "m1", 4, 5), edited("e1", "m1", 7, "design")];
    draft("e1");
    load(models, "s1");
    const rows = render(h(lib.VersionTreeList, { family: lib.versionFamily(models, "s1"), onPick() {} }));
    assert.equal((rows.match(/data-testid="version-row-draft"/g) ?? []).length, 1);
    release();
});

await test("UX-8: the Models tab's Edit… brings the chat back when it is folded away, then asks for the cursor", () => {
    load([model("m1"), stab("s1", "m1", 4, 5)], "m1", "models");
    lib.useWorkspaceStore.setState({ chatHidden: true, composerChoice: "new" });
    const serial = S().composerFocusSerial;
    lib.editVersion({ id: "s1" });
    assert.equal(S().chatHidden, false, "a folded panel is invisible and cannot take the cursor");
    assert.equal(S().activeModelId, "s1");
    assert.equal(S().workspaceTab, "3d");
    assert.equal(S().composerChoice, "edit");
    assert.equal(S().composerFocusSerial, serial + 1);
});

await test("UX-9: a request puts back the changes kept from before a reload first (when the check of the model is done), so it cannot lose them", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    globalThis.__kept = "s1";
    // The check of the model is not done: the request says "wait" itself, and nothing is replayed (a failed replay forgets the draft).
    await lib.submitEdit("add a shelf");
    assert.deepEqual(globalThis.__voxelCalls.map((c) => c[0]), ["request"]);
    // Done: the kept changes come back first, then the request is made on top of them.
    globalThis.__voxelCalls = [];
    globalThis.__voxelState = { proposal: { summary: "x" } };
    lib.useAnalysisStore.setState({ resultModelId: "s1", result: planned() });
    await lib.submitEdit("add a shelf");
    assert.deepEqual(globalThis.__voxelCalls.map((c) => c[0]), ["findResumable", "resume", "request"]);
    // Nothing kept: nothing to put back.
    globalThis.__voxelCalls = [];
    globalThis.__kept = null;
    globalThis.__voxelState = { proposal: { summary: "x" } };
    await lib.submitEdit("add a shelf");
    assert.deepEqual(globalThis.__voxelCalls.map((c) => c[0]), ["findResumable", "request"]);
    // Kept for another version: left alone.
    globalThis.__voxelCalls = [];
    globalThis.__kept = "m1";
    await lib.submitEdit("add a shelf");
    assert.deepEqual(globalThis.__voxelCalls.map((c) => c[0]), ["findResumable", "request"]);
});

await test("UX-3: Stop is on the run chip from the first moment of a request for a change to the blocks, and stops it", async () => {
    readyForEdit([model("m1"), stab("s1", "m1", 4, 5)], "s1");
    globalThis.__heldDuringBlockEdit = () => lib.currentWork();
    await lib.submitEdit("add a shelf");
    const held = globalThis.__blockEdits[0].held;
    assert.equal(typeof held.stop, "function");
    assert.equal(held.label, "Changing the blocks");
    held.stop();
    await tick();
    assert.ok(globalThis.__voxelCalls.some((c) => c[0] === "cancel"), "the editor was asked to cancel");
});

await test("UX-10: the version rows tell a screen reader which one is on screen and what kind each is; a greyed Edit says why when it is reached", () => {
    const models = [model("m1", { analysis: summary(0) }), stab("s1", "m1", 9, 5, { analysis: summary(0) }), edited("e1", "m1", 7, "voxel", "Shelf", { analysis: summary(2) }), optimized("p1", "s1", 10, { analysis: summary(0) })];
    load(models, "p1");
    const html = render(h(lib.VersionTreeList, { family: lib.versionFamily(models, "p1"), onPick() {} }));
    assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1, "one row is current");
    assert.match(html.match(/<button[^>]*aria-current="true"[^>]*>/)[0], /data-active="true"/);
    const rowKinds = [...html.matchAll(/data-testid="version-row-kind"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    assert.deepEqual(rowKinds, ["Optimized.", "Edited."], "the kind in a word where the title does not say it ('v2 · Stabilized' and 'v1 · Original' do)");
    // The Edit half of the toggle and the Models tab's Edit…: reachable, described by the reason.
    const reason = "Edits work on models you generate.";
    const off = render(h(lib.Composer, composerProps({ mode: "new", edit: { target: null, canEdit: false, reason, subject: "the original" } })));
    const id = off.match(/data-testid="mode-edit"[^>]*aria-describedby="([^"]+)"|aria-describedby="([^"]+)"[^>]*data-testid="mode-edit"/);
    const describedBy = id[1] ?? id[2];
    assert.match(off, new RegExp(`<span id="${describedBy.replace(/[«»]/g, ".")}" class="sr-only">${reason.replace(".", "\\.")}</span>`));
    const on = render(h(lib.Composer, composerProps({ mode: "edit", edit: { target: "design", canEdit: true, reason: null, subject: "v2" } })));
    assert.doesNotMatch(on.match(/<button[^>]*data-testid="mode-edit"[^>]*>/)[0], /aria-disabled="|aria-describedby=/);
    const ex = model("ex", { kind: "example", provider: "example", example_slug: "shelf-arm" });
    const panel = render(h(lib.ModelsPanel, { models: [ex], activeModelId: "ex", providers: [HUNYUAN], onView() {}, onEdit() {} }));
    const edit = panel.match(/<button[^>]*data-testid="model-edit"[^>]*>/)[0];
    const pid = edit.match(/aria-describedby="([^"]+)"/)[1];
    assert.ok(panel.includes(`id="${pid}"`), "the description exists");
    assert.match(textOf(panel), /Edits work on models you generate/);
});

// ---------- the words on screen ----------

await test("vocabulary: what the person reads never says voxel, FEM, utilisation, COG, cantilever, compliance, objective, kPa or coordinates (those live in tooltips and the glossary)", async () => {
    const FORBIDDEN = /\b(voxel|voxels|voxelis\w*|FEM|utilisation|COG|cantilever\w*|compliance|objective|kPa|coordinates?)\b/i;
    const models = TREE();
    models.push(edited("e2", "m1", 12, "mesh", "Wider seat"), edited("e3", "m1", 13, "design", "Cup holder"));
    const pages = [];
    for (const tab of ["3d", "analysis", "optimize", "models"]) {
        pages.push(await shellHtml({ models, active: "p1", tab }));
        lib.useWorkspaceStore.setState({ jobs: { e: editJob({ project_id: "p1" }) } });
        pages.push(await shellHtml({ models, active: "e2", tab }));
        lib.useWorkspaceStore.setState({ jobs: {} });
    }
    lib.useWorkspaceStore.setState({ models, activeModelId: "p1", providers: providersWith(ASSIST), workspaceTab: "3d" });
    pages.push(render(h(lib.Composer, composerProps({ mode: "edit", edit: { target: "voxel", canEdit: true, reason: null, subject: "v4 · Lightest" } }))));
    pages.push(render(h(lib.Composer, composerProps({ mode: "new", edit: { target: null, canEdit: false, reason: lib.NOT_EDITABLE_EXAMPLE, subject: "the original" } }))));
    for (const m of models) pages.push(render(h(lib.ModelCard, { model: m, models, active: false, onView() {} })));
    const words = [
        ...Object.values(lib.ROUTE_WORDS), ...Object.values(lib.WORK_CHIP_WORDS), ...Object.values(lib.OPTIMIZE_STOP_WORDS), lib.AI_EDITOR_MISSING, lib.NOT_EDITABLE_EXAMPLE,
        lib.NOT_EDITABLE_DEMO, lib.NOTHING_TO_EDIT, lib.EDIT_LOG_TITLE, lib.OPTIMIZER_LOG_TITLE, lib.STABILIZER_LOG_TITLE,
        lib.placeholderFor({ mode: "edit", generating: false, started: true, target: "voxel", subject: "x" }),
        ...models.map((m) => lib.versionDetail(m) ?? ""), ...models.map((m) => lib.versionStory(m) ?? ""), ...models.map((m) => lib.modelTitle(m)),
        lib.workBusyMessage("blocks", "p1") ?? "", lib.editReplyLine(editJob({ status: "succeeded", model: models[2] }), [MUSE]),
    ];
    for (const page of pages) {
        // The text of the page, minus tooltips and screen-reader sentences that quote the person's own words.
        const visible = textOf(page);
        assert.doesNotMatch(visible, FORBIDDEN, `visible text: ${visible.match(FORBIDDEN)?.[0]}`);
    }
    for (const word of words) assert.doesNotMatch(word, FORBIDDEN, `a sentence of the interface: ${word}`);
});

await test("vocabulary: 'optimiz' is a label (the tab, the kind, the heading) and never a sentence about an objective function", () => {
    const sentences = [...Object.values(lib.OPTIMIZE_STOP_WORDS), lib.workBusyMessage("optimize", "p1") ?? "", ...Object.values(lib.ROUTE_HINTS)];
    for (const s of sentences) assert.doesNotMatch(s, /optimi[sz]ation problem|objective function|compliance/i, s);
});

delete globalThis.document;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
