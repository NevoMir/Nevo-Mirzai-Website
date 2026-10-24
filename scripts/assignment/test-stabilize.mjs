// Tests for the stabilizer (src/assignment/analysis/stabilize): the iterative, stress-driven correction of a block assembly.
//   node scripts/assignment/test-stabilize.mjs            (about a minute: FUZZ=n sets the random assemblies, default 40; ONLY=text runs the tests whose name has it)
//
// What is pinned down:
//   - the geometry the search uses (grid.ts) is the engine's own (analyzeStructure), and its stress numbers are computeStress's
//   - the six benchmark shapes of the brief (gallows, leaning tower, table with lost legs, T, mushroom, the desk lamp fixture)
//     end with no error and the stress under the target, within the blocks the design predicts
//   - every result: original blocks untouched, added roles/steps contiguous, the log reads true (no step makes a more important
//     problem worse, figures equal a fresh analysis), the GLB round-trips through readAssemblyGlb + checkDerivedMeta
//   - deterministic (same bytes twice, same blocks with either solver), idempotent, depth 2 keeps earlier roles
//   - caps (blocks, time, cancel), the worker's message protocol, the page-side runner with and without a Worker
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const A = (n) => import(`../../src/assignment/${n}.ts`);
const { stabilize } = await A("analysis/stabilize/stabilize");
const { runStabilize } = await A("analysis/stabilize/runStabilize");
const { evaluateGeometry, cellIndex } = await A("analysis/stabilize/grid");
const { makeStressSolver } = await A("analysis/stabilize/stressAdapter");
const { describeStep } = await A("analysis/stabilize/describe");
const { DEFAULT_STABILIZE_OPTIONS, DEFAULT_TARGET_UTILISATION, MAX_TARGET_UTILISATION, STABILIZER_VERSION, isWorse, problemCost, problemsOf } = await A("analysis/stabilize/types");
const st = await A("analysis/stress");
const asm = await A("analysis/assembly");
const fem = await A("analysis/fem/index");
const { analyze } = await A("analysis/analyze");
const { analyzeStructure } = await A("analysis/structure");
const { normalizeSettings } = await A("analysis/settings");
const { materialOf, STRESS_WARN } = await A("analysis/materials");
const { descriptorFromBlocks, assemblyHash, CELL_STRIDE } = await A("shared/assembly");
const { readAssemblyGlb } = await A("shared/assemblyGlb");
const { checkDerivedMeta } = await A("shared/derivedMeta");
const { BLOCK_ROLES, DERIVED_GLB_LIMIT, DERIVED_META_LIMIT, MAX_STABILIZE_STEPS } = await A("shared/contract");
const { NodeIO } = await import("@gltf-transform/core");

let passed = 0; const failures = [];
async function test(name, fn) { if (process.env.ONLY && !name.includes(process.env.ONLY)) return; try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); } }
const timings = [];

// ---------- shapes (cells [i, j, k], inclusive boxes) ----------

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const box = (x0, x1, y0, y1, z0, z1) => range(x1 - x0 + 1, x0).flatMap((i) => range(y1 - y0 + 1, y0).flatMap((j) => range(z1 - z0 + 1, z0).map((k) => [i, j, k])));
const uniq = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];
const ellipsoid = (cx, cy, cz, rx, ry, rz) => {
    const out = [];
    for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
        const x = (i + 0.5 - cx) / rx, y = (j + 0.5 - cy) / ry, z = (k + 0.5 - cz) / rz;
        if (x * x + y * y + z * z <= 1) out.push([i, j, k]);
    }
    return out;
};
const SHAPES = {
    gallows: uniq([...box(2, 2, 5, 5, 0, 5), ...box(3, 8, 5, 5, 5, 5)]), // 6-block arm off a 6-block column
    leaningTower: uniq(range(10).flatMap((k) => box(Math.floor(k / 2), Math.floor(k / 2) + 1, 4, 4, k, k))), // 2 x 1 section, 1 block shift per 2 layers
    table: uniq(box(0, 9, 0, 9, 5, 6)), // top 10 x 10 x 2 whose legs the voxeliser lost: all of it floats
    tShape: uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 4, 4, 6, 6)]), // 1-block stem, 10-long cap: overhangs 4 and 5
    mushroom: uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 0, 9, 6, 7)]), // 1 x 1 x 6 stem, 10 x 10 x 2 cap
};
const EXTRA = {
    shelfArm: uniq([...box(0, 2, 0, 2, 0, 0), ...box(1, 1, 1, 1, 1, 5), ...box(2, 8, 1, 1, 5, 5)]),
    arm5: uniq([...box(2, 2, 5, 5, 0, 5), ...box(3, 7, 5, 5, 5, 5)]),
    arm8off3: uniq([...box(1, 1, 5, 5, 0, 2), ...box(2, 9, 5, 5, 2, 2)]),
    arm4: uniq([...box(1, 1, 5, 5, 0, 5), ...box(2, 5, 5, 5, 5, 5)]), // the limit case: reach 4 passes, only the base tips
    arm4wide: uniq([...box(1, 1, 5, 5, 0, 5), ...box(2, 5, 4, 6, 5, 5)]),
    tStem2: uniq([...box(4, 5, 4, 4, 0, 5), ...box(0, 9, 4, 4, 6, 6)]),
    tWide: uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 3, 5, 6, 7)]),
    crane: uniq([...box(3, 5, 3, 5, 0, 0), ...box(4, 4, 4, 4, 1, 8), ...box(1, 9, 4, 4, 9, 9), ...box(1, 2, 4, 4, 8, 8)]),
    humanoid: uniq([...box(3, 3, 4, 4, 0, 3), ...box(5, 5, 4, 4, 0, 3), ...box(3, 5, 4, 5, 4, 7), ...box(0, 2, 4, 4, 7, 7), ...box(6, 8, 4, 4, 7, 7), ...box(3, 4, 4, 5, 8, 9)]),
    dino: uniq([...box(1, 6, 3, 5, 2, 4), ...[[1, 3], [1, 5], [5, 3], [5, 5]].flatMap(([x, y]) => box(x, x, y, y, 0, 1)), ...box(7, 7, 4, 4, 3, 5), ...box(7, 9, 3, 5, 5, 6), ...box(0, 0, 4, 4, 3, 3)]),
    chairLost: uniq([...box(3, 6, 3, 6, 3, 3), ...box(3, 6, 6, 6, 4, 7)]),
    thickCap: uniq([...box(4, 5, 4, 5, 0, 5), ...box(0, 9, 0, 9, 6, 9)]), // 10 x 10 x 4 cap on a 2 x 2 stem, already a warning
};
// Already fine: the stabilizer must leave them alone.
const CONTROLS = {
    chair: uniq([...box(3, 6, 3, 6, 3, 3), ...box(3, 6, 6, 6, 4, 7), ...[[3, 3], [6, 3], [3, 6], [6, 6]].flatMap(([x, y]) => box(x, x, y, y, 0, 2))]),
    tree: uniq([...box(4, 5, 4, 5, 0, 4), ...ellipsoid(5, 5, 7, 4.6, 4.6, 2.4)]),
    bridge: uniq([...box(0, 1, 4, 5, 0, 3), ...box(8, 9, 4, 5, 0, 3), ...box(0, 9, 4, 5, 4, 5)]),
    house: uniq([...box(2, 7, 2, 7, 0, 3).filter(([i, j]) => !(i >= 3 && i <= 6 && j >= 3 && j <= 6)), ...box(0, 9, 0, 9, 4, 4)]),
    rocket: uniq([...box(4, 5, 4, 5, 0, 8), ...box(2, 3, 4, 5, 1, 2), ...box(6, 7, 4, 5, 1, 2), ...box(4, 5, 2, 3, 1, 1), ...box(4, 5, 6, 7, 1, 1)]),
    fourLegTable: uniq([...box(0, 0, 0, 0, 0, 4), ...box(9, 9, 0, 0, 0, 4), ...box(0, 0, 9, 9, 0, 4), ...box(9, 9, 9, 9, 0, 4), ...box(0, 9, 0, 9, 5, 6)]), // 74 % of the allowable: under the target
    pyramid: uniq([0, 1, 2, 3].flatMap((q) => box(q, 9 - q, q, 9 - q, q * 2, q * 2 + 1))),
    footbridge: uniq([...box(0, 1, 3, 5, 0, 3), ...box(8, 9, 3, 5, 0, 3), ...box(0, 9, 3, 5, 4, 4)]),
};

/** The desk lamp fixture, voxelised by the engine the way the app does it (a Y-up glTF turned into the viewer's Z-up frame). */
async function lampCells() {
    const doc = await new NodeIO().read(resolve(ROOT, "public/assignment_alex/fixtures/demo-assembly.glb"));
    const floats = [];
    for (const scene of doc.getRoot().listScenes()) scene.traverse((node) => {
        const mesh = node.getMesh(); if (!mesh) return;
        const m = node.getWorldMatrix();
        const world = (p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
        for (const prim of mesh.listPrimitives()) {
            if (prim.getMode() !== 4) continue;
            const pos = prim.getAttribute("POSITION").getArray();
            const indices = prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
            for (const i of indices) { const w = world([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); floats.push(w[0], -w[2], w[1]); }
        }
    });
    return analyze({ positions: new Float32Array(floats) }).blocks.map((b) => [...b.cell]);
}

// ---------- the harness ----------

const settings = normalizeSettings({});
const TARGET = DEFAULT_TARGET_UTILISATION;
const STAMP = { createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1 };
const wasmPath = resolve(ROOT, "src/assignment/analysis/fem/vendor/lSolver.wasm");
const wasm = await st.loadSolver(wasmPath);
const tsSolver = { solve: fem.solveFrameTs, backend: "ts" };
const baseOptions = { ...DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000, stamp: STAMP };
const run = (cells, { options = {}, depth = 0, assembly = null, solver = wasm, settings: s = settings, ...hooks } = {}) =>
    stabilize({ cells, settings: s, options: { ...baseOptions, ...options }, assembly }, depth, { solver, ...hooks });
const key = (c) => c[0] + 10 * c[1] + 100 * c[2];
const cellsOfDescriptor = (d) => range(d.cells.length / CELL_STRIDE).map((n) => [d.cells[n * CELL_STRIDE], d.cells[n * CELL_STRIDE + 1], d.cells[n * CELL_STRIDE + 2]]);
const fresh = (descriptor, s = settings) => {
    const result = asm.analyzeAssembly(descriptor, null, s);
    const stress = st.computeStress(result, wasm, s.material);
    return { result: st.applyStress(result, stress), stress };
};
const same = (a, b, eps = 1e-9) => (a === null || b === null ? a === b : Math.abs(a - b) <= eps);
const timed = async (name, fn) => { const t = performance.now(); const out = await fn(); timings.push([name, performance.now() - t]); return out; };

/** Everything that must hold of any result, whatever the input. Returns the fresh analysis of the final blocks. */
async function verify(name, cells, r, { prior = null, depth = 1, target = TARGET, s = settings } = {}) {
    const { meta, descriptor } = r;
    // the GLB: what the Worker will accept, and exactly what we hold
    assert.ok(r.glb.byteLength <= DERIVED_GLB_LIMIT, `${name}: GLB ${r.glb.byteLength} bytes`);
    const read = readAssemblyGlb(r.glb, null);
    assert.ok(read.ok, `${name}: ${read.error}`);
    assert.deepEqual(read.descriptor, descriptor, `${name}: descriptor round-trips`);
    assert.deepEqual(read.meta, meta, `${name}: meta round-trips`);
    assert.ok(checkDerivedMeta(meta, null).ok, `${name}: meta validates`);
    assert.ok(JSON.stringify(meta).length <= DERIVED_META_LIMIT);
    assert.equal(meta.assembly_hash, await assemblyHash(descriptor), `${name}: hash`);
    assert.equal(meta.depth, depth);
    assert.equal(meta.stabilizer, STABILIZER_VERSION);
    assert.equal(meta.material, s.material);
    assert.equal(meta.target_utilisation, target);
    // originals untouched, with the role and step they had; the rest added with a role and a step
    const given = new Map();
    cells.forEach((c, n) => given.set(key(c), prior ? [prior.cells[n * CELL_STRIDE + 3], prior.cells[n * CELL_STRIDE + 4]] : [0, 0]));
    const offset = prior ? Math.max(0, ...range(prior.cells.length / CELL_STRIDE).map((n) => prior.cells[n * CELL_STRIDE + 4])) : 0;
    const addedAt = new Map();
    for (let n = 0; n < descriptor.cells.length; n += CELL_STRIDE) {
        const k = key(descriptor.cells.slice(n, n + 3));
        const role = descriptor.cells[n + 3], step = descriptor.cells[n + 4];
        if (given.has(k)) assert.deepEqual([role, step], given.get(k), `${name}: given block ${k} changed`);
        else {
            assert.ok(role !== 0 && step > offset, `${name}: added block has role ${BLOCK_ROLES[role]}, step ${step}`);
            addedAt.set(step, (addedAt.get(step) ?? 0) + 1);
        }
    }
    for (const k of given.keys()) assert.ok(cellsOfDescriptor(descriptor).some((c) => key(c) === k), `${name}: a given block is gone`);
    // the log: contiguous, adds up, every move leaves nothing important worse, each move's figures chain into the next
    assert.ok(meta.steps.length <= MAX_STABILIZE_STEPS);
    meta.steps.forEach((step, q) => {
        assert.equal(step.n, q + 1, `${name}: step numbers`);
        assert.equal(addedAt.get(offset + step.n), step.added, `${name}: step ${step.n} added ${step.added} but the descriptor has ${addedAt.get(offset + step.n)}`);
        assert.ok(step.text.length <= 300 && /\d/.test(step.text), `${name}: step text "${step.text}"`);
        assert.ok(isWorse(step.after, step.before, target, 0.0015) === false, `${name}: step ${step.n} makes things worse: ${JSON.stringify(step.before)} -> ${JSON.stringify(step.after)}`);
        if (q > 0) assert.deepEqual(step.before, { ...meta.steps[q - 1].after }, `${name}: step ${step.n} starts where step ${step.n - 1} ended`);
    });
    // no row quotes a number it did not move (foldInert): a move that changes nothing is folded into the one that does, unless nothing in the log does
    const shown = (m) => [m.errors, m.floating_blocks, m.over_limit, m.longest_cantilever, m.max_utilisation === null ? null : Math.round(m.max_utilisation * 100), m.cog_margin_mm === null ? null : Math.round(m.cog_margin_mm)].join();
    const inert = meta.steps.filter((step) => shown(step.before) === shown(step.after));
    assert.ok(inert.length === 0 || inert.length === meta.steps.length, `${name}: steps that change none of the figures they quote: ${inert.map((step) => `#${step.n} ${step.text}`).join(" | ")}`);
    assert.equal(meta.steps.reduce((n, step) => n + step.added, 0), meta.added_blocks);
    assert.equal(addedAt.size, meta.steps.length);
    assert.equal(r.addedByRole && Object.values(r.addedByRole).reduce((n, v) => n + v, 0), meta.added_blocks);
    assert.deepEqual(r.addedByRole, meta.added_by_role);
    // the figures are the engine's: a fresh analysis of the final blocks, and of the given ones
    const end = fresh(descriptor, s);
    const startDescriptor = descriptorFromBlocks(cells.map((cell) => ({ cell })));
    const start = fresh(startDescriptor, s);
    for (const [label, m, f] of [["after", r.after, end], ["before", r.before, start]]) {
        const sum = f.result.summary;
        assert.equal(m.blocks, sum.blocks, `${name}: ${label}.blocks`);
        assert.equal(m.errors, sum.errors, `${name}: ${label}.errors`);
        assert.equal(m.warnings, sum.warnings, `${name}: ${label}.warnings`);
        assert.equal(m.floating_blocks, sum.floating_blocks);
        assert.equal(m.over_limit, sum.over_limit);
        assert.equal(m.longest_cantilever, sum.longest_cantilever);
        assert.ok(same(m.cog_margin_mm, f.result.stability ? sum.cog_margin_mm : null), `${name}: ${label}.cog_margin_mm ${m.cog_margin_mm} vs ${sum.cog_margin_mm}`);
        // A peak that only the grounded part has (blocks float) is unknown below the warning level: see measure.ts
        const peak = f.stress ? f.stress.maxUtilisation : null;
        const unknownPeak = peak !== null && sum.floating_blocks > 0 && peak < Math.min(target, STRESS_WARN);
        assert.ok(same(m.max_utilisation, peak === null || unknownPeak ? null : Math.min(50, Math.round(peak * 1000) / 1000)), `${name}: ${label}.max_utilisation ${m.max_utilisation} vs ${peak}`);
        assert.equal(m.overstressed_blocks, f.stress ? f.stress.overstressedBlocks : 0);
    }
    assert.deepEqual(meta.before, r.before);
    assert.deepEqual(meta.after, r.after);
    assert.deepEqual({ ...meta.after_summary, analyzed_at: "" }, { ...end.result.summary, analyzed_at: "" }, `${name}: after_summary`);
    assert.equal(meta.after.blocks, meta.before.blocks + meta.added_blocks);
    if (meta.steps.length > 0) {
        assert.deepEqual(meta.steps[0].before, { ...(({ warnings, overstressed_blocks, ...rest }) => rest)(meta.before) });
        assert.deepEqual(meta.steps.at(-1).after, { ...(({ warnings, overstressed_blocks, ...rest }) => rest)(meta.after) });
        // the run as a whole made the problems smaller: in the order of importance, the first that changed went down
        const pa = problemsOf(meta.steps.at(-1).after, target), pb = problemsOf(meta.steps[0].before, target);
        const first = pa.findIndex((v, n) => Math.abs(v - pb[n]) > 0.0015);
        assert.ok(first >= 0 && pa[first] < pb[first], `${name}: the run did not improve anything: ${pb} -> ${pa}`);
    }
    // complete means what it says
    if (r.complete) {
        assert.equal(end.result.summary.errors, 0, `${name}: complete but ${end.result.summary.errors} errors`);
        assert.ok(end.stress === null || end.stress.maxUtilisation <= target + 1e-9, `${name}: complete but stress ${end.stress?.maxUtilisation}`);
    }
    assert.equal(meta.complete, r.complete);
    assert.equal(meta.stop, r.stop);
    return end;
}

const roleCount = (r, role) => r.addedByRole[role] ?? 0;
const between = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what} = ${v}, expected ${lo}..${hi}`);

// ============================================================================================================================
console.log("engine parity");

await test("the search's geometry (grid.ts) is the engine's: counts, floating, overhang, reach of every block, centre-of-gravity margin", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const d = { gx: 10, gy: 10, gz: 10 };
    for (let t = 0; t < 300; t++) {
        const occ = new Uint8Array(1000);
        const density = 0.05 + rnd() * 0.45;
        for (let q = 1 + Math.floor(rnd() * 4); q > 0; q--) {
            const cx = Math.floor(rnd() * 10), cy = Math.floor(rnd() * 10), cz = Math.floor(rnd() * 10), r = 1 + Math.floor(rnd() * 4);
            for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++)
                if (Math.abs(i - cx) <= r && Math.abs(j - cy) <= r && Math.abs(k - cz) <= r && rnd() < density * 2.2) occ[cellIndex(d, i, j, k)] = 1;
        }
        if (!occ.some((v) => v)) continue;
        const desc = { version: 1, blockSizeMm: 100, grid: [10, 10, 10], inset: 0.96, cells: [] };
        for (let c = 0; c < 1000; c++) if (occ[c]) desc.cells.push(c % 10, Math.floor(c / 10) % 10, Math.floor(c / 100), 0, 0);
        const res = asm.analyzeAssembly(desc, null, settings);
        const g = evaluateGeometry(occ, d, 100, settings.cantileverLimit, 100);
        assert.equal(res.stats.blockCount, g.count, `t=${t} blocks`);
        assert.equal(res.stats.floatingCount, g.floatingCells, `t=${t} floating`);
        assert.equal(res.stats.overLimitCount, g.overreachCells, `t=${t} over limit`);
        assert.equal(res.stats.longestCantilever, g.longestReach, `t=${t} longest`);
        for (const b of res.blocks) {
            const c = cellIndex(d, b.cell[0], b.cell[1], b.cell[2]);
            assert.equal(g.reach[c], b.reach === null ? -1 : b.reach, `t=${t} reach of ${b.cell}`);
        }
        const margin = res.stability ? res.stability.marginMm : Infinity;
        assert.ok(Math.abs(margin - g.marginMm) < 1e-6 || (margin === Infinity && g.marginMm === Infinity), `t=${t} margin ${margin} vs ${g.marginMm}`);
        // sanity of the independent structure analysis too
        assert.equal(analyzeStructure(asm.gridFromAssembly(desc, null, settings), settings).stats.blockCount, g.count);
    }
});

await test("the search's stress numbers are computeStress's: per-block utilisation, both materials, with and without a floating part", async () => {
    const lamp = await lampCells();
    for (const material of ["concrete", "timber"]) {
        const s = normalizeSettings({ material });
        const solver = makeStressSolver({ solve: wasm.solve, blockSizeMm: 100, material: materialOf(material).fem });
        for (const [name, cells] of Object.entries({ ...SHAPES, lamp, crane: EXTRA.crane, dino: EXTRA.dino })) {
            if (name === "table") continue; // nothing stands on the ground: no field
            const desc = descriptorFromBlocks(cells.map((cell) => ({ cell })));
            const res = asm.analyzeAssembly(desc, null, s);
            const stress = st.computeStress(res, wasm, material);
            const occ = new Uint8Array(1000);
            for (const c of cells) occ[cellIndex({ gx: 10, gy: 10, gz: 10 }, c[0], c[1], c[2])] = 1;
            const field = solver(occ, { gx: 10, gy: 10, gz: 10 });
            assert.ok(Math.abs(field.maxUtil - stress.maxUtilisation) < 1e-9, `${material} ${name}: max ${field.maxUtil} vs ${stress.maxUtilisation}`);
            res.blocks.forEach((b) => {
                const v = stress.byBlock[b.index];
                const mine = field.util[cellIndex({ gx: 10, gy: 10, gz: 10 }, b.cell[0], b.cell[1], b.cell[2])];
                assert.ok(Number.isNaN(v) ? mine === 0 : Math.abs(mine - v) < 1e-5 * Math.max(1, v), `${material} ${name} block ${b.cell}: ${mine} vs ${v}`);
            });
        }
    }
});

await test("the thresholds line up: a 4-block concrete arm is under the target, a 5-block arm over it (the cantilever rule and the stress rule agree)", async () => {
    const util = (cells) => fresh(descriptorFromBlocks(cells.map((cell) => ({ cell })))).stress.maxUtilisation;
    const arm = (n) => uniq([...box(0, 0, 0, 0, 0, 5), ...range(n, 1).map((i) => [i, 0, 5])]);
    assert.ok(util(arm(4)) < TARGET, `4-block arm ${util(arm(4))}`);
    assert.ok(util(arm(5)) > 1, `5-block arm ${util(arm(5))}`);
});

// ============================================================================================================================
console.log("the benchmark shapes of the brief");

await test("gallows: 6-block arm off a 6-block column  ->  a column under the tip + a footing; no error, stress far under the target", async () => {
    const r = await timed("gallows", () => run(SHAPES.gallows));
    await verify("gallows", SHAPES.gallows, r);
    assert.equal(r.before.errors, 3); assert.ok(r.before.cog_margin_mm < 0 && r.before.max_utilisation > 1);
    assert.ok(r.complete && r.stop === "stable" && r.after.errors === 0 && r.after.max_utilisation <= TARGET);
    between(r.meta.added_blocks, 6, 9, "added"); assert.equal(roleCount(r, "column"), 5); between(roleCount(r, "footing"), 1, 3, "footing");
    assert.ok(r.after.longest_cantilever <= 4 && r.after.cog_margin_mm >= 100 - 1e-6);
});

await test("leaning tower (2 x 1 section, one block of lean per two layers)  ->  a footing and braces in the inner corners", async () => {
    const r = await timed("leaning tower", () => run(SHAPES.leaningTower));
    await verify("leaning tower", SHAPES.leaningTower, r);
    assert.ok(r.before.cog_margin_mm < 0 && r.before.max_utilisation > 2);
    assert.ok(r.complete && r.after.max_utilisation <= TARGET);
    between(r.meta.added_blocks, 5, 9, "added"); between(roleCount(r, "footing"), 3, 5, "footing"); between(roleCount(r, "bracket"), 2, 4, "bracket");
});

await test("table whose thin legs the voxeliser lost (200 floating blocks)  ->  four legs in one move", async () => {
    const r = await timed("table", () => run(SHAPES.table));
    await verify("table", SHAPES.table, r);
    assert.equal(r.before.floating_blocks, 200); assert.equal(r.before.max_utilisation, null);
    assert.ok(r.complete); assert.equal(r.after.floating_blocks, 0);
    assert.equal(r.meta.steps.length, 1); assert.equal(r.meta.added_blocks, 20); assert.equal(roleCount(r, "column"), 20);
    // four legs: the added cells make four separate columns of five blocks, one near each corner
    const added = cellsOfDescriptor(r.descriptor).filter((c) => c[2] < 5);
    const feet = new Set(added.map((c) => `${c[0]},${c[1]}`));
    assert.equal(feet.size, 4); for (const f of feet) assert.equal(added.filter((c) => `${c[0]},${c[1]}` === f).length, 5);
});

await test("T: 1-block stem under a 10-long cap (overhangs 4 and 5)  ->  the stem widens by one column, plus a footing", async () => {
    const r = await timed("T", () => run(SHAPES.tShape));
    await verify("T", SHAPES.tShape, r);
    assert.equal(r.before.over_limit, 1); assert.ok(r.before.max_utilisation > 1);
    assert.ok(r.complete); between(r.meta.added_blocks, 6, 10, "added"); assert.equal(roleCount(r, "column"), 6); between(roleCount(r, "footing"), 0, 3, "footing");
    assert.ok(r.after.longest_cantilever <= 4 && r.after.max_utilisation <= TARGET);
});

await test("mushroom: 1 x 1 x 6 stem under a 10 x 10 x 2 cap (stress 1177 %)  ->  the stem grows to 2 x 2 in one move", async () => {
    const r = await timed("mushroom", () => run(SHAPES.mushroom));
    await verify("mushroom", SHAPES.mushroom, r);
    assert.equal(r.before.over_limit, 38); assert.ok(r.before.max_utilisation > 10);
    assert.ok(r.complete && r.after.max_utilisation <= TARGET && r.after.over_limit === 0);
    // The 2 x 2 stem is three columns of six, found as ONE move: a single extra column on the way would raise the stress.
    assert.equal(r.meta.added_blocks, 18); assert.equal(roleCount(r, "column"), 18); assert.equal(r.meta.steps.length, 1);
});

await test("desk lamp fixture (voxelised: 26 floating blocks in 5 parts)  ->  bridges and legs join every part, within +40 blocks", async () => {
    const cells = await lampCells();
    const r = await timed("desk lamp", () => run(cells));
    await verify("lamp", cells, r);
    assert.equal(r.before.floating_blocks, 26);
    assert.ok(r.complete && r.after.floating_blocks === 0 && r.after.errors === 0 && r.after.max_utilisation <= TARGET);
    between(r.meta.added_blocks, 8, 40, "added");
    assert.ok(roleCount(r, "bridge") + roleCount(r, "column") > 0);
});

await test("variants of the brief: 5-block arm, 8-block arm off a short column, 4-block limit case, wide arm, 2-wide stem, wide cap, crane, humanoid, dino, lost-leg chair, thick cap", async () => {
    const expect = {
        arm5: { added: [5, 9] }, arm8off3: { added: [3, 8] }, arm4: { added: [2, 6], util: 0.706 }, arm4wide: { added: [5, 12] }, tStem2: { added: [1, 4] }, tWide: { added: [6, 12] },
        crane: { added: [6, 12] }, humanoid: { added: [1, 5] }, dino: { added: [1, 3] }, chairLost: { added: [4, 16] }, thickCap: { added: [12, 30] }, shelfArm: { added: [4, 7] },
    };
    for (const [name, want] of Object.entries(expect)) {
        const r = await timed(name, () => run(EXTRA[name]));
        await verify(name, EXTRA[name], r);
        assert.ok(r.complete, `${name}: stop ${r.stop}, errors ${r.after.errors}, stress ${r.after.max_utilisation}`);
        between(r.meta.added_blocks, want.added[0], want.added[1], `${name} added`);
        // an arm of the allowed length keeps its stress (it was under the target): only the base is widened
        if (want.util) assert.ok(Math.abs(r.after.max_utilisation - want.util) < 0.01, `${name}: stress ${r.after.max_utilisation}`);
    }
});

await test("controls (chair, tree, bridge, house, rocket, four-leg table, pyramid, footbridge): already fine, nothing is added, the result is the same blocks", async () => {
    for (const [name, cells] of Object.entries(CONTROLS)) {
        const r = await timed(`control ${name}`, () => run(cells));
        await verify(name, cells, r);
        assert.equal(r.meta.added_blocks, 0, name); assert.equal(r.meta.steps.length, 0, name);
        assert.equal(r.stop, "stable"); assert.ok(r.complete);
        assert.equal(r.descriptor.cells.length / CELL_STRIDE, cells.length);
        assert.deepEqual(r.before, r.after);
    }
});

await test("sentences: each step names its move with both numbers; several columns read as columns", async () => {
    const r = await run(SHAPES.mushroom);
    assert.match(r.meta.steps[0].text, /^Added 3 columns \(18 blocks\) under the .* because the cantilever reached 5 > 4 blocks\. Longest cantilever 5 → 4; peak stress 1177% → 69%\.$/);
    const g = await run(SHAPES.gallows);
    assert.match(g.meta.steps[0].text, /^Added a 5-block column under the arm tip at x = \d+ mm, y = \d+ mm because the cantilever reached 6 > 4 blocks\. Longest cantilever 6 → 3; peak stress 148% → \d+%\.$/);
    assert.ok(g.meta.steps.slice(1).every((s) => s.reason === "cog" && /^Widened the base with .* COG margin -?\d+ → \d+ mm\.$/.test(s.text)), g.meta.steps.map((s) => s.text).join(" | "));
    const t = await run(SHAPES.table);
    assert.match(t.meta.steps[0].text, /^Added 4 columns \(20 blocks\) under the floating part at x = \d+ mm, y = \d+ mm so it reaches the ground\. Floating blocks 200 → 0\.$/);
    const lamp = await run(await lampCells());
    assert.ok(lamp.meta.steps.some((s) => /^Joined the floating part \(\d+ blocks, around \d+ mm high\) to the structure with a \d+-block bridge\. Floating blocks \d+ → \d+\.$/.test(s.text)), lamp.meta.steps.map((s) => s.text).join("\n"));
    for (const rr of [r, g, t, lamp]) for (const s of rr.meta.steps) assert.ok(s.text.length <= 300);
});

await test("describeStep: the templates stay under 300 characters whatever the numbers", () => {
    const m = { blocks: 999, errors: 12, floating_blocks: 999, over_limit: 999, longest_cantilever: 999, cog_margin_mm: -1999.5, max_utilisation: 49.999 };
    for (const reason of ["floating", "cantilever", "cog", "stress"]) for (const move of BLOCK_ROLES.slice(1)) {
        const text = describeStep({ move, reason, added: 999, parts: 99, atMm: [1999.5, 1999.5, 1999.5], target: "overhang with a very long name that goes on", before: m, after: m, limit: 10, partBlocks: 999, trigger: 49.999, side: "+X and -Y", cell: [9, 9, 9] });
        assert.ok(text.length <= 300 && text.length > 20, `${reason}/${move}: ${text.length}`);
    }
});

await test("the order of problems: a move may raise a less important one, never a more important one", () => {
    const m = (o) => ({ floating_blocks: 0, over_limit: 0, cog_margin_mm: 120, max_utilisation: 0.5, ...o });
    assert.equal(isWorse(m({ floating_blocks: 0, max_utilisation: 3 }), m({ floating_blocks: 12 }), 0.75), false, "joining a floating part may raise the stress");
    assert.equal(isWorse(m({ max_utilisation: 0.9 }), m({ max_utilisation: 0.5 }), 0.75), true);
    assert.equal(isWorse(m({ max_utilisation: 0.7 }), m({ max_utilisation: 0.5 }), 0.75), false, "under the target is the same as under the target");
    assert.equal(isWorse(m({ cog_margin_mm: -5 }), m({ cog_margin_mm: 10, max_utilisation: 2 }), 0.75), true, "tipping is worse than stress");
    assert.equal(isWorse(m({ over_limit: 3, max_utilisation: 0.1 }), m({ over_limit: 2 }), 0.75), true);
    assert.equal(isWorse(m({}), m({}), 0.75), false);
    assert.deepEqual(problemsOf(m({ floating_blocks: 2, over_limit: 3, cog_margin_mm: -10, max_utilisation: 1.25 }), 0.75), [2, 3, 11, 0.5, 110]);
    assert.ok(problemCost({ ...m({}), errors: 0 }, 0.75) === 0 && problemCost({ ...m({ floating_blocks: 5 }), errors: 1 }, 0.75) > 1000);
});

// ============================================================================================================================
console.log("determinism, idempotence, depth");

await test("deterministic: the same input gives the same GLB bytes twice (with the clock stamped), also with the cleanup in play", async () => {
    for (const [name, cells] of Object.entries({ ...SHAPES, ...EXTRA })) {
        const a = await run(cells), b = await run(cells);
        assert.equal(Buffer.compare(Buffer.from(a.glb), Buffer.from(b.glb)), 0, name);
        assert.equal(a.meta.assembly_hash, b.meta.assembly_hash);
    }
});

await test("with the TypeScript solver the blocks, the log and the figures are the same as with Awatif's WASM (only the solver's name differs)", async () => {
    assert.equal(wasm.backend, "wasm", "the WASM solver must load in Node, else this compares the fallback with itself");
    for (const [name, cells] of Object.entries({ ...SHAPES, ...EXTRA, lamp: await lampCells() })) {
        const a = await run(cells), b = await run(cells, { solver: tsSolver });
        assert.equal(a.meta.solver, "awatif-wasm"); assert.equal(b.meta.solver, "awatif-ts");
        assert.equal(a.meta.assembly_hash, b.meta.assembly_hash, name);
        assert.deepEqual(a.descriptor, b.descriptor, name);
        assert.deepEqual(a.meta.steps.map((s) => [s.text, s.at_mm]), b.meta.steps.map((s) => [s.text, s.at_mm]), name);
        assert.deepEqual({ ...a.meta, solver: "", after_summary: null }, { ...b.meta, solver: "", after_summary: null }, name);
    }
});

await test("idempotent: stabilizing a stabilized model (as depth 2) adds nothing and says so", async () => {
    for (const [name, cells] of Object.entries({ ...SHAPES, ...EXTRA })) {
        const first = await run(cells);
        if (!first.complete) continue;
        const again = await run(cellsOfDescriptor(first.descriptor), { depth: 1, assembly: first.descriptor });
        assert.equal(again.meta.added_blocks, 0, `${name}: added ${again.meta.added_blocks}`);
        assert.equal(again.stop, "stable");
        assert.deepEqual(again.descriptor.cells, first.descriptor.cells, `${name}: the blocks, roles and steps are unchanged`);
        assert.equal(again.meta.assembly_hash, first.meta.assembly_hash);
        await verify(`${name} again`, cellsOfDescriptor(first.descriptor), again, { prior: first.descriptor, depth: 2 });
    }
});

await test("depth: a stabilized model is the 'original' of the next run; earlier additions keep their roles and steps, new steps follow them", async () => {
    // One move only, so the first run stops short (the tower is still tipping and overstressed) and the second has real work to do.
    const tower = SHAPES.leaningTower;
    const first = await run(tower, { options: { maxSteps: 1 } });
    assert.equal(first.stop, "max-steps"); assert.equal(first.meta.steps.length, 1); assert.equal(first.complete, false);
    await verify("tower, 1 step", tower, first);
    const cells2 = cellsOfDescriptor(first.descriptor);
    const second = await run(cells2, { depth: 1, assembly: first.descriptor });
    await verify("tower, depth 2", cells2, second, { prior: first.descriptor, depth: 2 });
    assert.ok(second.complete); assert.equal(second.meta.depth, 2);
    const offset = 1; // the first run's last step
    for (let n = 0; n < second.descriptor.cells.length; n += CELL_STRIDE) {
        const k = key(second.descriptor.cells.slice(n, n + 3));
        const was = first.descriptor.cells.findIndex((_, q) => q % CELL_STRIDE === 0 && key(first.descriptor.cells.slice(q, q + 3)) === k);
        if (was >= 0) assert.deepEqual(second.descriptor.cells.slice(n + 3, n + 5), first.descriptor.cells.slice(was + 3, was + 5), "an earlier block changed");
        else assert.ok(second.descriptor.cells[n + 4] > offset && second.descriptor.cells[n + 4] <= offset + second.meta.steps.length);
    }
    // what the first run added (role column, step 1) is still "column"; the true originals are still "original"
    const roles = (d) => { const o = {}; for (let n = 0; n < d.cells.length; n += CELL_STRIDE) o[BLOCK_ROLES[d.cells[n + 3]]] = (o[BLOCK_ROLES[d.cells[n + 3]]] ?? 0) + 1; return o; };
    assert.equal(roles(second.descriptor).original, tower.length);
    assert.equal(roles(second.descriptor).footing, roles(first.descriptor).footing + (second.addedByRole.footing ?? 0), "the first run's footing is still a footing");
    // The 'original' view of the final model is exactly the blocks of the very first input.
    assert.equal(asm.originalOf(second.descriptor).cells.length / CELL_STRIDE, tower.length);
});

await test("depth is limited: a model stabilized three times cannot be stabilized again; bad input is refused with a clear message", async () => {
    await assert.rejects(run(SHAPES.gallows, { depth: 3 }), /maximum number of times/);
    await assert.rejects(run([]), /no blocks/);
    await assert.rejects(run([[0, 0, 0], [0, 0, 0]]), /listed twice/);
    await assert.rejects(run([[0, 0, 10]]), /outside/);
    await assert.rejects(run([[0, 0, 0.5]]), /outside/);
    await assert.rejects(run(SHAPES.gallows, { s: normalizeSettings({ blockSizeMm: 50 }), settings: normalizeSettings({ blockSizeMm: 50 }) }), /100 mm blocks/);
    const d = descriptorFromBlocks([{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }]);
    await assert.rejects(run([[0, 0, 0], [5, 5, 0]], { assembly: d }), /not the same blocks/);
    await assert.rejects(run([[0, 0, 0]], { assembly: d }), /not the same blocks/);
    await assert.rejects(run([[0, 0, 0]], { assembly: { version: 1 } }), /not a valid block list/);
});

await test("a stabilized model with a different material: timber keeps the geometry fixes and needs no stress fix; the log says which material", async () => {
    const timber = normalizeSettings({ material: "timber" });
    const r = await run(SHAPES.gallows, { settings: timber });
    await verify("gallows in timber", SHAPES.gallows, r, { s: timber });
    assert.equal(r.meta.material, "timber"); assert.ok(r.complete);
    assert.ok(r.before.max_utilisation < 0.25, `timber stress ${r.before.max_utilisation}`);
    assert.ok(r.meta.steps.every((s) => s.reason !== "stress"));
});

await test("another target: 40 % makes the T's stem stiffer than the default needs; a target above the warning level (75 %) is lowered to it", async () => {
    const strict = await run(SHAPES.tShape, { options: { targetUtilisation: 0.4 } });
    await verify("T at 40 %", SHAPES.tShape, strict, { target: 0.4 });
    assert.ok(strict.after.max_utilisation <= 0.4 + 1e-9 || !strict.complete);
    const loose = await run(EXTRA.arm4, { options: { targetUtilisation: 1 } });
    assert.equal(loose.meta.target_utilisation, MAX_TARGET_UTILISATION);
    await verify("arm4 asked for 100 %", EXTRA.arm4, loose, { target: MAX_TARGET_UTILISATION });
    assert.ok(loose.complete);
    assert.equal(MAX_TARGET_UTILISATION, STRESS_WARN, "the highest target is the warning level");
    assert.equal(DEFAULT_TARGET_UTILISATION, STRESS_WARN);
});

await test("complete means no stress warning either: a target above the warning level is lowered to it, so a warn-only model is still fixed when 90 % is asked for", async () => {
    // A 3 x 3 stem under a 10 x 10 x 2 cap: 85 % of the allowable, one warning, no error. At 90 % it would have been left alone.
    const warnOnly = uniq([...box(3, 5, 3, 5, 0, 5), ...box(0, 9, 0, 9, 6, 7)]);
    const start = fresh(descriptorFromBlocks(warnOnly.map((cell) => ({ cell }))));
    assert.ok(start.stress.maxUtilisation > 0.8 && start.stress.maxUtilisation < 0.9, `${start.stress.maxUtilisation}`);
    assert.equal(start.result.summary.errors, 0); assert.equal(start.result.summary.warnings, 1);
    const reference = await run(warnOnly);
    for (const asked of [0.75, 0.8, 0.9, 1, 7, Number.POSITIVE_INFINITY]) {
        const r = await run(warnOnly, { options: { targetUtilisation: asked } });
        await verify(`warn-only, asked ${asked}`, warnOnly, r, { target: MAX_TARGET_UTILISATION });
        assert.equal(r.meta.target_utilisation, MAX_TARGET_UTILISATION);
        assert.ok(r.complete && r.stop === "stable" && r.meta.added_blocks > 0, `asked ${asked}: ${r.stop}, +${r.meta.added_blocks}`);
        assert.equal(r.after.warnings, 0, "complete: no stress warning is left"); assert.equal(r.after.errors, 0);
        assert.ok(r.after.max_utilisation <= STRESS_WARN + 1e-9);
        assert.equal(Buffer.compare(Buffer.from(r.glb), Buffer.from(reference.glb)), 0, `asked ${asked}: the same run as the default`);
    }
    // Below the cap the ask is kept as it is
    const six = await run(warnOnly, { options: { targetUtilisation: 0.6 } });
    assert.equal(six.meta.target_utilisation, 0.6);
    await verify("warn-only at 60 %", warnOnly, six, { target: 0.6 });
    assert.ok(six.after.max_utilisation <= 0.6 + 1e-9);
});

await test("edge cases: a single floating block, a lone block, a ground slab, two towers, a diagonal chain, a heavy slab with no legs (valid and honest, never an invalid file)", async () => {
    const cases = {
        "one floating block": { cells: [[5, 5, 9]], complete: true, added: [9, 16] },
        "one block on the ground": { cells: [[5, 5, 0]], complete: true, added: [2, 6] },
        "ground slab": { cells: box(0, 9, 0, 9, 0, 0), complete: true, added: [0, 0] },
        "tall 1 x 1 tower": { cells: box(5, 5, 5, 5, 0, 9), complete: true, added: [2, 6] },
        "two towers": { cells: uniq([...box(1, 1, 1, 1, 0, 8), ...box(8, 8, 8, 8, 0, 8)]), complete: true, added: [4, 12] },
        "floating top slab": { cells: box(2, 7, 2, 7, 8, 9), complete: true, added: [20, 40] },
        "diagonal chain of corner-touching blocks": { cells: range(10).map((i) => [i, i, i]), complete: null }, // pathological: only checked for validity
        "a 900-block slab floating above the ground": { cells: box(0, 9, 0, 9, 1, 9), complete: null }, // four legs cannot carry it: reported as not complete
    };
    for (const [name, want] of Object.entries(cases)) {
        const r = await timed(`edge: ${name}`, () => run(want.cells));
        await verify(name, want.cells, r);
        if (want.complete !== null) assert.equal(r.complete, want.complete, `${name}: ${r.stop}`);
        if (want.added) between(r.meta.added_blocks, want.added[0], want.added[1], `${name} added`);
        assert.ok(r.after.floating_blocks === 0 || !r.complete);
    }
    const heavy = await run(box(0, 9, 0, 9, 1, 9));
    assert.equal(heavy.complete, false); assert.equal(heavy.after.floating_blocks, 0); assert.ok(heavy.after.max_utilisation > 1);
    // a stable model costs no time even with no time left
    const quick = await run(CONTROLS.chair, { options: { timeBudgetMs: 0 } });
    assert.equal(quick.stop, "stable"); assert.equal(quick.meta.added_blocks, 0);
});

// ============================================================================================================================
console.log("caps, budget, cancel");

await test("a block budget caps what is added: stop = max-blocks, not complete, still a valid GLB; no budget in the way when it is big enough", async () => {
    const n0 = SHAPES.tShape.length;
    const capped = await run(SHAPES.tShape, { options: { maxBlocks: n0 + 3 } });
    await verify("T capped", SHAPES.tShape, capped);
    assert.ok(capped.meta.added_blocks <= 3, `added ${capped.meta.added_blocks}`);
    assert.equal(capped.stop, "max-blocks"); assert.equal(capped.complete, false);
    const none = await run(SHAPES.tShape, { options: { maxBlocks: n0 } });
    assert.equal(none.meta.added_blocks, 0); assert.equal(none.stop, "max-blocks");
    await verify("T, no room", SHAPES.tShape, none);
    const exact = await run(SHAPES.tShape, { options: { maxBlocks: n0 + 8 } });
    assert.ok(exact.complete && exact.meta.added_blocks === 8);
});

await test("stop reasons: running into the 75 % safeguard is not the user's block budget ('max-blocks' is for a budget that was set)", async () => {
    // Four single blocks high in the air: a 9-block column for each is 36 blocks, more than the safeguard allows (24).
    const four = [[1, 1, 9], [8, 1, 9], [1, 8, 9], [8, 8, 9]];
    const free = await run(four);
    await verify("four high blocks", four, free);
    assert.equal(free.meta.added_blocks, 24); assert.equal(free.complete, false);
    assert.notEqual(free.stop, "max-blocks", "no budget was set");
    const roomy = await run(four, { options: { maxBlocks: 30 } }); // 26 more blocks allowed: the safeguard (24) is the tighter limit
    assert.equal(roomy.meta.added_blocks, 24); assert.notEqual(roomy.stop, "max-blocks");
    const tight = await run(four, { options: { maxBlocks: 9 } }); // 5 more: the user's budget is the limit
    assert.equal(tight.stop, "max-blocks"); assert.ok(tight.meta.added_blocks <= 5);
    await verify("four high blocks, budget 9", four, tight);
});

await test("the time budget covers the replay after the clean-up too: out of time there, the moves as made are kept (valid, complete, a few blocks more) instead of solving the rest of the replay", async () => {
    // 11 blocks of a random sculpture: the clean-up takes a block out of the 9 moves the loop makes, so the log is replayed.
    const sculpture = [[2, 1, 0], [6, 4, 0], [3, 8, 0], [6, 9, 0], [2, 8, 1], [7, 5, 3], [8, 5, 3], [8, 7, 3], [6, 7, 4], [7, 5, 5], [8, 7, 5]];
    const reference = await run(sculpture);
    await verify("sculpture", sculpture, reference);
    // A clock that stands still until the J-th solve, which is where it jumps far past any budget: the solves that come after
    // J are the ones the run makes although its time is up. The last solves of a run are the replay's (one per kept move).
    const real = performance.now;
    let now = 0, solves = 0, jumpAt = Infinity;
    const counting = { backend: wasm.backend, solve: (model) => { if (++solves === jumpAt) now = 1e9; return wasm.solve(model); } };
    const attempt = () => { now = 0; solves = 0; return run(sculpture, { solver: counting }); };
    try {
        performance.now = () => now;
        jumpAt = Infinity;
        const full = await attempt();
        const total = solves;
        assert.equal(Buffer.compare(Buffer.from(full.glb), Buffer.from(reference.glb)), 0, "the fake clock changes nothing while it stands still");
        assert.ok(total >= 12, `${total} solves`);
        for (const j of [total - 3, total - 2, total - 1]) {
            jumpAt = j;
            const r = await attempt();
            jumpAt = Infinity;
            assert.equal(solves, j, `time ran out at solve ${j} of ${total}: ${solves} were made (the replay went on)`);
            assert.equal(r.stop, reference.stop, "the search had finished; only the replay ran out of time");
            assert.ok(r.complete && r.meta.added_blocks > reference.meta.added_blocks, `solve ${j}: +${r.meta.added_blocks} blocks, ${reference.meta.added_blocks} with the clean-up`);
            await verify(`sculpture, time up at solve ${j}`, sculpture, r);
        }
    } finally { performance.now = real; }
});

await test("analysis settings maxBlocks is the default budget (the 'too many components' error then stays)", async () => {
    const s = normalizeSettings({ maxBlocks: SHAPES.gallows.length + 2 });
    const r = await stabilize({ cells: SHAPES.gallows, settings: s, options: { targetUtilisation: TARGET, maxSteps: 40, timeBudgetMs: 30000, maxBlocks: s.maxBlocks, stamp: STAMP }, assembly: null }, 0, { solver: wasm });
    assert.ok(r.meta.added_blocks <= 2);
    await verify("gallows, budget from settings", SHAPES.gallows, r, { s });
});

await test("the step cap: maxSteps ends the run after that many moves (stop = max-steps); more than the log can hold is clamped", async () => {
    const r = await run(SHAPES.leaningTower, { options: { maxSteps: 1 } });
    await verify("tower, 1 step", SHAPES.leaningTower, r);
    assert.equal(r.meta.steps.length, 1); assert.equal(r.stop, "max-steps"); assert.equal(r.complete, false);
    const zero = await run(SHAPES.leaningTower, { options: { maxSteps: 0 } });
    assert.equal(zero.meta.added_blocks, 0); assert.equal(zero.stop, "max-steps");
    const huge = await run(SHAPES.leaningTower, { options: { maxSteps: 1000 } });
    assert.ok(huge.meta.steps.length <= MAX_STABILIZE_STEPS);
});

await test("the time budget: the run stops when it is spent and returns what it has (valid, partial), instead of running on", async () => {
    const wide = uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 0, 9, 6, 9)]); // 1 x 1 stem under a 4-thick cap, 406 blocks: the slowest of the set
    const full = await timed("1-stem thick cap (full run)", () => run(wide));
    assert.ok(full.complete);
    const t0 = performance.now();
    const r = await run(wide, { options: { timeBudgetMs: 50 } });
    const ms = performance.now() - t0;
    timings.push(["1-stem thick cap, 50 ms budget", ms]);
    await verify("budgeted", wide, r);
    assert.equal(r.stop, "time-budget"); assert.equal(r.complete, false);
    assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms for a 50 ms budget`);
    assert.ok(wide.length > 400);
    const zero = await run(SHAPES.gallows, { options: { timeBudgetMs: 0 } });
    assert.equal(zero.stop, "time-budget"); assert.equal(zero.meta.added_blocks, 0);
    await verify("zero budget", SHAPES.gallows, zero);
});

await test("cancel: cancelled() ends the run between moves (stop = canceled) with the moves so far, valid and saveable", async () => {
    let seen = 0;
    const r = await run(SHAPES.leaningTower, { onEvent: (e) => { if (e.kind === "step") seen++; }, cancelled: () => seen >= 1 });
    assert.equal(r.stop, "canceled"); assert.equal(r.meta.steps.length, 1); assert.equal(r.complete, false);
    await verify("canceled", SHAPES.leaningTower, r);
});

await test("a 1000-block input is handled inside the budget (one solve of 1000 blocks takes about half a second)", async () => {
    const full = box(0, 9, 0, 9, 0, 9);
    const r = await timed("1000 blocks, nothing to fix", () => run(full));
    assert.equal(r.meta.added_blocks, 0); assert.equal(r.stop, "stable");
    const almost = full.filter((c) => !(c[0] === 5 && c[1] === 5 && c[2] === 4) && !(c[0] === 5 && c[1] === 5 && c[2] === 5)); // a hole inside: still connected sideways
    const r2 = await timed("998 blocks with a hole", () => run(almost));
    assert.equal(r2.meta.added_blocks, 0);
    const slab = box(0, 9, 0, 9, 0, 7).concat([[5, 5, 9]]); // 800 blocks and one with a gap under it
    const r3 = await timed("801 blocks, one floating", () => run(slab));
    await verify("801", slab, r3);
    assert.ok(r3.complete && r3.meta.added_blocks === 1 && r3.after.floating_blocks === 0);
});

// ============================================================================================================================
console.log("events, worker, runStabilize");

await test("events: every accepted move is reported as it happens (log entry, its cells and roles, running block count); progress is throttled", async () => {
    const steps = [], progress = [];
    const r = await run(SHAPES.leaningTower, { onEvent: (e) => (e.kind === "step" ? steps.push(e) : progress.push(e)) });
    assert.equal(steps.length, r.meta.steps.length, "no clean-up on this shape, so the streamed log is the final one");
    steps.forEach((e, q) => {
        assert.equal(e.step.n, q + 1);
        assert.equal(e.cells.length, e.step.added); assert.equal(e.roles.length, e.step.added);
        assert.deepEqual(e.step, r.meta.steps[q]);
        assert.equal(e.blocks, r.meta.before.blocks + steps.slice(0, q + 1).reduce((n, x) => n + x.step.added, 0));
        for (const c of e.cells) assert.ok(c.every((v) => Number.isInteger(v) && v >= 0 && v < 10));
        assert.ok(e.elapsedMs >= 0);
    });
    for (const e of progress) { assert.equal(e.phase, "evaluating"); assert.ok(e.candidatesDone <= e.candidatesTotal || e.candidatesTotal === 0); }
    assert.ok(progress.length <= 1 + Math.ceil((steps.at(-1).elapsedMs + 50) / 100), "at most ten a second");
    // the streamed cells and roles are the descriptor's
    for (const e of steps) e.cells.forEach((c, q) => {
        const n = cellsOfDescriptor(r.descriptor).findIndex((d) => key(d) === key(c));
        assert.equal(BLOCK_ROLES[r.descriptor.cells[n * CELL_STRIDE + 3]], e.roles[q]); assert.equal(r.descriptor.cells[n * CELL_STRIDE + 4], e.step.n);
    });
});

await test("the clean-up is replayed: when it takes blocks out, the final log still describes the blocks that are left (no step without blocks, numbers contiguous)", async () => {
    let cleaned = 0;
    for (const [name, cells] of Object.entries({ ...SHAPES, ...EXTRA, thick: uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 0, 9, 6, 9)]) })) {
        const steps = [];
        const r = await run(cells, { onEvent: (e) => e.kind === "step" && steps.push(e) });
        await verify(name, cells, r);
        if (steps.length !== r.meta.steps.length || steps.some((e, q) => e.step.added !== r.meta.steps[q]?.added)) cleaned++;
    }
    console.log(`       (${cleaned} of ${Object.keys({ ...SHAPES, ...EXTRA }).length + 1} shapes were cleaned up after the loop)`);
});

await test("a move that changes none of the figures it quotes is folded into the one that does (clean-up leftovers, moves that only improve the search's score)", async () => {
    // Two sculptures from the random set; before the fold their logs had a row each like "COG margin -126 -> -126 mm".
    const sculptures = {
        "tipping: a footing that did not move the margin": [[8, 5, 0], [4, 8, 0], [6, 9, 0], [2, 5, 4], [1, 6, 4], [0, 8, 4], [0, 9, 4], [0, 5, 5], [0, 6, 5], [2, 7, 5], [2, 9, 5], [0, 5, 6], [1, 5, 6], [2, 6, 6], [1, 8, 6], [1, 9, 6], [2, 9, 6], [0, 6, 7], [0, 8, 7], [1, 8, 7], [1, 9, 7], [2, 9, 7], [0, 9, 8], [2, 9, 8]],
        "close to the edge: a footing that did not move the margin": [[4, 5, 0], [7, 8, 0], [7, 9, 0], [1, 6, 2], [1, 7, 2], [0, 8, 2], [0, 6, 3], [1, 6, 3], [0, 8, 3], [1, 8, 3], [0, 6, 4], [1, 6, 4], [1, 7, 4], [0, 8, 4], [1, 8, 4]],
    };
    for (const [name, cells] of Object.entries(sculptures)) {
        const streamed = [];
        const r = await run(cells, { onEvent: (e) => e.kind === "step" && streamed.push(e.step) });
        await verify(name, cells, r); // verify() fails on a row whose figures are all unchanged
        assert.ok(r.meta.steps.length < streamed.length, `${name}: ${streamed.length} moves made, ${r.meta.steps.length} in the log`);
    }
    // The folded move keeps the place and the reason of the move that did something, and the figures run on from row to row.
    const [name, cells] = Object.entries(sculptures)[1];
    const r = await run(cells);
    r.meta.steps.forEach((step, q) => { if (q > 0) assert.deepEqual(step.before, r.meta.steps[q - 1].after, `${name}: row ${step.n}`); });
});

await test("the worker: a stabilize request gets event messages, then done with the GLB transferred; a bad request gets error", async () => {
    const posted = [];
    globalThis.self = { postMessage: (message, transfer) => posted.push({ message, transfer }) };
    await import("../../src/assignment/analysis/stabilize/stabilize.worker.ts");
    const input = { cells: SHAPES.gallows, settings, options: { ...baseOptions } };
    await globalThis.self.onmessage({ data: { kind: "stabilize", id: 7, input, sourceDepth: 0, wasmUrl: wasmPath } });
    const events = posted.filter((p) => p.message.kind === "event");
    const done = posted.filter((p) => p.message.kind === "done");
    assert.ok(events.length > 0 && events.every((p) => p.message.id === 7));
    assert.equal(done.length, 1);
    const result = done[0].message.result;
    assert.equal(done[0].message.id, 7);
    assert.ok(done[0].transfer.length === 1 && done[0].transfer[0] === result.glb.buffer, "the GLB's buffer is transferred");
    assert.equal(result.meta.solver, "awatif-wasm");
    await verify("worker result", SHAPES.gallows, result);
    posted.length = 0;
    await globalThis.self.onmessage({ data: { kind: "stabilize", id: 8, input: { ...input, cells: [] }, sourceDepth: 0 } });
    assert.equal(posted.length, 1); assert.equal(posted[0].message.kind, "error"); assert.match(posted[0].message.message, /no blocks/);
    posted.length = 0;
    await globalThis.self.onmessage({ data: { kind: "other", id: 9 } });
    assert.equal(posted.length, 0);
    await globalThis.self.onmessage({ data: { kind: "stabilize", id: 10, input, sourceDepth: 0 } }); // no WASM URL: the TypeScript solver
    assert.equal(posted.at(-1).message.kind, "done"); assert.equal(posted.at(-1).message.result.meta.solver, "awatif-ts");
    const log = console.error; console.error = () => {}; // emscripten reports the file it could not read
    try {
        await globalThis.self.onmessage({ data: { kind: "stabilize", id: 11, input, sourceDepth: 0, wasmUrl: "/nonexistent/lSolver.wasm" } }); // a URL that does not load: the same fallback
    } finally { console.error = log; }
    assert.equal(posted.at(-1).message.kind, "done"); assert.equal(posted.at(-1).message.result.meta.solver, "awatif-ts");
    delete globalThis.self;
});

await test("a real thread (worker_threads standing in for the browser's Worker): requests and results survive structured clone, the GLB moves by transfer, terminate() stops a long run at once", async () => {
    const { Worker: Thread } = await import("node:worker_threads");
    const url = new URL("../../src/assignment/analysis/stabilize/stabilize.worker.ts", import.meta.url).href;
    // The module talks to `self` the way a browser worker does; give the thread that scope.
    const shim = `const { parentPort } = require("node:worker_threads");
        globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), set onmessage(fn) { parentPort.on("message", (data) => fn({ data })); } };
        import(${JSON.stringify(url)}).then(() => parentPort.postMessage({ ready: true }));`;
    const start = async () => { const t = new Thread(shim, { eval: true }); await new Promise((res, rej) => { t.once("message", res); t.once("error", rej); }); return t; };
    const wait = (t, kind) => new Promise((res, rej) => { t.on("message", function on(m) { if (m.kind === kind) { t.off("message", on); res(m); } }); t.once("error", rej); });

    const t1 = await start();
    const input = { cells: SHAPES.gallows, settings, options: { ...baseOptions } };
    const events = []; t1.on("message", (m) => m.kind === "event" && events.push(m));
    t1.postMessage({ kind: "stabilize", id: 1, input, sourceDepth: 0, wasmUrl: wasmPath });
    const done = await wait(t1, "done");
    await verify("thread result", SHAPES.gallows, done.result);
    assert.ok(done.result.glb instanceof Uint8Array && events.length > 0 && events.every((m) => m.id === 1 && m.event.kind));
    assert.equal(done.result.meta.assembly_hash, (await run(SHAPES.gallows)).meta.assembly_hash);
    await t1.terminate();

    // a long run (about two seconds), stopped after its first event: the thread is gone within a few milliseconds
    const wide = uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 0, 9, 6, 9)]);
    const t2 = await start();
    t2.postMessage({ kind: "stabilize", id: 2, input: { ...input, cells: wide }, sourceDepth: 0, wasmUrl: wasmPath });
    await wait(t2, "event");
    const t0 = performance.now(); await t2.terminate(); const ms = performance.now() - t0;
    timings.push(["terminate() of a running worker thread", ms]);
    assert.ok(ms < 500, `terminate took ${ms.toFixed(0)} ms`);
});

await test("runStabilize without a Worker (Node): same result as the direct call, events in both forms, depth passed through", async () => {
    assert.equal(typeof Worker, "undefined");
    const onStep = [], onProgress = [], onEvent = [];
    const r = await runStabilize({ cells: SHAPES.gallows, settings, options: { ...baseOptions } }, { sourceDepth: 0, wasmUrl: wasmPath, onStep: (e) => onStep.push(e), onProgress: (e) => onProgress.push(e), onEvent: (e) => onEvent.push(e) });
    const direct = await run(SHAPES.gallows);
    assert.equal(r.meta.assembly_hash, direct.meta.assembly_hash);
    assert.equal(Buffer.compare(Buffer.from(r.glb), Buffer.from(direct.glb)), 0);
    assert.equal(onStep.length, r.meta.steps.length); assert.equal(onEvent.length, onStep.length + onProgress.length);
    assert.ok(onStep.every((e) => e.kind === "step") && onProgress.every((e) => e.kind === "progress"));
    const d2 = await runStabilize({ cells: SHAPES.gallows, settings, options: { ...baseOptions } }, { sourceDepth: 1, wasmUrl: null });
    assert.equal(d2.meta.depth, 2); assert.equal(d2.meta.solver, "awatif-ts");
    await assert.rejects(runStabilize({ cells: [], settings, options: baseOptions }), /no blocks/);
});

await test("runStabilize: a signal aborted before the start rejects at once; one aborted during the run stops it within a moment (AbortError)", async () => {
    const pre = new AbortController(); pre.abort();
    await assert.rejects(runStabilize({ cells: SHAPES.gallows, settings, options: baseOptions }, { signal: pre.signal }), (e) => e.name === "AbortError");
    const wide = uniq([...box(4, 4, 4, 4, 0, 5), ...box(0, 9, 0, 9, 6, 9)]);
    const c = new AbortController();
    let abortedAt = 0;
    const p = runStabilize({ cells: wide, settings, options: { ...baseOptions } }, { signal: c.signal, wasmUrl: wasmPath, onProgress: () => { if (!abortedAt) { abortedAt = performance.now(); c.abort(); } }, onStep: () => { if (!abortedAt) { abortedAt = performance.now(); c.abort(); } } });
    await assert.rejects(p, (e) => e.name === "AbortError");
    const latency = performance.now() - abortedAt;
    timings.push(["abort latency (main thread, 400+ blocks)", latency]);
    assert.ok(abortedAt > 0 && latency < 1000, `stopped ${latency.toFixed(0)} ms after the abort`);
});

// ============================================================================================================================
console.log("random assemblies");

await test(`random swiss-cheese assemblies (FUZZ=${process.env.FUZZ ?? 40}): given blocks kept, results valid and honest, deterministic, most are fixed`, async () => {
    let seed = 777;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const trials = Number(process.env.FUZZ ?? 40);
    let complete = 0, sumMs = 0, maxMs = 0, sumAddedFraction = 0;
    for (let t = 0; t < trials; t++) {
        const occ = new Set();
        const density = 0.15 + rnd() * 0.6;
        for (let q = 1 + Math.floor(rnd() * 4); q > 0; q--) {
            const cx = Math.floor(rnd() * 10), cy = Math.floor(rnd() * 10), cz = Math.floor(rnd() * 8), r = 1 + Math.floor(rnd() * 4);
            for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++)
                if (Math.abs(i - cx) <= r && Math.abs(j - cy) <= r && Math.abs(k - cz) <= r && rnd() < density) occ.add((k * 10 + j) * 10 + i);
        }
        for (let q = 0; q < 3; q++) occ.add(Math.floor(rnd() * 10) + 10 * Math.floor(rnd() * 10)); // something stands on the ground
        const cells = [...occ].sort((a, b) => a - b).map((c) => [c % 10, Math.floor(c / 10) % 10, Math.floor(c / 100)]);
        const t0 = performance.now();
        const r = await run(cells);
        const ms = performance.now() - t0; sumMs += ms; maxMs = Math.max(maxMs, ms);
        await verify(`random ${t}`, cells, r);
        if (r.complete) complete++;
        sumAddedFraction += r.meta.added_blocks / cells.length;
        if (t % 4 === 0) { const again = await run(cells); assert.equal(Buffer.compare(Buffer.from(r.glb), Buffer.from(again.glb)), 0, `random ${t} is not deterministic`); }
    }
    timings.push([`random assemblies: mean of ${trials}`, sumMs / trials], [`random assemblies: slowest of ${trials}`, maxMs]);
    console.log(`       ${complete}/${trials} fixed completely, +${(sumAddedFraction / trials * 100).toFixed(0)}% blocks on average`);
    assert.ok(complete >= Math.floor(trials * 0.85), `only ${complete}/${trials} were fixed`);
});

// ============================================================================================================================
console.log("\ntimings (Node, Awatif WASM):");
for (const [name, ms] of timings) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${name}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
