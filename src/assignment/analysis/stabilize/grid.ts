// Occupancy-grid geometry for the stabilizer: the same definitions as structure.ts (supported, bodies, reach,
// per-body centre of gravity against the convex hull of the body's ground cells), but on a plain Uint8Array so a
// candidate fix can be re-evaluated in ~0.1 ms. Parity with analyzeStructure is tested in scripts/assignment/test-stabilize.mjs.

import { convexHull, hullDistance } from "../geometry.ts";
import type { Vec2, Vec3 } from "../types.ts";

export interface Dims {
    gx: number;
    gy: number;
    gz: number;
}

export const cellIndex = (d: Dims, i: number, j: number, k: number): number => (k * d.gy + j) * d.gx + i;

export function cellCoords(d: Dims, c: number): Vec3 {
    const plane = d.gx * d.gy;
    const k = (c / plane) | 0;
    const r = c - k * plane;
    const j = (r / d.gx) | 0;
    return [r - j * d.gx, j, k];
}

export const inGrid = (d: Dims, i: number, j: number, k: number): boolean => i >= 0 && j >= 0 && k >= 0 && i < d.gx && j < d.gy && k < d.gz;

/** Face neighbours (di, dj, dk). Indices 0..3 are horizontal, 4 = up, 5 = down. */
export const NB6: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];
const DIAG: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
];

export interface BodyInfo {
    id: number;
    cells: number[];
    grounded: boolean;
}

export interface CogInfo {
    bodyId: number;
    cogMm: Vec3;
    marginMm: number; // signed distance of the COG ground point to the support hull (< 0 = outside)
    inside: boolean;
    tip: Vec2 | null; // unit vector the body tips towards (when outside)
    hull: Vec2[];
    /** Smooth shortfall of the margin in 8 compass directions (mm^2 / bs^2); 0 when every direction has >= target. */
    phi: number;
}

export interface Geometry {
    dims: Dims;
    count: number;
    supported: Uint8Array;
    bodyOf: Int32Array; // -1 = empty cell
    bodies: BodyInfo[];
    reach: Int32Array; // -1 = empty or floating
    floatingCells: number;
    overreachCells: number;
    overreachExcess: number; // sum over cells of max(0, reach - limit)
    longestReach: number;
    sumReach: number;
    cogs: CogInfo[]; // one per grounded body that touches the ground
    weakest: CogInfo | null; // smallest margin
    marginMm: number; // weakest margin (Infinity when nothing is grounded)
    cogPhi: number; // sum of phi over bodies
}

export function evaluateGeometry(occ: Uint8Array, d: Dims, bs: number, limit: number, targetMarginMm: number): Geometry {
    const N = occ.length;
    const plane = d.gx * d.gy;
    let count = 0;

    // supported: an unbroken column to the ground (cells are ordered bottom-up)
    const supported = new Uint8Array(N);
    for (let c = 0; c < N; c++) {
        if (!occ[c]) continue;
        count++;
        supported[c] = c < plane ? 1 : supported[c - plane] ? 1 : 0;
    }

    // bodies: 6-connected components
    const bodyOf = new Int32Array(N).fill(-1);
    const bodies: BodyInfo[] = [];
    const stack = new Int32Array(N);
    for (let s = 0; s < N; s++) {
        if (!occ[s] || bodyOf[s] >= 0) continue;
        const id = bodies.length;
        const cells: number[] = [];
        let top = 0;
        stack[top++] = s;
        bodyOf[s] = id;
        let grounded = false;
        while (top > 0) {
            const c = stack[--top];
            cells.push(c);
            if (c < plane) grounded = true;
            const k = (c / plane) | 0;
            const r = c - k * plane;
            const j = (r / d.gx) | 0;
            const i = r - j * d.gx;
            for (let q = 0; q < 6; q++) {
                const di = NB6[q][0];
                const dj = NB6[q][1];
                const dk = NB6[q][2];
                const ni = i + di;
                const nj = j + dj;
                const nk = k + dk;
                if (ni < 0 || nj < 0 || nk < 0 || ni >= d.gx || nj >= d.gy || nk >= d.gz) continue;
                const n = (nk * d.gy + nj) * d.gx + ni;
                if (occ[n] && bodyOf[n] < 0) {
                    bodyOf[n] = id;
                    stack[top++] = n;
                }
            }
        }
        bodies.push({ id, cells, grounded });
    }

    const reach = computeReach(occ, d, supported);
    let floatingCells = 0;
    let overreachCells = 0;
    let overreachExcess = 0;
    let longestReach = 0;
    let sumReach = 0;
    for (const b of bodies) {
        if (!b.grounded) {
            floatingCells += b.cells.length;
            continue;
        }
        for (const c of b.cells) {
            const r = reach[c];
            sumReach += r;
            if (r > longestReach) longestReach = r;
            if (r > limit) {
                overreachCells++;
                overreachExcess += r - limit;
            }
        }
    }

    const cogs: CogInfo[] = [];
    for (const b of bodies) {
        if (!b.grounded) continue;
        const info = bodyCog(b, d, bs, targetMarginMm);
        if (info) cogs.push(info);
    }
    let weakest: CogInfo | null = null;
    let cogPhi = 0;
    for (const c of cogs) {
        cogPhi += c.phi;
        if (!weakest || c.marginMm < weakest.marginMm - 1e-9 || (Math.abs(c.marginMm - weakest.marginMm) <= 1e-9 && bodies[c.bodyId].cells.length > bodies[weakest.bodyId].cells.length)) weakest = c;
    }
    return {
        dims: d,
        count,
        supported,
        bodyOf,
        bodies,
        reach,
        floatingCells,
        overreachCells,
        overreachExcess,
        longestReach,
        sumReach,
        cogs,
        weakest,
        marginMm: weakest ? weakest.marginMm : Infinity,
        cogPhi,
    };
}

/** Horizontal block steps to the nearest supported cell (vertical steps are free): see structure.ts reachFrom. */
export function computeReach(occ: Uint8Array, d: Dims, supported: Uint8Array): Int32Array {
    const N = occ.length;
    const plane = d.gx * d.gy;
    const reach = new Int32Array(N).fill(-1);
    let level: number[] = [];
    for (let c = 0; c < N; c++) {
        if (occ[c] && supported[c]) {
            reach[c] = 0;
            level.push(c);
        }
    }
    const at = (i: number, j: number, k: number): number => (i < 0 || j < 0 || k < 0 || i >= d.gx || j >= d.gy || k >= d.gz ? -1 : (k * d.gy + j) * d.gx + i);
    for (let depth = 0; level.length > 0; depth++) {
        for (let q = 0; q < level.length; q++) {
            const c = level[q];
            if (c + plane < N && occ[c + plane] && reach[c + plane] < 0) {
                reach[c + plane] = depth;
                level.push(c + plane);
            }
            if (c >= plane && occ[c - plane] && reach[c - plane] < 0) {
                reach[c - plane] = depth;
                level.push(c - plane);
            }
        }
        const next: number[] = [];
        for (const c of level) {
            const k = (c / plane) | 0;
            const r = c - k * plane;
            const j = (r / d.gx) | 0;
            const i = r - j * d.gx;
            for (let q = 0; q < 4; q++) {
                const n = at(i + NB6[q][0], j + NB6[q][1], k);
                if (n >= 0 && occ[n] && reach[n] < 0) {
                    reach[n] = depth + 1;
                    next.push(n);
                }
            }
            for (const [di, dj] of DIAG) {
                const n = at(i + di, j + dj, k);
                if (n < 0 || !occ[n] || reach[n] >= 0) continue;
                const a = at(i + di, j, k);
                const b = at(i, j + dj, k);
                if ((a < 0 || !occ[a]) && (b < 0 || !occ[b])) continue;
                reach[n] = depth + 1;
                next.push(n);
            }
        }
        level = next;
    }
    return reach;
}

const COMPASS: ReadonlyArray<Vec2> = [
    [1, 0],
    [Math.SQRT1_2, Math.SQRT1_2],
    [0, 1],
    [-Math.SQRT1_2, Math.SQRT1_2],
    [-1, 0],
    [-Math.SQRT1_2, -Math.SQRT1_2],
    [0, -1],
    [Math.SQRT1_2, -Math.SQRT1_2],
];

function bodyCog(body: BodyInfo, d: Dims, bs: number, target: number): CogInfo | null {
    const corners: Vec2[] = [];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let grounded = 0;
    for (const c of body.cells) {
        const [i, j, k] = cellCoords(d, c);
        sx += (i + 0.5) * bs;
        sy += (j + 0.5) * bs;
        sz += (k + 0.5) * bs;
        if (k === 0) {
            grounded++;
            corners.push([i * bs, j * bs], [(i + 1) * bs, j * bs], [(i + 1) * bs, (j + 1) * bs], [i * bs, (j + 1) * bs]);
        }
    }
    if (grounded === 0) return null;
    const n = body.cells.length;
    const cog: Vec3 = [sx / n, sy / n, sz / n];
    const p: Vec2 = [cog[0], cog[1]];
    const hull = convexHull(corners);
    const { signed, nearest } = hullDistance(p, hull);
    const inside = signed >= 0;
    let tip: Vec2 | null = null;
    if (!inside) {
        const dx = p[0] - nearest[0];
        const dy = p[1] - nearest[1];
        const len = Math.hypot(dx, dy);
        tip = len > 0 ? [dx / len, dy / len] : null;
    }
    // smooth shortfall: distance to the hull boundary along 8 compass rays (the signed margin when outside)
    let phi = 0;
    for (const u of COMPASS) {
        let r: number;
        if (!inside) r = signed;
        else {
            r = Infinity;
            for (let e = 0; e < hull.length; e++) {
                const a = hull[e];
                const b = hull[(e + 1) % hull.length];
                const ex = b[0] - a[0];
                const ey = b[1] - a[1];
                const len = Math.hypot(ex, ey);
                if (len === 0) continue;
                const nx = ey / len; // outward normal (CCW hull)
                const ny = -ex / len;
                const den = u[0] * nx + u[1] * ny;
                if (den <= 1e-12) continue;
                const t = ((a[0] - p[0]) * nx + (a[1] - p[1]) * ny) / den;
                if (t < r) r = t;
            }
            if (!Number.isFinite(r)) r = 0;
        }
        const short = Math.max(0, target - r) / bs;
        phi += short * short;
    }
    return { bodyId: body.id, cogMm: cog, marginMm: signed, inside, tip, hull, phi };
}

/** Number of occupied face neighbours of a cell. */
export function occupiedNeighbours(occ: Uint8Array, d: Dims, c: number): number {
    const [i, j, k] = cellCoords(d, c);
    let n = 0;
    for (const [di, dj, dk] of NB6) {
        const ni = i + di;
        const nj = j + dj;
        const nk = k + dk;
        if (inGrid(d, ni, nj, nk) && occ[cellIndex(d, ni, nj, nk)]) n++;
    }
    return n;
}
