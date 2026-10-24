// The stabilizer's contract with the rest of the app: what it is given, what it reports while it runs, what it returns.
//
//   search.ts        the algorithm: which move to try next (floating parts, reach, centre of gravity, joint stress)
//   stabilize.ts     around it: the input -> the descriptor, the log (describe.ts sentences), the DerivedMeta and the GLB
//   stabilize.worker.ts + runStabilize.ts   the Web Worker that runs it and the promise (progress, AbortSignal) the page calls
//
// The stabilizer is a PURE FUNCTION of (cells, settings, options): no randomness, no network, and no clock in any decision
// (the one exception is the time budget, which only ever stops it early). The same input gives the same blocks, the same
// log and the same assembly_hash on every machine and with either solver backend (scores are compared with a relative
// tolerance of 1e-7, so the 1e-10 difference between Awatif's WASM and the TypeScript solver cannot flip a tie). With
// `options.stamp` it also gives the same GLB bytes, which is what lets the bundled examples be rebuilt and checked.

import type { AddedRole, DerivedMeta, StabilizeStepLog, StabilizeStop, StabilizationMetrics, StepMetrics } from "../../shared/contract.ts";
import type { AssemblyDescriptor } from "../../shared/assembly.ts";
import { STRESS_WARN } from "../materials.ts";
import type { AnalysisSettings } from "../types.ts";

/** Stress level the loop tries to get under: the warning level of the report. */
export const DEFAULT_TARGET_UTILISATION = STRESS_WARN; // a stabilized design carries no stress warning

/**
 * The highest target a run accepts (higher ones are lowered to it): a run that stops above the warning level still has a stress
 * warning, so it could not honestly be "complete" ("passes all checks"). The Options slider's range should end here too.
 */
export const MAX_TARGET_UTILISATION = STRESS_WARN;

/** DerivedMeta.stabilizer: the version of the algorithm. Bump it when a change can alter the blocks it picks. */
export const STABILIZER_VERSION = "1.0.0";

/** The centre of gravity is brought at least this far inside the support base (the report only warns below 1 mm). */
export const COG_TARGET_MM = 100;

export interface StabilizeOptions {
    /**
     * Stop when the highest joint stress is at or under this share of the allowable (and nothing fails). 0.1 up to
     * MAX_TARGET_UTILISATION (the stress warning level): a higher value is lowered to it, and the log records the one used.
     */
    targetUtilisation: number;
    /**
     * Never end up with more blocks than this (the caller passes settings.maxBlocks, else the 1000 cells of the grid). The
     * search also keeps to three quarters of the given blocks, at least 24, as a safeguard against a hopeless model. A run
     * that stops at this budget has stop = "max-blocks"; one that stops at the safeguard has "no-improving-move".
     */
    maxBlocks: number;
    /**
     * At most this many accepted moves. A run is clamped to 45: the log (up to 300 characters a move) has to fit the 32 KB
     * the saved metadata may take (MAX_STABILIZE_STEPS = 60 is the contract's limit), and a model that needs more is better
     * stabilized again from the result (depth 2) than in one very long list.
     */
    maxSteps: number;
    /**
     * Stop after this long and return the best so far (stop = "time-budget"). The search, the clean-up and the replay of the
     * log after it all keep to it, within the one step they are in: a replay that runs out of time keeps the moves as made.
     * (The search's own work limit of 400 evaluations ends a run with stop = "max-steps", not "time-budget".)
     */
    timeBudgetMs: number;
    /**
     * Fixes the two things in the result that come from the clock (log.created_at, log.duration_ms, and the analysed_at of
     * the stored summary), so the GLB is byte for byte reproducible. The example build uses it; the app leaves it out.
     */
    stamp?: { createdAt: string; durationMs: number };
}

export const DEFAULT_STABILIZE_OPTIONS: Omit<StabilizeOptions, "maxBlocks"> = {
    targetUtilisation: DEFAULT_TARGET_UTILISATION,
    maxSteps: 40,
    timeBudgetMs: 30_000,
};

/** The analysed model's blocks, as the stabilizer takes them (an AnalysisResult's cells). */
export interface StabilizeInput {
    cells: Array<[number, number, number]>;
    /** The analysis settings in force: cantilever limit, fill threshold (recorded in the log), material, budget. */
    settings: AnalysisSettings;
    options: StabilizeOptions;
    /**
     * Set when the model is itself a stabilized one (AnalysisResult.assembly.descriptor): its blocks are the "original"
     * of this run, so none is removed or moved, and the descriptor of the result keeps the role and step each of them
     * had. Its blocks must be exactly `cells`. Absent for a generated or example model (every block is "original").
     */
    assembly?: AssemblyDescriptor | null;
}

/**
 * While it runs. `step` messages carry the move just accepted; `progress` ones are sent at most ten times a second.
 *
 * A `step` is the move as it was made. When the clean-up at the end of the run takes blocks out of earlier moves (the
 * columns that a later spread of legs made redundant), the final log in StabilizeResult.meta.steps is the one that describes
 * the blocks that are left (renumbered 1..n, figures measured again), so it replaces the steps seen on the way. The same
 * holds when a move that changed none of the figures its sentence quotes is folded into the move that did (stabilize.ts
 * foldInert): the final log has fewer, renumbered rows over the same blocks.
 */
export type StabilizeEvent =
    | { kind: "progress"; phase: "evaluating"; candidatesDone: number; candidatesTotal: number; steps: number; blocks: number; elapsedMs: number }
    | {
          kind: "step";
          step: StabilizeStepLog;
          /** The cells it added, for the live preview, with the role of each (same order). */
          cells: Array<[number, number, number]>;
          roles: AddedRole[];
          /** Blocks in the assembly after this move. */
          blocks: number;
          elapsedMs: number;
      };

export interface StabilizeResult {
    /**
     * The stabilized assembly: the given blocks exactly as they were (role and step included) and the added ones with the
     * role they play and the step that added them. Step n of the log (1-based, as `meta.steps[n - 1].n`) is the `step` of its
     * blocks plus the highest step among the given blocks (0 for a generated or example model; after a stabilized model,
     * `assembly.steps` of its analysis), so a block's step identifies its move in a model that was stabilized more than once.
     */
    descriptor: AssemblyDescriptor;
    /** The log that goes into the GLB and into models.meta. */
    meta: DerivedMeta;
    /** The GLB (shared/assemblyGlb.ts writeAssemblyGlb(descriptor, meta)), ready to upload; transferred out of the worker. */
    glb: Uint8Array;
    before: StabilizationMetrics;
    after: StabilizationMetrics;
    stop: StabilizeStop;
    /**
     * No errors left (the engine's count, as the Analysis tab shows it) and stress under the target, which is never above the
     * warning level (MAX_TARGET_UTILISATION), so no stress warning either: save it without asking. The centre of gravity may
     * still be short of its 100 mm design margin (stop then says why: max-blocks, no-improving-move).
     */
    complete: boolean;
    addedByRole: Partial<Record<AddedRole, number>>;
}

// ---------- worker messages ----------

export interface StabilizeRequest {
    kind: "stabilize";
    id: number;
    input: StabilizeInput;
    /** The model the cells came from: 0 for a generated or example model, else the source's DerivedMeta.depth (the log records depth + 1). */
    sourceDepth: number;
    /** The URL of lSolver.wasm (Vite's `?url` import), so the worker can load Awatif's solver; absent: the TypeScript solver. */
    wasmUrl?: string;
}

export type StabilizeResponse =
    | { kind: "event"; id: number; event: StabilizeEvent }
    | { kind: "done"; id: number; result: StabilizeResult }
    | { kind: "error"; id: number; message: string };

// ---------- the measure of a move ----------

type ProblemFigures = Pick<StepMetrics, "floating_blocks" | "over_limit" | "cog_margin_mm" | "max_utilisation">;

/**
 * What is wrong with a state, most important first: floating blocks, blocks beyond the cantilever limit, how far the centre
 * of gravity is outside the base (tipping), stress above the target, the centre of gravity short of its margin. Smaller is
 * better in every place. The same order the search fixes them in, and the order of the rule below.
 */
export function problemsOf(m: ProblemFigures, target: number): [number, number, number, number, number] {
    const margin = m.cog_margin_mm;
    return [
        m.floating_blocks,
        m.over_limit,
        margin === null ? 0 : Math.max(0, 1 - margin),
        m.max_utilisation === null ? 0 : Math.max(0, m.max_utilisation - target),
        margin === null ? 0 : Math.max(0, COG_TARGET_MM - margin),
    ];
}

/**
 * Is `after` worse than `before`? Decided by the first problem (in the order above) that changed by more than `tolerance`
 * (stress and distances are measured, so a change in the sixth digit is not a change). A move may leave a less important
 * problem worse, as joining a floating part to the ground can raise the stress there; it may never trade a more important
 * one for it. This is the gate every move of the search passes, and what the tests check of every step of a log.
 */
export function isWorse(after: ProblemFigures, before: ProblemFigures, target: number, tolerance = 1e-6): boolean {
    const a = problemsOf(after, target);
    const b = problemsOf(before, target);
    for (let n = 0; n < a.length; n++) {
        if (a[n] > b[n] + tolerance) return true;
        if (a[n] < b[n] - tolerance) return false;
    }
    return false;
}

/**
 * All the problems as one number (errors count most), to show how big they are. Not what a move is judged by (that is isWorse):
 * joining a floating part to the ground can raise this number when the join creates a stressed joint, and is still progress.
 */
export function problemCost(m: ProblemFigures & Pick<StepMetrics, "errors">, target: number): number {
    const [floating, over, , excess, deficit] = problemsOf(m, target);
    return 1000 * m.errors + 4 * floating + 3 * over + deficit / 5 + 1000 * Math.min(excess, 5);
}
