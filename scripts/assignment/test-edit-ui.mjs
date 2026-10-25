// Tests for editing by words in the browser (spec 8.1, B2): the edit store's state machine (store/edit.ts) driven through a fake server and the
// REAL mesh editor (no worker: the page-side fallback runs the same session code), and the chat card (components/chat/EditCard.tsx) rendered
// to markup in every state it has.
//
//   node scripts/assignment/test-edit-ui.mjs
//
// One esbuild bundle with real React and react-dom/server, like test-versions-ui.mjs; `zustand` becomes a tiny wrapper whose hooks read the
// current state, the toast library becomes a log, and the autosave and the model list refresh become no-ops. No DOM, no network.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node < 22.18 only strips types behind a flag (the scripts import the editor's TypeScript for their test files); run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-edit-ui-test");
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
export * from "@/assignment/store/edit";
export * from "@/assignment/store/editLogic";
export * from "@/assignment/store/jobs";
export * from "@/assignment/lib/api";
export { EditCard, PendingEditCards } from "@/assignment/components/chat/EditCard";
export { HUNYUAN_CREDITS, REGENERATE_PROMPT_MAX } from "@/assignment/components/chat/RegenerateDialog";
export { MESH_REFINE_OPS } from "@/assignment/shared/contract";
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
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "error",
    plugins: [
        {
            name: "shims",
            setup(b) {
                b.onResolve({ filter: /^zustand$/ }, () => ({ path: "zustand-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                b.onResolve({ filter: /store\/persist$/ }, () => ({ path: "persist-shim", namespace: "shim" }));
                b.onResolve({ filter: /store\/providers$/ }, () => ({ path: "providers-shim", namespace: "shim" }));
                b.onLoad({ filter: /^zustand-shim$/, namespace: "shim" }, () => ({ contents: ZUSTAND_SHIM, loader: "js", resolveDir: root }));
                b.onLoad({ filter: /^toast-shim$/, namespace: "shim" }, () => ({ contents: TOAST_SHIM, loader: "js" }));
                b.onLoad({ filter: /^persist-shim$/, namespace: "shim" }, () => ({
                    contents: "export const saveNow = async () => { globalThis.__saves = (globalThis.__saves ?? 0) + 1; }; export const writeProjectData = async () => {};",
                    loader: "js",
                }));
                b.onLoad({ filter: /^providers-shim$/, namespace: "shim" }, () => ({
                    contents: `
                        export const refreshProviders = async () => {};
                        export const providerInfo = () => undefined;
                        export const providerLabel = (_p, id) => id;
                        export const isCancelable = () => true;
                        export const stageText = (s) => s || "Queued";
                        export const viaLabel = () => null;
                        export const designerNote = () => null;`,
                    loader: "js",
                }));
            },
        },
    ],
});

// ---------- a browser, as far as these modules look ----------

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, String(v)), removeItem: (k) => void storage.delete(k) };
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const { React, renderToStaticMarkup, useWorkspaceStore, useEditStore, setEditDeps, startDesignOrMeshEdit, applyStoredPlan, retrySave, stopEdit, undoEdit, dismissRun, meshEditBusy, downloadLocalResult } = lib;
const { cardStateOf, stageWords, designStageWords, failureOf, familyOf, undoBlockedText, regeneratePrompt, applicablePlan, isPlanReady, verdictWorse, savedLine, megabytes, offersRegenerate, generationProviderFor, errorTitle, splitTechnical, offersTryAgain, restoreEditWords, EDIT_START_LINES } = lib;
const { applyJob, ApiRequestError, EditCard, PendingEditCards, HUNYUAN_CREDITS, toasts, MESH_REFINE_OPS } = lib;
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
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`);
    }
}
const section = (title) => console.log(`\n== ${title}`);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 4000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await tick(5);
    }
}

// ---------- data ----------

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const model = (over = {}) => ({
    id: uid(1), project_id: P1, job_id: uid(900), provider: "hunyuan", prompt: "a wooden rocking chair", glb_url: "/api/assignment_alex/files/models/x.glb", thumbnail_url: null,
    size_bytes: 27_000_000, part_count: 1, created_at: "2026-10-25T10:00:00.000Z", analysis: null, kind: "generated", source_model_id: null, example_slug: null, derived: null, edit: null, optimization: null, ...over,
});
const editMeta = (over = {}) => ({
    version: 1, target: "mesh", depth: 1, label: "Make it taller", summary: "Made the backrest taller.", entries: [{ n: 1, instruction: "make the backrest taller", summary: "Made the backrest taller.", added: 0, removed: 0, moved: 1 }],
    engine: "meta/muse-spark-1.3-contributor", changes: null, ops: [{ op: "stretch", label: "backrest" }], notes: [], stabilized_depth: 0, base_steps: 0, job_id: uid(500), created_at: "2026-10-25T10:01:00.000Z", ...over,
});
const job = (over = {}) => ({
    id: uid(500), project_id: P1, provider: "muse", prompt: "make the backrest taller", status: "queued", progress: 0, stage: "Queued", error: null, created_at: "2026-10-25T10:00:30.000Z", updated_at: "2026-10-25T10:00:30.000Z", finished_at: null,
    model: null, kind: "edit", edit: { source_model_id: uid(1), target: "mesh", result: null }, ...over,
});
const meshPlan = (over = {}) => ({
    target: "mesh", applied: true, summary: "Made the box taller and added two parts.", notes: ["scaled to fit"], regen_prompt: "a taller wooden rocking chair",
    program: { summary: "s", applied: true, ops: [
        { op: "stretch", label: "top", boxes: [{ min: [-400, -400, 300], max: [400, 400, 1100] }], exclude: [], feather_mm: 20, axis: "z", from_mm: 500, to_mm: 900, amount_mm: 100 },
        { op: "add_parts", label: "knobs", boxes: [], exclude: [], feather_mm: 20, axis: "z", parts: [{ name: "knob", shape: "sphere", size: [80, 80, 40], position: [0, 0, 1010], rotation: [0, 0, 0], color: "#336699" }] },
    ] }, ...over,
});

const { plainBoxGlb } = await import("./edit-test-support.mjs"); // a small plain model file: the model being edited
const sourceGlb = await plainBoxGlb();

/** Resets the stores and the fakes. `calls` records what the store asked of the server. */
function setup({ models = [model()], active = uid(1), project = P1, deps = {} } = {}) {
    useEditStore.setState({ runs: {}, undone: {} });
    toasts.length = 0;
    useWorkspaceStore.getState().startNewChat();
    useWorkspaceStore.setState({ activeProjectId: project, models, activeModelId: active, jobs: {}, messages: [], project: null });
    const calls = { start: [], upload: [], cancel: [], remove: [], fetch: [], access: 0 };
    let n = 500;
    const fake = {
        startEdit: async (sourceId, body) => {
            calls.start.push({ sourceId, body });
            return job({ id: uid(n++), prompt: body.instruction, edit: { source_model_id: sourceId, target: body.target, result: null } });
        },
        uploadEditedMesh: async (sourceId, jobId, glb) => {
            calls.upload.push({ sourceId, jobId, bytes: glb.byteLength });
            return model({ id: uid(700 + calls.upload.length), kind: "edited", provider: "hunyuan", source_model_id: sourceId, job_id: jobId, size_bytes: glb.byteLength, edit: editMeta({ job_id: jobId }) });
        },
        fetchModelBytes: async (url) => { calls.fetch.push(url); return sourceGlb.buffer.slice(sourceGlb.byteOffset, sourceGlb.byteOffset + sourceGlb.byteLength); },
        cancelJob: async (id) => { calls.cancel.push(id); return { ...useWorkspaceStore.getState().jobs[id], status: "canceled", updated_at: "2026-10-25T11:00:00.000Z", finished_at: "2026-10-25T11:00:00.000Z" }; },
        deleteModel: async (id) => { calls.remove.push(id); },
        getJob: async (id) => useWorkspaceStore.getState().jobs[id],
        requestAccessCode: async () => { calls.access++; return true; },
        pictureFormat: () => "png",
        ...deps,
    };
    setEditDeps(fake);
    return calls;
}
const state = () => useWorkspaceStore.getState();
const runs = () => Object.values(useEditStore.getState().runs);
const finish = (j, result, extra = {}) => ({ ...j, status: "succeeded", progress: 100, updated_at: new Date(Date.parse(j.updated_at) + 5000).toISOString(), finished_at: new Date().toISOString(), edit: { ...j.edit, result }, ...extra });

// ============================================================ logic
section("the rules (editLogic)");

await test("stage words, a design job's stage, sizes", async () => {
    assert.equal(stageWords("describing"), "Looking at the model");
    assert.equal(stageWords("planning"), "Planning the edit");
    assert.equal(stageWords("applying", { step: { index: 2, total: 3, label: "x" } }), "Applying the edit (2 of 3)");
    assert.equal(stageWords("applying", { step: { index: 1, total: 1, label: "x" } }), "Applying the edit");
    assert.equal(stageWords("applying", { stage: "texture" }), "Repainting");
    assert.equal(stageWords("saving", { bytes: 15.2 * 1024 * 1024 }), "Saving 15 MB");
    assert.equal(megabytes(27.8 * 1024 * 1024), "28 MB");
    assert.equal(megabytes(2.34 * 1024 * 1024), "2.3 MB");
    assert.equal(designStageWords({ stage: "Queued", progress: 0 }), "Designing the change");
    assert.equal(designStageWords({ stage: "Building the 3D model…", progress: 70 }), "Building the 3D model");
    assert.equal(designStageWords({ stage: "", progress: 80 }), "Building the 3D model");
});

await test("failures read in plain words and say what to offer next", async () => {
    const { MeshEditError } = lib;
    assert.deepEqual(failureOf(new (Object.getPrototypeOf(ApiRequestError.prototype).constructor)("x"), "apply").kind, "apply");
    const f = (code) => failureOf(Object.assign(new Error("m"), { name: "MeshEditError", code }), "apply");
    void f;
    assert.equal(failureOf(new ApiRequestError(429, "Daily limit"), "start").message, "Daily limit");
    assert.match(failureOf(new ApiRequestError(401, "no"), "start").message, /access code/);
    assert.equal(failureOf("weird", "save").kind, "save");
    assert.ok(offersRegenerate("notfound") && offersRegenerate("unsupported") && offersRegenerate("apply") && !offersRegenerate("save") && !offersRegenerate("plan"));
    assert.equal(typeof MeshEditError, "undefined", "the bundle does not export it, the editor's own tests cover the codes");
});

await test("the family of a version, the generate-again prompt, the plan a job carries", async () => {
    const ms = [model({ id: "a" }), model({ id: "b", source_model_id: "a" }), model({ id: "c", source_model_id: "b" }), model({ id: "d", source_model_id: "a" }), model({ id: "z" })];
    assert.deepEqual(familyOf(ms, "b"), ["b", "c"]);
    assert.deepEqual(familyOf(ms, "a").sort(), ["a", "b", "c", "d"]);
    assert.equal(regeneratePrompt({ prompt: "a chair" }, "make it red", { regen_prompt: "a red chair" }), "a red chair");
    assert.equal(regeneratePrompt({ prompt: "a chair" }, "make it red", null), "a chair, make it red");
    assert.equal(regeneratePrompt({ prompt: "" }, "make it red", {}), "make it red");
    assert.ok(regeneratePrompt({ prompt: "x".repeat(2000) }, "make it red", null).length <= 1000);
    assert.ok(regeneratePrompt({ prompt: "x".repeat(2000) }, "make it red", null).endsWith("make it red"));
    const done = job({ status: "succeeded", edit: { source_model_id: uid(1), target: "mesh", result: meshPlan() } });
    assert.ok(applicablePlan(done) && isPlanReady(done));
    assert.equal(isPlanReady({ ...done, model: model() }), false);
    assert.equal(applicablePlan({ ...done, edit: { ...done.edit, result: meshPlan({ applied: false }) } }), null);
    assert.equal(applicablePlan({ ...done, status: "running" }), null);
    assert.equal(applicablePlan({ ...done, edit: { ...done.edit, target: "design" } }), null);
    assert.equal(generationProviderFor({ provider: "muse" }), "muse");
    assert.equal(generationProviderFor({ provider: "hunyuan" }), "hunyuan");
    assert.equal(savedLine("Made it taller"), "Made it taller.");
    assert.equal(savedLine(""), "Edited the model.");
    assert.ok(verdictWorse({ analysis: { errors: 0 } }, { analysis: { errors: 2 } }));
    assert.ok(!verdictWorse({ analysis: { errors: 2 } }, { analysis: { errors: 2 } }) && !verdictWorse(undefined, { analysis: { errors: 2 } }) && !verdictWorse({ analysis: { errors: 0 } }, { analysis: null }));
});

// ============================================================ the store
section("a design edit");

await test("a design edit: the person's words, the assistant's reply, the job; the job's end puts the new version on screen", async () => {
    const calls = setup({ models: [model({ provider: "muse", glb_url: "/g.glb" })] });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "  make the backrest   taller " });
    assert.deepEqual(calls.start.map((c) => [c.sourceId, c.body]), [[uid(1), { instruction: "make the backrest taller", target: "design" }]]);
    const msgs = state().messages;
    assert.equal(msgs.length, 2);
    assert.deepEqual([msgs[0].role, msgs[0].content], ["user", "make the backrest taller"]);
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[1].content, "Editing with **Muse Spark**.");
    assert.deepEqual(msgs[1].job_ids, [uid(500)]);
    assert.equal(state().jobs[uid(500)].status, "queued", "the job is in the store (the job polling picks it up)");
    assert.equal(useEditStore.getState().runs[uid(500)], undefined, "a design edit has no local run: its card follows the job");
    assert.ok((globalThis.__saves ?? 0) > 0, "the chat was saved with the reply that ties it to the job");
    // the server finishes it: the existing job handling adds the model and shows it
    const edited = model({ id: uid(2), kind: "edited", provider: "muse", source_model_id: uid(1), edit: editMeta({ target: "design", changes: { added: ["cup"], changed: ["back"], removed: [] } }) });
    applyJob({ ...state().jobs[uid(500)], status: "succeeded", progress: 100, updated_at: "2026-10-25T10:02:00.000Z", model: edited });
    assert.equal(state().activeModelId, uid(2));
    assert.ok(state().models.some((m) => m.id === uid(2)));
});

await test("a design edit that cannot start says why where the card would be, and a refused code is asked for once", async () => {
    let tries = 0;
    const calls = setup({ deps: { startEdit: async (id, body) => { tries++; if (tries === 1) throw new ApiRequestError(401, "Access code required"); return job({ id: uid(501), edit: { source_model_id: id, target: body.target, result: null } }); } } });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "add a shelf" });
    assert.equal(calls.access, 1);
    assert.equal(tries, 2);
    assert.deepEqual(state().messages[1].job_ids, [uid(501)]);

    const calls2 = setup({ deps: { startEdit: async () => { throw new ApiRequestError(409, "Another edit is already running in this project."); } } });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "add a shelf" });
    assert.equal(state().messages.length, 2);
    assert.match(state().messages[1].content, /I couldn't start that edit: Another edit is already running/);
    assert.equal(state().messages[1].job_ids, undefined);
    assert.ok(toasts.some((t) => t.kind === "error"));
    void calls2;

    const calls3 = setup({ deps: { startEdit: async () => { throw new ApiRequestError(429, "Today's limit of AI edits is used up."); } } });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "add a shelf" });
    assert.ok(toasts.some((t) => t.kind === "warning" && t.title === "Daily limit reached"));
    void calls3;
});

await test("nothing happens for an empty or too long instruction, a model that is not here, or another project", async () => {
    const calls = setup();
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "   " });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "x".repeat(501) });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(99), target: "design", instruction: "ok" });
    await startDesignOrMeshEdit({ projectId: P2, modelId: uid(1), target: "design", instruction: "ok" });
    assert.equal(calls.start.length, 0);
    assert.equal(state().messages.length, 0);
});

section("a mesh edit");

/** Starts a mesh edit and waits until the job exists and the store is planning. */
async function startMesh(calls, instruction = "make it taller and add a knob") {
    const p = startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction });
    await until(() => runs().some((r) => r.status === "planning"), "the plan to be asked for");
    await p;
    return runs()[0];
}

await test("describing, planning, applying, saving: the whole run on the real editor ends with the new version on screen", async () => {
    const calls = setup();
    const p = startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction: "make it taller and add a knob" });
    await until(() => runs().length === 1, "the run to appear");
    assert.equal(runs()[0].status, "describing");
    assert.equal(state().messages.length, 2);
    assert.equal(state().messages[1].content, "Looking at the model to plan the edit.");
    assert.equal(state().messages[1].job_ids, undefined, "no job yet");
    assert.match(render(h(PendingEditCards, { projectId: P1 })), /Looking at the model/);
    await p;
    // the plan was asked for with the pictures
    assert.equal(calls.start.length, 1);
    const { sourceId, body } = calls.start[0];
    assert.equal(sourceId, uid(1));
    assert.equal(body.target, "mesh");
    assert.equal(body.instruction, "make it taller and add a knob");
    assert.deepEqual(body.mesh.views.map((v) => v.id), ["FRONT", "SIDE", "TOP"]);
    assert.ok(body.mesh.views.every((v) => /^data:image\/png;base64,/.test(v.image)));
    assert.equal(body.mesh.original_prompt, "a wooden rocking chair");
    assert.match(body.mesh.facts, /^Model facts: size X /);
    assert.ok(JSON.stringify(body).length < 400 * 1024);
    // the card follows the job now
    const run = runs()[0];
    assert.equal(run.key, uid(500));
    assert.equal(run.jobId, uid(500));
    assert.equal(run.status, "planning");
    assert.deepEqual(state().messages[1].job_ids, [uid(500)]);
    assert.equal(state().messages[1].content, "Editing with **Muse Spark**.");
    assert.equal(render(h(PendingEditCards, { projectId: P1 })), "", "the pending card is gone once there is a job");
    // the plan is done on the server: the store runs it, saves it and shows it
    applyJob(finish(state().jobs[uid(500)], meshPlan()));
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "saved", "the run to be saved");
    assert.equal(calls.upload.length, 1);
    assert.deepEqual([calls.upload[0].sourceId, calls.upload[0].jobId], [uid(1), uid(500)]);
    assert.ok(calls.upload[0].bytes > 5_000, `${calls.upload[0].bytes} bytes`);
    const saved = state().models.find((m) => m.kind === "edited");
    assert.ok(saved, "the edited model is in the project");
    assert.equal(state().activeModelId, saved.id);
    assert.ok(state().messages.some((m) => m.model_ids?.includes(saved.id) && /Made the backrest taller/.test(m.content)), "a reply that points at the model");
    assert.ok(toasts.some((t) => t.kind === "success" && t.title === "Edited"));
    const done = useEditStore.getState().runs[uid(500)];
    assert.equal(done.savedModelId, saved.id);
    assert.deepEqual(done.notes.includes("scaled to fit"), true);
    assert.equal(done.hasLocalResult, false);
    assert.equal(meshEditBusy(P1), false);
});

await test("the picture package stays under the server's limit: the next format is tried when one is too big", async () => {
    let sizes = [];
    const fakeHandle = (big) => ({
        info: {}, inWorker: false, dispose() {},
        describe: async (format, _signal, size) => { sizes.push([format, size]); return { version: 1, frame: { size_mm: [1, 1, 1], facing: "-Y" }, facts: "f", pieces: null, extras: null, original_prompt: null, views: [{ id: "FRONT", caption: "c", image: "x".repeat(big(format, size)) }] }; },
    });
    const calls = setup({ deps: { openMeshEdit: async () => fakeHandle((format, size) => (format === "png" ? 500_000 : size === 384 ? 1000 : 300_000)) } });
    await startMesh(calls);
    assert.deepEqual(sizes, [["png", undefined], ["jpeg", undefined]]);
    assert.equal(calls.start[0].body.mesh.views[0].image.length, 300_000);
    sizes = [];
    const calls2 = setup({ deps: { pictureFormat: () => "jpeg", openMeshEdit: async () => fakeHandle((format, size) => (size === 384 ? 1000 : 500_000)) } });
    await startMesh(calls2);
    assert.deepEqual(sizes, [["jpeg", undefined], ["png", undefined], ["jpeg", 384]]);
    assert.equal(calls2.start[0].body.mesh.views[0].image.length, 1000);
});

await test("the second pass (off by default, MESH_REFINE_OPS empty): a delete is sent back with zoomed pictures and the run follows the new job", async () => {
    // off: a delete plan runs at once (the test above for "an op that finds nothing" relies on it)
    assert.equal(MESH_REFINE_OPS.length, 0);
    MESH_REFINE_OPS.push("delete");
    try {
        const calls = setup();
        const run = await startMesh(calls, "remove the knob");
        const deletePlan = meshPlan({ program: { summary: "s", applied: true, ops: [{ op: "delete", label: "top", boxes: [{ min: [-400, -400, 900], max: [400, 400, 1100] }], exclude: [], feather_mm: 3, axis: "z" }] } });
        applyJob(finish(state().jobs[run.key], deletePlan));
        await until(() => calls.start.length === 2, "the second plan to be asked for");
        const refine = calls.start[1].body.refine;
        assert.equal(refine.of_job_id, uid(500));
        assert.equal(refine.views.length, 3);
        assert.ok(refine.views.every((v) => /^data:image\/(png|jpeg);base64,/.test(v.image)) && /zoom/.test(refine.views[0].caption));
        assert.equal(refine.program.ops[0].op, "delete");
        assert.equal(calls.start[1].body.mesh, undefined, "the second request carries the views, not the whole package again");
        await until(() => useEditStore.getState().runs[uid(501)]?.status === "planning", "the run to follow the second job");
        assert.equal(useEditStore.getState().runs[uid(500)], undefined);
        assert.deepEqual(state().messages[1].job_ids, [uid(501)], "the reply follows the newest job");
        assert.equal(useEditStore.getState().runs[uid(501)].refined, true);
        // the corrected plan: applied, once, and the upload carries the second job's id
        applyJob(finish(state().jobs[uid(501)], deletePlan));
        await until(() => useEditStore.getState().runs[uid(501)]?.status === "saved", "saved");
        assert.deepEqual([calls.upload.length, calls.upload[0].jobId], [1, uid(501)]);
        assert.equal(calls.start.length, 2, "never a third plan");
    } finally {
        MESH_REFINE_OPS.length = 0;
    }
});

await test("the model says it cannot be done: nothing is run or saved, the explanation and the prompt to generate it again are kept", async () => {
    const calls = setup();
    const run = await startMesh(calls, "paint it like a photo of my cat");
    applyJob(finish(state().jobs[run.key], { target: "mesh", applied: false, summary: "A photo cannot be made with these tools.", notes: [], regen_prompt: "a chair painted like a cat" }));
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "noop", "noop");
    const r = useEditStore.getState().runs[uid(500)];
    assert.equal(r.summary, "A photo cannot be made with these tools.");
    assert.equal(r.regenPrompt, "a chair painted like a cat");
    assert.equal(calls.upload.length, 0);
    assert.equal(state().models.length, 1);
    const html = render(h(EditCard, { job: state().jobs[uid(500)] }));
    assert.match(html, /data-state="noop"/);
    assert.match(html, /A photo cannot be made with these tools/);
    assert.match(html, /Generate it as a new model/);
});

await test("an op that finds nothing ends the run with the part's name, and offers to generate the model again", async () => {
    const calls = setup();
    const run = await startMesh(calls, "remove the spoiler");
    applyJob(finish(state().jobs[run.key], meshPlan({ program: { summary: "s", applied: true, ops: [{ op: "delete", label: "spoiler", boxes: [{ min: [4000, 4000, 4000], max: [4100, 4100, 4100] }], exclude: [], feather_mm: 1, axis: "z" }] } })));
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "error", "the run to fail");
    const r = useEditStore.getState().runs[uid(500)];
    assert.equal(r.errorKind, "notfound");
    assert.equal(r.error, "I couldn't find the spoiler on this model.");
    assert.equal(calls.upload.length, 0);
    assert.equal(meshEditBusy(P1), false, "a failed run does not block the next one");
    const html = render(h(EditCard, { job: state().jobs[uid(500)] }));
    assert.match(html, /data-kind="notfound"/);
    assert.match(html, /I couldn&#x27;t find the spoiler on this model/);
    assert.match(html, /Generate it again with Hunyuan \(25 credits\)/);
});

await test("a plan that failed, or was stopped, ends the run; a file that cannot be edited says so before any plan is asked for", async () => {
    const calls = setup();
    const run = await startMesh(calls);
    applyJob({ ...state().jobs[run.key], status: "failed", error: "The model was cut off.", updated_at: "2026-10-25T10:05:00.000Z", finished_at: "x" });
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "error", "failure");
    assert.deepEqual([useEditStore.getState().runs[uid(500)].errorKind, useEditStore.getState().runs[uid(500)].error], ["plan", "The model was cut off."]);

    const calls2 = setup({ deps: { fetchModelBytes: async () => new Uint8Array(500).buffer } });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction: "make it taller" });
    const r = runs()[0];
    assert.deepEqual([r.status, r.errorKind], ["error", "unsupported"]);
    assert.match(r.error, /can't be edited here/);
    assert.equal(calls2.start.length, 0, "no plan is paid for");
    assert.match(state().messages[1].content, /can't be edited here/);
    assert.ok(!/\(.*\)/.test(state().messages[1].content), "the chat line has no file-format words in brackets");
    // The run has no job to carry a card, so the pending cards show it: the plain sentence, the regenerate offer (spec 3.6), no "try again" (the file is the problem).
    const card = render(h(PendingEditCards, { projectId: P1 }));
    assert.match(card, /data-state="error"/);
    assert.match(card, /data-kind="unsupported"/);
    assert.match(card, /This model can(?:'|&#x27;)t be edited here\./);
    assert.match(card, /Generate it again with Hunyuan \(25 credits\)/);
    assert.ok(!/data-testid="edit-try-again"/.test(card));
    assert.equal(render(h(PendingEditCards, { projectId: P2 })), "");
});

await test("a failed upload keeps the result: Try saving again goes through, Download is offered meanwhile", async () => {
    let fail = true;
    const calls = setup({ deps: { uploadEditedMesh: async (sourceId, jobId, glb) => { if (fail) throw new ApiRequestError(0, "Could not reach the server."); return model({ id: uid(701), kind: "edited", source_model_id: sourceId, job_id: jobId, size_bytes: glb.byteLength, edit: editMeta() }); } } });
    const run = await startMesh(calls);
    applyJob(finish(state().jobs[run.key], meshPlan()));
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "error", "the save to fail");
    const r = useEditStore.getState().runs[uid(500)];
    assert.deepEqual([r.errorKind, r.error, r.hasLocalResult], ["save", "Could not reach the server.", true]);
    assert.equal(state().models.length, 1, "nothing was added");
    const html = render(h(EditCard, { job: state().jobs[uid(500)] }));
    assert.match(html, /Try saving again/);
    assert.match(html, /Download GLB/);
    assert.ok(toasts.some((t) => t.kind === "error" && /save/i.test(t.title)));
    // Download: the local file becomes a link click
    const clicked = [];
    globalThis.URL.createObjectURL = () => "blob:x";
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.document = { ...globalThis.document, body: { appendChild() {} }, createElement: () => ({ click() { clicked.push(this.download); }, remove() {} }) };
    assert.equal(downloadLocalResult(uid(500), "chair.glb"), true);
    assert.deepEqual(clicked, ["chair.glb"]);
    assert.equal(downloadLocalResult(uid(999)), false);
    fail = false;
    await retrySave(uid(500));
    assert.equal(useEditStore.getState().runs[uid(500)].status, "saved");
    assert.equal(useEditStore.getState().runs[uid(500)].hasLocalResult, false);
    assert.equal(state().activeModelId, uid(701));
    await retrySave(uid(500)); // nothing to retry any more
    assert.equal(state().models.length, 2);
});

await test("Stop: while the plan is being made the job is cancelled; while the file is being read the run just ends", async () => {
    const calls = setup();
    const run = await startMesh(calls);
    await stopEdit(run.key);
    assert.deepEqual(calls.cancel, [uid(500)]);
    assert.equal(useEditStore.getState().runs[uid(500)], undefined, "the run goes: the card follows the canceled job, not an error with a try-again");
    assert.equal(state().jobs[uid(500)].status, "canceled");
    const stopped = render(h(EditCard, { job: state().jobs[uid(500)] }));
    assert.match(stopped, /data-state="canceled"/);
    assert.match(stopped, /Stopped\./);
    assert.ok(!/edit-try-again|edit-error/.test(stopped));

    // stopped while the model file is still loading
    let release;
    const calls2 = setup({ deps: { fetchModelBytes: (url, signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) } });
    const p = startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction: "make it taller" });
    await until(() => runs().length === 1, "the run");
    await stopEdit(runs()[0].key);
    await p;
    assert.equal(runs().length, 0, "a run that never had a job leaves nothing");
    assert.equal(calls2.start.length, 0);
    assert.equal(state().messages[1].content, "Stopped.");
    assert.equal(state().draft, "make it taller", "a Stop is not a never-mind: the words are back in the box");
    state().restoreDraft("");
    void release;

    // a design job is stopped on the server too
    const calls3 = setup();
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "x" });
    await stopEdit(uid(500));
    assert.deepEqual(calls3.cancel, [uid(500)]);
});

await test("only one mesh edit of a project at a time; leaving the project ends the local work but not an upload", async () => {
    const calls = setup();
    await startMesh(calls);
    assert.equal(meshEditBusy(P1), true);
    const before = state().messages.length;
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction: "and a second one" });
    assert.equal(state().messages.length, before, "no new message");
    assert.ok(toasts.some((t) => t.title === "Another edit is still running"));
    // leave: the run is dropped (the plan stays on the job)
    useWorkspaceStore.setState({ activeProjectId: P2 });
    assert.equal(runs().length, 0);
    assert.equal(meshEditBusy(P1), false);

    // an upload under way finishes and is not shown in the other project
    let finishUpload;
    const calls2 = setup({ deps: { uploadEditedMesh: (s, j, glb) => new Promise((resolve) => { finishUpload = () => resolve(model({ id: uid(702), kind: "edited", source_model_id: s, job_id: j, size_bytes: glb.byteLength, edit: editMeta() })); }) } });
    const run = await startMesh(calls2);
    applyJob(finish(state().jobs[run.key], meshPlan()));
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "saving", "saving");
    useWorkspaceStore.setState({ activeProjectId: P2, models: [] });
    assert.equal(useEditStore.getState().runs[uid(500)].status, "saving", "the upload is not interrupted");
    finishUpload();
    await until(() => useEditStore.getState().runs[uid(500)]?.status === "saved", "saved");
    assert.deepEqual(state().models, [], "...and the model is not put into the project that is open now");
    assert.ok(toasts.some((t) => t.title === "Saved an edited model"));
});

await test("Plan ready: a mesh plan that was never run is applied from the stored plan", async () => {
    const calls = setup();
    const planned = finish(job({ id: uid(510), prompt: "make it taller and add a knob" }), meshPlan());
    useWorkspaceStore.setState({ jobs: { [planned.id]: planned } });
    assert.match(render(h(EditCard, { job: planned })), /data-state="plan-ready"/);
    assert.match(render(h(EditCard, { job: planned })), /Apply it/);
    await applyStoredPlan(planned.id);
    await until(() => useEditStore.getState().runs[planned.id]?.status === "saved", "saved");
    assert.deepEqual(calls.fetch, ["/api/assignment_alex/files/models/x.glb"]);
    assert.equal(calls.start.length, 0, "no new plan is asked for");
    assert.equal(calls.upload[0].jobId, planned.id);
    assert.equal(state().activeModelId, uid(701));
    // a plan whose model is gone cannot be applied
    const calls2 = setup({ models: [] });
    useWorkspaceStore.setState({ jobs: { [planned.id]: planned } });
    await applyStoredPlan(planned.id);
    assert.equal(runs().length, 0);
    assert.ok(toasts.some((t) => /no longer be applied/.test(t.title)));
    assert.equal(calls2.fetch.length, 0);
});

await test("Undo removes the version, goes back to the source, and says Undone (or Version deleted)", async () => {
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta() });
    const calls = setup({ models: [model(), edited], active: uid(2) });
    assert.equal(await undoEdit(edited), "undone");
    assert.deepEqual(calls.remove, [uid(2)]);
    assert.deepEqual(state().models.map((m) => m.id), [uid(1)]);
    assert.equal(state().activeModelId, uid(1), "back on the model it was made from");
    assert.deepEqual(useEditStore.getState().undone, { [uid(2)]: true });
    assert.ok(toasts.some((t) => t.title === "Undone"));
    // already gone on the server
    const calls2 = setup({ models: [model(), edited], active: uid(2), deps: { deleteModel: async () => { throw new ApiRequestError(404, "Model not found"); } } });
    assert.equal(await undoEdit(edited), "gone");
    assert.deepEqual(state().models.map((m) => m.id), [uid(1)]);
    assert.ok(toasts.some((t) => t.title === "Version deleted"));
    // a failure keeps everything
    setup({ models: [model(), edited], active: uid(2), deps: { deleteModel: async () => { throw new ApiRequestError(500, "boom"); } } });
    assert.equal(await undoEdit(edited), "failed");
    assert.equal(state().models.length, 2);
    void calls2;
});

// Review finding F3: a card's Undo stays for as long as the version exists; deleting it also deletes the versions made from it (the server removes the
// whole subtree), so a stabilized or optimized version made from the edit must not vanish behind one click and a toast that says "Undone".
await test("Undo is refused for a version that others were made from: nothing is deleted, the person is told where to remove it", async () => {
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta() });
    const child = model({ id: uid(3), kind: "stabilized", provider: "stabilizer", source_model_id: uid(2) });
    const grandchild = model({ id: uid(4), kind: "optimized", provider: "optimizer", source_model_id: uid(3) });
    const calls = setup({ models: [model(), edited, child, grandchild], active: uid(3) });
    assert.equal(await undoEdit(edited), "blocked");
    assert.deepEqual(calls.remove, [], "nothing was asked of the server");
    assert.deepEqual(state().models.map((m) => m.id), [uid(1), uid(2), uid(3), uid(4)]);
    assert.equal(state().activeModelId, uid(3), "the stage did not move");
    assert.deepEqual(useEditStore.getState().undone, {});
    assert.ok(toasts.some((t) => /Other versions were made from this one/.test(t.title) && /Models tab/.test(t.options?.description ?? "")));
    // once the later versions are gone it can be undone again
    useWorkspaceStore.setState({ models: [model(), edited] });
    assert.equal(await undoEdit(edited), "undone");
    assert.deepEqual(calls.remove, [uid(2)]);
    assert.equal(undoBlockedText(1), "Another version was made from this one, so Undo is off. To remove it, delete it in the Models tab, which removes that version too.");
    assert.match(undoBlockedText(3), /^3 other versions were made from this one/);
});

// ============================================================ the card
section("the card in every state");

const html = (j, extra = {}) => render(h(EditCard, { job: j, ...extra }));
const stateOf = (markup) => /data-state="([a-z-]+)"/.exec(markup)?.[1];

await test("working: the stage in words, the time, Stop (a design job, a mesh plan on the server, a run on this page)", async () => {
    setup({ models: [model({ provider: "muse" })] });
    const design = job({ status: "running", progress: 70, stage: "Building the 3D model…", edit: { source_model_id: uid(1), target: "design", result: null } });
    let m = html(design);
    assert.equal(stateOf(m), "working");
    assert.match(m, /Building the 3D model/);
    assert.match(m, /data-testid="edit-stop"/);
    assert.match(m, /Changes the parts/);
    assert.match(m, /“make the backrest taller”/);
    const mesh = job({ status: "running" });
    m = html(mesh);
    assert.match(m, /Planning the edit/);
    assert.match(m, /Adjusts the model/);
    // a run on this page overrides the job: Applying the edit (2 of 3)
    useEditStore.setState({ runs: { [mesh.id]: { key: mesh.id, jobId: mesh.id, projectId: P1, sourceModelId: uid(1), instruction: "make it bigger", target: "mesh", status: "applying", startedAt: Date.now(), step: { index: 2, total: 3, label: "x" }, stage: null, summary: null, notes: [], errorKind: null, error: null, savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false } } });
    m = html(mesh);
    assert.match(m, /Applying the edit \(2 of 3\)/);
    assert.match(m, /“make it bigger”/);
    useEditStore.setState({ runs: { [mesh.id]: { ...useEditStore.getState().runs[mesh.id], status: "saving", resultBytes: 15.2 * 1024 * 1024 } } });
    m = html(mesh);
    assert.match(m, /Saving 15 MB/);
    assert.ok(!/edit-stop/.test(m), "no Stop while the file is being saved");
});

await test("done (design): what changed by part name, the verdict line, Undo, Compare, Download; no Hunyuan offer", async () => {
    const source = model({ provider: "muse", prompt: "a chair" });
    const edited = model({ id: uid(2), provider: "muse", kind: "edited", source_model_id: uid(1), part_count: 22, size_bytes: 12000, edit: editMeta({ target: "design", summary: "Made the back taller and added a cup holder.", changes: { added: ["cup holder", "cup ring"], changed: ["back"], removed: ["left arm"] }, notes: ["scaled to 98% to fit the 1000 mm cube"], ops: null }) });
    setup({ models: [source, edited], active: uid(1) });
    const j = job({ status: "succeeded", model: edited, edit: { source_model_id: uid(1), target: "design", result: null } });
    const m = html(j);
    assert.equal(stateOf(m), "done");
    assert.match(m, /Made the back taller and added a cup holder/);
    assert.match(m, /Added:<\/span> cup holder, cup ring/);
    assert.match(m, /Changed:<\/span> back/);
    assert.match(m, /Removed:<\/span> left arm/);
    assert.match(m, /scaled to 98% to fit the 1000 mm cube/);
    for (const id of ["edit-undo", "edit-compare", "verdict-line"]) assert.match(m, new RegExp(`data-testid="${id}"`), id);
    assert.match(m, /Show the edit/);
    assert.match(m, /Download GLB/);
    assert.ok(!/edit-regenerate/.test(m), "a parts model is edited by its parts: no Hunyuan offer");
    // when the edit is on screen the button says how to go back
    useWorkspaceStore.setState({ activeModelId: uid(2) });
    assert.match(html(j), /Show the version before/);
});

await test("done (mesh): the Hunyuan offer says what it costs; a worse verdict offers Stabilize", async () => {
    const source = model({ analysis: { errors: 0 } });
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta(), analysis: { version: 1, blocks: 100, errors: 3, warnings: 0, floating_blocks: 3, over_limit: 0, longest_cantilever: 2, cog_margin_mm: 40, stress: null } });
    setup({ models: [source, edited], active: uid(2) });
    const j = job({ status: "succeeded", model: edited, edit: { source_model_id: uid(1), target: "mesh", result: meshPlan() } });
    const m = html(j);
    assert.equal(stateOf(m), "done");
    assert.match(m, /Generate it again with Hunyuan \(25 credits\)/);
    assert.equal(HUNYUAN_CREDITS, 25);
    assert.match(m, /data-testid="edit-stabilize"/);
    useWorkspaceStore.setState({ models: [{ ...source, analysis: { errors: 3 } }, edited] });
    assert.ok(!/edit-stabilize/.test(html(j)), "the verdict did not get worse");
});

await test("done: Undo is switched off, with the reason in words, once a version was made from the edit (and on again when it is gone)", async () => {
    const source = model();
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta() });
    const stable = model({ id: uid(3), kind: "stabilized", provider: "stabilizer", source_model_id: uid(2) });
    setup({ models: [source, edited, stable], active: uid(2) });
    const j = job({ status: "succeeded", model: edited, edit: { source_model_id: uid(1), target: "mesh", result: meshPlan() } });
    let m = html(j);
    assert.equal(stateOf(m), "done");
    const undoButton = /<button[^>]*data-testid="edit-undo"[^>]*>/.exec(m)?.[0] ?? "";
    assert.ok(undoButton !== "", "the button is still there");
    assert.match(undoButton, /disabled=""/);
    assert.match(m, /data-testid="edit-undo-off"[^>]*>Another version was made from this one, so Undo is off/);
    // two later versions: the count is in the words
    useWorkspaceStore.setState({ models: [source, edited, stable, model({ id: uid(4), kind: "optimized", provider: "optimizer", source_model_id: uid(3) })] });
    assert.match(html(j), /2 other versions were made from this one, so Undo is off/);
    // nothing made from it: Undo works and says nothing more
    useWorkspaceStore.setState({ models: [source, edited] });
    m = html(j);
    assert.ok(!/<button[^>]*data-testid="edit-undo"[^>]*disabled/.test(m), "Undo is enabled");
    assert.ok(!/edit-undo-off/.test(m));
});

await test("undone, gone, canceled, a design edit that changed nothing, a failed job, a finished job with no result", async () => {
    setup({ models: [model()] });
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta() });
    const done = job({ status: "succeeded", model: edited });
    assert.equal(stateOf(html(done)), "gone", "the version is not in the project any more");
    assert.match(html(done), /Version deleted/);
    useEditStore.setState({ undone: { [uid(2)]: true } });
    assert.equal(stateOf(html(done)), "undone");
    assert.match(html(done), /Undone\. The model is back as it was/);
    assert.equal(stateOf(html(job({ status: "canceled" }))), "canceled");
    const noop = job({ status: "succeeded", edit: { source_model_id: uid(1), target: "design", result: { target: "design", applied: false, summary: "That is not about this object.", notes: [] } } });
    assert.equal(stateOf(html(noop)), "noop");
    assert.match(html(noop), /That is not about this object/);
    const failed = html(job({ status: "failed", error: "The model could not be reached." }));
    assert.equal(stateOf(failed), "error");
    assert.match(failed, /Could not plan the edit\.<\/span> The model could not be reached/);
    // The project payload carries the stored result only for a job that has no model; a finished job with neither lost its version (Undo, then a reload).
    assert.equal(stateOf(html(job({ status: "succeeded" }))), "gone");
    assert.equal(stateOf(html(job({ status: "succeeded", edit: null }))), "error");
    const designGone = job({ status: "succeeded", edit: { source_model_id: uid(1), target: "design", result: null } });
    assert.equal(stateOf(html(designGone)), "gone", "an undone design edit does not read as 'nothing was changed' after a reload");
});

await test("a job that failed after it began did not work; a start that never got a job could not start; a failed start or plan offers Try again", async () => {
    assert.equal(errorTitle("start", true), "The edit did not work");
    assert.equal(errorTitle("start", false), "Could not start the edit");
    assert.equal(errorTitle("plan", true), "Could not plan the edit");
    assert.ok(offersTryAgain("start") && offersTryAgain("plan") && !offersTryAgain("unsupported") && !offersTryAgain("apply") && !offersTryAgain("save"));
    setup({ models: [model({ provider: "muse" })] });
    const design = html(job({ status: "failed", error: "The model could not be reached.", edit: { source_model_id: uid(1), target: "design", result: null } }));
    assert.match(design, /The edit did not work\.<\/span> The model could not be reached/);
    assert.ok(!/Could not start the edit/.test(design));
    assert.match(design, /data-testid="edit-try-again"/);
    // a mesh plan that failed too
    assert.match(html(job({ status: "failed", error: "x" })), /data-testid="edit-try-again"/);
});

await test("Try again puts the words back in the box on the version they were meant for (3D tab, Edit chosen, the cursor there)", async () => {
    const source = model();
    const edited = model({ id: uid(2), kind: "edited", source_model_id: uid(1), edit: editMeta() });
    setup({ models: [source, edited], active: uid(2) });
    state().setWorkspaceTab("analysis");
    state().setChatHidden(true);
    state().setComposerChoice("new");
    const focus = state().composerFocusSerial;
    restoreEditWords("make the backrest taller", uid(1));
    const s = state();
    assert.equal(s.activeModelId, uid(1));
    assert.equal(s.workspaceTab, "3d");
    assert.equal(s.chatHidden, false);
    assert.equal(s.composerChoice, "edit");
    assert.equal(s.draft, "make the backrest taller");
    assert.equal(s.composerFocusSerial, focus + 1);
    // the version is gone: the words still come back
    setup({ models: [source], active: uid(1) });
    restoreEditWords("again", "00000000-0000-4000-8000-00000000dead");
    assert.equal(state().draft, "again");
    assert.equal(state().composerChoice, "edit");
});

await test("technical words about a file's format sit in a tooltip, not in the sentence", async () => {
    assert.deepEqual(splitTechnical("This model's format can't be edited here (quantised geometry)."), { plain: "This model's format can't be edited here.", detail: "quantised geometry" });
    assert.deepEqual(splitTechnical("This model's format can't be edited here (it uses a feature that cannot be saved after an edit: KHR_x)."), { plain: "This model's format can't be edited here.", detail: "it uses a feature that cannot be saved after an edit: KHR_x" });
    assert.deepEqual(splitTechnical("This model is too detailed to edit here."), { plain: "This model is too detailed to edit here.", detail: null });
    assert.deepEqual(splitTechnical("I couldn't find the spoiler on this model."), { plain: "I couldn't find the spoiler on this model.", detail: null });
    setup();
    useEditStore.setState({ runs: { "pending-1": { key: "pending-1", jobId: null, projectId: P1, sourceModelId: uid(1), instruction: "make it taller", target: "mesh", status: "error", startedAt: Date.now(), step: null, stage: null, summary: null, notes: [], errorKind: "unsupported", error: "This model's format can't be edited here (quantised geometry).", savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false } } });
    const m = render(h(PendingEditCards, { projectId: P1 }));
    assert.ok(!/<p[^>]*>.*quantised geometry.*<\/p>/.test(m.replace(/aria-label="[^"]*"/g, "")), "the sentence does not carry the format word");
    assert.match(m, /data-testid="edit-technical"[^>]*aria-label="Technical detail: quantised geometry"/);
    // a new edit replaces the failed card; the failed one is not left behind
    setup({ deps: {} });
    useEditStore.setState({ runs: { "pending-9": { key: "pending-9", jobId: null, projectId: P1, sourceModelId: uid(1), instruction: "old", target: "mesh", status: "error", startedAt: 0, step: null, stage: null, summary: null, notes: [], errorKind: "unsupported", error: "x", savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false } } });
    await startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "make it taller" });
    assert.equal(useEditStore.getState().runs["pending-9"], undefined);
});

await test("the two lines a change writes before its job exists are the ones the chat reader knows (they cannot drift)", async () => {
    assert.equal(EDIT_START_LINES.mesh, "Looking at the model to plan the edit.");
    assert.equal(EDIT_START_LINES.design, "Starting the edit.");
    // a design edit whose request is still out
    setup({ models: [model({ provider: "muse" })], deps: { startEdit: () => new Promise(() => {}) } });
    void startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "design", instruction: "x" });
    await until(() => state().messages.length === 2, "the reply");
    assert.equal(state().messages[1].content, EDIT_START_LINES.design);
    // a mesh edit whose file is still being read
    setup({ deps: { fetchModelBytes: (url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) } });
    const p = startDesignOrMeshEdit({ projectId: P1, modelId: uid(1), target: "mesh", instruction: "make it taller" });
    await until(() => runs().length === 1, "the run");
    assert.equal(state().messages[1].content, EDIT_START_LINES.mesh);
    await stopEdit(runs()[0].key);
    await p;
});

await test("the words on the card keep to plain language (the product's vocabulary rule)", async () => {
    setup({ models: [model({ provider: "muse" })] });
    const all = [
        html(job({ status: "running" })), html(job({ status: "failed", error: "x" })),
        html(finishedPlan()), html(job({ status: "succeeded", edit: { source_model_id: uid(1), target: "mesh", result: { target: "mesh", applied: false, summary: "No.", notes: [] } } })),
    ].join(" ");
    for (const word of ["voxel", "FEM", "utilisation", "cantilever", "compliance", "objective", "kPa", "coordinates"]) assert.ok(!all.toLowerCase().includes(word.toLowerCase()), word);
    function finishedPlan() { return finish(job({ id: uid(511) }), meshPlan()); }
});

await test("the card for a run that has no job yet (the pictures are being made) is a pending card with Stop", async () => {
    setup();
    useEditStore.setState({ runs: { "pending-1": { key: "pending-1", jobId: null, projectId: P1, sourceModelId: uid(1), instruction: "make it taller", target: "mesh", status: "describing", startedAt: Date.now(), step: null, stage: null, summary: null, notes: [], errorKind: null, error: null, savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false } } });
    const m = render(h(PendingEditCards, { projectId: P1 }));
    assert.match(m, /Looking at the model/);
    assert.match(m, /data-testid="edit-stop"/);
    assert.match(m, /“make it taller”/);
    assert.equal(render(h(PendingEditCards, { projectId: P2 })), "");
    dismissRun("pending-1");
    assert.equal(render(h(PendingEditCards, { projectId: P1 })), "");
    assert.equal(cardStateOf({ job: null, run: undefined, models: [], undone: {} }).kind, "gone");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
