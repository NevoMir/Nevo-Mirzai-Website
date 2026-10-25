// The two stages of an analysis in one place: the structural analysis (analyze.ts, assembly.ts), then the joint-stress
// estimate (stress.ts). The analysis worker, runAnalysis's main-thread fallback, and the stabilizer all
// go through here, so a result means the same wherever it was made.
//
// Loaded lazily by everything that is not the worker: it pulls in the FEM solver and its WebAssembly loader.

import { AWATIF_WASM_URL } from "./fem/wasmUrl.ts";
import { solveFrameTs } from "./fem/tsSolver.ts";
import type { AssemblyDescriptor } from "../shared/assembly.ts";
import { analyzeAssembly, type Bounds } from "./assembly.ts";
import { WASM_LOAD_MS, applyStress, computeStress, loadSolver, loadSolverWithin, stressUnavailable, type SolverHandle } from "./stress.ts";
import type { AnalysisResult, AnalysisSettings } from "./types.ts";

export interface StressOptions {
    /**
     * The solver to use: skips loading Awatif's WASM (the TypeScript solver gives the same numbers to 1e-6, which is what
     * the tests and the example builder compare against).
     */
    solver?: SolverHandle;
    /** Where lSolver.wasm is, when not at the bundled default (fem/wasmUrl.ts). Used only by the first load. */
    wasmUrl?: string;
}

const TS_SOLVER: SolverHandle = { solve: solveFrameTs, backend: "ts" };

// One solver per thread (page, worker): loading the module compiles 250 KB of WebAssembly, which is done once.
// loadSolver never rejects: it proves the module on a tiny model and answers with the TypeScript solver if that fails.
// It does not time out by itself, so a stalled download is cut off after WASM_LOAD_MS: the thread then uses the TypeScript
// solver (the stalled promise is not kept), and switches to the WASM one if it turns up later.
let shared: Promise<SolverHandle> | null = null;

/** The thread's Awatif solver, loaded on first use. `load` and `timeoutMs` are for tests. */
export function sharedSolver(wasmUrl: string = AWATIF_WASM_URL, load: (url: string) => Promise<SolverHandle> = loadSolver, timeoutMs: number = WASM_LOAD_MS): Promise<SolverHandle> {
    if (shared) return shared;
    const mine: Promise<SolverHandle> = loadSolverWithin(
        () => load(wasmUrl),
        timeoutMs,
        (handle) => {
            // Only if nobody has reset or replaced the solver since (a reset starts a load of its own).
            if (shared === mine) shared = Promise.resolve(handle);
        },
    );
    shared = mine;
    return mine;
}

/** Forgets the loaded solver (the next call loads it again). For tests. */
export function resetSharedSolver(): void {
    shared = null;
}

/**
 * The result with the stress estimate in it. Never throws: when the solver fails on both backends the structural result
 * comes back with an "info" row "Stress could not be estimated", so a stress failure cannot take the analysis down.
 */
export async function withStress(result: AnalysisResult, options: StressOptions = {}): Promise<AnalysisResult> {
    try {
        const handle = options.solver ?? (await sharedSolver(options.wasmUrl));
        const stress = computeStress(result, handle);
        // The WASM module aborted during this run and computeStress finished it on the TypeScript solver: the module is
        // dead for good, so later runs use the TypeScript solver straight away instead of failing once more first.
        if (stress && !options.solver && stress.solver.backend !== handle.backend) shared = Promise.resolve(TS_SOLVER);
        return applyStress(result, stress);
    } catch {
        return stressUnavailable(result);
    }
}

/**
 * Analyses a block assembly (no voxelising) and estimates its stress. `soup`: the bounds of the GLB's triangles in the
 * viewer's frame, or null for a headless analysis. `frame`: the assembly those bounds belong to, when `desc` is only a
 * part of it (for instance the original blocks of a stabilized model, analysed on their own).
 */
export async function analyzeAssemblyWithStress(
    desc: AssemblyDescriptor,
    soup: Bounds | null,
    settings: Partial<AnalysisSettings> = {},
    frame: AssemblyDescriptor = desc,
    options: StressOptions = {},
): Promise<AnalysisResult> {
    return withStress(analyzeAssembly(desc, soup, settings, frame), options);
}
