// The analysis in a Web Worker, so a big model never blocks the page. runAnalysis.ts owns the other end.
//
// Two stages: the structural analysis (a mesh is voxelised first; a block assembly is read from its cells), then the
// stress estimate with Awatif's WebAssembly solver (withStress.ts). The solver is loaded once per worker.

import { analyzeGrid } from "./analyze.ts";
import { annotateRoles, gridFromAssembly, parseBounds } from "./assembly.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { normalizeSettings } from "./settings.ts";
import type { AnalysisResult } from "./types.ts";
import { parseAssemblyDescriptor } from "../shared/assembly.ts";
import { withStress } from "./withStress.ts";
import { voxelize } from "./voxelize.ts";
import type { AnalysisStage, VoxelGrid } from "./voxelize.ts";

// The app's tsconfig has the DOM lib, not the WebWorker one, so describe the little of the scope that is used.
interface WorkerScope {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse): void;
}
const scope = self as unknown as WorkerScope;

/** The last few voxelised models, least recently used first. */
const GRID_CACHE_SIZE = 3;
const grids = new Map<string, VoxelGrid>();

function remember(key: string, grid: VoxelGrid): void {
    grids.delete(key);
    grids.set(key, grid);
    while (grids.size > GRID_CACHE_SIZE) {
        const oldest = grids.keys().next().value;
        if (oldest === undefined) break;
        grids.delete(oldest);
    }
}

/** The structural analysis ends at this share of the bar; the stress estimate fills the rest. */
const STRESS_FROM = 0.96;

scope.onmessage = async (event) => {
    const request = event.data;
    if (request.kind !== "run") return;
    const { id } = request;
    try {
        const settings = normalizeSettings(request.settings);
        // At most one progress message per 40 ms (and always the stage changes), so the page is not flooded.
        let lastPost = 0;
        let lastStage = "";
        const onProgress = (fraction: number, step: AnalysisStage) => {
            const now = Date.now();
            if (step === lastStage && now - lastPost < 40) return;
            lastStage = step;
            lastPost = now;
            scope.postMessage({ kind: "progress", id, step, fraction });
        };
        // The bar must not reach 100 % before the stress stage has run.
        const onAnalyzeProgress = (fraction: number, step: AnalysisStage) => onProgress(Math.min(fraction, STRESS_FROM), step);

        let result: AnalysisResult;
        if (request.assembly) {
            // A stabilized model: the cells are the blocks. Checked here too, because the grid is built by indexing with them.
            const assembly = parseAssemblyDescriptor(request.assembly);
            if (!assembly) throw new Error("The block assembly is not valid.");
            const frame = request.frame ? parseAssemblyDescriptor(request.frame) : null;
            if (request.frame && !frame) throw new Error("The block assembly's frame is not valid.");
            const grid = gridFromAssembly(assembly, parseBounds(request.soupBounds), settings, frame ?? assembly);
            result = annotateRoles(analyzeGrid(grid, settings, { onProgress: onAnalyzeProgress }), assembly);
        } else {
            let grid = request.gridKey !== null ? grids.get(request.gridKey) : undefined;
            if (grid && (grid.targetSizeMm !== settings.targetSizeMm || grid.blockSizeMm !== settings.blockSizeMm)) grid = undefined;
            if (!grid) {
                if (!request.positions) {
                    scope.postMessage({ kind: "need-soup", id });
                    return;
                }
                grid = voxelize({ positions: request.positions }, settings, onAnalyzeProgress);
            }
            // Not a grid made from nothing: a later request for the same model would get "No blocks" from it even
            // after the real triangles are available.
            if (request.gridKey !== null && grid.triangles.used > 0) remember(request.gridKey, grid);
            result = analyzeGrid(grid, settings, { onProgress: onAnalyzeProgress });
        }

        onProgress(STRESS_FROM, "stress");
        // Never throws: a failure of the solver leaves the structural result with an info row (withStress.ts).
        result = await withStress(result, { wasmUrl: request.wasmUrl });
        onProgress(1, "stress");
        scope.postMessage({ kind: "result", id, result });
    } catch (error) {
        scope.postMessage({ kind: "error", id, message: error instanceof Error && error.message ? error.message : "The analysis failed." });
    }
};
