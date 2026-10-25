// The edit frame: millimetres, Z up, ground z = 0, x/y centred, the whole model scaled so its longest side is 1000 mm (the scale the
// structural analysis uses). glTF is Y up, so a glTF point (x, y, z) is (x, -z, y) here. The frame is rebuilt from the file on every edit,
// and its transform is kept so the result goes back into the file's own units.

import type { MeshSource } from "./readMeshGlb.ts";
import { refreshNormals } from "./normals.ts";
import type { EditMesh, Vec3 } from "./types.ts";

export interface EditFrame {
    /** mm per source unit (the file is in metres, so a 0.5 m model has scale 2000). */
    scale: number;
    /** The point of the file (Z up, metres) that is the frame's origin: centred on x/y, on the ground in z. */
    origin: Vec3;
    /** The size of everything (the mesh and the parts an earlier edit added), mm. */
    sizeMm: Vec3;
}

/** A piece of the file that an edit leaves alone, in the frame (for the pictures and the facts). */
export interface FramePiece {
    nodeIndex: number;
    name: string;
    /** mm, Z up. */
    Q: Float32Array;
    idx: Uint32Array;
    color: [number, number, number];
    min: Vec3;
    max: Vec3;
}

/** glTF world (x, y, z) -> Z up (x, -z, y). */
export function zUpOf(p: Float32Array): Float32Array {
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
        out[i] = p[i];
        out[i + 1] = -p[i + 2];
        out[i + 2] = p[i + 1];
    }
    return out;
}

/** The frame that fits `sets` (Z-up positions, source units) in a 1000 mm cube on the ground. */
export function makeFrame(sets: readonly Float32Array[]): EditFrame {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const P of sets) {
        for (let i = 0; i < P.length; i += 3) {
            for (let a = 0; a < 3; a++) {
                const v = P[i + a];
                if (v < min[a]) min[a] = v;
                if (v > max[a]) max[a] = v;
            }
        }
    }
    if (!Number.isFinite(min[0])) return { scale: 1000, origin: [0, 0, 0], sizeMm: [0, 0, 0] };
    const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const scale = longest > 0 ? 1000 / longest : 1000;
    return {
        scale,
        origin: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]],
        sizeMm: [(max[0] - min[0]) * scale, (max[1] - min[1]) * scale, (max[2] - min[2]) * scale],
    };
}

/** Z-up source positions -> the frame (mm). */
export function toFrame(P: Float32Array, frame: EditFrame): Float32Array {
    const out = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = (P[i + a] - frame.origin[a]) * frame.scale;
    return out;
}

/** Frame mm -> Z-up source positions. */
export function fromFrame(Q: Float32Array, frame: EditFrame): Float32Array {
    const out = new Float32Array(Q.length);
    for (let i = 0; i < Q.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = Q[i + a] / frame.scale + frame.origin[a];
    return out;
}

const boundsOf = (Q: Float32Array): { min: Vec3; max: Vec3 } => {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < Q.length; i += 3) for (let a = 0; a < 3; a++) { const v = Q[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
    return { min, max };
};

export interface EditSetup {
    mesh: EditMesh;
    frame: EditFrame;
    /** True when the file has texture coordinates (a recolor of a region needs them). */
    hasUv: boolean;
    pieces: FramePiece[];
}

/** The mesh and the untouched pieces of a read file, in the edit frame. */
export function buildEditSetup(source: MeshSource): EditSetup {
    const zMain = zUpOf(source.positions);
    const zPieces = source.carried.map((piece) => zUpOf(piece.positions));
    const frame = makeFrame([zMain, ...zPieces]);
    const Q = toFrame(zMain, frame);
    const n = Q.length / 3;
    const nor = new Float32Array(n * 3);
    if (source.normals) {
        for (let i = 0; i < n; i++) {
            nor[i * 3] = source.normals[i * 3];
            nor[i * 3 + 1] = -source.normals[i * 3 + 2];
            nor[i * 3 + 2] = source.normals[i * 3 + 1];
        }
    } else {
        refreshNormals(Q, source.indices, nor, null);
    }
    const pieces: FramePiece[] = source.carried.map((piece, i) => {
        const pQ = toFrame(zPieces[i], frame);
        const { min, max } = boundsOf(pQ);
        return { nodeIndex: piece.nodeIndex, name: piece.name, Q: pQ, idx: piece.indices, color: piece.color, min, max };
    });
    return {
        mesh: { Q, uv: source.uv ? Float32Array.from(source.uv) : new Float32Array(n * 2), nor, idx: Uint32Array.from(source.indices) },
        frame,
        hasUv: source.uv !== null,
        pieces,
    };
}
