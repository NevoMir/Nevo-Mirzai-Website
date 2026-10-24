// Tests for analysis/assembly.ts (a block assembly analysed without voxelising) and analysis/stress.ts (the joint-stress
// estimate), against closed-form beam theory and against the structural analysis.
//   node scripts/assignment/test-stress-assembly.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const A = (n) => import(`../../src/assignment/${n}.ts`);
const { descriptorFromBlocks } = await A("shared/assembly");
const { writeAssemblyGlb, readAssemblyGlb } = await A("shared/assemblyGlb");
const asm = await A("analysis/assembly");
const st = await A("analysis/stress");
const { analyze } = await A("analysis/analyze");
const { normalizeSettings } = await A("analysis/settings");
const fem = await A("analysis/fem/index");
const ws = await A("analysis/withStress");
const mat = await A("analysis/materials");
const { AWATIF_WASM_URL } = await A("analysis/fem/wasmUrl");
const { buildReport, buildBlocksCsv } = await A("analysis/report");
const { NodeIO } = await import("@gltf-transform/core");

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); } }

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
const box = (x0, x1, y0, y1, z0, z1) => range(x1 - x0, x0).flatMap((i) => range(y1 - y0, y0).flatMap((j) => range(z1 - z0, z0).map((k) => [i, j, k])));
const uniq = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];
const SHAPES = {
    shelfArm: uniq([...box(0, 3, 0, 3, 0, 1), ...box(1, 2, 1, 2, 1, 6), ...box(2, 9, 1, 2, 5, 6)]),
    mushroom: uniq([...box(4, 6, 4, 6, 0, 6), ...box(0, 10, 0, 10, 6, 9)]),
    table: uniq([...box(0, 1, 0, 1, 0, 5), ...box(9, 10, 0, 1, 0, 5), ...box(0, 1, 9, 10, 0, 5), ...box(9, 10, 9, 10, 0, 5), ...box(0, 10, 0, 10, 5, 7)]),
    bridge: uniq([...box(0, 2, 0, 3, 0, 4), ...box(8, 10, 0, 3, 0, 4), ...box(0, 10, 0, 3, 4, 5)]),
    armOnColumn: uniq([...box(0, 1, 0, 1, 0, 6), ...[1, 2, 3, 4, 5, 6].map((i) => [i, 0, 5])]),
    floatingHead: uniq([...box(0, 3, 0, 3, 0, 1), ...box(1, 2, 1, 2, 1, 4), ...box(1, 2, 1, 2, 6, 8)]), // a gap at k = 4..5: the head floats
};
// An arm of `n` blocks along +x off the top of a 5-block column that stands on a 6 x 3 base (so the centre of gravity stays
// inside it and only the arm is in question); `cap` adds one block on top of the arm at that index.
const arm = (n, cap = null) => uniq([...box(0, 6, 0, 3, 0, 1), ...box(0, 1, 1, 2, 1, 6), ...range(n, 1).map((i) => [i, 1, 5]), ...(cap === null ? [] : [[cap, 1, 6]])]);
const settings = normalizeSettings({});
const analyse = (cells, s = settings) => asm.analyzeAssembly(descriptorFromBlocks(cells.map((cell) => ({ cell }))), null, s);
const wasmPath = resolve(ROOT, "src/assignment/analysis/fem/vendor/lSolver.wasm");
const wasm = await st.loadSolver(wasmPath);
const tsSolver = { solve: fem.solveFrameTs, backend: "ts" };

await test("the WASM solver loads in Node (else every other result here is the TypeScript fallback)", () => assert.equal(wasm.backend, "wasm"));

await test("assembly analysis = the cells exactly (blocks, statuses, reach, issues) for every shape", () => {
    for (const [name, cells] of Object.entries(SHAPES)) {
        const r = analyse(cells);
        assert.equal(r.blocks.length, cells.length, name);
        const want = new Set(cells.map((c) => c.join()));
        assert.ok(r.blocks.every((b) => want.has(b.cell.join())), name);
        assert.ok(r.blocks.every((b) => b.fill === 1 && b.role === "original" && b.step === 0), name);
        assert.equal(r.assembly.roleCounts[0], cells.length);
    }
});

await test("why the descriptor exists: voxelising the exported GLB's triangles gives other blocks", async () => {
    const cells = SHAPES.shelfArm;
    const glb = writeAssemblyGlb(descriptorFromBlocks(cells.map((cell) => ({ cell }))));
    const dir = mkdtempSync(join(tmpdir(), "asm-"));
    writeFileSync(join(dir, "a.glb"), glb);
    const doc = await new NodeIO().read(join(dir, "a.glb"));
    const floats = [];
    for (const scene of doc.getRoot().listScenes()) scene.traverse((node) => {
        const mesh = node.getMesh(); if (!mesh) return;
        for (const prim of mesh.listPrimitives()) {
            const pos = prim.getAttribute("POSITION").getArray(); const idx = prim.getIndices().getArray();
            for (const i of idx) floats.push(pos[i * 3], -pos[i * 3 + 2], pos[i * 3 + 1]); // glTF Y-up -> Z-up, as the viewer does
        }
    });
    const soup = new Float32Array(floats);
    const plain = analyze({ positions: soup });
    assert.notEqual(plain.blocks.length, cells.length, `voxelising gave ${plain.blocks.length} blocks for ${cells.length}`);
    const exact = asm.analyzeAssembly(readAssemblyGlb(glb, null).descriptor, asm.boundsOf(soup), settings);
    assert.equal(exact.blocks.length, cells.length);
    // The transform maps the GLB's frame onto the lattice: the first vertex of the first block lands inside its cell.
    const t = exact.transform; const p = [soup[0], soup[1], soup[2]];
    const mm = p.map((v, a) => (v - t.modelMin[a]) * t.factor + t.offsetMm[a]);
    assert.ok(mm.every((v) => v >= 0 && v <= 1000));
});

await test("original-only subset: the stabilized model's source blocks analyse on their own", () => {
    const base = SHAPES.shelfArm;
    const blocks = [...base.map((cell) => ({ cell })), { cell: [8, 1, 4], role: "column", step: 1 }, { cell: [8, 1, 3], role: "column", step: 1 }, { cell: [8, 1, 2], role: "column", step: 1 }, { cell: [8, 1, 1], role: "column", step: 1 }, { cell: [8, 1, 0], role: "column", step: 1 }];
    const desc = descriptorFromBlocks(blocks);
    const full = asm.analyzeAssembly(desc, null, settings);
    const orig = asm.analyzeAssembly(asm.originalOf(desc), null, settings);
    assert.equal(orig.blocks.length, base.length);
    assert.equal(full.stats.overLimitCount, 0);
    assert.ok(orig.stats.overLimitCount > 0, "the original still has its long arm");
    assert.deepEqual(full.assembly.roleCounts, [base.length, 5, 0, 0, 0, 0]);
    // Inside the stabilized model's frame the subset keeps the whole's transform (so the stage does not jump between views).
    const soup = { min: [0.01, -0.99, 0.005], max: [0.89, -0.01, 0.595] };
    const whole = asm.analyzeAssembly(desc, soup, settings);
    const part = asm.analyzeAssembly(asm.originalOf(desc), soup, settings, desc);
    assert.deepEqual(part.transform, whole.transform);
    assert.equal(part.blocks.length, base.length);
    assert.equal(asm.originalOf(descriptorFromBlocks([{ cell: [0, 0, 0], role: "column", step: 1 }])), null);
});

await test("closed form: a 6-block arm on a 5-block column, timber: arm-root tension = 126 rho g a (61.78 kPa), both backends", () => {
    const r = analyse(SHAPES.armOnColumn, normalizeSettings({ material: "timber" }));
    const expected = 126 * 500 * 9.80665 * 0.1; // Pa
    for (const solver of [wasm, tsSolver]) {
        const s = st.computeStress(r, solver, "timber");
        const p = s.points[0];
        assert.ok(Math.abs(p.tensionKPa * 1000 - expected) / expected < 2e-3, `${solver.backend}: ${p.tensionKPa} kPa`);
        assert.equal(p.mode, "tension");
        assert.deepEqual(p.joint, [[0, 0, 5], [1, 0, 5]]);
        assert.ok(Math.abs(s.maxUtilisation - expected / 0.4e6) < 1e-3);
    }
});

await test("WASM and TypeScript solvers agree to 1e-6 on every shape and material", () => {
    for (const [name, cells] of Object.entries(SHAPES)) for (const material of ["concrete", "timber"]) {
        const r = analyse(cells, normalizeSettings({ material }));
        const a = st.computeStress(r, wasm, material), b = st.computeStress(r, tsSolver, material);
        assert.equal(a.analysedBlocks, b.analysedBlocks, name);
        for (let q = 0; q < a.byBlock.length; q++) {
            if (Number.isNaN(a.byBlock[q])) { assert.ok(Number.isNaN(b.byBlock[q])); continue; }
            assert.ok(Math.abs(a.byBlock[q] - b.byBlock[q]) < 1e-6, `${name} ${material} block ${q}: ${a.byBlock[q]} vs ${b.byBlock[q]}`);
        }
    }
});

await test("thresholds with the default material (concrete): the stress check agrees with the cantilever rule", () => {
    const run = (cells, material) => { const r = analyse(cells, normalizeSettings({ material })); return st.applyStress(r, st.computeStress(r, wasm)); };
    assert.equal(mat.STRESS_WARN, 0.75); assert.equal(mat.STRESS_FAIL, 1);
    // Closed form for an n-block arm off a column: the root joint carries 3 n (n + 1) rho g a of tension.
    const expected = (n, rho = 2400, ft = 0.2e6) => 3 * n * (n + 1) * rho * 9.80665 * 0.1 / ft;
    const four = run(arm(4)), five = run(arm(5)), seven = run(SHAPES.shelfArm);
    assert.ok(Math.abs(four.stress.maxUtilisation - expected(4)) < 0.005, `4-block arm ${four.stress.maxUtilisation}`);
    assert.ok(Math.abs(five.stress.maxUtilisation - expected(5)) < 0.005, `5-block arm ${five.stress.maxUtilisation}`);
    // The allowed 4-block cantilever passes (~71 %, under the 75 % warning); the 5-block one fails both ways (~106 %).
    assert.ok(four.stress.maxUtilisation > 0.7 && four.stress.maxUtilisation < mat.STRESS_WARN, String(four.stress.maxUtilisation));
    assert.equal(four.stats.overLimitCount, 0); assert.equal(four.issues.length, 0); assert.equal(four.checks.at(-1).status, "pass");
    assert.ok(five.stress.maxUtilisation > mat.STRESS_FAIL && five.stress.maxUtilisation < 1.1, String(five.stress.maxUtilisation));
    assert.ok(five.stats.overLimitCount > 0);
    assert.equal(five.issues.filter((i) => i.kind === "overstressed").length, 1); assert.equal(five.checks.at(-1).status, "fail");
    // The 7-block arm of the shelf shape: 198 %.
    assert.ok(Math.abs(seven.stress.maxUtilisation - 1.98) < 0.02);
    assert.equal(seven.issues.filter((i) => i.kind === "overstressed").length, 1, "one region, one issue");
    assert.equal(seven.checks.at(-1).key, "stress"); assert.equal(seven.checks.at(-1).status, "fail");
    assert.equal(seven.summary.errors, seven.issues.filter((i) => i.severity === "error").length);
    assert.equal(seven.summary.stress.overstressed_blocks, seven.stress.overstressedBlocks);
    assert.ok(seven.issues.findIndex((i) => i.severity === "warning") === -1 || seven.issues.findIndex((i) => i.severity === "warning") > seven.issues.findLastIndex((i) => i.severity === "error"), "errors first");
    // Between 75 % and 100 %: a warning only (a 4-block arm with one more block on its third).
    const capped = run(arm(4, 3));
    assert.ok(capped.stress.maxUtilisation > mat.STRESS_WARN && capped.stress.maxUtilisation < 1, String(capped.stress.maxUtilisation));
    assert.ok(capped.issues.some((i) => i.kind === "highly-stressed" && i.severity === "warning") && !capped.issues.some((i) => i.kind === "overstressed"));
    assert.equal(capped.summary.errors, 0); assert.equal(capped.summary.warnings, 1); assert.equal(capped.checks.at(-1).status, "pass");
    // The slabs that used to sit just over a 60 % line (73 % and 74 %) are now under the 75 % one: they pass without a warning.
    for (const name of ["mushroom", "table"]) {
        const r = run(SHAPES[name]);
        assert.ok(r.stress.maxUtilisation > 0.7 && r.stress.maxUtilisation < mat.STRESS_WARN, `${name} ${r.stress.maxUtilisation}`);
        assert.equal(r.issues.length, 0, name); assert.equal(r.checks.at(-1).status, "pass");
    }
    const bridge = run(SHAPES.bridge);
    assert.ok(bridge.stress.maxUtilisation < 0.5 && bridge.issues.length === 0);
    // Timber: the same 7-block arm is at 21 % (its joints take 0.4 MPa and the blocks weigh a fifth).
    assert.ok(Math.abs(run(SHAPES.shelfArm, "timber").stress.maxUtilisation - 0.21) < 0.01);
});

await test("stress numbers: a 6-block arm off a 5-block column carries 126 rho g a at its root, in timber (61.78 kPa) and in concrete (296.6 kPa)", () => {
    for (const [material, rho] of [["timber", 500], ["concrete", 2400]]) {
        const r = analyse(SHAPES.armOnColumn, normalizeSettings({ material }));
        const s = st.computeStress(r, wasm, material);
        const kPa = 126 * rho * 9.80665 * 0.1 / 1000;
        assert.ok(Math.abs(s.points[0].tensionKPa - kPa) / kPa < 2e-3, `${material}: ${s.points[0].tensionKPa} vs ${kPa}`);
    }
    assert.ok(Math.abs(126 * 500 * 9.80665 * 0.1 / 1000 - 61.78) < 0.01);
});

await test("applyStress twice does not stack issues; a floating head has NaN stress and is counted as unsupported", () => {
    const r = analyse(SHAPES.shelfArm);
    const once = st.applyStress(r, st.computeStress(r, wasm));
    const twice = st.applyStress(once, st.computeStress(once, wasm));
    assert.equal(twice.issues.length, once.issues.length);
    assert.equal(twice.checks.filter((c) => c.key === "stress").length, 1);
    const f = analyse(SHAPES.floatingHead);
    assert.ok(f.stats.floatingCount > 0);
    const s = st.computeStress(f, wasm);
    assert.equal(s.unsupportedBlocks, f.stats.floatingCount);
    assert.equal([...s.byBlock].filter(Number.isNaN).length, f.stats.floatingCount);
    const applied = st.applyStress(f, s);
    assert.match(applied.checks.at(-1).value, /floating, no load path/);
});

await test("nothing on the ground: stress is null and the row says so", () => {
    const r = analyse([[3, 3, 3], [3, 3, 4]]);
    assert.equal(st.computeStress(r, wasm), null);
    const applied = st.applyStress(r, null);
    assert.equal(applied.checks.at(-1).status, "info");
    assert.equal(applied.stress, null);
});

await test("1000 blocks: solved in under 1.5 s (WASM) and the field is finite", () => {
    const full = []; for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) full.push([i, j, k]);
    const r = analyse(full);
    const t0 = performance.now(); const s = st.computeStress(r, wasm); const ms = performance.now() - t0;
    console.log(`       1000-block cube: ${ms.toFixed(0)} ms (solver reports ${s.solver.ms.toFixed(0)} ms), peak ${(s.maxUtilisation * 100).toFixed(0)} %`);
    assert.ok(ms < 1500);
    assert.ok([...s.byBlock].every(Number.isFinite));
});

await test("the summary with a stress block passes the server's validation (and survives the 50x cap)", async () => {
    const { checkAnalysisSummary } = await import("../../worker/analysis.ts");
    const r = analyse(SHAPES.shelfArm);
    const out = st.applyStress(r, st.computeStress(r, wasm));
    const checked = checkAnalysisSummary(out.summary, Date.now());
    assert.equal(checked.ok, true, checked.error);
    assert.deepEqual(checked.value.stress, out.summary.stress);
    assert.equal(checked.value.stress.material, "concrete");
    assert.ok(checked.value.stress.max_utilisation > 1.9 && checked.value.stress.max_utilisation <= 50);
    const failed = await ws.withStress(r, { solver: { solve: () => { throw new Error("x"); }, backend: "ts" } });
    const ok = checkAnalysisSummary(failed.summary, Date.now());
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.value.stress ?? null, null);
});

await test("the bundled wasm URL (fem/wasmUrl.ts) is a file: URL in Node and the solver loads from it", async () => {
    assert.match(AWATIF_WASM_URL, /^file:\/\/.*\/fem\/vendor\/lSolver\.wasm$/);
    const handle = await st.loadSolver(AWATIF_WASM_URL);
    assert.equal(handle.backend, "wasm");
    const warn = console.warn, error = console.error; // the loader reports the missing file; that is the point of the test
    console.warn = console.error = () => {};
    const missing = await st.loadSolver(`${AWATIF_WASM_URL}.missing`).finally(() => { console.warn = warn; console.error = error; });
    assert.equal(missing.backend, "ts", "a wasm that cannot be loaded falls back to the TypeScript solver");
    const r = analyse(SHAPES.shelfArm);
    assert.ok(Math.abs(st.computeStress(r, handle).maxUtilisation - st.computeStress(r, missing).maxUtilisation) < 1e-6);
});

await test("withStress: the shared solver is Awatif's wasm; the result equals applyStress(computeStress(...))", async () => {
    ws.resetSharedSolver();
    const r = analyse(SHAPES.shelfArm);
    const viaHelper = await ws.withStress(r);
    assert.equal(viaHelper.stress.solver.backend, "wasm");
    assert.equal(await ws.sharedSolver(), await ws.sharedSolver(), "one solver promise per thread");
    const direct = st.applyStress(r, st.computeStress(r, wasm));
    assert.deepEqual(viaHelper.issues, direct.issues);
    assert.deepEqual(viaHelper.checks, direct.checks);
    assert.deepEqual(viaHelper.summary.stress, direct.summary.stress);
    assert.equal(viaHelper.summary.errors, direct.summary.errors);
    assert.ok(r.stress === null && r.checks.every((c) => c.key !== "stress"), "the structural result it was given is not changed");
});

await test("withStress never throws: a solver that fails everywhere leaves the structural result with an info row", async () => {
    const r = analyse(SHAPES.shelfArm);
    const broken = { solve: () => { throw new Error("singular"); }, backend: "ts" };
    const out = await ws.withStress(r, { solver: broken });
    assert.equal(out.stress, null);
    const row = out.checks.at(-1);
    assert.deepEqual([row.key, row.value, row.status], ["stress", st.STRESS_UNAVAILABLE, "info"]);
    assert.equal(st.STRESS_UNAVAILABLE, "Stress could not be estimated");
    assert.equal(out.summary.stress, null);
    assert.equal(out.summary.errors, r.summary.errors, "the structural verdict stands");
    assert.deepEqual(out.issues, r.issues);
    assert.equal(out.checks.length, r.checks.length + 1);
    // A wasm module that dies mid-run: that run finishes on the TypeScript solver and later runs start there.
    ws.resetSharedSolver();
    const dying = { solve: () => { throw new Error("Aborted(OOM)"); }, backend: "wasm" };
    const finished = st.computeStress(r, dying);
    assert.equal(finished.solver.backend, "ts");
    assert.ok(Math.abs(finished.maxUtilisation - st.computeStress(r, wasm).maxUtilisation) < 1e-6);
});

await test("analyzeAssemblyWithStress = analyzeAssembly + stress, inside the frame of the whole for a part", async () => {
    const base = SHAPES.shelfArm;
    const blocks = [...base.map((cell) => ({ cell })), ...[4, 3, 2, 1, 0].map((k) => ({ cell: [8, 1, k], role: "column", step: 1 }))];
    const desc = descriptorFromBlocks(blocks);
    const soup = { min: [0.01, -0.99, 0.005], max: [0.89, -0.01, 0.595] };
    const whole = await ws.analyzeAssemblyWithStress(desc, soup, {});
    assert.equal(whole.assembly.roleCounts[1], 5);
    assert.ok(whole.stress && whole.stress.maxUtilisation < 0.75, "the column holds the arm up");
    const original = await ws.analyzeAssemblyWithStress(asm.originalOf(desc), soup, {}, desc);
    assert.deepEqual(original.transform, whole.transform);
    assert.ok(original.stress.maxUtilisation > 1.9, "the original blocks on their own are overstressed");
    assert.ok(original.issues.some((i) => i.kind === "overstressed"));
    assert.ok(!whole.issues.some((i) => i.kind === "overstressed"));
});

await test("an assembly has its own scale: a block size or target volume in the settings does not break its analysis", () => {
    const desc = descriptorFromBlocks(SHAPES.shelfArm.map((cell) => ({ cell })));
    const r = asm.analyzeAssembly(desc, null, { blockSizeMm: 50, targetSizeMm: 500 });
    assert.equal(r.settings.blockSizeMm, 100); assert.equal(r.settings.targetSizeMm, 1000);
    assert.equal(r.blocks.length, SHAPES.shelfArm.length);
    assert.deepEqual(asm.settingsForAssembly(normalizeSettings({ cantileverLimit: 2, material: "timber" }), desc), { ...normalizeSettings({ cantileverLimit: 2, material: "timber" }), blockSizeMm: 100, targetSizeMm: 1000 });
});

await test("stress points do not wrap around the grid: two overstressed arms on opposite faces stay two points", () => {
    // A 5-block arm off a column is overstressed (106 % in concrete). Column at x = 0, y = 0 and one at x = 0, y = 9 one layer
    // lower: with a fixed 10-cell row key, (9, j, k) was "next to" (0, j + 1, k) and (i, 0, k) next to (i, 9, k - 1).
    const armAt = (x, y, h, n) => [...range(h).map((k) => [x, y, k]), ...range(n, x + 1).map((i) => [i, y, h - 1])];
    const near = armAt(0, 0, 7, 5), far = armAt(0, 9, 6, 5);
    const worst = (r) => r.stress.points.filter((p) => p.utilisation > mat.STRESS_FAIL);
    const one = worst(st.applyStress(analyse(near), st.computeStress(analyse(near), wasm)));
    assert.equal(one.length, 1);
    const both = analyse([...near, ...far]);
    const out = st.applyStress(both, st.computeStress(both, wasm));
    const points = worst(out);
    assert.equal(points.length, 2, `${points.length} overstressed points`);
    assert.ok(points.every((p) => p.blocks.length < 10), "each point is its own arm");
    // No point mixes blocks of the two columns (their cells are 9 apart in y).
    for (const p of out.stress.points) {
        const ys = p.blocks.map((b) => out.blocks[b].cell[1]);
        assert.ok(Math.max(...ys) - Math.min(...ys) <= 1, `point ${p.rank} spans y ${Math.min(...ys)}..${Math.max(...ys)}`);
    }
    const issues = out.issues.filter((i) => i.kind === "overstressed");
    assert.equal(issues.length, 2);
    assert.equal(out.summary.errors, analyse([...near, ...far]).summary.errors + 2, "each arm adds its own error");
});

await test("a block assembly over its budget: the advice is to remove blocks or raise the budget, not to raise a fill threshold that changes nothing", () => {
    const cells = SHAPES.shelfArm;
    const over = analyse(cells, normalizeSettings({ maxBlocks: cells.length - 5 }));
    const issue = over.issues.find((i) => i.kind === "too-many-blocks");
    assert.ok(issue, "the budget error is there");
    assert.match(issue.detail, new RegExp(`budget is ${cells.length - 5}: 5 blocks over`));
    assert.match(issue.detail, /Remove blocks or raise the budget\./);
    assert.doesNotMatch(issue.detail, /fill threshold/);
    // Whatever the threshold, every block of an assembly is whole: the count does not move.
    assert.equal(analyse(cells, normalizeSettings({ maxBlocks: cells.length - 5, fillThreshold: 1 })).blocks.length, cells.length);
});

await test("loadSolverWithin: a stalled load gives the TypeScript solver after the timeout; the WASM solver is handed over if it arrives late", async () => {
    const t0 = performance.now();
    const stalled = await st.loadSolverWithin(() => new Promise(() => {}), 40);
    assert.equal(stalled.backend, "ts");
    assert.ok(performance.now() - t0 >= 30 && performance.now() - t0 < 2000, "after the timeout, not before and not never");
    const r = analyse(SHAPES.shelfArm);
    assert.ok(Math.abs(st.computeStress(r, stalled).maxUtilisation - st.computeStress(r, wasm).maxUtilisation) < 1e-6, "same numbers");
    let late = null;
    const slow = () => new Promise((resolve) => setTimeout(() => resolve(wasm), 80));
    assert.equal((await st.loadSolverWithin(slow, 20, (handle) => { late = handle; })).backend, "ts");
    assert.equal(late, null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(late, wasm, "the late solver is handed over");
    let called = false;
    assert.equal(await st.loadSolverWithin(() => Promise.resolve(wasm), 1000, () => { called = true; }), wasm);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(called, false, "a solver that came in time is just returned");
    assert.equal(st.WASM_LOAD_MS, 10_000);
});

await test("sharedSolver: a stalled WASM download does not hold a finished analysis back (TypeScript solver after the timeout, WASM from the next run once it arrives)", async () => {
    ws.resetSharedSolver();
    let release = () => {};
    const stalled = new Promise((resolve) => { release = () => resolve(wasm); });
    const first = ws.sharedSolver("any.wasm", () => stalled, 30);
    const r = analyse(SHAPES.shelfArm);
    const t0 = performance.now();
    const out = await ws.withStress(r); // goes through the same shared solver
    assert.ok(performance.now() - t0 < 2000);
    assert.equal(out.stress.solver.backend, "ts", "the stalled load is not waited for");
    assert.ok(Math.abs(out.stress.maxUtilisation - st.computeStress(r, wasm).maxUtilisation) < 1e-6);
    assert.equal((await first).backend, "ts");
    assert.equal((await ws.sharedSolver()).backend, "ts", "the stalled promise is not kept");
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await ws.sharedSolver()).backend, "wasm", "the late module is used from then on");
    assert.equal((await ws.withStress(r)).stress.solver.backend, "wasm");
    // A reset while the old load is still out: when it turns up it must not replace the solver of the new load.
    ws.resetSharedSolver();
    let releaseOld = () => {};
    const old = new Promise((resolve) => { releaseOld = () => resolve(wasm); });
    await ws.sharedSolver("old.wasm", () => old, 20);
    ws.resetSharedSolver();
    const fresh = { solve: fem.solveFrameTs, backend: "ts" };
    assert.equal(await ws.sharedSolver("new.wasm", () => Promise.resolve(fresh), 1000), fresh);
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await ws.sharedSolver(), fresh);
    ws.resetSharedSolver();
});

await test("parseBounds: finite numbers, min <= max, else null", () => {
    assert.deepEqual(asm.parseBounds({ min: [0, 0, 0], max: [1, 2, 3] }), { min: [0, 0, 0], max: [1, 2, 3] });
    for (const bad of [null, undefined, 3, "x", {}, { min: [0, 0, 0] }, { min: [0, 0], max: [1, 1, 1] }, { min: [0, 0, 0], max: [1, 1, Infinity] }, { min: [0, 0, 0], max: [1, 1, NaN] }, { min: [2, 0, 0], max: [1, 1, 1] }, { min: [0, 0, "0"], max: [1, 1, 1] }]) {
        assert.equal(asm.parseBounds(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(asm.boundsOf(new Float32Array([0, 1, 2, 3, 4, 5])), { min: [0, 1, 2], max: [3, 4, 5] });
    assert.equal(asm.boundsOf(new Float32Array(0)), null);
});

await test("report: stress block, assembly counts, per-block role/step/utilisation, CSV columns, stabilization log", async () => {
    const blocks = [...SHAPES.shelfArm.map((cell) => ({ cell })), ...[4, 3, 2, 1, 0].map((k) => ({ cell: [8, 1, k], role: "column", step: 1 }))];
    const desc = descriptorFromBlocks(blocks);
    const r = await ws.analyzeAssemblyWithStress(desc, null, {});
    const json = JSON.parse(JSON.stringify(buildReport(r, { modelName: "Shelf", derived: { marker: "log" } })));
    assert.equal(json.version, 1);
    assert.equal(json.model.modelName, "Shelf"); assert.equal(json.model.derived, undefined, "the log is its own key, not part of model");
    assert.deepEqual(json.stabilization, { marker: "log" });
    assert.deepEqual(json.assembly, { blocks: blocks.length, added_blocks: 5, steps: 1, role_counts: { original: SHAPES.shelfArm.length, column: 5, footing: 0, bracket: 0, bridge: 0, reinforcement: 0 } });
    assert.equal(json.stress.load_case, "self-weight");
    assert.equal(json.stress.material.id, "concrete"); assert.equal(json.stress.material.joint_tension_mpa, 0.2); assert.equal(json.stress.material.density_kg_m3, 2400);
    assert.deepEqual(json.stress.thresholds, { warn: 0.75, fail: 1 });
    assert.equal(json.stress.solver.backend, "wasm"); assert.match(json.stress.solver.name, /Awatif/);
    assert.equal(json.stress.max_utilisation, Math.round(r.stress.maxUtilisation * 1000) / 1000);
    assert.equal(json.stress.points.length, r.stress.points.length);
    assert.ok(json.stress.assumptions.length >= 4);
    assert.equal(json.blocks.length, blocks.length);
    assert.ok(json.blocks.every((b) => typeof b.role === "string" && Number.isInteger(b.step) && b.utilisation !== undefined));
    assert.equal(json.blocks.filter((b) => b.role === "column").length, 5);
    assert.ok(json.blocks.filter((b) => b.role === "column").every((b) => b.step === 1));
    assert.ok(json.definitions.some((d) => d.key === "stress") && json.definitions.some((d) => d.key === "utilisation") && json.definitions.some((d) => d.key === "stabilizer"));
    const csv = buildBlocksCsv(r).trimEnd().split("\n");
    assert.equal(csv[0], "index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill,role,step,utilisation");
    const columnRow = csv.slice(1).map((l) => l.split(",")).find((c) => c[11] === "column");
    assert.equal(columnRow.length, 14); assert.equal(columnRow[12], "1"); assert.ok(Number(columnRow[13]) >= 0);
    // A mesh result (not an assembly) without the stress stage: no role/step, stress null, utilisation column empty.
    const plain = analyse(SHAPES.bridge);
    const plainJson = JSON.parse(JSON.stringify(buildReport(plain)));
    assert.equal(plainJson.stress, null); assert.equal(plainJson.stabilization, undefined);
    assert.ok(plainJson.blocks.every((b) => b.utilisation === undefined));
    const plainCsv = buildBlocksCsv({ ...plain, assembly: null, blocks: plain.blocks.map((b) => ({ ...b, role: undefined, step: undefined })) }).trimEnd().split("\n");
    assert.ok(plainCsv.slice(1).every((l) => l.endsWith(",,,")), "role, step and utilisation are empty");
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
