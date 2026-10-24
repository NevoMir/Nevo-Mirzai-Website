// Runs the stabilizer off the main thread and hands back a promise, the way runAnalysis.ts does for the analysis.
//
//   const result = await runStabilize(input, { sourceDepth, signal, onEvent });
//
// - A Web Worker does the work (Vite bundles it); every accepted move is reported as it happens (onStep), and the search
//   reports how far it is with the candidate moves it is scoring (onProgress, at most ten times a second).
// - Without Worker support, or if the worker cannot start, the same code runs on the page's own thread. It gives the page a
//   turn every ~30 ms of work, so Stop keeps working and the page keeps painting (it is just slower than the worker).
// - Aborting the signal terminates the worker and rejects with an Error named "AbortError". A worker cannot be asked to
//   stop politely (the search is one synchronous loop), so what the run had found is what its `step` events carried (each
//   with the cells it added and their roles): a caller that wants to keep a stopped run builds its result from those.
// - The result's GLB is transferred out of the worker, not copied.

import type { StabilizeEvent, StabilizeInput, StabilizeRequest, StabilizeResponse, StabilizeResult } from "./types.ts";

export type StepEvent = Extract<StabilizeEvent, { kind: "step" }>;
export type ProgressEvent = Extract<StabilizeEvent, { kind: "progress" }>;

export interface RunStabilizeOptions {
    /** 0 for a generated or example model (the default), else the DerivedMeta.depth of the stabilized model the cells came from. */
    sourceDepth?: number;
    /** Aborting terminates the worker and rejects with an AbortError. */
    signal?: AbortSignal;
    /** Every event, in order. */
    onEvent?: (event: StabilizeEvent) => void;
    /** Just the accepted moves / just the progress; each is also given to onEvent. */
    onStep?: (event: StepEvent) => void;
    onProgress?: (event: ProgressEvent) => void;
    /**
     * URL of lSolver.wasm. Left out: the one in the bundle (Vite's `?url`). null: the TypeScript solver (same answers to 1e-10,
     * somewhat slower on big models).
     */
    wasmUrl?: string | null;
}

export function stabilizeAbortError(): Error {
    const error = new Error("The stabilizer was stopped.");
    error.name = "AbortError";
    return error;
}

function dispatch(options: RunStabilizeOptions, event: StabilizeEvent): void {
    options.onEvent?.(event);
    if (event.kind === "step") options.onStep?.(event);
    else options.onProgress?.(event);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw stabilizeAbortError();
}

/** The worker could not be started or died before it said anything: the caller falls back to the page. */
class WorkerUnavailable extends Error {}

let bundledUrl: Promise<string | undefined> | null = null;

/** The URL Vite gives lSolver.wasm in the build. Dynamic, so a plain Node run of this module (tests) still loads. */
function bundledWasmUrl(): Promise<string | undefined> {
    bundledUrl ??= import("../fem/vendor/lSolver.wasm?url").then(
        (m) => (m as { default: string }).default,
        () => undefined,
    );
    return bundledUrl;
}

async function resolveWasm(options: { wasmUrl?: string | null }): Promise<string | undefined> {
    if (options.wasmUrl === null) return undefined;
    return options.wasmUrl ?? (await bundledWasmUrl());
}

// ---------- the page's own thread ----------

function pauser(): () => Promise<void> {
    let last = performance.now();
    return async () => {
        if (performance.now() - last < 30) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        last = performance.now();
    };
}

async function runOnMainThread(input: StabilizeInput, sourceDepth: number, wasmUrl: string | undefined, options: RunStabilizeOptions): Promise<StabilizeResult> {
    const { stabilize, loadStabilizerSolver } = await import("./stabilize.ts");
    // One tick so the caller can show "stabilizing" before the page gets busy.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(options.signal);
    const solver = await loadStabilizerSolver(wasmUrl);
    throwIfAborted(options.signal);
    const result = await stabilize(input, sourceDepth, {
        solver,
        onEvent: (event) => dispatch(options, event),
        cancelled: () => options.signal?.aborted === true,
        pause: pauser(),
    });
    throwIfAborted(options.signal);
    return result;
}

// ---------- the worker ----------

function runInWorker(worker: Worker, input: StabilizeInput, sourceDepth: number, wasmUrl: string | undefined, options: RunStabilizeOptions): Promise<StabilizeResult> {
    return new Promise<StabilizeResult>((resolve, reject) => {
        const id = 1;
        let settled = false;
        let heard = false;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            options.signal?.removeEventListener("abort", onAbort);
            worker.terminate(); // one worker per run: it holds the solver's memory
            action();
        };
        const onAbort = () => finish(() => reject(stabilizeAbortError()));
        worker.onmessage = (event: MessageEvent<StabilizeResponse>) => {
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
                const text = event.message || "The stabilizer worker failed.";
                // Before it has said anything the page can do the job itself; after, restarting would repeat every step.
                reject(heard ? new Error(text) : new WorkerUnavailable(text));
            });
        worker.onmessageerror = () => finish(() => reject(heard ? new Error("The stabilizer sent a message that could not be read.") : new WorkerUnavailable("The stabilizer sent a message that could not be read.")));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
            return;
        }
        try {
            const request: StabilizeRequest = { kind: "stabilize", id, input, sourceDepth, wasmUrl };
            worker.postMessage(request);
        } catch (error) {
            finish(() => reject(new WorkerUnavailable(error instanceof Error ? error.message : "The stabilizer could not be started.")));
        }
    });
}

function startWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    try {
        return new Worker(new URL("./stabilize.worker.ts", import.meta.url), { type: "module" });
    } catch {
        return null;
    }
}

// ---------- public ----------

/**
 * Stabilizes the model (see stabilize.ts). Rejects with an Error named "AbortError" when stopped, with a RangeError-style
 * message for input that cannot be stabilized, and with the worker's message if the search itself fails.
 */
export async function runStabilize(input: StabilizeInput, options: RunStabilizeOptions = {}): Promise<StabilizeResult> {
    throwIfAborted(options.signal);
    const sourceDepth = options.sourceDepth ?? 0;
    const wasmUrl = await resolveWasm(options);
    throwIfAborted(options.signal);
    const worker = startWorker();
    if (worker) {
        try {
            return await runInWorker(worker, input, sourceDepth, wasmUrl, options);
        } catch (error) {
            if (!(error instanceof WorkerUnavailable)) throw error;
        }
    }
    return runOnMainThread(input, sourceDepth, wasmUrl, options);
}
