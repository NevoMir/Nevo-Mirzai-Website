// The optimizer's contract: what it is given (a compiled OptimizeConfig), what it reports while it runs, what it returns.
//
//   spec.ts       compileSpec: the user-facing OptimizationSpec (shared/optimizeSpec.ts: what Muse Spark writes and the page edits) -> OptimizeConfig
//   evaluate.ts   one state of the assembly -> metrics (geometry: grid.ts; stress, deflection, strain energy: one Awatif solve)
//   optimize.ts   the algorithm (BESO-style batches, exact validation, halving backtracking, a single-move sweep at the end)
//
// A PURE FUNCTION of (occupancy, config, solver): no randomness, no network, no clock in any decision except the time budget,
// which only ever stops it early. Every sort breaks ties by cell index, so the same input gives the same blocks, the same
// history and the same assembly hash on every machine and with either solver backend (comparisons use a relative tolerance
// of 1e-7, so the 1e-10 difference between Awatif's WASM and the TypeScript solver cannot flip a tie).

import { METRIC_KEYS } from "../../shared/optimizeSpec.ts";
import type { MetricKey, Symmetry } from "../../shared/optimizeSpec.ts";
import type { StopReason } from "../../shared/optimizeMeta.ts";
import type { Effective } from "./spec.ts";

export type { StopReason };

export { METRIC_KEYS };
export type { MetricKey, Symmetry };

/** One term of the objective J = sum(weight * f(metric)). All four are "smaller f is better" after the normalisation below. */
export interface ObjectiveTerm {
    metric: MetricKey;
    /** > 0; the terms are normalised to sum to 1 by compileSpec. */
    weight: number;
}

/** The constraints, compiled to numbers the loop can compare. null = not constrained. */
export interface Limits {
    /** Highest joint utilisation allowed (0.75 = 75 % of the allowable, the report's warning level). */
    maxUtil: number | null;
    /** Smallest centre-of-gravity margin allowed [mm] (weakest free-standing structure). */
    minMarginMm: number | null;
    /** Longest cantilever allowed [blocks]; the engine's own rule, normally the analysis setting. */
    cantileverLimit: number;
    maxBlocks: number;
    minBlocks: number;
    /** Largest deflection allowed [mm]; null = no limit. */
    maxDeflectionMm: number | null;
    /** Most free-standing structures allowed (1 when keep_connected and the start is one piece). */
    maxBodies: number;
}

export interface OptimizeConfig {
    terms: ObjectiveTerm[];
    limits: Limits;
    allowRemove: boolean;
    allowAdd: boolean;
    /** Per cell index: 1 = the block may be taken out. */
    canRemove: Uint8Array;
    /** Per cell index: 1 = a block may be put here. */
    canAdd: Uint8Array;
    symmetry: Symmetry;
    /** Stop as soon as the block count is at or under this (e.g. "30 % lighter"); null = no such target. */
    stopAtBlocks: number | null;
    maxIterations: number;
    /** Most FEM solves; the deterministic budget. */
    maxSolves: number;
    /** Wall-clock safety net; a run that hits it has stop = "time-budget" and is not reproducible. */
    timeBudgetMs: number;
    blockSizeMm: number;
    /** BESO evolution ratio: share of the blocks one iteration may take out (default 0.05). For tuning and the ablation tests. */
    evolutionRatio?: number;
    /** Most orbits in one batch (default 24). 1 = plain greedy, one block per solve. */
    maxBatch?: number;
    /** Weight of the stress / strain-energy hint relative to the exact centre-of-gravity gain when ranking cells to add (default 0.1). */
    addMeritScale?: number;
}

/** The figures of a state, as the Stability tab reports them. */
export interface Metrics {
    blocks: number;
    floating: number; // blocks in floating structures
    overLimit: number; // blocks beyond the cantilever limit
    longestReach: number;
    bodies: number; // free-standing structures
    cogMarginMm: number | null;
    maxUtil: number | null; // null: nothing stands on the ground
    maxDeflectionMm: number | null;
    /** sum of the end forces times the displacements, N m (twice the strain energy); a stiffness measure at the same load */
    compliance: number | null;
}

/** One row of the convergence chart: the state after an accepted iteration (iteration 0 = the start). */
export interface IterationRecord {
    iteration: number;
    blocks: number;
    maxUtil: number | null;
    cogMarginMm: number | null;
    maxDeflectionMm: number | null;
    /** Objective value J (smaller is better) and the violation it was accepted with (0 = feasible). */
    objective: number;
    violation: number;
    removed: number; // blocks taken out by this iteration's accepted move
    added: number;
    /** Candidate batches tried for this iteration (>= 1; the first ones that broke a constraint are the backtracking). */
    attempts: number;
    solves: number; // cumulative
    elapsedMs: number;
}

export type OptimizeEvent =
    /** First event of a run: the exact figures of the start and what the spec compiled to (the page shows them while the chart is still empty). */
    | { kind: "start"; start: Metrics; effective: Effective; warnings: string[] }
    | { kind: "progress"; phase: "evaluating"; iteration: number; solves: number; blocks: number; elapsedMs: number }
    | { kind: "iteration"; record: IterationRecord; removedCells: number[]; addedCells: number[] };

export interface OptimizeResult {
    /** The final occupancy (1000 cells, index (k*10+j)*10+i). */
    occupancy: Uint8Array;
    removed: number[]; // cell indices of the start's blocks that are gone, ascending
    added: number[]; // cell indices of blocks that were not there, ascending
    /** The iteration (1-based) that took out / put in each of `removed` / `added`, same order: the replay slider of the page. */
    removedAt: number[];
    addedAt: number[];
    start: Metrics;
    end: Metrics;
    history: IterationRecord[];
    stop: StopReason;
    /**
     * Only meaningful when `stop` is "converged": true when the last sweep tried every single change (every block that may go, the
     * best-ranked cells to fill) and none helped, so "no single block can change" is a fact; false when the sweep gave up first
     * (diminishing returns, patience) and the claim would be too strong. Not saved in the log.
     */
    complete: boolean;
    /** All constraints hold in `occupancy`. */
    feasible: boolean;
    /** The blocks differ from the start. */
    changed: boolean;
    solves: number;
    elapsedMs: number;
    /** Plain sentences about things the run had to ignore or could not do. */
    notes: string[];
}
