// The analysis in a Web Worker, so a big model never blocks the page. runAnalysis.ts owns the other end.

import { analyzeGrid } from "./analyze.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { normalizeSettings } from "./settings.ts";
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

scope.onmessage = (event) => {
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

        let grid = request.gridKey !== null ? grids.get(request.gridKey) : undefined;
        if (grid && (grid.targetSizeMm !== settings.targetSizeMm || grid.blockSizeMm !== settings.blockSizeMm)) grid = undefined;
        if (!grid) {
            if (!request.positions) {
                scope.postMessage({ kind: "need-soup", id });
                return;
            }
            grid = voxelize({ positions: request.positions }, settings, onProgress);
        }
        // Not a grid made from nothing: a later request for the same model would get "No blocks" from it even
        // after the real triangles are available.
        if (request.gridKey !== null && grid.triangles.used > 0) remember(request.gridKey, grid);
        const result = analyzeGrid(grid, settings, { onProgress });
        scope.postMessage({ kind: "result", id, result });
    } catch (error) {
        scope.postMessage({ kind: "error", id, message: error instanceof Error && error.message ? error.message : "The analysis failed." });
    }
};
