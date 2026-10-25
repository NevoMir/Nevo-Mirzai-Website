// Tests of the optimizer's marks on the block view (src/assignment/viewer/diffLayer.ts, the diff of analysisLayer.ts): the blocks that are gone as ghosts,
// the blocks that are new with a ring, the others dimmed.
//   node scripts/assignment/test-optimize-viewer.mjs
// No browser is needed: the block scene is a three.js scene graph that is read, not drawn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const { createBlocksScene } = await import("../../src/assignment/viewer/analysisLayer.ts");
const { createDiffLayer } = await import("../../src/assignment/viewer/diffLayer.ts");
const THREE = await import("three");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); }
}

/** A 3 x 3 x 2 slab of blocks (18), the analysis the stage would draw. */
function makeAnalysis() {
    const cell = 100;
    const blocks = [];
    for (let k = 0; k < 2; k++) for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) blocks.push({ index: blocks.length, cell: [i, j, k], centerMm: [(i + 0.5) * cell, (j + 0.5) * cell, (k + 0.5) * cell], status: "supported", reach: 0, body: 0, fill: 1, cantilever: null });
    return {
        settings: { targetSizeMm: 1000, blockSizeMm: cell, fillThreshold: 0.3, cantileverLimit: 4, maxBlocks: null },
        gridSize: [10, 10, 10], transform: { factor: 10, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] }, sizeMm: [1000, 1000, 1000], blocks, bodies: [], cantilevers: [], stability: null,
        issues: [], checks: [], stats: { blockCount: blocks.length, groundBlocks: 9, cantileveredCount: 0, longestCantilever: 0, overLimitCount: 0, floatingCount: 0, bodyCount: 1, layers: 2, coverage: 1 },
        summary: {}, stress: null, assembly: null, timingsMs: { voxelize: 0, analyze: 0 },
    };
}
const VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: false, highlight: [] };
const make = (diff, extra = {}) => createBlocksScene({ analysis: makeAnalysis(), view: { ...VIEW, diff }, theme: "light", reducedMotion: true, ...extra });
const root = (s) => s.scene.getObjectByName("blocks:root");
const diffGroup = (s) => root(s).getObjectByName("blocks:diff");
const instanced = (group) => group.children.filter((o) => o.isInstancedMesh);
const blockMeshes = (s) => root(s).getObjectByName("blocks:blocks").children.filter((o) => o.isInstancedMesh);
const counts = (s) => {
    const [dimmed, , active] = [blockMeshes(s).find((m) => m.renderOrder === -3), 0, blockMeshes(s).find((m) => m.renderOrder === 0)];
    const halo = blockMeshes(s).find((m) => m.renderOrder === -2 && m.material.side === THREE.BackSide && m.count !== undefined);
    return { active: active.count, dimmed: dimmed.count, halo };
};
const DIFF = { removed: [[5, 5, 0], [5, 5, 1], [6, 5, 0]], added: [[1, 1, 1]], dimRest: false };

await test("a diff draws the removed blocks as ghosts and the new one with a ring; nothing is drawn without one", () => {
    const plain = make(null);
    assert.equal(diffGroup(plain).visible, false);
    plain.dispose();
    const s = make(DIFF);
    const g = diffGroup(s);
    assert.equal(g.visible, true);
    const [ring, ghosts] = instanced(g);
    assert.equal(ghosts.count, 3);
    assert.equal(ring.count, 1);
    // the first ghost sits at the middle of cell (5, 5, 0), in analysis mm
    const m = new THREE.Matrix4().fromArray(ghosts.instanceMatrix.array, 0);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    assert.deepEqual(p.toArray(), [550, 550, 50]);
    assert.ok(Math.abs(m.elements[0] - 92) < 1e-9, "a ghost fills its cell like a block does");
    const edges = g.children.find((o) => o.isLineSegments);
    assert.equal(edges.geometry.drawRange.count, 3 * 24, "red edges round every ghost");
    // the blocks of the result are all still drawn (the ring is only a ring)
    assert.equal(counts(s).active, 18);
    s.dispose();
});

await test("setView says whether the diff changed; clearing hides the layer; the same diff is no change", () => {
    const frames = [];
    const s = make(null, { onChange: () => frames.push(1) });
    assert.equal(s.setView({ ...VIEW, diff: DIFF }), true);
    assert.equal(diffGroup(s).visible, true);
    assert.equal(s.setView({ ...VIEW, diff: DIFF }), false, "the same diff object: nothing to do");
    assert.equal(s.setView({ ...VIEW, diff: { ...DIFF, removed: [[5, 5, 5]] } }), true);
    assert.equal(instanced(diffGroup(s))[1].count, 1);
    assert.equal(s.setView({ ...VIEW, diff: null }), true);
    assert.equal(diffGroup(s).visible, false);
    assert.equal(s.setView({ ...VIEW }), false, "a view with no diff is the view with null");
    assert.ok(frames.length >= 3);
    s.dispose();
});

await test("dimming the rest keeps the new blocks lit, and dims everything when none is new", () => {
    const lit = make({ ...DIFF, dimRest: true });
    assert.deepEqual([counts(lit).active, counts(lit).dimmed], [1, 17], "only the new block stays lit");
    lit.dispose();
    const dark = make({ removed: DIFF.removed, added: [], dimRest: true });
    assert.deepEqual([counts(dark).active, counts(dark).dimmed], [0, 18], "a run that only took blocks out: the blocks all dim, the ghosts stand out");
    dark.dispose();
    const none = make({ ...DIFF, dimRest: false });
    assert.deepEqual([counts(none).active, counts(none).dimmed], [18, 0]);
    none.dispose();
    // a pick (highlight) still works with a diff on: the diff does not take the pick's halo, and picking is not narrowed to the new blocks
    const picked = make({ ...DIFF, dimRest: true }, {});
    picked.setView({ ...VIEW, highlight: [4], diff: { ...DIFF, dimRest: true } });
    assert.equal(counts(picked).active, 2, "the picked block and the new one");
    picked.dispose();
});

await test("cells outside the grid are ignored, a theme change repaints, dispose frees everything", () => {
    const layer = (() => {
        const parent = new THREE.Group();
        return { parent, layer: createDiffLayer(parent, { cell: 100, theme: "light" }) };
    })();
    assert.equal(layer.layer.set({ removed: [[-1, 0, 0], [3, 3, 3], [10, 0, 0], [1.5, 0, 0]], added: [[0, 0, 0]], dimRest: false }), true);
    const g = layer.parent.getObjectByName("blocks:diff");
    assert.equal(instanced(g)[1].count, 1, "one valid ghost of four");
    const fill = instanced(g)[1].material;
    const before = fill.color.getHexString();
    layer.layer.setTheme("dark");
    assert.notEqual(fill.color.getHexString(), before);
    assert.equal(layer.layer.set(null), true);
    assert.equal(g.visible, false);
    layer.layer.dispose();
    assert.equal(layer.parent.getObjectByName("blocks:diff"), undefined);
    const s = make(DIFF);
    s.setTheme("dark");
    s.dispose();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
