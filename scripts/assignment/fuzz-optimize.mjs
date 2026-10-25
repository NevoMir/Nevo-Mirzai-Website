// Random specs against the optimizer: every run must keep the invariants, whatever the spec says.
//   node scripts/assignment/fuzz-optimize.mjs [runs per seed = 94] [seed ...]      (default: 3 seeds x 94 = 282 runs, about 5 minutes)
//
// Invariants (a failure prints the spec that broke them):
//   - the removed blocks were removable and the added cells addable (the masks), nothing is removed with removal off or added with adding off
//   - the violations never get worse than the start's, and a feasible start stays feasible
//   - a feasible result passes the official pipeline (analyzeAssembly + computeStress + applyStress) with 0 errors, and 0 warnings when the
//     stress limit is at most 75 %; the block budget, the strength and balance limits, the number of free-standing structures and the symmetry hold
//   - every 6th run is repeated and gives the same blocks (deterministic)
//   - every 12th run goes through optimizeAssembly: the log it writes is accepted by checkOptimizeMeta and agrees with the cells
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const L = await import("./optimize-lib.mjs");
const { SPEC, OPT, EVAL, OA, SL, MC } = L;

const solver = await L.getSolver();
const settings = L.settingsMod.normalizeSettings({});
const material = L.mats.materialOf("concrete").fem;
const N = Number(process.argv[2] ?? 94);
const seeds = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [12345, 777, 2024];
const heavy = new Set(["step-pyramid", "mushroom-pavilion"]);
const cache = {};
let totalFail = 0, totalRan = 0;

for (const seed0 of seeds) {
    let seed = seed0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    let fail = 0, ran = 0, infeasible = 0, changed = 0;
    const stats = { stop: {} };
    for (let n = 0; n < N; n++) {
        const slug = pick(L.SLUGS.filter((s) => !heavy.has(s) || rnd() < 0.25));
        const r = (cache[slug] ??= L.loadStabilized(slug));
        const ctx = (cache[slug + "ctx"] ??= OA.specContextOf(r.descriptor, settings, solver, {}));
        const metrics = ["blocks", "peak_stress", "cog_margin", "deflection"].filter(() => rnd() < 0.45);
        if (!metrics.length) metrics.push(pick(["blocks", "peak_stress", "cog_margin", "deflection"]));
        const ws = metrics.map(() => 0.1 + rnd());
        const box = () => { const a = [0, 0, 0].map(() => Math.floor(rnd() * 10)), b = [0, 0, 0].map(() => Math.floor(rnd() * 10)); return { min: a.map((v, i) => Math.min(v, b[i])), max: a.map((v, i) => Math.max(v, b[i])) }; };
        const raw = {
            actionable: true, title: "fuzz", summary: "fuzz",
            objective: metrics.map((m, i) => ({ metric: m, weight: ws[i] })),
            moves: { allow: pick(["remove", "add", "both"]), removable: pick(["added", "inner", "any"]) },
            constraints: {
                max_stress_pct: rnd() < 0.5 ? null : 40 + rnd() * 60, min_cog_margin_mm: rnd() < 0.5 ? null : rnd() * 200, max_cantilever_blocks: rnd() < 0.8 ? null : 2 + Math.floor(rnd() * 4),
                max_blocks: rnd() < 0.8 ? null : ctx.start.blocks + Math.floor(rnd() * 40) - 10, max_added_blocks: rnd() < 0.5 ? null : Math.floor(rnd() * 30), min_blocks_pct: rnd() < 0.6 ? null : 40 + rnd() * 60,
                max_deflection_pct: rnd() < 0.8 ? null : 50 + rnd() * 150, keep_one_piece: rnd() < 0.85, symmetry: rnd() < 0.8 ? "none" : pick(["x", "y", "xy"]),
            },
            protected: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ mode: pick(["keep", "clear", "only"]), part: null, box: box() })),
            stop: { reduce_blocks_by_pct: rnd() < 0.8 ? null : 5 + rnd() * 30 }, notes: [],
        };
        const { spec } = SL.repairSpec(raw, SPEC.repairContextOf(ctx));
        const c = SPEC.compileSpec(spec, ctx, { maxSolves: 120, timeBudgetMs: 20000 });
        const startOcc = ctx.occ;
        const res = await OPT.optimize(startOcc, c.config, { solve: solver.solve, material });
        ran++; stats.stop[res.stop] = (stats.stop[res.stop] ?? 0) + 1;
        if (!res.feasible) infeasible++;
        if (res.changed) changed++;
        const problems = [];
        const lim = c.config.limits;
        for (const cell of res.removed) if (!c.config.canRemove[cell]) problems.push(`removed protected cell ${cell}`);
        for (const cell of res.added) if (!c.config.canAdd[cell]) problems.push(`added in a forbidden cell ${cell}`);
        if (!c.config.allowRemove && res.removed.some((cell) => !res.added.includes(cell)) && res.removed.length) problems.push("removed with removal off: " + res.removed.length);
        if (!c.config.allowAdd && res.added.length) problems.push("added with adding off: " + res.added.length);
        const refOf = { blocks0: res.start.blocks, deflection0Mm: res.start.maxDeflectionMm ?? 1, uRef: lim.maxUtil ?? 0.75, blockSizeMm: 100 };
        const startViol = EVAL.violationsOf(res.start, lim, refOf, true);
        const endViol = EVAL.violationsOf(res.end, lim, refOf, true);
        if (EVAL.compareViolations(endViol, startViol) > 0) problems.push(`violations got worse ${JSON.stringify(startViol)} -> ${JSON.stringify(endViol)}`);
        if (EVAL.isFeasible(startViol) && !res.feasible) problems.push("start was feasible, result is not");
        if (res.feasible) {
            const v = await L.official(res.occupancy);
            if (v.summary.errors > 0) problems.push(`official errors ${v.summary.errors}: ${v.issues.filter((i) => i.severity === "error").map((i) => i.kind).join(",")}`);
            // the official analysis uses the Stability tab's own 4-block overhang limit; a looser one in the spec is allowed to show up there
            if (lim.maxUtil !== null && lim.maxUtil <= 0.75 && lim.cantileverLimit <= 4 && v.summary.warnings > 0) problems.push(`official warnings ${v.summary.warnings}`);
            if (res.end.blocks > lim.maxBlocks || res.end.blocks < lim.minBlocks) problems.push(`budget broken ${res.end.blocks} not in [${lim.minBlocks}, ${lim.maxBlocks}]`);
            if (lim.maxUtil !== null && res.end.maxUtil > lim.maxUtil + 1e-7) problems.push(`stress ${res.end.maxUtil} > ${lim.maxUtil}`);
            if (lim.minMarginMm !== null && res.end.cogMarginMm < lim.minMarginMm - 1e-6) problems.push(`margin ${res.end.cogMarginMm} < ${lim.minMarginMm}`);
            if (res.end.bodies > lim.maxBodies) problems.push(`bodies ${res.end.bodies} > ${lim.maxBodies}`);
        }
        if (c.config.symmetry !== "none" && res.changed) {
            if (!SPEC.symmetriesOf(res.occupancy).includes(c.config.symmetry)) problems.push("symmetry lost " + c.config.symmetry);
        }
        if (n % 6 === 0) {
            const again = await OPT.optimize(startOcc, c.config, { solve: solver.solve, material });
            if (!again.occupancy.every((v, i) => v === res.occupancy[i])) problems.push("not deterministic");
        }
        if (n % 12 === 0 && res.feasible && spec.actionable) {
            const run = await OA.optimizeAssembly({ assembly: r.descriptor, settings, spec, goal: "fuzz", source: "blocks", parts: {}, stabilizedDepth: 1, maxSolves: 120, timeBudgetMs: 20000 }, { solver });
            if (run.meta.feasible) {
                const checked = MC.checkOptimizeMeta(JSON.parse(JSON.stringify(run.meta)), null);
                if (!checked.ok) problems.push("log refused: " + checked.error);
                else {
                    const bad = MC.crossCheckOptimized(run.descriptor, checked.value, { kind: "stabilized", assembly_hash: await L.asm.assemblyHash(r.descriptor) });
                    if (bad) problems.push("log disagrees with the cells: " + bad);
                    const back = L.glb.readAssemblyGlb(run.glb);
                    if (!back.ok || !back.optimization) problems.push("the GLB lost its log");
                }
            }
        }
        if (problems.length) { fail++; console.log(`FAIL seed ${seed0} #${n} ${slug}`, JSON.stringify({ allow: spec.moves, obj: spec.objective.map((t) => t.metric), c: spec.constraints, prot: spec.protected }), problems); }
    }
    console.log(`fuzz seed ${seed0}: ${ran} runs, ${fail} failures, ${changed} changed the model, ${infeasible} ended infeasible (the start already broke a limit), stops ${JSON.stringify(stats.stop)}`);
    totalFail += fail; totalRan += ran;
}
console.log(`fuzz total: ${totalRan} runs, ${totalFail} failures`);
process.exit(totalFail ? 1 : 0);
