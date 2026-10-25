// Messages between runMeshEdit.ts (the page) and meshEdit.worker.ts. Types only, so both sides share one contract.

import type { MeshPackage, MeshView } from "../shared/contract.ts";
import type { MeshProgram } from "../shared/meshProgram.ts";
import type { PictureFormat } from "./describeMesh.ts";
import type { SessionInfo } from "./session.ts";
import type { MeshEditErrorCode, RunProgress } from "./types.ts";

export type WorkerRequest =
    /** The model file (transferred) and the prompt it was made from. */
    | { kind: "open"; id: number; bytes: ArrayBuffer; originalPrompt: string | null }
    | { kind: "describe"; id: number; format: PictureFormat; size?: number }
    | { kind: "zoom"; id: number; program: MeshProgram; format: PictureFormat }
    | { kind: "run"; id: number; program: MeshProgram; instruction: string; jobId: string | null };

export type WorkerResponse =
    | { kind: "opened"; id: number; info: SessionInfo }
    | { kind: "described"; id: number; pkg: MeshPackage }
    | { kind: "zoomed"; id: number; views: MeshView[] }
    | { kind: "progress"; id: number; progress: RunProgress | { stage: "texture" | "writing" } }
    | { kind: "ran"; id: number; glb: ArrayBuffer; notes: string[]; triangles: number; parts: number; ms: number }
    | { kind: "error"; id: number; code: MeshEditErrorCode; message: string };
