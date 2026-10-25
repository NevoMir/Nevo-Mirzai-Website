// The mesh editor in a Web Worker, so a 28 MB model never blocks the page. runMeshEdit.ts owns the other end. One worker holds one open
// model (the arrays are big); the page terminates it when the edit ends or is stopped.

import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { openSession, type Session } from "./session.ts";
import { browserCodec } from "./texture.ts";
import { MeshEditError } from "./types.ts";

// The app's tsconfig has the DOM lib, not the WebWorker one, so describe the little of the scope that is used.
interface WorkerScope {
    onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

let session: Session | null = null;

scope.onmessage = async (event) => {
    const request = event.data;
    const { id } = request;
    try {
        switch (request.kind) {
            case "open":
                session = await openSession(new Uint8Array(request.bytes), browserCodec(), request.originalPrompt);
                scope.postMessage({ kind: "opened", id, info: session.info });
                break;
            case "describe":
                if (!session) throw new MeshEditError("failed", "No model is open.");
                scope.postMessage({ kind: "described", id, pkg: await session.describe(request.format, request.size) });
                break;
            case "zoom":
                if (!session) throw new MeshEditError("failed", "No model is open.");
                scope.postMessage({ kind: "zoomed", id, views: await session.zoom(request.program, request.format) });
                break;
            case "run": {
                if (!session) throw new MeshEditError("failed", "No model is open.");
                const out = await session.run({
                    program: request.program,
                    instruction: request.instruction,
                    jobId: request.jobId,
                    onProgress: (progress) => scope.postMessage({ kind: "progress", id, progress }),
                });
                const glb = out.glb.buffer.slice(out.glb.byteOffset, out.glb.byteOffset + out.glb.byteLength) as ArrayBuffer;
                scope.postMessage({ kind: "ran", id, glb, notes: out.notes, triangles: out.triangles, parts: out.parts, ms: out.ms }, [glb]);
                break;
            }
        }
    } catch (error) {
        const code = error instanceof MeshEditError ? error.code : "failed";
        scope.postMessage({ kind: "error", id, code, message: error instanceof Error && error.message ? error.message : "The edit failed." });
    }
};
