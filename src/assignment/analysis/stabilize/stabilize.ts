// The stabilizer as the app uses it: cells in, a stabilized assembly out (its descriptor, the log, the GLB bytes, before/after).
// The search itself (which block to add next) is search.ts; this file wraps it:
//
//   input checks -> search -> [clean-up, replayed so the log still describes the blocks that are left] -> descriptor
//   -> measure the result with the engine -> DerivedMeta (shared/derivedMeta.ts) -> GLB (shared/assemblyGlb.ts)
//
// Nothing here touches the DOM, so the worker, the page's fallback and the Node scripts (tests, example build) share it.

import type { AddedRole, AnalysisSummary, DerivedMeta, StabilizationMetrics, StabilizeStepLog, StabilizeStop, StepMetrics } from "../../shared/contract.ts";
import { MAX_DERIVED_DEPTH, MAX_STABILIZE_STEPS } from "../../shared/contract.ts";
import { ASSEMBLY_BLOCK_MM, ASSEMBLY_GRID, CELL_STRIDE, assemblyHash, parseAssemblyDescriptor, roleIndex, type AssemblyDescriptor } from "../../shared/assembly.ts";
import { writeAssemblyGlb } from "../../shared/assemblyGlb.ts";
import { FemError, solveFrameTs } from "../fem/index.ts";
import type { FrameModel, FrameSolution } from "../fem/index.ts";
import { materialOf } from "../materials.ts";
import { normalizeSettings } from "../settings.ts";
import { loadSolver, loadSolverWithin } from "../stress.ts";
import type { SolverHandle } from "../stress.ts";
import type { AnalysisSettings } from "../types.ts";
import { describeStep } from "./describe.ts";
import type { StepContext } from "./describe.ts";
import { NB6, cellCoords, cellIndex, inGrid } from "./grid.ts";
import type { Dims } from "./grid.ts";
import { descriptorOfOccupancy, measure } from "./measure.ts";
import type { Measured, MeasureEnv } from "./measure.ts";
import { moveOf, search } from "./search.ts";
import type { Phase, SearchEvent, SearchStep, StepNote } from "./search.ts";
import { makeStressSolver } from "./stressAdapter.ts";
import type { StressSolver } from "./stressAdapter.ts";
import { COG_TARGET_MM, DEFAULT_STABILIZE_OPTIONS, MAX_TARGET_UTILISATION, STABILIZER_VERSION, isWorse } from "./types.ts";
import type { StabilizeEvent, StabilizeInput, StabilizeResult } from "./types.ts";

/** How a run is hosted. */
export interface StabilizeRun {
    /** The stress solver (analysis/stress.ts loadSolver): Awatif's WASM, or its TypeScript twin. */
    solver: SolverHandle;
    onEvent?: (event: StabilizeEvent) => void;
    /** Polled between moves; true stops the run (the result then has stop = "canceled"). */
    cancelled?: () => boolean;
    /**
     * Awaited between pieces of work, so a run on the page's own thread can paint and answer Stop. Left out in the worker,
     * which runs straight through.
     */
    pause?: () => Promise<void>;
}

/**
 * Most moves one run makes: the log (at most 300 characters a move) has to fit the 32 KB the saved metadata may take, and a
 * model that needs more than this is better stabilized again from the result (depth 2) than in one very long list.
 */
const MAX_RUN_STEPS = 45;

/**
 * Awatif's WASM solver from `wasmUrl`; without one, when it does not load, or when loading it hangs (stress.ts WASM_LOAD_MS),
 * the TypeScript solver, which gives the same answers (to 1e-10), only slower on big models.
 */
export async function loadStabilizerSolver(wasmUrl?: string): Promise<SolverHandle> {
    if (!wasmUrl) return { solve: solveFrameTs, backend: "ts" };
    return loadSolverWithin(() => loadSolver(wasmUrl));
}

const DIMS: Dims = { gx: ASSEMBLY_GRID, gy: ASSEMBLY_GRID, gz: ASSEMBLY_GRID };
const CELLS = ASSEMBLY_GRID ** 3;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 1): number => Math.round(v * 10 ** digits) / 10 ** digits;
const metricsOfStep = (m: StabilizationMetrics): StepMetrics => ({
    blocks: m.blocks,
    errors: m.errors,
    floating_blocks: m.floating_blocks,
    over_limit: m.over_limit,
    longest_cantilever: m.longest_cantilever,
    cog_margin_mm: m.cog_margin_mm,
    max_utilisation: m.max_utilisation,
});

// ---------- preparing a run ----------

interface Prepared {
    settings: AnalysisSettings;
    target: number;
    maxBlocks: number;
    maxSteps: number;
    timeBudgetMs: number;
    depth: number;
    stamp: { createdAt: string; durationMs: number } | null;
    /** 1 where a block was given. */
    occupancy: Uint8Array;
    /** Role index and step of every given block (as it was in the source), by cell index. */
    given: Map<number, readonly [number, number]>;
    /** Highest step among the given blocks: the steps of this run are numbered after them in the descriptor. */
    stepOffset: number;
    /** Resilient: a WASM module that aborts mid-run is replaced by the TypeScript solver, as computeStress does. */
    handle: SolverHandle;
    solve: StressSolver;
    env: MeasureEnv;
}

/** A solver handle that falls back to the TypeScript solver for good if the WASM one throws (the module is dead then). */
function resilient(real: SolverHandle): SolverHandle {
    let backend = real.backend;
    return {
        get backend() {
            return backend;
        },
        solve(model: FrameModel): FrameSolution {
            if (backend === "ts") return real.backend === "ts" ? real.solve(model) : solveFrameTs(model);
            try {
                return real.solve(model);
            } catch (error) {
                // A singular system fails in the TypeScript solver too; that error is the caller's.
                if (error instanceof FemError && error.status === 1) throw error;
                backend = "ts";
                return solveFrameTs(model);
            }
        },
    };
}

function prepare(input: StabilizeInput, sourceDepth: number, run: StabilizeRun): Prepared {
    const settings = normalizeSettings(input.settings);
    if (settings.blockSizeMm !== ASSEMBLY_BLOCK_MM) throw new RangeError(`The stabilizer works with ${ASSEMBLY_BLOCK_MM} mm blocks.`);
    if (!Number.isInteger(sourceDepth) || sourceDepth < 0) throw new RangeError("The model's stabilization depth must be a whole number from 0.");
    if (sourceDepth + 1 > MAX_DERIVED_DEPTH) throw new RangeError("This version has been stabilized the maximum number of times.");
    if (input.cells.length === 0) throw new RangeError("There are no blocks to stabilize.");

    const occupancy = new Uint8Array(CELLS);
    for (const cell of input.cells) {
        const [i, j, k] = cell;
        if (![i, j, k].every((v) => Number.isInteger(v) && v >= 0 && v < ASSEMBLY_GRID)) throw new RangeError(`Cell (${i}, ${j}, ${k}) is outside the ${ASSEMBLY_GRID} x ${ASSEMBLY_GRID} x ${ASSEMBLY_GRID} grid.`);
        const c = cellIndex(DIMS, i, j, k);
        if (occupancy[c]) throw new RangeError(`Cell (${i}, ${j}, ${k}) is listed twice.`);
        occupancy[c] = 1;
    }

    // The given blocks' roles and steps: from the source's descriptor, else every block is an original (role 0, step 0).
    const given = new Map<number, readonly [number, number]>();
    let stepOffset = 0;
    const desc = input.assembly ? parseAssemblyDescriptor(input.assembly) : null;
    if (input.assembly && !desc) throw new RangeError("The assembly is not a valid block list.");
    if (desc) {
        if (desc.cells.length / CELL_STRIDE !== input.cells.length) throw new RangeError("The assembly and the cells are not the same blocks.");
        for (let n = 0; n < desc.cells.length; n += CELL_STRIDE) {
            const c = cellIndex(DIMS, desc.cells[n], desc.cells[n + 1], desc.cells[n + 2]);
            if (!occupancy[c]) throw new RangeError("The assembly and the cells are not the same blocks.");
            given.set(c, [desc.cells[n + 3], desc.cells[n + 4]]);
            stepOffset = Math.max(stepOffset, desc.cells[n + 4]);
        }
    } else {
        for (let c = 0; c < CELLS; c++) if (occupancy[c]) given.set(c, [0, 0]);
    }

    const o = input.options;
    const handle = resilient(run.solver);
    const solve = makeStressSolver({ solve: (model) => handle.solve(model), blockSizeMm: ASSEMBLY_BLOCK_MM, material: materialOf(settings.material).fem });
    const stamp = o.stamp ? { createdAt: new Date(o.stamp.createdAt).toISOString(), durationMs: clamp(Math.round(o.stamp.durationMs), 0, 3_600_000) } : null;
    // Never above the warning level: "complete" must mean there is no stress warning left either.
    const target = clamp(Number.isFinite(o.targetUtilisation) ? o.targetUtilisation : DEFAULT_STABILIZE_OPTIONS.targetUtilisation, 0.1, MAX_TARGET_UTILISATION);
    return {
        settings,
        target,
        maxBlocks: clamp(Math.floor(Number.isFinite(o.maxBlocks) ? o.maxBlocks : (settings.maxBlocks ?? CELLS)), 0, CELLS),
        maxSteps: clamp(Math.floor(Number.isFinite(o.maxSteps) ? o.maxSteps : DEFAULT_STABILIZE_OPTIONS.maxSteps), 0, Math.min(MAX_RUN_STEPS, MAX_STABILIZE_STEPS)),
        timeBudgetMs: Number.isFinite(o.timeBudgetMs) ? Math.max(0, o.timeBudgetMs) : DEFAULT_STABILIZE_OPTIONS.timeBudgetMs,
        depth: sourceDepth + 1,
        stamp,
        occupancy,
        given,
        stepOffset,
        handle,
        solve,
        env: { settings, solver: handle, dims: DIMS, target },
    };
}

// ---------- the log ----------

/** A move as it is logged: what the search accepted, with the numbers measured before and after it. */
interface LoggedMove {
    n: number;
    phase: Phase;
    move: AddedRole;
    cells: number[];
    roles: AddedRole[];
    note: StepNote;
    before: Measured;
    after: Measured;
    /** The cells the move is "at" in the log, when it is a move with others folded into it (see foldInert): its own. */
    focus?: number[];
}

const REASON = { floating: "floating", reach: "cantilever", cog: "cog", stress: "stress" } as const;

function logOf(p: Prepared, m: LoggedMove): StabilizeStepLog {
    const sum: [number, number, number] = [0, 0, 0];
    const here = m.focus ?? m.cells;
    for (const c of here) {
        const [i, j, k] = cellCoords(DIMS, c);
        sum[0] += (i + 0.5) * ASSEMBLY_BLOCK_MM;
        sum[1] += (j + 0.5) * ASSEMBLY_BLOCK_MM;
        sum[2] += (k + 0.5) * ASSEMBLY_BLOCK_MM;
    }
    const at: [number, number, number] = [round(sum[0] / here.length), round(sum[1] / here.length), round(sum[2] / here.length)];
    const before = metricsOfStep(m.before.metrics);
    const after = metricsOfStep(m.after.metrics);
    const ctx: StepContext = {
        move: m.move,
        reason: REASON[m.phase],
        added: m.cells.length,
        parts: piecesOf(m.cells, m.move),
        // A floating part is told by its own height; the blocks that join it are mostly lower.
        atMm: m.phase === "floating" && m.note.partHeightMm !== undefined ? [at[0], at[1], m.note.partHeightMm] : at,
        target: m.note.target,
        before,
        after,
        limit: p.settings.cantileverLimit,
        partBlocks: m.note.partBlocks,
        trigger: m.note.trigger,
        side: m.note.side,
        cell: m.note.hotCell,
    };
    return { n: m.n, move: m.move, reason: REASON[m.phase], added: m.cells.length, text: describeStep(ctx), at_mm: at, before, after };
}

/** Separate pieces a move makes: columns standing side by side count one each, otherwise 6-connected groups of blocks. */
function piecesOf(cells: number[], move: AddedRole): number {
    if (move === "column") return new Set(cells.map((c) => cellCoords(DIMS, c).slice(0, 2).join())).size;
    const left = new Set(cells);
    let pieces = 0;
    for (const start of cells) {
        if (!left.delete(start)) continue;
        pieces++;
        const stack = [start];
        while (stack.length) {
            const [i, j, k] = cellCoords(DIMS, stack.pop() as number);
            for (const [di, dj, dk] of NB6) {
                if (!inGrid(DIMS, i + di, j + dj, k + dk)) continue;
                const n = cellIndex(DIMS, i + di, j + dj, k + dk);
                if (left.delete(n)) stack.push(n);
            }
        }
    }
    return pieces;
}

const coordsOf = (cells: number[]): Array<[number, number, number]> => cells.map((c) => cellCoords(DIMS, c));

// ---------- the result ----------

/** What assemble() needs: the moves that stand, in order, and where the run started and ended. */
interface Plan {
    moves: LoggedMove[];
    occ: Uint8Array;
    start: Measured;
    end: Measured;
}

async function assemble(p: Prepared, plan: Plan, stop: StabilizeStop, t0: number): Promise<StabilizeResult> {
    const { moves, occ, start, end } = plan;
    // The descriptor: given blocks as they were, added ones with their role and the step number after the given ones.
    const added = new Map<number, { role: AddedRole; step: number }>();
    for (const m of moves) m.cells.forEach((c, q) => added.set(c, { role: m.roles[q], step: m.n }));
    const descriptor: AssemblyDescriptor = descriptorOfOccupancy(occ, (c) => {
        const g = p.given.get(c);
        if (g) return g;
        const a = added.get(c) as { role: AddedRole; step: number };
        return [roleIndex(a.role), p.stepOffset + a.step];
    });

    const addedByRole: Partial<Record<AddedRole, number>> = {};
    for (const a of added.values()) addedByRole[a.role] = (addedByRole[a.role] ?? 0) + 1;
    const complete = end.metrics.errors === 0 && (end.raw.maxUtil === null || end.raw.maxUtil <= p.target + 1e-9);
    // "stable" says the checks pass; if the engine still counts an error the loop could not see, say so instead.
    const finalStop: StabilizeStop = stop === "stable" && !complete ? "no-improving-move" : stop;

    const createdAt = p.stamp ? p.stamp.createdAt : new Date().toISOString();
    const afterSummary: AnalysisSummary = { ...end.summary, analyzed_at: createdAt };
    const meta: DerivedMeta = {
        version: 1,
        depth: p.depth,
        stabilizer: STABILIZER_VERSION,
        solver: p.handle.backend === "wasm" ? "awatif-wasm" : "awatif-ts",
        material: p.settings.material,
        target_utilisation: p.target,
        cantilever_limit: p.settings.cantileverLimit,
        fill_threshold: p.settings.fillThreshold,
        complete,
        stop: finalStop,
        added_blocks: added.size,
        added_by_role: addedByRole,
        before: start.metrics,
        after: end.metrics,
        steps: moves.map((m) => logOf(p, m)),
        duration_ms: p.stamp ? p.stamp.durationMs : Math.round(performance.now() - t0),
        assembly_hash: await assemblyHash(descriptor),
        after_summary: afterSummary,
        created_at: createdAt,
    };
    const glb = writeAssemblyGlb(descriptor, meta);
    return { descriptor, meta, glb, before: start.metrics, after: end.metrics, stop: finalStop, complete, addedByRole };
}

/** Moves in the search's own form (before the clean-up): their numbers were measured as they were made. */
const asMoves = (steps: SearchStep[]): LoggedMove[] => steps.map((s) => ({ n: s.n, phase: s.phase, move: s.move, cells: s.cells, roles: s.roles, note: s.note, before: s.before, after: s.after }));

/** Do the moves still read true in order: each one leaves things no worse and the problem it was made for was still there? */
function reads(p: Prepared, moves: LoggedMove[]): boolean {
    const figures = (m: Measured) => ({ floating_blocks: m.metrics.floating_blocks, over_limit: m.metrics.over_limit, cog_margin_mm: m.raw.cogMarginMm, max_utilisation: m.raw.maxUtil });
    return moves.every((m) => {
        if (isWorse(figures(m.after), figures(m.before), p.target)) return false;
        const b = m.before;
        switch (m.phase) {
            case "floating":
                return b.metrics.floating_blocks > 0;
            case "reach":
                return b.metrics.over_limit > 0;
            case "cog":
                return b.raw.cogMarginMm !== null && b.raw.cogMarginMm < COG_TARGET_MM - 1e-6;
            case "stress":
                return b.raw.maxUtil !== null && b.raw.maxUtil > p.target + 1e-9;
        }
    });
}

/** Do the figures a move's sentence quotes stay the same, as the log shows them (whole %, whole mm)? */
function changesNothing(m: LoggedMove): boolean {
    const b = m.before.metrics;
    const a = m.after.metrics;
    const shown = (v: number | null, scale: number): number | null => (v === null ? null : Math.round(v * scale));
    return (
        a.errors === b.errors &&
        a.floating_blocks === b.floating_blocks &&
        a.over_limit === b.over_limit &&
        a.longest_cantilever === b.longest_cantilever &&
        shown(a.max_utilisation, 100) === shown(b.max_utilisation, 100) &&
        shown(a.cog_margin_mm, 1) === shown(b.cog_margin_mm, 1)
    );
}

/**
 * A move that changes none of the figures its sentence quotes ("peak stress 141% -> 141%") is folded into the move that does
 * something: the blocks stay, so the assembly is the same, but the log no longer has a row that cites a number it did not move.
 * It comes about when the clean-up trims part of a compound plan, or when the search takes a move that only helps its smooth
 * score. It goes into the next move that changes something (the effect shows there), else into the one before. A log in which
 * no move changes anything is left alone. Renumbers the moves 1..n.
 */
function foldInert(moves: LoggedMove[]): LoggedMove[] {
    const joined = (parts: LoggedMove[], lead: LoggedMove): LoggedMove => {
        const roles = parts.flatMap((part) => part.roles);
        return {
            n: lead.n,
            phase: lead.phase,
            move: moveOf(roles),
            cells: parts.flatMap((part) => part.cells),
            roles,
            note: lead.note,
            before: parts[0].before,
            after: parts[parts.length - 1].after,
            focus: lead.focus ?? lead.cells, // where the reason is: the move that did something, not the ones folded into it
        };
    };
    const out: LoggedMove[] = [];
    let waiting: LoggedMove[] = [];
    for (const m of moves) {
        if (changesNothing(m)) {
            waiting.push(m);
            continue;
        }
        out.push(waiting.length > 0 ? joined([...waiting, m], m) : m);
        waiting = [];
    }
    if (out.length === 0) return moves;
    if (waiting.length > 0) out[out.length - 1] = joined([out[out.length - 1], ...waiting], out[out.length - 1]);
    return out.map((m, q) => ({ ...m, n: q + 1 }));
}

/**
 * The clean-up took blocks out of earlier moves, so the figures measured as those moves were made no longer describe the
 * states in between. Replays what is left (move by move, solving each state) and returns the moves with fresh figures;
 * null when the result no longer reads as a sequence of improvements, or when the time budget (`deadline`, on the
 * performance clock) runs out first: then the unpruned run is kept.
 */
async function replay(
    p: Prepared,
    run: StabilizeRun,
    steps: SearchStep[],
    removed: Set<number>,
    start: Measured,
    deadline: number,
): Promise<{ moves: LoggedMove[]; occ: Uint8Array; end: Measured } | null> {
    const kept = steps
        .map((s) => {
            const idx = s.cells.map((_, q) => q).filter((q) => !removed.has(s.cells[q]));
            return { s, cells: idx.map((q) => s.cells[q]), roles: idx.map((q) => s.roles[q]) };
        })
        .filter((k) => k.cells.length > 0);
    const moves: LoggedMove[] = [];
    const occ = Uint8Array.from(p.occupancy);
    let before = start;
    for (const [q, k] of kept.entries()) {
        await run.pause?.();
        // Every step is a solve (up to half a second on 1000 blocks), so the budget is checked here like in the search.
        if (performance.now() > deadline) return null;
        for (const c of k.cells) occ[c] = 1;
        const field = p.solve(occ, DIMS);
        const after = measure(occ, field.solved > 0 ? field : null, p.env);
        moves.push({ n: q + 1, phase: k.s.phase, move: moveOf(k.roles), cells: k.cells, roles: k.roles, note: k.s.note, before, after });
        before = after;
    }
    return reads(p, moves) ? { moves, occ, end: before } : null;
}

// ---------- entry points ----------

/**
 * Stabilizes the model: adds the blocks it needs and returns the new assembly with its log and GLB. `sourceDepth` is 0 for a
 * generated or example model, else the source's DerivedMeta.depth. Throws RangeError for input that cannot be stabilized.
 */
export async function stabilize(input: StabilizeInput, sourceDepth: number, run: StabilizeRun): Promise<StabilizeResult> {
    const t0 = performance.now();
    const p = prepare(input, sourceDepth, run);
    const emit = (event: SearchEvent): void => {
        if (!run.onEvent) return;
        const elapsedMs = Math.round(performance.now() - t0);
        if (event.kind === "progress") {
            run.onEvent({ kind: "progress", phase: "evaluating", candidatesDone: event.candidatesDone, candidatesTotal: event.candidatesTotal, steps: event.steps, blocks: event.blocks, elapsedMs });
        } else {
            const s = event.step;
            run.onEvent({ kind: "step", step: logOf(p, asMoves([s])[0]), cells: coordsOf(s.cells), roles: s.roles, blocks: event.blocks, elapsedMs });
        }
    };
    const deadline = performance.now() + p.timeBudgetMs;
    const gen = search({
        dims: DIMS,
        occupancy: p.occupancy,
        cantileverLimit: p.settings.cantileverLimit,
        blockSizeMm: ASSEMBLY_BLOCK_MM,
        target: p.target,
        maxBlocks: p.maxBlocks,
        maxSteps: p.maxSteps,
        timeBudgetMs: p.timeBudgetMs,
        solve: p.solve,
        env: p.env,
        onEvent: emit,
        cancelled: run.cancelled,
    });
    let r = gen.next();
    while (!r.done) {
        if (run.pause) await run.pause();
        r = gen.next();
    }
    const outcome = r.value;

    let plan: Plan = { moves: asMoves(outcome.steps), occ: outcome.occ, start: outcome.start, end: outcome.end };
    if (outcome.removed.length > 0) {
        const removed = new Set(outcome.removed);
        const replayed = await replay(p, run, outcome.steps, removed, outcome.start, deadline);
        if (replayed) plan = { moves: replayed.moves, occ: replayed.occ, start: outcome.start, end: replayed.end };
        else {
            // Keep the moves as made: the blocks the clean-up would have saved stay.
            const occ = outcome.occ.slice();
            for (const c of removed) occ[c] = 1;
            plan = { moves: plan.moves, occ, start: outcome.start, end: outcome.end };
        }
    }
    return assemble(p, { ...plan, moves: foldInert(plan.moves) }, outcome.stop, t0);
}
