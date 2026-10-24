// Voxel assembly -> 3D frame model.
//   node    = block centre (grid cell (i, j, k) -> ((i+.5) a, (j+.5) a, (k+.5) a) metres, a = block edge)
//   element = one beam between every pair of FACE-adjacent blocks (+x, +y, +z neighbours), 100x100 mm solid square
//   support = fully fixed (6 DOF) at every block on the ground layer k = 0 (the bond to the ground / glued base)
//   load    = self-weight, -m g in Z at every node (m = rho a^3), i.e. block weight lumped at its centre

import type { FrameModel, FrameProps } from "./types.ts";

export const GRAVITY = 9.80665; // m/s^2

export interface Material {
    name: string;
    E: number; // Pa
    G: number; // Pa
    rho: number; // kg/m^3
    /** Strengths used by the utilisation check (see stress.ts). Pa. */
    jointTension: number; // tension across a joint / glue line (the weak link of an assembly)
    compression: number; // bearing / crushing
    shear: number;
}

export const MATERIALS: Record<string, Material> = {
    // Softwood C24-like: E0 11 GPa, G ~ E/16, rho 500; weakest values (perpendicular to grain) govern a block joint.
    timber: { name: "Timber (C24)", E: 11e9, G: 0.69e9, rho: 500, jointTension: 0.4e6, compression: 2.5e6, shear: 4e6 },
    // Plain concrete / mortared masonry blocks.
    concrete: { name: "Concrete blocks", E: 30e9, G: 12.5e9, rho: 2400, jointTension: 0.2e6, compression: 20e6, shear: 1e6 },
};

export interface BlockSection {
    a: number; // edge [m]
    A: number;
    I: number; // = Iy = Iz
    J: number; // St Venant torsion constant of a solid square: 0.1406 a^4
    W: number; // elastic section modulus a^3/6
    Wt: number; // torsion modulus 0.208 a^3
}

export function blockSection(a: number): BlockSection {
    return { a, A: a * a, I: a ** 4 / 12, J: 0.1406 * a ** 4, W: a ** 3 / 6, Wt: 0.208 * a ** 3 };
}

/** Unique key of a grid cell (i, j, k >= -1, each < 1023). */
const cellCode = (i: number, j: number, k: number): number => i + 1 + 1024 * (j + 1 + 1024 * (k + 1));

export interface VoxelBlockLike {
    cell: readonly [number, number, number]; // grid indices i, j, k (k = 0 on the ground)
}

export interface VoxelFrame {
    model: FrameModel;
    section: BlockSection;
    material: Material;
    /** Weight of one block [N]. */
    blockWeight: number;
    /** node index == index into the `blocks` array that was passed in. */
    elementBlocks: Uint32Array; // 2 per element: same as model.elems (kept for readability)
}

export interface BuildOptions {
    blockSizeMm: number; // 100 in the app
    material: Material;
    /** Size multiplier: 1 = real 100 mm blocks. Stress scales linearly with it (self-weight). Default 1. */
    scale?: number;
}

export function buildVoxelFrame(blocks: readonly VoxelBlockLike[], options: BuildOptions): VoxelFrame {
    const a = (options.blockSizeMm / 1000) * (options.scale ?? 1);
    const n = blocks.length;
    const index = new Map<number, number>();
    const code = cellCode;
    blocks.forEach((b, q) => index.set(code(b.cell[0], b.cell[1], b.cell[2]), q));
    const nodes = new Float64Array(3 * n);
    const elemList: number[] = [];
    const support: number[] = [];
    blocks.forEach((b, q) => {
        const [i, j, k] = b.cell;
        nodes[3 * q] = (i + 0.5) * a;
        nodes[3 * q + 1] = (j + 0.5) * a;
        nodes[3 * q + 2] = (k + 0.5) * a;
        if (k === 0) support.push(q);
        const nx = index.get(code(i + 1, j, k));
        const ny = index.get(code(i, j + 1, k));
        const nz = index.get(code(i, j, k + 1));
        if (nx !== undefined) elemList.push(q, nx);
        if (ny !== undefined) elemList.push(q, ny);
        if (nz !== undefined) elemList.push(q, nz);
    });
    const section = blockSection(a);
    const m = options.material;
    const W = m.rho * a ** 3 * GRAVITY;
    const loadNodes = new Int32Array(n);
    const loadVals = new Float64Array(6 * n);
    for (let q = 0; q < n; q++) {
        loadNodes[q] = q;
        loadVals[6 * q + 2] = -W;
    }
    const props: FrameProps = { E: m.E, G: m.G, A: section.A, Iy: section.I, Iz: section.I, J: section.J };
    const elems = Uint32Array.from(elemList);
    return {
        model: { nodes, elems, supportNodes: Int32Array.from(support), loadNodes, loadVals, props },
        section,
        material: m,
        blockWeight: W,
        elementBlocks: elems,
    };
}

/** Indices of the blocks that are 6-connected to a ground block (k = 0). Solve only these: a floating body is a singular system. */
export function groundedBlockIndices(blocks: readonly VoxelBlockLike[]): number[] {
    const code = cellCode;
    const index = new Map<number, number>();
    blocks.forEach((b, q) => index.set(code(b.cell[0], b.cell[1], b.cell[2]), q));
    const seen = new Uint8Array(blocks.length);
    const stack: number[] = [];
    blocks.forEach((b, q) => {
        if (b.cell[2] === 0) {
            seen[q] = 1;
            stack.push(q);
        }
    });
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (stack.length) {
        const q = stack.pop() as number;
        const [i, j, k] = blocks[q].cell;
        for (const d of dirs) {
            const r = index.get(code(i + d[0], j + d[1], k + d[2]));
            if (r !== undefined && !seen[r]) {
                seen[r] = 1;
                stack.push(r);
            }
        }
    }
    const out: number[] = [];
    seen.forEach((s, q) => {
        if (s) out.push(q);
    });
    return out;
}
