// Smoke test of changing the blocks by words against `wrangler dev`: store a block-edited version, edit an edited version, stabilize an edit,
// repeat saves, refusals, the project payload, delete, and the guards of POST /llm/voxel-edit.
//
//   npx wrangler dev --port 8787 --local                  # MOCK_PROVIDER=1 in .dev.vars: the editor answers with one canned operation
//   node scripts/assignment/smoke-voxel-edit.mjs          # BASE=http://127.0.0.1:8787 by default
//
// Other servers it understands (each runs the guard checks for that setup):
//   NO_KEY=1   a server without OPENROUTER_API_KEY and without MOCK_PROVIDER: the endpoint answers 503
//   LIMIT=2    a server started with DAILY_LLM_LIMIT=2 (and the mock): the third call of the day is a 429
//   LIVE=1     a server with a real key and MOCK_LLM=0: ONE real call (costs about $0.0005), checked against the schema
// The edited versions it uploads are built here with the shared modules from the answers Muse Spark gave in live runs
// (fixtures/voxel-edit/runs), so no browser and no model are needed for the storage checks.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const src = (p) => import(path.join(root, "src/assignment", p));
const G = await src("shared/voxelEdit/grid.ts");
const O = await src("shared/voxelEdit/ops.ts");
const S = await src("shared/voxelEdit/scene.ts");
const M = await src("shared/voxelEdit/meta.ts");
const PR = await src("shared/voxelEdit/prompt.ts");
const GLB = await src("shared/assemblyGlb.ts");
const CT = await src("shared/contract.ts");
const AN = await src("analysis/assembly.ts");
const WS = await src("analysis/withStress.ts");
const { stabilize, loadStabilizerSolver } = await src("analysis/stabilize/stabilize.ts");
const { DEFAULT_STABILIZE_OPTIONS } = await src("analysis/stabilize/types.ts");
const { normalizeSettings } = await src("analysis/settings.ts");

const EX = path.join(root, "public/assignment_alex/examples");
const FIX = path.join(here, "fixtures/voxel-edit");
const cache = JSON.parse(readFileSync(path.join(FIX, "labels-cache.json"), "utf8"));
const answerOf = (tag) => JSON.parse(JSON.parse(readFileSync(path.join(FIX, "runs", `${tag}.json`), "utf8")).content);

let pass = 0;
const failures = [];
const section = (title) => console.log(`\n== ${title}`);
function check(name, condition, detail = "") {
    if (condition) {
        pass++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
    }
}
async function api(pathname, init = {}) {
    const res = await fetch(API + pathname, init);
    const raw = await res.text();
    let body = raw;
    try { body = JSON.parse(raw); } catch { /* not JSON */ }
    return { status: res.status, body };
}
const post = (pathname, body, headers = {}) => api(pathname, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const glb = (pathname, bytes) => api(pathname, { method: "POST", headers: { "content-type": "model/gltf-binary" }, body: bytes });
const op = (o) => ({ op: "add", region: null, box: null, dirs: null, amount: null, axis: null, at: null, plane: null, offset: null, wall: null, include_added: false, ...o });
const analyseGrid = (g) => WS.withStress(AN.analyzeAssembly(G.descriptorOfGrid(g), null, {}));
const sceneIssues = (result) => result.issues.map((i) => ({ severity: i.severity, title: i.title, cells: i.blocks.map((b) => result.blocks[b].cell) }));

/** An example as the editor sees it: its stabilized version (or just the original blocks), labelled by part. */
async function loadExample(slug, version = "stabilized") {
    const lab = cache[slug];
    const owner = new Int8Array(1000).fill(-1);
    for (const [c, p] of lab.owner) owner[c] = p;
    const d = GLB.readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, slug, "stabilized.glb")))).descriptor;
    const grid = G.gridFromDescriptor(d, { names: lab.names, owner });
    if (version === "original") for (let c = 0; c < 1000; c++) if (grid.occ[c] && grid.role[c] !== 0) { grid.occ[c] = 0; grid.role[c] = 0; grid.step[c] = 0; grid.label[c] = -1; }
    const analysis = await analyseGrid(grid);
    const scene = S.buildScene(grid, { name: slug, summary: analysis.summary, issues: sceneIssues(analysis) });
    return { grid, analysis, scene };
}

/** One edit applied to `grid`, saved as a file: the descriptor and the log. */
async function editOnce({ grid, scene, analysis }, answer, instruction, { sourceDepth, stabilizedDepth }) {
    const base = G.maxStep(grid);
    const clean = O.cleanAnswer(answer);
    const r = O.applyEdit(grid, clean, scene.regions, base + 1);
    if (!r.ok) throw new Error(`the edit was refused: ${r.reason}`);
    const after = await analyseGrid(r.grid);
    const entry = M.logEntry(1, instruction, clean, r.report, "meta/muse-spark-1.3-contributor", 0.0004);
    const built = await M.buildEditVersion({ baseSteps: base, sourceDepth, stabilizedDepth, entries: [entry], grid: r.grid, beforeSummary: analysis.summary, afterSummary: after.summary, createdAt: new Date().toISOString() });
    return { ...built, grid: r.grid, after, base };
}

// ---------- 1. the endpoint's guards ----------

section("POST /llm/voxel-edit: guards");
const scene = "MODEL: x";
const bad = [
    ["empty instruction -> 400", { instruction: "", scene }],
    ["a blank instruction -> 400", { instruction: "   ", scene }],
    [`instruction over ${CT.EDIT_INSTRUCTION_MAX} characters -> 400`, { instruction: "x".repeat(CT.EDIT_INSTRUCTION_MAX + 1), scene }],
    ["scene that is not a model description -> 400", { instruction: "make it taller", scene: "hello" }],
    ["no scene -> 400", { instruction: "make it taller" }],
    ["scene over the limit -> 400", { instruction: "make it taller", scene: `MODEL: ${"y".repeat(PR.VOXEL_EDIT_SCENE_LIMIT)}` }],
    ["a number instead of text -> 400", { instruction: 5, scene }],
];
for (const [name, body] of bad) check(name, (await post("/llm/voxel-edit", body)).status === 400, String((await post("/llm/voxel-edit", body)).status));
check("GET -> 405", (await api("/llm/voxel-edit")).status === 405);
check("DELETE -> 405", (await api("/llm/voxel-edit", { method: "DELETE" })).status === 405);
check("an unknown task -> 404", (await post("/llm/not-a-task", { instruction: "a", scene })).status === 404);
const big = await api("/llm/voxel-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "a", scene: `MODEL: ${"x".repeat(20000)}` }) });
check("body over 16 KB -> 413", big.status === 413 || big.status === 400, String(big.status));
const notJson = await api("/llm/voxel-edit", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
check("not JSON -> 400", notJson.status === 400);

if (process.env.NO_KEY === "1") {
    const r = await post("/llm/voxel-edit", { instruction: "make it taller", scene });
    check("no key (and no mock) -> 503", r.status === 503, `${r.status} ${JSON.stringify(r.body)}`);
    check("the 503 says what is wrong in plain words", /not set up/.test(r.body?.error ?? ""));
} else if (process.env.LIVE === "1") {
    const lamp = await loadExample("desk-lamp");
    const t0 = Date.now();
    const r = await post("/llm/voxel-edit", { instruction: "make the base wider", scene: lamp.scene.text });
    check("a real call answers 200 in time", r.status === 200 && Date.now() - t0 < 60_000, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    const a = r.body?.answer;
    check("the answer has the schema's four fields, and the cost is reported", a && typeof a.summary === "string" && Array.isArray(a.ops) && typeof r.body.model === "string" && (r.body.cost_usd === null || r.body.cost_usd < 0.01), JSON.stringify(r.body).slice(0, 300));
    const clean = O.cleanAnswer(a);
    const applied = clean && O.applyEdit(lamp.grid, clean, lamp.scene.regions, G.maxStep(lamp.grid) + 1);
    check("the browser's cleaning and applying accepts it", !!applied && applied.ok, applied && !applied.ok ? applied.reason : "");
    console.log(`   ${r.body?.ms} ms, ${r.body?.prompt_tokens} + ${r.body?.completion_tokens} tokens, $${r.body?.cost_usd}; ${JSON.stringify(a?.summary)}`);
} else {
    const r = await post("/llm/voxel-edit", { instruction: "make it taller", scene });
    check("the mock answers 200 with the schema's shape", r.status === 200 && Array.isArray(r.body?.answer?.ops) && typeof r.body.answer.summary === "string" && r.body.model === "mock", `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    const op0 = r.body?.answer?.ops?.[0];
    check("its operation has every field of the schema", op0 && ["op", "region", "box", "dirs", "amount", "axis", "at", "plane", "offset", "wall", "include_added"].every((k) => k in op0), JSON.stringify(op0));
    const lamp = await loadExample("desk-lamp");
    const clean = O.cleanAnswer(r.body?.answer);
    const applied = clean && O.applyEdit(lamp.grid, clean, lamp.scene.regions, G.maxStep(lamp.grid) + 1);
    check("the browser can clean and apply it", !!applied && applied.ok && applied.report.added > 0, applied && !applied.ok ? applied.reason : "");
    if (process.env.LIMIT) {
        const limit = Number(process.env.LIMIT);
        // the calls above already used some of today's slots; call until the limit says no
        let status = 200;
        let calls = 1;
        while (status === 200 && calls < limit + 3) { status = (await post("/llm/voxel-edit", { instruction: "again", scene })).status; calls++; }
        check(`the daily limit (${limit}) stops the calls with a 429`, status === 429 && calls <= limit + 2, `status ${status} after ${calls} calls`);
        const r429 = await post("/llm/voxel-edit", { instruction: "again", scene });
        check("the 429 says so in plain words", /limit/i.test(r429.body?.error ?? ""), JSON.stringify(r429.body));
        const bad400 = await post("/llm/voxel-edit", { instruction: "", scene });
        check("a bad request is still a 400 when the day is used up (it is checked first)", bad400.status === 400);
    }
}

if (process.env.NO_KEY === "1" || process.env.LIVE === "1" || process.env.LIMIT) {
    console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
    process.exit(failures.length ? 1 : 0);
}

// ---------- 2. the storage of an edited version ----------

section("POST /models/:id/derived: an edit of a stabilized version");
const slug = "pencil-leg-chair";
const created = await post("/projects/from-example", { slug });
check("project from an example", created.status === 201, JSON.stringify(created.body).slice(0, 200));
const project = created.body.project;
const original = project.models.find((m) => m.kind === "example");
const twin = project.models.find((m) => m.kind === "stabilized");
check("the example project has both models", !!original && !!twin);
check("every model carries edit: null", project.models.every((m) => m.edit === null || m.edit === undefined));

const chair = await loadExample(slug);
const v1 = await editOnce(chair, answerOf("T10a"), "move the backrest one block towards the front", { sourceDepth: 1, stabilizedDepth: twin.derived.depth });
const bytes1 = GLB.writeAssemblyGlb(v1.descriptor, null, v1.log);
const up1 = await glb(`/models/${twin.id}/derived`, bytes1);
check("the edited version is stored (201)", up1.status === 201, JSON.stringify(up1.body).slice(0, 300));
const m1 = up1.body.model;
check("kind edited, provider editor, source set", m1?.kind === "edited" && m1.provider === "editor" && m1.source_model_id === twin.id, JSON.stringify(m1)?.slice(0, 200));
check("the slim edit summary is returned, built by the server", m1?.edit?.target === "voxel" && m1.edit.depth === 2 && m1.edit.entries.length === 1 && m1.edit.entries[0].instruction.startsWith("move the backrest") && m1.edit.entries[0].ops === undefined, JSON.stringify(m1?.edit)?.slice(0, 300));
check("the version's name is the instruction, tidied", /^Move the backrest/.test(m1?.edit?.label ?? ""), m1?.edit?.label);
check("the verdict is stored with the model", m1?.analysis?.blocks === v1.after.summary.blocks && m1.analysis.errors === v1.after.summary.errors);
check("derived is null for an edited model", m1?.derived === null);
const again = await glb(`/models/${twin.id}/derived`, bytes1);
check("the same edit again returns the stored model (200)", again.status === 200 && again.body.model.id === m1.id);

section("refusals");
const tamper = (mutate) => {
    const log = structuredClone(v1.log);
    mutate(log);
    return GLB.writeAssemblyGlb(v1.descriptor, null, log);
};
async function refused(name, mutate, expect = 400) {
    let bytes;
    try { bytes = tamper(mutate); } catch { check(`${name} (the writer refuses it)`, true); return; }
    const r = await glb(`/models/${twin.id}/derived`, bytes);
    check(`${name} -> ${expect}`, r.status === expect, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
}
await refused("a log whose counts do not add up", (l) => { l.edits[0].added += 3; });
await refused("a log with the wrong stabilization count", (l) => { l.stabilized_depth = 0; });
await refused("a log whose hash is not the blocks'", (l) => { l.assembly_hash = "0".repeat(64); });
await refused("a log that claims it started from a different model", (l) => { l.before.blocks += 20; l.after.blocks += 0; });
await refused("a log of more edits than the steps hold", (l) => { l.edits[0].moved = 0; l.edits[0].added = 0; l.after.blocks = l.before.blocks - l.edits[0].removed; });
const lying = await glb(`/models/${twin.id}/derived`, tamper((l) => { l.depth = 9; l.created_at = "2026-10-24T10:00:00.000Z"; }));
check("a claimed depth is not believed: the server stores its own count", (lying.status === 201 || lying.status === 200) && lying.body.model.edit.depth === 2, `${lying.status} ${JSON.stringify(lying.body).slice(0, 160)}`);
const wrongType = await api(`/models/${twin.id}/derived`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("wrong content type -> 415", wrongType.status === 415);
check("an unknown source -> 404", (await glb("/models/00000000-0000-4000-8000-000000000000/derived", bytes1)).status === 404);
const withTwoLogs = (() => { try { return GLB.writeAssemblyGlb(v1.descriptor, structuredClone(twin.derived), v1.log); } catch { return null; } })();
if (withTwoLogs) check("a file with two logs -> 400", (await glb(`/models/${twin.id}/derived`, withTwoLogs)).status === 400);
else check("a file with two logs cannot be written", true);

section("an edit of an edit, and a stabilization of an edit");
const grid1 = G.gridFromDescriptor(v1.descriptor, G.labelsFromString(v1.log.parts, v1.log.labels, v1.descriptor));
const issues1 = sceneIssues(v1.after);
const second = { grid: grid1, analysis: v1.after, scene: S.buildScene(grid1, { name: "chair (edited)", summary: v1.after.summary, issues: issues1 }) };
const ans2 = { summary: "Added a column under the front left corner of the seat.", notes: "", clarification: "", ops: [op({ op: "add", box: [2, 2, 0, 2, 2, 1] })] };
const v2 = await editOnce(second, ans2, "add a column under the front left corner of the seat", { sourceDepth: 2, stabilizedDepth: 1 });
const up2 = await glb(`/models/${m1.id}/derived`, GLB.writeAssemblyGlb(v2.descriptor, null, v2.log));
check("an edit of an edited version is stored, one level deeper", up2.status === 201 && up2.body.model?.edit?.depth === 3, JSON.stringify(up2.body).slice(0, 300));
const m2 = up2.body.model;

const solver = await loadStabilizerSolver();
const cellsOf = (d) => { const out = []; for (let n = 0; n < d.cells.length; n += 5) out.push([d.cells[n], d.cells[n + 1], d.cells[n + 2]]); return out; };
const stabilizeOf = (descriptor, sourceDepth) => stabilize({ cells: cellsOf(descriptor), settings: normalizeSettings({}), options: { ...DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000 }, assembly: descriptor }, sourceDepth, { solver });
const st = await stabilizeOf(v1.descriptor, v1.log.stabilized_depth);
const upS = await glb(`/models/${m1.id}/derived`, st.glb);
check("a stabilization of an edited version is stored", upS.status === 201, JSON.stringify(upS.body).slice(0, 300));
check("it is kind stabilized, and the edit does not use up a stabilization (this is the second)", upS.body.model?.kind === "stabilized" && upS.body.model.derived?.depth === 2 && upS.body.model.edit === null, JSON.stringify(upS.body.model?.derived)?.slice(0, 120));
const wrongDepth = structuredClone(st.meta);
wrongDepth.depth = 1;
const wd = await glb(`/models/${m1.id}/derived`, GLB.writeAssemblyGlb(st.descriptor, wrongDepth));
check("a stabilization log with the wrong depth for an edited source -> 400/409", wd.status === 400 || wd.status === 409, String(wd.status));

section("the project, the payload and delete");
const detail = await api(`/projects/${project.id}`);
const models = detail.body.project.models;
check("the project lists 5 models (example, twin, two edits, a stabilized edit)", models.length === 5, String(models.length));
const edited = models.filter((m) => m.kind === "edited");
check("two edited models with slim summaries and no operations", edited.length === 2 && edited.every((m) => m.edit && m.edit.entries[0].instruction && !("ops" in m.edit.entries[0])));
const kb = JSON.stringify(detail.body).length / 1024;
console.log(`   project payload ${kb.toFixed(1)} KB`);
check("the payload stays small", kb < 60, `${kb.toFixed(1)} KB`);
const del = await api(`/models/${m1.id}`, { method: "DELETE" });
check("delete an edited version -> 200", del.status === 200);
const after = (await api(`/projects/${project.id}`)).body.project.models;
check("its descendants went with it (the second edit and the stabilized edit)", after.length === 2 && !after.some((m) => m.id === m2.id), String(after.length));
check("the roots cannot be deleted", (await api(`/models/${original.id}`, { method: "DELETE" })).status === 409);

section("an edit of the UNSTABLE original, then stabilizing it");
{
    const dino = await api("/projects/from-example", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "long-neck-dino" }) });
    const orig = dino.body.project.models.find((m) => m.kind === "example");
    const ex = await loadExample("long-neck-dino", "original");
    const v5 = await editOnce(ex, answerOf("T5a"), "the arm is too long", { sourceDepth: 0, stabilizedDepth: 0 });
    const up5 = await glb(`/models/${orig.id}/derived`, GLB.writeAssemblyGlb(v5.descriptor, null, v5.log));
    check("an edit of the original is stored, made from a root (depth 1)", up5.status === 201 && up5.body.model?.source_model_id === orig.id && up5.body.model.edit?.depth === 1, JSON.stringify(up5.body).slice(0, 240));
    check("its verdict: one problem before, none after", ex.analysis.summary.errors === 1 && up5.body.model?.analysis?.errors === 0);
    const st5 = await stabilizeOf(v5.descriptor, 0);
    const upS5 = await glb(`/models/${up5.body.model.id}/derived`, st5.glb);
    check("stabilizing an edit of the original: stored as the first stabilization", upS5.status === 201 && upS5.body.model?.derived?.depth === 1, JSON.stringify(upS5.body).slice(0, 200));
    const bogus = await editOnce(ex, answerOf("T5a"), "the arm is too long", { sourceDepth: 0, stabilizedDepth: 0 });
    bogus.log.base_steps = 4;
    let bytes;
    try { bytes = GLB.writeAssemblyGlb(bogus.descriptor, null, bogus.log); } catch { bytes = null; }
    if (bytes) check("an edit of a mesh that claims earlier steps -> 400", (await glb(`/models/${orig.id}/derived`, bytes)).status === 400);
}

section("the limits");
{
    const lamp = await api("/projects/from-example", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "desk-lamp" }) });
    const src2 = lamp.body.project.models.find((m) => m.kind === "stabilized");
    const ex = await loadExample("desk-lamp");
    let stored = 0;
    let last = null;
    // different edits of the same source, up to the cap of versions per source
    for (let n = 0; n < CT.MAX_VERSIONS_PER_SOURCE + 1; n++) {
        const answer = { summary: `Added block ${n}.`, notes: "", clarification: "", ops: [op({ op: "add", box: [n % 10, 9 - Math.floor(n / 10), 0, n % 10, 9 - Math.floor(n / 10), 0] })] };
        const r = O.applyEdit(ex.grid, O.cleanAnswer(answer), ex.scene.regions, G.maxStep(ex.grid) + 1);
        if (!r.ok || r.report.added === 0) continue;
        const v = await editOnce(ex, answer, `add block ${n}`, { sourceDepth: 1, stabilizedDepth: src2.derived.depth });
        last = await glb(`/models/${src2.id}/derived`, GLB.writeAssemblyGlb(v.descriptor, null, v.log));
        if (last.status === 201) stored++;
        else break;
    }
    check(`a source takes at most ${CT.MAX_VERSIONS_PER_SOURCE} versions, then says so (429, the cap's status)`, last !== null && (last.status === 429 || last.status === 409) && stored === CT.MAX_VERSIONS_PER_SOURCE, `${stored} stored, last ${last?.status} ${JSON.stringify(last?.body).slice(0, 120)}`);
}

console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
