// The selection of an op: a soft box. Every vertex gets a weight 0..1 from the boxes (with a feathered edge) minus the exclude boxes.

import type { MeshBox } from "../shared/meshProgram.ts";

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t: number): number => t * t * (3 - 2 * t);

export interface Where {
    boxes: readonly MeshBox[];
    exclude: readonly MeshBox[];
    feather_mm: number;
}

/**
 * Per-vertex selection weight of `where`: for each box and axis smooth(clamp((p - (lo - f/2)) / f)) * smooth(clamp(((hi + f/2) - p) / f)),
 * multiplied over the axes; the selection is the maximum over the boxes, times (1 - the strongest exclude). No boxes = everything (weight 1).
 * `skipAxis` leaves one axis out of the boxes (a stretch only uses the footprint of its selection).
 */
export function selectionWeights(Q: Float32Array, where: Where, skipAxis = -1): Float32Array {
    const n = Q.length / 3;
    const w = new Float32Array(n);
    const f = Math.min(200, Math.max(0.5, where.feather_mm));
    const half = f / 2;
    const boxes = where.boxes;
    const excl = where.exclude;
    const inBox = (x: number, y: number, z: number, b: MeshBox): number => {
        let m = 1;
        for (let a = 0; a < 3 && m > 0; a++) {
            if (a === skipAxis) continue;
            const p = a === 0 ? x : a === 1 ? y : z;
            m *= smooth(clamp01((p - (b.min[a] - half)) / f)) * smooth(clamp01((b.max[a] + half - p) / f));
        }
        return m;
    };
    for (let v = 0; v < n; v++) {
        const x = Q[v * 3], y = Q[v * 3 + 1], z = Q[v * 3 + 2];
        let m = boxes.length === 0 ? 1 : 0;
        for (const b of boxes) m = Math.max(m, inBox(x, y, z, b));
        if (m > 0) for (const b of excl) m *= 1 - inBox(x, y, z, b);
        w[v] = m;
    }
    return w;
}

export function countPositive(w: Float32Array): number {
    let c = 0;
    for (let i = 0; i < w.length; i++) if (w[i] > 0) c++;
    return c;
}
