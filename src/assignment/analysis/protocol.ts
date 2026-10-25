// Messages between runAnalysis.ts (page) and analysis.worker.ts. Types only, so both sides share one contract.

import type { AssemblyDescriptor } from "../shared/assembly.ts";
import type { Bounds } from "./assembly.ts";
import type { AnalysisResult, AnalysisSettings, AnalysisTransform, Vec3 } from "./types.ts";
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
    /**
     * A block assembly (a stabilized model). The grid is built from its cells, never voxelised, so `positions` is
     * null and `gridKey` is not used: the descriptor travels with every request (it is a few KB and building the grid
     * from it takes microseconds, so there is nothing worth caching).
     */
    assembly?: AssemblyDescriptor | null;
    /** The bounds of the GLB's triangles in the viewer's frame (sets the result's transform); null: a headless frame. */
    soupBounds?: Bounds | null;
    /**
     * The transform of the SOURCE mesh the blocks are drawn over (a stabilized model shown on the model it was made from):
     * the result's transform as it is. When it is set, `soupBounds` and `frame` are not used.
     */
    sourceTransform?: AnalysisTransform | null;
    /** With `sourceTransform`: the scaled bounding box of that mesh, which is the result's size (else the lattice's own extent is). */
    sourceSizeMm?: Vec3 | null;
    /** The assembly `soupBounds` belong to, when `assembly` is only a part of it (for instance the original blocks of a stabilized model, analysed on their own). */
    frame?: AssemblyDescriptor | null;
    /** Where lSolver.wasm is, when not at the bundle's own copy (fem/wasmUrl.ts). Only the first request of a worker uses it. */
    wasmUrl?: string;
}

export type WorkerRequest = RunRequest;

export type WorkerResponse =
    | { kind: "progress"; id: number; step: AnalysisStage; fraction: number }
    | { kind: "result"; id: number; result: AnalysisResult }
    | { kind: "error"; id: number; message: string }
    /** The worker no longer has the grid for `gridKey` and the request carried no triangles: send them. */
    | { kind: "need-soup"; id: number };
