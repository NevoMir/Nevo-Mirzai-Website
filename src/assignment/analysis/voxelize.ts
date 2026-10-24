// Triangles -> solid occupancy of the 10 x 10 x 10 block grid.
//
// Method (made for imperfect AI meshes: holes, self-intersections, several shells, flipped faces):
//   1. Scale the model so its longest side is `targetSizeMm`, centre it in X/Y inside the target footprint and
//      put its lowest point on z = 0 (AnalysisTransform).
//   2. Rasterise on a fine grid of cells that are 1/SUBDIVISION of a block (100 / 12 = 8.3 mm cells, 120^3 cells
//      for the 10-block grid) plus a one-cell border. A cell is a SURFACE cell when a triangle touches it (exact
//      triangle-box test, Akenine-Moeller separating axis theorem, only for the cells in the triangle's bounding
//      range). Touching is closed: a triangle that lies exactly on a cell face touches the cells on BOTH sides.
//   3. Flood-fill the OUTSIDE from the border (6-connectivity). Every cell the fill cannot reach is solid: the
//      surface cells and everything enclosed by them. No normals, winding or watertightness are needed, so a
//      closed shell is filled and overlapping shells just merge. An open shell (a hole larger than a cell) leaks:
//      the inside is reached by the fill and only the thin skin counts as solid; the "thin-features" warning
//      reports that.
//   4. A block's fill = solid fine cells inside it / CELLS_PER_BLOCK. A block is "used" when its fill reaches the
//      threshold (that step lives in structure.ts so the threshold can change without voxelising again).
//
// Surface cells are conservative (a cell the surface only grazes counts), so the solid is up to one fine cell
// (8.3 mm) fatter than the true volume at every face, and a block's fill is an ESTIMATE of its volume share that
// errs high by up to 1/SUBDIVISION (8 points) per exposed face, not a measurement. That is deliberate: it keeps
// legs and arms thinner than a block alive. The cell is small enough that one layer of it (1/12 = 8.3% of a
// block) stays below the lowest fill threshold the app offers (10%), so a face that merely grazes the next block
// (or lies exactly on the boundary between two blocks) never turns that block into a component. Everything is
// typed arrays: no per-cell objects, so 2M triangles fit in a worker in well under two seconds.

import type { AnalysisSettings, AnalysisTransform, TriangleSoup, Vec3 } from "./types.ts";
import { assertGridSize } from "./settings.ts";

/**
 * Fine cells per block edge: 12 -> 8.3 mm cells for 100 mm blocks. One layer of them is 1/12 = 8.3% of a block,
 * which must stay below the lowest fill threshold (10%) or a grazing face would make a block of its own.
 */
export const SUBDIVISION = 12;
export const CELLS_PER_BLOCK = SUBDIVISION * SUBDIVISION * SUBDIVISION;

export type AnalysisStage = "voxelize" | "flood" | "analyze" | "stress";
/** `fraction` is overall progress, 0-1. */
export type ProgressFn = (fraction: number, stage: AnalysisStage) => void;

export interface VoxelGrid {
    /** What the grid was built for; a grid can only be re-analysed with settings that agree on these. */
    targetSizeMm: number;
    blockSizeMm: number;
    gridSize: Vec3; // blocks per axis
    transform: AnalysisTransform;
    sizeMm: Vec3; // the scaled model's bounding box
    /** Solid fine cells per block (0..CELLS_PER_BLOCK), index (k * gy + j) * gx + i. */
    solid: Uint16Array;
    totalSolid: number; // sum of `solid`
    surfaceCells: number; // fine cells touched by a triangle (diagnostics)
    triangles: { total: number; used: number; skipped: number };
    voxelizeMs: number;
    /**
     * Set by gridFromAssembly: the cells are exact blocks of a block assembly, not the voxelisation of a mesh. Every block is
     * then whole (nothing is "weakly filled"), so advice about the fill threshold does not apply.
     */
    fromAssembly?: boolean;
}

const OUTSIDE = 2;
const SURFACE = 1;
// Tolerance (mm) so a triangle that merely touches a cell face counts as touching it.
const TOUCH_EPS = 1e-7;
// The same idea in cell units, for deciding that a coordinate sits exactly on a cell face.
const BOUNDARY_EPS = 1e-9;
// A triangle whose bounding range covers more cells than this is cut in two (at most MAX_SPLIT_DEPTH times).
const MAX_RANGE_CELLS = 32;
const MAX_SPLIT_DEPTH = 40;

// ---------- Triangle / box overlap ----------

/** True when a separating axis exists for an edge e (given the vertices relative to the box centre). */
function edgeAxesSeparate(
    ex: number,
    ey: number,
    ez: number,
    v0x: number,
    v0y: number,
    v0z: number,
    v1x: number,
    v1y: number,
    v1z: number,
    v2x: number,
    v2y: number,
    v2z: number,
    h: number,
): boolean {
    const fx = Math.abs(ex);
    const fy = Math.abs(ey);
    const fz = Math.abs(ez);
    // Axis e x X = (0, ez, -ey)
    let p0 = ez * v0y - ey * v0z;
    let p1 = ez * v1y - ey * v1z;
    let p2 = ez * v2y - ey * v2z;
    let rad = h * (fz + fy);
    if (Math.min(p0, p1, p2) > rad || Math.max(p0, p1, p2) < -rad) return true;
    // Axis e x Y = (-ez, 0, ex)
    p0 = ex * v0z - ez * v0x;
    p1 = ex * v1z - ez * v1x;
    p2 = ex * v2z - ez * v2x;
    rad = h * (fz + fx);
    if (Math.min(p0, p1, p2) > rad || Math.max(p0, p1, p2) < -rad) return true;
    // Axis e x Z = (ey, -ex, 0)
    p0 = ey * v0x - ex * v0y;
    p1 = ey * v1x - ex * v1y;
    p2 = ey * v2x - ex * v2y;
    rad = h * (fy + fx);
    return Math.min(p0, p1, p2) > rad || Math.max(p0, p1, p2) < -rad;
}

/**
 * Exact triangle / axis-aligned cube overlap (closed: touching counts). The vertices are relative to the cube's
 * centre and `h` is its half edge. The three box-face axes are not tested: callers only ask about cells inside
 * the triangle's bounding range, where they always overlap.
 */
export function triBoxOverlap(
    v0x: number,
    v0y: number,
    v0z: number,
    v1x: number,
    v1y: number,
    v1z: number,
    v2x: number,
    v2y: number,
    v2z: number,
    h: number,
): boolean {
    const e0x = v1x - v0x;
    const e0y = v1y - v0y;
    const e0z = v1z - v0z;
    const e1x = v2x - v1x;
    const e1y = v2y - v1y;
    const e1z = v2z - v1z;
    // The plane test first: it is the cheapest and rejects most cells of a long diagonal triangle.
    const nx = e0y * e1z - e0z * e1y;
    const ny = e0z * e1x - e0x * e1z;
    const nz = e0x * e1y - e0y * e1x;
    const planeRad = h * (Math.abs(nx) + Math.abs(ny) + Math.abs(nz));
    if (Math.abs(nx * v0x + ny * v0y + nz * v0z) > planeRad) return false;
    if (edgeAxesSeparate(e0x, e0y, e0z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, h)) return false;
    if (edgeAxesSeparate(e1x, e1y, e1z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, h)) return false;
    return !edgeAxesSeparate(v0x - v2x, v0y - v2y, v0z - v2z, v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z, h);
}

// ---------- Voxelisation ----------

interface Bounds {
    min: Vec3;
    max: Vec3;
    valid: number;
}

/** Bounding box of the triangles whose nine coordinates are all finite. */
function finiteBounds(p: Float32Array, triCount: number): Bounds {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let valid = 0;
    for (let t = 0, o = 0; t < triCount; t++, o += 9) {
        // One NaN or Infinity anywhere makes the sum non-finite.
        if (!Number.isFinite(p[o] + p[o + 1] + p[o + 2] + p[o + 3] + p[o + 4] + p[o + 5] + p[o + 6] + p[o + 7] + p[o + 8])) continue;
        valid++;
        for (let v = 0; v < 9; v += 3) {
            const x = p[o + v];
            const y = p[o + v + 1];
            const z = p[o + v + 2];
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], valid };
}

/** Voxelises the soup. `settings` must already be normalised (normalizeSettings). */
export function voxelize(soup: TriangleSoup, settings: AnalysisSettings, onProgress?: ProgressFn): VoxelGrid {
    const started = performance.now();
    const g = assertGridSize(settings, SUBDIVISION);
    const blockSize = settings.blockSizeMm;
    const positions = soup.positions;
    const triCount = Math.floor(positions.length / 9);
    const bounds = finiteBounds(positions, triCount);

    const n = g * SUBDIVISION; // fine cells per axis
    const cs = blockSize / SUBDIVISION; // fine cell edge, mm
    const inv = 1 / cs;
    const P = n + 2; // padded fine grid: a one-cell border that is never a surface
    const PP = P * P;

    // ----- transform -----
    const ext: Vec3 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
    const longest = Math.max(ext[0], ext[1], ext[2]);
    const hasGeometry = bounds.valid > 0 && Number.isFinite(longest) && longest > 0;
    const factor = hasGeometry ? settings.targetSizeMm / longest : 1;
    const modelMin: Vec3 = bounds.valid > 0 ? bounds.min : [0, 0, 0];
    const sizeMm: Vec3 = bounds.valid > 0 ? [ext[0] * factor, ext[1] * factor, ext[2] * factor] : [0, 0, 0];
    const offsetMm: Vec3 = [(settings.targetSizeMm - sizeMm[0]) / 2, (settings.targetSizeMm - sizeMm[1]) / 2, 0];
    const transform: AnalysisTransform = { factor, modelMin, offsetMm };

    const solid = new Uint16Array(g * g * g);
    const grid: VoxelGrid = {
        targetSizeMm: settings.targetSizeMm,
        blockSizeMm: blockSize,
        gridSize: [g, g, g],
        transform,
        sizeMm,
        solid,
        totalSolid: 0,
        surfaceCells: 0,
        triangles: { total: triCount, used: 0, skipped: triCount - bounds.valid },
        voxelizeMs: 0,
    };
    if (!hasGeometry) {
        // Nothing (or only a single point) to voxelise: an empty grid, which the analysis reports as "no blocks".
        grid.voxelizeMs = performance.now() - started;
        onProgress?.(0.9, "voxelize");
        return grid;
    }
    grid.triangles.used = bounds.valid;

    // ----- surface cells -----
    const state = new Uint8Array(PP * P);
    const [minX, minY, minZ] = modelMin;
    const [offX, offY, offZ] = offsetMm;
    const last = n - 1;
    const half = cs / 2 + TOUCH_EPS;
    const clampCell = (c: number): number => (c < 0 ? 0 : c > last ? last : c);
    const reportEvery = 1 << 15;

    /** Marks the cells a triangle (in analysis mm) touches. Big triangles are split first, see MAX_RANGE_CELLS. */
    const mark = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, depth: number): void => {
        // Cell of each vertex: those cells are touched for sure, so they need no overlap test.
        const a0 = clampCell(Math.floor(ax * inv));
        const a1 = clampCell(Math.floor(ay * inv));
        const a2 = clampCell(Math.floor(az * inv));
        const b0 = clampCell(Math.floor(bx * inv));
        const b1 = clampCell(Math.floor(by * inv));
        const b2 = clampCell(Math.floor(bz * inv));
        const c0 = clampCell(Math.floor(cx * inv));
        const c1 = clampCell(Math.floor(cy * inv));
        const c2 = clampCell(Math.floor(cz * inv));
        state[((a2 + 1) * P + (a1 + 1)) * P + a0 + 1] = SURFACE;
        state[((b2 + 1) * P + (b1 + 1)) * P + b0 + 1] = SURFACE;
        state[((c2 + 1) * P + (c1 + 1)) * P + c0 + 1] = SURFACE;
        // Touching is closed, so a triangle whose lowest coordinate lies exactly on a cell face also touches the
        // cell below it. floor() alone would only reach the cell above (the vertex's own cell): a face on a cell
        // boundary then marked the cell on its + side and never the one on its - side. BOUNDARY_EPS (in cells)
        // absorbs the float noise of the transform.
        const x0 = clampCell(Math.floor(Math.min(ax, bx, cx) * inv - BOUNDARY_EPS));
        const x1 = Math.max(a0, b0, c0);
        const y0 = clampCell(Math.floor(Math.min(ay, by, cy) * inv - BOUNDARY_EPS));
        const y1 = Math.max(a1, b1, c1);
        const z0 = clampCell(Math.floor(Math.min(az, bz, cz) * inv - BOUNDARY_EPS));
        const z1 = Math.max(a2, b2, c2);
        if (x0 === x1 && y0 === y1 && z0 === z1) return; // the whole triangle sits in one cell
        if (depth < MAX_SPLIT_DEPTH && (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_RANGE_CELLS) {
            // A long or large triangle: cut its longest edge in two, so the pieces have tight cell ranges (a long
            // sliver would otherwise be tested against thousands of cells it does not touch).
            const ab = (bx - ax) * (bx - ax) + (by - ay) * (by - ay) + (bz - az) * (bz - az);
            const bc = (cx - bx) * (cx - bx) + (cy - by) * (cy - by) + (cz - bz) * (cz - bz);
            const ca = (ax - cx) * (ax - cx) + (ay - cy) * (ay - cy) + (az - cz) * (az - cz);
            if (ab >= bc && ab >= ca) {
                const mx = (ax + bx) / 2;
                const my = (ay + by) / 2;
                const mz = (az + bz) / 2;
                mark(ax, ay, az, mx, my, mz, cx, cy, cz, depth + 1);
                mark(mx, my, mz, bx, by, bz, cx, cy, cz, depth + 1);
            } else if (bc >= ca) {
                const mx = (bx + cx) / 2;
                const my = (by + cy) / 2;
                const mz = (bz + cz) / 2;
                mark(ax, ay, az, bx, by, bz, mx, my, mz, depth + 1);
                mark(ax, ay, az, mx, my, mz, cx, cy, cz, depth + 1);
            } else {
                const mx = (cx + ax) / 2;
                const my = (cy + ay) / 2;
                const mz = (cz + az) / 2;
                mark(ax, ay, az, bx, by, bz, mx, my, mz, depth + 1);
                mark(mx, my, mz, bx, by, bz, cx, cy, cz, depth + 1);
            }
            return;
        }
        for (let z = z0; z <= z1; z++) {
            const centreZ = (z + 0.5) * cs;
            for (let y = y0; y <= y1; y++) {
                const centreY = (y + 0.5) * cs;
                const row = ((z + 1) * P + (y + 1)) * P + 1;
                for (let x = x0; x <= x1; x++) {
                    if (state[row + x] !== 0) continue; // already known to be surface
                    const centreX = (x + 0.5) * cs;
                    if (triBoxOverlap(ax - centreX, ay - centreY, az - centreZ, bx - centreX, by - centreY, bz - centreZ, cx - centreX, cy - centreY, cz - centreZ, half)) {
                        state[row + x] = SURFACE;
                    }
                }
            }
        }
    };

    for (let t = 0, o = 0; t < triCount; t++, o += 9) {
        if (onProgress !== undefined && (t & (reportEvery - 1)) === 0) onProgress((t / triCount) * 0.85, "voxelize");
        const px0 = positions[o];
        const py0 = positions[o + 1];
        const pz0 = positions[o + 2];
        const px1 = positions[o + 3];
        const py1 = positions[o + 4];
        const pz1 = positions[o + 5];
        const px2 = positions[o + 6];
        const py2 = positions[o + 7];
        const pz2 = positions[o + 8];
        if (!Number.isFinite(px0 + py0 + pz0 + px1 + py1 + pz1 + px2 + py2 + pz2)) continue;
        // To analysis millimetres.
        mark(
            (px0 - minX) * factor + offX,
            (py0 - minY) * factor + offY,
            (pz0 - minZ) * factor + offZ,
            (px1 - minX) * factor + offX,
            (py1 - minY) * factor + offY,
            (pz1 - minZ) * factor + offZ,
            (px2 - minX) * factor + offX,
            (py2 - minY) * factor + offY,
            (pz2 - minZ) * factor + offZ,
            0,
        );
    }

    // ----- flood-fill the outside from the border -----
    onProgress?.(0.85, "flood");
    const queue = new Int32Array(PP * P);
    let head = 0;
    let tail = 0;
    state[0] = OUTSIDE; // a corner of the border; the border is one connected shell of empty cells
    queue[tail++] = 0;
    while (head < tail) {
        const idx = queue[head++];
        const x = idx % P;
        const y = ((idx / P) | 0) % P;
        const z = (idx / PP) | 0;
        if (x > 0 && state[idx - 1] === 0) {
            state[idx - 1] = OUTSIDE;
            queue[tail++] = idx - 1;
        }
        if (x < P - 1 && state[idx + 1] === 0) {
            state[idx + 1] = OUTSIDE;
            queue[tail++] = idx + 1;
        }
        if (y > 0 && state[idx - P] === 0) {
            state[idx - P] = OUTSIDE;
            queue[tail++] = idx - P;
        }
        if (y < P - 1 && state[idx + P] === 0) {
            state[idx + P] = OUTSIDE;
            queue[tail++] = idx + P;
        }
        if (z > 0 && state[idx - PP] === 0) {
            state[idx - PP] = OUTSIDE;
            queue[tail++] = idx - PP;
        }
        if (z < P - 1 && state[idx + PP] === 0) {
            state[idx + PP] = OUTSIDE;
            queue[tail++] = idx + PP;
        }
    }

    // ----- count solid cells per block -----
    onProgress?.(0.9, "flood");
    let total = 0;
    let surface = 0;
    for (let z = 0; z < n; z++) {
        const bk = (z / SUBDIVISION) | 0;
        for (let y = 0; y < n; y++) {
            const rowBlocks = (bk * g + ((y / SUBDIVISION) | 0)) * g;
            const row = ((z + 1) * P + (y + 1)) * P + 1;
            for (let x = 0; x < n; x++) {
                const s = state[row + x];
                if (s === OUTSIDE) continue;
                if (s === SURFACE) surface++;
                solid[rowBlocks + ((x / SUBDIVISION) | 0)]++;
                total++;
            }
        }
    }
    grid.totalSolid = total;
    grid.surfaceCells = surface;
    grid.voxelizeMs = performance.now() - started;
    return grid;
}
