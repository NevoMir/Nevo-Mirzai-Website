// The page's end of the mesh editor: opens a model file in a Web Worker (or, where workers do not start, on the main thread after a tick),
// describes it, runs a program on it. Aborting terminates the worker, so a stopped edit leaves nothing running.
//
//   const edit = await openMeshEdit(bytes, { originalPrompt, signal });
//   const pkg = await edit.describe();
//   const out = await edit.run({ program, instruction, jobId, onProgress });
//   edit.dispose();

import type { MeshPackage, MeshView } from "../shared/contract.ts";
import type { MeshProgram } from "../shared/meshProgram.ts";
import type { PictureFormat } from "./describeMesh.ts";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import type { RunOutput, SessionInfo } from "./session.ts";
import { MeshEditError, type RunProgress } from "./types.ts";

export interface OpenOptions {
    originalPrompt?: string | null;
    signal?: AbortSignal;
}

export interface RunOptions {
    program: MeshProgram;
    instruction: string;
    jobId: string | null;
    signal?: AbortSignal;
    onProgress?: (progress: RunProgress | { stage: "texture" | "writing" }) => void;
}

export interface MeshEditHandle {
    info: SessionInfo;
    /** True when the work runs in a Web Worker (false: on the page itself). */
    inWorker: boolean;
    describe(format?: PictureFormat, signal?: AbortSignal, size?: number): Promise<MeshPackage>;
    zoom(program: MeshProgram, format?: PictureFormat, signal?: AbortSignal): Promise<MeshView[]>;
    run(options: RunOptions): Promise<RunOutput>;
    dispose(): void;
}

const aborted = (): MeshEditError => new MeshEditError("aborted", "The edit was stopped.");

/** What the main thread does when the worker cannot start: the same session code, loaded on demand. */
async function openOnMainThread(bytes: ArrayBuffer, options: OpenOptions): Promise<MeshEditHandle> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const [{ openSession }, { browserCodec }] = await Promise.all([import("./session.ts"), import("./texture.ts")]);
    const session = await openSession(new Uint8Array(bytes), browserCodec(), options.originalPrompt ?? null);
    const guard = <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => (signal?.aborted ? Promise.reject(aborted()) : work());
    return {
        info: session.info,
        inWorker: false,
        describe: (format = "png", signal, size) => guard(signal, () => session.describe(format, size)),
        zoom: (program, format = "png", signal) => guard(signal, () => session.zoom(program, format)),
        run: (o) => guard(o.signal, () => session.run(o)),
        dispose: () => undefined,
    };
}

function openInWorker(worker: Worker, bytes: ArrayBuffer, options: OpenOptions): Promise<MeshEditHandle> {
    let nextId = 1;
    let disposed = false;
    const pending = new Map<number, { resolve: (message: WorkerResponse) => void; reject: (error: Error) => void; onProgress?: RunOptions["onProgress"] }>();
    const failAll = (error: Error): void => {
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const entry = pending.get(message.id);
        if (!entry) return;
        if (message.kind === "progress") {
            entry.onProgress?.(message.progress);
            return;
        }
        pending.delete(message.id);
        if (message.kind === "error") entry.reject(new MeshEditError(message.code, message.message));
        else entry.resolve(message);
    };
    worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        failAll(new MeshEditError("failed", event.message || "The editor could not run."));
    };
    worker.onmessageerror = () => failAll(new MeshEditError("failed", "The editor sent a message that could not be read."));

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        worker.terminate();
        failAll(aborted());
    };
    const ask = (request: (id: number) => WorkerRequest, signal: AbortSignal | undefined, onProgress?: RunOptions["onProgress"], transfer?: Transferable[]): Promise<WorkerResponse> =>
        new Promise<WorkerResponse>((resolve, reject) => {
            if (disposed || signal?.aborted) {
                reject(aborted());
                return;
            }
            const id = nextId++;
            const onAbort = (): void => dispose();
            signal?.addEventListener("abort", onAbort, { once: true });
            pending.set(id, {
                resolve: (m) => {
                    signal?.removeEventListener("abort", onAbort);
                    resolve(m);
                },
                reject: (e) => {
                    signal?.removeEventListener("abort", onAbort);
                    reject(e);
                },
                onProgress,
            });
            worker.postMessage(request(id), transfer ?? []);
        });

    return ask((id) => ({ kind: "open", id, bytes, originalPrompt: options.originalPrompt ?? null }), options.signal, undefined, [bytes]).then((opened) => {
        if (opened.kind !== "opened") throw new MeshEditError("failed", "The editor did not start.");
        return {
            info: opened.info,
            inWorker: true,
            describe: async (format = "png", signal, size) => {
                const r = await ask((id) => ({ kind: "describe", id, format, size }), signal ?? options.signal);
                if (r.kind !== "described") throw new MeshEditError("failed", "The editor gave no answer.");
                return r.pkg;
            },
            zoom: async (program, format = "png", signal) => {
                const r = await ask((id) => ({ kind: "zoom", id, program, format }), signal ?? options.signal);
                if (r.kind !== "zoomed") throw new MeshEditError("failed", "The editor gave no answer.");
                return r.views;
            },
            run: async (o) => {
                const r = await ask((id) => ({ kind: "run", id, program: o.program, instruction: o.instruction, jobId: o.jobId }), o.signal ?? options.signal, o.onProgress);
                if (r.kind !== "ran") throw new MeshEditError("failed", "The editor gave no answer.");
                return { glb: new Uint8Array(r.glb), notes: r.notes, triangles: r.triangles, parts: r.parts, log: [], ms: r.ms };
            },
            dispose,
        } satisfies MeshEditHandle;
    });
}

/**
 * Opens the model file (an ArrayBuffer, transferred to the worker: do not use it afterwards). Rejects with a MeshEditError: "unsupported"
 * (the format cannot be edited here, the message says so) or "aborted".
 */
export async function openMeshEdit(bytes: ArrayBuffer, options: OpenOptions = {}): Promise<MeshEditHandle> {
    if (options.signal?.aborted) throw aborted();
    let worker: Worker | null = null;
    if (typeof Worker !== "undefined") {
        try {
            worker = new Worker(new URL("./meshEdit.worker.ts", import.meta.url), { type: "module" });
        } catch {
            worker = null;
        }
    }
    if (!worker) return openOnMainThread(bytes, options);
    try {
        // A copy goes to the worker (transferred): if the worker cannot start, the page still has the file for the fallback.
        return await openInWorker(worker, bytes.slice(0), options);
    } catch (error) {
        worker.terminate();
        // A verdict on the model (or the person's own stop) ends here; anything else means the worker could not start, so the page does the work.
        if (error instanceof MeshEditError && (error.code === "unsupported" || error.code === "aborted" || error.code === "toobig")) throw error;
        return openOnMainThread(bytes, options);
    }
}
