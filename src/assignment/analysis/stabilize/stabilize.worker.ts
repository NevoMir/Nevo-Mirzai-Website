// The stabilizer in a Web Worker: a model of a few hundred blocks takes seconds of FEM. runStabilize.ts owns the other end;
// stopping a run terminates the worker (the search is one synchronous loop, so there is no way to ask it politely).

import type { SolverHandle } from "../stress.ts";
import { loadStabilizerSolver, stabilize } from "./stabilize.ts";
import type { StabilizeRequest, StabilizeResponse } from "./types.ts";

// The app's tsconfig has the DOM lib, not the WebWorker one, so describe the little of the scope that is used.
interface WorkerScope {
    onmessage: ((event: MessageEvent<StabilizeRequest>) => void) | null;
    postMessage(message: StabilizeResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** Loading the WASM module takes a moment; a worker serves one run, but keep the handle in case it is asked for another. */
const solvers = new Map<string, Promise<SolverHandle>>();

scope.onmessage = async (event) => {
    const request = event.data;
    if (request.kind !== "stabilize") return;
    const { id } = request;
    try {
        const key = request.wasmUrl ?? "";
        let solver = solvers.get(key);
        if (!solver) {
            solver = loadStabilizerSolver(request.wasmUrl); // the TypeScript solver when there is no URL or the module does not load
            solvers.set(key, solver);
        }
        const result = await stabilize(request.input, request.sourceDepth, {
            solver: await solver,
            onEvent: (e) => scope.postMessage({ kind: "event", id, event: e }),
        });
        // The GLB's buffer moves to the page instead of being copied.
        scope.postMessage({ kind: "done", id, result }, [result.glb.buffer]);
    } catch (error) {
        scope.postMessage({ kind: "error", id, message: error instanceof Error && error.message ? error.message : "The stabilizer failed." });
    }
};
