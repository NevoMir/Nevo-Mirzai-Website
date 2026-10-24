// Messages between runAnalysis.ts (page) and analysis.worker.ts. Types only, so both sides share one contract.

import type { AnalysisResult, AnalysisSettings } from "./types.ts";
import type { AnalysisStage } from "./voxelize.ts";

export interface RunRequest {
    kind: "run";
    id: number;
    /**
     * Identifies the voxelised model (model + target + block size). The worker keeps the last few grids, so a
     * change of fill threshold, cantilever limit or budget re-uses one and `positions` can be null.
     */
    gridKey: string | null;
    positions: Float32Array | null;
    settings: AnalysisSettings;
}

export type WorkerRequest = RunRequest;

export type WorkerResponse =
    | { kind: "progress"; id: number; step: AnalysisStage; fraction: number }
    | { kind: "result"; id: number; result: AnalysisResult }
    | { kind: "error"; id: number; message: string }
    /** The worker no longer has the grid for `gridKey` and the request carried no triangles: send them. */
    | { kind: "need-soup"; id: number };
