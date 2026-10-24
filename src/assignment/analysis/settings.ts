// Settings sanity: every entry point (analyze, runAnalysis, the worker) funnels user-supplied settings through
// normalizeSettings so the rest of the engine can rely on finite, in-range numbers.

import { DEFAULT_ANALYSIS_SETTINGS } from "./types.ts";
import { MATERIAL_IDS } from "../shared/contract.ts";
import type { AnalysisSettings } from "./types.ts";

/**
 * Most fine cells per axis the voxeliser accepts (160^3 cells, ~4 MB of state). The number of blocks per axis that
 * allows depends on the cells per block (maxGridSize): 13 blocks at 12 cells each. The task uses 10.
 */
export const MAX_FINE_CELLS = 160;
/** The server only stores summaries whose cantilever limit is 1..10 (worker/analysis.ts). */
export const MAX_CANTILEVER_LIMIT = 10;

const positive = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

/** Fills in defaults and clamps; never throws. */
export function normalizeSettings(input: Partial<AnalysisSettings> = {}): AnalysisSettings {
    const d = DEFAULT_ANALYSIS_SETTINGS;
    const threshold = typeof input.fillThreshold === "number" && Number.isFinite(input.fillThreshold) ? input.fillThreshold : d.fillThreshold;
    const limit = typeof input.cantileverLimit === "number" && Number.isFinite(input.cantileverLimit) ? Math.floor(input.cantileverLimit) : d.cantileverLimit;
    let maxBlocks: number | null = d.maxBlocks;
    if (input.maxBlocks === null) maxBlocks = null;
    else if (typeof input.maxBlocks === "number" && Number.isFinite(input.maxBlocks)) maxBlocks = Math.max(1, Math.floor(input.maxBlocks));
    return {
        targetSizeMm: positive(input.targetSizeMm, d.targetSizeMm),
        blockSizeMm: positive(input.blockSizeMm, d.blockSizeMm),
        fillThreshold: Math.min(1, Math.max(0, threshold)),
        cantileverLimit: Math.min(MAX_CANTILEVER_LIMIT, Math.max(1, limit)),
        maxBlocks,
        material: MATERIAL_IDS.includes(input.material as never) ? (input.material as AnalysisSettings["material"]) : d.material,
    };
}

/** Blocks per axis: the smallest grid that covers the target volume. */
export function gridSizeFor(settings: AnalysisSettings): number {
    // The epsilon keeps 1000 / 100 at exactly 10 despite float noise.
    return Math.max(1, Math.ceil(settings.targetSizeMm / settings.blockSizeMm - 1e-9));
}

/** Most blocks per axis that fit in MAX_FINE_CELLS when each block is split into `subdivision` cells per edge. */
export function maxGridSize(subdivision: number): number {
    return Math.max(1, Math.floor(MAX_FINE_CELLS / subdivision));
}

/** Throws a RangeError (with a message fit for the UI) when the settings would need an enormous grid. */
export function assertGridSize(settings: AnalysisSettings, subdivision: number): number {
    const size = gridSizeFor(settings);
    const most = maxGridSize(subdivision);
    if (size > most) {
        throw new RangeError(`The block size is too small for the target volume: ${size} blocks per side (at most ${most}).`);
    }
    return size;
}
