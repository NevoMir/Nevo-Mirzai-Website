// One edit session on one model file: open it (read, frame, decode the picture), describe it to the model, run a program on it, write the
// result. The Web Worker (meshEdit.worker.ts) and the main-thread fallback (runMeshEdit.ts) both drive this, and so do the Node tests, so
// there is one pipeline. Everything the file's bytes cost lives here: about 80 MB of arrays for a 28 MB Hunyuan model.

import { EDITED_GLB_LIMIT, MAX_EDIT_TRIANGLES, type MeshPackage, type MeshView } from "../shared/contract.ts";
import { sanitizeProgram, type MeshProgram } from "../shared/meshProgram.ts";
import { partPrimitive } from "../shared/partsGlb.ts";
import { describeMesh, zoomViews, type PictureFormat } from "./describeMesh.ts";
import { buildEditSetup, type EditSetup } from "./frame.ts";
import { writeEditedGlb } from "./patchGlb.ts";
import { readMeshGlb, type MeshSource } from "./readMeshGlb.ts";
import { runProgram } from "./runProgram.ts";
import { TEXTURE_SIDE, applyPaints, stackCopyPicture, type RawImage, type TextureCodec } from "./texture.ts";
import { MeshEditError, type OpLog, type RunProgress } from "./types.ts";

export interface SessionInfo {
    triangles: number;
    sizeMm: [number, number, number];
    textured: boolean;
    /** The browser can repaint the picture (region and whole-model recolor); false = a recolor is approximated or skipped. */
    canRepaint: boolean;
}

export interface RunOutput {
    glb: Uint8Array;
    /** What the card should say besides the summary ("the colour is an approximation in this browser"). */
    notes: string[];
    triangles: number;
    parts: number;
    log: OpLog[];
    ms: number;
}

export interface RunInput {
    program: MeshProgram;
    /** For the informative echo in the file: what was asked and which job planned it. */
    instruction: string;
    jobId: string | null;
    signal?: AbortSignal;
    onProgress?: (progress: RunProgress | { stage: "texture" | "writing" }) => void;
}

export interface Session {
    info: SessionInfo;
    describe(format: PictureFormat, size?: number): Promise<MeshPackage>;
    zoom(program: MeshProgram, format: PictureFormat): Promise<MeshView[]>;
    run(input: RunInput): Promise<RunOutput>;
}

/** Reads the file and gets it ready. Rejects with a MeshEditError("unsupported") whose message is fit for the person. */
export async function openSession(bytes: Uint8Array, codec: TextureCodec | null, originalPrompt: string | null): Promise<Session> {
    const read = readMeshGlb(bytes);
    if (!read.ok) throw new MeshEditError("unsupported", read.reason);
    const source: MeshSource = read.source;
    const setup: EditSetup = buildEditSetup(source);
    // One decode serves the pictures (vertex colours) and the recolor.
    let image: RawImage | null = null;
    if (codec && source.texture) image = await codec.decode(source.texture.bytes, source.texture.mime, TEXTURE_SIDE);
    const info: SessionInfo = {
        triangles: setup.mesh.idx.length / 3,
        sizeMm: [setup.frame.sizeMm[0], setup.frame.sizeMm[1], setup.frame.sizeMm[2]],
        textured: source.texture !== null,
        canRepaint: codec !== null && (source.texture === null || image !== null),
    };
    const base = { setup, source, image, originalPrompt };

    return {
        info,
        describe: (format, size) => describeMesh({ ...base, format, size }),
        zoom: (program, format) => zoomViews({ ...base, format }, program),
        run: async (input) => {
            const t0 = performance.now();
            // The plan came from the server and was cleaned there; it is cleaned again before anything runs on the model.
            const clean = sanitizeProgram(input.program);
            if (!clean.ok) throw new MeshEditError("failed", clean.error);
            if (!clean.program.applied || clean.program.ops.length === 0) throw new MeshEditError("failed", "There is nothing to do.");
            const { state, log, notes: runNotes } = runProgram(setup.mesh, clean.program, { signal: input.signal, onProgress: input.onProgress });
            if (input.signal?.aborted) throw new MeshEditError("aborted", "The edit was stopped.");

            let partTriangles = 0;
            const meshCache = new Map();
            for (const part of state.parts) partTriangles += partPrimitive(part.shape, part.size, meshCache).mesh.indices.length / 3;
            const triangles = state.idx.length / 3 + partTriangles;
            if (triangles > MAX_EDIT_TRIANGLES) throw new MeshEditError("toobig", "The result would be too detailed to save. Describe a smaller change.");

            input.onProgress?.({ stage: "texture" });
            const notes = [...clean.notes, ...runNotes];
            // A mirrored copy shares its picture with the original; when a region is repainted the copy gets a picture of its own, else the paint
            // would land on both.
            let picture = image;
            const uvBefore = state.uv;
            if (picture && source.texture && setup.hasUv && state.paints.some((p) => p.weights !== null) && state.page.some((p) => p === 1)) {
                const stacked = stackCopyPicture(picture, state.uv, state.page, source.texture.transform);
                if ("reason" in stacked) notes.push("The copy shares its colours with the original, so painting one of them paints both.");
                else {
                    picture = stacked.image;
                    state.uv = stacked.uv;
                }
            }
            let paint = await applyPaints(codec, source.texture, picture, state.uv, state.idx, state.paints, source.baseColor);
            // The coordinates only make sense with the stacked picture: if it could not be written, they go back.
            if (state.uv !== uvBefore && !paint.image) {
                state.uv = uvBefore;
                picture = image;
            }
            notes.push(...paint.notes);
            input.onProgress?.({ stage: "writing" });
            const echo = {
                version: 1,
                target: "mesh",
                made_by: "Assembly Studio",
                instruction: input.instruction.slice(0, 500),
                summary: clean.program.summary,
                ops: clean.program.ops.map((o) => ({ op: o.op, label: o.label })),
                notes,
                job_id: input.jobId,
            };
            const write = () => writeEditedGlb({ source, frame: setup.frame, mesh: state, hasUv: setup.hasUv, parts: state.parts, image: paint.image, baseColorFactor: paint.baseColorFactor, echo });
            let glb = write();
            // A large original (a 4096 px PNG is most of a Hunyuan file) that would not fit the upload: store the picture as a JPEG instead.
            if (glb.byteLength > EDITED_GLB_LIMIT && codec && picture && !paint.image) {
                paint = await applyPaints(codec, source.texture, picture, state.uv, state.idx, [{ color: "#808080", strength: 0, weights: null }], source.baseColor);
                glb = write();
            }
            if (glb.byteLength > EDITED_GLB_LIMIT) throw new MeshEditError("toobig", "The edited model is too large to save.");
            return { glb, notes, triangles, parts: state.parts.length, log, ms: Math.round(performance.now() - t0) };
        },
    };
}
