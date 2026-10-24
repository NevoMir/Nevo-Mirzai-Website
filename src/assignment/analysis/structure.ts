// Occupancy -> structural model: which blocks are supported, how far each overhang reaches, which parts are
// connected, and whether each free-standing structure would tip. The definitions are written out in
// definitions.ts (shown in the app and in the exported report); the code below follows them one to one.
//
//   supported   k = 0, or the block directly below is supported: an unbroken column down to the ground.
//   body        a 6-connected group of blocks (faces touching; edges and corners do not connect). Grounded when
//               any of its blocks is at k = 0, otherwise it is floating.
//   reach       for the blocks of a grounded body: the fewest HORIZONTAL block steps to a supported block. Moving
//               up or down is free, so a block hanging under (or standing on) an overhang shares its reach. A step
//               goes to a face neighbour, or diagonally across a corner (still one step) when at least one of the
//               two blocks beside that corner exists: the reach of a plate is the distance to its nearest
//               support, in the chessboard sense, not the length of a staircase to a corner.
//               supported = 0, cantilever = 1..limit, overreach = more than the limit.
//   cantilever  a 6-connected group of grounded blocks that are not supported: one arm, bridge or hanging part.
//   stability   per grounded body: its centre of gravity (every block weighs the same) against its own support
//               base, the convex hull of its blocks on the ground. Bodies that share no face carry no load
//               between them, so each stands or falls alone; the weakest one is reported.

import type { AnalysisSettings, AnalysisStats, Block, BlockStatus, Body, CantileverRun, Stability, Vec2, Vec3 } from "./types.ts";
import { CELLS_PER_BLOCK } from "./voxelize.ts";
import type { VoxelGrid } from "./voxelize.ts";
import { convexHull, hullDistance } from "./geometry.ts";

export interface Occupancy {
    fill: Float32Array; // per cell: share of the block filled (0-1)
    used: Uint8Array; // per cell: 1 when the block is part of the assembly
    coverage: number; // solid volume that ended up inside used blocks / all solid volume
}

/** Which blocks are used at `threshold`, and how much of the model they keep. Cheap: no voxelising. */
export function occupancyOf(grid: VoxelGrid, threshold: number): Occupancy {
    const count = grid.solid.length;
    const fill = new Float32Array(count);
    const used = new Uint8Array(count);
    let kept = 0;
    // 1e-9: a block that is exactly at the threshold counts (432 / 1728 = 0.25 must pass a 0.25 threshold).
    const min = threshold - 1e-9;
    for (let c = 0; c < count; c++) {
        const f = grid.solid[c] / CELLS_PER_BLOCK;
        fill[c] = f;
        if (f > 0 && f >= min) {
            used[c] = 1;
            kept += grid.solid[c];
        }
    }
    return { fill, used, coverage: grid.totalSolid > 0 ? kept / grid.totalSolid : 0 };
}

/** The model's solid volume kept if the fill threshold were `threshold` (for the "lower the threshold" hint). */
export function coverageAt(grid: VoxelGrid, threshold: number): number {
    return occupancyOf(grid, threshold).coverage;
}

export interface Structure {
    gridSize: Vec3;
    blocks: Block[];
    bodies: Body[];
    cantilevers: CantileverRun[];
    stability: Stability | null;
    stats: AnalysisStats;
    occupancy: Occupancy;
    /** Index in `blocks` per grid cell, -1 where there is no block. */
    blockAt: Int32Array;
}

/** Diagonal horizontal steps (di, dj): see the reach rule above. */
const DIAGONALS: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
];

/**
 * Which cells are part of a structure that touches the ground when the fill threshold is `threshold`: 1 for a
 * used cell whose 6-connected group contains a block at k = 0. Cheap (one flood fill over the grid), so the
 * issues can ask "would this part be held up at a lower threshold?" without analysing again.
 */
export function groundedCellsAt(grid: VoxelGrid, threshold: number): Uint8Array {
    const [gx, gy, gz] = grid.gridSize;
    const { used } = occupancyOf(grid, threshold);
    const grounded = new Uint8Array(used.length);
    const queue = new Int32Array(used.length);
    let head = 0;
    let tail = 0;
    for (let c = 0; c < gx * gy; c++) {
        if (used[c]) {
            grounded[c] = 1;
            queue[tail++] = c;
        }
    }
    const plane = gx * gy;
    while (head < tail) {
        const c = queue[head++];
        const i = c % gx;
        const j = ((c / gx) | 0) % gy;
        const k = (c / plane) | 0;
        const visit = (n: number) => {
            if (used[n] && !grounded[n]) {
                grounded[n] = 1;
                queue[tail++] = n;
            }
        };
        if (i > 0) visit(c - 1);
        if (i < gx - 1) visit(c + 1);
        if (j > 0) visit(c - gx);
        if (j < gy - 1) visit(c + gx);
        if (k > 0) visit(c - plane);
        if (k < gz - 1) visit(c + plane);
    }
    return grounded;
}

// The six face neighbours, as (di, dj, dk).
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

/**
 * Horizontal block steps from the `seeds` to every block, level by level; -1 where a block cannot be reached.
 * Vertical steps are free, a horizontal step goes to a face neighbour or across a corner (see the header), and
 * each costs 1. With the supported blocks as seeds this is every block's reach.
 */
export function reachFrom(blocks: Block[], blockAt: Int32Array, gridSize: Vec3, seeds: number[]): Int32Array {
    const [gx, gy, gz] = gridSize;
    const at = (i: number, j: number, k: number): number => {
        if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) return -1;
        return blockAt[(k * gy + j) * gx + i];
    };
    const neighbour = (b: Block, d: readonly [number, number, number]): number => at(b.cell[0] + d[0], b.cell[1] + d[1], b.cell[2] + d[2]);
    const reach = new Int32Array(blocks.length).fill(-1);
    let level: number[] = [];
    for (const b of seeds) {
        reach[b] = 0;
        level.push(b);
    }
    for (let depth = 0; level.length > 0; depth++) {
        // Free moves first, so that everything at distance `depth` is known before the next level is opened.
        for (let q = 0; q < level.length; q++) {
            const b = level[q];
            for (let d = 4; d < 6; d++) {
                const nb = neighbour(blocks[b], NEIGHBOURS[d]);
                if (nb >= 0 && reach[nb] < 0) {
                    reach[nb] = depth;
                    level.push(nb);
                }
            }
        }
        const next: number[] = [];
        for (const b of level) {
            const [bi, bj, bk] = blocks[b].cell;
            for (let d = 0; d < 4; d++) {
                const nb = neighbour(blocks[b], NEIGHBOURS[d]);
                if (nb >= 0 && reach[nb] < 0) {
                    reach[nb] = depth + 1;
                    next.push(nb);
                }
            }
            for (const [di, dj] of DIAGONALS) {
                const nb = at(bi + di, bj + dj, bk);
                if (nb < 0 || reach[nb] >= 0) continue;
                // Across a corner only while one of the two blocks beside it exists, so the step stays inside the
                // same connected structure (a lone block touching along an edge holds nothing).
                if (at(bi + di, bj, bk) < 0 && at(bi, bj + dj, bk) < 0) continue;
                reach[nb] = depth + 1;
                next.push(nb);
            }
        }
        level = next;
    }
    return reach;
}

export function analyzeStructure(grid: VoxelGrid, settings: AnalysisSettings): Structure {
    const [gx, gy, gz] = grid.gridSize;
    const bs = settings.blockSizeMm;
    const limit = settings.cantileverLimit;
    const occupancy = occupancyOf(grid, settings.fillThreshold);
    const cellIndex = (i: number, j: number, k: number): number => (k * gy + j) * gx + i;

    // ----- blocks, bottom layer first -----
    const blockAt = new Int32Array(gx * gy * gz).fill(-1);
    const blocks: Block[] = [];
    for (let k = 0; k < gz; k++) {
        for (let j = 0; j < gy; j++) {
            for (let i = 0; i < gx; i++) {
                const c = cellIndex(i, j, k);
                if (!occupancy.used[c]) continue;
                blockAt[c] = blocks.length;
                blocks.push({
                    index: blocks.length,
                    cell: [i, j, k],
                    centerMm: [(i + 0.5) * bs, (j + 0.5) * bs, (k + 0.5) * bs],
                    status: "supported",
                    reach: null,
                    body: -1,
                    fill: occupancy.fill[c],
                    cantilever: null,
                });
            }
        }
    }
    const count = blocks.length;
    /** The block at cell (i, j, k), or -1 for an empty cell or one outside the grid. */
    const at = (i: number, j: number, k: number): number => {
        if (i < 0 || j < 0 || k < 0 || i >= gx || j >= gy || k >= gz) return -1;
        return blockAt[cellIndex(i, j, k)];
    };
    const neighbour = (b: Block, d: readonly [number, number, number]): number => at(b.cell[0] + d[0], b.cell[1] + d[1], b.cell[2] + d[2]);

    // ----- supported: an unbroken column to the ground (blocks are ordered bottom-up, so below comes first) -----
    const supported = new Uint8Array(count);
    for (let b = 0; b < count; b++) {
        const [i, j, k] = blocks[b].cell;
        if (k === 0) supported[b] = 1;
        else {
            const below = blockAt[cellIndex(i, j, k - 1)];
            supported[b] = below >= 0 && supported[below] ? 1 : 0;
        }
    }

    // ----- bodies: 6-connected components -----
    const bodies: Body[] = [];
    const bodyOf = new Int32Array(count).fill(-1);
    const stack = new Int32Array(count);
    for (let start = 0; start < count; start++) {
        if (bodyOf[start] >= 0) continue;
        const id = bodies.length;
        const members: number[] = [];
        let top = 0;
        stack[top++] = start;
        bodyOf[start] = id;
        let grounded = false;
        while (top > 0) {
            const b = stack[--top];
            members.push(b);
            if (blocks[b].cell[2] === 0) grounded = true;
            for (const d of NEIGHBOURS) {
                const nb = neighbour(blocks[b], d);
                if (nb >= 0 && bodyOf[nb] < 0) {
                    bodyOf[nb] = id;
                    stack[top++] = nb;
                }
            }
        }
        members.sort((a, b) => a - b);
        bodies.push({ id, blocks: members, grounded });
    }

    // ----- reach: the fewest horizontal steps to a supported block -----
    const seeds: number[] = [];
    for (let b = 0; b < count; b++) if (supported[b]) seeds.push(b);
    const reach = reachFrom(blocks, blockAt, grid.gridSize, seeds);

    // ----- block status -----
    for (let b = 0; b < count; b++) {
        const block = blocks[b];
        block.body = bodyOf[b];
        if (!bodies[block.body].grounded) {
            block.status = "floating";
            block.reach = null;
            continue;
        }
        block.reach = reach[b];
        const status: BlockStatus = reach[b] === 0 ? "supported" : reach[b] <= limit ? "cantilever" : "overreach";
        block.status = status;
    }

    // ----- cantilever runs: connected groups of grounded blocks that are not supported -----
    const cantilevers: CantileverRun[] = [];
    const seen = new Uint8Array(count);
    for (let start = 0; start < count; start++) {
        const sb = blocks[start];
        if (seen[start] || (sb.status !== "cantilever" && sb.status !== "overreach")) continue;
        const id = cantilevers.length;
        const members: number[] = [];
        const roots = new Set<number>();
        let top = 0;
        stack[top++] = start;
        seen[start] = 1;
        while (top > 0) {
            const b = stack[--top];
            members.push(b);
            blocks[b].cantilever = id;
            for (const d of NEIGHBOURS) {
                const nb = neighbour(blocks[b], d);
                if (nb < 0) continue;
                const status = blocks[nb].status;
                if (status === "supported") roots.add(nb);
                else if ((status === "cantilever" || status === "overreach") && !seen[nb]) {
                    seen[nb] = 1;
                    stack[top++] = nb;
                }
            }
        }
        members.sort((a, b) => a - b);
        let maxReach = 0;
        let minLayer = Infinity;
        let maxLayer = -Infinity;
        const overLimit: number[] = [];
        for (const b of members) {
            const r = blocks[b].reach ?? 0;
            if (r > maxReach) maxReach = r;
            if (r > limit) overLimit.push(b);
            const k = blocks[b].cell[2];
            if (k < minLayer) minLayer = k;
            if (k > maxLayer) maxLayer = k;
        }
        cantilevers.push({ id, blocks: members, roots: [...roots].sort((a, b) => a - b), reach: maxReach, overLimit, layers: [minLayer, maxLayer] });
    }

    // ----- stability -----
    const stability = computeStability(blocks, bodies, bs);

    // ----- stats -----
    let groundBlocks = 0;
    let cantileveredCount = 0;
    let overLimitCount = 0;
    let floatingCount = 0;
    let layers = 0;
    for (const block of blocks) {
        if (block.cell[2] === 0) groundBlocks++;
        if (block.status === "cantilever" || block.status === "overreach") cantileveredCount++;
        if (block.status === "overreach") overLimitCount++;
        if (block.status === "floating") floatingCount++;
        if (block.cell[2] + 1 > layers) layers = block.cell[2] + 1;
    }
    let longestCantilever = 0;
    for (const run of cantilevers) if (run.reach > longestCantilever) longestCantilever = run.reach;
    const stats: AnalysisStats = {
        blockCount: count,
        groundBlocks,
        cantileveredCount,
        longestCantilever,
        overLimitCount,
        floatingCount,
        bodyCount: bodies.length,
        layers,
        coverage: occupancy.coverage,
    };

    return { gridSize: grid.gridSize, blocks, bodies, cantilevers, stability, stats, occupancy, blockAt };
}

/**
 * Every grounded body against its own support base; the one with the smallest margin (the most likely to tip) is
 * the result. A body that rests on the ground only through an unrelated neighbour does not exist: bodies share
 * no face, so what holds one up is never another.
 */
function computeStability(blocks: Block[], bodies: Body[], bs: number): Stability | null {
    let weakest: Stability | null = null;
    let weakestSize = 0;
    let groundedBodies = 0;
    for (const body of bodies) {
        if (!body.grounded) continue; // floating parts do not load any base
        groundedBodies++;
        const candidate = bodyStability(blocks, body, bs);
        if (!candidate) continue;
        // Smallest margin wins; on a tie the bigger structure (more mass at stake), then the lower id.
        const better = !weakest || candidate.marginMm < weakest.marginMm - 1e-9 || (Math.abs(candidate.marginMm - weakest.marginMm) <= 1e-9 && body.blocks.length > weakestSize);
        if (better) {
            weakest = candidate;
            weakestSize = body.blocks.length;
        }
    }
    if (weakest) weakest.groundedBodies = groundedBodies;
    return weakest;
}

/** Centre of gravity of one body against the convex hull of its own ground footprint. */
function bodyStability(blocks: Block[], body: Body, bs: number): Stability | null {
    const footprint: Vec2[] = [];
    const corners: Vec2[] = [];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const id of body.blocks) {
        const block = blocks[id];
        sx += block.centerMm[0];
        sy += block.centerMm[1];
        sz += block.centerMm[2];
        if (block.cell[2] !== 0) continue;
        const [i, j] = block.cell;
        footprint.push([i, j]);
        corners.push([i * bs, j * bs], [(i + 1) * bs, j * bs], [(i + 1) * bs, (j + 1) * bs], [i * bs, (j + 1) * bs]);
    }
    if (footprint.length === 0) return null;

    const n = body.blocks.length;
    const cogMm: Vec3 = [sx / n, sy / n, sz / n];
    const groundPointMm: Vec2 = [cogMm[0], cogMm[1]];
    const supportHull = convexHull(corners);
    const { signed, nearest } = hullDistance(groundPointMm, supportHull);
    const inside = signed >= 0;
    let tipDirection: Vec2 | null = null;
    if (!inside) {
        const dx = groundPointMm[0] - nearest[0];
        const dy = groundPointMm[1] - nearest[1];
        const len = Math.hypot(dx, dy);
        tipDirection = len > 0 ? [dx / len, dy / len] : null;
    }
    return { cogMm, groundPointMm, supportHull, footprint, inside, marginMm: signed, tipDirection, pivotMm: nearest, bodyId: body.id };
}
