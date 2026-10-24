// The analysis entry points (pure TypeScript, no DOM): triangles -> voxels -> structure -> issues.

import type { AnalysisResult, AnalysisSettings, AnalysisTransform, TriangleSoup, Vec3 } from "./types.ts";
import { normalizeSettings } from "./settings.ts";
import { voxelize } from "./voxelize.ts";
import type { ProgressFn, VoxelGrid } from "./voxelize.ts";
import { analyzeStructure } from "./structure.ts";
import { buildChecks, buildIssues, buildSummary } from "./issues.ts";

export interface AnalyzeOptions {
    onProgress?: ProgressFn;
}

/** Soup -> full result. `settings` may be partial; missing values take the defaults. */
export function analyze(soup: TriangleSoup, settings: Partial<AnalysisSettings> = {}, options: AnalyzeOptions = {}): AnalysisResult {
    const normalized = normalizeSettings(settings);
    const grid = voxelize(soup, normalized, options.onProgress);
    return analyzeGrid(grid, normalized, options);
}

/**
 * Re-evaluates a voxelised model. Everything except the scale and the block size can change without voxelising
 * again (fill threshold, cantilever limit, budget), so the UI can update instantly when a setting moves.
 */
export function analyzeGrid(grid: VoxelGrid, settings: Partial<AnalysisSettings> = {}, options: AnalyzeOptions = {}): AnalysisResult {
    const normalized = normalizeSettings(settings);
    if (normalized.targetSizeMm !== grid.targetSizeMm || normalized.blockSizeMm !== grid.blockSizeMm) {
        throw new Error("The voxel grid was built for a different target size or block size; voxelise again.");
    }
    const started = performance.now();
    options.onProgress?.(0.92, "analyze");
    const structure = analyzeStructure(grid, normalized);
    const issues = buildIssues(structure, grid, normalized);
    const checks = buildChecks(structure, normalized);
    const summary = buildSummary(structure, issues, grid, normalized);
    options.onProgress?.(1, "analyze");
    return {
        settings: normalized,
        gridSize: grid.gridSize,
        transform: grid.transform,
        sizeMm: grid.sizeMm,
        blocks: structure.blocks,
        bodies: structure.bodies,
        cantilevers: structure.cantilevers,
        stability: structure.stability,
        issues,
        checks,
        stats: structure.stats,
        summary,
        timingsMs: { voxelize: grid.voxelizeMs, analyze: performance.now() - started },
    };
}

/** Analysis millimetres -> the model's own coordinates (what the loaded GLB uses). */
export function toModelSpace(mm: Vec3, t: AnalysisTransform): Vec3 {
    return [(mm[0] - t.offsetMm[0]) / t.factor + t.modelMin[0], (mm[1] - t.offsetMm[1]) / t.factor + t.modelMin[1], (mm[2] - t.offsetMm[2]) / t.factor + t.modelMin[2]];
}

/** A point of the model (in the soup's coordinates) -> analysis millimetres. */
export function toAnalysisMm(p: Vec3, t: AnalysisTransform): Vec3 {
    return [(p[0] - t.modelMin[0]) * t.factor + t.offsetMm[0], (p[1] - t.modelMin[1]) * t.factor + t.offsetMm[1], (p[2] - t.modelMin[2]) * t.factor + t.offsetMm[2]];
}
