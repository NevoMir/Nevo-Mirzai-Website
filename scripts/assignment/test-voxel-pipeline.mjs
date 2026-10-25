// End-to-end check of a block edit through the shared modules, with no server: edit -> log -> GLB -> strict read -> cross-check -> tamper ->
// stabilize the EDITED version -> edit again. What it pins: an edited version is an ordinary assembly the stabilizer can work on (the edit's
// blocks keep their role and step), the file refuses a bit flip in the geometry, cells or roles, and the server-side checks (worker/editChecks.ts,
// worker/derivedChecks.ts with firstRun = false for a source that is already a block assembly) agree with what the browser wrote.
//
//   node scripts/assignment/test-voxel-pipeline.mjs
import assert from "node:assert/strict";
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
const src = (p) => import(path.join(root, "src/assignment", p));
const G = await src("shared/voxelEdit/grid.ts");
const O = await src("shared/voxelEdit/ops.ts");
const S = await src("shared/voxelEdit/scene.ts");
const M = await src("shared/voxelEdit/meta.ts");
const LOG = await src("shared/voxelEdit/log.ts");
const A = await src("shared/assembly.ts");
const GLB = await src("shared/assemblyGlb.ts");
const AN = await src("analysis/assembly.ts");
const WS = await src("analysis/withStress.ts");
const { stabilize, loadStabilizerSolver } = await src("analysis/stabilize/stabilize.ts");
const { DEFAULT_STABILIZE_OPTIONS } = await src("analysis/stabilize/types.ts");
const { normalizeSettings } = await src("analysis/settings.ts");
const { crossCheckVoxelEdit } = await import(path.join(root, "worker/editChecks.ts"));
const { crossCheckDerived } = await import(path.join(root, "worker/derivedChecks.ts"));

const EX = path.join(root, "public/assignment_alex/examples");
const FIX = path.join(here, "fixtures/voxel-edit");
const cache = JSON.parse(readFileSync(path.join(FIX, "labels-cache.json"), "utf8"));
const answerOf = (tag) => JSON.parse(JSON.parse(readFileSync(path.join(FIX, "runs", `${tag}.json`), "utf8")).content);

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).split("\n").slice(0, 4).join("\n").replace(/^/gm, "       ")}`);
    }
}

const analyse = (g) => WS.withStress(AN.analyzeAssembly(G.descriptorOfGrid(g), null, {}));
const sceneIssues = (result) => result.issues.map((i) => ({ severity: i.severity, title: i.title, cells: i.blocks.map((b) => result.blocks[b].cell) }));
async function load(slug, version) {
    const lab = cache[slug];
    const owner = new Int8Array(1000).fill(-1);
    for (const [c, p] of lab.owner) owner[c] = p;
    const d = GLB.readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, slug, "stabilized.glb")))).descriptor;
    const grid = G.gridFromDescriptor(d, { names: lab.names, owner });
    if (version === "original") for (let c = 0; c < 1000; c++) if (grid.occ[c] && grid.role[c] !== 0) { grid.occ[c] = 0; grid.role[c] = 0; grid.step[c] = 0; grid.label[c] = -1; }
    const analysis = await analyse(grid);
    return { grid, analysis, scene: S.buildScene(grid, { name: slug, summary: analysis.summary, issues: sceneIssues(analysis) }) };
}
async function edit(ex, answer, instruction, ctx) {
    const base = G.maxStep(ex.grid);
    const clean = O.cleanAnswer(answer);
    const r = O.applyEdit(ex.grid, clean, ex.scene.regions, base + 1);
    assert.ok(r.ok, r.reason);
    const after = await analyse(r.grid);
    const entry = M.logEntry(1, instruction, clean, r.report, "meta/muse-spark-1.3-contributor", 0.0004);
    const built = await M.buildEditVersion({ baseSteps: base, entries: [entry], grid: r.grid, beforeSummary: ex.analysis.summary, afterSummary: after.summary, createdAt: new Date().toISOString(), ...ctx });
    return { ...built, grid: r.grid, after, base };
}
const cellsOf = (d) => { const out = []; for (let n = 0; n < d.cells.length; n += 5) out.push([d.cells[n], d.cells[n + 1], d.cells[n + 2]]); return out; };

const solver = await loadStabilizerSolver();
const stabilizeOf = (descriptor, sourceDepth) => stabilize({ cells: cellsOf(descriptor), settings: normalizeSettings({}), options: { ...DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000 }, assembly: descriptor }, sourceDepth, { solver });
const cellMap = (d) => { const m = new Map(); for (let n = 0; n < d.cells.length; n += 5) m.set(d.cells.slice(n, n + 3).join(), d.cells.slice(n + 3, n + 5).join()); return m; };

const chair = await load("pencil-leg-chair", "stabilized");
const v1 = await edit(chair, answerOf("T10a"), "move the backrest one block towards the front", { sourceDepth: 1, stabilizedDepth: 1 });
const bytes1 = GLB.writeAssemblyGlb(v1.descriptor, null, v1.log);
const back1 = GLB.readAssemblyGlb(bytes1);

await test("the edited grid is a descriptor the strict parser takes, with the user role", () => {
    assert.ok(A.parseAssemblyDescriptor(v1.descriptor));
    assert.ok(v1.descriptor.cells.some((v, n) => n % 5 === 3 && v === 6), "blocks of role user");
    assert.ok(v1.log.base_steps > 0, "the stabilizer's steps come first");
});
await test("log -> GLB -> strict read: the same descriptor and the same log; the server's cross-check passes", async () => {
    assert.ok(LOG.checkVoxelEditLog(v1.log, null).ok);
    assert.ok(back1.ok && back1.edit && back1.meta === null && back1.optimization === null);
    assert.equal(JSON.stringify(back1.descriptor), JSON.stringify(v1.descriptor));
    assert.equal(JSON.stringify(back1.edit), JSON.stringify(LOG.checkVoxelEditLog(v1.log, null).value));
    assert.equal(crossCheckVoxelEdit(back1.descriptor, back1.edit), null);
    assert.equal(back1.edit.assembly_hash, await A.assemblyHash(back1.descriptor));
    console.log(`       GLB ${bytes1.length} bytes`);
});
await test("a log that does not fit its blocks is refused by the cross-check", () => {
    const counts = structuredClone(back1.edit); counts.edits[0].added += 5;
    assert.ok(crossCheckVoxelEdit(back1.descriptor, counts));
    const dd = structuredClone(back1.descriptor);
    const at = dd.cells.findIndex((v, n) => n % 5 === 3 && v === 6);
    dd.cells[at] = 1;
    assert.ok(crossCheckVoxelEdit(dd, back1.edit), "a block of the edit's step that is not role user");
    const labels = structuredClone(back1.edit); labels.labels = labels.labels.slice(1);
    assert.ok(crossCheckVoxelEdit(back1.descriptor, labels));
});
await test("a single-bit flip in the cells, roles or geometry is refused by the reader (steps and free text are bounded by the cross-check)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const strip = (d) => JSON.stringify(d.cells.filter((_, n) => n % 5 !== 4));
    let accepted = 0, stepOnly = 0;
    for (let q = 0; q < 400; q++) {
        const copy = bytes1.slice();
        copy[Math.floor(rnd() * copy.length)] ^= 1 << Math.floor(rnd() * 8);
        const r = GLB.readAssemblyGlb(copy);
        if (!r.ok) continue;
        if (strip(r.descriptor) === strip(back1.descriptor) && JSON.stringify(r.edit) === JSON.stringify(back1.edit)) stepOnly++;
        else accepted++;
    }
    console.log(`       ${accepted} flips of free text or the hash accepted by the reader, ${stepOnly} that only changed a step number (the server compares the hash and cross-checks the log)`);
    assert.ok(accepted <= 3, `${accepted} accepted`);
});
await test("labels of the wrong length or an unknown part are refused", () => {
    const short = structuredClone(v1.log); short.labels = short.labels.slice(1);
    assert.equal(LOG.checkVoxelEditLog(short, null).ok, false);
    const unknown = structuredClone(v1.log); unknown.parts = unknown.parts.slice(0, 1);
    assert.equal(LOG.checkVoxelEditLog(unknown, null).ok, unknown.labels.split("").every((ch) => ch === "." || ch === "A"));
});

let stabilized;
await test("stabilizing the EDITED version keeps every block's role and step; the stabilization's own checks pass with firstRun = false and fail with true", async () => {
    stabilized = await stabilizeOf(back1.descriptor, back1.edit.stabilized_depth);
    assert.equal(stabilized.meta.depth, back1.edit.stabilized_depth + 1, "the depth counts stabilizations only");
    const before = cellMap(back1.descriptor), after = cellMap(stabilized.descriptor);
    let kept = 0;
    for (const [cell, v] of before) if (after.get(cell) === v) kept++;
    assert.equal(kept, before.size, `${kept}/${before.size} blocks keep their role and step`);
    const back = GLB.readAssemblyGlb(stabilized.glb);
    assert.ok(back.ok && back.meta);
    assert.equal(crossCheckDerived(back.descriptor, back.meta, false), null);
    if (stabilized.meta.added_blocks > 0) assert.ok(crossCheckDerived(back.descriptor, back.meta, true), "firstRun = true would refuse steps carried from an edit (D14)");
    console.log(`       +${stabilized.meta.added_blocks} blocks, ${stabilized.meta.complete ? "complete" : "partial"}, depth ${stabilized.meta.depth}`);
});
await test("the edited and stabilized chair has no problems left", async () => {
    const grid = G.gridFromDescriptor(GLB.readAssemblyGlb(stabilized.glb).descriptor, null);
    const a = await analyse(grid);
    console.log(`       verdicts: stabilized chair ${chair.analysis.summary.errors} problems -> after the edit ${v1.after.summary.errors} -> after stabilizing the edit ${a.summary.errors}`);
    assert.equal(a.summary.errors, 0);
});
await test("an edit of the edited version: the second log starts after the first's steps and is checked against its own base", async () => {
    const labels1 = G.labelsFromString(back1.edit.parts, back1.edit.labels, back1.descriptor);
    const grid1 = G.gridFromDescriptor(back1.descriptor, labels1);
    const ex1 = { grid: grid1, analysis: v1.after, scene: S.buildScene(grid1, { name: "chair (edited)", summary: v1.after.summary, issues: sceneIssues(v1.after) }) };
    const ans = { summary: "Added a column under the front left corner of the seat.", notes: "", clarification: "", ops: [{ op: "add", region: null, box: [2, 2, 0, 2, 2, 1], dirs: null, amount: null, axis: null, at: null, plane: null, offset: null, wall: null, include_added: false }] };
    const v2 = await edit(ex1, ans, "add a column under the front left corner of the seat", { sourceDepth: 2, stabilizedDepth: 1 });
    assert.equal(v2.log.base_steps, G.maxStep(grid1));
    assert.ok(v2.log.base_steps >= v1.log.base_steps + 1);
    const r2 = GLB.readAssemblyGlb(GLB.writeAssemblyGlb(v2.descriptor, null, v2.log));
    assert.ok(r2.ok && r2.edit);
    assert.equal(crossCheckVoxelEdit(r2.descriptor, r2.edit), null);
    assert.equal(r2.edit.before.blocks, back1.edit.after.blocks, "its before is the first edit's after");
});
await test("an edit of the UNSTABLE original starts at step 0, and the edit can then be stabilized (the edit's blocks keep role user)", async () => {
    const dino = await load("long-neck-dino", "original");
    assert.equal(G.maxStep(dino.grid), 0);
    const v = await edit(dino, answerOf("T5a"), "the arm is too long", { sourceDepth: 1, stabilizedDepth: 0 });
    assert.equal(v.log.base_steps, 0);
    assert.equal(v.log.before.errors, 1);
    assert.equal(v.log.after.errors, 0, "the edit fixed the problem");
    const back = GLB.readAssemblyGlb(GLB.writeAssemblyGlb(v.descriptor, null, v.log));
    assert.ok(back.ok);
    assert.equal(crossCheckVoxelEdit(back.descriptor, back.edit), null);
    const st = await stabilizeOf(back.descriptor, 0);
    const out = GLB.readAssemblyGlb(st.glb);
    assert.ok(out.ok && out.meta);
    const before = cellMap(back.descriptor), after = cellMap(out.descriptor);
    for (const [cell, value] of before) assert.equal(after.get(cell), value, `block ${cell} kept its role and step`);
    assert.equal(crossCheckDerived(out.descriptor, out.meta, false), null);
});
await test("whole-model checks: every example edited with its recorded answer round-trips through the file", async () => {
    const cases = [["oak-tree", "stabilized", "T1a"], ["pencil-leg-chair", "stabilized", "T2a"], ["mushroom-pavilion", "stabilized", "T3a"], ["desk-lamp", "stabilized", "T4b"], ["desk-lamp", "stabilized", "T9a"]];
    for (const [slug, version, tag] of cases) {
        const ex = await load(slug, version);
        const v = await edit(ex, answerOf(tag), tag, { sourceDepth: 1, stabilizedDepth: 1 });
        const back = GLB.readAssemblyGlb(GLB.writeAssemblyGlb(v.descriptor, null, v.log));
        assert.ok(back.ok && back.edit, `${slug} ${tag}`);
        assert.equal(crossCheckVoxelEdit(back.descriptor, back.edit), null, `${slug} ${tag}`);
        assert.ok(JSON.stringify(LOG.summarizeVoxelEdit(back.edit, { depth: 2 })).length <= 8 * 1024);
    }
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
