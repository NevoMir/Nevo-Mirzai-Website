// Tests for changing the blocks by words in the app: the state machine of store/voxelEdit.ts (request -> proposal -> Apply -> draft -> Save)
// against a fake AI editor and a fake server, and the card and the Stability panel rendered in every state.
//
//   node scripts/assignment/test-voxel-edit-ui.mjs
//
// One esbuild bundle with real React and react-dom/server, the stores set to the state under test (the same approach as test-panel.mjs). The
// analysis is the real engine (with the stress estimate) running in Node; only the AI editor, the upload and the part labels are replaced by
// the test. The answers the editor gives are the ones Muse Spark gave in the live runs (fixtures/voxel-edit/runs). No DOM, no network.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-voxel-edit-ui-test");
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
export { React, renderToStaticMarkup };
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/analysisLogic";
export * from "@/assignment/store/workGuard";
export * from "@/assignment/store/voxelEdit";
export * from "@/assignment/store/voxelEditLogic";
export * from "@/assignment/store/partLabels";
export { analyzeAssembly } from "@/assignment/analysis/assembly";
export { withStress } from "@/assignment/analysis/withStress";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { assemblyHash } from "@/assignment/shared/assembly";
export * from "@/assignment/shared/voxelEdit/grid";
export * from "@/assignment/shared/voxelEdit/log";
export { crossCheckVoxelEdit } from "../../../worker/editChecks";
export { submitEdit } from "@/assignment/store/editRouter";
export { rememberPartSoups } from "@/assignment/viewer/partSoups";
export { EditBlocksCard } from "@/assignment/components/analysis/EditBlocksCard";
export { AnalysisPanel } from "@/assignment/components/analysis/AnalysisPanel";
export { AnalysisPeekCard } from "@/assignment/components/analysis/AnalysisPeekCard";
export { verdictOfResult } from "@/assignment/components/analysis/useAnalysis";
export { ApiRequestError } from "@/assignment/lib/api";
export { toasts } from "@/assignment/components/ui/sonner";
`;

await build({
    stdin: { contents: ENTRY, resolveDir: path.join(root, "src/assignment/components"), sourcefile: "entry.tsx", loader: "tsx" },
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
                // The mesh editor is another owner's: the router only needs its name to resolve.
                b.onResolve({ filter: /store\/edit$/ }, () => ({ path: "edit-stub", namespace: "shim" }));
                b.onLoad({ filter: /^edit-stub$/, namespace: "shim" }, () => ({ contents: "export async function startDesignOrMeshEdit() {}", loader: "js" }));
                // Writing a note with a model card saves the project at once; there is no server here.
                b.onResolve({ filter: /store\/persist$/ }, (args) => (args.importer.endsWith("chatNotes.ts") ? { path: "persist-stub", namespace: "shim" } : undefined));
                b.onLoad({ filter: /^persist-stub$/, namespace: "shim" }, () => ({ contents: "export async function saveNow() {}", loader: "js" }));
                b.onResolve({ filter: /analysis\/stabilize\/runStabilize$/ }, () => ({ path: "stabilize-run-stub", namespace: "shim" }));
                b.onLoad({ filter: /^stabilize-run-stub$/, namespace: "shim" }, () => ({ contents: 'export const runStabilize = async () => { throw new Error("not used here"); };', loader: "js" }));
                b.onLoad({ filter: /^zustand-shim$/, namespace: "shim" }, () => ({ contents: ZUSTAND_SHIM, loader: "js", resolveDir: root }));
                b.onLoad({ filter: /^toast-shim$/, namespace: "shim" }, () => ({ contents: TOAST_SHIM, loader: "js" }));
            },
        },
    ],
});

// ---------- a browser, as far as these modules look ----------

const mapStorage = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), get size() { return m.size; } };
};
globalThis.localStorage = mapStorage();
globalThis.sessionStorage = mapStorage();
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const { React, renderToStaticMarkup } = lib;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).slice(0, 700).split("\n").slice(0, 6).join("\n").replace(/^/gm, "       ")}`);
    }
}

// ---------- fixtures ----------

const EX = path.join(root, "public/assignment_alex/examples");
const FIX = path.join(here, "fixtures/voxel-edit");
const cache = JSON.parse(readFileSync(path.join(FIX, "labels-cache.json"), "utf8"));
const answerOf = (tag) => JSON.parse(JSON.parse(readFileSync(path.join(FIX, "runs", `${tag}.json`), "utf8")).content);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, " ").replace(/\s+/g, " ").trim();
const tag = (html, id) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextTick = () => new Promise((r) => setImmediate(r));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SLUG = "pencil-leg-chair";
const ROOT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SRC_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const modelOf = (id, extra = {}) => ({
    id, project_id: PROJECT, job_id: "job", provider: "stabilizer", prompt: "a chair with pencil legs", glb_url: `/files/${id}.glb`, thumbnail_url: null, size_bytes: 1000, part_count: 5,
    created_at: "2026-10-24T10:00:00.000Z", analysis: null, kind: "stabilized", source_model_id: ROOT_ID, example_slug: null, derived: { depth: 1 }, edit: null, optimization: null, ...extra,
});
const rootModel = modelOf(ROOT_ID, { provider: "example", kind: "example", source_model_id: null, derived: null, example_slug: SLUG });
const exampleMeta = lib.readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, SLUG, "stabilized.glb")))).meta;
const sourceModel = modelOf(SRC_ID, { derived: exampleMeta });

const analyse = async (descriptor, settings) => lib.withStress(lib.analyzeAssembly(descriptor, null, settings));
const stabilizedDescriptor = () => lib.readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, SLUG, "stabilized.glb")))).descriptor;
const labelling = () => {
    const lab = cache[SLUG];
    const owner = new Int8Array(1000).fill(-1);
    for (const [c, p] of lab.owner) owner[c] = p;
    return { names: lab.names, owner, source: "mesh" };
};

/** What the fake server and the fake AI editor saw. */
let asked, uploads, answers, uploadFails, askGate;
function resetWorld() {
    asked = [];
    uploads = [];
    answers = [];
    uploadFails = 0;
    askGate = null;
    lib.setVoxelEditDeps({
        ask: async (body, signal) => {
            asked.push(body);
            if (askGate) await new Promise((resolve, reject) => { askGate.release = resolve; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); });
            const next = answers.shift();
            if (next instanceof Error) throw next;
            return { answer: next ?? answerOf("T10a"), model: "meta/muse-spark-1.3-contributor", cost_usd: 0.0004, prompt_tokens: 2600, completion_tokens: 900, ms: 5000 };
        },
        analyse,
        upload: async (sourceId, glb) => {
            if (uploadFails > 0) {
                uploadFails--;
                throw new lib.ApiRequestError(409, "This version already has the most versions it can have.");
            }
            const read = lib.readAssemblyGlb(glb);
            assert.ok(read.ok && read.edit, "the upload is an assembly with an edit log");
            const model = modelOf(`bbbbbbbb-0000-4000-8000-${String(uploads.length + 1).padStart(12, "0")}`, {
                kind: "edited", provider: "editor", source_model_id: sourceId, derived: null,
                edit: lib.summarizeVoxelEdit(read.edit, { depth: 2 }), created_at: "2026-10-24T10:05:00.000Z",
            });
            uploads.push({ sourceId, glb, read, model });
            return model;
        },
        labels: async () => labelling(),
        now: () => Date.now(),
    });
}

/** The workspace and the analysis as the Stability tab has them for the stabilized chair. */
async function openChair(model = sourceModel) {
    lib.resetWorkGuard();
    lib.forgetPartLabels();
    globalThis.sessionStorage.clear();
    lib.useVoxelEditStore.getState().discard();
    lib.useWorkspaceStore.setState({ activeProjectId: PROJECT, models: [rootModel, model], activeModelId: model.id, messages: [], workspaceTab: "analysis", providers: null });
    const result = await analyse(stabilizedDescriptor(), {});
    lib.useAnalysisStore.setState({ result: null, resultModelId: null, preview: null });
    lib.useAnalysisStore.getState().runSucceeded(model.id, result);
    resetWorld();
    return result;
}

const store = () => lib.useVoxelEditStore.getState();
const guard = () => lib.currentWork();
const notes = () => lib.useWorkspaceStore.getState().messages;

// ================= the state machine =================

console.log("the flow");
await test("a request becomes a proposal: summary, counts, what it does to the verdict, a preview on the stage, the work guard held", async () => {
    const base = await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    const s = store();
    assert.equal(s.status, "proposal");
    assert.equal(s.sourceModelId, SRC_ID);
    assert.ok(s.proposal.summary.length > 0);
    assert.ok(s.proposal.moved > 0, JSON.stringify(s.proposal));
    assert.equal(s.proposal.change.tone, "worse", "moving the backrest forward breaks the model (live run: 0 errors -> 4 floating)");
    assert.match(s.proposal.change.text, /Stable → \d+ problems?/);
    assert.ok(s.proposal.change.broke.length > 0);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].instruction, "move the backrest one block towards the front");
    assert.ok(asked[0].scene.startsWith("MODEL: ") && asked[0].scene.length < 9000);
    assert.equal(guard()?.kind, "blocks");
    assert.equal(guard()?.waiting, true, "a proposal waits for a decision: the Draft chip, not the run chip");
    const preview = lib.useAnalysisStore.getState().preview;
    assert.ok(preview && preview.owner === "blocks" && preview.modelId === SRC_ID);
    assert.deepEqual(preview.result.transform, base.transform, "the preview is drawn in the frame of the stage");
    assert.ok(preview.result.blocks.some((b) => b.role === "user"));
    assert.ok(notes().some((m) => m.role === "assistant" && m.content.includes(s.proposal.summary)), "the summary is in the chat");
});
await test("Apply puts the proposal in a draft; the draft is kept for a reload; the headline is the draft's", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    const s = store();
    assert.equal(s.status, "idle");
    assert.equal(s.proposal, null);
    assert.equal(s.draft.count, 1);
    assert.equal(s.draft.redo, 0);
    assert.ok(s.draftResult.stats.blockCount > 0);
    assert.equal(lib.useAnalysisStore.getState().preview.owner, "blocks");
    const kept = JSON.parse(globalThis.sessionStorage.getItem("assembly-studio-block-draft"));
    assert.equal(kept.modelId, SRC_ID);
    assert.equal(kept.entries.length, 1);
    assert.equal(kept.entries[0].instruction, "move the backrest one block towards the front");
    assert.equal(guard()?.kind, "blocks", "the draft keeps the guard");
    assert.equal(guard()?.waiting, true, "... and says it waits for Save or Discard");
});
await test("a second request sees the first (EARLIER EDITS), Undo and Redo walk the draft, a new request after Undo drops the redo", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    answers.push(answerOf("T10a"));
    // the second change: the model is asked about the DRAFT, not the saved version
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move it again" });
    assert.match(asked[1].scene, /EARLIER EDITS/);
    assert.match(asked[1].scene, /move the backrest one block towards the front/);
    store().apply();
    assert.equal(store().draft.count, 2);
    store().undo();
    assert.equal(store().draft.count, 1);
    assert.equal(store().draft.redo, 1);
    store().undo();
    assert.equal(store().draft.count, 0);
    assert.equal(lib.useAnalysisStore.getState().preview, null, "nothing applied: the stage shows the saved version");
    assert.equal(guard()?.kind, "blocks", "undone changes can still be put back: the guard stays");
    store().redo();
    store().redo();
    assert.equal(store().draft.count, 2);
    store().undo();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move it again" });
    store().apply();
    assert.equal(store().draft.count, 2);
    assert.equal(store().draft.redo, 0, "a new change replaces what was undone");
});
await test("Save version uploads ONE file with the whole log; the new version is on the stage; the guard, the preview and the kept draft are gone", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    await store().save();
    assert.equal(uploads.length, 1);
    const { sourceId, read, model } = uploads[0];
    assert.equal(sourceId, SRC_ID);
    assert.equal(read.edit.edits.length, 1);
    assert.equal(read.edit.depth, 2, "the source is a version of the example, so the new version is two deep");
    assert.equal(read.edit.stabilized_depth, 1);
    assert.equal(read.edit.base_steps > 0, true, "the stabilizer's steps come first");
    assert.equal(lib.crossCheckVoxelEdit(read.descriptor, read.edit), null);
    assert.equal(read.edit.assembly_hash, await lib.assemblyHash(read.descriptor));
    const w = lib.useWorkspaceStore.getState();
    assert.ok(w.models.some((m) => m.id === model.id));
    assert.equal(w.activeModelId, model.id);
    assert.equal(guard(), null);
    assert.equal(lib.useAnalysisStore.getState().preview, null);
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), null);
    assert.equal(store().status, "idle");
    assert.equal(store().savedModelId, model.id);
    assert.ok(notes().some((m) => m.model_ids?.includes(model.id)), "the chat points at the new version");
    // its labels are known without reading its file
    const l = await lib.partLabelsFor(model);
    assert.equal(l.source, "log");
    assert.deepEqual(l.names, read.edit.parts);
});
// Review finding F1: Shift+Enter in the composer is a newline, a paste may carry tabs; the saved log refuses control characters, so a request typed
// that way produced a proposal and a draft that could never be saved (every retry threw the same RangeError).
await test("a request typed over several lines or with a tab is one line all the way: the editor, the proposal, the chat, the log, the saved file", async () => {
    await openChair();
    lib.useWorkspaceStore.setState({ providers: { providers: [], default_provider: null, access_required: false, daily_limit: null, used_today: 0, assist: { available: true, queued: true, images: true, model: "m", daily_limit: 100, used_today: 0 } } });
    const typed = "move the backrest\none block\ttowards the front\r\n";
    const out = await lib.submitEdit(typed);
    assert.deepEqual(out, { ok: true });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].instruction, "move the backrest one block towards the front");
    assert.equal(store().proposal.instruction, "move the backrest one block towards the front");
    assert.ok(notes().some((m) => m.role === "user" && m.content === "move the backrest one block towards the front"), "the chat shows it on one line");
    store().apply();
    await store().save();
    assert.equal(store().status, "idle", store().error ?? "");
    assert.equal(store().savedModelId, uploads[0]?.model.id, "the version was saved");
    assert.equal(uploads[0].read.edit.edits[0].instruction, "move the backrest one block towards the front");
    // the store alone (what requestBlockEdit does for a caller that is not the router) flattens too
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: " move\tit\nforward \u0007please " });
    assert.equal(asked[0].instruction, "move it forward please");
    // a text of nothing but blanks and control characters is "nothing to say"; a long text is judged after it is flattened
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "\n\t \u0001" }), /Write what you want/);
    store().discardProposal();
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: `move it${" \n".repeat(400)}forward` });
    assert.equal(asked[0].instruction, "move it forward");
});
await test("Save in two changes keeps both in the log, in order, with the steps after the stabilizer's", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "first" });
    store().apply();
    answers.push(answerOf("T2a"));
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "second" });
    store().apply();
    await store().save();
    const { read } = uploads[0];
    assert.deepEqual(read.edit.edits.map((e) => e.n), [1, 2]);
    assert.deepEqual(read.edit.edits.map((e) => e.instruction), ["first", "second"]);
    assert.equal(lib.crossCheckVoxelEdit(read.descriptor, read.edit), null);
});
await test("a failed save keeps the draft: the error says why, Try again saves it", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    uploadFails = 1;
    await store().save();
    assert.equal(store().status, "error");
    assert.match(store().error, /most versions/);
    assert.equal(store().draft.count, 1);
    assert.equal(guard()?.kind, "blocks");
    assert.ok(lib.toasts.some((t) => t.kind === "error" && /save/i.test(t.title)));
    await store().save();
    assert.equal(uploads.length, 1);
    assert.equal(store().status, "idle");
    assert.equal(guard(), null);
});
await test("Discard throws the draft away: preview, guard and kept draft", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    store().discard();
    assert.equal(store().draft, null);
    assert.equal(store().sourceModelId, null);
    assert.equal(guard(), null);
    assert.equal(lib.useAnalysisStore.getState().preview, null);
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), null);
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "again" });
    store().discardProposal();
    assert.equal(guard(), null, "discarding the only proposal ends the session");
    assert.equal(lib.useAnalysisStore.getState().preview, null);
});
await test("Stop while the editor thinks: back to the field, the late answer is dropped, the guard is free", async () => {
    await openChair();
    askGate = {};
    const p = lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    await nextTick();
    await sleep(5);
    assert.equal(store().status, "planning");
    assert.ok(guard()?.stop, "the run chip has a Stop");
    assert.equal(guard()?.waiting, false, "a request in flight is running work, not a draft: the run chip shows it");
    guard().stop();
    await p;
    assert.equal(store().status, "idle");
    assert.equal(store().proposal, null);
    assert.equal(guard(), null);
    assert.equal(lib.useAnalysisStore.getState().preview, null);
    assert.equal(notes().filter((m) => m.role === "assistant").length, 0, "nothing was said about a change that never came");
});
await test("an answer that arrives after the person went to another version is dropped", async () => {
    await openChair();
    askGate = {};
    const p = lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    await sleep(10);
    lib.useWorkspaceStore.setState({ activeModelId: ROOT_ID });
    askGate.release();
    await p;
    assert.equal(store().status, "idle");
    assert.equal(store().proposal, null);
    assert.equal(guard(), null);
});
await test("a question, a refusal and a change that changes nothing are shown as notices, not proposals", async () => {
    await openChair();
    // the editor asks
    answers.push({ summary: "", notes: "", clarification: "Which side do you mean?", ops: [] });
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "make it nicer" });
    assert.equal(store().proposal, null);
    assert.equal(store().notice.kind, "ask");
    assert.equal(store().notice.text, "Which side do you mean?");
    assert.ok(notes().some((m) => m.content === "Which side do you mean?"));
    assert.equal(guard(), null, "no session without a change");
    // a refusal: grow past the edge
    answers.push({ summary: "x", notes: "", clarification: "", ops: [{ op: "stretch", region: null, box: null, dirs: null, amount: 9, axis: "k", at: 0, plane: null, offset: null, wall: null, include_added: false }] });
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "much taller" });
    assert.equal(store().notice.kind, "refused");
    assert.match(store().notice.text + store().notice.warnings.join(" "), /does not fit/);
    // nothing changes: an add into cells that are full
    const [ci, cj, ck] = stabilizedDescriptor().cells;
    answers.push({ summary: "Added a block.", notes: "", clarification: "", ops: [{ op: "add", region: null, box: [ci, cj, ck, ci, cj, ck], dirs: null, amount: null, axis: null, at: null, plane: null, offset: null, wall: null, include_added: false }] });
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "fill the floor" });
    assert.equal(store().proposal, null);
    assert.equal(store().notice.kind, "nothing");
    assert.match(store().notice.warnings.join(" "), /already full/);
});
await test("errors reject with a sentence for the person and leave nothing behind", async () => {
    await openChair();
    answers.push(new lib.ApiRequestError(429, "Today's limit of AI requests is used up. Try again tomorrow."));
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x" }), /Today's limit/);
    assert.equal(store().status, "idle");
    assert.equal(guard(), null);
    assert.equal(lib.useAnalysisStore.getState().preview, null);
    answers.push({ summary: "s", notes: "", clarification: "" }); // no ops list at all
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "y" }).then(
        () => assert.ok(store().notice || store().proposal === null),
        (e) => assert.match(String(e.message), /could not be read/),
    );
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "   " }), /Write what you want/);
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x".repeat(501) }), /under 500/);
    await assert.rejects(lib.requestBlockEdit({ modelId: "00000000-0000-4000-8000-0000000000ff", instruction: "x" }), /not in the project/);
    assert.equal(guard(), null);
});
await test("the model's check must be ready; other work holds the floor", async () => {
    await openChair();
    lib.useAnalysisStore.setState({ result: null, resultModelId: null });
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x" }), /Wait for the check/);
    assert.equal(guard(), null);
    await openChair();
    const release = lib.acquireWork("stabilize", PROJECT);
    await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x" }), /Finish or discard the stabilizing first/);
    assert.equal(asked.length, 0, "the editor is not asked while something else runs");
    release();
});
await test("a draft of one version blocks changes to another; twelve changes fill a version", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "a" });
    store().apply();
    await assert.rejects(lib.requestBlockEdit({ modelId: ROOT_ID, instruction: "b" }), /Save or discard the changes you made to the other version/);
    assert.equal(store().draft.count, 1, "the draft is untouched");
    // fill the draft: the chair has no room to grow, so the same shift is applied back and forth
    for (let n = 1; n < 12; n++) {
        answers.push(n % 2 === 1 ? { summary: "back", notes: "", clarification: "", ops: [{ op: "shift", region: "D", box: null, dirs: null, amount: null, axis: null, at: null, plane: null, offset: [0, 1, 0], wall: null, include_added: false }] } : answerOf("T10a"));
        await lib.requestBlockEdit({ modelId: SRC_ID, instruction: `change ${n + 1}` });
        if (store().proposal) store().apply();
    }
    if (store().draft.count === 12) {
        assert.equal(store().draft.full, true);
        await assert.rejects(lib.requestBlockEdit({ modelId: SRC_ID, instruction: "one more" }), /up to 12 changes/);
    } else {
        assert.ok(store().draft.count >= 2, `the loop applied ${store().draft.count} changes`);
    }
});
await test("a kept draft is found after a reload and rebuilt exactly, with every step undoable", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    answers.push(answerOf("T2a"));
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "add a column" });
    store().apply();
    const before = store().draftResult;
    const kept = globalThis.sessionStorage.getItem("assembly-studio-block-draft");
    // a reload: the store is empty, the browser still has the kept draft
    store().discard();
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), null);
    globalThis.sessionStorage.setItem("assembly-studio-block-draft", kept);
    store().findResumable(SRC_ID);
    assert.deepEqual(store().resumable, { modelId: SRC_ID, count: 2 });
    store().findResumable(ROOT_ID);
    assert.equal(store().resumable, null, "only for the model it belongs to");
    store().findResumable(SRC_ID);
    await store().resume();
    const s = store();
    assert.equal(s.status, "idle");
    assert.equal(s.draft.count, 2);
    assert.equal(s.resumable, null);
    assert.equal(s.draftResult.stats.blockCount, before.stats.blockCount);
    assert.deepEqual(s.draftResult.blocks.map((b) => [b.cell, b.role, b.step]), before.blocks.map((b) => [b.cell, b.role, b.step]));
    assert.equal(guard()?.kind, "blocks");
    store().undo();
    assert.equal(store().draft.count, 1);
});
await test("a request that comes back with no change does not forget the changes kept from before a reload", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    const kept = globalThis.sessionStorage.getItem("assembly-studio-block-draft");
    assert.ok(kept);
    store().discard();
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), null, "an explicit discard forgets them");
    // a reload: the browser still has the kept draft; a question is asked before it is resumed
    globalThis.sessionStorage.setItem("assembly-studio-block-draft", kept);
    answers.push({ summary: "", notes: "", clarification: "Which side do you mean?", ops: [] });
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "make it nicer" });
    assert.equal(store().notice?.kind, "ask");
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), kept, "the empty session did not own the kept draft");
    store().findResumable(SRC_ID);
    assert.deepEqual(store().resumable, { modelId: SRC_ID, count: 1 }, "... so Continue is still offered");
    // "Forget" on the offer is an explicit discard
    store().discard();
    assert.equal(globalThis.sessionStorage.getItem("assembly-studio-block-draft"), null);
});
await test("leaving the project (or deleting the version) ends the session", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x" });
    store().apply();
    lib.useWorkspaceStore.setState({ activeProjectId: "22222222-2222-4222-8222-222222222222", models: [] });
    assert.equal(store().draft, null);
    assert.equal(store().sourceModelId, null);
    assert.equal(guard(), null);
    assert.equal(lib.useAnalysisStore.getState().preview, null);
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "x" });
    store().apply();
    lib.useWorkspaceStore.setState({ models: [rootModel] });
    assert.equal(store().draft, null, "the version the draft is about is gone");
    assert.equal(guard(), null);
});
await test("a mesh original is edited as the unstable blocks it voxelises to; the before is judged like the after", async () => {
    // an original: the analysis of a voxelised mesh has no assembly and no roles
    const asm = await analyse(stabilizedDescriptor(), {});
    const originalCells = asm.blocks.filter((b) => !b.role || b.role === "original").map((b) => ({ ...b, role: undefined, step: undefined }));
    const mesh = { ...asm, assembly: null, blocks: originalCells.map((b, index) => ({ ...b, index })) };
    lib.resetWorkGuard();
    lib.forgetPartLabels();
    globalThis.sessionStorage.clear();
    store().discard();
    const original = modelOf(ROOT_ID, { provider: "example", kind: "example", source_model_id: null, derived: null, example_slug: SLUG });
    lib.useWorkspaceStore.setState({ activeProjectId: PROJECT, models: [original], activeModelId: ROOT_ID, messages: [] });
    lib.useAnalysisStore.setState({ result: null, resultModelId: null, preview: null });
    lib.useAnalysisStore.getState().runSucceeded(ROOT_ID, mesh);
    resetWorld();
    answers.push(answerOf("T10a"));
    await lib.requestBlockEdit({ modelId: ROOT_ID, instruction: "move the backrest one block towards the front" });
    assert.equal(store().status, "proposal");
    assert.match(asked[0].scene, /original blocks, not stabilized/);
    store().apply();
    await store().save();
    const { read } = uploads[0];
    assert.equal(read.edit.depth, 1, "made from a root");
    assert.equal(read.edit.stabilized_depth, 0);
    assert.equal(read.edit.base_steps, 0, "the original has no steps");
    assert.equal(lib.crossCheckVoxelEdit(read.descriptor, read.edit), null);
});

// ================= the card =================

const FORBIDDEN = /\bvoxel|\bFEM\b|utili[sz]ation|\bCOG\b|cantilever|compliance|\bobjective\b|\bkPa\b/i;
const chairModel = () => lib.useWorkspaceStore.getState().models.find((m) => m.id === SRC_ID);
const chairResult = () => lib.useAnalysisStore.getState().result;
const card = (props = {}) => render(h(lib.EditBlocksCard, { model: chairModel(), result: chairResult(), ...props }));
const reset = () => lib.useVoxelEditStore.setState({ status: "idle", sourceModelId: null, proposal: null, draft: null, draftResult: null, notice: null, error: null, startedAt: null, resuming: false, resumable: null });

console.log("the card");
await test("idle: the field, three chips, no filled button, plain words", async () => {
    await openChair();
    reset();
    const html = card();
    assert.match(html, /data-testid="blockedit-card"/);
    assert.match(html, /data-state="idle"/);
    assert.match(html, /data-testid="blockedit-input"/);
    assert.match(html, /placeholder="e\.g\. “add a shelf under the seat”"/);
    assert.equal((html.match(/data-testid="blockedit-chips"/g) ?? []).length, 1);
    for (const chip of lib.EDIT_CHIPS) assert.ok(html.includes(chip), chip);
    assert.doesNotMatch(html, /data-testid="blockedit-apply"|data-testid="blockedit-save"/);
    assert.doesNotMatch(text(html), FORBIDDEN);
    assert.match(html, /maxLength="500"|maxlength="500"/i);
});
await test("the field is off, with the reason, when the server has no editor, other work runs, or there are no blocks", async () => {
    await openChair();
    reset();
    lib.useWorkspaceStore.setState({ providers: { providers: [], default_provider: null, access_required: false, daily_limit: null, used_today: 0, assist: { available: false, queued: false, images: false, model: "", daily_limit: null, used_today: 0 } } });
    let html = card();
    assert.match(html, /disabled=""/);
    assert.match(html, /The AI editor is not set up on the server\./);
    lib.useWorkspaceStore.setState({ providers: null });
    const release = lib.acquireWork("stabilize", PROJECT);
    html = card();
    assert.match(html, /Finish or discard the stabilizing first\./);
    release();
    assert.doesNotMatch(card(), /Finish or discard/);
    const empty = { ...chairResult(), stats: { ...chairResult().stats, blockCount: 0 } };
    assert.match(render(h(lib.EditBlocksCard, { model: chairModel(), result: empty })), /There are no blocks to change\./);
});
await test("planning: the clock and Stop; the field stays, off, so the words are not lost if the request fails", async () => {
    await openChair();
    reset();
    lib.useVoxelEditStore.setState({ status: "planning", sourceModelId: SRC_ID, startedAt: Date.now() - 6000, instruction: "x" });
    const html = card();
    assert.match(html, /data-state="planning"/);
    assert.match(text(html), /Muse is reading the blocks/);
    assert.match(html, /data-testid="blockedit-stop"/);
    assert.match(tag(html, "blockedit-input"), /disabled=""/);
    assert.doesNotMatch(html, /data-testid="blockedit-chips"/);
    lib.useVoxelEditStore.setState({ resuming: true });
    assert.match(text(card()), /Putting your changes back/);
});
await test("a proposal: the sentence, the numbers, the change of verdict, Apply and Discard; a big change is worded more strongly", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    let html = card();
    assert.match(html, /data-state="proposal"/);
    assert.match(html, /data-testid="blockedit-summary"/);
    assert.match(html, /data-testid="blockedit-counts"/);
    assert.match(tag(html, "blockedit-change"), /data-tone="worse"/);
    assert.match(text(html), /Stable → \d+ problems?/);
    assert.match(html, /data-testid="blockedit-apply"/);
    assert.match(html, /data-testid="blockedit-discard-proposal"/);
    assert.equal((html.match(/bg-primary text-primary-foreground/g) ?? []).length, 1, "one filled button");
    assert.doesNotMatch(html, /data-testid="blockedit-input"/, "the field waits for the decision");
    assert.doesNotMatch(text(html), FORBIDDEN);
    lib.useVoxelEditStore.setState({ proposal: { ...store().proposal, large: true, removed: 80, notes: "I took the left of the Front view as the left.", warnings: ["Step 2: no room - it already reaches the edge of the space the model can use."], protectedKept: 3 } });
    html = card();
    assert.match(html, /data-testid="blockedit-large"/);
    assert.match(text(html), /big change: 80 blocks would go/);
    assert.match(html, /data-testid="blockedit-notes"/);
    assert.match(html, /data-testid="blockedit-warning"/);
    assert.match(text(html), /Kept 3 blocks that the stabilizer added/);
    store().discardProposal();
});
await test("a draft: Save is the filled button; Undo, Redo, Stabilize (only when something is left to fix), Discard; the checkbox", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    store().apply();
    let html = card();
    assert.match(html, /data-state="draft"/);
    assert.match(text(html), /Draft: 1 change, not saved/);
    assert.match(html, /data-testid="blockedit-save"/);
    assert.match(html, /data-testid="blockedit-undo"/);
    assert.match(tag(html, "blockedit-redo"), /disabled=""/);
    assert.match(html, /data-testid="blockedit-stabilize"/, "the edit broke the model: Stabilize is offered");
    assert.match(html, /data-testid="blockedit-stabilize-after"/);
    assert.match(html, /data-testid="blockedit-figures"/);
    assert.equal((html.match(/bg-primary text-primary-foreground/g) ?? []).length, 1, "one filled button");
    assert.match(html, /data-testid="blockedit-input"/, "more changes can follow");
    assert.doesNotMatch(text(html), FORBIDDEN);
    // a draft that is fine has no Stabilize button
    lib.useVoxelEditStore.setState({ draft: { ...store().draft, verdict: { ...store().draft.verdict, kind: "pass", fix: "none" } } });
    assert.doesNotMatch(card(), /data-testid="blockedit-stabilize"[ >]/);
    // the twelfth change: the field is off and says so
    lib.useVoxelEditStore.setState({ draft: { ...store().draft, count: 12, full: true } });
    html = card();
    assert.match(html, /data-testid="blockedit-full"/);
    assert.match(text(html), /Save this version before you make more changes\./);
    // every change undone
    lib.useVoxelEditStore.setState({ draft: { ...store().draft, count: 0, redo: 2, full: false } });
    html = card();
    assert.match(text(html), /Your changes are undone/);
    assert.doesNotMatch(html, /data-testid="blockedit-save"/);
    assert.doesNotMatch(tag(html, "blockedit-redo"), /disabled=""/);
    store().discard();
});
await test("a notice, an unsaved draft elsewhere, a kept draft, a failed save", async () => {
    await openChair();
    reset();
    lib.useVoxelEditStore.setState({ notice: { kind: "ask", text: "Which side do you mean?", warnings: [] } });
    let html = card();
    assert.match(tag(html, "blockedit-notice"), /data-kind="ask"/);
    assert.match(text(html), /Which side do you mean\?/);
    assert.match(html, /data-testid="blockedit-input"/);
    lib.useVoxelEditStore.setState({ notice: { kind: "refused", text: "Step 1 (stretch): does not fit.", warnings: ["nothing else"] } });
    assert.match(card(), /data-kind="refused"/);
    reset();
    lib.useVoxelEditStore.setState({ sourceModelId: ROOT_ID, draft: { count: 1, redo: 0, verdict: { kind: "pass", fix: "none", errors: 0, warnings: 0, blocks: 3, custom: null, headline: "", short: "Stable" }, change: { tone: "same", text: "Still stable", broke: [], fixed: [] }, blocks: 3, baseBlocks: 3, last: "x", full: false } });
    html = card();
    assert.match(html, /data-testid="blockedit-elsewhere"/);
    assert.match(text(html), /You have unsaved changes to another version\./);
    assert.match(html, /data-testid="blockedit-go"/);
    assert.doesNotMatch(html, /data-testid="blockedit-input"/);
    reset();
    lib.useVoxelEditStore.setState({ resumable: { modelId: SRC_ID, count: 2 } });
    html = card();
    assert.match(html, /data-testid="blockedit-resume"/);
    assert.match(text(html), /You have 2 changes, not saved on this version\./);
    assert.match(html, /data-testid="blockedit-continue"/);
    reset();
    lib.useVoxelEditStore.setState({ status: "error", sourceModelId: SRC_ID, error: "The server could not be reached.", draft: { count: 1, redo: 0, verdict: { kind: "pass", fix: "none", errors: 0, warnings: 0, blocks: 3, custom: null, headline: "", short: "Stable" }, change: { tone: "same", text: "Still stable", broke: [], fixed: [] }, blocks: 3, baseBlocks: 3, last: "x", full: false } });
    html = card();
    assert.match(html, /role="alert"/);
    assert.match(text(html), /Could not save the version/);
    assert.match(html, /data-testid="blockedit-retry"/);
});
await test("the phone's card: one row when idle, the decisions when there is something to decide", async () => {
    await openChair();
    reset();
    let html = card({ compact: true });
    assert.match(html, /data-testid="blockedit-open"/);
    assert.doesNotMatch(html, /data-testid="blockedit-input"/);
    assert.match(text(html), /Change the blocks/);
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    html = card({ compact: true });
    assert.match(html, /data-testid="blockedit-apply"/);
    store().apply();
    html = card({ compact: true });
    assert.match(html, /data-testid="blockedit-save"/);
    assert.doesNotMatch(html, /data-testid="blockedit-figures"|data-testid="blockedit-stabilize-after"/);
    store().discard();
});

await test("the phone's compact proposal keeps the warnings, the notes and the blocks the stabilizer kept", async () => {
    await openChair();
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    lib.useVoxelEditStore.setState({ proposal: { ...store().proposal, notes: "Read \"the back\" as the backrest.", warnings: ["Two blocks were left out."], protectedKept: 3 } });
    const html = card({ compact: true });
    assert.match(html, /data-testid="blockedit-notes"/);
    assert.match(html, /data-testid="blockedit-warning"/);
    assert.match(text(html), /Kept 3 blocks that the stabilizer added/);
    store().discard();
});
console.log("the panel");
await test("the Stability panel: the card sits under the answer; with a draft the headline is the draft's and the Stabilize button waits", async () => {
    const base = await openChair();
    reset();
    const snapshot = (result) => ({ phase: "done", result, verdict: lib.verdictOfResult(result), sentence: null, run: { modelId: SRC_ID, status: "idle", error: null, stage: "", progress: 0 }, viewResult: result, previewResult: null, ready: true, unavailable: null });
    const panel = () => render(h(lib.AnalysisPanel, { model: chairModel(), snapshot: snapshot(base), variant: "dock" }));
    let html = panel();
    assert.match(html, /data-testid="blockedit-card"/);
    assert.match(html, /data-testid="analysis-chips"/);
    assert.doesNotMatch(html, /data-testid="analysis-draft-label"/);
    const idleVerdict = html.match(/data-verdict="(\w+)"/)[1];
    assert.equal(idleVerdict, "pass");
    await lib.requestBlockEdit({ modelId: SRC_ID, instruction: "move the backrest one block towards the front" });
    html = panel();
    assert.doesNotMatch(html, /data-testid="stabilize-start"/, "a proposal is on the table: Stabilize waits");
    store().apply();
    html = panel();
    assert.match(html, /data-testid="analysis-draft-label"/);
    assert.match(text(html), /With your changes, not saved yet/);
    assert.notEqual(html.match(/data-verdict="(\w+)"/)[1], "pass", "the headline is the draft's verdict");
    assert.doesNotMatch(html, /data-testid="analysis-chips"/, "the draft's figures are in the card");
    assert.doesNotMatch(html, /data-testid="analysis-issues"/, "the problem list belongs to the saved version");
    assert.match(html, /data-testid="blockedit-draft"/);
    assert.doesNotMatch(text(html), FORBIDDEN);
    // the peek card does the same
    const peek = render(h(lib.AnalysisPeekCard, { model: chairModel(), snapshot: snapshot(base) }));
    assert.match(peek, /data-testid="blockedit-card"/);
    assert.match(peek, /data-testid="blockedit-save"/);
    assert.doesNotMatch(peek, /data-testid="stabilize-start"/);
    store().discard();
    html = panel();
    assert.match(html, /data-testid="analysis-chips"/);
    assert.doesNotMatch(html, /data-testid="analysis-draft-label"/);
});

// ================= the labels of a model =================

console.log("part labels");
await test("labels: the nearest log, else the mesh on the stage; stabilizing never moves a block; nothing is kept when the mesh is not on the stage", async () => {
    lib.forgetPartLabels();
    const lab = labelling();
    let meshCalls = 0;
    let logCalls = 0;
    lib.setPartLabelDeps({
        readLog: async () => {
            logCalls++;
            const d = stabilizedDescriptor();
            const labels = Array.from({ length: d.cells.length / 5 }, () => ".").join("");
            return { names: [], labels, descriptor: d };
        },
        labelMesh: async (m) => {
            meshCalls++;
            return m.id === ROOT_ID ? lab : null;
        },
    });
    lib.useWorkspaceStore.setState({ models: [rootModel, sourceModel] });
    // a stabilized version asks its root mesh
    let l = await lib.partLabelsFor(sourceModel);
    assert.equal(l.source, "mesh");
    assert.deepEqual(l.names, lab.names);
    assert.equal(meshCalls, 1);
    await lib.partLabelsFor(sourceModel);
    assert.equal(meshCalls, 1, "cached");
    // a block edit of it has its own log, which is what its children inherit
    const edited = modelOf("cccccccc-0000-4000-8000-000000000003", { kind: "edited", provider: "editor", source_model_id: SRC_ID, derived: null, edit: { target: "voxel" } });
    const child = modelOf("dddddddd-0000-4000-8000-000000000004", { source_model_id: edited.id });
    lib.useWorkspaceStore.setState({ models: [rootModel, sourceModel, edited, child] });
    l = await lib.partLabelsFor(child);
    assert.equal(l.source, "log", "the log of the edit is what its children inherit");
    assert.equal(l.names.length, 0, "and it says there are no parts");
    assert.equal(logCalls, 1);
    // a mesh that is not on the stage gives no labels and is not remembered
    lib.forgetPartLabels();
    const other = modelOf("eeeeeeee-0000-4000-8000-000000000005", { kind: "generated", provider: "muse", source_model_id: null, derived: null });
    lib.useWorkspaceStore.setState({ models: [other] });
    meshCalls = 0;
    l = await lib.partLabelsFor(other);
    assert.equal(l.names.length, 0);
    await lib.partLabelsFor(other);
    assert.equal(meshCalls, 2, "asked again");
    // the optimizer's view: part name -> cells
    const parts = lib.cellsByPart(lab);
    assert.deepEqual(Object.keys(parts), lab.names);
    assert.equal(Object.values(parts).reduce((n, cells) => n + cells.length, 0), cache[SLUG].owner.filter(([, p]) => p >= 0).length);
    lib.setPartLabelDeps();
});

// Review finding F11: a mesh edit is stored with its source's part count (1 for a Hunyuan model) although an edit can add parts to the file,
// and the labeller took "fewer than 2 parts" as the end of the matter without looking at the file.
await test("labels: the stored part count of an edited mesh does not close the question (parts an edit added), that of a single-part original does", async () => {
    lib.forgetPartLabels();
    lib.setPartLabelDeps(); // the real labeller, with a fake stage
    let reads = 0;
    const soup = new Float32Array(9);
    lib.rememberPartSoups(soup, () => {
        reads++;
        return [{ name: "Model", positions: soup }];
    });
    const stage = (url) => lib.useAnalysisStore.setState({ loaded: { url, assembly: null, extractTriangles: () => ({ positions: soup }) } });
    const hunyuan = modelOf("f1111111-0000-4000-8000-000000000001", { kind: "generated", provider: "hunyuan", source_model_id: null, derived: null, part_count: 1, glb_url: "/files/hunyuan.glb" });
    const edited = modelOf("f2222222-0000-4000-8000-000000000002", { kind: "edited", provider: "hunyuan", source_model_id: hunyuan.id, derived: null, part_count: 1, glb_url: "/files/edited.glb", edit: { target: "mesh" } });
    lib.useWorkspaceStore.setState({ models: [hunyuan, edited] });
    stage("/files/hunyuan.glb");
    let l = await lib.partLabelsFor(hunyuan);
    assert.equal(l.names.length, 0);
    assert.equal(reads, 0, "a single-part original is answered without reading its triangles");
    stage("/files/edited.glb");
    l = await lib.partLabelsFor(edited);
    assert.equal(l.names.length, 0, "one part in the file: no labels");
    assert.equal(reads, 1, "the edited mesh's parts were read from the stage");
    // a block version made from the edited mesh asks the edited mesh the same way
    reads = 0;
    lib.forgetPartLabels();
    const stable = modelOf("f3333333-0000-4000-8000-000000000003", { source_model_id: edited.id });
    lib.useWorkspaceStore.setState({ models: [hunyuan, edited, stable] });
    await lib.partLabelsFor(stable);
    assert.equal(reads, 1);
    lib.useAnalysisStore.setState({ loaded: null });
    lib.forgetPartLabels();
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
