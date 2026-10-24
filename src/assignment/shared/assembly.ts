// A block assembly: the cells of the 10 x 10 x 10 grid that hold a block, each with the role it plays and the
// stabilizer step that added it. This is what a stabilized model IS; its GLB (shared/assemblyGlb.ts) is a rendering of it.
//
// Pure TypeScript with no DOM, so the browser, the Worker (which validates uploads) and the Node scripts that build
// the bundled examples all use this one copy.
//
// Why a descriptor and not "just the GLB's triangles": the analysis voxelises triangles after scaling the model so
// its longest side is 1000 mm. A stabilized assembly whose longest side is 700 mm would be stretched by 1.43 and
// its blocks would no longer sit on the 100 mm lattice (measured: a 21-block assembly came back as 68 blocks).
// The descriptor lets the analysis read the cells exactly instead (analysis/assembly.ts).

import { BLOCK_ROLES, type BlockRole } from "./contract.ts";

/** glTF key under scenes[0].extras that carries the descriptor / the stabilizer's log. */
export const ASSEMBLY_EXTRAS_KEY = "nevo:assembly";
export const STABILIZATION_EXTRAS_KEY = "nevo:stabilization";

export const ASSEMBLY_BLOCK_MM = 100;
export const ASSEMBLY_GRID = 10;
export const MAX_ASSEMBLY_BLOCKS = ASSEMBLY_GRID ** 3;
/** Numbers per block in `AssemblyDescriptor.cells`: i, j, k, role index, step. */
export const CELL_STRIDE = 5;
export const MAX_STEP = 255;
/** Share of its cell an exported cube fills, so neighbouring blocks read as separate components in the 3D tab. */
export const DEFAULT_INSET = 0.96;

/** glTF node/mesh name of each role: what the Parts list of the viewer shows. */
export const ROLE_NODE_NAMES: Record<BlockRole, string> = {
    original: "Original blocks",
    column: "Columns",
    footing: "Footing",
    bracket: "Brackets",
    bridge: "Bridges",
    reinforcement: "Reinforcement",
};

/**
 * Colour of each role (sRGB hex): the GLB's materials (they cannot follow the theme) and the Overlay legend. The block view
 * paints "original" blocks with its theme-aware slate instead (statusColor("supported", theme)); the added roles are
 * saturated hues that read on both stages (the 3D view outlines every block, as it does for the status colours).
 */
export const ROLE_HEX: Record<BlockRole, string> = {
    original: "#64748b", // slate: quiet, so what was added carries the colour
    column: "#f59e0b",
    footing: "#8b5cf6",
    bracket: "#22c55e",
    bridge: "#06b6d4",
    reinforcement: "#ec4899",
};

export interface AssemblyDescriptor {
    version: 1;
    blockSizeMm: 100;
    grid: [10, 10, 10];
    /** Fill of the exported cube (0.9 - 1). */
    inset: number;
    /**
     * Flat list, CELL_STRIDE numbers per block: i, j, k, role (index into BLOCK_ROLES), step (0 = in the analysed
     * model, n = added by stabilizer step n). CANONICAL ORDER: ascending k, then j, then i, which is also the order the
     * analysis engine numbers its blocks in, so descriptor block n is AnalysisResult.blocks[n].
     */
    cells: number[];
}

export const roleIndex = (role: BlockRole): number => BLOCK_ROLES.indexOf(role);

/** Number of blocks in a descriptor. */
export const blockCount = (d: Pick<AssemblyDescriptor, "cells">): number => d.cells.length / CELL_STRIDE;

/** Position of a cell in the canonical order (also the engine's `(k * gy + j) * gx + i`). */
export const cellCode = (i: number, j: number, k: number): number => (k * ASSEMBLY_GRID + j) * ASSEMBLY_GRID + i;

/** What the descriptor builder needs of a block (an engine Block fits). */
export interface BlockLike {
    cell: readonly [number, number, number];
    role?: BlockRole;
    step?: number;
}

/** Builds the canonical descriptor from blocks in any order. Throws on a duplicate or out-of-grid cell. */
export function descriptorFromBlocks(blocks: readonly BlockLike[], inset: number = DEFAULT_INSET): AssemblyDescriptor {
    const sorted = [...blocks].sort((a, b) => cellCode(a.cell[0], a.cell[1], a.cell[2]) - cellCode(b.cell[0], b.cell[1], b.cell[2]));
    const cells: number[] = [];
    let previous = -1;
    for (const block of sorted) {
        const [i, j, k] = block.cell;
        if (![i, j, k].every((v) => Number.isInteger(v) && v >= 0 && v < ASSEMBLY_GRID)) throw new RangeError(`Cell (${i}, ${j}, ${k}) is outside the grid`);
        const code = cellCode(i, j, k);
        if (code === previous) throw new RangeError(`Cell (${i}, ${j}, ${k}) is listed twice`);
        previous = code;
        cells.push(i, j, k, roleIndex(block.role ?? "original"), block.step ?? 0);
    }
    return { version: 1, blockSizeMm: ASSEMBLY_BLOCK_MM, grid: [ASSEMBLY_GRID, ASSEMBLY_GRID, ASSEMBLY_GRID], inset, cells };
}

/** A descriptor from untrusted JSON, or null. Strict: anything off (including a non-canonical order) is refused. */
export function parseAssemblyDescriptor(value: unknown): AssemblyDescriptor | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (v.version !== 1 || v.blockSizeMm !== ASSEMBLY_BLOCK_MM) return null;
    if (!Array.isArray(v.grid) || v.grid.length !== 3 || !v.grid.every((g) => g === ASSEMBLY_GRID)) return null;
    if (typeof v.inset !== "number" || !Number.isFinite(v.inset) || v.inset < 0.9 || v.inset > 1) return null;
    const raw = v.cells;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length % CELL_STRIDE !== 0 || raw.length > MAX_ASSEMBLY_BLOCKS * CELL_STRIDE) return null;
    const cells = new Array<number>(raw.length);
    let previous = -1;
    for (let n = 0; n < raw.length; n += CELL_STRIDE) {
        for (let c = 0; c < CELL_STRIDE; c++) {
            const x: unknown = raw[n + c];
            if (typeof x !== "number" || !Number.isInteger(x)) return null;
            cells[n + c] = x;
        }
        const [i, j, k, role, step] = [cells[n], cells[n + 1], cells[n + 2], cells[n + 3], cells[n + 4]];
        if (i < 0 || j < 0 || k < 0 || i >= ASSEMBLY_GRID || j >= ASSEMBLY_GRID || k >= ASSEMBLY_GRID) return null;
        if (role < 0 || role >= BLOCK_ROLES.length || step < 0 || step > MAX_STEP) return null;
        // "original" blocks are step 0 and only they are: the two facts must agree.
        if ((role === 0) !== (step === 0)) return null;
        const code = cellCode(i, j, k);
        if (code <= previous) return null; // not strictly ascending: a duplicate, or not canonical
        previous = code;
    }
    return { version: 1, blockSizeMm: ASSEMBLY_BLOCK_MM, grid: [ASSEMBLY_GRID, ASSEMBLY_GRID, ASSEMBLY_GRID], inset: v.inset, cells };
}

/** Blocks per role, in BLOCK_ROLES order (zero for a role that is absent). */
export function roleCounts(d: Pick<AssemblyDescriptor, "cells">): number[] {
    const counts = BLOCK_ROLES.map(() => 0);
    for (let n = 3; n < d.cells.length; n += CELL_STRIDE) counts[d.cells[n]]++;
    return counts;
}

/**
 * SHA-256 (hex) of the shape and roles, not of the step numbers: two runs that end with the same blocks in the same
 * roles are the same result (the unique index on models(source_model_id, assembly_hash) relies on it).
 */
export async function assemblyHash(d: Pick<AssemblyDescriptor, "cells">): Promise<string> {
    const rows: string[] = [];
    for (let n = 0; n < d.cells.length; n += CELL_STRIDE) rows.push(`${d.cells[n]},${d.cells[n + 1]},${d.cells[n + 2]},${BLOCK_ROLES[d.cells[n + 3]]}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rows.join(";"))));
    let hex = "";
    for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
    return hex;
}
