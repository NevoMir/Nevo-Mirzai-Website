// Runs the optimizer off the main thread and hands back a promise, the way runStabilize.ts does for the stabilizer.
//
//   const done = await runOptimize(input, { signal, onIteration, onProgress });
//
// - A Web Worker does the work (Vite bundles it). Every accepted iteration is reported as it happens (onIteration: the metrics row for
//   the convergence chart and the cells it took out / put in, for the live preview); progress (at most ten a second) says it is alive.
// - Aborting the signal is a request, not a kill: the worker finishes the iteration it is in and answers with the best state so far
//   (stop = "canceled"), which RESOLVES here, so the page can offer "keep this result". Only when the worker has not answered within
//   STOP_GRACE_MS (a stuck solve) is it terminated and the promise rejected with an Error named "AbortError".
// - Without Worker support, or when the worker cannot start, the same code runs on the page's own thread (it gives the page a turn every
//   ~25 ms of work, so Stop keeps working).

import type { AssemblyDescriptor } from "../../shared/assembly.ts";
import type { Brief } from "../../shared/optimizeSpec.ts";
import type { AnalysisSettings } from "../types.ts";
import type { OptimizeInput } from "./optimizeAssembly.ts";
import type { OptimizeMessage, OptimizeRequest, OptimizeResponse, OptimizeWireResult } from "./protocol.ts";
import type { SpecContext } from "./spec.ts";
import type { IterationRecord, OptimizeEvent } from "./types.ts";

export type StartEvent = Extract<OptimizeEvent, { kind: "start" }>;
export type IterationEvent = Extract<OptimizeEvent, { kind: "iteration" }>;
export type ProgressEvent = Extract<OptimizeEvent, { kind: "progress" }>;

/**
 * How long a Stop may take to be answered before the worker is ended. The answer needs the "after" figures from the engine: about 0.5 s for a
 * model that fills the whole lattice on a fast laptop, two or three times that on a phone, so 2 s was too tight (the person lost the state they
 * pressed Stop to keep).
 */
export const STOP_GRACE_MS = 5000;

export interface RunOptimizeOptions {
    signal?: AbortSignal;
    onEvent?: (event: OptimizeEvent) => void;
    onStart?: (event: StartEvent) => void;
    onIteration?: (event: IterationEvent) => void;
    onProgress?: (event: ProgressEvent) => void;
    /** URL of lSolver.wasm. Left out: the one in the bundle (Vite's `?url`). null: the TypeScript solver. */
    wasmUrl?: string | null;
}

export function optimizeAbortError(): Error {
    const error = new Error("The optimizer was stopped.");
    error.name = "AbortError";
    return error;
}

function dispatch(options: RunOptimizeOptions, event: OptimizeEvent): void {
    options.onEvent?.(event);
    if (event.kind === "iteration") options.onIteration?.(event);
    else if (event.kind === "start") options.onStart?.(event);
    else options.onProgress?.(event);
}

class WorkerUnavailable extends Error {}

let bundledUrl: Promise<string | undefined> | null = null;
function bundledWasmUrl(): Promise<string | undefined> {
    bundledUrl ??= import("../fem/vendor/lSolver.wasm?url").then(
        (m) => (m as { default: string }).default,
        () => undefined,
    );
    return bundledUrl;
}
async function resolveWasm(options: RunOptimizeOptions): Promise<string | undefined> {
    if (options.wasmUrl === null) return undefined;
    return options.wasmUrl ?? (await bundledWasmUrl());
}

// ---------- the page's own thread ----------

function pauser(): () => Promise<void> {
    let last = performance.now();
    return async () => {
        if (performance.now() - last < 25) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        last = performance.now();
    };
}

async function runOnMainThread(input: OptimizeInput, wasmUrl: string | undefined, options: RunOptimizeOptions): Promise<OptimizeWireResult> {
    const { optimizeAssembly } = await import("./optimizeAssembly.ts");
    const { loadStabilizerSolver } = await import("../stabilize/stabilize.ts");
    const { toWire } = await import("./protocol.ts");
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // one tick so the caller can show "optimizing" before the page gets busy
    const solver = await loadStabilizerSolver(wasmUrl);
    const run = await optimizeAssembly(input, { solver, onEvent: (e) => dispatch(options, e), cancelled: () => options.signal?.aborted === true, pause: pauser() });
    return toWire(run);
}

// ---------- the worker ----------

function runInWorker(worker: Worker, input: OptimizeInput, wasmUrl: string | undefined, options: RunOptimizeOptions): Promise<OptimizeWireResult> {
    return new Promise<OptimizeWireResult>((resolve, reject) => {
        const id = 1;
        let settled = false;
        let heard = false;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            options.signal?.removeEventListener("abort", onAbort);
            worker.terminate(); // one worker per run: it holds the solver's memory
            action();
        };
        const onAbort = () => {
            // Ask politely; the worker answers `done` (stop = "canceled") at the end of its iteration.
            try {
                const cancel: OptimizeMessage = { kind: "cancel", id };
                worker.postMessage(cancel);
            } catch {
                finish(() => reject(optimizeAbortError()));
                return;
            }
            graceTimer = setTimeout(() => finish(() => reject(optimizeAbortError())), STOP_GRACE_MS);
        };
        worker.onmessage = (event: MessageEvent<OptimizeResponse>) => {
            const message = event.data;
            if (message.id !== id) return;
            heard = true;
            switch (message.kind) {
                case "event":
                    dispatch(options, message.event);
                    break;
                case "done":
                    finish(() => resolve(message.result));
                    break;
                case "error":
                    finish(() => reject(new Error(message.message)));
                    break;
            }
        };
        worker.onerror = (event: ErrorEvent) =>
            finish(() => {
                const text = event.message || "The optimizer worker failed.";
                // Before it has said anything the page can do the job itself; after, restarting would repeat every iteration.
                reject(heard ? new Error(text) : new WorkerUnavailable(text));
            });
        worker.onmessageerror = () => finish(() => reject(heard ? new Error("The optimizer sent a message that could not be read.") : new WorkerUnavailable("The optimizer sent a message that could not be read.")));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        try {
            const request: OptimizeRequest = { kind: "optimize", id, input, wasmUrl };
            worker.postMessage(request);
        } catch (error) {
            finish(() => reject(new WorkerUnavailable(error instanceof Error ? error.message : "The optimizer could not be started.")));
            return;
        }
        if (options.signal?.aborted) onAbort();
    });
}

function startWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("./optimize.worker.ts", import.meta.url), { type: "module" });
    } catch {
        return null;
    }
}

// ---------- public ----------

/** What the page needs to talk about a model before a run: the facts for the spec (context) and the brief the model is given. */
export interface OptimizePrepared {
    context: SpecContext;
    brief: Brief;
}

/**
 * The facts about the version a run would start from: its figures (one geometry pass and one solve, a few milliseconds to a tenth of a
 * second on the page's own thread) and the brief Muse Spark is given. `parts` are the cells of each named part (cleanParts makes them safe).
 */
export async function prepareOptimize(input: { assembly: AssemblyDescriptor; settings: AnalysisSettings; parts: Record<string, number[]> }, options: Pick<RunOptimizeOptions, "wasmUrl"> = {}): Promise<OptimizePrepared> {
    const [{ cleanParts, specContextOf }, { briefOf }, { loadStabilizerSolver }] = await Promise.all([import("./optimizeAssembly.ts"), import("./spec.ts"), import("../stabilize/stabilize.ts")]);
    const solver = await loadStabilizerSolver(await resolveWasm(options));
    const context = specContextOf(input.assembly, input.settings, solver, cleanParts(input.parts));
    return { context, brief: briefOf(context) };
}

/** Optimizes the assembly (see optimizeAssembly.ts). Resolves with stop = "canceled" when stopped; rejects with the message of an input that cannot be optimized. */
export async function runOptimize(input: OptimizeInput, options: RunOptimizeOptions = {}): Promise<OptimizeWireResult> {
    if (options.signal?.aborted) throw optimizeAbortError();
    const wasmUrl = await resolveWasm(options);
    const worker = startWorker();
    if (worker) {
        try {
            return await runInWorker(worker, input, wasmUrl, options);
        } catch (error) {
            if (!(error instanceof WorkerUnavailable)) throw error;
        }
    }
    return runOnMainThread(input, wasmUrl, options);
}

export type { IterationRecord };
