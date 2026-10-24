// What the stabilizer logs about a state of the assembly, taken from the engine itself: the cells go through the same
// analyzeAssembly + computeStress + applyStress the Analysis tab runs, so a step's "errors 3 -> 2" and "peak 198% -> 72%" are
// exactly what the report shows for that version. The stress solve is not repeated: the stabilizer already solved this state
// (it needed the field to choose its next move), so computeStress is handed that solution (stressAdapter.replayOf).

import { ASSEMBLY_BLOCK_MM, ASSEMBLY_GRID, DEFAULT_INSET, type AssemblyDescriptor } from "../../shared/assembly.ts";
import type { AnalysisSummary, StabilizationMetrics } from "../../shared/contract.ts";
import { analyzeAssembly } from "../assembly.ts";
import { STRESS_WARN } from "../materials.ts";
import { applyStress, computeStress, type SolverHandle } from "../stress.ts";
import type { AnalysisSettings } from "../types.ts";
import type { Dims } from "./grid.ts";
import { replayOf } from "./stressAdapter.ts";
import type { StressField } from "./stressAdapter.ts";

export interface Measured {
    /** What is logged: rounded like the summary, so it reads the same in the log, the card and the JSON report. */
    metrics: StabilizationMetrics;
    summary: AnalysisSummary;
    /** Unrounded, for the comparisons the loop makes (a rounding step must never decide whether a move helped). */
    raw: { cogMarginMm: number | null; maxUtil: number | null };
}

export interface MeasureEnv {
    settings: AnalysisSettings;
    solver: SolverHandle;
    dims: Dims;
    /** The stress level the run aims for (default and cap: STRESS_WARN); see max_utilisation below. */
    target?: number;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
/** MAX_UTIL of the DerivedMeta validator. */
const UTIL_CAP = 50;

/** The canonical descriptor of the occupied cells. `roleAt(cell index)` gives the [role index, step] of a block. */
export function descriptorOfOccupancy(occ: Uint8Array, roleAt: (cell: number) => readonly [number, number]): AssemblyDescriptor {
    const cells: number[] = [];
    const plane = ASSEMBLY_GRID * ASSEMBLY_GRID;
    for (let c = 0; c < occ.length; c++) {
        if (!occ[c]) continue;
        const k = Math.floor(c / plane);
        const r = c - k * plane;
        const j = Math.floor(r / ASSEMBLY_GRID);
        const [role, step] = roleAt(c);
        cells.push(r - j * ASSEMBLY_GRID, j, k, role, step); // ascending cell index is the canonical order (k, then j, then i)
    }
    return { version: 1, blockSizeMm: ASSEMBLY_BLOCK_MM, grid: [ASSEMBLY_GRID, ASSEMBLY_GRID, ASSEMBLY_GRID], inset: DEFAULT_INSET, cells };
}

/** The engine's figures for a state. `field`: the stress solution of exactly this state (null: nothing stands on the ground). */
export function measure(occ: Uint8Array, field: StressField | null, env: MeasureEnv): Measured {
    const desc = descriptorOfOccupancy(occ, () => [0, 0]);
    const base = analyzeAssembly(desc, null, env.settings);
    const stress = computeStress(base, replayOf(field, env.solver), env.settings.material);
    const result = applyStress(base, stress);
    const s = result.summary;
    const maxUtil = stress ? stress.maxUtilisation : null;
    // Blocks with no load path to the ground are not solved, so while any float the peak is that of the grounded part alone:
    // a lamp with 26 of 44 blocks floating "peaks" at 0 %, and "0 % -> 52 %" would read as the fix making it worse. Below the
    // level the checks warn at, the figure is unknown (null); above it, it is a true lower bound and stays. `raw.maxUtil`
    // keeps the number the search compares.
    const unknown = maxUtil !== null && s.floating_blocks > 0 && maxUtil < Math.min(env.target ?? STRESS_WARN, STRESS_WARN);
    return {
        metrics: {
            blocks: s.blocks,
            errors: s.errors,
            warnings: s.warnings,
            floating_blocks: s.floating_blocks,
            over_limit: s.over_limit,
            longest_cantilever: s.longest_cantilever,
            cog_margin_mm: result.stability ? s.cog_margin_mm : null,
            max_utilisation: maxUtil === null || unknown ? null : Math.min(UTIL_CAP, round3(maxUtil)),
            overstressed_blocks: stress ? stress.overstressedBlocks : 0,
        },
        summary: s,
        raw: { cogMarginMm: result.stability ? result.stability.marginMm : null, maxUtil },
    };
}
