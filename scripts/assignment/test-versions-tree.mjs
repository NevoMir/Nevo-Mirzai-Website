// Tests for the version tree (src/assignment/shared/versionTree.ts): the pure rules behind the top bar's version control, the Models tab's
// tree, the stage (what is drawn, over which mesh) and the composer's routing (what a typed change acts on).
//   node scripts/assignment/test-versions-tree.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const T = await import("../../src/assignment/shared/versionTree.ts");

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

// ---------- fixtures ----------
const at = (minute) => `2026-10-25T03:${String(minute).padStart(2, "0")}:00Z`;
const root = (id, minute, provider = "hunyuan", kind = "generated") => ({ id, kind, source_model_id: null, created_at: at(minute), provider, derived: null, edit: null, optimization: null });
const stab = (id, src, minute, depth = 1) => ({ id, kind: "stabilized", source_model_id: src, created_at: at(minute), provider: "stabilizer", derived: { depth }, edit: null, optimization: null });
const edit = (id, src, minute, target, label = "Taller back", extra = {}) => ({
    id, kind: "edited", source_model_id: src, created_at: at(minute),
    provider: target === "voxel" ? "editor" : (extra.provider ?? "hunyuan"), derived: null, optimization: null,
    edit: { target, label, stabilized_depth: extra.stabilized_depth ?? 0 },
});
const opt = (id, src, minute, shape_changed, title = "Lightest", stabilized_depth = 1) => ({
    id, kind: "optimized", source_model_id: src, created_at: at(minute), provider: "optimizer", derived: null, edit: null,
    optimization: { shape_changed, title, stabilized_depth },
});

// Scenario A: a Hunyuan original -> mesh edit "Taller back" -> stabilized -> optimized (kept the outside) and one that thinned the outside;
// plus a second branch: a block edit of the original, stabilized again.
const A = [
    root("o", 1),
    edit("e1", "o", 2, "mesh"),
    stab("s1", "e1", 3),
    opt("p1", "s1", 4, true, "Lightest"),
    edit("b1", "o", 5, "voxel", "Shelf"),
    stab("s2", "b1", 6, 1),
    opt("p2", "s1", 7, false, "Strongest"),
];
const by = (list, id) => list.find((m) => m.id === id);

await test("root, parent, children and the ordinal by creation time", () => {
    assert.equal(T.rootOf(A, by(A, "p1")).id, "o");
    assert.equal(T.rootOf(A, by(A, "o")).id, "o");
    assert.equal(T.parentOf(A, by(A, "p1")).id, "s1");
    assert.equal(T.parentOf(A, by(A, "o")), null);
    assert.deepEqual(T.childrenOf(A, "o").map((m) => m.id), ["e1", "b1"]);
    assert.deepEqual(T.versionsBelow(A, "o").map((m) => m.id), ["e1", "s1", "p1", "b1", "s2", "p2"]);
    assert.deepEqual(T.descendantsOf(A, "o").map((m) => m.id), ["p2", "s2", "b1", "p1", "s1", "e1"], "newest first");
    assert.deepEqual([T.ordinalOf(A, by(A, "o")), T.ordinalOf(A, by(A, "e1")), T.ordinalOf(A, by(A, "p2"))], [1, 2, 7]);
    assert.equal(T.ordinalMap(A).get("s2"), 6);
});

await test("titles: v1 is the root, the others are numbered by creation and named after what they are", () => {
    assert.equal(T.versionName(by(A, "o")), "Original");
    assert.equal(T.versionTitle(A, by(A, "s1")), "v3 · Stabilized");
    assert.equal(T.versionTitle(A, by(A, "p1")), "v4 · Lightest");
    assert.equal(T.versionTitle(A, by(A, "e1")), "v2 · Taller back");
    assert.equal(T.versionName({ ...by(A, "e1"), edit: null }), "Edited", "an unreadable meta still gets a word");
    assert.equal(T.versionName({ ...by(A, "p1"), optimization: null }), "Optimized");
    assert.equal(T.versionName({ ...by(A, "e1"), edit: { target: "mesh", label: "   " } }), "Edited", "a blank label is no name");
});

await test("representation: a mesh or a block assembly", () => {
    for (const id of ["o", "e1"]) assert.equal(T.representation(by(A, id)), "mesh", id);
    for (const id of ["b1", "s1", "p1"]) assert.equal(T.representation(by(A, id)), "blocks", id);
    assert.equal(T.representation(edit("d", "o", 2, "design")), "mesh");
    assert.equal(T.representation({ ...edit("x", "o", 2, "voxel"), edit: null }), "mesh", "an unreadable edit meta reads as a mesh, as on the server");
    assert.equal(T.representation(root("ex", 1, "example", "example")), "mesh");
    assert.equal(T.isBlockVersion(by(A, "s1")), true);
    assert.equal(T.isBlockVersion(by(A, "o")), false);
});

await test("stage: a mesh shows itself; a stabilized version sits on the (edited) mesh it was made from", () => {
    assert.equal(T.stageOf(A, by(A, "o")).own, true);
    assert.equal(T.stageOf(A, by(A, "e1")).display.id, "e1");
    const s1 = T.stageOf(A, by(A, "s1"));
    assert.deepEqual([s1.display.id, s1.own], ["e1", false], "the stabilizer worked on the edited mesh");
});

await test("stage: a block edit, and everything made from it, shows its own blocks", () => {
    assert.equal(T.stageOf(A, by(A, "b1")).own, true);
    const s2 = T.stageOf(A, by(A, "s2"));
    assert.deepEqual([s2.display.id, s2.own], ["s2", true]);
    assert.equal(T.meshBaseOf(A, by(A, "s2")), null);
});

await test("stage: an optimization stays on the original mesh whether or not it changed the outside (only a block edit by words leaves it)", () => {
    const p1 = T.stageOf(A, by(A, "p1"));
    assert.deepEqual([p1.display.id, p1.own], ["e1", false]);
    const p2 = T.stageOf(A, by(A, "p2"));
    assert.deepEqual([p2.display.id, p2.own], ["e1", false]);
    assert.equal(T.meshBaseOf(A, by(A, "p2")).id, "e1");
    const L = [...A, stab("s3", "p1", 8, 2)];
    assert.deepEqual([T.stageOf(L, by(L, "s3")).display.id, T.stageOf(L, by(L, "s3")).own], ["e1", false]);
});

await test("stage: an optimization straight from the original sits on the original's mesh", () => {
    const L = [root("r", 1), opt("q", "r", 2, false, "Lightest", 0)];
    const q = T.stageOf(L, L[1]);
    assert.deepEqual([q.display.id, q.own], ["r", false]);
});

await test("stage: a design or mesh edit is its own mesh; a version of a design edit sits on it", () => {
    const L = [root("m", 1, "muse"), edit("d1", "m", 2, "design", "Cup holder", { provider: "muse" }), stab("sd", "d1", 3)];
    assert.deepEqual([T.stageOf(L, L[1]).display.id, T.stageOf(L, L[1]).own], ["d1", true]);
    assert.deepEqual([T.stageOf(L, L[2]).display.id, T.stageOf(L, L[2]).own], ["d1", false]);
});

await test("orphans and loops: a version with no parent stands alone; a loop has no root; nothing hangs", () => {
    const orphan = [opt("x", "gone", 1, false)];
    assert.equal(T.rootOf(orphan, orphan[0]), null);
    assert.equal(T.ordinalOf(orphan, orphan[0]), 1);
    assert.equal(T.stageOf(orphan, orphan[0]).own, true);
    assert.equal(T.versionTitle(orphan, orphan[0]), "Lightest", "no number without a root");
    assert.equal(T.headOf(orphan, orphan[0]), null);
    const loop = [edit("a", "b", 1, "voxel"), edit("b", "a", 2, "voxel")];
    assert.equal(T.rootOf(loop, loop[0]), null);
    assert.equal(T.meshBaseOf(loop, loop[0]), null);
    assert.equal(T.chainDepth(loop, loop[0]), 1, "stops at the first repeat");
    const self = [stab("z", "z", 1)];
    assert.equal(T.rootOf(self, self[0]), null);
    assert.equal(T.parentOf(self, self[0]).id, "z");
    assert.deepEqual(T.subtreeIds(self, "z"), ["z"]);
});

await test("head: the version on screen, else the one seen last in the family, else the newest; [ and ] walk the tree", () => {
    T.forgetHeads();
    assert.equal(T.headOf(A, by(A, "o")).id, "p2", "from the original: the newest");
    T.rememberHead(A, by(A, "s1"));
    assert.equal(T.headOf(A, by(A, "o")).id, "s1", "the one seen last");
    assert.equal(T.headOf(A, by(A, "p1")).id, "p1", "a version is its own head");
    T.rememberHead(A, by(A, "o"));
    assert.equal(T.headOf(A, by(A, "o")).id, "s1", "the original is no head");
    assert.equal(T.stepTarget(A, by(A, "p1"), "parent").id, "s1");
    assert.equal(T.stepTarget(A, by(A, "o"), "parent"), null);
    assert.equal(T.stepTarget(A, by(A, "s1"), "child").id, "p2", "the newest child");
    assert.equal(T.stepTarget(A, by(A, "p1"), "child"), null);
    assert.equal(T.headOf([root("solo", 1)], root("solo", 1)), null, "no version, no head");
    T.forgetHeads();
});

await test("rows: depth first, siblings oldest first, with the connector facts", () => {
    const rows = T.treeRows(A, by(A, "o"));
    assert.equal(rows.map((r) => `${r.model.id}:${r.depth}`).join(), "o:0,e1:1,s1:2,p1:3,p2:3,b1:1,s2:2");
    const row = (id) => rows.find((r) => r.model.id === id);
    assert.deepEqual([row("e1").last, row("b1").last, row("o").last], [false, true, true]);
    assert.deepEqual(row("s1").lines, [true], "e1 has a later sibling (b1): its line runs past s1");
    assert.deepEqual(row("s2").lines, [false], "b1 is the last child: no line");
    assert.deepEqual(row("p1").lines, [true, false], "e1 continues, s1 has no later sibling... p1 is not last");
    assert.equal(row("p1").last, false);
    assert.equal(row("p2").last, true);
});

await test("forest: every model is listed once, newest root first; orphans and cycles stand as roots", () => {
    const L = [root("r1", 1), stab("c1", "r1", 2), root("r2", 3), opt("lost", "gone", 4, true), edit("a", "b", 5, "voxel"), edit("b", "a", 6, "voxel")];
    const forest = T.forestOf(L);
    const ids = forest.flatMap((f) => f.rows.map((r) => r.model.id));
    assert.equal(ids.length, L.length, "nothing is hidden");
    assert.equal(new Set(ids).size, L.length, "nothing is listed twice");
    assert.deepEqual(forest.find((f) => f.root.id === "r1").rows.map((r) => r.model.id), ["r1", "c1"]);
    assert.ok(forest.some((f) => f.root.id === "lost"));
    assert.equal(T.forestOf([]).length, 0);
    assert.equal(forest[0].root.id !== "r1", true, "newest first");
});

await test("delete: only versions, and the whole subtree goes", () => {
    assert.deepEqual(T.subtreeIds(A, "e1").sort(), ["e1", "p1", "p2", "s1"].sort());
    assert.deepEqual(T.subtreeIds(A, "p1"), ["p1"]);
    assert.equal(T.canDelete(by(A, "o")), false);
    assert.equal(T.canDelete(root("ex", 1, "example", "example")), false);
    for (const id of ["e1", "s1", "p1", "b1"]) assert.equal(T.canDelete(by(A, id)), true, id);
});

await test("edit target: the blocks on the Stability and Optimization tabs, whatever the version", () => {
    for (const tab of ["analysis", "optimize"]) {
        for (const m of A) assert.deepEqual(T.editTargetFor(A, m, tab), { target: "voxel", reason: null }, `${m.id} on ${tab}`);
    }
    const muse = [root("m", 1, "muse")];
    assert.equal(T.editTargetFor(muse, muse[0], "analysis").target, "voxel", "a Muse mesh is voxelised: that is the unstable block version");
});

await test("edit target on 3D and Models: the parts of a Muse design, the mesh of any other generated model, the blocks of a block version", () => {
    const M = [root("m", 1, "muse"), edit("d1", "m", 2, "design", "Cup holder", { provider: "muse" }), stab("sd", "d1", 3), edit("d2", "d1", 4, "design", "Paint", { provider: "muse" })];
    assert.equal(T.editTargetFor(M, M[0], "3d").target, "design");
    assert.equal(T.editTargetFor(M, M[1], "3d").target, "design", "a design edit is edited as a design again");
    assert.equal(T.editTargetFor(M, M[3], "models").target, "design");
    assert.equal(T.editTargetFor(M, M[2], "3d").target, "voxel", "a stabilized version has no mesh of its own");
    assert.equal(T.editTargetFor(A, by(A, "o"), "3d").target, "mesh", "a Hunyuan model");
    assert.equal(T.editTargetFor(A, by(A, "e1"), "models").target, "mesh", "a mesh edit is edited as a mesh again");
    assert.equal(T.editTargetFor(A, by(A, "b1"), "3d").target, "voxel");
    assert.equal(T.editTargetFor(A, by(A, "p1"), "3d").target, "voxel");
});

await test("edit target: an example and the offline demo have none, and say why in words; no model has no target", () => {
    const ex = root("ex", 1, "example", "example");
    const none = T.editTargetFor([ex], ex, "3d");
    assert.equal(none.target, null);
    assert.match(none.reason, /Edits work on models you generate/);
    assert.match(none.reason, /Change the blocks/);
    assert.equal(T.editTargetFor([ex], ex, "analysis").target, "voxel", "its blocks can be changed");
    const mock = root("mk", 1, "mock");
    assert.equal(T.editTargetFor([mock], mock, "3d").target, null);
    const nothing = T.editTargetFor([], null, "3d");
    assert.deepEqual([nothing.target, typeof nothing.reason], [null, "string"]);
});

await test("stabilizations on a path and the caps' counters", () => {
    assert.equal(T.stabilizationsOfModel(by(A, "o")), 0);
    assert.equal(T.stabilizationsOfModel(by(A, "s1")), 1);
    assert.equal(T.stabilizationsOfModel(by(A, "p1")), 1);
    assert.equal(T.stabilizationsOfModel(edit("e", "o", 1, "voxel", "x", { stabilized_depth: 2 })), 2);
    assert.equal(T.stabilizationsOfModel({ ...by(A, "s1"), derived: null }, 3), 3, "an unreadable meta counts as the caller's number");
    assert.equal(T.chainDepth(A, by(A, "p1")), 3);
    assert.equal(T.chainDepth(A, by(A, "o")), 0);
    assert.equal(T.versionsOfSource(A, "o"), 2);
    assert.equal(T.versionCount(A), 6);
    assert.equal(T.meshEditCount(A), 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
