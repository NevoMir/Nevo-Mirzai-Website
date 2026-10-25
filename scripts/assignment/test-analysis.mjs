// Tests for the structural analysis engine (src/assignment/analysis/*.ts): triangle/box overlap, voxelisation
// (solid fill, scaling, leaks, grazing faces), the structural model (supported blocks, cantilever reach across
// corners, floating parts, per-body centre of gravity), the issues and check rows (thin joints, directions, edge
// cases), the downloads, the runAnalysis wrapper and its cache (including empty extractions), the real desk-lamp
// fixture, and speed on a million triangles. The "E1".."E9" tests pin the review findings fixed in the engine.
// Block assemblies (a stabilized model: the cells are the blocks) and the stress stage are covered through runAnalysis,
// through the worker's message protocol and through the report downloads; their numbers are in test-stress-assembly.mjs.
//
//   node scripts/assignment/test-analysis.mjs
//
// The .ts modules are imported directly (Node 22 strips the types). Most tests run without a Worker: runAnalysis then
// takes its main-thread fallback (Node has no global Worker), which is the same engine code the worker runs. The worker
// tests start a Node worker thread on analysis.worker.ts behind a stand-in for the browser's Worker (FakeWorker), so the
// real module the browser bundles is what answers, wasm solver included. test-worker-build.mjs checks a built site.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Worker as NodeWorker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

// Node < 22.18 only strips types behind a flag; run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mod = (name) => import(`../../src/assignment/analysis/${name}.ts`);
const { analyze, analyzeGrid, toAnalysisMm, toModelSpace } = await mod("analyze");
const { voxelize, triBoxOverlap, SUBDIVISION, transformForBounds } = await mod("voxelize");
const { convexHull, hullDistance, directionLabel } = await mod("geometry");
const { normalizeSettings, maxGridSize } = await mod("settings");
const { buildReport, buildReportJson, buildBlocksCsv } = await mod("report");
const { runAnalysis, clearAnalysisCache, EmptyModelError } = await mod("runAnalysis");
const { withStress, analyzeAssemblyWithStress, resetSharedSolver } = await mod("withStress");
const { boundsOf, originalOf, soupBoundsOf, sourceTransformOf, sourcePlacementOf, analyzeAssembly, parseSize } = await mod("assembly");
const { descriptorFromBlocks } = await import("../../src/assignment/shared/assembly.ts");
const { DEFINITIONS, HOW_IT_WORKS, SCREEN_DEFINITIONS } = await mod("definitions");
const { plainDirection, placeOf, placeAtPoint } = await mod("plain");
const { DEFAULT_ANALYSIS_SETTINGS } = await mod("types");
const { checkAnalysisSummary } = await import("../../worker/analysis.ts");
const { NodeIO } = await import("@gltf-transform/core");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}
const near = (actual, expected, eps = 1e-6, message = "") => assert.ok(Math.abs(actual - expected) <= eps, `${message} expected ${expected}, got ${actual}`);
const nearVec = (actual, expected, eps = 1e-6, message = "") => {
    assert.equal(actual.length, expected.length, message);
    actual.forEach((v, i) => near(v, expected[i], eps, `${message}[${i}]`));
};

// ---------- builders ----------

/** Pushes a closed box (12 triangles, outward winding) into `out`. */
function pushBox(out, x0, y0, z0, x1, y1, z1, flip = false) {
    const p = (x, y, z) => [x, y, z];
    const v = [p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)];
    const quads = [
        [0, 3, 2, 1], // bottom (-z)
        [4, 5, 6, 7], // top (+z)
        [0, 1, 5, 4], // -y
        [2, 3, 7, 6], // +y
        [1, 2, 6, 5], // +x
        [3, 0, 4, 7], // -x
    ];
    for (const [a, b, c, d] of quads) {
        const tris = flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]];
        for (const t of tris) for (const idx of t) out.push(...v[idx]);
    }
}

/** A quad as two triangles. */
function pushQuad(out, a, b, c, d) {
    for (const idx of [a, b, c, a, c, d]) out.push(...idx);
}

const soupOf = (floats) => ({ positions: floats instanceof Float32Array ? floats : new Float32Array(floats) });

/**
 * A shape of unit blocks as a triangle soup, in made-up model units (0.2 per block, an offset, a tilt-free Z-up
 * frame). Each box is inset by 1% so its faces fall inside its own cells, which keeps the expected blocks exact.
 * The engine centres the model in X/Y, so the bounding box must differ from the cube it is scaled into by an even
 * number of blocks per side: `target = longest side` and the parity is asserted.
 */
function shape(cells, { unit = 0.2, inset = 0.01, origin = [3.7, -1.2, 5.1], flip = false } = {}) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const c of cells) {
        for (let a = 0; a < 3; a++) {
            min[a] = Math.min(min[a], c[a]);
            max[a] = Math.max(max[a], c[a]);
        }
    }
    const dims = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const G = Math.max(...dims);
    assert.equal((G - dims[0]) % 2, 0, `parity of x in ${dims} (G ${G})`);
    assert.equal((G - dims[1]) % 2, 0, `parity of y in ${dims} (G ${G})`);
    const floats = [];
    for (const [i, j, k] of cells) {
        const o = (a, v) => origin[a] + (v - min[a] + (a === 2 ? 0 : 0)) * unit;
        pushBox(floats, o(0, i + inset), o(1, j + inset), o(2, k + inset), o(0, i + 1 - inset), o(1, j + 1 - inset), o(2, k + 1 - inset), flip);
    }
    const offset = [(G - dims[0]) / 2, (G - dims[1]) / 2, 0];
    return {
        soup: soupOf(floats),
        settings: { targetSizeMm: G * 100, blockSizeMm: 100 },
        G,
        /** shape cell -> analysis cell */
        at: (c) => [c[0] - min[0] + offset[0], c[1] - min[1] + offset[1], c[2] - min[2]],
    };
}

/** Analyses a shape and finds blocks by their shape coordinates. */
function run(cells, extra = {}, shapeOptions = {}) {
    const s = shape(cells, shapeOptions);
    const result = analyze(s.soup, { ...s.settings, ...extra });
    const find = (c) => {
        const a = s.at(c);
        return result.blocks.find((b) => b.cell[0] === a[0] && b.cell[1] === a[1] && b.cell[2] === a[2]);
    };
    const idx = (c) => find(c)?.index;
    return { s, result, find, idx };
}

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const cube = (n) => range(n).flatMap((i) => range(n).flatMap((j) => range(n).map((k) => [i, j, k])));

/** The gallows: a base slab, a column on its left end, an arm of `arm` blocks to the right at the top. */
function gallows(arm, height, { hang = [] } = {}) {
    const slab = range(arm + 1).map((i) => [i, 0, 0]);
    const column = range(height - 1, 1).map((k) => [0, 0, k]);
    const top = height - 1;
    const armCells = range(arm, 1).map((i) => [i, 0, top]);
    const hanging = hang.map((i) => [i, 0, top - 1]);
    return [...slab, ...column, ...armCells, ...hanging];
}

/** A hollow box (six faces, no thickness), optionally with a square hole in the top. */
function shellSoup(G, { hole = false } = {}) {
    const unit = 0.2;
    const d = 0.01;
    const a = d * unit;
    const b = (G - d) * unit;
    const out = [];
    const P = (x, y, z) => [x, y, z];
    pushQuad(out, P(a, a, a), P(a, b, a), P(b, b, a), P(b, a, a)); // bottom
    pushQuad(out, P(a, a, a), P(b, a, a), P(b, a, b), P(a, a, b)); // -y
    pushQuad(out, P(a, b, a), P(a, b, b), P(b, b, b), P(b, b, a)); // +y
    pushQuad(out, P(a, a, a), P(a, a, b), P(a, b, b), P(a, b, a)); // -x
    pushQuad(out, P(b, a, a), P(b, b, a), P(b, b, b), P(b, a, b)); // +x
    if (!hole) pushQuad(out, P(a, a, b), P(b, a, b), P(b, b, b), P(a, b, b));
    else {
        // The top as a frame around a hole two blocks wide in the middle.
        const h0 = ((G - 2) / 2) * unit;
        const h1 = ((G + 2) / 2) * unit;
        pushQuad(out, P(a, a, b), P(b, a, b), P(b, h0, b), P(a, h0, b));
        pushQuad(out, P(a, h1, b), P(b, h1, b), P(b, b, b), P(a, b, b));
        pushQuad(out, P(a, h0, b), P(h0, h0, b), P(h0, h1, b), P(a, h1, b));
        pushQuad(out, P(h1, h0, b), P(b, h0, b), P(b, h1, b), P(h1, h1, b));
    }
    return soupOf(out);
}

/** A grid with the given cells fully solid, for testing the structure without voxelising. */
function gridOf(G, cells, blockSizeMm = 100) {
    const solid = new Uint16Array(G * G * G);
    for (const [i, j, k] of cells) solid[(k * G + j) * G + i] = SUBDIVISION ** 3;
    return {
        targetSizeMm: G * blockSizeMm,
        blockSizeMm,
        gridSize: [G, G, G],
        transform: { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] },
        sizeMm: [G * blockSizeMm, G * blockSizeMm, G * blockSizeMm],
        solid,
        totalSolid: cells.length * SUBDIVISION ** 3,
        surfaceCells: 0,
        triangles: { total: 0, used: 0, skipped: 0 },
        voxelizeMs: 0,
    };
}

/** Rotates a Y-up glTF position into the viewer's Z-up frame (+90 degrees about X): (x, y, z) -> (x, -z, y). */
async function readGlbTriangles(path) {
    const doc = await new NodeIO().read(path);
    const floats = [];
    for (const scene of doc.getRoot().listScenes()) {
        scene.traverse((node) => {
            const mesh = node.getMesh();
            if (!mesh) return;
            const m = node.getWorldMatrix();
            const world = (p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
            for (const prim of mesh.listPrimitives()) {
                if (prim.getMode() !== 4) continue;
                const pos = prim.getAttribute("POSITION").getArray();
                const indices = prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
                for (const i of indices) {
                    const w = world([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
                    floats.push(w[0], -w[2], w[1]);
                }
            }
        });
    }
    return new Float32Array(floats);
}

// ---------- triangle / box overlap ----------

/** Reference: clip the triangle against the six planes of the cube; any vertex left means they overlap. */
function overlapByClipping(tri, h) {
    let poly = tri.map((p) => p.slice());
    for (let axis = 0; axis < 3; axis++) {
        for (const sign of [1, -1]) {
            const out = [];
            const inside = (p) => sign * p[axis] <= h;
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i];
                const b = poly[(i + 1) % poly.length];
                const ia = inside(a);
                const ib = inside(b);
                if (ia) out.push(a);
                if (ia !== ib) {
                    const t = (h - sign * a[axis]) / (sign * (b[axis] - a[axis]));
                    out.push(a.map((v, c) => v + (b[c] - v) * t));
                }
            }
            poly = out;
            if (poly.length === 0) return false;
        }
    }
    return poly.length > 0;
}

await test("triBoxOverlap agrees with polygon clipping on 40,000 random triangles", () => {
    let seed = 12345;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    let mismatches = 0;
    let hits = 0;
    let checked = 0;
    for (let n = 0; n < 40000; n++) {
        const h = 1;
        const tri = [0, 1, 2].map(() => [rand() * 2.4, rand() * 2.4, rand() * 2.4]);
        // The routine assumes the triangle's bounding box meets the cube (callers only test cells in range).
        let boxMeets = true;
        for (let a = 0; a < 3; a++) {
            const lo = Math.min(tri[0][a], tri[1][a], tri[2][a]);
            const hi = Math.max(tri[0][a], tri[1][a], tri[2][a]);
            if (hi < -h || lo > h) boxMeets = false;
        }
        if (!boxMeets) continue;
        checked++;
        const expected = overlapByClipping(tri, h);
        const actual = triBoxOverlap(...tri[0], ...tri[1], ...tri[2], h);
        if (expected) hits++;
        if (expected !== actual) mismatches++;
    }
    assert.ok(checked > 5000 && hits > 1000 && hits < checked, `a useful mix of cases: ${hits} of ${checked} overlap`);
    assert.equal(mismatches, 0);
});

await test("triBoxOverlap: touching counts, degenerate triangles do not break it", () => {
    // Face contact, edge contact, vertex contact.
    assert.ok(triBoxOverlap(1, -0.5, -0.5, 1, 0.5, -0.5, 1, 0, 0.5, 1));
    assert.ok(triBoxOverlap(1, 1, -2, 1, 1, 2, 3, 3, 0, 1));
    assert.ok(triBoxOverlap(1, 1, 1, 2, 2, 2, 3, 1, 2, 1));
    // A needle through the cube, a needle that misses, a point.
    assert.ok(triBoxOverlap(-3, 0, 0, 3, 0, 0, 0, 0, 0, 1));
    assert.ok(!triBoxOverlap(-3, 2, 0, 3, 2, 0, 0, 2, 0, 1));
    assert.ok(triBoxOverlap(0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 1));
    // A big plane above the cube.
    assert.ok(!triBoxOverlap(-9, -9, 2, 9, -9, 2, 0, 9, 2, 1));
});

await test("convex hull, signed distance and direction labels", () => {
    const hull = convexHull([[0, 0], [100, 0], [100, 100], [0, 100], [50, 50], [50, 0], [0, 100]]);
    assert.deepEqual(hull, [[0, 0], [100, 0], [100, 100], [0, 100]], "counter-clockwise, no inner or repeated points");
    near(hullDistance([50, 40], hull).signed, 40);
    near(hullDistance([130, 50], hull).signed, -30);
    nearVec(hullDistance([130, 50], hull).nearest, [100, 50]);
    near(hullDistance([130, 140], hull).signed, -Math.hypot(30, 40), 1e-9, "outside a corner: distance to the corner");
    near(hullDistance([100, 50], hull).signed, 0, 1e-9, "on the edge is margin 0, not outside");
    assert.equal(directionLabel(1, 0.1), "+X");
    assert.equal(directionLabel(-0.2, -1), "-Y");
    assert.equal(directionLabel(1, -1), "+X and -Y");
    assert.equal(directionLabel(0, 0), "");
    assert.equal(convexHull([[1, 1]]).length, 1);
});

// ---------- voxelisation ----------

await test("settings are normalised: defaults, clamps, junk", () => {
    assert.deepEqual(normalizeSettings(), DEFAULT_ANALYSIS_SETTINGS);
    const s = normalizeSettings({ fillThreshold: 7, cantileverLimit: 99.7, maxBlocks: 0, targetSizeMm: -5, blockSizeMm: NaN });
    assert.equal(s.fillThreshold, 1);
    assert.equal(s.cantileverLimit, 10);
    assert.equal(s.maxBlocks, 1);
    assert.equal(s.targetSizeMm, 1000);
    assert.equal(s.blockSizeMm, 100);
    assert.equal(normalizeSettings({ maxBlocks: null }).maxBlocks, null);
    assert.throws(() => analyze(soupOf([0, 0, 0, 1, 0, 0, 0, 1, 0]), { targetSizeMm: 1000, blockSizeMm: 5 }), /too small for the target volume: 200 blocks per side \(at most 13\)/);
    // 13 blocks of 12 cells is the largest grid (160 fine cells per axis at most); 10 is the task's.
    assert.equal(maxGridSize(SUBDIVISION), 13);
    assert.equal(analyze(soupOf([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1]), { targetSizeMm: 1300, blockSizeMm: 100 }).gridSize[0], 13);
    assert.throws(() => analyze(soupOf([0, 0, 0, 1, 0, 0, 0, 1, 0]), { targetSizeMm: 1400, blockSizeMm: 100 }), /at most 13/);
});

await test("scaling: a 2 m box ends up 1000 mm long, centred in X/Y and on the ground", () => {
    const floats = [];
    pushBox(floats, 5, -3, 10, 7, -2, 11);
    // 30%: the box's top face lies exactly on a block boundary (z = 500 mm); the E2 tests below cover what that does at the default.
    const result = analyze(soupOf(floats), { fillThreshold: 0.3 });
    nearVec(result.sizeMm, [1000, 500, 500], 1e-3);
    near(result.transform.factor, 500, 1e-9);
    nearVec(result.transform.modelMin, [5, -3, 10]);
    nearVec(result.transform.offsetMm, [0, 250, 0], 1e-6);
    nearVec(toAnalysisMm([5, -3, 10], result.transform), [0, 250, 0], 1e-6);
    nearVec(toAnalysisMm([7, -2, 11], result.transform), [1000, 750, 500], 1e-6);
    nearVec(toModelSpace(toAnalysisMm([6.25, -2.5, 10.4], result.transform), result.transform), [6.25, -2.5, 10.4], 1e-9);
    assert.deepEqual(result.gridSize, [10, 10, 10]);
    const cells = result.blocks.map((b) => b.cell);
    const lo = (a) => Math.min(...cells.map((c) => c[a]));
    const hi = (a) => Math.max(...cells.map((c) => c[a]));
    assert.equal(lo(0), 0);
    assert.equal(hi(0), 9);
    assert.equal(lo(2), 0, "rests on the ground");
    assert.equal(hi(2), 4);
    assert.equal(lo(1) + hi(1), 9, "centred in Y");
    assert.ok(result.blocks.every((b) => b.status === "supported"), "a box on the ground is all supported");
});

await test("scaling is uniform whichever side is the longest, and keeps the proportions", () => {
    const floats = [];
    pushBox(floats, 0, 0, 0, 1, 1, 4); // tall
    const result = analyze(soupOf(floats));
    nearVec(result.sizeMm, [250, 250, 1000], 1e-3);
    nearVec(result.transform.offsetMm, [375, 375, 0], 1e-6);
    assert.equal(result.stats.layers, 10);
});

await test("a solid 3x3x3 cube: 27 supported blocks, centred COG, no issues", () => {
    const { result, s } = run(cube(3));
    assert.deepEqual(s.settings, { targetSizeMm: 300, blockSizeMm: 100 });
    assert.deepEqual(result.gridSize, [3, 3, 3]);
    assert.equal(result.blocks.length, 27);
    assert.ok(result.blocks.every((b) => b.status === "supported" && b.reach === 0 && b.fill > 0.99 && b.cantilever === null));
    assert.equal(result.bodies.length, 1);
    assert.equal(result.bodies[0].grounded, true);
    assert.equal(result.cantilevers.length, 0);
    assert.equal(result.stats.blockCount, 27);
    assert.equal(result.stats.groundBlocks, 9);
    assert.equal(result.stats.cantileveredCount, 0);
    assert.equal(result.stats.layers, 3);
    near(result.stats.coverage, 1);
    nearVec(result.stability.cogMm, [150, 150, 150]);
    assert.equal(result.stability.inside, true);
    near(result.stability.marginMm, 150);
    assert.equal(result.stability.tipDirection, null);
    assert.equal(result.stability.footprint.length, 9);
    assert.deepEqual(result.stability.supportHull, [[0, 0], [300, 0], [300, 300], [0, 300]]);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.checks.map((c) => c.key), ["cog", "cantilevered", "long-cantilevers", "components", "floating"]);
    assert.deepEqual(result.checks.map((c) => c.status), ["pass", "info", "pass", "info", "pass"]);
    assert.equal(result.checks[0].value, "Inside the base · 150 mm margin");
    assert.equal(result.checks[1].value, "None");
    assert.equal(result.checks[2].value, "None longer than 4 blocks");
    assert.equal(result.checks[3].value, "27 blocks (of 27)");
    assert.equal(result.checks[4].value, "None");
});

await test("the flipped and the doubled soup give the same blocks (no normals or winding needed)", () => {
    const a = run(cube(2)).result;
    const flipped = run(cube(2), {}, { flip: true }).result;
    assert.equal(flipped.blocks.length, 8);
    assert.deepEqual(flipped.blocks.map((b) => b.cell), a.blocks.map((b) => b.cell));
    const s = shape(cube(2));
    const doubled = new Float32Array(s.soup.positions.length * 2);
    doubled.set(s.soup.positions);
    doubled.set(s.soup.positions, s.soup.positions.length);
    assert.equal(analyze(soupOf(doubled), s.settings).blocks.length, 8);
});

await test("overlapping shells are merged: two crossing boxes fill their union", () => {
    const floats = [];
    pushBox(floats, 0.01, 0.01, 0.01, 0.59, 0.19, 0.19); // 3 x 1 x 1 blocks (unit 0.2)
    pushBox(floats, 0.21, 0.01, 0.01, 0.39, 0.19, 0.59); // crosses it: 1 x 1 x 3 blocks
    const result = analyze(soupOf(floats), { targetSizeMm: 300 });
    // Union of a row of 3 and a column of 3 sharing one block: 5 blocks.
    assert.equal(result.blocks.length, 5);
});

await test("a closed hollow box is filled; with a hole it leaks to a thin skin, without crashing", () => {
    const closed = analyze(shellSoup(5), { targetSizeMm: 500 });
    assert.equal(closed.blocks.length, 125, "the inside of a closed shell is solid");
    assert.deepEqual(closed.issues, []);

    // The skin is one layer of fine cells (1/12 of a block) thick: a block that holds only a flat face stays under
    // the 10% default, the blocks along an edge (two faces) and at a corner (three) reach it.
    const open = analyze(shellSoup(5, { hole: true }), { targetSizeMm: 500 });
    assert.ok(open.blocks.length > 0 && open.blocks.length < 125, `the skin only: ${open.blocks.length} blocks`);
    assert.ok(!open.blocks.some((b) => b.cell.join() === "2,2,2"), "the middle is empty");
    assert.ok(open.stats.coverage < 0.8, `coverage ${open.stats.coverage}`);
    const thin = open.issues.find((i) => i.kind === "thin-features");
    assert.ok(thin && thin.severity === "warning", "the thin skin is reported");
    assert.match(thin.detail, /thinner than a block/);
    assert.doesNotMatch(thin.detail, /Lowering the fill threshold/, "no lower threshold keeps most of a skin, so none is suggested");
    assert.ok(open.issues.every((i, n) => i.severity === "error" || open.issues.slice(n).every((j) => j.severity === "warning")), "errors come first");
});

await test("the thin-parts hint names a lower threshold that really keeps the model", () => {
    // A solid 4 x 4 x 4 block cube with a 20 mm thick plate under it that spans the whole footprint: the plate is
    // 16-30% filled per block, so a 40% threshold drops it and a lower one keeps it.
    const floats = [];
    pushBox(floats, 0, 0, 0, 1, 1, 0.02); // plate, 1000 x 1000 x 20 mm in a model of 1 unit
    pushBox(floats, 0.3, 0.3, 0.02, 0.7, 0.7, 0.42);
    const base = { targetSizeMm: 1000 };
    const dropped = analyze(soupOf(floats), { ...base, fillThreshold: 0.4 });
    assert.ok(dropped.stats.coverage < 0.8, `coverage ${dropped.stats.coverage}`);
    const thin = dropped.issues.find((i) => i.kind === "thin-features");
    assert.ok(thin, "reported");
    const hint = /from 40% to (\d+)% would keep about (\d+)%/.exec(thin.detail);
    assert.ok(hint, thin.detail);
    const lowered = analyze(soupOf(floats), { ...base, fillThreshold: Number(hint[1]) / 100 });
    assert.ok(lowered.stats.coverage >= 0.8, "at the suggested threshold the model keeps at least 80%");
    assert.ok(Math.abs(Math.round(lowered.stats.coverage * 100) - Number(hint[2])) <= 1, "and the percentage in the hint is the real one");
    assert.ok(Number(hint[1]) >= 10 && Number(hint[1]) < 40, "within the range of the settings panel");
});

await test("empty and broken input: 0 triangles, NaNs, degenerate and tiny triangles", () => {
    for (const soup of [soupOf(new Float32Array(0)), soupOf([NaN, 0, 0, 1, 1, 1, 2, 2, 2, Infinity, 0, 0, 1, 1, 1, 0, 0, 0]), soupOf([1, 1, 1, 1, 1, 1, 1, 1, 1]), soupOf([0, 0, 0, 1, 0, 0, 2, 0, 0])]) {
        const result = analyze(soup);
        assert.equal(result.blocks.length, 0);
        assert.equal(result.stability, null);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].kind, "empty");
        assert.equal(result.issues[0].severity, "error");
        assert.equal(result.checks.length, 5);
        assert.equal(result.stats.blockCount, 0);
        assert.equal(result.summary.cog_mm, null);
        assert.equal(result.summary.errors, 1);
        assert.equal(checkAnalysisSummary(result.summary, Date.now()).ok, true, "the server accepts it");
    }
    // Bad triangles next to a good box: skipped, counted, the box is still analysed.
    const floats = [];
    pushBox(floats, 0, 0, 0, 1, 1, 1);
    floats.push(NaN, 0, 0, 5, 5, 5, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const result = analyze(soupOf(floats), { targetSizeMm: 300 });
    assert.equal(result.blocks.length, 27);
    const grid = voxelize(soupOf(floats), normalizeSettings({ targetSizeMm: 300 }));
    assert.equal(grid.triangles.skipped, 1);
    assert.equal(grid.triangles.total, 14);
    // A trailing partial triangle is ignored.
    assert.equal(analyze(soupOf([...floats, 1, 2, 3]), { targetSizeMm: 300 }).blocks.length, 27);
});

await test("a flat sheet is thin: one layer of fine cells is under the default threshold, so no block", () => {
    const sheet = [];
    pushQuad(sheet, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    const result = analyze(soupOf(sheet));
    assert.equal(result.blocks.length, 0);
    assert.equal(result.issues[0].kind, "empty");
    assert.match(result.issues[0].detail, /thin or hollow/);
    // One layer is 1 / SUBDIVISION of a block (8.3%): a threshold at or under that keeps the sheet.
    assert.equal(analyze(soupOf(sheet), { fillThreshold: 1 / SUBDIVISION }).blocks.length, 100);
    assert.equal(analyze(soupOf(sheet), { fillThreshold: 0.05 }).blocks.length, 100);
    assert.equal(analyze(soupOf(sheet), { fillThreshold: 0.09 }).blocks.length, 0);
});

await test("E2: a face that grazes a block (or lies exactly on the boundary between two) does not add a layer of blocks", () => {
    const layers = (h, extra = {}) => {
        const floats = [];
        pushBox(floats, 0, 0, 0, 1000, 1000, h);
        return analyze(soupOf(floats), { ...extra });
    };
    // Heights around the 500 mm boundary: up to a layer of fine cells (8.3 mm) of poke stays under the threshold.
    for (const h of [499, 500, 501, 505, 508]) {
        const r = layers(h);
        assert.equal(r.stats.layers, 5, `height ${h}: ${r.stats.layers} layers`);
        assert.equal(r.stats.blockCount, 500, `height ${h}`);
        near(r.stability.cogMm[2], 250, 1e-9, `COG z for height ${h}`);
    }
    // Real material in the sixth layer (a tenth of it or more) is kept.
    for (const h of [510, 524, 575]) {
        const r = layers(h);
        assert.equal(r.stats.layers, 6, `height ${h}`);
        assert.equal(r.stats.blockCount, 600, `height ${h}`);
    }
    // The estimate errs high but stays within a layer of cells: a 575 mm slab is 75% in its top layer.
    const top = layers(575).blocks.filter((b) => b.cell[2] === 5);
    assert.ok(top.every((b) => b.fill >= 0.75 - 1e-9 && b.fill <= 0.75 + 2 / SUBDIVISION + 1e-9), `top layer fill ${top[0].fill}`);

    // A box 810 mm deep, centred: its faces at y = 95 and 905 only graze the outer rows of blocks.
    const floats = [];
    pushBox(floats, 0, 0, 0, 1000, 810, 300);
    const wide = analyze(soupOf(floats));
    assert.equal(wide.stats.groundBlocks, 80);
    assert.deepEqual(wide.stability.supportHull, [[0, 100], [1000, 100], [1000, 900], [0, 900]]);
});

await test("E2: a symmetric table gives a symmetric result (4 ground blocks, centred COG), and a mirrored model mirrors the blocks", () => {
    const table = [];
    for (const [x, y] of [[0, 0], [900, 0], [0, 900], [900, 900]]) pushBox(table, x, y, 0, x + 100, y + 100, 910);
    pushBox(table, 0, 0, 910, 1000, 1000, 1000);
    const r = analyze(soupOf(table));
    assert.equal(r.stats.groundBlocks, 4, "no extra ground blocks bleed in on one side");
    near(r.stability.cogMm[0], 500, 1e-6);
    near(r.stability.cogMm[1], 500, 1e-6);
    assert.equal(r.stats.blockCount, 4 * 9 + 100);
    assert.equal(r.stats.longestCantilever, 4, "the top is held at four corners: nothing sticks out more than 4 blocks");
    assert.deepEqual(r.issues, []);

    // A mirrored model (x -> 1000 - x) has the mirrored blocks with the same fills, whatever sits on a cell boundary.
    const parts = [[0, 0, 0, 100, 700, 400], [100, 0, 0, 500, 100, 250], [450, 200, 0, 700, 600, 175], [700, 100, 0, 1000, 300, 125]];
    const a = [];
    const b = [];
    for (const [x0, y0, z0, x1, y1, z1] of parts) {
        pushBox(a, x0, y0, z0, x1, y1, z1);
        pushBox(b, 1000 - x1, y0, z0, 1000 - x0, y1, z1);
    }
    const ra = analyze(soupOf(a));
    const rb = analyze(soupOf(b));
    assert.equal(ra.blocks.length, rb.blocks.length);
    const key = (r) => new Map(r.blocks.map((blk) => [blk.cell.join(), blk.fill]));
    const ka = key(ra);
    const kb = key(rb);
    for (const [cell, fill] of ka) {
        const [i, j, k] = cell.split(",").map(Number);
        near(kb.get([9 - i, j, k].join()) ?? -1, fill, 1e-9, `mirrored fill of ${cell}`);
    }
});

await test("E2: the fill never undercounts a box and errs high by less than two layers of cells", () => {
    let seed = 2468;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    let worst = 0;
    for (let n = 0; n < 60; n++) {
        const box = [rand() * 400, rand() * 400, rand() * 400];
        const size = [150 + rand() * 450, 150 + rand() * 450, 150 + rand() * 450];
        size[Math.floor(rand() * 3)] = 1000; // fixes the scale at 1 and the origin at 0 on that axis
        const lo = box.map((v, a) => (size[a] === 1000 ? 0 : v));
        const hi = lo.map((v, a) => v + size[a]);
        const floats = [];
        pushBox(floats, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]);
        const grid = voxelize(soupOf(floats), normalizeSettings({}));
        // The model is centred in X/Y by the transform; its box in analysis mm:
        const off = grid.transform.offsetMm;
        const m0 = [lo[0] + off[0] - grid.transform.modelMin[0], lo[1] + off[1] - grid.transform.modelMin[1], lo[2] - grid.transform.modelMin[2]];
        const m1 = [hi[0] + off[0] - grid.transform.modelMin[0], hi[1] + off[1] - grid.transform.modelMin[1], hi[2] - grid.transform.modelMin[2]];
        for (let k = 0; k < 10; k++) {
            for (let j = 0; j < 10; j++) {
                for (let i = 0; i < 10; i++) {
                    const truth = (overlap(m0[0], m1[0], i * 100, i * 100 + 100) * overlap(m0[1], m1[1], j * 100, j * 100 + 100) * overlap(m0[2], m1[2], k * 100, k * 100 + 100)) / 1e6;
                    const fill = grid.solid[(k * 10 + j) * 10 + i] / (SUBDIVISION ** 3);
                    assert.ok(fill >= truth - 1e-9, `box ${n} block ${i},${j},${k}: fill ${fill} under the true ${truth}`);
                    // Each axis can only gain the cells a face touches: one per face, so at most two layers
                    // of 1/12 of the block in an axis, applied to the other two axes' extents.
                    const axis = (a, c) => Math.min(1, overlap(m0[a], m1[a], c * 100, c * 100 + 100) / 100 + 2 / SUBDIVISION);
                    const bound = axis(0, i) * axis(1, j) * axis(2, k);
                    worst = Math.max(worst, fill - truth);
                    assert.ok(fill <= bound + 1e-9, `box ${n} block ${i},${j},${k}: fill ${fill} above ${bound}`);
                }
            }
        }
    }
    assert.ok(worst > 0.02, "the conservative bias is real, so the bound is not vacuous");
});

// ---------- structure ----------

await test("gallows with a 6-block arm: one cantilever run, reach 6, two blocks over the limit", () => {
    const { result, find, idx } = run(gallows(6, 6));
    assert.equal(result.blocks.length, 7 + 5 + 6);
    assert.equal(result.cantilevers.length, 1);
    const run1 = result.cantilevers[0];
    assert.equal(run1.reach, 6);
    assert.equal(run1.blocks.length, 6);
    assert.deepEqual(run1.roots, [idx([0, 0, 5])], "attached to the top of the column");
    assert.deepEqual(run1.overLimit, [idx([5, 0, 5]), idx([6, 0, 5])]);
    assert.deepEqual(run1.layers, [5, 5]);
    for (let i = 1; i <= 6; i++) {
        const b = find([i, 0, 5]);
        assert.equal(b.reach, i);
        assert.equal(b.status, i <= 4 ? "cantilever" : "overreach");
        assert.equal(b.cantilever, 0);
    }
    assert.equal(find([0, 0, 5]).status, "supported");
    assert.equal(find([0, 0, 3]).status, "supported");
    assert.equal(result.stats.cantileveredCount, 6);
    assert.equal(result.stats.longestCantilever, 6);
    assert.equal(result.stats.overLimitCount, 2);
    // The base slab keeps the centre of gravity inside.
    assert.equal(result.stability.inside, true);
    near(result.stability.marginMm, 50, 1e-6);

    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    assert.equal(issue.id, "cantilever-0");
    assert.equal(issue.kind, "cantilever-too-long");
    assert.equal(issue.severity, "error");
    assert.equal(issue.title, "Arm too long: 6 blocks (max 4)");
    assert.deepEqual(issue.blocks, run1.overLimit);
    assert.match(issue.detail, /At a height of 500-600 mm/, issue.detail);
    assert.match(issue.detail, /6 blocks \(600 mm\)/);
    assert.match(issue.detail, /towards the right/);
    assert.doesNotMatch(issue.detail, /\+X|cantilever/i, "plain words: no axis names, no jargon");
    assert.match(issue.detail, /limit is 4 blocks \(400 mm\)/);
    assert.match(issue.detail, /2 blocks are beyond the limit/);
    nearVec(issue.focusMm, find([6, 0, 5]).centerMm, 1e-9);

    const long = result.checks.find((c) => c.key === "long-cantilevers");
    assert.equal(long.status, "fail");
    assert.equal(long.value, "1 run longer than 4 blocks");
    assert.equal(result.checks.find((c) => c.key === "cantilevered").value, "6 blocks");
    assert.equal(result.checks.find((c) => c.key === "cog").status, "pass");
    assert.equal(result.summary.errors, 1);
    assert.equal(result.summary.over_limit, 2);
    assert.equal(result.summary.longest_cantilever, 6);
});

await test("a 4-block arm is within the limit; setting the limit to 3 makes it a violation", () => {
    const { result } = run(gallows(4, 5));
    assert.equal(result.cantilevers.length, 1);
    assert.equal(result.cantilevers[0].reach, 4);
    assert.deepEqual(result.cantilevers[0].overLimit, []);
    assert.deepEqual(result.issues, []);
    assert.equal(result.checks.find((c) => c.key === "long-cantilevers").status, "pass");
    assert.equal(result.stats.overLimitCount, 0);
    assert.ok(result.blocks.filter((b) => b.status === "cantilever").length === 4);

    const strict = run(gallows(4, 5), { cantileverLimit: 3 }).result;
    assert.equal(strict.issues.length, 1);
    assert.equal(strict.issues[0].title, "Arm too long: 4 blocks (max 3)");
    assert.equal(strict.issues[0].blocks.length, 1);
    assert.match(strict.issues[0].detail, /1 block is beyond the limit/);
});

await test("a block hanging under the arm tip has the tip's reach, and a block on top of an arm shares it", () => {
    const { result, find, idx } = run([...gallows(6, 6, { hang: [6, 3] }), [6, 0, 6]]);
    assert.equal(find([6, 0, 4]).reach, 6, "hangs under the tip");
    assert.equal(find([6, 0, 4]).status, "overreach");
    assert.equal(find([3, 0, 4]).reach, 3, "hangs under the middle of the arm");
    assert.equal(find([3, 0, 4]).status, "cantilever");
    assert.equal(find([6, 0, 6]).reach, 6, "stands on the tip");
    assert.equal(result.cantilevers.length, 1, "they are all one run");
    assert.equal(result.cantilevers[0].blocks.length, 9);
    assert.deepEqual(result.cantilevers[0].layers, [4, 6]);
    assert.deepEqual(result.cantilevers[0].overLimit.sort((a, b) => a - b), [idx([5, 0, 5]), idx([6, 0, 4]), idx([6, 0, 5]), idx([6, 0, 6])].sort((a, b) => a - b));
    assert.match(result.issues[0].detail, /At a height of 400-700 mm/);
});

await test("a bridge between two columns: reach is the distance to the nearest support", () => {
    // Two columns 8 apart with a deck of 7 blocks on top: the middle is 4 from a column.
    const cells = [];
    for (const i of [0, 8]) for (const k of range(4)) cells.push([i, 0, k]);
    for (const i of range(7, 1)) cells.push([i, 0, 3]);
    const { result, find } = run(cells);
    assert.deepEqual(range(7, 1).map((i) => find([i, 0, 3]).reach), [1, 2, 3, 4, 3, 2, 1]);
    assert.equal(result.cantilevers[0].roots.length, 2);
    assert.equal(result.cantilevers[0].reach, 4);
    assert.deepEqual(result.issues, []);
});

await test("a leaning shape: the centre of gravity falls outside the base (+X), and the tip direction is right", () => {
    const lean = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]];
    const { result, find } = run(lean);
    assert.equal(find([4, 0, 3]).reach, 3);
    assert.equal(result.stability.inside, false);
    // 5 x 1 x 4 blocks scaled into 500: no X offset, the row sits in the middle (y 200..300). COG x = 17/8 blocks.
    nearVec(result.stability.groundPointMm, [212.5, 250], 1e-6);
    near(result.stability.marginMm, -12.5, 1e-6);
    nearVec(result.stability.tipDirection, [1, 0]);
    nearVec(result.stability.pivotMm, [200, 250], 1e-6, "pivots about the right edge of the base");
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    assert.equal(issue.id, "cog");
    assert.equal(issue.kind, "cog-outside");
    assert.equal(issue.severity, "error");
    assert.equal(issue.title, "Tips over: 13 mm past the base");
    assert.match(issue.detail, /The model's weight is centred 13 mm past the edge of its base, towards the right, so it would tip over/);
    assert.doesNotMatch(issue.detail, /centre of gravity|support base|\+X/i, "plain words");
    nearVec(issue.focusMm, result.stability.cogMm);
    assert.ok(issue.blocks.length > 0 && issue.blocks.every((b) => result.blocks[b].cell[0] >= 2), "the overhanging blocks are highlighted");
    const cog = result.checks[0];
    assert.equal(cog.status, "fail");
    assert.equal(cog.value, "Outside the base · 13 mm towards +X");
    assert.equal(result.summary.cog_inside, false);
    assert.equal(result.summary.cog_margin_mm, -12.5);
});

await test("the tip direction follows the lean: -Y and a diagonal", () => {
    // The same lean turned so that it points to -Y.
    const lean = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]];
    const toMinusY = lean.map(([i, j, k]) => [j, 4 - i, k]);
    const a = run(toMinusY).result;
    nearVec(a.stability.tipDirection, [0, -1], 1e-9);
    assert.match(a.issues[0].detail, /towards the front/);
    assert.equal(a.checks[0].value, "Outside the base · 13 mm towards -Y");
    // A diagonal lean: a column on one ground block with an arm to +X and an arm to +Y at the top.
    const diag = [[0, 0, 0], [0, 0, 1], [0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2]];
    const b = run(diag).result;
    assert.equal(b.issues.length, 1);
    assert.equal(b.stability.inside, false);
    nearVec(b.stability.tipDirection, [Math.SQRT1_2, Math.SQRT1_2], 1e-9);
    near(b.stability.marginMm, -Math.hypot(100 * (10.5 / 9 - 1), 100 * (10.5 / 9 - 1)), 1e-6);
    assert.match(b.issues[0].detail, /towards the back right/);
});

await test("a floating box above the ground is its own body, an error, and not part of the centre of gravity", () => {
    const cells = [[0, 0, 0], [1, 0, 0], [1, 0, 2], [2, 0, 2]];
    const { result, find } = run(cells);
    assert.equal(result.bodies.length, 2);
    assert.deepEqual(result.bodies.map((b) => b.grounded), [true, false]);
    assert.equal(find([1, 0, 2]).status, "floating");
    assert.equal(find([1, 0, 2]).reach, null);
    assert.equal(find([2, 0, 2]).body, 1);
    assert.equal(result.stats.floatingCount, 2);
    assert.equal(result.stats.bodyCount, 2);
    assert.equal(result.cantilevers.length, 0, "floating blocks are not cantilevers");
    nearVec(result.stability.cogMm, [100, 150, 50], 1e-6, "the COG uses only the two grounded blocks");
    assert.equal(result.issues.length, 1);
    const issue = result.issues[0];
    assert.equal(issue.id, "floating-1");
    assert.equal(issue.kind, "floating");
    assert.equal(issue.severity, "error");
    assert.equal(issue.title, "Floating part: 2 blocks");
    assert.deepEqual(issue.blocks, result.bodies[1].blocks);
    assert.match(issue.detail, /at a height of 200-300 mm/);
    assert.match(issue.detail, /not connected to the ground/);
    assert.match(issue.detail, /one block of space separates them from the structure/);
    assert.match(issue.detail, /if the model is joined there, the joint fills less than 10% of a block/);
    assert.doesNotMatch(issue.detail, /edge/);
    const row = result.checks.find((c) => c.key === "floating");
    assert.equal(row.status, "fail");
    assert.equal(row.value, "2 blocks in 1 floating part");
    assert.equal(result.summary.floating_blocks, 2);
});

await test("a part that only touches the structure along an edge is still floating, and says so", () => {
    const { result } = run([[0, 0, 0], [0, 1, 0], [1, 0, 1]]);
    assert.equal(result.stats.floatingCount, 1);
    assert.match(result.issues[0].detail, /only along an edge or a corner/);
});

await test("a floating block far above the ground says how far it is", () => {
    const { result } = run([[0, 0, 0], [0, 0, 4]]);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].detail, /1 block at a height of 400-500 mm is not connected/);
    assert.match(result.issues[0].detail, /nearest block of the structure is 3 blocks away/);
    assert.doesNotMatch(result.issues[0].detail, /empty/, "does not claim the blocks in between are empty");
    assert.match(result.issues[0].detail, /It would fall/);
});

await test("things that do not rest on the ground are floating; a design with nothing on the ground says so", () => {
    const grid = gridOf(4, [[1, 1, 1], [1, 1, 2]]);
    const result = analyzeGrid(grid, { targetSizeMm: 400, blockSizeMm: 100 });
    assert.equal(result.stability, null);
    assert.equal(result.stats.floatingCount, 2);
    assert.equal(result.checks[0].value, "Nothing touches the ground");
    assert.equal(result.checks[0].status, "fail");
    assert.equal(result.summary.cog_mm, null);
    assert.equal(result.summary.cog_inside, false);
    assert.equal(checkAnalysisSummary(result.summary, Date.now()).ok, true);
});

await test("a component budget: too many blocks is an error with the numbers", () => {
    const over = run(cube(3), { maxBlocks: 20 }).result;
    assert.equal(over.issues.length, 1);
    assert.equal(over.issues[0].kind, "too-many-blocks");
    assert.equal(over.issues[0].title, "Too many blocks: 27 (budget 20)");
    assert.match(over.issues[0].detail, /block budget is 20: 7 blocks over/);
    assert.match(over.issues[0].detail, /Raising the fill threshold above \d+% drops the most weakly filled blocks first/, "a voxelised mesh: the fill threshold can drop blocks");
    assert.equal(over.checks[3].status, "fail");
    assert.equal(over.checks[3].value, "27 blocks (budget 20)");
    const ok = run(cube(3), { maxBlocks: 27 }).result;
    assert.deepEqual(ok.issues, []);
    assert.equal(ok.checks[3].status, "pass");
});

await test("issues are ordered: errors first, then warnings; ids are stable across runs", () => {
    const cells = [...gallows(6, 6), [10, 0, 3]]; // a long arm plus a stray floating block
    const lean = run(cells, { fillThreshold: 0.3 });
    const again = run(cells, { fillThreshold: 0.3 });
    assert.deepEqual(lean.result.issues.map((i) => i.id), again.result.issues.map((i) => i.id));
    const ids = lean.result.issues.map((i) => i.id);
    assert.ok(ids.includes("cantilever-0") && ids.some((id) => id.startsWith("floating-")));
    const severities = lean.result.issues.map((i) => i.severity);
    assert.deepEqual(severities, [...severities].sort((a, b) => (a === b ? 0 : a === "error" ? -1 : 1)));
});

// ---------- regressions: reach across corners (E1), per-body stability (E3), thin joints (E4), ... ----------

/** Cells of a flat plate on layer `k`: `w` x `d` blocks from (0, 0). */
const plate = (k, w = 10, d = w) => range(w).flatMap((i) => range(d).map((j) => [i, j, k]));
const column = (i, j, k0, k1) => range(k1 - k0 + 1, k0).map((k) => [i, j, k]);
/** analyzeGrid on explicit cells in a G x G x G grid of 100 mm blocks. */
const analyzeCells = (G, cells, extra = {}) => analyzeGrid(gridOf(G, cells), { targetSizeMm: G * 100, blockSizeMm: 100, ...extra });

await test("E1: reach counts a step across a corner once, so a table top is judged by its overhang", () => {
    // Four one-block legs under a 10 x 10 top: the middle is 4 blocks from a leg (chessboard distance), not 8.
    const table = [...[[0, 0], [9, 0], [0, 9], [9, 9]].flatMap(([i, j]) => column(i, j, 0, 8)), ...plate(9)];
    const t = analyzeCells(10, table);
    assert.equal(t.stats.longestCantilever, 4);
    assert.equal(t.stats.overLimitCount, 0);
    assert.deepEqual(t.issues, [], "a top held at four corners has no cantilever problem");
    assert.equal(t.stability.inside, true);

    // A two-block stem under a top that overhangs exactly 4 blocks on every side: at the limit, not over it.
    const pedestal = [...[4, 5].flatMap((i) => [4, 5].flatMap((j) => column(i, j, 0, 8))), ...plate(9)];
    const p = analyzeCells(10, pedestal);
    assert.equal(p.stats.longestCantilever, 4);
    assert.deepEqual(p.issues, []);
    const strict = analyzeCells(10, pedestal, { cantileverLimit: 3 });
    assert.equal(strict.cantilevers.length, 1);
    assert.match(strict.issues.find((i) => i.kind === "cantilever-too-long").detail, /sticks out up to 4 blocks \(400 mm\) in all directions/, "the length it names is the real overhang");

    // One pillar in a corner under the full plate: the far corner is 9 blocks away (not 18), so a limit of 9 can
    // never be exceeded by a plate in this grid.
    const corner = [...column(0, 0, 0, 8), ...plate(9)];
    const c = analyzeCells(10, corner, { cantileverLimit: 9 });
    assert.equal(c.stats.longestCantilever, 9);
    assert.equal(c.stats.overLimitCount, 0);
    const c8 = analyzeCells(10, corner, { cantileverLimit: 8 });
    assert.equal(c8.stats.overLimitCount, 19, "the blocks with max(i, j) = 9");
    const reachOf = (i, j) => c.blocks.find((b) => b.cell.join() === [i, j, 9].join()).reach;
    assert.deepEqual([reachOf(0, 0), reachOf(3, 1), reachOf(1, 3), reachOf(5, 5), reachOf(9, 2), reachOf(9, 9)], [0, 3, 3, 5, 9, 9]);

    // A one-wide staircase is measured by how far it gets, not by the length of its path.
    const stairs = [...column(0, 0, 0, 8), [0, 0, 9], [1, 0, 9], [1, 1, 9], [2, 1, 9], [2, 2, 9], [3, 2, 9], [3, 3, 9], [4, 3, 9], [4, 4, 9]];
    const st = analyzeCells(10, stairs);
    assert.equal(st.stats.longestCantilever, 4);
    // Two blocks that only touch along an edge are not connected, so there is no diagonal to step across.
    const touching = analyzeCells(10, [...column(0, 0, 0, 8), [0, 0, 9], [1, 1, 9]]);
    assert.equal(touching.bodies.filter((b) => !b.grounded).length, 1);
    assert.equal(touching.blocks.find((b) => b.cell.join() === "1,1,9").status, "floating");
});

await test("E3: a stray grounded piece does not hide a structure that tips; each body is judged on its own", () => {
    // A mushroom (2-wide stem, 7-block cap) and, far away on the ground, a separate one-block-high pad.
    const mushroom = [...[0, 1].flatMap((j) => column(0, j, 0, 5)), ...range(7).flatMap((i) => [0, 1].map((j) => [i, j, 6]))];
    const pad = [[9, 0, 0], [9, 1, 0]];
    const alone = run([...mushroom, [9, 0, 6], [9, 1, 6]]); // the marker floats, so the scale stays the same
    const withPad = run([...mushroom, ...pad]);
    assert.equal(withPad.result.bodies.length, 2);
    assert.deepEqual(withPad.result.bodies.map((b) => b.grounded), [true, true]);
    for (const { result } of [alone, withPad]) {
        assert.equal(result.stability.inside, false, "the mushroom tips");
        assert.equal(result.stability.tipDirection[0] > 0.9, true, "towards +X");
        assert.ok(result.issues.some((i) => i.kind === "cog-outside" && i.severity === "error"));
    }
    const { result } = withPad;
    assert.equal(result.stability.groundedBodies, 2);
    const tipping = result.bodies[result.stability.bodyId];
    assert.equal(tipping.blocks.length, 12 + 14, "the weakest body is the mushroom");
    near(result.stability.marginMm, alone.result.stability.marginMm, 1e-9, "the pad changes nothing for the mushroom");
    assert.deepEqual(result.stability.supportHull, [[0, 400], [100, 400], [100, 600], [0, 600]], "its base is its own stem, not stem + pad");
    nearVec(result.stability.cogMm, alone.result.stability.cogMm, 1e-9);
    const cog = result.issues.find((i) => i.id === "cog");
    assert.match(cog.detail, /The weight of one of the 2 separate pieces standing on the ground \(26 blocks\) is centred \d+ mm past the edge of its base, towards the right, so that piece would tip over/);
    assert.ok(cog.blocks.length > 0 && cog.blocks.every((b) => tipping.blocks.includes(b)), "only the tipping structure is highlighted");
    assert.ok(cog.blocks.every((b) => result.blocks[b].cell[0] >= 1), "the cap, not the stem");
    assert.equal(result.checks[0].status, "fail");
    assert.match(result.checks[0].value, /^Outside the base · \d+ mm towards \+X \(weakest of 2 structures\)$/);
    assert.equal(result.summary.cog_inside, false);
    assert.equal(buildReport(result).stability.grounded_bodies, 2);
    assert.equal(buildReport(result).stability.body, result.stability.bodyId);

    // Two stable structures: the smaller margin is the one reported.
    const two = analyzeCells(8, [...cube(3), [6, 6, 0]]);
    assert.equal(two.stability.inside, true);
    assert.equal(two.stability.groundedBodies, 2);
    near(two.stability.marginMm, 50, 1e-9, "the lone block has 50 mm to its edge, the cube 150");
    assert.equal(two.bodies[two.stability.bodyId].blocks.length, 1);
    assert.match(two.checks[0].value, /Inside the base · 50 mm margin \(weakest of 2 structures\)/);
    assert.deepEqual(two.issues, []);
    // One grounded body: nothing to add to the wording.
    assert.equal(run(cube(2)).result.checks[0].value, "Inside the base · 100 mm margin");
});

await test("V8: the centre-of-gravity row says when floating blocks were left out of the balance", () => {
    // A cube on the ground plus a block that floats in the air: the cube alone decides the balance.
    const r = analyzeCells(8, [...cube(3), [6, 6, 5]]);
    assert.equal(r.stats.floatingCount, 1);
    assert.equal(r.stability.inside, true);
    assert.equal(r.checks[0].value, "Inside the base · 150 mm margin · 1 floating block not counted");
    // Both notes together, and none when nothing floats.
    const both = analyzeCells(8, [...cube(3), [6, 6, 0], [7, 7, 5], [7, 6, 5]]);
    assert.match(both.checks[0].value, /^Inside the base · 50 mm margin \(weakest of 2 structures\) · 2 floating blocks not counted$/);
    assert.equal(analyzeCells(8, cube(3)).checks[0].value, "Inside the base · 150 mm margin");
});

await test("E4: a thin leg the threshold drops is named, with the threshold that keeps it", () => {
    // A 1000 x 1000 table, top 40 mm thick, four 36 mm legs each inside one corner block (25% filled there).
    const table = (leg) => {
        const floats = [];
        const x0 = (100 - leg) / 2;
        for (const [x, y] of [[x0, x0], [900 + x0, x0], [x0, 900 + x0], [900 + x0, 900 + x0]]) pushBox(floats, x, y, 0, x + leg, y + leg, 460);
        pushBox(floats, 0, 0, 460, 1000, 1000, 500);
        return soupOf(floats);
    };
    const dropped = analyze(table(36), { fillThreshold: 0.3 });
    assert.equal(dropped.stability, null, "nothing touches the ground at 30%");
    const floating = dropped.issues.find((i) => i.kind === "floating");
    assert.match(floating.detail, /\d+ blocks of thin material \(25% filled\) next to these blocks were left out at the 30% fill threshold\. At 25% they are kept and join the part to the structure/);
    assert.match(floating.detail, /No block of the design reaches the ground\./);
    assert.doesNotMatch(floating.detail, /empty|nearest block/);
    const hint = dropped.issues.find((i) => i.kind === "thin-features");
    assert.ok(hint && hint.severity === "warning", "the thin-joint hint is there");
    assert.match(hint.detail, /Lowering the fill threshold from 30% to 25% would (keep about \d+% and )?join the floating part to the structure \(it adds \d+ blocks\)/);
    assert.deepEqual(hint.blocks, floating.blocks, "it shows the part that would be held up");
    assert.ok(dropped.issues.indexOf(floating) < dropped.issues.indexOf(hint), "errors first");
    // With most of the volume kept the hint is about the joints only: a chunky box with a 36 mm post under it.
    const post = [];
    pushBox(post, 0, 0, 100, 1000, 1000, 1000);
    pushBox(post, 32, 32, 0, 68, 68, 100);
    // (36 mm is 19.4% of the block, plus the grazing layer of the box above it: 31%, so 35% drops it and 30% keeps it)
    const joints = analyze(soupOf(post), { fillThreshold: 0.35 });
    assert.ok(joints.stats.coverage >= 0.8, `coverage ${joints.stats.coverage}`);
    assert.equal(joints.stability, null);
    const jointsHint = joints.issues.find((i) => i.kind === "thin-features");
    assert.match(jointsHint.title, /^Thin joints left out: 1 floating part would connect$/);
    assert.match(jointsHint.detail, /^Lowering the fill threshold from 35% to 30% would join the floating part to the structure \(it adds 1 block\)\. Compare with the original model/);
    // The advice is true: at 25% the table stands.
    const fixed = analyze(table(36), { fillThreshold: 0.25 });
    assert.equal(fixed.stats.bodyCount, 1);
    assert.equal(fixed.stats.floatingCount, 0);
    assert.equal(fixed.issues.length, 0);
    // The ladder stops at the lowest threshold the app offers, and the default is already there: nothing to suggest.
    const thin = analyze(table(15));
    assert.equal(thin.stability, null, "15 mm legs are below any threshold of the app");
    const detail = thin.issues.find((i) => i.kind === "floating").detail;
    assert.doesNotMatch(detail, /thin material/);
    assert.match(detail, /No block of the design reaches the ground\./);
    assert.ok(!thin.issues.some((i) => i.kind === "thin-features"), "no lower threshold to suggest, so no hint");
    // A part that really is separate, far from anything: the distance, and no claim about material in between.
    const apart = analyze(soupOf((() => { const f = []; pushBox(f, 0, 0, 0, 300, 300, 300); pushBox(f, 0, 0, 700, 300, 300, 1000); return f; })()), { fillThreshold: 0.3 });
    const gap = apart.issues.find((i) => i.kind === "floating");
    assert.match(gap.detail, /the nearest block of the structure is 4 blocks away; if the model is joined there/);
    assert.ok(!apart.issues.some((i) => i.kind === "thin-features"));
});

await test("E6: only the blocks that pull a structure over are listed, the counterweight is named apart", () => {
    // A stem under a 10-block beam: 7 blocks overhang to the right, 2 to the left.
    const cells = [...column(2, 0, 0, 4), ...range(10).map((i) => [i, 0, 5])];
    const r = analyzeCells(10, cells);
    assert.equal(r.stability.inside, false);
    nearVec(r.stability.tipDirection, [1, 0], 1e-9);
    near(r.stability.marginMm, -(100 * (5 * 250 + 10 * 500) / 15 / 100 - 300), 1e-6);
    const issue = r.issues.find((i) => i.id === "cog");
    assert.deepEqual(issue.blocks.map((b) => r.blocks[b].cell[0]).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9], "the right-hand overhang");
    assert.match(issue.detail, /7 blocks lie beyond the base on the side it tips to/);
    assert.match(issue.detail, /2 further blocks beyond the base on the other side counterbalance it/);
});

await test("E7: a cantilever that sticks out in several directions is described as such", () => {
    // A cap on a two-block stem, limit 3: the whole rim is over, in every direction.
    const cap = [...[4, 5].flatMap((i) => [4, 5].flatMap((j) => column(i, j, 0, 8))), ...plate(9)];
    const r = analyzeCells(10, cap, { cantileverLimit: 3 });
    const issue = r.issues.find((i) => i.kind === "cantilever-too-long");
    assert.equal(r.cantilevers.length, 1);
    assert.match(issue.detail, /a part sticks out up to 4 blocks \(400 mm\) in all directions from its last support/);
    assert.doesNotMatch(issue.detail, /towards/);
    // A T: an arm out of a column that ends in a crossbar. The ends of the bar stick out to both sides, in one run.
    const tee = analyzeCells(11, [...column(0, 5, 0, 4), ...range(3, 1).map((i) => [i, 5, 5]), ...range(11).map((j) => [3, j, 5]), [0, 5, 5]]);
    const two = tee.issues.find((i) => i.kind === "cantilever-too-long");
    assert.equal(tee.cantilevers.length, 1);
    // (the bar is one block wide, so its ends are reached along it: 3 + 5 steps, minus one for the corner at the arm)
    assert.match(two.detail, /sticks out up to 7 blocks \(700 mm\) in 2 directions \(back right, front right\) from its last support/);
    assert.equal(two.blocks.length, 6);
    // A beam over a central column is two cantilevers, one per side, each with its own heading.
    const beam = analyzeCells(11, [...column(5, 0, 0, 4), ...range(11).map((i) => [i, 0, 5])]);
    const heads = beam.issues.filter((i) => i.kind === "cantilever-too-long").map((i) => /towards the (right|left)/.exec(i.detail)?.[1]);
    assert.deepEqual(heads.sort(), ["left", "right"]);
    // One arm keeps the single heading.
    assert.match(analyzeCells(10, gallows(6, 6)).issues[0].detail, /sticks out 6 blocks \(600 mm\) towards the right from its last support/);
    // A diagonal arm names the diagonal.
    const diag = analyzeCells(10, [...column(0, 0, 0, 3), ...range(7).map((i) => [i, i, 4]), ...range(6).map((i) => [i + 1, i, 4])]);
    assert.match(diag.issues.find((i) => i.kind === "cantilever-too-long").detail, /towards the back right/);
});

await test("E9: a centre of gravity a hair outside the base is not reported as 0 mm, and one exactly on the edge is only balanced", () => {
    // 25 blocks standing on cell (0, 0..4) and 26 hanging beside them at x = 150: the COG is 0.98 mm past x = 100.
    const left = range(5).flatMap((j) => column(0, j, 0, 4));
    const right = [...range(5).flatMap((j) => column(1, j, 1, 5)), [1, 0, 6]];
    const hair = analyzeCells(7, [...left, ...right]);
    assert.equal(hair.stability.inside, false);
    assert.ok(hair.stability.marginMm > -1 && hair.stability.marginMm < 0, `margin ${hair.stability.marginMm}`);
    assert.equal(hair.checks[0].value, "Outside the base · < 1 mm towards +X");
    assert.equal(hair.checks[0].status, "fail");
    const miss = hair.issues.find((i) => i.id === "cog");
    assert.match(miss.detail, /The model's weight is centred less than 1 mm past the edge of its base, towards the right, so it would tip over/);
    assert.equal(miss.title, "Tips over: less than 1 mm past the base");
    assert.doesNotMatch(miss.detail, /\b0 mm\b/);
    assert.equal(hair.summary.cog_margin_mm, Math.round(hair.stability.marginMm * 10) / 10);

    // Exactly on the edge: x = 50, 50, 150, 150 against a base from 0 to 100.
    const edge = analyzeCells(4, [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 2]]);
    near(edge.stability.marginMm, 0, 1e-9);
    assert.equal(edge.stability.inside, true);
    assert.equal(edge.checks[0].value, "On the edge of the base · < 1 mm margin");
    assert.equal(edge.checks[0].status, "pass", "the constraint holds, the warning carries the caution");
    const warn = edge.issues.find((i) => i.id === "cog-edge");
    assert.equal(warn.severity, "warning");
    assert.equal(warn.kind, "cog-outside", "it belongs to the centre-of-gravity row");
    assert.match(warn.detail, /within 1 mm of the edge of its base \(the right side\)/);
    assert.equal(warn.title, "Balanced on the edge of the base");
    assert.equal(edge.summary.errors, 0);
    assert.equal(edge.summary.warnings, 1);
    assert.ok(edge.issues.every((i, n) => i.severity === "error" || edge.issues.slice(n).every((j) => j.severity === "warning")));
    // Comfortably inside: no warning.
    assert.deepEqual(analyzeCells(4, cube(2)).issues, []);
});

// ---------- property test: structure against a plain reference ----------

await test("structure matches a plain reference on 300 random block sets", () => {
    let seed = 987654;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const G = 6;
    let acrossCorners = 0; // rounds where a corner step made some block closer than face steps alone
    let severalBodies = 0; // rounds with more than one grounded body
    for (let round = 0; round < 300; round++) {
        const density = 0.15 + rand() * 0.5;
        const key = (i, j, k) => `${i},${j},${k}`;
        const set = new Set();
        const cells = [];
        for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let k = 0; k < G; k++) if (rand() < density * (k === 0 ? 1.6 : 1)) (set.add(key(i, j, k)), cells.push([i, j, k]));
        const limit = 1 + Math.floor(rand() * 4);
        const result = analyzeGrid(gridOf(G, cells), { targetSizeMm: G * 100, blockSizeMm: 100, cantileverLimit: limit });
        assert.equal(result.blocks.length, cells.length);

        // Reference supported: walk down the column.
        const supportedRef = (i, j, k) => {
            for (let z = k; z >= 0; z--) if (!set.has(key(i, j, z))) return false;
            return true;
        };
        // Reference bodies: flood fill.
        const comp = new Map();
        let nComp = 0;
        for (const c of cells) {
            if (comp.has(key(...c))) continue;
            const stack = [c];
            comp.set(key(...c), nComp);
            while (stack.length) {
                const [i, j, k] = stack.pop();
                for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                    const n = [i + di, j + dj, k + dk];
                    if (set.has(key(...n)) && !comp.has(key(...n))) (comp.set(key(...n), nComp), stack.push(n));
                }
            }
            nComp++;
        }
        const grounded = new Set(cells.filter((c) => c[2] === 0).map((c) => comp.get(key(...c))));
        // Reference reach: Bellman-Ford over (horizontal 1, vertical 0, diagonal 1 when a block beside the corner exists).
        const bellman = (diagonals) => {
            const dist = new Map(cells.map((c) => [key(...c), supportedRef(...c) ? 0 : Infinity]));
            for (let changed = true; changed; ) {
                changed = false;
                for (const [i, j, k] of cells) {
                    const steps = [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 0], [0, 0, -1, 0]];
                    if (diagonals) for (const [di, dj] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (set.has(key(i + di, j, k)) || set.has(key(i, j + dj, k))) steps.push([di, dj, 0, 1]);
                    for (const [di, dj, dk, w] of steps) {
                        const nk = key(i + di, j + dj, k + dk);
                        if (!dist.has(nk)) continue;
                        if (dist.get(nk) + w < dist.get(key(i, j, k))) (dist.set(key(i, j, k), dist.get(nk) + w), (changed = true));
                    }
                }
            }
            return dist;
        };
        const dist = bellman(true);
        const faceOnly = bellman(false);
        if (cells.some((c) => Number.isFinite(faceOnly.get(key(...c))) && dist.get(key(...c)) < faceOnly.get(key(...c)))) acrossCorners++;
        for (const b of result.blocks) {
            const [i, j, k] = b.cell;
            const isGrounded = grounded.has(comp.get(key(i, j, k)));
            if (!isGrounded) {
                assert.equal(b.status, "floating", `round ${round} ${b.cell}`);
                assert.equal(b.reach, null);
                continue;
            }
            const d = dist.get(key(i, j, k));
            assert.equal(b.reach, d, `round ${round} reach of ${b.cell}`);
            assert.equal(b.status, d === 0 ? "supported" : d <= limit ? "cantilever" : "overreach", `round ${round} status of ${b.cell}`);
            assert.equal(supportedRef(i, j, k), b.status === "supported");
        }
        assert.equal(result.bodies.length, nComp, `round ${round} bodies`);
        assert.equal(result.bodies.filter((b) => b.grounded).length, grounded.size);
        // Every cantilevered block is in exactly one run, runs are connected and rooted.
        const inRuns = result.cantilevers.reduce((n, r) => n + r.blocks.length, 0);
        assert.equal(inRuns, result.stats.cantileveredCount);
        for (const r of result.cantilevers) {
            assert.ok(r.roots.length > 0 && r.roots.every((x) => result.blocks[x].status === "supported"));
            assert.equal(r.reach, Math.max(...r.blocks.map((x) => result.blocks[x].reach)));
            assert.deepEqual(r.overLimit, r.blocks.filter((x) => result.blocks[x].reach > limit));
        }
        // Stability exists exactly when something stands on the ground.
        assert.equal(result.stability !== null, cells.some((c) => c[2] === 0));
        if (result.stability) {
            // Every grounded body is judged on its own: its mean against the hull of its own ground cells.
            const refs = [...grounded].map((id) => {
                const own = cells.filter((c) => comp.get(key(...c)) === id);
                const mean = (a) => own.reduce((sum, c) => sum + (c[a] + 0.5) * 100, 0) / own.length;
                const corners = own.filter((c) => c[2] === 0).flatMap(([i, j]) => [[i * 100, j * 100], [(i + 1) * 100, j * 100], [(i + 1) * 100, (j + 1) * 100], [i * 100, (j + 1) * 100]]);
                return { id, mean: [mean(0), mean(1), mean(2)], margin: hullDistance([mean(0), mean(1)], convexHull(corners)).signed };
            });
            const worst = Math.min(...refs.map((r) => r.margin));
            near(result.stability.marginMm, worst, 1e-9, `round ${round} the reported margin is the weakest body's`);
            assert.equal(result.stability.groundedBodies, refs.length);
            if (refs.length > 1) severalBodies++;
            const reported = refs.find((r) => r.id === comp.get(key(...result.blocks[result.bodies[result.stability.bodyId].blocks[0]].cell)));
            assert.ok(reported && Math.abs(reported.margin - worst) < 1e-9, `round ${round} reports a body with the smallest margin`);
            nearVec(result.stability.cogMm, reported.mean, 1e-9);
            assert.equal(result.stability.inside, result.stability.marginMm >= 0);
        }
    }
    assert.ok(acrossCorners > 20, `the corner rule mattered in ${acrossCorners} rounds`);
    assert.ok(severalBodies > 20, `several grounded bodies in ${severalBodies} rounds`);
});

// ---------- the downloads ----------

await test("summary passes the server's validation; report JSON and blocks CSV are complete", () => {
    const { result } = run(gallows(6, 6));
    const checked = checkAnalysisSummary(result.summary, Date.now());
    assert.equal(checked.ok, true, checked.error);
    assert.equal(result.summary.version, 1);
    assert.equal(result.summary.cantilever_limit, 4);
    assert.equal(result.summary.fill_threshold, 0.1);
    assert.ok(Math.abs(Date.parse(result.summary.analyzed_at) - Date.now()) < 5000);

    const json = JSON.parse(buildReportJson(result, { modelName: "Gallows", modelId: "m1" }));
    assert.equal(json.report, "block-structure-analysis");
    assert.equal(json.model.modelName, "Gallows");
    assert.equal(json.verdict.passes, false);
    assert.equal(json.verdict.errors, 1);
    assert.equal(json.checks.length, 5);
    assert.equal(json.issues[0].cells.length, 2);
    assert.equal(json.blocks.length, result.blocks.length);
    assert.equal(json.definitions.length, DEFINITIONS.length);
    assert.ok(json.definitions.some((d) => /Cantilevered block/.test(d.title)));
    assert.ok(json.stability.support_base_mm.length >= 4);
    assert.equal(buildReport(result).cantilever_runs[0].reach, 6);

    const csv = buildBlocksCsv(result).trimEnd().split("\n");
    assert.equal(csv[0], "index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill,role,step,utilisation");
    assert.equal(csv.length, result.blocks.length + 1);
    const first = csv[1].split(",");
    assert.equal(first.length, 14);
    assert.deepEqual(first.slice(11), ["", "", ""], "a mesh result before the stress stage: no role, no step, no utilisation");
    assert.equal(first[7], "supported");
    assert.equal(first[8], "0");
    const overreach = csv.find((line) => line.includes(",overreach,"));
    assert.ok(overreach && ["5", "6"].includes(overreach.split(",")[8]), overreach);
    const empty = analyze(soupOf(new Float32Array(0)));
    assert.equal(buildBlocksCsv(empty), "index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill,role,step,utilisation\n");
    assert.equal(JSON.parse(buildReportJson(empty)).stability, null);
});

// ---------- runAnalysis (main-thread path in Node) ----------

await test("runAnalysis: result cache, voxel-grid reuse, cancellation, progress", async () => {
    clearAnalysisCache();
    const s = shape(gallows(6, 6));
    let extracted = 0;
    const source = () => (extracted++, s.soup);
    const stages = new Set();
    const first = await runAnalysis(source, s.settings, { cacheKey: "gallows", onProgress: (p) => stages.add(p.step) });
    assert.equal(extracted, 1);
    assert.ok(stages.has("voxelize") && stages.has("analyze"));
    assert.equal(first.cantilevers[0].reach, 6);

    const again = await runAnalysis(source, s.settings, { cacheKey: "gallows" });
    assert.equal(again, first, "same model + settings: the cached result");
    assert.equal(extracted, 1, "the triangles are not even extracted for a cache hit");

    // A different limit re-uses the voxel grid held for this model: still no extraction, a new result.
    const strict = await runAnalysis(source, { ...s.settings, cantileverLimit: 2 }, { cacheKey: "gallows" });
    assert.notEqual(strict, first);
    assert.equal(strict.settings.cantileverLimit, 2);
    assert.equal(strict.stats.overLimitCount, 4);
    assert.equal(extracted, 1);

    // Without a key the model is recognised by a fingerprint of its triangles.
    clearAnalysisCache();
    const a = await runAnalysis(s.soup, s.settings);
    const b = await runAnalysis({ positions: new Float32Array(s.soup.positions) }, s.settings);
    assert.equal(b, a);
    const other = shape(gallows(4, 5));
    assert.notEqual(await runAnalysis(other.soup, other.settings), a);

    // Cancelled before it starts, and while it waits.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runAnalysis(s.soup, s.settings, { signal: controller.signal, cacheKey: "x" }), (e) => e.name === "AbortError" && e instanceof Error);
    const later = new AbortController();
    const pending = runAnalysis(shape(cube(2)).soup, { targetSizeMm: 200 }, { signal: later.signal, cacheKey: "cube" });
    later.abort();
    await assert.rejects(pending, (e) => e.name === "AbortError");

    // Bad settings come back as a rejected promise with a readable message.
    await assert.rejects(runAnalysis(s.soup, { blockSizeMm: 1 }, { cacheKey: "bad" }), /too small/);
    clearAnalysisCache();
});

await test("analyzeGrid re-evaluates quickly and refuses a grid built for other sizes", () => {
    const s = shape(gallows(6, 6));
    const settings = normalizeSettings(s.settings);
    const grid = voxelize(s.soup, settings);
    const t0 = performance.now();
    const loose = analyzeGrid(grid, { ...s.settings, cantileverLimit: 6 });
    assert.ok(performance.now() - t0 < 100);
    assert.equal(loose.issues.length, 0);
    assert.throws(() => analyzeGrid(grid, { targetSizeMm: 1000, blockSizeMm: 100 }), /different/);
    assert.equal(analyzeGrid(grid, { ...s.settings, fillThreshold: 1 }).blocks.length, loose.blocks.length, "fully filled boxes survive a threshold of 1");
});

// ---------- the worker, through a stand-in for the browser's Worker ----------

/**
 * The browser's `new Worker(url)` backed by a Node worker thread that runs analysis.worker.ts with `self` and
 * `postMessage` shimmed, so runAnalysis.ts and the worker's message protocol are tested together.
 */
class FakeWorker {
    static created = 0;
    static instances = [];
    static sent = []; // every message the page posted, to see what travels (triangles or an assembly)
    static mode = "ok"; // "ok" | "crash"
    static quiet = false; // keep the thread's stderr out of the test log (a loader reporting a missing file on purpose)
    constructor() {
        FakeWorker.created += 1;
        FakeWorker.instances.push(this);
        const workerUrl = pathToFileURL(resolve(ROOT, "src/assignment/analysis/analysis.worker.ts")).href;
        const body =
            FakeWorker.mode === "crash"
                ? `throw new Error("boom");`
                : `const { parentPort } = require("node:worker_threads");
                   globalThis.self = globalThis;
                   globalThis.postMessage = (m) => parentPort.postMessage(m);
                   import(${JSON.stringify(workerUrl)}).then(() => parentPort.on("message", (data) => globalThis.onmessage({ data })));`;
        this.thread = new NodeWorker(body, { eval: true, stderr: FakeWorker.quiet });
        this.terminated = false;
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        this.thread.on("message", (data) => this.onmessage?.({ data }));
        this.thread.on("error", (error) => this.onerror?.({ message: error.message }));
    }
    postMessage(message, transfer) {
        FakeWorker.sent.push(message);
        this.thread.postMessage(message, transfer ?? []);
    }
    terminate() {
        this.terminated = true;
        void this.thread.terminate();
    }
}

await test("runAnalysis through a worker: same result as in-process, grid reuse without triangles, abort kills the worker", async () => {
    globalThis.Worker = FakeWorker;
    try {
        clearAnalysisCache();
        const s = shape(gallows(6, 6));
        const inProcess = analyze(s.soup, s.settings);
        const stressed = await withStress(inProcess);
        let extracted = 0;
        const source = () => (extracted++, s.soup);
        const steps = new Set();
        const viaWorker = await runAnalysis(source, s.settings, { cacheKey: "w-gallows", onProgress: (p) => steps.add(p.step) });
        assert.equal(FakeWorker.created, 1);
        assert.equal(extracted, 1);
        assert.equal(s.soup.positions.length > 0, true, "the soup was copied, not taken away");
        assert.ok(steps.has("analyze") && steps.has("stress"), [...steps].join());
        assert.deepEqual(viaWorker.blocks, inProcess.blocks);
        assert.deepEqual(viaWorker.stability, inProcess.stability);
        // The worker's second stage is the stress estimate (Awatif's wasm there too), the same as withStress in-process.
        assert.equal(viaWorker.stress.solver.backend, "wasm");
        assert.deepEqual(viaWorker.issues, stressed.issues);
        assert.deepEqual(viaWorker.checks, stressed.checks);
        assert.deepEqual(viaWorker.summary.stress, stressed.summary.stress);
        assert.deepEqual(viaWorker.stress.byBlock, stressed.stress.byBlock);
        assert.ok(viaWorker.issues.some((i) => i.kind === "overstressed"), "a 6-block arm of concrete blocks is overstressed");

        // New limit, same model: the idle worker still holds the voxel grid, so no triangles are sent or extracted.
        const strict = await runAnalysis(source, { ...s.settings, cantileverLimit: 2 }, { cacheKey: "w-gallows" });
        assert.equal(FakeWorker.created, 1, "the idle worker is re-used");
        assert.equal(extracted, 1, "no extraction for a model the worker holds");
        assert.equal(strict.stats.overLimitCount, 4);

        // Another model needs its triangles.
        const other = shape(gallows(4, 5));
        const second = await runAnalysis(() => other.soup, other.settings, { cacheKey: "w-other" });
        assert.equal(second.cantilevers[0].reach, 4);
        assert.equal(FakeWorker.created, 1);

        // The worker forgets the oldest of its grids after three models; asking for it again must still work (need-soup).
        for (const n of [2, 3, 4]) await runAnalysis(() => shape(cube(n)).soup, { targetSizeMm: n * 100 }, { cacheKey: `w-cube-${n}` });
        let reextracted = 0;
        const again = await runAnalysis(() => (reextracted++, s.soup), { ...s.settings, cantileverLimit: 3 }, { cacheKey: "w-gallows" });
        assert.equal(reextracted, 1, "the worker asked for the triangles again");
        assert.equal(again.stats.overLimitCount, 3);

        // An error inside the analysis comes back as a rejection and the worker stays usable.
        await assert.rejects(runAnalysis(s.soup, { blockSizeMm: 1 }, { cacheKey: "w-bad" }), /too small/);
        const stillWorks = await runAnalysis(() => shape(cube(2)).soup, { targetSizeMm: 200 }, { cacheKey: "w-cube-2" });
        assert.equal(stillWorks.blocks.length, 8);

        // Abort: the worker is terminated, the promise rejects with AbortError, the next run starts a fresh worker.
        const big = randomTriangles(2_000_000, { size: 20 });
        const controller = new AbortController();
        const before = FakeWorker.created;
        const pending = runAnalysis({ positions: big }, {}, { signal: controller.signal, cacheKey: "w-big" });
        setTimeout(() => controller.abort(), 5);
        await assert.rejects(pending, (e) => e.name === "AbortError");
        assert.ok(FakeWorker.instances.slice(before - 1).some((w) => w.terminated), "a cancelled run terminates its worker");
        const fresh = await runAnalysis(() => shape(cube(2)).soup, { targetSizeMm: 200, fillThreshold: 0.5 }, { cacheKey: "w-after-abort" });
        assert.equal(fresh.blocks.length, 8);
        assert.ok(FakeWorker.created > before);
    } finally {
        clearAnalysisCache();
        delete globalThis.Worker;
    }
});

await test("runAnalysis falls back to the main thread when the worker crashes on start", async () => {
    globalThis.Worker = FakeWorker;
    FakeWorker.mode = "crash";
    try {
        clearAnalysisCache();
        const s = shape(cube(2));
        const result = await runAnalysis(s.soup, s.settings, { cacheKey: "crash" });
        assert.equal(result.blocks.length, 8);
        assert.ok(FakeWorker.instances.at(-1).terminated);
    } finally {
        FakeWorker.mode = "ok";
        clearAnalysisCache();
        delete globalThis.Worker;
    }
});

// ---------- block assemblies (a stabilized model): the cells are the blocks, the triangles only give the frame ----------

const bx = (x0, x1, y0, y1, z0, z1) => range(x1 - x0, x0).flatMap((i) => range(y1 - y0, y0).flatMap((j) => range(z1 - z0, z0).map((k) => [i, j, k])));
/** A shelf: an 8 x 3 base, a 5-block column, a 6-block arm (overstressed on its own). */
const shelfBlocks = () => [...bx(0, 8, 0, 3, 0, 1), ...bx(0, 1, 1, 2, 1, 6), ...bx(1, 7, 1, 2, 5, 6)].map((cell) => ({ cell }));
/** The shelf with a 4-block column added under the arm tip by "step 1": stable. */
const stabilizedBlocks = () => [...shelfBlocks(), ...[1, 2, 3, 4].map((k) => ({ cell: [6, 1, k], role: "column", step: 1 }))];
/** The triangles of an assembly's GLB: boxes inset 2 % per side, in the viewer's own frame (any scale and place). */
function assemblySoup(desc, { unit = 0.1, origin = [3.7, -1.2, 5.1] } = {}) {
    const floats = [];
    for (let n = 0; n < desc.cells.length; n += 5) {
        const [i, j, k] = [desc.cells[n], desc.cells[n + 1], desc.cells[n + 2]];
        const lo = (v) => (v + 0.02) * unit;
        const hi = (v) => (v + 0.98) * unit;
        pushBox(floats, origin[0] + lo(i), origin[1] + lo(j), origin[2] + lo(k), origin[0] + hi(i), origin[1] + hi(j), origin[2] + hi(k));
    }
    return soupOf(floats);
}
const assemblyBlockCount = (desc) => desc.cells.length / 5;

await test("runAnalysis of a block assembly (main thread): the cells are the blocks, roles on them, a stress stage, cached by cells and material", async () => {
    clearAnalysisCache();
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const soup = assemblySoup(desc, { unit: 0.25 }); // a GLB in other units than metres
    let extracted = 0;
    const source = () => (extracted++, soup);
    const stages = [];
    let last = 0;
    let monotone = true;
    const r = await runAnalysis(source, {}, { assembly: desc, cacheKey: "asm", onProgress: (p) => { stages.push(p.step); if (p.progress < last - 1e-9) monotone = false; last = p.progress; } });
    assert.equal(r.blocks.length, assemblyBlockCount(desc));
    assert.equal(r.timingsMs.voxelize, 0, "nothing was voxelised");
    assert.deepEqual(r.assembly.roleCounts, [shelfBlocks().length, 4, 0, 0, 0, 0, 0]);
    assert.deepEqual(r.blocks.filter((b) => b.role === "column").map((b) => b.step), [1, 1, 1, 1]);
    assert.ok(r.blocks.filter((b) => b.role === "original").every((b) => b.step === 0));
    assert.equal(r.stress.solver.backend, "wasm");
    assert.equal(r.stats.overLimitCount, 0);
    assert.ok(r.stress.maxUtilisation < 0.75, `the column holds the arm up: ${r.stress.maxUtilisation}`);
    assert.ok(stages.includes("analyze") && stages.includes("stress") && !stages.includes("voxelize"), stages.join());
    assert.ok(monotone && last === 1, "the bar only moves forward and ends at 100 %");
    assert.equal(extracted, 1, "the triangles are read once, for their bounds");
    assert.notEqual(analyze(soup, { targetSizeMm: 800 }).blocks.length, r.blocks.length, "voxelising the same triangles gives other blocks: why the cells are used");
    // The same as analysing the cells directly, with the transform of the triangles' frame.
    const direct = await analyzeAssemblyWithStress(desc, boundsOf(soup.positions), {});
    assert.deepEqual(r.blocks, direct.blocks);
    assert.deepEqual(r.issues, direct.issues);
    assert.deepEqual(r.transform, direct.transform);
    // The triangles' frame is tied to the lattice: 0.25 units of model per block makes 400 mm per unit, and the box
    // corners (inset 2 mm per side) land at 2 mm and at the far edge of the last cell minus 2 mm.
    const bounds = boundsOf(soup.positions);
    near(r.transform.factor, 400, 1e-3);
    const toMm = (p) => p.map((v, a) => (v - r.transform.modelMin[a]) * r.transform.factor + r.transform.offsetMm[a]);
    nearVec(toMm(bounds.min), [2, 2, 2], 1e-3, "min corner");
    nearVec(toMm(bounds.max), [798, 298, 598], 1e-3, "max corner");

    assert.equal(await runAnalysis(source, {}, { assembly: desc, cacheKey: "asm" }), r, "the same cells and settings: the cached result");
    assert.equal(extracted, 1, "not even the bounds for a cache hit");
    const timber = await runAnalysis(source, { material: "timber" }, { assembly: desc, cacheKey: "asm" });
    assert.notEqual(timber, r, "the material is part of the cache key");
    assert.equal(timber.stress.material, "timber");
    assert.ok(timber.stress.maxUtilisation < r.stress.maxUtilisation);
    const other = descriptorFromBlocks(stabilizedBlocks().map((b) => (b.role === "column" && b.cell[2] === 1 ? { ...b, role: "footing" } : b)));
    const roles = await runAnalysis(source, {}, { assembly: other, cacheKey: "asm" });
    assert.notEqual(roles, r, "a role is part of the key");
    assert.equal(roles.assembly.roleCounts[2], 1);
    const odd = await runAnalysis(source, { blockSizeMm: 50, targetSizeMm: 500 }, { assembly: desc, cacheKey: "asm" });
    assert.equal(odd.blocks.length, r.blocks.length, "the lattice is the assembly's own: a voxelisation scale does not apply");
    assert.equal(odd.settings.blockSizeMm, 100);

    // The blocks of the original on their own, in the whole's frame: the compare view's "original".
    const part = originalOf(desc);
    const o = await runAnalysis(source, {}, { assembly: part, frame: desc, cacheKey: "asm" });
    assert.deepEqual(o.transform, r.transform);
    assert.equal(o.blocks.length, shelfBlocks().length);
    assert.ok(o.stats.overLimitCount > 0 && o.issues.some((i) => i.kind === "overstressed"), "the original arm is too long and overstressed");
    assert.ok(o.assembly.roleCounts.slice(1).every((n) => n === 0));
    clearAnalysisCache();
});

await test("runAnalysis of a block assembly: an unloaded viewer (no triangles) is an EmptyModelError or a headless frame that is not remembered", async () => {
    clearAnalysisCache();
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const empty = () => ({ positions: new Float32Array(0) });
    await assert.rejects(runAnalysis(empty, {}, { assembly: desc, cacheKey: "asm-e", rejectEmpty: true }), (e) => e instanceof EmptyModelError);
    const headless = await runAnalysis(empty, {}, { assembly: desc, cacheKey: "asm-e" });
    assert.deepEqual(headless.transform, { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] });
    assert.equal(headless.blocks.length, assemblyBlockCount(desc));
    const real = await runAnalysis(assemblySoup(desc), {}, { assembly: desc, cacheKey: "asm-e" });
    assert.notDeepEqual(real.transform, headless.transform, "the empty answer did not stick to the model");
    clearAnalysisCache();
});

/** A Node worker thread running analysis.worker.ts, spoken to in the worker protocol. */
function rawWorker() {
    const worker = new FakeWorker();
    const messages = [];
    worker.onmessage = (event) => messages.push(event.data);
    return {
        messages,
        async ask(request) {
            const from = messages.length;
            worker.postMessage(request);
            for (let n = 0; n < 1000; n++) {
                const done = messages.slice(from).find((m) => m.kind === "result" || m.kind === "error" || m.kind === "need-soup");
                if (done) return { done, messages: messages.slice(from) };
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("the worker did not answer");
        },
        stop: () => worker.terminate(),
    };
}

await test("the worker's request path with an assembly: cells + bounds in, annotated result with stress out; bad input is refused", async () => {
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const soup = assemblySoup(desc);
    const settings = normalizeSettings({});
    const request = (id, extra = {}) => ({ kind: "run", id, gridKey: null, positions: null, settings, assembly: desc, soupBounds: boundsOf(soup.positions), ...extra });
    const expected = await analyzeAssemblyWithStress(desc, boundsOf(soup.positions), settings);
    const w = rawWorker();
    try {
        const { done, messages } = await w.ask(request(1));
        assert.equal(done.kind, "result");
        assert.deepEqual(done.result.blocks, expected.blocks);
        assert.deepEqual(done.result.issues, expected.issues);
        assert.deepEqual(done.result.transform, expected.transform);
        assert.deepEqual(done.result.assembly, expected.assembly);
        assert.deepEqual(done.result.stress.byBlock, expected.stress.byBlock);
        assert.equal(done.result.stress.solver.backend, "wasm");
        const progress = messages.filter((m) => m.kind === "progress");
        assert.ok(progress.some((m) => m.step === "stress"), "the stress stage reports progress");
        assert.ok(progress.every((m) => m.fraction <= 1) && progress.map((m) => m.fraction).every((f, n, all) => n === 0 || f >= all[n - 1] - 1e-9), "progress never goes back");

        // The same worker answers a second assembly (the solver stays loaded) and a mesh request.
        const second = await w.ask(request(2, { settings: normalizeSettings({ material: "timber" }) }));
        assert.equal(second.done.result.stress.material, "timber");
        assert.equal(second.done.result.stress.solver.backend, "wasm");
        const mesh = shape(cube(2));
        const third = await w.ask({ kind: "run", id: 3, gridKey: "raw-cube", positions: mesh.soup.positions, settings: normalizeSettings(mesh.settings) });
        assert.equal(third.done.result.blocks.length, 8);
        assert.ok(third.done.result.stress, "a mesh gets the stress stage too");

        // A frame for a part of the assembly.
        const part = originalOf(desc);
        const framed = await w.ask(request(4, { assembly: part, frame: desc }));
        assert.deepEqual(framed.done.result.transform, expected.transform);

        // Refusals: a descriptor that is not canonical, a frame that is not valid; bounds that are not numbers mean "no frame".
        const cut = await w.ask(request(5, { assembly: { ...desc, cells: desc.cells.slice(0, 7) } }));
        assert.equal(cut.done.kind, "error");
        assert.match(cut.done.message, /block assembly is not valid/);
        const swapped = await w.ask(request(6, { assembly: { ...desc, cells: [...desc.cells.slice(5, 10), ...desc.cells.slice(0, 5), ...desc.cells.slice(10)] } }));
        assert.equal(swapped.done.kind, "error");
        const badFrame = await w.ask(request(7, { frame: { version: 2 } }));
        assert.equal(badFrame.done.kind, "error");
        assert.match(badFrame.done.message, /frame is not valid/);
        const noFrame = await w.ask(request(8, { soupBounds: { min: [0, 0, 0], max: [Infinity, 1, 1] } }));
        assert.deepEqual(noFrame.done.result.transform, { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] });
        // Nothing to analyse and nothing held: the old protocol still answers need-soup.
        const lost = await w.ask({ kind: "run", id: 9, gridKey: "never-seen", positions: null, settings });
        assert.equal(lost.done.kind, "need-soup");
    } finally {
        w.stop();
    }
});

await test("the worker falls back to the TypeScript solver when the wasm cannot be loaded, with the same numbers", async () => {
    const desc = descriptorFromBlocks(shelfBlocks());
    const settings = normalizeSettings({});
    FakeWorker.quiet = true;
    const w = rawWorker();
    try {
        const { done } = await w.ask({ kind: "run", id: 1, gridKey: null, positions: null, settings, assembly: desc, soupBounds: null, wasmUrl: pathToFileURL(resolve(ROOT, "src/assignment/analysis/fem/vendor/nope.wasm")).href });
        assert.equal(done.kind, "result", done.message);
        assert.equal(done.result.stress.solver.backend, "ts");
        const wasm = await analyzeAssemblyWithStress(desc, null, settings);
        assert.equal(wasm.stress.solver.backend, "wasm");
        assert.ok(Math.abs(done.result.stress.maxUtilisation - wasm.stress.maxUtilisation) < 1e-6);
        assert.deepEqual(done.result.issues, wasm.issues);
    } finally {
        FakeWorker.quiet = false;
        w.stop();
    }
});

await test("runAnalysis of a block assembly through a worker: no triangles are sent, results match the main thread", async () => {
    globalThis.Worker = FakeWorker;
    try {
        clearAnalysisCache();
        const desc = descriptorFromBlocks(stabilizedBlocks());
        const soup = assemblySoup(desc);
        let extracted = 0;
        const source = () => (extracted++, soup);
        const before = FakeWorker.sent.length;
        const stages = new Set();
        const viaWorker = await runAnalysis(source, {}, { assembly: desc, cacheKey: "asm-w", onProgress: (p) => stages.add(p.step) });
        const sent = FakeWorker.sent.slice(before);
        assert.equal(sent.length, 1, "one message: no need-soup round trip");
        assert.equal(sent[0].positions, null);
        assert.equal(sent[0].assembly.cells.length, desc.cells.length);
        assert.deepEqual(sent[0].soupBounds, boundsOf(soup.positions));
        assert.ok(stages.has("stress") && !stages.has("voxelize"));
        const direct = await analyzeAssemblyWithStress(desc, boundsOf(soup.positions), {});
        assert.deepEqual(viaWorker.blocks, direct.blocks);
        assert.deepEqual(viaWorker.issues, direct.issues);
        assert.deepEqual(viaWorker.transform, direct.transform);
        assert.equal(viaWorker.stress.solver.backend, "wasm");
        assert.equal(await runAnalysis(source, {}, { assembly: desc, cacheKey: "asm-w" }), viaWorker);
        assert.equal(FakeWorker.sent.length, before + 1, "a cache hit sends nothing");
        // A different cantilever limit re-evaluates the same cells in the idle worker.
        const strict = await runAnalysis(source, { cantileverLimit: 2 }, { assembly: desc, cacheKey: "asm-w" });
        assert.equal(FakeWorker.created > 0, true);
        assert.ok(strict.stats.overLimitCount > 0 && strict.settings.cantileverLimit === 2);
        // And a mesh is still voxelised.
        const mesh = shape(cube(2));
        assert.equal((await runAnalysis(mesh.soup, mesh.settings, { cacheKey: "asm-w-mesh" })).blocks.length, 8);
    } finally {
        clearAnalysisCache();
        delete globalThis.Worker;
    }
});

// ---------- a stabilized model over its SOURCE mesh: the placement is the source's, given from outside ----------

await test("soupBoundsOf is the bounds voxelize would use: whole triangles with finite coordinates only", () => {
    assert.equal(soupBoundsOf(new Float32Array(0)), null);
    assert.equal(soupBoundsOf(new Float32Array(6)), null, "less than a triangle");
    assert.equal(soupBoundsOf(Float32Array.from([NaN, 0, 0, 1, 1, 1, 2, 2, 2])), null, "the only triangle has a NaN");
    // The broken triangle's far-away finite vertices must not stretch the box (they would shrink the scale and shift the cells).
    const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 1, /* broken */ 500, 500, 500, Infinity, 0, 0, 0, 0, 0, /* partial */ 9, 9, 9]);
    assert.deepEqual(soupBoundsOf(soup), { min: [0, 0, 0], max: [1, 1, 1] });
    const settings = normalizeSettings({});
    assert.deepEqual(transformForBounds(soupBoundsOf(soup), settings), voxelize({ positions: soup }, settings).transform);
});

await test("sourceTransformOf: the source mesh's own voxelisation transform, at the assembly's lattice scale", () => {
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const floats = [];
    pushBox(floats, 7, 5, 3, 40, 12, 9);
    const soup = soupOf(floats);
    const settings = normalizeSettings({ targetSizeMm: 1000, blockSizeMm: 100 });
    const t = sourceTransformOf(soupBoundsOf(soup.positions), settings, desc);
    assert.deepEqual(t, voxelize(soup, settings).transform);
    // A user-set scale of the settings does not apply to a lattice of 100 mm blocks.
    assert.deepEqual(sourceTransformOf(soupBoundsOf(soup.positions), { blockSizeMm: 50, targetSizeMm: 500 }, desc), t);
    assert.equal(sourceTransformOf(null, settings, desc), null);
    // The placement is the transform and the mesh's scaled box: what voxelising the mesh reports as its size.
    const placement = sourcePlacementOf(soupBoundsOf(soup.positions), settings, desc);
    assert.deepEqual(placement.transform, t);
    assert.deepEqual(placement.sizeMm, voxelize(soup, settings).sizeMm);
    assert.deepEqual(sourcePlacementOf(soupBoundsOf(soup.positions), { blockSizeMm: 50, targetSizeMm: 500 }, desc), placement, "the lattice's scale, not the settings'");
    assert.equal(sourcePlacementOf(null, settings, desc), null);
});

await test("a stabilized model over its source mesh is as big as that mesh: the size is the mesh's box, so the original and the stabilized model agree", async () => {
    clearAnalysisCache();
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const floats = [];
    pushBox(floats, 7, 5, 3, 40, 12, 9);
    const soup = soupOf(floats);
    const settings = normalizeSettings({});
    const placement = sourcePlacementOf(soupBoundsOf(soup.positions), settings, desc);
    const original = voxelize(soup, settings);
    // Headless, and over a mesh without being told its size: the lattice's own extent (what the stabilizer measures).
    const lattice = analyzeAssembly(desc, null, {});
    const told = analyzeAssembly(desc, null, {}, desc, placement.transform);
    assert.deepEqual(told.sizeMm, lattice.sizeMm, "the transform alone does not say how big the mesh is");
    // With the mesh's box: the result says what the original does, in the result and in the summary that is saved.
    const sized = analyzeAssembly(desc, null, {}, desc, placement.transform, placement.sizeMm);
    assert.deepEqual(sized.transform, placement.transform);
    assert.deepEqual(sized.sizeMm, original.sizeMm);
    assert.notDeepEqual(sized.sizeMm, lattice.sizeMm);
    assert.deepEqual(sized.summary.size_mm, analyzeGrid(original, settings).summary.size_mm);
    assert.deepEqual(sized.blocks, told.blocks, "nothing else moves");
    assert.deepEqual(sized.issues.map((i) => [i.kind, i.blocks]), told.issues.map((i) => [i.kind, i.blocks]));
    assert.deepEqual(sized.stats, told.stats);
    // A size without a transform is not a placement: the lattice's own frame and extent.
    assert.deepEqual(analyzeAssembly(desc, null, {}, desc, null, placement.sizeMm).sizeMm, lattice.sizeMm);
    // The summary the Worker takes in accepts it.
    assert.equal(checkAnalysisSummary(sized.summary, Date.now()).ok, true);

    // Through runAnalysis (main thread): same, and another size under the same key is another result.
    const key = "stab@src-size";
    const run = (sourceSizeMm, extra = {}) => runAnalysis(() => assert.fail("no triangles are read"), {}, { assembly: desc, cacheKey: key, sourceTransform: placement.transform, sourceSizeMm, ...extra });
    const a = await run(placement.sizeMm);
    assert.deepEqual(a.sizeMm, original.sizeMm);
    assert.deepEqual(a.summary.size_mm, sized.summary.size_mm);
    assert.equal(await run([...placement.sizeMm]), a, "cached by the size's values");
    const other = await run([500, 400, 300]);
    assert.notEqual(other, a, "another size is another result");
    assert.deepEqual(other.sizeMm, [500, 400, 300]);
    assert.deepEqual(a.sizeMm, original.sizeMm, "and did not change the first");
    const unsized = await run(null);
    assert.deepEqual(unsized.sizeMm, lattice.sizeMm);
    assert.notEqual(unsized, a);
    // A size with no transform is ignored (and is not in the key, so it cannot split the cache).
    const free = await runAnalysis(assemblySoup(desc), {}, { assembly: desc, cacheKey: "stab@own-size", sourceSizeMm: [1, 2, 3] });
    assert.deepEqual(free.sizeMm, lattice.sizeMm);
    // A mesh is voxelised and says its own.
    const mesh = shape(cube(2));
    const voxelised = await runAnalysis(mesh.soup, mesh.settings, { cacheKey: "mesh-with-size", sourceTransform: placement.transform, sourceSizeMm: [1, 2, 3] });
    assert.notDeepEqual(voxelised.sizeMm, [1, 2, 3]);
    clearAnalysisCache();
});

await test("parseSize: three finite numbers that are not negative, else null", () => {
    assert.deepEqual(parseSize([1, 2.5, 0]), [1, 2.5, 0]);
    for (const bad of [null, undefined, "x", 7, {}, [], [1, 2], [1, 2, 3, 4], [1, 2, NaN], [1, Infinity, 3], [1, -1, 3], [1, "2", 3]]) assert.equal(parseSize(bad), null, JSON.stringify(bad));
});

await test("runAnalysis with a sourceTransform (main thread): the blocks are placed by it, the triangles are never read, the cache tells placements apart", async () => {
    clearAnalysisCache();
    const desc = descriptorFromBlocks(stabilizedBlocks());
    const T = { factor: 8, modelMin: [1, 2, 3], offsetMm: [40, 120, 0] };
    let extracted = 0;
    const source = () => (extracted++, assemblySoup(desc));
    const placed = await runAnalysis(source, {}, { assembly: desc, cacheKey: "stab@src", sourceTransform: T });
    assert.equal(extracted, 0, "the placement is given: nothing is read from the viewer");
    assert.deepEqual(placed.transform, T);
    assert.equal(placed.blocks.length, assemblyBlockCount(desc));
    assert.deepEqual(placed.assembly.roleCounts, [shelfBlocks().length, 4, 0, 0, 0, 0, 0]);
    assert.ok(placed.stress, "the stress stage ran");
    // The numbers are the assembly's whatever the placement.
    const own = await runAnalysis(assemblySoup(desc), {}, { assembly: desc, cacheKey: "stab@own" });
    assert.notDeepEqual(own.transform, T, "the stabilized GLB's own frame is another placement");
    assert.deepEqual(placed.blocks, own.blocks);
    assert.deepEqual(placed.issues, own.issues);
    assert.deepEqual({ ...placed.summary, analyzed_at: "" }, { ...own.summary, analyzed_at: "" });
    assert.equal(placed.stress.maxUtilisation, own.stress.maxUtilisation);
    // Cached by the placement as well as the key.
    assert.equal(await runAnalysis(source, {}, { assembly: desc, cacheKey: "stab@src", sourceTransform: { ...T, modelMin: [...T.modelMin] } }), placed);
    const T2 = { ...T, offsetMm: [0, 0, 0] };
    const moved = await runAnalysis(source, {}, { assembly: desc, cacheKey: "stab@src", sourceTransform: T2 });
    assert.notEqual(moved, placed, "another placement under the same key is another result");
    assert.deepEqual(moved.transform, T2);
    assert.deepEqual(placed.transform, T, "and did not change the first");
    // No key and no triangles needed either: the transform is the identity of the frame.
    assert.deepEqual((await runAnalysis(source, {}, { assembly: desc, sourceTransform: T })).transform, T);
    assert.equal(extracted, 0);
    // An unloaded viewer does not matter when nothing is read from it.
    const unloaded = await runAnalysis(() => ({ positions: new Float32Array(0) }), {}, { assembly: desc, cacheKey: "stab@unloaded", sourceTransform: T, rejectEmpty: true });
    assert.deepEqual(unloaded.transform, T);
    // A mesh has no use for a placement it did not ask for: it is voxelised and gets its own.
    const mesh = shape(cube(2));
    const voxelised = await runAnalysis(mesh.soup, mesh.settings, { cacheKey: "mesh-with-transform", sourceTransform: T });
    assert.notDeepEqual(voxelised.transform, T);
    clearAnalysisCache();
});

await test("runAnalysis with a sourceTransform through a worker: bounds and triangles are not sent, the transform is, and the result matches the main thread", async () => {
    globalThis.Worker = FakeWorker;
    try {
        clearAnalysisCache();
        const desc = descriptorFromBlocks(stabilizedBlocks());
        const T = { factor: 8, modelMin: [1, 2, 3], offsetMm: [40, 120, 0] };
        let extracted = 0;
        const source = () => (extracted++, assemblySoup(desc));
        const before = FakeWorker.sent.length;
        const viaWorker = await runAnalysis(source, {}, { assembly: desc, cacheKey: "stab@src-w", sourceTransform: T });
        const sent = FakeWorker.sent.slice(before);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].positions, null);
        assert.equal(sent[0].soupBounds, null);
        assert.equal(sent[0].frame, null);
        assert.deepEqual(sent[0].sourceTransform, T);
        assert.equal(sent[0].sourceSizeMm, null, "no size given: none sent");
        assert.equal(extracted, 0);
        const direct = await analyzeAssemblyWithStress(desc, null, {});
        assert.deepEqual(viaWorker.transform, T);
        assert.deepEqual(viaWorker.blocks, direct.blocks);
        assert.deepEqual(viaWorker.issues, direct.issues);
        assert.equal(viaWorker.stress.solver.backend, "wasm");
        assert.equal(await runAnalysis(source, {}, { assembly: desc, cacheKey: "stab@src-w", sourceTransform: T }), viaWorker);
        assert.equal(FakeWorker.sent.length, before + 1, "a cache hit sends nothing");
    } finally {
        clearAnalysisCache();
        delete globalThis.Worker;
    }
});

await test("runAnalysis through a worker: the source mesh's size travels with its transform and is the result's size", async () => {
    globalThis.Worker = FakeWorker;
    try {
        clearAnalysisCache();
        const desc = descriptorFromBlocks(stabilizedBlocks());
        const T = { factor: 8, modelMin: [1, 2, 3], offsetMm: [40, 120, 0] };
        const box = [640, 480, 900];
        const before = FakeWorker.sent.length;
        const viaWorker = await runAnalysis(() => assert.fail("no triangles are read"), {}, { assembly: desc, cacheKey: "stab@src-size-w", sourceTransform: T, sourceSizeMm: box });
        const sent = FakeWorker.sent.slice(before);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].sourceTransform, T);
        assert.deepEqual(sent[0].sourceSizeMm, box);
        assert.deepEqual(viaWorker.sizeMm, box);
        assert.deepEqual(viaWorker.summary.size_mm, box);
        assert.deepEqual(viaWorker.transform, T);
        const direct = analyzeAssembly(desc, null, {}, desc, T, box);
        assert.deepEqual(viaWorker.blocks, direct.blocks);
        assert.deepEqual(viaWorker.issues, direct.issues);
    } finally {
        clearAnalysisCache();
        delete globalThis.Worker;
    }
});

await test("the worker refuses a source size that is not three finite numbers, as it does a bad transform", async () => {
    const desc = descriptorFromBlocks(shelfBlocks());
    const settings = normalizeSettings({});
    const w = rawWorker();
    try {
        const T = { factor: 2, modelMin: [0, 0, 0], offsetMm: [10, 20, 0] };
        const ask = (id, sourceSizeMm) => w.ask({ kind: "run", id, gridKey: null, positions: null, settings, assembly: desc, soupBounds: null, sourceTransform: T, sourceSizeMm });
        const good = await ask(1, [300, 200, 100]);
        assert.equal(good.done.kind, "result", good.done.message);
        assert.deepEqual(good.done.result.sizeMm, [300, 200, 100]);
        for (const bad of [[1, 2], [1, NaN, 3], [1, -2, 3], ["1", 2, 3], "big", 7]) {
            const answer = await ask(2, bad);
            assert.equal(answer.done.kind, "error", JSON.stringify(bad));
            assert.match(answer.done.message, /size is not valid/);
        }
        const none = await ask(3, null);
        assert.equal(none.done.kind, "result", "null means no size given");
        assert.deepEqual(none.done.result.sizeMm, analyzeAssembly(desc, null, {}).sizeMm);
    } finally {
        w.stop();
    }
});

await test("the worker refuses a transform that is not finite numbers with a positive factor", async () => {
    const desc = descriptorFromBlocks(shelfBlocks());
    const settings = normalizeSettings({});
    const w = rawWorker();
    try {
        const ask = (id, sourceTransform) => w.ask({ kind: "run", id, gridKey: null, positions: null, settings, assembly: desc, soupBounds: null, sourceTransform });
        const good = await ask(1, { factor: 2, modelMin: [0, 0, 0], offsetMm: [10, 20, 0] });
        assert.equal(good.done.kind, "result", good.done.message);
        assert.deepEqual(good.done.result.transform, { factor: 2, modelMin: [0, 0, 0], offsetMm: [10, 20, 0] });
        for (const bad of [{ factor: 0, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] }, { factor: NaN, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] }, { factor: 1, modelMin: [0, 0], offsetMm: [0, 0, 0] }, { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, "1", 0] }, "scale it", 7]) {
            const answer = await ask(2, bad);
            assert.equal(answer.done.kind, "error", JSON.stringify(bad));
            assert.match(answer.done.message, /transform is not valid/);
        }
        const none = await ask(3, null);
        assert.equal(none.done.kind, "result", "null means no transform given");
        assert.deepEqual(none.done.result.transform, { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] });
    } finally {
        w.stop();
    }
});

await test("E5: an empty extraction is never cached or remembered; the real model under the same key is analysed", async () => {
    const empty = () => ({ positions: new Float32Array(0) });
    for (const withWorker of [false, true]) {
        if (withWorker) globalThis.Worker = FakeWorker;
        try {
            clearAnalysisCache();
            const s = shape(gallows(6, 6));
            const key = `stale-${withWorker}`;
            // A viewer that is not loaded yet hands back no triangles: "No blocks", but not for good.
            const none = await runAnalysis(empty(), s.settings, { cacheKey: key });
            assert.equal(none.issues[0].kind, "empty");
            assert.equal(await runAnalysis(empty(), s.settings, { cacheKey: key }) === none, false, "the empty answer is not cached");
            const real = await runAnalysis(s.soup, s.settings, { cacheKey: key });
            assert.equal(real.cantilevers[0].reach, 6, "the real model under the same key is analysed afresh");
            // Another setting for the same key uses the real model's voxel grid, not the empty one.
            let extracted = 0;
            const strict = await runAnalysis(() => (extracted++, s.soup), { ...s.settings, cantileverLimit: 2 }, { cacheKey: key });
            assert.equal(strict.stats.overLimitCount, 4);
            assert.equal(extracted, 0, "the grid of the real model is held");
            // And an empty run first, then the real model with a different threshold under the same key.
            const key2 = `${key}-2`;
            await runAnalysis(empty(), s.settings, { cacheKey: key2 });
            const other = await runAnalysis(s.soup, { ...s.settings, fillThreshold: 0.4 }, { cacheKey: key2 });
            assert.ok(other.blocks.length > 0, "not the empty grid again");

            // rejectEmpty turns "no triangles" into an error to retry on, and a cached answer still wins over it.
            const key3 = `${key}-3`;
            const created = FakeWorker.created;
            await assert.rejects(runAnalysis(empty, s.settings, { cacheKey: key3, rejectEmpty: true }), (e) => e instanceof EmptyModelError && e.name === "EmptyModelError" && /not loaded/.test(e.message));
            await assert.rejects(runAnalysis(empty, s.settings, { cacheKey: key3, rejectEmpty: true }), (e) => e instanceof EmptyModelError);
            if (withWorker) assert.equal(FakeWorker.created, created, "an empty model does not cost a worker");
            assert.equal(await runAnalysis(empty, s.settings, { cacheKey: key, rejectEmpty: true }), real, "a cached result is returned without asking for the triangles");
            const loaded = await runAnalysis(s.soup, s.settings, { cacheKey: key3, rejectEmpty: true });
            assert.equal(loaded.cantilevers[0].reach, 6, "once loaded it works");
        } finally {
            clearAnalysisCache();
            delete globalThis.Worker;
        }
    }
});

// ---------- plain words on screen, technical terms in the report ----------

/** Words and shapes a student should not meet in an issue's title or detail (the report and the glossary keep them). */
const JARGON = /cantilever|centre of gravity|center of gravity|utilis|allowable|kPa|\bCOG\b|\bFEM\b|voxel|overreach|load path|component|overstressed|highly stressed|support base/i;
const CELL_COORDINATES = /\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)/;
const AXIS_NAMES = /(?:^|[\s(,/])[+\-−][XYZ]\b/;
function assertPlain(issue, where = "") {
    for (const [field, text] of [["title", issue.title], ["detail", issue.detail]]) {
        assert.doesNotMatch(text, JARGON, `${where} ${issue.id} ${field}: ${text}`);
        assert.doesNotMatch(text, CELL_COORDINATES, `${where} ${issue.id} ${field} has a cell coordinate: ${text}`);
        assert.doesNotMatch(text, AXIS_NAMES, `${where} ${issue.id} ${field} names an axis: ${text}`);
        assert.doesNotMatch(text, /\bkPa\b|\bMPa\b/, `${where} ${issue.id} ${field}`);
    }
}

/** A 4-block concrete arm with two blocks on top of it: 92% of its strength used (a warning, not an error). */
const heavyArmBlocks = () => [...bx(0, 4, 0, 3, 0, 1), ...bx(0, 1, 1, 2, 1, 5), ...bx(1, 5, 1, 2, 4, 5), [1, 1, 5], [2, 1, 5]].map((cell) => ({ cell }));

await test("plainDirection: the Front view's words for the analysis axes (+X right, -Y front), diagonals between", () => {
    assert.equal(plainDirection(1, 0), "right");
    assert.equal(plainDirection(-1, 0), "left");
    assert.equal(plainDirection(0, 1), "back");
    assert.equal(plainDirection(0, -1), "front");
    assert.equal(plainDirection(1, 1), "back right");
    assert.equal(plainDirection(-1, 1), "back left");
    assert.equal(plainDirection(1, -1), "front right");
    assert.equal(plainDirection(-1, -1), "front left");
    assert.equal(plainDirection(0, 0), "");
    // The same classes as the report's directionLabel: ~22 degrees of an axis is that axis.
    for (const [dx, dy] of [[1, 0.3], [1, -0.3], [0.3, 1], [-0.3, -1], [1, 0.5], [-1, 0.7], [0.2, -0.2], [5, 1.9], [5, 2.1]]) {
        const technical = directionLabel(dx, dy);
        const plain = plainDirection(dx, dy);
        const words = technical.split(" and ").map((t) => ({ "+X": "right", "-X": "left", "+Y": "back", "-Y": "front" })[t]);
        assert.deepEqual(plain.split(" ").sort(), words.sort(), `${dx},${dy}: ${technical} -> ${plain}`);
    }
});

await test("placeOf: a height range and the side of the model, never a cell; the middle has no side", () => {
    const { result } = run(gallows(6, 6));
    const arm = result.issues[0];
    const place = placeOf(result.blocks, arm.blocks, result.settings.blockSizeMm);
    assert.equal(place.height, "500-600 mm");
    assert.deepEqual(place.layers, [5, 5]);
    assert.equal(place.side, "right side", "the end of the arm is on the right");
    assert.equal(place.line, "500-600 mm up, right side");
    assert.equal(place.sentence, "at a height of 500-600 mm, on the right side");
    // A column of the model's middle: no side to name.
    const column3 = analyzeCells(5, [...column(2, 2, 0, 3), ...column(1, 2, 0, 0), ...column(3, 2, 0, 0)]).blocks;
    const mid = column3.filter((b) => b.cell[0] === 2).map((b) => b.index);
    const middle = placeOf(column3, mid, 100);
    assert.equal(middle.side, "middle");
    assert.equal(middle.line, "0-400 mm up, in the middle");
    assert.equal(middle.sentence, "at a height of 0-400 mm, in the middle");
    assert.equal(placeOf(result.blocks, [], 100), null);
    assert.equal(placeAtPoint(result.blocks, arm.focusMm, 100).line, "500-600 mm up, right side", "the point the camera flies to is on the same side");
    assert.equal(placeAtPoint([], [0, 0, 0], 100), null);
});

await test("every issue the engine words is plain: no jargon, no cell coordinates, no axis names, no kPa", async () => {
    const lean = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [1, 0, 2], [1, 0, 3], [2, 0, 3], [3, 0, 3], [4, 0, 3]];
    const results = {
        arm: run(gallows(6, 6)).result,
        fan: analyzeCells(10, [...[4, 5].flatMap((i) => [4, 5].flatMap((j) => column(i, j, 0, 8))), ...plate(9)], { cantileverLimit: 3 }),
        lean: run(lean).result,
        leanFront: run(lean.map(([i, j, k]) => [j, 4 - i, k])).result,
        leanDiagonal: run([[0, 0, 0], [0, 0, 1], [0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2], [0, 1, 2], [0, 2, 2], [0, 3, 2]]).result,
        floating: run([[0, 0, 0], [1, 0, 0], [1, 0, 2], [2, 0, 2]]).result,
        farFloating: run([[0, 0, 0], [0, 0, 4]]).result,
        edgeFloating: run([[0, 0, 0], [0, 1, 0], [1, 0, 1]]).result,
        budget: run(cube(3), { maxBlocks: 20 }).result,
        edge: analyzeCells(4, [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 2]]),
        noGround: analyzeGrid(gridOf(4, [[1, 1, 1], [1, 1, 2]]), { targetSizeMm: 400, blockSizeMm: 100 }),
        several: analyzeCells(8, [...cube(3), [6, 6, 0], [7, 7, 5]]),
    };
    // A thin skin (thin parts left out) and the stress issues of an overloaded arm and a heavily loaded one.
    results.skin = analyze(shellSoup(5, { hole: true }), { targetSizeMm: 500 });
    results.stress = await analyzeAssemblyWithStress(descriptorFromBlocks(shelfBlocks()), null, {});
    results.heavy = await analyzeAssemblyWithStress(descriptorFromBlocks(heavyArmBlocks()), null, { cantileverLimit: 10 });
    let seen = 0;
    const kinds = new Set();
    for (const [name, result] of Object.entries(results)) {
        for (const issue of result.issues) {
            assertPlain(issue, name);
            kinds.add(issue.kind);
            seen += 1;
        }
    }
    assert.ok(seen >= 15, `${seen} issues looked at`);
    for (const kind of ["cog-outside", "cantilever-too-long", "floating", "too-many-blocks", "thin-features", "overstressed", "highly-stressed"]) assert.ok(kinds.has(kind), `a ${kind} issue was among them`);
    assert.ok(results.edge.issues.some((i) => i.id === "cog-edge"), "and the one on the edge");
    // The titles are short sentences with the numbers.
    assert.equal(results.stress.issues.find((i) => i.kind === "cantilever-too-long").title, "Arm too long: 6 blocks (max 4)");
    assert.equal(results.budget.issues[0].title, "Too many blocks: 27 (budget 20)");
    assert.equal(results.noGround.issues.find((i) => i.kind === "floating").title, "Floating part: 2 blocks");
});

await test("a stress issue says where (a height and a side), what the joint goes through, and how much of its strength is used", async () => {
    const r = await analyzeAssemblyWithStress(descriptorFromBlocks(shelfBlocks()), null, {});
    const issue = r.issues.find((i) => i.kind === "overstressed");
    assert.match(issue.title, /^Joint overloaded: \d+%$/);
    assert.equal(issue.title, `Joint overloaded: ${Math.round(r.stress.maxUtilisation * 100)}%`);
    assert.match(issue.detail, /^At a height of \d+-\d+ mm, (on the (left|right) side|at the (back|front)( (left|right))?|in the middle), a concrete joint is (pulled apart|crushed|sheared) and uses \d+% of its strength under the model's own weight\. It would open or crush\. /);
    assert.doesNotMatch(issue.detail, /kPa|allowed/);
    assert.equal(issue.blocks[0], r.stress.points[0].blocks[0], "the peak block is the first");
    // The place is the peak's, not the whole region's.
    const peak = r.blocks[issue.blocks[0]];
    const height = `${peak.cell[2] * 100}-${(peak.cell[2] + 1) * 100} mm`;
    assert.ok(issue.detail.includes(`At a height of ${height}`), `${height} in ${issue.detail}`);
    // A warning: the same sentence for a joint close to its limit.
    const heavy = await analyzeAssemblyWithStress(descriptorFromBlocks(heavyArmBlocks()), null, { cantileverLimit: 10 });
    assert.ok(heavy.stress.maxUtilisation > 0.75 && heavy.stress.maxUtilisation <= 1, `${heavy.stress.maxUtilisation}`);
    const warning = heavy.issues.find((i) => i.kind === "highly-stressed");
    assert.ok(warning, "a 4-block arm with two blocks on top of it is close to its limit");
    assert.match(warning.title, /^Joint heavily loaded: \d+%$/);
    assert.match(warning.detail, /It is close to its limit\./);
});

await test("the report keeps the technical terms: kinds, rows, definitions, cells and kPa, whatever the screen says", async () => {
    const { result } = run(gallows(6, 6));
    const json = JSON.parse(buildReportJson(result));
    assert.equal(json.issues[0].kind, "cantilever-too-long");
    assert.equal(json.issues[0].cells.length, 2, "the cells are in the report");
    assert.equal(json.checks[0].label, "Centre of gravity");
    assert.equal(json.checks[0].value, "Inside the base · 50 mm margin");
    assert.equal(json.checks[1].label, "Cantilevered blocks");
    assert.equal(json.checks[2].label, "Long cantilevers");
    assert.equal(json.checks[3].label, "Components used");
    assert.equal(json.cantilever_runs.length, 1);
    assert.deepEqual(json.definitions, DEFINITIONS, "the definitions are the technical statement of each rule");
    assert.ok(json.definitions.some((d) => /Utilisation/.test(d.title)) && json.definitions.some((d) => /Centre of gravity/.test(d.title)));
    const stressed = await analyzeAssemblyWithStress(descriptorFromBlocks(shelfBlocks()), null, {});
    const row = stressed.checks.find((c) => c.key === "stress");
    assert.equal(row.label, "Joint stress");
    assert.match(row.value, /^Peak \d+% of allowable at block \(\d+, \d+, \d+\)/);
    const withStressJson = JSON.parse(buildReportJson(stressed));
    assert.ok(withStressJson.stress.points[0].tension_kpa > 0 && withStressJson.stress.points[0].allowable_kpa > 0);
    assert.equal(withStressJson.stress.points[0].mode, "tension");
    // Each issue also carries its finding in the engine's terms, with the figures: the screen's sentence is plain, the report's is technical.
    assert.match(json.issues[0].technical, /^Cantilever run \d+: reach \d+ blocks against a limit of 4; \d+ of its \d+ blocks are over the limit \(layers k \d+ to \d+\)\.$/);
    assert.doesNotMatch(json.issues[0].title + json.issues[0].detail, /cantilever/i, "while the screen's own words do not name it");
    const overstressed = withStressJson.issues.find((i) => i.kind === "overstressed" || i.kind === "highly-stressed");
    assert.ok(overstressed, "the shelf has an overloaded joint");
    assert.match(overstressed.technical, /^Joint utilisation \d+% of the allowable stress: (tension|compression|shear) \d+ of \d+ kPa allowable at block \(\d+, \d+, \d+\); over (100% \(overstressed\)|75% \(highly stressed\))\.$/);
    const tipper = run([[0, 0, 0], [0, 0, 1], [1, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 1], [5, 0, 1], [6, 0, 1]]);
    const tip = JSON.parse(buildReportJson(tipper.result)).issues.find((i) => i.kind === "cog-outside");
    assert.ok(tip, "a column with a long arm tips over");
    assert.match(tip.technical, /^Centre of gravity \(.*\) mm projects [\d.]+ mm outside the support base; it tips about \(.*\) mm towards \(.*\)\.$/);
    for (const issue of json.issues) assert.ok(typeof issue.technical === "string" && issue.technical.length > 10, `${issue.kind} has a technical line`);
});

await test("the info page's plain parts: four steps, and the two screen-only definitions that the report does not carry", () => {
    assert.equal(HOW_IT_WORKS.length, 4);
    for (const step of HOW_IT_WORKS) {
        assert.ok(step.title && step.text, step.title);
        assert.doesNotMatch(step.text, JARGON, step.title);
    }
    assert.deepEqual(SCREEN_DEFINITIONS.map((d) => d.key), ["directions", "reach-unit"]);
    assert.ok(!DEFINITIONS.some((d) => SCREEN_DEFINITIONS.some((x) => x.key === d.key)), "not in the report's list");
    assert.match(SCREEN_DEFINITIONS[0].text, /right, left, front and back/i);
    assert.match(SCREEN_DEFINITIONS[0].text, /\+X for right/, "the exported report's axes are explained here");
});

// ---------- the real fixture ----------

await test("the desk lamp fixture: runs in under 2 s; blocks, bodies, cantilevers, issues are plausible", async () => {
    const positions = await readGlbTriangles(resolve(ROOT, "public/assignment_alex/fixtures/demo-assembly.glb"));
    assert.ok(positions.length > 3000);
    const t0 = performance.now();
    const result = analyze({ positions });
    const ms = performance.now() - t0;
    console.log(`       lamp: ${positions.length / 9} triangles, ${result.stats.blockCount} blocks, ${result.stats.bodyCount} bodies (${result.bodies.map((b) => `${b.blocks.length}${b.grounded ? "g" : "f"}`).join(" ")}), ${ms.toFixed(0)} ms (voxelize ${result.timingsMs.voxelize.toFixed(0)}, analyze ${result.timingsMs.analyze.toFixed(0)})`);
    console.log(`       size ${result.sizeMm.map(Math.round).join(" x ")} mm, coverage ${(result.stats.coverage * 100).toFixed(0)}%, ground blocks ${result.stats.groundBlocks}, layers ${result.stats.layers}, cantilevered ${result.stats.cantileveredCount}, longest ${result.stats.longestCantilever}, over limit ${result.stats.overLimitCount}, floating ${result.stats.floatingCount}`);
    if (result.stability) console.log(`       COG ${result.stability.cogMm.map(Math.round).join(", ")} mm, ${result.stability.inside ? "inside" : "OUTSIDE"} the base, margin ${Math.round(result.stability.marginMm)} mm`);
    for (const issue of result.issues) console.log(`       ${issue.severity.toUpperCase()}  ${issue.title}  |  ${issue.detail}`);
    for (const check of result.checks) console.log(`       [${check.status}] ${check.label}: ${check.value}`);
    assert.ok(ms < 2000, `${ms} ms`);
    nearVec(result.sizeMm.map((v) => Math.max(v, 0)).sort((a, b) => b - a).slice(0, 1), [1000], 1e-3);
    assert.ok(result.stats.blockCount > 10 && result.stats.blockCount < 1000);
    assert.equal(result.stats.groundBlocks > 0, true);
    assert.equal(result.blocks.filter((b) => b.cell[2] === 0).length, result.stats.groundBlocks);
    assert.ok(result.bodies.some((b) => b.grounded));
    assert.equal(checkAnalysisSummary(result.summary, Date.now()).ok, true);
    // Every block belongs to exactly one body and the bodies partition the blocks.
    assert.equal(result.bodies.reduce((n, b) => n + b.blocks.length, 0), result.blocks.length);
    // The same model, scaled and moved (a different unit and origin) gives the same blocks.
    const moved = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        moved[i] = positions[i] * 3.5 + 10;
        moved[i + 1] = positions[i + 1] * 3.5 - 4;
        moved[i + 2] = positions[i + 2] * 3.5 + 77;
    }
    const other = analyze({ positions: moved });
    assert.ok(Math.abs(other.blocks.length - result.blocks.length) <= 3, `scale-invariant: ${other.blocks.length} vs ${result.blocks.length}`);
});

await test("fill threshold tuning on the lamp (printed)", async () => {
    const positions = await readGlbTriangles(resolve(ROOT, "public/assignment_alex/fixtures/demo-assembly.glb"));
    const grid = voxelize({ positions }, normalizeSettings({}));
    console.log("       threshold  blocks  bodies  floating  cantilevered  over-limit  coverage  cog");
    for (const t of [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]) {
        const r = analyzeGrid(grid, { fillThreshold: t });
        const cog = r.stability ? `${r.stability.inside ? "in " : "OUT"} ${Math.round(r.stability.marginMm)}` : "-";
        console.log(`       ${t.toFixed(2).padStart(8)}  ${String(r.stats.blockCount).padStart(6)}  ${String(r.stats.bodyCount).padStart(6)}  ${String(r.stats.floatingCount).padStart(8)}  ${String(r.stats.cantileveredCount).padStart(12)}  ${String(r.stats.overLimitCount).padStart(10)}  ${(r.stats.coverage * 100).toFixed(0).padStart(7)}%  ${cog}`);
    }
    // More blocks as the threshold drops (never fewer).
    const counts = [0.6, 0.4, 0.3, 0.2, 0.1].map((t) => analyzeGrid(grid, { fillThreshold: t }).stats.blockCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b));
});

// ---------- speed ----------

function randomTriangles(count, { size = 30, extent = 1000 } = {}) {
    let seed = 424242;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const out = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
        const cx = rand() * extent;
        const cy = rand() * extent;
        const cz = rand() * extent;
        for (let v = 0; v < 3; v++) {
            out[t * 9 + v * 3] = cx + (rand() - 0.5) * size;
            out[t * 9 + v * 3 + 1] = cy + (rand() - 0.5) * size;
            out[t * 9 + v * 3 + 2] = cz + (rand() - 0.5) * size;
        }
    }
    return out;
}

await test("speed: 1M random small triangles in under 3 s", () => {
    const positions = randomTriangles(1_000_000);
    const t0 = performance.now();
    const result = analyze({ positions });
    const ms = performance.now() - t0;
    console.log(`       1M triangles: ${ms.toFixed(0)} ms (voxelize ${result.timingsMs.voxelize.toFixed(0)}, analyze ${result.timingsMs.analyze.toFixed(0)}), ${result.stats.blockCount} blocks`);
    assert.ok(ms < 3000, `${ms} ms`);
    assert.ok(result.stats.blockCount > 900);
});

await test("speed: huge triangles and slivers do not blow up the cell tests", () => {
    // 20,000 triangles each as large as the volume, and 100,000 long thin slivers.
    const large = randomTriangles(20_000, { size: 1000 });
    let t0 = performance.now();
    analyze({ positions: large });
    const largeMs = performance.now() - t0;
    let seed = 7;
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const slivers = new Float32Array(100_000 * 9);
    for (let t = 0; t < 100_000; t++) {
        for (let a = 0; a < 3; a++) {
            slivers[t * 9 + a] = rand() * 1000;
            slivers[t * 9 + 3 + a] = rand() * 1000;
            slivers[t * 9 + 6 + a] = slivers[t * 9 + a] + 0.01;
        }
    }
    t0 = performance.now();
    analyze({ positions: slivers });
    const sliverMs = performance.now() - t0;
    console.log(`       20k volume-sized triangles: ${largeMs.toFixed(0)} ms; 100k slivers: ${sliverMs.toFixed(0)} ms`);
    // (the fine cells are a third of what they were, and the worst inputs scale with the number of cells they touch)
    assert.ok(largeMs < 6000 && sliverMs < 6000);
});

await test("speed: 2M triangles of a real-looking surface (a tessellated sphere shell) in under 3 s", () => {
    // A UV sphere with ~2M triangles: the case the worker has to survive.
    const nu = 1000;
    const nv = 1000;
    const floats = new Float32Array(nu * nv * 2 * 9);
    let o = 0;
    const pt = (u, v) => {
        const a = (u / nu) * Math.PI * 2;
        const b = (v / nv) * Math.PI;
        return [Math.cos(a) * Math.sin(b), Math.sin(a) * Math.sin(b), Math.cos(b)];
    };
    for (let u = 0; u < nu; u++) {
        for (let v = 0; v < nv; v++) {
            const p00 = pt(u, v);
            const p10 = pt(u + 1, v);
            const p01 = pt(u, v + 1);
            const p11 = pt(u + 1, v + 1);
            floats.set([...p00, ...p10, ...p11, ...p00, ...p11, ...p01], o);
            o += 18;
        }
    }
    const t0 = performance.now();
    const result = analyze({ positions: floats });
    const ms = performance.now() - t0;
    console.log(`       2M triangles: ${ms.toFixed(0)} ms (voxelize ${result.timingsMs.voxelize.toFixed(0)}), ${result.stats.blockCount} blocks`);
    assert.ok(ms < 3000, `${ms} ms`);
    // A sphere shell, closed: filled solid, so the inside is part of it.
    assert.ok(result.stats.blockCount > 400 && result.stats.blockCount < 700);
    assert.equal(result.stability.inside, true);
    console.log(`       sphere issues: ${result.issues.map((i) => i.title).join("; ") || "none"}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
