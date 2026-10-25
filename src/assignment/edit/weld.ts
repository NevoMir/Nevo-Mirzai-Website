// Welding: vertices at the same place (a texture seam stores a point twice) get one id. A numeric hash on positions quantised to
// `cellMm` (no string keys: a 300k-vertex mesh welds in a few tens of milliseconds). Two points that are bit-identical, as seam
// duplicates are, always fall in the same cell whatever the cell size is.

export interface Weld {
    /** The weld id of every vertex. */
    ids: Int32Array;
    /** How many distinct ids there are. */
    count: number;
}

export function weldIds(Q: Float32Array, cellMm = 0.05): Weld {
    const n = Q.length / 3;
    const ids = new Int32Array(n);
    const qx = new Int32Array(n);
    const qy = new Int32Array(n);
    const qz = new Int32Array(n);
    let size = 16;
    while (size < n * 2) size <<= 1;
    const mask = size - 1;
    const table = new Int32Array(size).fill(-1);
    let count = 0;
    for (let v = 0; v < n; v++) {
        const x = Math.round(Q[v * 3] / cellMm);
        const y = Math.round(Q[v * 3 + 1] / cellMm);
        const z = Math.round(Q[v * 3 + 2] / cellMm);
        qx[v] = x;
        qy[v] = y;
        qz[v] = z;
        let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
        h ^= h >>> 15;
        h = Math.imul(h, 0x2c1b3c6d);
        h ^= h >>> 12;
        let slot = h & mask;
        for (;;) {
            const u = table[slot];
            if (u === -1) {
                table[slot] = v;
                ids[v] = count++;
                break;
            }
            if (qx[u] === x && qy[u] === y && qz[u] === z) {
                ids[v] = ids[u];
                break;
            }
            slot = (slot + 1) & mask;
        }
    }
    return { ids, count };
}
