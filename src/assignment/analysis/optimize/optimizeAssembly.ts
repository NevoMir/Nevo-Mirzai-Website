// The optimizer as the app uses it: a block assembly + a spec in, a new assembly + its log + the GLB bytes out.
// optimize.ts is the algorithm; this file wraps it the way stabilize.ts wraps search.ts:
//
//   assembly -> occupancy/roles -> compileSpec -> optimize -> descriptor (kept blocks keep their role and step, new ones are
//   "reinforcement" of the next step) -> measure before and after with the engine -> OptimizeMeta -> GLB (log inside)
//
// No DOM: the worker, the page's fallback and the Node scripts share it.

import { ASSEMBLY_BLOCK_MM, CELL_STRIDE, MAX_STEP, assemblyHash, parseAssemblyDescriptor, roleIndex, type AssemblyDescriptor } from "../../shared/assembly.ts";
import { writeAssemblyGlb } from "../../shared/assemblyGlb.ts";
import { MAX_DERIVED_DEPTH, type AnalysisSummary } from "../../shared/contract.ts";
import { OPTIMIZER_VERSION, type HistoryRow, type OptimizeMeta, type OptimizeMetrics } from "../../shared/optimizeMeta.ts";
import { MAX_PARTS, cleanGoal, cleanPartName } from "../../shared/optimizeSpec.ts";
import { materialOf } from "../materials.ts";
import { normalizeSettings } from "../settings.ts";
import { resilient } from "../stabilize/stabilize.ts";
import { cellCoords } from "../stabilize/grid.ts";
import { descriptorOfOccupancy, measure } from "../stabilize/measure.ts";
import type { SolverHandle } from "../stress.ts";
import type { AnalysisSettings } from "../types.ts";
import { CELLS, DIMS, createEvaluator, metricsOf } from "./evaluate.ts";
import { optimize } from "./optimize.ts";
import { compileSpec, hiddenInner, type Compiled, type OptimizationSpec, type SpecContext } from "./spec.ts";
import type { IterationRecord, Metrics, OptimizeEvent, OptimizeResult } from "./types.ts";

export { OPTIMIZER_VERSION };
export type { HistoryRow, OptimizeMeta, OptimizeMetrics };

/** A role the optimizer does not own: the block an edit made by words. It is not "added support" and counts as shape when it shows. */
const USER_ROLE = roleIndex("user");
const REINFORCEMENT = roleIndex("reinforcement");

export interface OptimizeInput {
    /** The version being optimized: its blocks, roles and steps. */
    assembly: AssemblyDescriptor;
    settings: AnalysisSettings;
    spec: OptimizationSpec;
    /** The person's words, or the label of the chip they clicked (1 to 300 characters): recorded with the result. */
    goal: string;
    /**
     * "blocks": the assembly is a saved block version (its cell hash is `source_hash`). "mesh": it is the voxelisation of an original
     * mesh (generated, example, edited design/mesh), which has no block hash: `source_hash` is null.
     */
    source: "blocks" | "mesh";
    /** Cells (indices (k * 10 + j) * 10 + i) of each named part, from the part labels; {} for a single-mesh model. Insertion order gives the letters. */
    parts: Record<string, number[]>;
    /** Stabilizations on the path from the root to the source (0 for a mesh). An optimization does not add one. */
    stabilizedDepth: number;
    maxIterations?: number;
    maxSolves?: number;
    timeBudgetMs?: number;
    /** Fixes created_at / duration_ms so the GLB is reproducible (tests, example build). */
    stamp?: { createdAt: string; durationMs: number };
}

export interface OptimizeRunResult {
    descriptor: AssemblyDescriptor;
    meta: OptimizeMeta;
    /** The assembly as a GLB with the log inside (scenes[0].extras["nevo:optimization"]); exactly what is uploaded. */
    glb: Uint8Array;
    result: OptimizeResult;
    compiled: Compiled;
    changed: boolean;
}

export interface OptimizeHost {
    solver: SolverHandle;
    onEvent?: (event: OptimizeEvent) => void;
    cancelled?: () => boolean;
    pause?: () => Promise<void>;
}

const round = (v: number, d: number): number => Math.round(v * 10 ** d) / 10 ** d;
const deflectionUm = (m: Metrics): number | null => (m.maxDeflectionMm === null ? null : m.maxDeflectionMm * 1000);
const codeOf = (c: number): number => {
    const [i, j, k] = cellCoords(DIMS, c);
    return k * 100 + j * 10 + i;
};

/** Untrusted or oversized parts -> at most 26 named (safe names), non-empty, valid cell lists, the names unique (the biggest parts are kept when there are more). */
export function cleanParts(parts: Record<string, ArrayLike<number>>): Record<string, number[]> {
    const rows: Array<{ name: string; cells: number[] }> = [];
    const seen = new Set<string>();
    for (const [raw, list] of Object.entries(parts)) {
        const name = cleanPartName(raw);
        if (!name || seen.has(name.toLowerCase())) continue;
        const cells: number[] = [];
        for (let n = 0; n < list.length; n++) {
            const c = list[n];
            if (Number.isInteger(c) && c >= 0 && c < CELLS) cells.push(c);
        }
        if (cells.length === 0) continue;
        seen.add(name.toLowerCase());
        rows.push({ name, cells: [...new Set(cells)].sort((a, b) => a - b) });
    }
    // More than 26: keep the parts that own the most cells, in their old order.
    const keep = rows.length <= MAX_PARTS ? rows : [...rows].sort((a, b) => b.cells.length - a.cells.length).slice(0, MAX_PARTS).sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
    const out: Record<string, number[]> = {};
    for (const row of keep) out[row.name] = row.cells;
    return out;
}

/** The occupancy, roles and steps of a descriptor, by cell index. */
export function unpack(desc: AssemblyDescriptor): { occ: Uint8Array; role: Uint8Array; step: Uint8Array } {
    const occ = new Uint8Array(CELLS);
    const role = new Uint8Array(CELLS);
    const step = new Uint8Array(CELLS);
    for (let n = 0; n < desc.cells.length; n += CELL_STRIDE) {
        const c = (desc.cells[n + 2] * DIMS.gy + desc.cells[n + 1]) * DIMS.gx + desc.cells[n];
        occ[c] = 1;
        role[c] = desc.cells[n + 3];
        step[c] = desc.cells[n + 4];
    }
    return { occ, role, step };
}

/** What the page needs before it can compile a spec: the start's figures (one geometry pass and one solve). */
export function specContextOf(desc: AssemblyDescriptor, settings: AnalysisSettings, solver: SolverHandle, parts: Record<string, number[]>): SpecContext {
    const { occ, role } = unpack(desc);
    const ev = createEvaluator({ solve: solver.solve, blockSizeMm: ASSEMBLY_BLOCK_MM, material: materialOf(settings.material).fem, cantileverLimit: settings.cantileverLimit });
    const geom = ev.geometry(occ);
    const field = geom.floatingCells === geom.count ? null : ev.field(occ);
    const cells: Record<string, Uint8Array> = {};
    for (const [name, list] of Object.entries(parts)) {
        const mask = new Uint8Array(CELLS);
        for (const c of list) if (c >= 0 && c < CELLS) mask[c] = 1;
        cells[name] = mask;
    }
    return { occ, role, parts: cells, cantileverLimit: settings.cantileverLimit, budget: settings.maxBlocks, start: metricsOf(geom, field) };
}

/** The figures of a state from the engine itself (analyzeAssembly + computeStress + applyStress): what the Stability tab shows for that version. */
function measured(occ: Uint8Array, settings: AnalysisSettings, solver: SolverHandle, deflectionUm: number | null): { metrics: OptimizeMetrics; summary: AnalysisSummary } {
    const m = measure(occ, null, { settings, solver, dims: DIMS });
    const kg = m.metrics.blocks * materialOf(settings.material).fem.rho * (ASSEMBLY_BLOCK_MM / 1000) ** 3;
    return {
        summary: m.summary,
        metrics: {
            blocks: m.metrics.blocks,
            weight_kg: round(kg, 1),
            errors: m.metrics.errors,
            warnings: m.metrics.warnings,
            floating_blocks: m.metrics.floating_blocks,
            over_limit: m.metrics.over_limit,
            longest_cantilever: m.metrics.longest_cantilever,
            cog_margin_mm: m.metrics.cog_margin_mm,
            max_utilisation: m.metrics.max_utilisation,
            max_deflection_um: deflectionUm === null ? null : round(deflectionUm, 3),
        },
    };
}

/**
 * One character per block of the result in canonical order: the part letter ('A' = first part) or '.'. The labels are inherited by cell
 * from the source: a block that was not there before (the optimizer's own) is '.', and the first part to list a cell owns it.
 */
function labelsOf(occ: Uint8Array, source: Uint8Array, names: readonly string[], parts: Record<string, number[]>): string {
    const owner = new Int8Array(CELLS).fill(-1);
    names.forEach((name, p) => {
        for (const c of parts[name]) if (owner[c] < 0) owner[c] = p;
    });
    let out = "";
    for (let c = 0; c < CELLS; c++) if (occ[c]) out += owner[c] < 0 || !source[c] ? "." : String.fromCharCode(65 + owner[c]);
    return out;
}

export async function optimizeAssembly(input: OptimizeInput, hostIn: OptimizeHost): Promise<OptimizeRunResult> {
    const host: OptimizeHost = { ...hostIn, solver: resilient(hostIn.solver) };
    const settings = normalizeSettings(input.settings);
    if (settings.blockSizeMm !== ASSEMBLY_BLOCK_MM) throw new RangeError(`The optimizer works with ${ASSEMBLY_BLOCK_MM} mm blocks.`);
    if (!Number.isInteger(input.stabilizedDepth) || input.stabilizedDepth < 0 || input.stabilizedDepth > MAX_DERIVED_DEPTH) throw new RangeError("The model's stabilization depth must be a whole number from 0 to " + MAX_DERIVED_DEPTH + ".");
    const goal = cleanGoal(input.goal).slice(0, 300);
    if (goal === "") throw new RangeError("The goal is empty.");
    const desc = parseAssemblyDescriptor(input.assembly);
    if (!desc) throw new RangeError("The assembly is not a valid block list.");
    if (!input.spec.actionable) throw new RangeError("The goal is not something the optimizer can work on.");

    const material = materialOf(settings.material).fem;
    const t0 = performance.now();
    const parts = cleanParts(input.parts);
    const names = Object.keys(parts);
    const ctx = specContextOf(desc, settings, host.solver, parts);
    const compiled = compileSpec(input.spec, ctx, { maxIterations: input.maxIterations, maxSolves: input.maxSolves, timeBudgetMs: input.timeBudgetMs });
    const { occ, role, step } = unpack(desc);
    host.onEvent?.({ kind: "start", start: ctx.start, effective: compiled.effective, warnings: compiled.warnings });
    // The "before" figures from the engine itself (analyzeAssembly + computeStress + applyStress), as the Stability tab shows them. They
    // depend on the start only, so they are taken now: after a Stop only the "after" figures are left to measure, and a big model is
    // answered in about half the time.
    const before = measured(occ, settings, host.solver, deflectionUm(ctx.start));
    const optimized = await optimize(occ, compiled.config, { solve: host.solver.solve, material, onEvent: host.onEvent, cancelled: host.cancelled, pause: host.pause });

    // The new assembly: every block that was there keeps its role and step, the new ones are reinforcement of the next step.
    let highest = 0;
    for (let c = 0; c < CELLS; c++) if (occ[c] && step[c] > highest) highest = step[c];
    const added = new Set(optimized.added);
    const nextStep = added.size > 0 ? highest + 1 : 0;
    if (nextStep > MAX_STEP) throw new RangeError("This version carries too many steps to add another.");
    const descriptor = descriptorOfOccupancy(optimized.occupancy, (c) => (added.has(c) ? [REINFORCEMENT, nextStep] : [role[c], step[c]]));

    // The outside shape changed iff a surface block of the source's own model (not a support the stabilizer added) is gone.
    const hidden = hiddenInner(occ);
    const shapeChanged = optimized.removed.some((c) => (role[c] === 0 || role[c] === USER_ROLE) && hidden[c] === 0);

    const after = measured(optimized.occupancy, settings, host.solver, deflectionUm(optimized.end));
    const result = holdToEngine(optimized, before.metrics.errors, after.metrics.errors);
    const createdAt = input.stamp ? input.stamp.createdAt : new Date().toISOString();
    const meta: OptimizeMeta = {
        version: 1,
        optimizer: OPTIMIZER_VERSION,
        solver: host.solver.backend === "wasm" ? "awatif-wasm" : "awatif-ts",
        material: settings.material,
        spec: input.spec,
        source_hash: input.source === "blocks" ? await assemblyHash(desc) : null,
        stabilized_depth: input.stabilizedDepth,
        goal,
        shape_changed: shapeChanged,
        parts: names,
        labels: labelsOf(result.occupancy, occ, names, parts),
        step: nextStep,
        ...removedByCode(result),
        added: result.added.length,
        added_at: result.addedAt,
        stop: result.stop,
        feasible: result.feasible,
        before: before.metrics,
        after: after.metrics,
        history: result.history.map(rowOf),
        solves: result.solves,
        duration_ms: input.stamp ? input.stamp.durationMs : Math.round(performance.now() - t0),
        assembly_hash: await assemblyHash(descriptor),
        // Stamped with the log's own date: the file then says one time, and a run with a fixed stamp gives the same bytes.
        after_summary: { ...after.summary, analyzed_at: createdAt },
        created_at: createdAt,
    };
    // A result that breaks a limit is shown (the card says why) but never written: the validator would refuse it.
    const glb = result.feasible ? writeAssemblyGlb(descriptor, null, null, meta) : writeAssemblyGlb(descriptor);
    return { descriptor, meta, glb, result, compiled, changed: result.changed };
}

/**
 * The safety net: the engine's own verdict outranks the optimizer's. A result the Stability tab would mark with more problems than the start
 * had (a limit the run was given that the tab does not share, or any future gap between the two) is never offered for keeping: it comes back
 * infeasible, with a note that says why. Anything else is returned as it is.
 */
export function holdToEngine(result: OptimizeResult, errorsBefore: number, errorsAfter: number): OptimizeResult {
    if (!result.feasible || errorsAfter <= errorsBefore) return result;
    const problems = errorsAfter === 1 ? "a problem" : `${errorsAfter} problems`;
    return { ...result, feasible: false, stop: "infeasible", complete: false, notes: [...result.notes, `The Stability tab would mark ${problems} in this result, so it cannot be kept.`] };
}

/** `removed` and `removed_at` ordered by cell code (k, j, i), which is not the cell index order of the lattice. */
function removedByCode(result: OptimizeResult): { removed: number[]; removed_at: number[] } {
    const pairs = result.removed.map((c, n) => ({ code: codeOf(c), at: result.removedAt[n] })).sort((a, b) => a.code - b.code);
    return { removed: pairs.map((p) => p.code), removed_at: pairs.map((p) => p.at) };
}

function rowOf(h: IterationRecord): HistoryRow {
    return [h.iteration, h.blocks, round(h.maxUtil ?? 0, 3), round(h.cogMarginMm ?? 0, 1), round((h.maxDeflectionMm ?? 0) * 1000, 3), round(h.objective, 4), h.removed, h.added, h.solves];
}
