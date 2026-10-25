// The composer's router against the REAL block editor (store/voxelEdit.ts), the real work guard and the real analysis, with a fake AI editor and a
// fake server: what the person is left with when a change to the blocks ends in a proposal, a question, a Stop, a move to another version, or a
// project left; and that changes kept from before a reload survive a new request. (test-versions-ui.mjs has the router against a stand-in editor.)
//
//   node scripts/assignment/test-versions-router.mjs
//
// One esbuild bundle like test-voxel-edit-ui.mjs, whose fixtures it reuses. No DOM, no network, no AI.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-versions-router-test");
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
export const toast = Object.assign(make("message"), { info: make("info"), success: make("success"), warning: make("warning"), error: make("error") });
export const Toaster = () => null;
`;
const ENTRY = `
export * from "@/assignment/store/useWorkspaceStore";
export * from "@/assignment/store/analysis";
export * from "@/assignment/store/workGuard";
export * from "@/assignment/store/voxelEdit";
export * from "@/assignment/store/partLabels";
export * from "@/assignment/store/editRouter";
export { analyzeAssembly } from "@/assignment/analysis/assembly";
export { withStress } from "@/assignment/analysis/withStress";
export { readAssemblyGlb } from "@/assignment/shared/assemblyGlb";
export { toasts } from "@/assignment/components/ui/sonner";
`;

await build({
    stdin: { contents: ENTRY, resolveDir: path.join(root, "src/assignment/components"), sourcefile: "entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
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
                b.onLoad({ filter: /^edit-stub$/, namespace: "shim" }, () => ({ contents: "export async function startDesignOrMeshEdit() {} export const meshEditBusy = () => false;", loader: "js" }));
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
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = mapStorage();
globalThis.sessionStorage = mapStorage();
globalThis.window = { innerWidth: 1440, addEventListener() {}, removeEventListener() {} };

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).slice(0, 900).split("\n").slice(0, 8).join("\n").replace(/^/gm, "       ")}`);
    }
}

// ---------- fixtures (the stabilized pencil-leg chair of test-voxel-edit-ui.mjs) ----------

const EX = path.join(root, "public/assignment_alex/examples");
const FIX = path.join(here, "fixtures/voxel-edit");
const cache = JSON.parse(readFileSync(path.join(FIX, "labels-cache.json"), "utf8"));
const answerOf = (tag) => JSON.parse(JSON.parse(readFileSync(path.join(FIX, "runs", `${tag}.json`), "utf8")).content);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SLUG = "pencil-leg-chair";
const ROOT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const SRC_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const KEPT = "assembly-studio-block-draft";
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

let asked, answers, askGate;
function resetWorld() {
    asked = [];
    answers = [];
    askGate = null;
    lib.setVoxelEditDeps({
        ask: async (body, signal) => {
            asked.push(body);
            if (askGate) await new Promise((resolve, reject) => { askGate.release = resolve; signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); });
            return { answer: answers.shift() ?? answerOf("T10a"), model: "meta/muse-spark-1.3-contributor", cost_usd: 0.0004, prompt_tokens: 2600, completion_tokens: 900, ms: 5000 };
        },
        analyse,
        upload: async () => {
            throw new Error("nothing is saved in these tests");
        },
        labels: async () => labelling(),
        now: () => Date.now(),
    });
}

/** The workspace and the analysis as the Stability tab has them for the stabilized chair, with the AI editor set up. */
async function openChair() {
    lib.resetWorkGuard();
    lib.forgetPartLabels();
    globalThis.sessionStorage.clear();
    lib.useVoxelEditStore.getState().discard();
    lib.useWorkspaceStore.setState({
        activeProjectId: PROJECT, models: [rootModel, sourceModel], activeModelId: SRC_ID, messages: [], workspaceTab: "3d",
        providers: { providers: [], default_provider: null, access_required: false, daily_limit: null, used_today: 0, assist: { available: true, queued: true, images: true, model: "m", daily_limit: 100, used_today: 0 } },
    });
    const result = await analyse(stabilizedDescriptor(), {});
    lib.useAnalysisStore.setState({ result: null, resultModelId: null, preview: null, openRequest: 0, sheetOpen: false, panelOpen: false });
    lib.useAnalysisStore.getState().runSucceeded(SRC_ID, result);
    lib.toasts.length = 0;
    resetWorld();
    return result;
}

const store = () => lib.useVoxelEditStore.getState();
const workspace = () => lib.useWorkspaceStore.getState();
const notes = () => workspace().messages.map((m) => `${m.role}: ${m.content}`);
const WORDS = "move the backrest one block towards the front";

console.log("the router against the real block editor");

await test("a proposal: the words are in the chat, the report is asked for (a phone leaves the chat for it), and the person stays on the same version", async () => {
    await openChair();
    const out = await lib.submitEdit(WORDS);
    assert.deepEqual(out, { ok: true });
    assert.equal(store().status, "proposal");
    const analysis = lib.useAnalysisStore.getState();
    assert.equal(analysis.openRequest, 1, "the page watches this request and shows the canvas");
    assert.equal(analysis.sheetOpen, true, "a phone gets the whole proposal, warnings included");
    assert.equal(workspace().workspaceTab, "analysis");
    assert.equal(workspace().activeModelId, SRC_ID);
    assert.equal(notes()[0], `user: ${WORDS}`);
    assert.ok(notes().some((n) => /proposal is on the Stability tab/.test(n)));
});

await test("a question is an answer in the chat: the report is not forced open, and nothing is handed back", async () => {
    await openChair();
    answers.push({ summary: "", notes: "", clarification: "Which side do you mean?", ops: [] });
    const out = await lib.submitEdit("make it nicer");
    assert.deepEqual(out, { ok: true });
    assert.equal(store().notice?.kind, "ask");
    assert.equal(lib.useAnalysisStore.getState().openRequest, 0);
    assert.ok(notes().includes("assistant: Which side do you mean?"));
});

await test("Stop while the editor thinks: the chat says so and the words go back to the box; the guard is free", async () => {
    await openChair();
    askGate = {};
    const sent = lib.submitEdit(WORDS);
    await sleep(15);
    assert.equal(store().status, "planning");
    assert.ok(lib.currentWork()?.stop, "the run chip has a Stop");
    lib.currentWork().stop();
    assert.deepEqual(await sent, { ok: false, restorePrompt: true });
    assert.deepEqual(notes(), [`user: ${WORDS}`, `assistant: ${lib.BLOCK_EDIT_STOPPED}`]);
    assert.equal(lib.currentWork(), null);
    assert.equal(lib.useAnalysisStore.getState().openRequest, 0);
});

await test("the person goes to another version while the editor thinks: the answer is dropped, and the chat says why", async () => {
    await openChair();
    askGate = {};
    const sent = lib.submitEdit(WORDS);
    await sleep(15);
    lib.useWorkspaceStore.setState({ activeModelId: ROOT_ID });
    askGate.release();
    assert.deepEqual(await sent, { ok: false, restorePrompt: true });
    assert.equal(notes().at(-1), `assistant: ${lib.BLOCK_EDIT_MOVED}`);
    assert.equal(store().proposal, null);
    assert.equal(lib.currentWork(), null);
});

await test("another project is opened meanwhile: its chat gets nothing and the words are not handed to it", async () => {
    await openChair();
    askGate = {};
    const sent = lib.submitEdit(WORDS);
    await sleep(15);
    lib.useWorkspaceStore.setState({ activeProjectId: "22222222-2222-4222-8222-222222222222", messages: [] });
    askGate.release?.();
    assert.deepEqual(await sent, { ok: true });
    assert.deepEqual(notes(), []);
});

await test("changes kept from before a reload are put back first: a request that ends in a question cannot make the editor forget them", async () => {
    await openChair();
    await lib.submitEdit(WORDS);
    store().apply();
    assert.equal(store().draft.count, 1);
    // A reload: the page's memory goes, the browser's session storage stays.
    const kept = globalThis.sessionStorage.getItem(KEPT);
    assert.ok(kept, "the draft is kept for a reload");
    store().discard();
    assert.equal(store().draft, null);
    assert.equal(globalThis.sessionStorage.getItem(KEPT), null);
    globalThis.sessionStorage.setItem(KEPT, kept);
    lib.useWorkspaceStore.setState({ messages: [] });
    lib.useAnalysisStore.getState().runSucceeded(SRC_ID, await analyse(stabilizedDescriptor(), {}));
    asked.length = 0;
    // The person ignores "You have 1 change on this version. Continue / Discard" and asks for something else; the editor asks back.
    answers.push({ summary: "", notes: "", clarification: "Which side do you mean?", ops: [] });
    const out = await lib.submitEdit("make it nicer");
    assert.deepEqual(out, { ok: true });
    assert.equal(store().notice?.kind, "ask");
    assert.equal(store().draft?.count, 1, "the kept change is back, and still there");
    assert.match(asked[0].scene, /EARLIER EDITS/, "the question was asked about the draft, not the saved version");
    assert.ok(globalThis.sessionStorage.getItem(KEPT), "and still kept for a reload");
    assert.equal(store().resumable, null);
});

await test("kept changes are not replayed before the check of the model is done (a failed replay would forget them); the request says to wait", async () => {
    await openChair();
    await lib.submitEdit(WORDS);
    store().apply();
    const kept = globalThis.sessionStorage.getItem(KEPT);
    store().discard();
    globalThis.sessionStorage.setItem(KEPT, kept);
    lib.useAnalysisStore.setState({ result: null, resultModelId: null });
    const out = await lib.submitEdit("make it nicer");
    assert.deepEqual(out, { ok: false, restorePrompt: true });
    assert.match(lib.toasts.at(-1).options.description, /check of this model to finish/);
    assert.ok(globalThis.sessionStorage.getItem(KEPT), "the kept draft survived");
    assert.equal(lib.currentWork(), null);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
