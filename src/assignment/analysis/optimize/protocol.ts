// The messages between the page and the optimizer's Web Worker (optimize.worker.ts <-> runOptimize.ts), and what a finished run looks like
// on the wire. One worker per run (it holds the solver's memory), like the stabilizer's.

import type { OptimizeInput, OptimizeMeta, OptimizeRunResult } from "./optimizeAssembly.ts";
import type { AssemblyDescriptor } from "../../shared/assembly.ts";
import type { Effective } from "./spec.ts";
import type { OptimizeEvent, OptimizeResult } from "./types.ts";

export interface OptimizeRequest {
    kind: "optimize";
    id: number;
    input: OptimizeInput;
    /** URL of lSolver.wasm (Vite's `?url` import); absent: the TypeScript solver (same answers, ~3-4x slower). */
    wasmUrl?: string;
}

/** Asks the run to stop at the end of the iteration it is in (a solve is 5-100 ms); the worker then still sends `done`, with stop = "canceled". */
export interface OptimizeCancel {
    kind: "cancel";
    id: number;
}

export type OptimizeMessage = OptimizeRequest | OptimizeCancel;

/** The finished run as it crosses the worker boundary: the GLB buffer is transferred, the big typed arrays of the config stay behind. */
export interface OptimizeWireResult {
    descriptor: AssemblyDescriptor;
    meta: OptimizeMeta;
    glb: Uint8Array;
    result: OptimizeResult;
    effective: Effective;
    warnings: string[];
    changed: boolean;
}

export type OptimizeResponse =
    | { kind: "event"; id: number; event: OptimizeEvent }
    | { kind: "done"; id: number; result: OptimizeWireResult }
    | { kind: "error"; id: number; message: string };

export function toWire(run: OptimizeRunResult): OptimizeWireResult {
    return { descriptor: run.descriptor, meta: run.meta, glb: run.glb, result: run.result, effective: run.compiled.effective, warnings: run.compiled.warnings, changed: run.changed };
}
