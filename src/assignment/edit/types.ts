// Shared types of the mesh editor (src/assignment/edit/*): the working mesh, the errors a run can end in, the progress it reports.
// Types and one small class only; erasable TypeScript, so the Node tests import the modules next to it directly.

import type { MeshOpName } from "../shared/contract.ts";
import type { DesignPart } from "../shared/partsDesign.ts";

export type Vec3 = [number, number, number];

/** What a run ended in when it did not produce a mesh. `message` is fit to show the person. */
export type MeshEditErrorCode =
    /** The file's structure cannot be edited here (Draco, quantised, several textured pieces, too many triangles ...). */
    | "unsupported"
    /** An op selected nothing: "I couldn't find the <label> on this model." */
    | "notfound"
    /** The edit would remove most of the model. */
    | "toomuch"
    /** The result would be over MAX_EDIT_TRIANGLES or the file over the upload limit. */
    | "toobig"
    | "aborted"
    | "failed";

export class MeshEditError extends Error {
    readonly code: MeshEditErrorCode;
    constructor(code: MeshEditErrorCode, message: string) {
        super(message);
        this.name = "MeshEditError";
        this.code = code;
    }
}

/** The single mesh being edited, in the edit frame (mm, Z up, ground z = 0, longest side 1000 mm). */
export interface EditMesh {
    /** mm, 3 per vertex. */
    Q: Float32Array;
    /** 2 per vertex (all zero when the source has no texture coordinates). */
    uv: Float32Array;
    /** Unit normals in the same frame, 3 per vertex. */
    nor: Float32Array;
    /** Triangles, 3 per triangle. */
    idx: Uint32Array;
}

/** A recolor that waits for the texture step: the colour, its strength, and the per-vertex weight of the region (null = the whole model). */
export interface Paint {
    color: string;
    strength: number;
    weights: Float32Array | null;
}

/** The state a program is run on: the mesh plus what the ops collect for the later steps. */
export interface EditState extends EditMesh {
    paints: Paint[];
    parts: DesignPart[];
    /**
     * Which picture each vertex looks at: 0 = the model's own, 1 = the copy of it that the triangles made by a mirror_copy get (a copy uses the
     * texture coordinates of the part it copies, so without a picture of its own, painting the copy would paint the original too).
     */
    page: Uint8Array;
}

export interface OpLog {
    op: MeshOpName | "normals";
    label?: string;
    /** A sentence in plain words for the card when the op had to do something other than the plan said (runProgram collects them). */
    note?: string;
    ms: number;
    /** Free-form counts of what the op did ("deleted", "capped", "moved" ...). */
    [key: string]: unknown;
}

export interface RunProgress {
    /** 1-based index of the op that starts, and how many there are. */
    index: number;
    total: number;
    op: MeshOpName;
    label: string;
}
