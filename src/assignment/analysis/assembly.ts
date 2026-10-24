// Analysing a block assembly (a stabilized model) without voxelising anything.
//
// A voxelised mesh is scaled so its longest side is 1000 mm; an assembly's cells are already on the 100 mm lattice, so
// the grid is built straight from the descriptor and the result is exactly what the cells say: the same blocks, the same
// statuses and reaches as analysing the cells directly (the tests pin this). The transform is still needed by the viewer,
// which draws the lattice inside the loaded GLB's own frame: it is derived from the bounding box of the GLB's triangles.

import { BLOCK_ROLES } from "../shared/contract.ts";
import { CELL_STRIDE, blockCount, descriptorFromBlocks, roleCounts, type AssemblyDescriptor } from "../shared/assembly.ts";
import { analyzeGrid } from "./analyze.ts";
import { normalizeSettings } from "./settings.ts";
import type { AnalysisResult, AnalysisSettings, Vec3 } from "./types.ts";
import { SUBDIVISION, type VoxelGrid } from "./voxelize.ts";

export interface Bounds {
    min: Vec3;
    max: Vec3;
}

/** Axis-aligned bounds of a triangle soup (9 floats per triangle). Null for an empty one. */
export function boundsOf(positions: Float32Array): Bounds | null {
    if (positions.length < 3) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let p = 0; p + 2 < positions.length; p += 3) {
        for (let a = 0; a < 3; a++) {
            const v = positions[p + a];
            if (v < min[a]) min[a] = v;
            if (v > max[a]) max[a] = v;
        }
    }
    return { min, max };
}

/** Bounds from untrusted data (a worker message), or null when anything is not a finite number. */
export function parseBounds(value: unknown): Bounds | null {
    if (typeof value !== "object" || value === null) return null;
    const { min, max } = value as { min?: unknown; max?: unknown };
    const vec = (v: unknown): Vec3 | null =>
        Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? ([v[0], v[1], v[2]] as Vec3) : null;
    const lo = vec(min);
    const hi = vec(max);
    return lo && hi && lo.every((n, a) => n <= hi[a]) ? { min: lo, max: hi } : null;
}

/** The settings with the scale an assembly has: its own block size, and the target volume its lattice makes. */
export function settingsForAssembly(settings: AnalysisSettings, desc: AssemblyDescriptor): AnalysisSettings {
    return { ...settings, blockSizeMm: desc.blockSizeMm, targetSizeMm: desc.blockSizeMm * desc.grid[0] };
}

/**
 * The voxel grid of an assembly. `soup`: the bounds of the GLB's triangles in the viewer's display frame, so the
 * result's transform maps that frame onto the lattice; null for a headless analysis (the stabilizer, scripts), where
 * the lattice is the frame (factor 1, no offset).
 */
export function gridFromAssembly(desc: AssemblyDescriptor, soup: Bounds | null, settings: AnalysisSettings, frame: AssemblyDescriptor = desc): VoxelGrid {
    const bs = desc.blockSizeMm;
    const [gx, gy, gz] = desc.grid;
    const solid = new Uint16Array(gx * gy * gz);
    for (let n = 0; n < desc.cells.length; n += CELL_STRIDE) solid[(desc.cells[n + 2] * gy + desc.cells[n + 1]) * gx + desc.cells[n]] = SUBDIVISION ** 3;
    // The transform describes the GLB the soup came from, so it is measured on `frame` (the whole assembly) even when
    // `desc` is a part of it (the "original" view analyses the source blocks inside the stabilized model's frame).
    let lo: Vec3 = [Infinity, Infinity, 0];
    let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let n = 0; n < frame.cells.length; n += CELL_STRIDE) {
        lo = [Math.min(lo[0], frame.cells[n]), Math.min(lo[1], frame.cells[n + 1]), 0];
        hi = [Math.max(hi[0], frame.cells[n]), Math.max(hi[1], frame.cells[n + 1]), Math.max(hi[2], frame.cells[n + 2])];
    }
    const margin = ((1 - desc.inset) / 2) * bs; // the exported cube sits this far inside its cell
    // Extent of the exported geometry in mm, per axis.
    const extent: Vec3 = [(hi[0] - lo[0] + 1) * bs - 2 * margin, (hi[1] - lo[1] + 1) * bs - 2 * margin, (hi[2] + 1) * bs - 2 * margin];
    let transform = { factor: 1, modelMin: [0, 0, 0] as Vec3, offsetMm: [0, 0, 0] as Vec3 };
    if (soup) {
        const size: Vec3 = [soup.max[0] - soup.min[0], soup.max[1] - soup.min[1], soup.max[2] - soup.min[2]];
        const axis = extent.indexOf(Math.max(...extent));
        if (size[axis] > 0) {
            transform = {
                factor: extent[axis] / size[axis],
                modelMin: [...soup.min] as Vec3,
                offsetMm: [lo[0] * bs + margin, lo[1] * bs + margin, margin],
            };
        }
    }
    return {
        targetSizeMm: settings.targetSizeMm,
        blockSizeMm: bs,
        gridSize: [gx, gy, gz],
        transform,
        sizeMm: extent,
        solid,
        totalSolid: blockCount(desc) * SUBDIVISION ** 3,
        surfaceCells: 0,
        triangles: { total: 0, used: 0, skipped: 0 },
        voxelizeMs: 0,
        fromAssembly: true,
    };
}

/** Roles and steps onto the blocks of a result made from `desc` (descriptor block n is result block n). */
export function annotateRoles(result: AnalysisResult, desc: AssemblyDescriptor): AnalysisResult {
    if (result.blocks.length !== blockCount(desc)) throw new RangeError("The result and the assembly do not have the same blocks.");
    result.blocks.forEach((block, n) => {
        const at = n * CELL_STRIDE;
        if (block.cell[0] !== desc.cells[at] || block.cell[1] !== desc.cells[at + 1] || block.cell[2] !== desc.cells[at + 2]) {
            throw new RangeError("The result and the assembly list their blocks in a different order.");
        }
        block.role = BLOCK_ROLES[desc.cells[at + 3]];
        block.step = desc.cells[at + 4];
    });
    let steps = 0;
    for (let n = 4; n < desc.cells.length; n += CELL_STRIDE) steps = Math.max(steps, desc.cells[n]);
    result.assembly = { descriptor: desc, roleCounts: roleCounts(desc), steps };
    return result;
}

/**
 * Structural analysis of an assembly (no stress yet: that is analysis/stress.ts). `frame`: the assembly the soup's bounds
 * belong to, when `desc` is only a part of it (see originalOf).
 */
export function analyzeAssembly(desc: AssemblyDescriptor, soup: Bounds | null, settings: Partial<AnalysisSettings> = {}, frame: AssemblyDescriptor = desc): AnalysisResult {
    const normalized = settingsForAssembly(normalizeSettings(settings), desc);
    const result = analyzeGrid(gridFromAssembly(desc, soup, normalized, frame), normalized);
    return annotateRoles(result, desc);
}

/** The assembly without what the stabilizer added: what the stabilized model started from. Null when nothing is left. */
export function originalOf(desc: AssemblyDescriptor): AssemblyDescriptor | null {
    const blocks: Array<{ cell: [number, number, number] }> = [];
    for (let n = 0; n < desc.cells.length; n += CELL_STRIDE) {
        if (desc.cells[n + 3] === 0) blocks.push({ cell: [desc.cells[n], desc.cells[n + 1], desc.cells[n + 2]] });
    }
    return blocks.length > 0 ? descriptorFromBlocks(blocks, desc.inset) : null;
}

/** The cells of any result, for the stabilizer's input. */
export function cellsOf(result: Pick<AnalysisResult, "blocks">): Array<[number, number, number]> {
    return result.blocks.map((b) => [b.cell[0], b.cell[1], b.cell[2]]);
}
