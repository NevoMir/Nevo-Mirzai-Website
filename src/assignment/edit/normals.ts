// Smooth vertex normals: area-weighted over the triangles around a welded point, so a texture seam does not show as a crease.

import { weldIds } from "./weld.ts";

/**
 * Writes the normal of every vertex in `changed` (all of them when null) into `nor`. Normals of the other vertices stay as they are, so
 * an in-place edit (stretch, move) re-lights only what moved. Returns how many vertices got a new normal.
 */
export function refreshNormals(Q: Float32Array, idx: Uint32Array, nor: Float32Array, changed: Uint8Array | null): number {
    const n = Q.length / 3;
    const { ids, count } = weldIds(Q);
    const acc = new Float64Array(count * 3);
    const nt = idx.length / 3;
    for (let t = 0; t < nt; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        const ux = Q[b * 3] - Q[a * 3], uy = Q[b * 3 + 1] - Q[a * 3 + 1], uz = Q[b * 3 + 2] - Q[a * 3 + 2];
        const vx = Q[c * 3] - Q[a * 3], vy = Q[c * 3 + 1] - Q[a * 3 + 1], vz = Q[c * 3 + 2] - Q[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // twice the area, as a vector
        let k = ids[a] * 3;
        acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz;
        k = ids[b] * 3;
        acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz;
        k = ids[c] * 3;
        acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz;
    }
    let touched = 0;
    for (let v = 0; v < n; v++) {
        if (changed && !changed[v]) continue;
        const k = ids[v] * 3;
        const len = Math.hypot(acc[k], acc[k + 1], acc[k + 2]);
        if (len === 0) {
            // A point no triangle has an area at: straight up is as good as any.
            nor[v * 3] = 0;
            nor[v * 3 + 1] = 0;
            nor[v * 3 + 2] = 1;
        } else {
            nor[v * 3] = acc[k] / len;
            nor[v * 3 + 1] = acc[k + 1] / len;
            nor[v * 3 + 2] = acc[k + 2] / len;
        }
        touched++;
    }
    return touched;
}
