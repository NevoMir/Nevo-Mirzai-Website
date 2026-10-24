// Runs the analysis off the main thread and hands back a promise.
//
//   const result = await runAnalysis(soup, settings, { signal, onProgress });
//
// - A Web Worker does the work (Vite bundles it). Without Worker support, or if the worker cannot start, the same
//   code runs on the main thread after one tick, so the page still works (it just cannot paint while it runs).
// - Cancelling (AbortSignal) terminates the worker, so a stale run never delays the next one.
// - Results are cached (small LRU) by model + settings, and the worker keeps the voxelised model, so moving the
//   fill threshold, the cantilever limit or the budget re-evaluates in a few milliseconds instead of voxelising
//   again. The model is identified by `options.cacheKey` (pass the model url) or, if none is given, by a cheap
//   fingerprint of the triangles.
// - The soup is COPIED into the worker unless `transfer: true` (then the caller's buffer is detached): the soup
//   from the viewer may share memory with a live geometry.
// - Every result carries the stress estimate (the worker's second stage, withStress.ts). The page-side fallback loads
//   that module lazily, so the solver is not part of the page's own bundle.
// - A stabilized model is a block assembly: pass `options.assembly` (the descriptor read from its GLB) and the cells are
//   analysed exactly, never voxelised. The soup is then only used for its bounds, which tie the lattice to the frame the
//   viewer draws in.
// - A soup with no triangle at all is never remembered: a viewer that is not loaded (or was disposed) hands back
//   an empty soup, and caching that as "No blocks" would stick to the model. With `rejectEmpty` it is an error
//   the caller can retry instead.

import type { AnalysisResult, AnalysisSettings, TriangleSoup } from "./types.ts";
import { CELL_STRIDE, type AssemblyDescriptor } from "../shared/assembly.ts";
import { analyzeGrid } from "./analyze.ts";
import { annotateRoles, boundsOf, gridFromAssembly, settingsForAssembly, type Bounds } from "./assembly.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { normalizeSettings } from "./settings.ts";
import { voxelize } from "./voxelize.ts";
import type { AnalysisStage, VoxelGrid } from "./voxelize.ts";

/** What onProgress receives. `stage` is a label for the UI; `step` is the machine-readable stage. */
export interface AnalysisProgress {
    stage: string;
    progress: number; // 0-1, overall
    step: AnalysisStage;
}

export interface RunOptions {
    signal?: AbortSignal;
    onProgress?: (progress: AnalysisProgress) => void;
    /** Identifies the model (its url). Lets cached results and the worker's voxel grid be reused. */
    cacheKey?: string;
    /** Move the triangles into the worker instead of copying them; the caller's buffer becomes unusable. */
    transfer?: boolean;
    /**
     * Reject with an EmptyModelError when the triangles come back empty, instead of answering "No blocks". For a
     * source that is a viewer: an empty soup means "not loaded (yet)", not "a model without geometry".
     */
    rejectEmpty?: boolean;
    /**
     * The block assembly the model is (a stabilized model's GLB declares it; LoadedModel.assembly), else leave it out
     * and the triangles are voxelised. With it the triangles are only used for their bounds.
     */
    assembly?: AssemblyDescriptor | null;
    /** The assembly the triangles belong to, when `assembly` is only a part of it (the compare view's original blocks). */
    frame?: AssemblyDescriptor | null;
}

/** The triangle source returned no triangle: the model is not loaded (yet). Retrying later may work. */
export class EmptyModelError extends Error {
    constructor() {
        super("The model is not loaded yet.");
        this.name = "EmptyModelError";
    }
}

/** A soup with fewer than one whole triangle: nothing to analyse. */
const isEmptySoup = (soup: TriangleSoup): boolean => soup.positions.length < 9;

const STAGE_LABELS: Record<AnalysisStage, string> = {
    voxelize: "Voxelising the model",
    flood: "Filling the inside",
    analyze: "Checking the structure",
    stress: "Estimating stress",
};

/** The structural analysis ends at this share of the bar; the stress estimate fills the rest (as in the worker). */
const STRESS_FROM = 0.96;

/** What the structural analysis needs to know about the model, beyond the settings. */
interface Job {
    gridKey: string;
    /** Set for a block assembly; the grid is then built from it. */
    assembly: AssemblyDescriptor | null;
    frame: AssemblyDescriptor | null;
}

export type SoupSource = TriangleSoup | (() => TriangleSoup);

export function abortError(): Error {
    const error = new Error("The analysis was cancelled.");
    error.name = "AbortError";
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError();
}

// ---------- cache ----------

const RESULT_CACHE_SIZE = 8;
const results = new Map<string, AnalysisResult>();

/** Cheap identity for a triangle list: its length and 1024 sampled words. Collisions would need equal samples. */
function fingerprint(positions: Float32Array): string {
    const words = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
    let h = 2166136261 ^ words.length;
    const step = Math.max(1, Math.floor(words.length / 1024));
    for (let i = 0; i < words.length; i += step) h = Math.imul(h ^ words[i], 16777619);
    return `fp:${words.length}:${(h >>> 0).toString(16)}`;
}

/** Identity of a descriptor: its block count and two 32-bit hashes of every number in it (cells, roles and steps). */
function assemblyKey(d: AssemblyDescriptor): string {
    let a = 2166136261;
    let b = 5381;
    for (const n of d.cells) {
        a = Math.imul(a ^ n, 16777619);
        b = Math.imul(b, 33) ^ n;
    }
    return `${d.cells.length / CELL_STRIDE}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}:${d.inset}`;
}

export function clearAnalysisCache(): void {
    results.clear();
    mainGrids.clear();
    if (idle) {
        idle.terminate();
        idle = null;
    }
}

// ---------- main-thread fallback ----------

const mainGrids = new Map<string, VoxelGrid>();

/** The bounds the viewer's triangles have (null when there are none), which tie an assembly's lattice to the viewer's frame. */
const soupBounds = (soup: TriangleSoup): Bounds | null => (isEmptySoup(soup) ? null : boundsOf(soup.positions));

async function runOnMainThread(soupOf: () => TriangleSoup, job: Job, settings: AnalysisSettings, options: RunOptions): Promise<AnalysisResult> {
    // One tick so the caller can show "analysing" before the page freezes.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(options.signal);
    const report = (fraction: number, step: AnalysisStage) => options.onProgress?.({ stage: STAGE_LABELS[step], progress: fraction, step });
    // The bar must not reach 100 % before the stress stage has run.
    const onProgress = (fraction: number, step: AnalysisStage) => report(Math.min(fraction, STRESS_FROM), step);
    let result: AnalysisResult;
    if (job.assembly) {
        const grid = gridFromAssembly(job.assembly, soupBounds(soupOf()), settings, job.frame ?? job.assembly);
        result = annotateRoles(analyzeGrid(grid, settings, { onProgress }), job.assembly);
    } else {
        let grid = mainGrids.get(job.gridKey);
        if (!grid) {
            grid = voxelize(soupOf(), settings, onProgress);
            // A grid built from nothing must not be reused for the real model that arrives later under the same key.
            if (grid.triangles.used > 0) {
                mainGrids.delete(job.gridKey);
                mainGrids.set(job.gridKey, grid);
                while (mainGrids.size > 2) {
                    const oldest = mainGrids.keys().next().value;
                    if (oldest === undefined) break;
                    mainGrids.delete(oldest);
                }
            }
        }
        throwIfAborted(options.signal);
        result = analyzeGrid(grid, settings, { onProgress });
    }
    throwIfAborted(options.signal);
    report(STRESS_FROM, "stress");
    const { withStress } = await import("./withStress.ts");
    const withStressResult = await withStress(result);
    throwIfAborted(options.signal);
    report(1, "stress");
    return withStressResult;
}

// ---------- worker ----------

/** The worker could not be started or crashed outside the analysis code: the caller falls back to the page. */
class WorkerUnavailable extends Error {}

let idle: Worker | null = null;
// Which voxel grids a worker still holds (mirrors the worker's own cache), most recent last.
const held = new WeakMap<Worker, string[]>();
let nextId = 1;

function takeWorker(): Worker | null {
    if (typeof Worker === "undefined") return null;
    if (idle) {
        const worker = idle;
        idle = null;
        return worker;
    }
    try {
        return new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    } catch {
        return null;
    }
}

function releaseWorker(worker: Worker): void {
    if (idle) worker.terminate();
    else idle = worker;
}

function runInWorker(worker: Worker, soupOf: () => TriangleSoup, job: Job, settings: AnalysisSettings, options: RunOptions): Promise<AnalysisResult> {
    const { gridKey, assembly, frame } = job;
    return new Promise<AnalysisResult>((resolve, reject) => {
        const id = nextId++;
        let settled = false;
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
            options.signal?.removeEventListener("abort", onAbort);
            action();
        };
        const onAbort = () =>
            finish(() => {
                worker.terminate();
                reject(abortError());
            });
        // The source threw (or was empty with rejectEmpty). An empty model says nothing against the worker, so it
        // keeps its grids; anything else may have left it in an unknown state.
        const fail = (error: unknown) =>
            finish(() => {
                if (error instanceof EmptyModelError) releaseWorker(worker);
                else worker.terminate();
                reject(error);
            });
        // The worker does not remember a grid made from an empty soup (see analysis.worker.ts), so neither do we.
        let sentEmpty = false;
        const sendSoup = () => {
            const soup = soupOf();
            if (assembly) {
                // The cells are the blocks: only the triangles' bounds are needed, not the triangles.
                const request: WorkerRequest = { kind: "run", id, gridKey, positions: null, settings, assembly, soupBounds: soupBounds(soup), frame };
                worker.postMessage(request);
                return;
            }
            const positions = soup.positions;
            sentEmpty = isEmptySoup(soup);
            if (options.transfer) worker.postMessage({ kind: "run", id, gridKey, positions, settings }, [positions.buffer]);
            else worker.postMessage({ kind: "run", id, gridKey, positions, settings });
        };

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            const message = event.data;
            if (message.id !== id) return;
            switch (message.kind) {
                case "progress":
                    options.onProgress?.({ stage: STAGE_LABELS[message.step], progress: message.fraction, step: message.step });
                    break;
                case "need-soup":
                    held.set(worker, (held.get(worker) ?? []).filter((key) => key !== gridKey));
                    try {
                        sendSoup();
                    } catch (error) {
                        fail(error);
                    }
                    break;
                case "result":
                    finish(() => {
                        // An assembly leaves nothing in the worker: its grid is built from the request every time.
                        if (!assembly) {
                            const keys = (held.get(worker) ?? []).filter((key) => key !== gridKey);
                            if (!sentEmpty) keys.push(gridKey);
                            while (keys.length > 3) keys.shift();
                            held.set(worker, keys);
                        }
                        releaseWorker(worker);
                        resolve(message.result);
                    });
                    break;
                case "error":
                    // The analysis itself failed (bad settings, ...): the worker is fine, the page would fail the same way.
                    finish(() => {
                        releaseWorker(worker);
                        reject(new Error(message.message));
                    });
                    break;
            }
        };
        worker.onerror = (event: ErrorEvent) =>
            finish(() => {
                worker.terminate();
                reject(new WorkerUnavailable(event.message || "The analysis worker failed."));
            });
        worker.onmessageerror = () =>
            finish(() => {
                worker.terminate();
                reject(new WorkerUnavailable("The analysis worker sent a message that could not be read."));
            });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
            onAbort();
            return;
        }

        try {
            if (!assembly && held.get(worker)?.includes(gridKey)) {
                // The worker already has this model voxelised: no triangles needed.
                worker.postMessage({ kind: "run", id, gridKey, positions: null, settings });
            } else {
                sendSoup();
            }
        } catch (error) {
            fail(error);
        }
    });
}

// ---------- public ----------

/**
 * Analyses the model. `source` is the triangles, or a function that produces them (called only when needed: not
 * at all for a cached result). Rejects with an Error named "AbortError" when cancelled.
 */
export async function runAnalysis(source: SoupSource, settingsInput: Partial<AnalysisSettings> = {}, options: RunOptions = {}): Promise<AnalysisResult> {
    throwIfAborted(options.signal);
    const assembly = options.assembly ?? null;
    // A lattice of 100 mm blocks is fixed by the assembly itself; the block size and target volume of a voxelisation do not apply.
    const settings = assembly ? settingsForAssembly(normalizeSettings(settingsInput), assembly) : normalizeSettings(settingsInput);
    let soup: TriangleSoup | null = typeof source === "function" ? null : source;
    const soupOf = (): TriangleSoup => {
        if (soup === null) soup = (source as () => TriangleSoup)();
        if (options.rejectEmpty && isEmptySoup(soup)) throw new EmptyModelError();
        return soup;
    };
    const modelKey = options.cacheKey ?? fingerprint(soupOf().positions);
    const frame = assembly ? (options.frame ?? null) : null;
    // A voxel grid is identified by the model and the scale; an assembly by its cells (roles and steps included), plus
    // the model for the frame its bounds give.
    const gridKey = assembly
        ? `asm:${assemblyKey(assembly)}${frame ? `+${assemblyKey(frame)}` : ""}|${modelKey}`
        : `${modelKey}|${settings.targetSizeMm}|${settings.blockSizeMm}`;
    const resultKey = `${gridKey}|${settings.fillThreshold}|${settings.cantileverLimit}|${settings.maxBlocks ?? "-"}|${settings.material}`;
    const job: Job = { gridKey, assembly, frame };

    const cached = results.get(resultKey);
    if (cached) {
        results.delete(resultKey); // refresh its place in the LRU order
        results.set(resultKey, cached);
        options.onProgress?.({ stage: STAGE_LABELS.analyze, progress: 1, step: "analyze" });
        return cached;
    }

    let result: AnalysisResult | null = null;
    const worker = takeWorker();
    if (worker) {
        try {
            result = await runInWorker(worker, soupOf, job, settings, options);
        } catch (error) {
            if (!(error instanceof WorkerUnavailable)) throw error;
            // Fall through to the main thread. (A transferred soup would be gone; the default copies it.)
            if (options.transfer) throw error;
        }
    }
    if (!result) result = await runOnMainThread(soupOf, job, settings, options);

    // "No blocks" for a soup that had no triangle is a statement about an extraction that failed, not about the
    // model: do not let it answer for the model from now on.
    if (soup !== null && isEmptySoup(soup)) return result;
    results.set(resultKey, result);
    while (results.size > RESULT_CACHE_SIZE) {
        const oldest = results.keys().next().value;
        if (oldest === undefined) break;
        results.delete(oldest);
    }
    return result;
}
