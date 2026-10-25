// The live check of changing the blocks by words: the instructions of the acceptance suite are sent to the AI editor (Muse Spark via OpenRouter)
// through a Worker that has a real key, and each answer is cleaned, applied and judged by objective predicates (what must be filled, what must stay,
// how big the change may be). It costs real money: 7 calls, about $0.0035 in all, 4 to 21 s each.
//
//   LIVE=1 BASE=http://127.0.0.1:8733 node scripts/assignment/live-voxel-edit.mjs
//   (the server: a `wrangler dev` whose .dev.vars has OPENROUTER_API_KEY and no MOCK_PROVIDER, or MOCK_LLM=0)
//   HUNYUAN=<path to a Hunyuan GLB>  adds the single-mesh case (no part names); LIVE_OUT=<file> writes every call and its answer as JSON.
//
// The cases: the five of the first live round on the production wording of the scene and the refined `stretch` text (a chair column, an oak trunk 2
// taller, a wider lamp base, a hollow mushroom, the dino's arm that is too long), one model with no parts, and a second turn that sees the first
// (EARLIER EDITS). The key is never read here: only the server has it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
if (process.env.LIVE !== "1") {
    console.log("This sends real requests to a paid model (7 calls, about $0.0035). Run it with LIVE=1 and BASE=<a server that has the key>.");
    process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8733").replace(/\/$/, "");
const src = (p) => import(path.join(root, "src/assignment", p));
const G = await src("shared/voxelEdit/grid.ts");
const O = await src("shared/voxelEdit/ops.ts");
const S = await src("shared/voxelEdit/scene.ts");
const GLB = await src("shared/assemblyGlb.ts");
const { descriptorFromBlocks } = await src("shared/assembly.ts");
const AN = await src("analysis/assembly.ts");
const WS = await src("analysis/withStress.ts");
const { runAnalysis } = await src("analysis/runAnalysis.ts");
const { normalizeSettings } = await src("analysis/settings.ts");

const EX = path.join(root, "public/assignment_alex/examples");
const cache = JSON.parse(readFileSync(path.join(here, "fixtures/voxel-edit/labels-cache.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(EX, "manifest.json"), "utf8")).examples;

const analyseGrid = (g) => WS.withStress(AN.analyzeAssembly(G.descriptorOfGrid(g), null, {}));
const sceneIssues = (result) => result.issues.map((i) => ({ severity: i.severity, title: i.title, cells: i.blocks.map((b) => result.blocks[b].cell) }));
const has = (g, i, j, k) => g.occ[G.code(i, j, k)] === 1;
const cellsWhere = (g, f) => { const r = []; for (let c = 0; c < 1000; c++) if (g.occ[c] && f(c)) r.push(c); return r; };
const removedCells = (a, b) => cellsWhere(a, (c) => !b.occ[c]);
const addedCells = (a, b) => cellsWhere(b, (c) => !a.occ[c]);
const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const pieceCount = (g) => {
    const seen = new Uint8Array(1000);
    let n = 0;
    for (let c0 = 0; c0 < 1000; c0++) {
        if (!g.occ[c0] || seen[c0]) continue;
        n++;
        const st = [c0]; seen[c0] = 1;
        while (st.length) {
            const c = st.pop();
            for (const [a, b, d] of NB) { const i = G.iOf(c) + a, j = G.jOf(c) + b, k = G.kOf(c) + d; if (!G.inGrid(i, j, k)) continue; const cc = G.code(i, j, k); if (g.occ[cc] && !seen[cc]) { seen[cc] = 1; st.push(cc); } }
        }
    }
    return n;
};

/** An example as the app shows it to the editor: labelled grid, analysis, scene (named like store/voxelEditLogic.ts sceneNameOf). */
async function loadExample(slug, version, history = []) {
    const lab = cache[slug];
    const owner = new Int8Array(1000).fill(-1);
    for (const [c, p] of lab.owner) owner[c] = p;
    const d = GLB.readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, slug, "stabilized.glb")))).descriptor;
    const grid = G.gridFromDescriptor(d, { names: lab.names, owner });
    if (version === "original") for (let c = 0; c < 1000; c++) if (grid.occ[c] && grid.role[c] !== 0) { grid.occ[c] = 0; grid.role[c] = 0; grid.step[c] = 0; grid.label[c] = -1; }
    const prompt = manifest.find((m) => m.slug === slug).prompt.slice(0, 60);
    const name = `${prompt} (${version === "original" ? "original blocks, not stabilized" : "stabilized version"})`;
    const analysis = await analyseGrid(grid);
    return { grid, analysis, name, scene: S.buildScene(grid, { name, summary: analysis.summary, issues: sceneIssues(analysis), history }) };
}

/** A model with no parts: a single mesh voxelised as the app does (a Hunyuan GLB), geometry only. */
async function loadSingleMesh(file) {
    const { NodeIO } = await import("@gltf-transform/core");
    const doc = await new NodeIO().read(file);
    const rootNode = doc.getRoot();
    const prim = rootNode.listMeshes()[0].listPrimitives()[0];
    const node = rootNode.listNodes()[0];
    const [x, y, z, w] = node.getRotation();
    const s = node.getScale(), t = node.getTranslation();
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    const pos = prim.getAttribute("POSITION").getArray();
    const idx = prim.getIndices().getArray();
    const P = new Float32Array(pos.length);
    for (let i = 0; i < pos.length / 3; i++) {
        const px = pos[i * 3] * s[0], py = pos[i * 3 + 1] * s[1], pz = pos[i * 3 + 2] * s[2];
        const gx = R[0] * px + R[1] * py + R[2] * pz + t[0], gy = R[3] * px + R[4] * py + R[5] * pz + t[1], gz = R[6] * px + R[7] * py + R[8] * pz + t[2];
        P[i * 3] = gx; P[i * 3 + 1] = -gz; P[i * 3 + 2] = gy; // glTF Y-up -> Z-up
    }
    const soup = new Float32Array(idx.length * 3);
    for (let n = 0; n < idx.length; n++) soup.set(P.subarray(idx[n] * 3, idx[n] * 3 + 3), n * 3);
    const result = await runAnalysis(() => ({ positions: soup }), normalizeSettings({}), { cacheKey: "live:single-mesh" });
    const descriptor = descriptorFromBlocks(result.blocks.map((b) => ({ cell: [b.cell[0], b.cell[1], b.cell[2]] })));
    const grid = G.gridFromDescriptor(descriptor, null);
    const analysis = await analyseGrid(grid);
    const name = "a rocking chair from a text-to-3D model (original blocks, not stabilized)";
    return { grid, analysis, name, scene: S.buildScene(grid, { name, summary: analysis.summary, issues: sceneIssues(analysis) }) };
}

const calls = [];
let totalCost = 0;
async function ask(label, ex, instruction) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/api/assignment_alex/llm/voxel-edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction, scene: ex.scene.text }) });
    const body = await res.json().catch(() => null);
    const record = { label, instruction, status: res.status, ms: Date.now() - t0, scene_chars: ex.scene.text.length, response: body };
    calls.push(record);
    if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 200)}`);
    totalCost += body.cost_usd ?? 0;
    return body;
}

const CASES = [
    {
        id: "T2", slug: "pencil-leg-chair", version: "stabilized", text: "add a column under the front left corner of the seat",
        check: (a, b) => { const add = addedCells(a, b); return [["(2,2,0) and (2,2,1) now filled", has(b, 2, 2, 0) && has(b, 2, 2, 1)], ["only added, nothing removed", removedCells(a, b).length === 0], ["small edit (<= 6 new blocks)", add.length >= 1 && add.length <= 6], ["new blocks near the front-left corner", add.every((c) => G.iOf(c) <= 3 && G.jOf(c) <= 3)]]; },
    },
    {
        id: "T1", slug: "oak-tree", version: "stabilized", text: "make the trunk 2 blocks taller",
        check: (a, b) => { const fol = cellsWhere(b, (c) => b.label[c] === 3); const was = cellsWhere(a, (c) => a.label[c] === 3).length; return [["trunk column (3,5) k0-3 present", [0, 1, 2, 3].every((k) => has(b, 3, 5, k))], ["foliage lifted to k>=5", Math.min(...fol.map(G.kOf)) >= 5], ["foliage block count unchanged", fol.length === was], ["nothing lost (blocks >= 91)", G.countBlocks(b) >= 91]]; },
    },
    {
        id: "T4", slug: "desk-lamp", version: "stabilized", text: "make the base wider",
        check: (a, b) => {
            const add = addedCells(a, b); const baseCells = cellsWhere(a, (c) => a.label[c] === 0);
            const near = (c) => baseCells.some((q) => Math.abs(G.iOf(q) - G.iOf(c)) <= 1 && Math.abs(G.jOf(q) - G.jOf(c)) <= 1 && Math.abs(G.kOf(q) - G.kOf(c)) <= 1);
            const box = (cs) => [Math.min(...cs.map(G.iOf)), Math.max(...cs.map(G.iOf)), Math.min(...cs.map(G.jOf)), Math.max(...cs.map(G.jOf))];
            const A0 = box(baseCells), B0 = box(cellsWhere(b, (c) => b.label[c] === 0 || (add.includes(c) && near(c))));
            return [["added >= 4 blocks", add.length >= 4], ["nothing removed", removedCells(a, b).length === 0], ["new blocks sit at the base", add.every((c) => G.kOf(c) <= 1 && near(c))], ["base footprint grew", B0[1] - B0[0] > A0[1] - A0[0] || B0[3] - B0[2] > A0[3] - A0[2]]];
        },
    },
    {
        id: "T3", slug: "mushroom-pavilion", version: "stabilized", text: "hollow out the inside, keep a 1 block wall",
        check: (a, b) => {
            const expose = cellsWhere(b, (c) => NB.some(([x, y, z]) => { const i = G.iOf(c) + x, j = G.jOf(c) + y, k = G.kOf(c) + z; return k >= 0 && (i < 0 || j < 0 || k > 9 || i > 9 || j > 9 || !b.occ[G.code(i, j, k)]); })).length;
            return [["removed >= 100 blocks", removedCells(a, b).length >= 100], ["stabilizer blocks kept", cellsWhere(a, (c) => a.role[c] >= 1).every((c) => b.occ[c])], ["still one connected piece", pieceCount(b) === 1], ["inner leftovers <= 12", G.countBlocks(b) - expose <= 12]];
        },
    },
    {
        id: "T5", slug: "long-neck-dino", version: "original", text: "the arm is too long",
        check: (a, b, r, after) => {
            const rem = removedCells(a, b);
            return [["over-limit blocks gone", after && after.summary.over_limit === 0], ["small change (2-12 removed)", rem.length >= 2 && rem.length <= 12], ["nothing added", addedCells(a, b).length === 0], ["legs untouched", cellsWhere(a, (c) => a.label[c] >= 0 && /leg/i.test(a.parts[a.label[c]])).every((c) => b.occ[c])]];
        },
    },
];

const results = [];
let predicates = 0, passedPredicates = 0;
function judge(id, text, a, b, r, after, checks, answer, body) {
    const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
    predicates += checks.length;
    passedPredicates += checks.length - failed.length;
    results.push({ id, text, passed: checks.length - failed.length, total: checks.length, failed });
    console.log(`${id.padEnd(8)} ${checks.length - failed.length}/${checks.length}  ${body.ms} ms  ${body.prompt_tokens}+${body.completion_tokens} tokens  $${(body.cost_usd ?? 0).toFixed(5)}  "${text}"`);
    console.log(`         "${(answer.summary ?? "").slice(0, 110)}"${answer.notes ? `  note: ${answer.notes.slice(0, 90)}` : ""}${answer.clarification ? `  asks: ${answer.clarification.slice(0, 90)}` : ""}`);
    if (failed.length) console.log(`         FAILED: ${failed.join("; ")}`);
    if (r && r.report.rejected.length) console.log(`         rejected: ${r.report.rejected.join(" | ")}`);
}

let chairAfterFirst = null;
for (const T of CASES) {
    const ex = await loadExample(T.slug, T.version);
    const body = await ask(T.id, ex, T.text);
    const answer = body.answer;
    const clean = O.cleanAnswer(answer);
    const r = clean ? O.applyEdit(ex.grid, clean, ex.scene.regions, G.maxStep(ex.grid) + 1) : null;
    const after = r?.ok ? await analyseGrid(r.grid) : null;
    judge(T.id, T.text, ex.grid, r?.ok ? r.grid : ex.grid, r, after, T.check(ex.grid, r?.ok ? r.grid : ex.grid, r, after), answer, body);
    if (T.id === "T2" && r?.ok) chairAfterFirst = { ex, r, after, clean, text: T.text };
}

// the second turn: the editor sees what the first one did
if (chairAfterFirst) {
    const { ex, r, after, clean, text } = chairAfterFirst;
    const history = [{ instruction: text, summary: (clean.summary || "Added a column.").slice(0, 120) }];
    const scene = S.buildScene(r.grid, { name: ex.name, summary: after.summary, issues: sceneIssues(after), history });
    assert.match(scene.text, /EARLIER EDITS/);
    const next = { grid: r.grid, scene };
    const instruction = "now put the same under the front right corner of the seat";
    const body = await ask("T2-turn2", next, instruction);
    const clean2 = O.cleanAnswer(body.answer);
    const r2 = clean2 ? O.applyEdit(r.grid, clean2, scene.regions, G.maxStep(r.grid) + 1) : null;
    const b = r2?.ok ? r2.grid : r.grid;
    const add = addedCells(r.grid, b);
    judge("T2-turn2", instruction, r.grid, b, r2, null, [["(7,2,0) and (7,2,1) now filled", has(b, 7, 2, 0) && has(b, 7, 2, 1)], ["only added, nothing removed", removedCells(r.grid, b).length === 0], ["at most 6 new blocks (none when a stabilizer column already stood there)", add.length <= 6], ["the first column is still there", has(b, 2, 2, 0) && has(b, 2, 2, 1)]], body.answer, body);
}

// a model with no parts
if (process.env.HUNYUAN) {
    const ex = await loadSingleMesh(process.env.HUNYUAN);
    const text = "add a shelf under the seat";
    const body = await ask("single-mesh", ex, text);
    const clean = O.cleanAnswer(body.answer);
    const r = clean ? O.applyEdit(ex.grid, clean, ex.scene.regions, 1) : null;
    const b = r?.ok ? r.grid : ex.grid;
    const add = addedCells(ex.grid, b);
    const lo = [9, 9, 9], hi = [0, 0, 0];
    for (let c = 0; c < 1000; c++) if (ex.grid.occ[c]) { const p = [G.iOf(c), G.jOf(c), G.kOf(c)]; for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p[q]); hi[q] = Math.max(hi[q], p[q]); } }
    const inside = add.every((c) => G.iOf(c) >= lo[0] && G.iOf(c) <= hi[0] && G.jOf(c) >= lo[1] && G.jOf(c) <= hi[1]);
    judge("single", text, ex.grid, b, r, null, [["the answer applied", !!r?.ok], ["a small change (3 to 60 blocks added)", add.length >= 3 && add.length <= 60], ["inside the footprint of the model", add.length > 0 && inside], ["nothing removed", removedCells(ex.grid, b).length === 0]], body.answer, body);
    console.log(`         scene ${ex.scene.text.length} characters, ${ex.scene.stats.pieces} pieces`);
}

console.log(`\n${passedPredicates}/${predicates} predicates; ${calls.length} calls, $${totalCost.toFixed(5)}, median ${[...calls].map((c) => c.ms).sort((a, b) => a - b)[Math.floor(calls.length / 2)]} ms`);
if (process.env.LIVE_OUT) writeFileSync(process.env.LIVE_OUT, JSON.stringify({ calls, results, totalCost }, null, 1));
process.exit(passedPredicates >= predicates - 1 ? 0 : 1);
