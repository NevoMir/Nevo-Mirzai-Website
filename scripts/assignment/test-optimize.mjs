// Tests for the optimizer (src/assignment/analysis/optimize, shared/optimizeSpec.ts, shared/optimizeMeta.ts): the BESO-style search that takes
// blocks out of (or puts them into) a block assembly under the engine's own constraints, the spec language that drives it, and the log it saves.
//   node scripts/assignment/test-optimize.mjs        (about 1.5 minutes: ONLY=text runs the tests whose name has it)
//
// What is pinned down:
//   - the strain energy of a beam is exact (equals 1/2 F.u), so the sensitivities are not a proxy
//   - repairSpec turns anything into a valid spec and never throws (junk fuzz); compileSpec's defaults, masks and warnings
//   - lightest stable / most stable on bundled examples: fewer blocks (or a better margin), no error and no warning in the official analysis,
//     the outside shape kept under "inner", the history never gets worse, masks and protections hold
//   - the result table of the design reproduces within +-2 % blocks (mushroom 394 -> 285, pyramid 426 -> 274, ...)
//   - deterministic: twice, and the TypeScript solver agrees with Awatif's WASM
//   - symmetry, impossible limits (the start comes back), edit blocks ("user") are not "added support", shape_changed, labels
//   - optimizeAssembly: canonical assembly, roles and steps kept, the GLB carries the log, the log is validated and cross-checked
//   - the worker protocol: events in order, Stop gives a valid partial result within 0.5 s
//   - the review fixes: the Settings block budget limits the run; a model past 75 % strength is not asked to get under it first; the sweep serves
//     additions as well as removals and says "converged / complete" only when no single block can still help; a model past the stress floor and
//     the margin cap is left alone; the safety net against the Stability tab's verdict; "before" is measured before the run; part names with no
//     Latin letters never match by accident
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const L = await import("./optimize-lib.mjs");
const { SPEC, OPT, EVAL, OA, SL, MC } = L;

const solver = await L.getSolver();
const settings = L.settingsMod.normalizeSettings({});
const material = L.mats.materialOf("concrete").fem;
let passed = 0; const failures = [];
async function test(name, fn) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
    const t0 = performance.now();
    try { await fn(); passed++; console.log(`  ok   ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); }
}
const ctxOf = (slug, parts = {}) => OA.specContextOf(L.loadStabilized(slug).descriptor, settings, solver, parts);
const RC = (ctx) => SPEC.repairContextOf(ctx);
const SOURCE = { kind: "stabilized", assembly_hash: null };
const baseInput = (r, spec, extra = {}) => ({ assembly: r.descriptor, settings, spec, goal: "test goal", source: "blocks", parts: {}, stabilizedDepth: 1, ...extra });

await test("strain energy equals 1/2 F.u (the sensitivity is exact)", async () => {
    for (const slug of ["cantilever-house", "pencil-leg-chair", "mushroom-pavilion"]) {
        const { occ } = L.occOf(L.loadStabilized(slug).descriptor);
        const ev = EVAL.createEvaluator({ solve: solver.solve, blockSizeMm: 100, material, cantileverLimit: 4 });
        const f = ev.field(occ);
        const stab = L.adapter.makeStressSolver({ solve: solver.solve, blockSizeMm: 100, material })(occ, L.DIMS);
        let work = 0;
        for (let q = 0; q < stab.model.loadNodes.length; q++) work += 0.5 * stab.model.loadVals[6 * q + 2] * stab.solution.displacements[3 * stab.model.loadNodes[q] + 2];
        assert.ok(Math.abs(f.strainEnergy - work) / work < 1e-6, `${slug}: ${f.strainEnergy} vs ${work}`);
    }
});

await test("repairSpec: junk in, valid spec out, never throws (fuzz)", () => {
    const ctx = ctxOf("pencil-leg-chair", { Backrest: new Uint8Array(1000) });
    for (const raw of [null, undefined, 5, "x", [], {}, { objective: "no" }, { objective: [{ metric: "nonsense", weight: 1 }] }, { moves: { allow: "explode", removable: 3 } }, { constraints: { max_stress_pct: "abc", min_blocks_pct: -5, max_added_blocks: 1e9 } }, { protected: [{ mode: "keep", part: "Hat", box: null }, { mode: "keep", part: null, box: { min: [-5, 99, 3], max: [4, 4, 4] } }] }]) {
        const { spec } = SL.repairSpec(raw, RC(ctx));
        assert.ok(spec.objective.length >= 1 && spec.objective.length <= 3);
        assert.ok(Math.abs(spec.objective.reduce((s, t) => s + t.weight, 0) - 1) < 2e-3);
        assert.ok(["remove", "add", "both"].includes(spec.moves.allow) && ["added", "inner", "any"].includes(spec.moves.removable));
        SPEC.compileSpec(spec, ctx); // compiles
    }
    const { spec } = SL.repairSpec({ protected: [{ mode: "keep", part: "backrest", box: null }, { mode: "clear", part: null, box: { min: [-5, 99, 3], max: [4, 4, 4] } }] }, RC(ctx));
    assert.equal(spec.protected[0].part, "Backrest");
    assert.deepEqual(spec.protected[1].box, { min: [0, 4, 3], max: [4, 9, 4] });
    // random junk of every JSON shape
    let seed = 7;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const junk = (depth = 0) => {
        const r = rnd();
        if (depth > 3 || r < 0.35) return [null, 0, -3, 1e12, NaN, Infinity, "", "a".repeat(5000), "keep", "blocks", true, false, "\u0000\n"][Math.floor(rnd() * 13)];
        if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 5) }, () => junk(depth + 1));
        const o = {};
        for (const k of ["actionable", "title", "summary", "objective", "metric", "weight", "moves", "allow", "removable", "constraints", "max_stress_pct", "min_cog_margin_mm", "max_cantilever_blocks", "max_blocks", "max_added_blocks", "min_blocks_pct", "max_deflection_pct", "keep_one_piece", "symmetry", "protected", "mode", "part", "box", "min", "max", "stop", "reduce_blocks_by_pct", "notes"]) if (rnd() < 0.3) o[k] = junk(depth + 1);
        return o;
    };
    for (let n = 0; n < 3000; n++) {
        const { spec } = SL.repairSpec(junk(), RC(ctx));
        assert.ok(spec.objective.length >= 1 && spec.objective.length <= 3 && spec.protected.length <= 6 && spec.notes.length <= 3);
        assert.ok(spec.title.length <= 48 && spec.summary.length <= 240);
        for (const t of spec.objective) assert.ok(t.weight > 0 && t.weight <= 1);
        if (n % 50 === 0) SPEC.compileSpec(spec, ctx);
    }
});

await test("compileSpec: defaults, warnings in plain words, masks", () => {
    const ctx = ctxOf("cantilever-house");
    const lightest = SPEC.compileSpec(SL.presetSpec("lightest", ctx.start), ctx);
    assert.equal(lightest.effective.maxStressPct, 75);
    assert.equal(lightest.effective.minCogMarginMm, 100);
    assert.equal(lightest.config.allowAdd, false);
    assert.ok(lightest.config.canRemove.reduce((a, b) => a + b, 0) >= 20);
    const any = SL.presetSpec("lightest", ctx.start); any.moves.removable = "any";
    const c = SPEC.compileSpec(any, ctx);
    assert.equal(c.config.limits.minBlocks, Math.ceil(ctx.start.blocks * 0.5));
    assert.ok(c.warnings.some((w) => /at least 50/.test(w)));
    const sym = SL.presetSpec("lightest", ctx.start); sym.constraints.symmetry = "xy";
    assert.ok(SPEC.compileSpec(sym, ctx).warnings.some((w) => /symmetric/.test(w)));
    // warnings and notes never use the engine's words
    const loose = SL.presetSpec("lightest", ctx.start); loose.constraints.max_cantilever_blocks = 9; loose.constraints.max_stress_pct = 95; loose.constraints.min_cog_margin_mm = 400;
    const w = SPEC.compileSpec(loose, ctx).warnings.join(" ");
    assert.ok(/Stability tab/.test(w) && !/cantilever|centre-of-gravity|COG|utilisation|compliance/i.test(w), w);
    // no block budget with adding: +10 %, min 5
    const stable = SPEC.compileSpec({ ...SL.presetSpec("most-stable", ctx.start), constraints: { ...SL.presetSpec("most-stable", ctx.start).constraints, max_added_blocks: null } }, ctx);
    assert.equal(stable.config.limits.maxBlocks, ctx.start.blocks + Math.max(5, Math.round(ctx.start.blocks * 0.1)));
    assert.ok(stable.warnings.some((x) => /No block budget/.test(x)));
});

await test("compileSpec: blocks made by an edit (user) are not 'added support'", () => {
    const r = L.loadStabilized("pencil-leg-chair");
    const { occ, role } = L.occOf(r.descriptor);
    const user = L.asm.roleIndex("user");
    const chosen = [...Array(1000).keys()].filter((c) => occ[c] && role[c] === 0).slice(0, 5);
    for (const c of chosen) role[c] = user;
    const ctx = { ...ctxOf("pencil-leg-chair"), occ, role };
    const added = SL.presetSpec("lightest", ctx.start); added.moves.removable = "added";
    const c = SPEC.compileSpec(added, ctx);
    for (const cell of chosen) assert.equal(c.config.canRemove[cell], 0, "an edit block was offered as removable support");
    // the stabilizer's own blocks still are
    assert.ok([...Array(1000).keys()].some((cell) => occ[cell] && role[cell] > 0 && role[cell] !== user && c.config.canRemove[cell] === 1));
    const any = SL.presetSpec("lightest", ctx.start); any.moves.removable = "any";
    for (const cell of chosen) assert.equal(SPEC.compileSpec(any, ctx).config.canRemove[cell], 1);
});

await test("lightest stable: fewer blocks, no error, no warning, hidden-inner scope keeps the outside", async () => {
    for (const slug of ["cantilever-house", "step-pyramid", "arch-footbridge"]) {
        const ctx = ctxOf(slug);
        const c = SPEC.compileSpec(SL.presetSpec("lightest", ctx.start), ctx);
        const res = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
        assert.ok(res.end.blocks < res.start.blocks, slug);
        assert.ok(res.feasible && res.stop === "converged");
        const v = await L.official(res.occupancy);
        assert.equal(v.summary.errors, 0); assert.equal(v.summary.warnings, 0);
        for (const cell of res.removed) assert.ok(c.config.canRemove[cell] === 1, "removed a protected block");
        assert.ok(res.end.maxUtil <= 0.75 + 1e-9 && res.end.cogMarginMm >= Math.min(100, ctx.start.cogMarginMm) - 1e-6);
        assert.equal(res.added.length, 0);
    }
});

await test("the result table reproduces within +-2 % blocks", async () => {
    const WANT = { "mushroom-pavilion": 285, "step-pyramid": 274, "cantilever-house": 119, "arch-footbridge": 128 };
    for (const [slug, want] of Object.entries(WANT)) {
        const ctx = ctxOf(slug);
        const c = SPEC.compileSpec(SL.presetSpec("lightest", ctx.start), ctx);
        const res = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
        assert.ok(Math.abs(res.end.blocks - want) <= Math.max(2, want * 0.02), `${slug}: ${res.end.blocks} blocks, the table says ${want}`);
        assert.equal(res.stop, "converged", slug);
    }
    // the budgeted "most stable" row: a pencil chair 103 -> 119 with its margin at the cap
    const ctx = ctxOf("pencil-leg-chair");
    const spec = SL.presetSpec("most-stable", ctx.start); spec.constraints.max_added_blocks = 20;
    const res = await OPT.optimize(ctx.occ, SPEC.compileSpec(spec, ctx).config, { solve: solver.solve, material });
    assert.ok(res.end.blocks >= 112 && res.end.blocks <= 123, `chair: ${res.end.blocks}`);
    assert.ok(res.end.cogMarginMm >= 250 && res.end.maxUtil < 0.45);
});

await test("most stable within +N blocks: never over the budget, stability better, history is monotone", async () => {
    for (const slug of ["pencil-leg-chair", "cantilever-house", "desk-lamp"]) {
        const ctx = ctxOf(slug);
        const spec = SL.presetSpec("most-stable", ctx.start); spec.constraints.max_added_blocks = 15;
        const c = SPEC.compileSpec(spec, ctx);
        const res = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
        assert.ok(res.end.blocks <= res.start.blocks + 15, slug);
        assert.ok(res.end.cogMarginMm > res.start.cogMarginMm + 20 || res.end.maxUtil < res.start.maxUtil - 0.1, slug);
        for (let i = 1; i < res.history.length; i++) assert.ok(res.history[i].objective <= res.history[i - 1].objective + 1e-9, "objective went up at row " + i);
        assert.equal((await L.official(res.occupancy)).summary.errors, 0);
    }
});

await test("protected parts are never touched; 'only' and 'clear' regions hold", async () => {
    const { ctx, state } = await L.ctxFor("pencil-leg-chair");
    assert.ok(Object.keys(ctx.parts).length >= 3, "the chair has named parts");
    const spec = SL.presetSpec("lightest", ctx.start); spec.moves.removable = "any"; spec.constraints.min_blocks_pct = 60;
    spec.protected = [{ mode: "keep", part: "Seat cushion", box: null }, { mode: "keep", part: "Backrest", box: null }];
    const c = SPEC.compileSpec(spec, ctx);
    const res = await OPT.optimize(state.occ, c.config, { solve: solver.solve, material });
    assert.ok(res.removed.length > 0);
    for (const cell of res.removed) assert.ok(!ctx.parts["Seat cushion"][cell] && !ctx.parts["Backrest"][cell]);
    const only = SL.presetSpec("lightest", ctx.start); only.moves.removable = "any"; only.constraints.min_blocks_pct = 60;
    only.protected = [{ mode: "only", part: null, box: { min: [0, 0, 0], max: [9, 9, 3] } }];
    const r2 = await OPT.optimize(state.occ, SPEC.compileSpec(only, ctx).config, { solve: solver.solve, material });
    for (const cell of r2.removed) assert.ok(L.grid.cellCoords(L.DIMS, cell)[2] <= 3);
    // "clear": nothing may be put into the box
    const clear = SL.presetSpec("most-stable", ctx.start); clear.protected = [{ mode: "clear", part: null, box: { min: [0, 0, 0], max: [9, 4, 9] } }];
    const r3 = await OPT.optimize(state.occ, SPEC.compileSpec(clear, ctx).config, { solve: solver.solve, material });
    for (const cell of r3.added) assert.ok(L.grid.cellCoords(L.DIMS, cell)[1] > 4, "put a block into a cleared box");
});

await test("deterministic: twice the same blocks, and the TypeScript solver agrees with Awatif's WASM", async () => {
    const ctx = ctxOf("cantilever-house");
    const c = SPEC.compileSpec(SL.presetSpec("most-stable", ctx.start), ctx);
    const a = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
    const b = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
    const t = await OPT.optimize(ctx.occ, c.config, { solve: L.fem.solveFrameTs, material });
    assert.deepEqual([...a.occupancy], [...b.occupancy]);
    assert.deepEqual([...a.occupancy], [...t.occupancy]);
    assert.deepEqual(a.history.map((h) => [h.blocks, h.removed, h.added]), t.history.map((h) => [h.blocks, h.removed, h.added]));
});

await test("symmetry: orbits move together", async () => {
    const ctx = ctxOf("arch-footbridge");
    assert.ok(SPEC.symmetriesOf(ctx.occ).includes("xy"));
    const spec = SL.presetSpec("lightest", ctx.start); spec.constraints.symmetry = "xy";
    const res = await OPT.optimize(ctx.occ, SPEC.compileSpec(spec, ctx).config, { solve: solver.solve, material });
    assert.ok(res.changed && SPEC.symmetriesOf(res.occupancy).includes("xy"));
});

await test("an impossible limit gives back the start, not a broken model", async () => {
    const ctx = ctxOf("pencil-leg-chair");
    const spec = SL.presetSpec("lightest", ctx.start); spec.constraints.max_stress_pct = 30;
    const res = await OPT.optimize(ctx.occ, SPEC.compileSpec(spec, ctx).config, { solve: solver.solve, material });
    assert.equal(res.feasible, false); assert.equal(res.stop, "infeasible"); assert.equal(res.changed, false);
    assert.ok(res.notes.length > 0 && !/centre-of-gravity|cantilever|stress /i.test(res.notes.join(" ")), res.notes.join(" "));
});

await test("optimizeAssembly: canonical assembly, roles/steps kept, the GLB carries the log, the meta adds up", async () => {
    const r = L.loadStabilized("pencil-leg-chair");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    const spec = SL.presetSpec("most-stable", ctx.start);
    const input = baseInput(r, spec, { goal: "Most stable", stamp: { createdAt: "2026-01-01T00:00:00.000Z", durationMs: 1 } });
    const run = await OA.optimizeAssembly(input, { solver });
    assert.ok(L.asm.parseAssemblyDescriptor(run.descriptor));
    const back = L.glb.readAssemblyGlb(run.glb);
    assert.ok(back.ok, back.error); assert.equal(back.blocks, run.meta.after.blocks);
    assert.equal(back.meta, null); assert.equal(back.edit, null);
    assert.deepEqual(JSON.parse(JSON.stringify(back.optimization)), JSON.parse(JSON.stringify(MC.checkOptimizeMeta(JSON.parse(JSON.stringify(run.meta)), null).value)), "the GLB carries the log");
    assert.deepEqual(back.descriptor.cells, run.descriptor.cells);
    assert.equal(await L.asm.assemblyHash(run.descriptor), run.meta.assembly_hash);
    const m = run.meta;
    assert.equal(m.before.blocks - m.removed.length + m.added, m.after.blocks);
    assert.equal(m.stabilized_depth, 1); assert.equal(m.goal, "Most stable"); assert.equal(m.shape_changed, false);
    assert.equal(m.source_hash, await L.asm.assemblyHash(r.descriptor));
    const was = new Map(); for (let n = 0; n < r.descriptor.cells.length; n += 5) was.set(r.descriptor.cells.slice(n, n + 3).join(), r.descriptor.cells.slice(n + 3, n + 5).join());
    let added = 0;
    for (let n = 0; n < run.descriptor.cells.length; n += 5) {
        const key = run.descriptor.cells.slice(n, n + 3).join(); const rs = run.descriptor.cells.slice(n + 3, n + 5).join();
        if (was.has(key)) assert.equal(rs, was.get(key)); else { added++; assert.equal(run.descriptor.cells[n + 3], 5); assert.equal(run.descriptor.cells[n + 4], m.step); }
    }
    assert.equal(added, m.added);
    assert.ok(JSON.stringify(m).length < 16 * 1024);
    assert.equal(m.after.errors, 0);
    // same input -> same GLB bytes
    const run2 = await OA.optimizeAssembly(input, { solver });
    assert.deepEqual(Buffer.from(run.glb), Buffer.from(run2.glb));
    // a mesh source has no block hash
    const fromMesh = await OA.optimizeAssembly({ ...input, source: "mesh", stabilizedDepth: 0 }, { solver });
    assert.equal(fromMesh.meta.source_hash, null);
    await assert.rejects(OA.optimizeAssembly({ ...input, spec: { ...spec, actionable: false } }, { solver }), /not something/);
    await assert.rejects(OA.optimizeAssembly({ ...input, stabilizedDepth: 4 }, { solver }), /depth/);
    await assert.rejects(OA.optimizeAssembly({ ...input, goal: "  " }, { solver }), /goal/);
});

await test("OptimizeMeta: validated, rebuilt field by field, cross-checked against the cells", async () => {
    const r = L.loadStabilized("cantilever-house");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    const run = await OA.optimizeAssembly(baseInput(r, SL.presetSpec("most-stable", ctx.start)), { solver });
    const hash = await L.asm.assemblyHash(r.descriptor);
    const wire = JSON.parse(JSON.stringify(run.meta));
    const ok = MC.checkOptimizeMeta(wire, null);
    assert.ok(ok.ok, ok.error);
    assert.deepEqual(JSON.parse(JSON.stringify(ok.value)), wire, "rebuilding is idempotent");
    const source = { kind: "stabilized", assembly_hash: hash };
    assert.equal(MC.crossCheckOptimized(run.descriptor, ok.value, source), null);
    const bad = (patch) => MC.checkOptimizeMeta({ ...wire, ...patch }, null);
    assert.ok(!bad({ version: 2 }).ok);
    assert.ok(!bad({ feasible: false }).ok);
    assert.ok(!bad({ removed: [5, 3] }).ok);
    assert.ok(!bad({ after: { ...wire.after, blocks: wire.after.blocks + 1 } }).ok);
    assert.ok(!bad({ history: [[1, 2, 3]] }).ok);
    assert.ok(!bad({ assembly_hash: "zz" }).ok);
    assert.ok(!bad({ goal: "" }).ok && !bad({ goal: "x".repeat(301) }).ok);
    assert.ok(!bad({ labels: "A".repeat(wire.after.blocks) }).ok, "a label for a part the log does not list");
    assert.ok(!bad({ labels: "." }).ok);
    // the log disagrees with the cells
    assert.ok(MC.crossCheckOptimized(run.descriptor, { ...ok.value, added: ok.value.added + 1 }, source));
    const present = run.descriptor.cells; const code = present[2] * 100 + present[1] * 10 + present[0];
    assert.ok(MC.crossCheckOptimized(run.descriptor, { ...ok.value, removed: [code] }, source));
    // made from another model than the one it is saved on
    assert.ok(MC.crossCheckOptimized(run.descriptor, ok.value, { kind: "stabilized", assembly_hash: "0".repeat(64) }));
    assert.ok(MC.crossCheckOptimized(run.descriptor, ok.value, { kind: "generated", assembly_hash: null }), "a block log on a mesh");
    // junk spec inside the meta is cleaned, not trusted
    const junk = MC.checkOptimizeMeta({ ...wire, spec: { objective: [{ metric: "blocks", weight: 5 }], moves: { allow: "x" } } }, null);
    assert.ok(junk.ok && junk.value.spec.moves.allow === "remove");
    assert.ok(wire.removed.length === wire.removed_at.length && wire.added === wire.added_at.length);
    // the slim summary the server stores
    const summary = MC.summarizeOptimize(ok.value);
    assert.equal(summary.version, 1); assert.equal(summary.removed, wire.removed.length); assert.equal(summary.added, wire.added);
    assert.ok(JSON.stringify(summary).length < 4 * 1024);
    // a worst-case log still fits the limit: 40 parts-worth of text is capped, 120 history rows, 999 removed
    assert.ok(MC.OPTIMIZE_META_LIMIT >= JSON.stringify({ ...wire, removed: Array.from({ length: 400 }, (_, i) => 500 + i), removed_at: Array.from({ length: 400 }, () => 150) }).length);
});

await test("shape_changed: true only when a surface block of the model's own is gone; parts and labels travel in the log", async () => {
    // inner scope never changes the shape
    const r = L.loadStabilized("mushroom-pavilion");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    const inner = await OA.optimizeAssembly(baseInput(r, SL.presetSpec("lightest", ctx.start)), { solver });
    assert.equal(inner.meta.shape_changed, false);
    assert.equal(inner.meta.parts.length, 0); assert.equal(inner.meta.labels, ".".repeat(inner.meta.after.blocks));
    // "any" on a thin model takes surface blocks away
    const pc = L.loadStabilized("pencil-leg-chair");
    const pctx = OA.specContextOf(pc.descriptor, settings, solver, {});
    const any = SL.presetSpec("lightest", pctx.start); any.moves.removable = "any"; any.constraints.min_blocks_pct = 70;
    const gone = await OA.optimizeAssembly(baseInput(pc, any), { solver });
    assert.ok(gone.meta.removed.length > 0 && gone.meta.shape_changed === true);
    // labels: a named part gets its letter, new blocks and the rest get '.'
    const { ctx: withParts, descriptor } = await L.ctxFor("pencil-leg-chair");
    const cells = L.partCells(withParts.parts);
    const run = await OA.optimizeAssembly(baseInput({ descriptor }, SL.presetSpec("most-stable", withParts.start), { parts: cells }), { solver });
    const names = Object.keys(OA.cleanParts(cells));
    assert.deepEqual(run.meta.parts, names);
    assert.equal(run.meta.labels.length, run.meta.after.blocks);
    const letters = new Set(run.meta.labels.replace(/\./g, ""));
    assert.ok(letters.size >= 2 && [...letters].every((ch) => ch.charCodeAt(0) - 65 < names.length));
    // the validator accepts it, and a stabilizer-added block of the result carries '.', never a part letter
    assert.ok(MC.checkOptimizeMeta(JSON.parse(JSON.stringify(run.meta)), null).ok);
    const wasBlock = new Set(); for (let n = 0; n < descriptor.cells.length; n += 5) wasBlock.add(descriptor.cells.slice(n, n + 3).join());
    for (let n = 0, b = 0; n < run.descriptor.cells.length; n += 5, b++) if (!wasBlock.has(run.descriptor.cells.slice(n, n + 3).join())) assert.equal(run.meta.labels[b], ".", "a new block was labelled");
});

await test("cleanParts: names are made safe, at most 26 parts, cells validated", () => {
    const messy = OA.cleanParts({ "  Seat <b>cushion</b>  ": [1, 2, 2, 3], "": [5], ["x".repeat(80)]: [7], "Seat   Cushion": [9], "seat cushion ": [9], Empty: [], Bad: [-1, 5000, 1.5], Ok: new Uint16Array([4, 6]) });
    assert.deepEqual(Object.keys(messy), ["Seat b cushion b", "x".repeat(40), "Seat Cushion", "Ok"]);
    assert.deepEqual(messy["Seat b cushion b"], [1, 2, 3]);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Part ${i}`, Array.from({ length: i + 1 }, (_, c) => c)]));
    const kept = Object.keys(OA.cleanParts(many));
    assert.equal(kept.length, 26);
    assert.ok(kept.includes("Part 39") && !kept.includes("Part 0"), "the biggest parts are kept");
});

await test("worker protocol: events in order, Stop gives a valid partial result within 0.5 s", async () => {
    const outbox = [];
    globalThis.self = { postMessage: (m) => outbox.push(m), onmessage: null };
    await import(`${L.R}analysis/optimize/optimize.worker.ts`);
    const r = L.loadStabilized("mushroom-pavilion");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    const input = baseInput(r, SL.presetSpec("lightest", ctx.start), { stabilizedDepth: 0 });
    globalThis.self.onmessage({ data: { kind: "optimize", id: 3, input, wasmUrl: L.WASM_PATH } });
    // Stop once the run has made some rounds (a fixed delay is a race against the machine's load and the "before" figures taken first)
    const canceledAt = { t: 0 };
    while (!outbox.some((m) => m.kind === "done" || m.kind === "error")) {
        if (!canceledAt.t && outbox.filter((m) => m.kind === "event" && m.event.kind === "iteration").length >= 5) { canceledAt.t = performance.now(); globalThis.self.onmessage({ data: { kind: "cancel", id: 3 } }); }
        await new Promise((res) => setTimeout(res, 5));
    }
    const answeredAfter = performance.now() - canceledAt.t;
    const done = outbox.find((m) => m.kind === "done");
    assert.ok(done, JSON.stringify(outbox.find((m) => m.kind === "error")));
    assert.equal(outbox[0].event.kind, "start");
    assert.equal(done.result.result.stop, "canceled");
    assert.ok(answeredAfter < 500, `Stop was answered after ${answeredAfter.toFixed(0)} ms`);
    assert.ok(done.result.meta.feasible && done.result.meta.after.errors === 0 && done.result.meta.after.blocks < done.result.meta.before.blocks);
    assert.ok(L.glb.readAssemblyGlb(done.result.glb).ok, "the partial result is a valid file");
    const iters = outbox.filter((m) => m.kind === "event" && m.event.kind === "iteration").map((m) => m.event.record.iteration);
    assert.ok(iters.length > 3);
    assert.deepEqual(iters, iters.slice().sort((a, b) => a - b));
    // a bad input is an error message, not a crash
    outbox.length = 0;
    globalThis.self.onmessage({ data: { kind: "optimize", id: 9, input: { ...input, assembly: { version: 1, cells: [] } }, wasmUrl: L.WASM_PATH } });
    while (!outbox.length) await new Promise((res) => setTimeout(res, 10));
    assert.equal(outbox[0].kind, "error"); assert.match(outbox[0].message, /not a valid block list/);
});

await test("runOptimize on the page's own thread: Stop resolves with the best state so far; a finished run is the same as the worker's", async () => {
    const RO = await L.A("analysis/optimize/runOptimize");
    const r = L.loadStabilized("mushroom-pavilion");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    const input = baseInput(r, SL.presetSpec("lightest", ctx.start), { stabilizedDepth: 0 });
    const ac = new AbortController();
    let seen = 0;
    let stoppedAt = 0;
    const res = await RO.runOptimize(input, { signal: ac.signal, wasmUrl: L.WASM_PATH, onIteration: () => { if (++seen === 3) { stoppedAt = performance.now(); ac.abort(); } } });
    assert.equal(res.result.stop, "canceled");
    assert.ok(res.meta.feasible && seen >= 3, `${seen} rounds`);
    assert.ok(performance.now() - stoppedAt < 3000, "Stop is answered");
    const full = await RO.runOptimize(baseInput(L.loadStabilized("cantilever-house"), SL.presetSpec("lightest", OA.specContextOf(L.loadStabilized("cantilever-house").descriptor, settings, solver, {}).start)), { wasmUrl: L.WASM_PATH });
    assert.equal(full.result.stop, "converged");
    assert.ok(full.meta.after.blocks < full.meta.before.blocks);
    await assert.rejects(RO.runOptimize(input, { signal: AbortSignal.abort() }), (e) => e.name === "AbortError");
});


// ---------- the review fixes ----------

/** Every single block that may go or be put in (next to a block) after a run, and whether it would still be an improvement: the proof behind "no single block can change". */
function singleMovesLeft(res, c, ctx) {
    const lim = c.config.limits;
    const ev = EVAL.createEvaluator({ solve: solver.solve, blockSizeMm: 100, material, cantileverLimit: lim.cantileverLimit });
    const m0 = res.start;
    const ref = { blocks0: Math.max(1, m0.blocks), deflection0Mm: m0.maxDeflectionMm && m0.maxDeflectionMm > 0 ? m0.maxDeflectionMm : 1, uRef: lim.maxUtil ?? 0.75, blockSizeMm: 100 };
    const score = (occ, fem) => { const g = ev.geometry(occ); const f = fem && g.floatingCells !== g.count ? ev.field(occ) : null; const m = EVAL.metricsOf(g, f); return { v: EVAL.violationsOf(m, lim, ref, fem), g: EVAL.goalOf(m, c.config.terms, ref), j: EVAL.objectiveOf(m, c.config.terms, ref) }; };
    const cur = score(res.occupancy, true);
    const addedByRun = new Set(res.added);
    let left = 0;
    for (let cell = 0; cell < 1000; cell++) {
        const t = res.occupancy.slice();
        if (res.occupancy[cell]) {
            if (!((c.config.allowRemove && c.config.canRemove[cell]) || addedByRun.has(cell))) continue;
            t[cell] = 0;
        } else {
            if (!c.config.allowAdd || !c.config.canAdd[cell] || res.end.blocks >= lim.maxBlocks) continue;
            const [i, j, k] = L.grid.cellCoords(L.DIMS, cell);
            if (!L.grid.NB6.some(([a, b, d]) => L.grid.inGrid(L.DIMS, i + a, j + b, k + d) && res.occupancy[L.grid.cellIndex(L.DIMS, i + a, j + b, k + d)])) continue;
            t[cell] = 1;
        }
        const g = score(t, false);
        if (EVAL.compareViolations(g.v.slice(0, 5), cur.v.slice(0, 5)) > 0) continue; // the geometry alone rules it out
        const q = score(t, true);
        const cmp = EVAL.compareViolations(q.v, cur.v);
        if (cmp < 0 || (cmp === 0 && q.j < cur.j - 1e-9 * Math.max(1, Math.abs(cur.j)) && q.g < cur.g - EVAL.GOAL_TOL)) left++;
    }
    return left;
}

await test("the block budget of the Stability tab limits the run: nothing over it is offered, the plan says so (the review's OPT-1)", async () => {
    const r = L.loadStabilized("pencil-leg-chair");
    const n0 = r.descriptor.cells.length / 5;
    const tight = L.settingsMod.normalizeSettings({ maxBlocks: n0 + 2 });
    const ctx = OA.specContextOf(r.descriptor, tight, solver, {});
    assert.equal(ctx.budget, n0 + 2);
    assert.equal(OA.specContextOf(r.descriptor, settings, solver, {}).budget, null);
    // the plan: the budget is the limit (the preset asks for +10, the budget allows 2), and the warning is about it
    const planned = SPEC.compileSpec(SL.presetSpec("strongest", { blocks: n0 }), ctx);
    assert.equal(planned.effective.maxBlocks, n0 + 2);
    assert.ok(planned.warnings.some((w) => /block budget in Settings is \d+, lower than the limit asked for, so at most \d+ blocks are used/.test(w)), planned.warnings.join(" | "));
    // no limit asked for at all: the usual +10 % is cut to what the budget allows, in those words
    const open = SL.presetSpec("strongest", { blocks: n0 }); open.constraints.max_added_blocks = null;
    const cut = SPEC.compileSpec(open, ctx);
    assert.equal(cut.effective.maxBlocks, n0 + 2);
    assert.ok(cut.warnings.some((w) => /No block limit was given and the block budget in Settings is \d+, so at most 2 extra blocks may be added/.test(w)), cut.warnings.join(" | "));
    assert.ok(!cut.warnings.some((w) => /No block budget was given/.test(w)));
    // a limit of the spec's own is lowered by it, and a budget that does not bind changes nothing
    const own = SL.presetSpec("strongest", { blocks: n0 }); own.constraints.max_added_blocks = 30;
    const lowered = SPEC.compileSpec(own, ctx);
    assert.equal(lowered.effective.maxBlocks, n0 + 2);
    assert.equal(SPEC.compileSpec(own, { ...ctx, budget: n0 + 100 }).effective.maxBlocks, n0 + 30);
    assert.equal(SPEC.compileSpec(own, { ...ctx, budget: null }).effective.maxBlocks, n0 + 30);
    const { budget: _unused, ...oldContext } = ctx; // a context made before the field existed
    assert.equal(SPEC.compileSpec(own, oldContext).effective.maxBlocks, n0 + 30);
    const light = SPEC.compileSpec(SL.presetSpec("lightest", { blocks: n0 }), ctx);
    assert.ok(!light.warnings.some((w) => /block budget/.test(w)), "taking blocks away needs no word about the budget");
    // the runs: every goal that adds blocks ends inside the budget, and the Stability tab finds nothing to mark
    for (const chip of ["strongest", "most-stable", "stiffest"]) {
        const run = await OA.optimizeAssembly(baseInput(r, SL.presetSpec(chip, { blocks: n0 }), { settings: tight, timeBudgetMs: 20000 }), { solver });
        assert.ok(run.meta.after.blocks <= n0 + 2, `${chip}: ${run.meta.after.blocks} blocks, the budget is ${n0 + 2}`);
        assert.equal(run.meta.after.errors, 0, chip);
        assert.ok(run.meta.feasible, chip);
        assert.ok(run.compiled.effective.maxBlocks <= n0 + 2);
    }
});

await test("random goals under random budgets: a result that can be kept never stands over the Stability tab's budget (the review's fuzz)", async () => {
    let seed = 99;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let kept = 0;
    for (let n = 0; n < 14; n++) {
        const slug = pick(["pencil-leg-chair", "desk-lamp", "cantilever-house", "leaning-tower"]);
        const r = L.loadStabilized(slug);
        const n0 = r.descriptor.cells.length / 5;
        const budget = n0 + pick([0, 0, 1, 2, 5, 12]); // 0: the model is at its budget already; adding needs something to go first
        const tight = L.settingsMod.normalizeSettings({ maxBlocks: budget });
        const metrics = ["blocks", "peak_stress", "cog_margin", "deflection"].filter(() => rnd() < 0.5);
        const spec = SL.presetSpec(pick(["lightest", "most-stable", "strongest", "stiffest"]), { blocks: n0 });
        if (metrics.length) spec.objective = metrics.map((metric) => ({ metric, weight: 0.2 + rnd() }));
        spec.moves = { allow: pick(["remove", "add", "both"]), removable: pick(["added", "inner"]) };
        spec.constraints.max_added_blocks = pick([null, 3, 20]);
        const run = await OA.optimizeAssembly(baseInput(r, SL.repairSpec(spec, { partNames: [], blocks: n0 }).spec, { settings: tight, maxSolves: 120, timeBudgetMs: 15000 }), { solver });
        assert.ok(run.compiled.effective.maxBlocks <= Math.max(budget, 1), `${slug} budget ${budget}: the plan allows ${run.compiled.effective.maxBlocks}`);
        if (run.meta.feasible) {
            kept++;
            assert.equal(run.meta.after.errors, 0, `${slug} budget ${budget}: the Stability tab marks ${run.meta.after.errors}`);
            assert.ok(run.meta.after.blocks <= budget, `${slug}: ${run.meta.after.blocks} blocks over a budget of ${budget}`);
        }
    }
    assert.ok(kept >= 8, `${kept} of 14 runs could be kept`);
});

await test("the safety net: a result the Stability tab would mark with more problems than the start is never offered", async () => {
    const ctx = ctxOf("cantilever-house");
    const c = SPEC.compileSpec(SL.presetSpec("lightest", ctx.start), ctx);
    const res = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
    assert.ok(res.feasible && res.changed);
    assert.equal(OA.holdToEngine(res, 0, 0), res, "agreeing verdicts change nothing");
    assert.equal(OA.holdToEngine(res, 1, 1), res, "no more problems than the start had");
    const held = OA.holdToEngine(res, 0, 1);
    assert.equal(held.feasible, false); assert.equal(held.stop, "infeasible"); assert.equal(held.complete, false);
    assert.match(held.notes.join(" "), /The Stability tab would mark a problem in this result, so it cannot be kept\./);
    assert.match(OA.holdToEngine(res, 0, 3).notes.join(" "), /3 problems/);
    assert.deepEqual([...held.occupancy], [...res.occupancy], "the blocks are the run's, only the verdict is not");
    const already = { ...res, feasible: false, stop: "infeasible", notes: ["x"] };
    assert.equal(OA.holdToEngine(already, 0, 5), already, "an infeasible result already says so");
    // through optimizeAssembly: the engine's count decides meta.feasible and so whether the GLB carries a log
    const r = L.loadStabilized("cantilever-house");
    const run = await OA.optimizeAssembly(baseInput(r, SL.presetSpec("lightest", ctx.start)), { solver });
    assert.equal(run.meta.after.errors, 0); assert.ok(run.meta.feasible && L.glb.readAssemblyGlb(run.glb).optimization);
});

await test("a model that already uses more than 75 % of its strength is not asked to get under it first (the review's OPT-2)", async () => {
    // the original blocks of the mushroom: only the 'heavily loaded' warning, no error
    const r = L.loadStabilized("mushroom-pavilion");
    const keep = [];
    for (let n = 0; n < r.descriptor.cells.length; n += 5) if (r.descriptor.cells[n + 3] === 0) keep.push(...r.descriptor.cells.slice(n, n + 5));
    const desc = { ...r.descriptor, cells: keep };
    const ctx = OA.specContextOf(desc, settings, solver, {});
    const pct = ctx.start.maxUtil * 100;
    assert.ok(pct > 75, "the fixture is past 75 %");
    const c = SPEC.compileSpec(SL.presetSpec("strongest", ctx.start), ctx);
    assert.equal(c.effective.maxStressPct, Math.ceil(pct - 1e-9));
    assert.ok(c.warnings.some((w) => /already uses \d+ % of its strength, more than the usual 75 %, so the run keeps it at or under \d+ %/.test(w)), c.warnings.join(" | "));
    assert.ok(!c.warnings.some((w) => /first tries to bring it under/.test(w)), "it is not asked to");
    assert.ok(!c.warnings.some((w) => /is a warning in the Stability tab/.test(w)), "the start has that warning already");
    // every chip can work now (they ended 'infeasible' after seconds before)
    for (const chip of ["lightest", "strongest", "most-stable"]) {
        const run = await OA.optimizeAssembly(baseInput({ descriptor: desc }, SL.presetSpec(chip, ctx.start), { source: "mesh", stabilizedDepth: 0, maxSolves: 30, timeBudgetMs: 20000 }), { solver });
        assert.equal(run.result.feasible, true, `${chip}: ${run.result.notes.join(" ")}`);
        assert.notEqual(run.result.stop, "infeasible", chip);
        assert.ok(run.meta.after.errors === 0, chip);
    }
    const light = await OA.optimizeAssembly(baseInput({ descriptor: desc }, SL.presetSpec("lightest", ctx.start), { source: "mesh", stabilizedDepth: 0, timeBudgetMs: 20000 }), { solver });
    assert.ok(light.meta.after.blocks < light.meta.before.blocks && light.meta.feasible, "lightest takes blocks out");
    // a limit the person set stays as it is: below the start it is a repair, and the plan says it may not be reachable
    const strict = SL.presetSpec("lightest", ctx.start); strict.constraints.max_stress_pct = 75;
    const s = SPEC.compileSpec(strict, ctx);
    assert.equal(s.effective.maxStressPct, 75);
    assert.ok(s.warnings.some((w) => /first tries to bring it under\. If it cannot, nothing is changed; a higher limit keeps what it finds/.test(w)), s.warnings.join(" | "));
    // a model under 75 % keeps the usual limit
    assert.equal(SPEC.compileSpec(SL.presetSpec("strongest", ctx.start), ctxOf("cantilever-house")).effective.maxStressPct, 75);
});

await test("the sweep serves additions as well as removals, and 'converged / complete' is said only when no single block can still help (the review's OPT-3)", async () => {
    // an add-goal used to spend its sweep on removals that cannot help and end with better additions untried (J -0.639 here)
    const tower = ctxOf("leaning-tower");
    const stiff = SPEC.compileSpec(SL.presetSpec("stiffest", tower.start), tower);
    const t = await OPT.optimize(tower.occ, stiff.config, { solve: solver.solve, material });
    assert.ok(t.history[t.history.length - 1].objective < -0.7, `J ${t.history[t.history.length - 1].objective}`);
    assert.ok(t.end.blocks >= 79, `${t.end.blocks} blocks`);
    // complete: the last sweep tried everything, and a brute force over every single move agrees
    for (const slug of ["pencil-leg-chair", "leaning-tower", "oak-tree", "harbour-crane"]) {
        const ctx = ctxOf(slug);
        const c = SPEC.compileSpec(SL.presetSpec("lightest", ctx.start), ctx);
        const res = await OPT.optimize(ctx.occ, c.config, { solve: solver.solve, material });
        assert.equal(res.stop, "converged", slug);
        assert.equal(res.complete, true, `${slug}: the sweep covered every candidate`);
        assert.equal(singleMovesLeft(res, c, ctx), 0, `${slug}: a single move still helps although the run said so`);
    }
    // not complete: a run that stopped on diminishing returns says "converged" in its own, weaker words, and the claim would indeed have been false
    const dino = ctxOf("long-neck-dino");
    const c = SPEC.compileSpec(SL.presetSpec("strongest", dino.start), dino);
    const res = await OPT.optimize(dino.occ, c.config, { solve: solver.solve, material });
    assert.equal(res.stop, "converged");
    assert.equal(res.complete, false);
    assert.ok(singleMovesLeft(res, c, dino) > 0, "some single move would still have helped, so 'no single block can change' was not for this run");
    // whatever the goal: complete is only ever true when the brute force finds nothing
    for (const [slug, chip] of [["desk-lamp", "strongest"], ["leaning-tower", "strongest"], ["oak-tree", "strongest"]]) {
        const ctx = ctxOf(slug);
        const cc = SPEC.compileSpec(SL.presetSpec(chip, ctx.start), ctx);
        const rr = await OPT.optimize(ctx.occ, cc.config, { solve: solver.solve, material });
        if (rr.complete) assert.equal(singleMovesLeft(rr, cc, ctx), 0, `${slug} ${chip}`);
        if (rr.stop !== "converged") assert.equal(rr.complete, false, "complete belongs to a converged run");
    }
});

await test("a model already past the stress floor and the margin cap is left alone: no change for the tie-break alone (the review's OPT-10)", async () => {
    // a pyramid at 6 % of its strength and 496 mm of margin: nothing the goal counts can get better
    const ctx = ctxOf("step-pyramid");
    for (const chip of ["strongest", "most-stable"]) {
        const spec = SL.presetSpec(chip, ctx.start);
        const res = await OPT.optimize(ctx.occ, SPEC.compileSpec(spec, ctx, { maxSolves: 80 }).config, { solve: solver.solve, material });
        assert.equal(res.changed, false, `${chip}: ${res.removed.length} out, ${res.added.length} in`);
        assert.equal(res.feasible, true); assert.equal(res.stop, "converged"); assert.deepEqual([...res.occupancy], [...ctx.occ]);
    }
    // a goal that is not floored still moves: stiffest has sag to win
    const stiff = await OPT.optimize(ctx.occ, SPEC.compileSpec(SL.presetSpec("stiffest", ctx.start), ctx, { maxSolves: 80 }).config, { solve: solver.solve, material });
    assert.ok(stiff.end.maxDeflectionMm <= stiff.start.maxDeflectionMm);
    // the two parts of the objective: the goal never rises, and the tie-break is a part of the total
    const ref = { blocks0: 100, deflection0Mm: 1, uRef: 0.75, blockSizeMm: 100 };
    const terms = [{ metric: "peak_stress", weight: 1 }];
    const low = { blocks: 100, floating: 0, overLimit: 0, longestReach: 1, bodies: 1, cogMarginMm: 400, maxUtil: 0.06, maxDeflectionMm: 1, compliance: 1 };
    const lower = { ...low, maxUtil: 0.05 };
    assert.equal(EVAL.goalOf(low, terms, ref), EVAL.goalOf(lower, terms, ref), "below the floor the goal does not count the difference");
    assert.ok(EVAL.objectiveOf(lower, terms, ref) < EVAL.objectiveOf(low, terms, ref), "the total still prefers the lower stress");
});

await test("Stop is answered sooner: the 'before' figures are taken before the run, not after it (the review's OPT-7)", async () => {
    const r = L.loadStabilized("cantilever-house");
    const ctx = OA.specContextOf(r.descriptor, settings, solver, {});
    let solves = 0;
    const counting = { ...solver, solve: (model) => { solves++; return solver.solve(model); } };
    let atFirstPoll = -1;
    const run = await OA.optimizeAssembly(baseInput(r, SL.presetSpec("lightest", ctx.start)), { solver: counting, cancelled: () => { if (atFirstPoll < 0) atFirstPoll = solves; return true; } });
    assert.equal(run.result.stop, "canceled"); assert.equal(run.changed, false);
    // solves so far at the first look at the Stop flag: the start's figures, the "before" figures, the optimizer's own start. The "after" figures come after.
    assert.ok(atFirstPoll >= 3, `${atFirstPoll} solves had been made when Stop was first looked at`);
    assert.equal(solves, atFirstPoll + 1, "only the 'after' figures are left to measure after a Stop");
    const RO = await L.A("analysis/optimize/runOptimize");
    assert.ok(RO.STOP_GRACE_MS >= 5000, "a slow device on a big model gets time to answer");
});

await test("part names: no letter or digit matches nothing, a short name does not match by being inside another, a guess is said (the review's OPT-9)", () => {
    const ask = (part, names) => {
        const got = SL.repairSpec({ objective: [{ metric: "blocks", weight: 1 }], protected: [{ mode: "keep", part, box: null }] }, { partNames: names, blocks: 100 });
        return { spec: got.spec, changes: got.changes.filter((c) => !/No usable aim/.test(c)) };
    };
    // names in other scripts used to normalise to '' and match anything
    for (const [names, want] of [[["Seat", "座椅"], "Backrest"], [["座椅"], "seat"], [["Seat", "靠背", "座椅"], "Backrest"], [["(1)", "Seat"], "Backrest"]]) {
        const got = ask(want, names);
        assert.deepEqual(got.spec.protected, [], `${JSON.stringify(names)} asked ${want}`);
        assert.match(got.changes.join(" "), /There is no part called/);
    }
    // they can still be matched by their own letters, and accents and case do not matter
    assert.equal(ask("座椅", ["Seat", "座椅"]).spec.protected[0].part, "座椅");
    assert.equal(ask("nandu", ["Ñandú", "Seat"]).spec.protected[0].part, "Ñandú");
    assert.equal(ask("BACKREST", ["Seat", "Backrest"]).spec.protected[0].part, "Backrest");
    assert.deepEqual(ask("backrest", ["Seat", "Backrest"]).changes, [], "the same name is no guess");
    // one letter or two never find a part by being inside another name, in either direction
    assert.deepEqual(ask("a", ["Seat", "Legs"]).spec.protected, []);
    assert.deepEqual(ask("se", ["Seat", "Legs"]).spec.protected, []);
    assert.deepEqual(ask("Backrest", ["A", "Seat"]).spec.protected, []);
    // a real loose match still works and says it was a reading
    const loose = ask("seat", ["Seat cushion", "Backrest"]);
    assert.equal(loose.spec.protected[0].part, "Seat cushion");
    assert.deepEqual(loose.changes, ['"seat" was read as the part "Seat cushion".']);
    assert.deepEqual(ask("seat", ["Seat cushion", "Seat back"]).spec.protected, [], "two candidates: no guess");
    assert.equal(SL.matchPart("  BackREST ", ["Backrest", "Seat"]), "Backrest");
    assert.equal(SL.matchPart("   ", ["Seat"]), null);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
