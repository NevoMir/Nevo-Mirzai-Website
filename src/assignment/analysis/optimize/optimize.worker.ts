// The optimizer in a Web Worker. A run is a few hundred FEM solves (5-100 ms each); runOptimize.ts owns the other end.
//
// Stopping: the page sends {kind: "cancel", id}. The run awaits `pause` between pieces of work (every ~25 ms of it), which lets this
// handler run and set the flag; the loop then ends at the next iteration boundary and the worker answers `done` with stop = "canceled" and
// the best (feasible) state so far. Only a worker that does not answer within the runner's grace period is terminated.

import type { SolverHandle } from "../stress.ts";
import { loadStabilizerSolver } from "../stabilize/stabilize.ts";
import { optimizeAssembly } from "./optimizeAssembly.ts";
import { toWire } from "./protocol.ts";
import type { OptimizeMessage, OptimizeResponse } from "./protocol.ts";

// The app's tsconfig has the DOM lib, not the WebWorker one, so describe the little of the scope that is used.
interface WorkerScope {
    onmessage: ((event: MessageEvent<OptimizeMessage>) => void) | null;
    postMessage(message: OptimizeResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

const solvers = new Map<string, Promise<SolverHandle>>();
const canceled = new Set<number>();

/** Gives the event loop a turn about every 25 ms of work, so a "cancel" message can be heard. */
function pauser(): () => Promise<void> {
    let last = performance.now();
    return async () => {
        if (performance.now() - last < 25) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        last = performance.now();
    };
}

scope.onmessage = async (event) => {
    const message = event.data;
    if (message.kind === "cancel") {
        canceled.add(message.id);
        return;
    }
    if (message.kind !== "optimize") return;
    const { id } = message;
    try {
        const key = message.wasmUrl ?? "";
        let solver = solvers.get(key);
        if (!solver) {
            solver = loadStabilizerSolver(message.wasmUrl); // the TypeScript solver when there is no URL or the module does not load
            solvers.set(key, solver);
        }
        const run = await optimizeAssembly(message.input, {
            solver: await solver,
            onEvent: (e) => scope.postMessage({ kind: "event", id, event: e }),
            cancelled: () => canceled.has(id),
            pause: pauser(),
        });
        scope.postMessage({ kind: "done", id, result: toWire(run) }, [run.glb.buffer]);
    } catch (error) {
        scope.postMessage({ kind: "error", id, message: error instanceof Error && error.message ? error.message : "The optimizer failed." });
    } finally {
        canceled.delete(id);
    }
};
