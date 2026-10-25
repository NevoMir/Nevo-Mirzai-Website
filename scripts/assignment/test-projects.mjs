// Tests for the projects side of stabilized models and examples: how the Models tab files and names models
// (components/workspace/format.ts, modelGroups.ts), the example gallery's state and opening flow
// (store/examples.ts), the model actions (store/models.ts) and the API client calls behind them (lib/api.ts).
//
//   node scripts/assignment/test-projects.mjs
//
// Bundled with esbuild like test-store.mjs: `react` is a no-op shim and the toast library becomes a log. No DOM, no
// network: `fetch` is replaced by a small in-memory server.
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = path.join(root, "node_modules/.tmp/assignment-projects-test");
mkdirSync(outDir, { recursive: true });

// ---------- bundle the modules under test ----------

const REACT_SHIM = `
export const useEffect = () => {};
export const useState = (init) => [typeof init === "function" ? init() : init, () => {}];
export const useRef = (v) => ({ current: v });
export const useMemo = (f) => f();
export const useCallback = (f) => f;
export default { useEffect, useState, useRef, useMemo, useCallback };
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
export * from "@/assignment/store/examples";
export * from "@/assignment/store/models";
export * from "@/assignment/store/providers";
export * from "@/assignment/components/workspace/format";
export * from "@/assignment/components/workspace/modelGroups";
export * from "@/assignment/lib/api";
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
                const shims = {
                    "react-shim": REACT_SHIM,
                    "toast-shim": TOAST_SHIM,
                };
                b.onResolve({ filter: /^react$/ }, () => ({ path: "react-shim", namespace: "shim" }));
                b.onResolve({ filter: /^@\/assignment\/components\/ui\/sonner$/ }, () => ({ path: "toast-shim", namespace: "shim" }));
                b.onLoad({ filter: /.*/, namespace: "shim" }, (args) => ({ contents: shims[args.path], loader: "js" }));
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
const events = [];
globalThis.window = { innerWidth: 1440, dispatchEvent: (e) => void events.push(e.type), addEventListener() {}, removeEventListener() {} };
globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };

// ---------- a fake server ----------

const calls = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

const fake = {
    examples: [],
    examplesStatus: 200,
    examplesDelay: 0,
    fromExample: null, // (body) => { status, json }
    fromExampleDelay: 0,
    derived: null, // (sourceId, body) => { status, json }
    del: null, // (id) => { status, json }
};

globalThis.fetch = async (url, init = {}) => {
    const apiPath = String(url).replace("/api/assignment_alex", "");
    const method = init.method ?? "GET";
    const isBlob = typeof Blob !== "undefined" && init.body instanceof Blob;
    const body = init.body && !isBlob ? JSON.parse(init.body) : init.body;
    const record = { method, path: apiPath, body, headers: init.headers ?? {} };
    calls.push(record);
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    let m;
    if (method === "GET" && apiPath === "/examples") {
        if (fake.examplesDelay) await sleep(fake.examplesDelay);
        if (fake.examplesStatus === 0) throw new TypeError("network down");
        return reply(fake.examplesStatus, fake.examplesStatus < 400 ? { examples: fake.examples } : { error: "boom" });
    }
    if (method === "POST" && apiPath === "/projects/from-example") {
        if (fake.fromExampleDelay) await sleep(fake.fromExampleDelay);
        const r = fake.fromExample(body);
        return reply(r.status, r.json);
    }
    if (method === "POST" && (m = apiPath.match(/^\/models\/([^/]+)\/derived$/))) {
        const r = fake.derived(m[1], body);
        return reply(r.status, r.json);
    }
    if (method === "DELETE" && (m = apiPath.match(/^\/models\/([^/]+)$/))) {
        const r = fake.del(m[1]);
        return reply(r.status, r.json);
    }
    return reply(404, { error: `no fake for ${method} ${apiPath}` });
};

// ---------- fixtures ----------

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function summary(over = {}) {
    return {
        version: 1, blocks: 100, bodies: 1, floating_blocks: 0, cantilevered: 0, longest_cantilever: 0, over_limit: 0,
        cantilever_limit: 4, cog_mm: [500, 500, 300], cog_inside: true, cog_margin_mm: 100, size_mm: [1000, 1000, 1000],
        coverage: 0.3, fill_threshold: 0.1, errors: 0, warnings: 0, analyzed_at: iso(), ...over,
    };
}
function model(over = {}) {
    return {
        id: uuid(), project_id: "p1", job_id: "", provider: "meshy", prompt: "a lamp", glb_url: "/x.glb", thumbnail_url: null,
        size_bytes: 1000, part_count: 1, created_at: iso(), analysis: null, kind: "generated", source_model_id: null,
        example_slug: null, derived: null, ...over,
    };
}
const stabilizedOf = (source, over = {}) =>
    model({ provider: "stabilizer", prompt: source.prompt, kind: "stabilized", source_model_id: source.id, ...over });
const hubProject = (id) => ({
    id, name: "x", created_at: iso(), modified_at: iso(), deleted_at: null, archived_at: null, pinned: false,
    thumbnail_url: null, tag_ids: [], model_count: 0,
});
function metrics(over = {}) {
    return {
        blocks: 100, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 0, cog_margin_mm: 100,
        max_utilisation: 0.2, overstressed_blocks: 0, ...over,
    };
}
function example(slug, over = {}) {
    return {
        slug, title: `Example ${slug}`, prompt: `A ${slug}`, blurb: "Goes wrong, then right.", tags: ["cantilever"],
        cover_url: `/assignment_alex/examples/${slug}/cover.png`,
        original: { size_bytes: 2000, part_count: 3, analysis: summary({ errors: 2, warnings: 0 }) },
        stabilized: {
            size_bytes: 6000, analysis: summary({ blocks: 114 }), added_blocks: 14,
            before: metrics({ errors: 2, max_utilisation: 1.98 }), after: metrics({ max_utilisation: 0.21 }),
        },
        version: "abcd1234",
        ...over,
    };
}
/** What POST /projects/from-example answers: a project with the original, its stabilized twin and the pre-written chat. */
function exampleProject(slug = "shelf-arm") {
    const projectId = uuid();
    const original = model({ project_id: projectId, provider: "example", kind: "example", example_slug: slug, prompt: `A ${slug}`, analysis: summary({ errors: 2 }) });
    const twin = stabilizedOf(original, { project_id: projectId, example_slug: slug, analysis: summary({ blocks: 114 }) });
    return {
        original,
        twin,
        detail: {
            ...hubProject(projectId),
            data: {
                messages: [
                    { id: uuid(), role: "user", content: `A ${slug}`, timestamp: iso() },
                    { id: uuid(), role: "assistant", content: "Opened the example.", timestamp: iso(), model_ids: [original.id, twin.id] },
                ],
                active_model_id: original.id,
            },
            models: [original, twin],
            jobs: [],
        },
    };
}

// ---------- the modules ----------

const lib = await import(pathToFileURL(path.join(outDir, "bundle.mjs")).href);
const S = () => lib.useWorkspaceStore.getState();
const navigated = [];
const navigate = (to) => void navigated.push(to);
const reset = () => {
    S().startNewChat();
    lib.useExamplesStore.setState({ status: "idle", examples: [], error: null });
    calls.length = 0;
    events.length = 0;
    navigated.length = 0;
    lib.toasts.length = 0;
    storage.clear();
    fake.examples = [example("shelf-arm"), example("footbridge")];
    fake.examplesStatus = 200;
    fake.examplesDelay = 0;
    fake.fromExample = () => ({ status: 500, json: { error: "unset" } });
    fake.fromExampleDelay = 0;
    fake.derived = () => ({ status: 500, json: { error: "unset" } });
    fake.del = () => ({ status: 200, json: { ok: true } });
};

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

// ================= naming =================

await test("modelTitle marks a stabilized version and leaves every other model's prompt alone", () => {
    assert.equal(lib.modelTitle(model({ prompt: "a lamp" })), "a lamp");
    assert.equal(lib.modelTitle(model({ prompt: "a lamp", kind: "example" })), "a lamp");
    assert.equal(lib.modelTitle(model({ prompt: "a lamp", kind: "stabilized" })), "Stabilized · a lamp");
    assert.equal(lib.modelTitle({ prompt: "from an old server" }), "from an old server", "no kind reads as generated");
});

await test("modelFileName ends in -stabilized / -example for those kinds and in the provider otherwise", () => {
    assert.equal(lib.modelFileName(model({ prompt: "A wooden rocking chair", provider: "meshy" })), "a-wooden-rocking-chair-meshy.glb");
    assert.equal(lib.modelFileName(model({ prompt: "A wooden rocking chair", provider: "stabilizer", kind: "stabilized" })), "a-wooden-rocking-chair-stabilized.glb");
    assert.equal(lib.modelFileName(model({ prompt: "Shelf arm", provider: "example", kind: "example" })), "shelf-arm-example.glb");
    assert.equal(lib.modelFileName({ prompt: "x", provider: "tripo" }), "x-tripo.glb", "a row without kind still gets a name");
    assert.equal(lib.modelFileName({ prompt: "???", provider: "tripo" }), "model-tripo.glb");
});

await test("addedBlocksLabel and exampleCoverUrl", () => {
    assert.equal(lib.addedBlocksLabel(14), "+14 blocks");
    assert.equal(lib.addedBlocksLabel(1), "+1 block");
    assert.equal(lib.exampleCoverUrl("shelf-arm"), "/assignment_alex/examples/shelf-arm/cover.png");
});

await test("providerLabel names the two makers no provider list carries", () => {
    assert.equal(lib.providerLabel(undefined, "example"), "Ready-made example");
    assert.equal(lib.providerLabel(undefined, "stabilizer"), "Stabilizer");
    assert.equal(lib.providerLabel(undefined, "meshy"), "Meshy 7.1");
});

// ================= grouping =================

await test("groupModels files a stabilized version under its source, newest source first", () => {
    const a = model({ prompt: "A" });
    const a1 = stabilizedOf(a);
    const a2 = stabilizedOf(a1);
    const b = model({ prompt: "B" });
    const c = model({ prompt: "C", kind: "example", provider: "example" });
    const c1 = stabilizedOf(c);
    const a1b = stabilizedOf(a); // a second version of A
    const groups = lib.groupModels([a, a1, b, a2, c, c1, a1b]);
    assert.deepEqual(groups.map((g) => g.source.prompt), ["C", "B", "A"], "newest source first");
    assert.deepEqual(groups[0].versions.map((v) => [v.model.id, v.depth]), [[c1.id, 1]]);
    assert.deepEqual(groups[1].versions, []);
    assert.deepEqual(
        groups[2].versions.map((v) => [v.model.id, v.depth]),
        [[a1.id, 1], [a2.id, 2], [a1b.id, 1]],
        "depth first: a version is followed by the versions made from it",
    );
});

await test("groupModels never hides a model: orphans, self references and cycles stand as sources", () => {
    const gone = model();
    const orphan = stabilizedOf(gone); // its source is not in the list
    const lonely = model({ kind: "stabilized", provider: "stabilizer" });
    lonely.source_model_id = lonely.id;
    const x = model({ kind: "stabilized", provider: "stabilizer" });
    const y = model({ kind: "stabilized", provider: "stabilizer", source_model_id: x.id });
    x.source_model_id = y.id; // x <-> y
    const plain = model();
    const list = [plain, orphan, lonely, x, y];
    const groups = lib.groupModels(list);
    const seen = groups.flatMap((g) => [g.source.id, ...g.versions.map((v) => v.model.id)]);
    assert.equal(seen.length, list.length, "each model appears exactly once");
    assert.deepEqual([...seen].sort(), list.map((m) => m.id).sort());
    assert.equal(groups.find((g) => g.source.id === orphan.id)?.versions.length, 0);
    assert.deepEqual(lib.groupModels([]), []);
});

await test("a generated model with a source_model_id is still a source (only stabilized versions nest)", () => {
    const a = model();
    const odd = model({ source_model_id: a.id }); // kind generated
    assert.equal(lib.groupModels([a, odd]).length, 2);
});

await test("descendantsOf takes the whole family, sourceOf and pairOf point the right way", () => {
    const a = model();
    const a1 = stabilizedOf(a);
    const a2 = stabilizedOf(a1);
    const a1b = stabilizedOf(a);
    const other = model();
    const list = [a, a1, a2, a1b, other];
    assert.deepEqual(lib.descendantsOf(list, a1.id).map((m) => m.id), [a2.id]);
    assert.deepEqual(lib.descendantsOf(list, a.id).map((m) => m.id).sort(), [a1.id, a1b.id, a2.id].sort());
    assert.deepEqual(lib.descendantsOf(list, other.id), []);

    assert.equal(lib.sourceOf(a1, list)?.id, a.id);
    assert.equal(lib.sourceOf(a, list), null);
    assert.equal(lib.sourceOf(stabilizedOf(model()), list), null, "source not in the list");

    assert.deepEqual(lib.pairOf(a1, list) && { id: lib.pairOf(a1, list).model.id, label: lib.pairOf(a1, list).label }, { id: a.id, label: "Original" });
    assert.deepEqual(
        lib.pairOf(a, list) && { id: lib.pairOf(a, list).model.id, label: lib.pairOf(a, list).label },
        { id: a1b.id, label: "Stabilized" },
        "an original points at its newest version",
    );
    assert.equal(lib.pairOf(a2, list)?.model.id, a1.id, "a version of a version points at the one before it");
    assert.equal(lib.pairOf(a2, list)?.label, "Previous");
    assert.equal(lib.pairOf(other, list), null, "nothing to flip to");
    assert.equal(lib.pairOf(stabilizedOf(model()), list), null, "a version whose source is gone has no pair");
});

// ================= the store =================

await test("sanitizeMessages keeps model_ids (strings only, at most 10) next to job_ids", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const out = lib.sanitizeMessages([
        { id: "1", role: "assistant", content: "a", timestamp: "t", model_ids: ["x", 5, "", "y"] },
        { id: "2", role: "assistant", content: "b", timestamp: "t", model_ids: ids },
        { id: "3", role: "assistant", content: "c", timestamp: "t", model_ids: [] },
        { id: "4", role: "assistant", content: "d", timestamp: "t", model_ids: "nope", job_ids: ["j"] },
    ]);
    assert.deepEqual(out[0].model_ids, ["x", "y"]);
    assert.equal(out[1].model_ids.length, 10);
    assert.equal(out[2].model_ids, undefined);
    assert.equal(out[3].model_ids, undefined);
    assert.deepEqual(out[3].job_ids, ["j"]);
});

await test("setProject fills kind and the source fields a server from before the stabilizer does not send", () => {
    const old = { id: "m", project_id: "p", job_id: "j", provider: "meshy", prompt: "p", glb_url: "/g", thumbnail_url: null, size_bytes: 1, part_count: 1, created_at: iso(), analysis: null };
    const fresh = model({ kind: "stabilized", source_model_id: "m", example_slug: "s" });
    S().setProject({ ...exampleProject().detail, models: [old, fresh] });
    const [a, b] = S().models;
    assert.equal(a.kind, "generated");
    assert.equal(a.source_model_id, null);
    assert.equal(a.example_slug, null);
    assert.equal(a.derived, null);
    assert.equal(b, fresh, "a complete row is passed through untouched");
    S().addModel({ ...old, id: "n" });
    assert.equal(S().models.find((m) => m.id === "n").kind, "generated");
});

await test("removeModels drops the ids and moves the viewer off a deleted model (a change the project saves)", () => {
    const a = model();
    const a1 = stabilizedOf(a);
    const a2 = stabilizedOf(a1);
    S().setProject({ ...exampleProject().detail, models: [a, a1, a2], data: { messages: [], active_model_id: a2.id } });
    const before = S().revision;
    S().removeModels([a1.id, a2.id], a.id);
    assert.deepEqual(S().models.map((m) => m.id), [a.id]);
    assert.equal(S().activeModelId, a.id);
    assert.equal(S().revision, before + 1, "the new active model is saved");

    // Not the active one: the viewer stays where it is.
    S().setProject({ ...exampleProject().detail, models: [a, a1], data: { messages: [], active_model_id: a.id } });
    const rev = S().revision;
    S().removeModels([a1.id], a.id);
    assert.equal(S().activeModelId, a.id);
    assert.equal(S().revision, rev, "nothing to save");
    // Unknown ids change nothing; no fallback means the newest model left.
    S().removeModels(["nope"]);
    assert.equal(S().models.length, 1);
    S().setProject({ ...exampleProject().detail, models: [a, a1], data: { messages: [], active_model_id: a1.id } });
    S().removeModels([a1.id]);
    assert.equal(S().activeModelId, a.id);
    S().removeModels([a.id]);
    assert.equal(S().activeModelId, null);
});

// ================= providers and the hero default =================

const info = (id, available) => ({ id, label: id, vendor: id, via: available ? "fal" : null, available, description: "", parts: false, textured: false, approx_seconds: 60 });

await test("hasPaidProvider ignores the offline demo and a list that has not arrived", () => {
    assert.equal(lib.hasPaidProvider(undefined), false);
    assert.equal(lib.hasPaidProvider([]), false);
    assert.equal(lib.hasPaidProvider([info("mock", true)]), false, "the free demo costs nothing");
    assert.equal(lib.hasPaidProvider([info("meshy", false), info("mock", true)]), false);
    assert.equal(lib.hasPaidProvider([info("meshy", true), info("mock", true)]), true);
});

await test("Muse Spark is an AI designer: a name when the server no longer lists it, a helper line, an OpenRouter badge", () => {
    assert.equal(lib.providerLabel(undefined, "muse"), "Muse Spark 1.3", "a job made before the key was removed still has a name");
    assert.equal(lib.providerLabel([{ ...info("muse", true), label: "Muse Spark 1.3 (live)" }], "muse"), "Muse Spark 1.3 (live)", "the server's label wins");
    assert.equal(lib.viaLabel("openrouter"), "via OpenRouter");
    assert.deepEqual(["fal", "tripo", "meshy", "tencent", "mock", null, undefined].map(lib.viaLabel), ["via fal", "via Tripo", "via Meshy", "via Tencent", "demo", null, null]);
    assert.equal(lib.isDesigner("muse"), true);
    assert.deepEqual(["hunyuan", "tripo-parts", "mock", undefined].map(lib.isDesigner), [false, false, false, false], "a model that returns parts is not a designer for that");
    assert.equal(lib.designerNote({ id: "muse" }), "AI designer · builds the object from named parts");
    assert.equal(lib.designerNote({ id: "hunyuan" }), null);
    assert.equal(lib.designerNote(undefined), null);
    // It is a usable paid model like the others: the hero offers to generate, and the picker may select it.
    assert.equal(lib.hasPaidProvider([info("muse", true)]), true);
    assert.deepEqual(lib.initialSelection([info("hunyuan", true), info("muse", true)], ["muse"], "hunyuan"), ["muse"]);
    assert.deepEqual(lib.initialSelection([info("muse", false)], ["muse"], null), [], "no key, no model");
});

await test("viaSuffix: the menu row names the key once, even when the maker's line already says it", () => {
    assert.equal(lib.viaSuffix("Meta via OpenRouter", "openrouter"), null, "the server's line for Muse");
    assert.equal(lib.viaSuffix("meta VIA openrouter", "openrouter"), null, "whatever the case");
    assert.equal(lib.viaSuffix("Meta", "openrouter"), "via OpenRouter");
    assert.equal(lib.viaSuffix("Tencent", "tencent"), "via Tencent");
    assert.equal(lib.viaSuffix("Tencent via Tencent Cloud", "tencent"), null);
    assert.equal(lib.viaSuffix("Meta via OpenRouter", null), null, "no key: no badge");
    assert.equal(lib.viaSuffix("Meta via OpenRouter", "fal"), "via fal", "another key than the one the line names still shows");
    assert.equal(lib.viaSuffix("Offline", "mock"), "demo");
});

await test("stageText: the card draws its own dots, so a stage that ends in an ellipsis loses it", () => {
    assert.equal(lib.stageText("Designing the parts\u2026"), "Designing the parts");
    assert.equal(lib.stageText("Building the 3D model..."), "Building the 3D model");
    assert.equal(lib.stageText("Building the 3D model"), "Building the 3D model");
    assert.equal(lib.stageText("Waiting for provider\u2026 "), "Waiting for provider");
    assert.equal(lib.stageText("In queue (position 3)"), "In queue (position 3)", "nothing else is touched");
    for (const empty of ["", "  ", "\u2026", null, undefined]) assert.equal(lib.stageText(empty), "Queued", JSON.stringify(empty));
});

await test("a project is a new chat only when it has no message, no model and no job (the hero never covers a model)", () => {
    const has = () => lib.selectProjectHasContent(S());
    assert.equal(has(), false, "a new chat");
    const { original, detail } = exampleProject();
    // A project made through the API: a model, and no chat at all.
    S().setProject({ ...detail, models: [original], jobs: [], data: { messages: [], active_model_id: original.id } });
    assert.equal(S().messages.length, 0);
    assert.equal(has(), true, "a model alone is content");
    // Messages alone (the first send's message before its model lands).
    S().setProject({ ...detail, models: [], jobs: [], data: { messages: detail.data.messages, active_model_id: null } });
    assert.equal(has(), true, "a message alone is content");
    // A job alone (a run begun in another tab, whose message was never saved).
    S().setProject({ ...detail, models: [], jobs: [{ id: uuid(), project_id: detail.id, provider: "muse", prompt: "a lamp", status: "running", progress: 10, stage: "Designing the parts\u2026", created_at: iso(), updated_at: iso(), model: null, error: null }], data: { messages: [], active_model_id: null } });
    assert.equal(has(), true, "a running job alone is content");
    // A project with nothing in it is empty, as is the chat that was just cleared.
    S().setProject({ ...detail, models: [], jobs: [], data: { messages: [], active_model_id: null } });
    assert.equal(has(), false, "an empty project still starts with the hero");
    S().setProject({ ...detail, models: [original], jobs: [], data: { messages: [], active_model_id: original.id } });
    S().startNewChat();
    assert.equal(has(), false, "starting over clears it");
    // Adding a model to an empty chat flips it, and deleting the last one flips it back.
    S().addModel(original);
    assert.equal(has(), true);
    S().removeModels([original.id]);
    assert.equal(has(), false);
});

await test("the hero starts on examples unless something paid can generate (and there are examples to open)", () => {
    const demoOnly = [info("mock", true)];
    const paid = [info("tripo", true)];
    assert.equal(lib.defaultStartMode(undefined, true), "examples", "list not loaded yet");
    assert.equal(lib.defaultStartMode(demoOnly, true), "examples", "the live site today");
    assert.equal(lib.defaultStartMode([info("tripo", false)], true), "examples", "generation switched off");
    assert.equal(lib.defaultStartMode(paid, true), "prompts");
    assert.equal(lib.defaultStartMode(demoOnly, false), "prompts", "no examples to show");
    assert.equal(lib.defaultStartMode(paid, false), "prompts");
});

await test("the remembered start mode round-trips and ignores anything else", () => {
    assert.equal(lib.loadStartMode(), null);
    lib.saveStartMode("prompts");
    assert.equal(lib.loadStartMode(), "prompts");
    lib.saveStartMode("examples");
    assert.equal(lib.loadStartMode(), "examples");
    storage.set("assembly-studio-start-mode", "sideways");
    assert.equal(lib.loadStartMode(), null);
    const real = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    try {
        assert.equal(lib.loadStartMode(), null);
        lib.saveStartMode("prompts"); // does not throw
    } finally {
        globalThis.localStorage = real;
    }
});

// ================= the cards' words =================

await test("exampleChips words a fixed model as 'problems → Stable', with the blocks and the stress change", () => {
    const chips = lib.exampleChips(example("shelf-arm"));
    assert.equal(chips.status, "2 problems → Stable");
    assert.equal(chips.fixed, true);
    assert.equal(chips.added, "+14 blocks");
    assert.equal(chips.stress, "198% → 21%");
    assert.equal(lib.exampleLabel(example("shelf-arm")), "Example shelf-arm, 2 problems to Stable, +14 blocks");
});

await test("exampleChips: a warning, a single block, and a control that was never broken", () => {
    const warn = example("mushroom", {
        original: { size_bytes: 1, part_count: 1, analysis: summary({ errors: 0, warnings: 1 }) },
        stabilized: { ...example("x").stabilized, added_blocks: 1 },
    });
    assert.equal(lib.exampleChips(warn).status, "1 warning → Stable");
    assert.equal(lib.exampleChips(warn).added, "+1 block");

    const control = example("footbridge", {
        original: { size_bytes: 1, part_count: 1, analysis: summary() },
        stabilized: {
            ...example("x").stabilized, added_blocks: 0, analysis: summary(),
            before: metrics({ max_utilisation: 0.24 }), after: metrics({ max_utilisation: 0.24 }),
        },
    });
    const chips = lib.exampleChips(control);
    assert.equal(chips.status, "Already stable");
    assert.equal(chips.fixed, false);
    assert.equal(chips.added, null);
    assert.equal(chips.stress, null, "unchanged stress is not a chip");
    assert.equal(lib.exampleLabel(control), "Example footbridge, Already stable");

    // Stress not known (nothing stood on the ground): no chip rather than "null%".
    const unknown = example("lamp", { stabilized: { ...example("x").stabilized, before: metrics({ max_utilisation: null }) } });
    assert.equal(lib.exampleChips(unknown).stress, null);
});

// ================= the API client =================

await test("listExamples returns the list and tolerates an answer without one", async () => {
    assert.deepEqual((await lib.listExamples()).map((e) => e.slug), ["shelf-arm", "footbridge"]);
    assert.equal(calls[0].path, "/examples");
    fake.examples = undefined;
    assert.deepEqual(await lib.listExamples(), []);
});

await test("createProjectFromExample posts the slug, and the tag only when there is one", async () => {
    const { detail } = exampleProject();
    fake.fromExample = () => ({ status: 201, json: { project: detail } });
    assert.equal((await lib.createProjectFromExample("shelf-arm")).id, detail.id);
    assert.deepEqual(calls[0].body, { slug: "shelf-arm" });
    await lib.createProjectFromExample("shelf-arm", "tag-1");
    assert.deepEqual(calls[1].body, { slug: "shelf-arm", tag_id: "tag-1" });
    await lib.createProjectFromExample("shelf-arm", null);
    assert.deepEqual(calls[2].body, { slug: "shelf-arm" });
});

await test("createDerivedModel sends the GLB bytes as model/gltf-binary and resolves to the stored model", async () => {
    const stored = stabilizedOf(model());
    let seen;
    fake.derived = (sourceId, body) => {
        seen = { sourceId, body };
        return { status: 201, json: { model: stored } };
    };
    // A view into a larger buffer, like the stabilizer's transferred result: only its own bytes may travel.
    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 9]);
    const glb = backing.subarray(2, 6);
    const result = await lib.createDerivedModel("src-1", glb);
    assert.equal(result.id, stored.id);
    assert.equal(seen.sourceId, "src-1");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers["content-type"], "model/gltf-binary");
    assert.ok(seen.body instanceof Blob);
    assert.deepEqual([...new Uint8Array(await seen.body.arrayBuffer())], [1, 2, 3, 4]);
});

await test("createDerivedModel surfaces the server's reason (400 invalid file, 429 cap)", async () => {
    fake.derived = () => ({ status: 429, json: { error: "This model already has 5 stabilized versions." } });
    await assert.rejects(() => lib.createDerivedModel("src", new Uint8Array(4)), (err) => err.status === 429 && /5 stabilized/.test(err.message));
    fake.derived = () => ({ status: 400, json: { error: "unexpected content" } });
    await assert.rejects(() => lib.createDerivedModel("src", new Uint8Array(4)), (err) => err.status === 400);
});

await test("deleteModel sends DELETE /models/:id", async () => {
    await lib.deleteModel("m 1");
    assert.deepEqual([calls[0].method, calls[0].path], ["DELETE", "/models/m%201"]);
    fake.del = () => ({ status: 409, json: { error: "Only stabilized versions can be deleted." } });
    await assert.rejects(() => lib.deleteModel("m"), (err) => err.status === 409);
});

// ================= the examples list =================

await test("loadExamples: loading, ready, then no refetch; concurrent calls share one request", async () => {
    fake.examplesDelay = 20;
    const first = lib.loadExamples();
    const second = lib.loadExamples();
    assert.equal(lib.useExamplesStore.getState().status, "loading");
    await Promise.all([first, second]);
    assert.equal(calls.filter((c) => c.path === "/examples").length, 1);
    assert.equal(lib.useExamplesStore.getState().status, "ready");
    assert.equal(lib.useExamplesStore.getState().examples.length, 2);
    await lib.loadExamples();
    assert.equal(calls.filter((c) => c.path === "/examples").length, 1, "a loaded list stays");
    await lib.loadExamples(true);
    assert.equal(calls.filter((c) => c.path === "/examples").length, 2, "force asks again");
});

await test("loadExamples: a failure is an error state with the reason, and Retry recovers", async () => {
    fake.examplesStatus = 500;
    await lib.loadExamples();
    let state = lib.useExamplesStore.getState();
    assert.equal(state.status, "error");
    assert.equal(state.error, "boom");
    assert.deepEqual(state.examples, []);
    fake.examplesStatus = 0; // the network is down
    await lib.loadExamples(true);
    assert.match(lib.useExamplesStore.getState().error, /Could not reach the server/);
    fake.examplesStatus = 200;
    await lib.loadExamples(true);
    state = lib.useExamplesStore.getState();
    assert.equal(state.status, "ready");
    assert.equal(state.error, null);
});

await test("a forced reload keeps the list on screen while it runs", async () => {
    await lib.loadExamples();
    fake.examplesDelay = 20;
    const reload = lib.loadExamples(true);
    assert.equal(lib.useExamplesStore.getState().status, "ready");
    assert.equal(lib.useExamplesStore.getState().examples.length, 2);
    await reload;
});

// ================= opening an example =================

await test("openExample puts the project in the workspace, opens it on the Analysis tab and tells the hub", async () => {
    const { detail, original } = exampleProject();
    fake.fromExample = () => ({ status: 201, json: { project: detail } });
    const result = await lib.openExample("shelf-arm", { navigate });
    assert.deepEqual(result, { ok: true, projectId: detail.id });
    assert.equal(S().activeProjectId, detail.id);
    assert.equal(S().activeModelId, original.id, "the original is shown first");
    assert.equal(S().workspaceTab, "analysis");
    assert.deepEqual(S().messages[1].model_ids, [original.id, S().models[1].id], "the chat reads as a conversation with two model cards");
    assert.equal(S().revision, 0, "opening is not an edit: nothing to autosave");
    assert.deepEqual(navigated, [`/app/${detail.id}?tab=analysis`]);
    assert.deepEqual(events, ["assembly-hub-changed"]);
    assert.deepEqual(calls[0].body, { slug: "shelf-arm" });
    assert.equal(lib.toasts.length, 0);
});

await test("openExample files the project under the seed tag", async () => {
    const { detail } = exampleProject();
    fake.fromExample = () => ({ status: 201, json: { project: detail } });
    await lib.openExample("shelf-arm", { navigate, tagId: "tag-9" });
    assert.deepEqual(calls[0].body, { slug: "shelf-arm", tag_id: "tag-9" });
});

await test("openExample failure: a toast with Retry, nothing opened, and Retry works", async () => {
    fake.fromExample = () => ({ status: 500, json: { error: "disk full" } });
    const result = await lib.openExample("shelf-arm", { navigate });
    assert.deepEqual(result, { ok: false, error: "disk full" });
    assert.equal(S().activeProjectId, null);
    assert.deepEqual(navigated, []);
    assert.deepEqual(events, []);
    const toast = lib.toasts.at(-1);
    assert.equal(toast.kind, "error");
    assert.equal(toast.title, "Could not open the example");
    assert.equal(toast.options.description, "disk full");
    assert.equal(toast.options.action.label, "Retry");

    const { detail } = exampleProject();
    fake.fromExample = () => ({ status: 201, json: { project: detail } });
    toast.options.action.onClick();
    await sleep(10);
    assert.equal(S().activeProjectId, detail.id, "Retry opened it");
    assert.deepEqual(navigated, [`/app/${detail.id}?tab=analysis`]);
});

await test("openExample: a network failure reads as a connection problem, with Retry", async () => {
    fake.fromExample = () => {
        throw new TypeError("network down");
    };
    const result = await lib.openExample("shelf-arm", { navigate });
    assert.equal(result.ok, false);
    assert.match(result.error, /Could not reach the server/);
    assert.equal(lib.toasts.at(-1).options.action.label, "Retry");
});

await test("openExample 404 (a deploy changed the set) refreshes the list instead of offering Retry", async () => {
    fake.fromExample = () => ({ status: 404, json: { error: "Example not found" } });
    const result = await lib.openExample("gone", { navigate });
    assert.equal(result.ok, false);
    const toast = lib.toasts.at(-1);
    assert.equal(toast.title, "That example is no longer available");
    assert.equal(toast.options.action, undefined);
    await sleep(10);
    assert.equal(calls.filter((c) => c.path === "/examples").length, 1, "the list was asked for again");
    assert.equal(lib.useExamplesStore.getState().status, "ready");
});

await test("openExample 429 (project limit) says why and offers no Retry", async () => {
    fake.fromExample = () => ({ status: 429, json: { error: "Project limit reached. Delete some projects first." } });
    await lib.openExample("shelf-arm", { navigate });
    const toast = lib.toasts.at(-1);
    assert.match(toast.options.description, /Project limit reached/);
    assert.equal(toast.options.action, undefined);
});

await test("a second click while one example is opening does nothing (one project, one request)", async () => {
    const { detail } = exampleProject();
    fake.fromExampleDelay = 30;
    fake.fromExample = () => ({ status: 201, json: { project: detail } });
    const first = lib.openExample("shelf-arm", { navigate });
    const second = await lib.openExample("footbridge", { navigate });
    assert.equal(second.ok, false);
    assert.equal((await first).ok, true);
    assert.equal(calls.filter((c) => c.path === "/projects/from-example").length, 1);
    assert.equal(navigated.length, 1);
    // And it is free again afterwards.
    fake.fromExampleDelay = 0;
    assert.equal((await lib.openExample("footbridge", { navigate })).ok, true);
});

// ================= model actions =================

await test("deleteStabilized deletes the version and its family, and the viewer goes back to the source", async () => {
    const a = model();
    const a1 = stabilizedOf(a, { derived: null });
    const a2 = stabilizedOf(a1);
    const other = model();
    S().setProject({ ...exampleProject().detail, models: [a, a1, a2, other], data: { messages: [], active_model_id: a2.id } });
    const result = await lib.deleteStabilized(a1);
    assert.deepEqual(result, { ok: true, removed: [a1.id, a2.id] });
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [["DELETE", `/models/${a1.id}`]], "one request: the server removes the rest");
    assert.deepEqual(S().models.map((m) => m.id), [a.id, other.id]);
    assert.equal(S().activeModelId, a.id, "back on the model the version was made from");
    assert.equal(lib.toasts.at(-1).title, "Deleted 2 stabilized versions");
});

await test("deleteStabilized refuses anything that is not a stabilized version, without a request", async () => {
    const a = model();
    S().setProject({ ...exampleProject().detail, models: [a], data: { messages: [], active_model_id: a.id } });
    const result = await lib.deleteStabilized(a);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    assert.equal(S().models.length, 1);
});

await test("deleteStabilized keeps everything when the server says no", async () => {
    const a = model();
    const a1 = stabilizedOf(a);
    S().setProject({ ...exampleProject().detail, models: [a, a1], data: { messages: [], active_model_id: a1.id } });
    fake.del = () => ({ status: 409, json: { error: "Source is in the bin." } });
    const result = await lib.deleteStabilized(a1);
    assert.deepEqual(result, { ok: false, error: "Source is in the bin." });
    assert.equal(S().models.length, 2);
    assert.equal(S().activeModelId, a1.id);
    assert.equal(lib.toasts.at(-1).kind, "error");
});

await test("there is no Compare any more: the top bar switches versions, so the models module only deletes them", () => {
    assert.ok(!("openCompare" in lib), "no way to open a version on an overlay from here");
    assert.deepEqual(Object.keys(lib).filter((k) => /compare/i.test(k)), []);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
