// Analysing a block assembly (a stabilized model) without voxelising anything.
//
// A voxelised mesh is scaled so its longest side is 1000 mm; an assembly's cells are already on the 100 mm lattice, so
// the grid is built straight from the descriptor and the result is exactly what the cells say: the same blocks, the same
// statuses and reaches as analysing the cells directly (the tests pin this). The transform is still needed by the viewer,
// which draws the lattice inside the frame of the mesh it shows. Two frames exist:
//   - the assembly GLB's own (the viewer shows the stabilized GLB itself): derived from the bounding box of the GLB's
//     triangles, so the lattice lands on the blocks it came from;
//   - the SOURCE mesh's (the viewer shows the original model and the blocks are drawn over it): the cells of a stabilized
//     model are cells of the source's own voxelisation, so the transform is the source's (voxelize.ts transformForBounds of
//     the source's bounds) and `sourceTransform` replaces the derived one. The result then describes the model on that mesh,
//     so its size (`sizeMm`, and the summary's `size_mm`) is the mesh's scaled box, `sourceSizeMm`, as it is for the original
//     voxelised from the same mesh: the two versions do not disagree about how big the model is.

import { BLOCK_ROLES } from "../shared/contract.ts";
import { CELL_STRIDE, blockCount, descriptorFromBlocks, roleCounts, type AssemblyDescriptor } from "../shared/assembly.ts";
import { analyzeGrid } from "./analyze.ts";
import { normalizeSettings } from "./settings.ts";
import type { AnalysisResult, AnalysisSettings, AnalysisTransform, Vec3 } from "./types.ts";
import { SUBDIVISION, finiteBounds, placementForBounds, type Placement, type VoxelGrid } from "./voxelize.ts";

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

/**
 * The bounds voxelize() puts a mesh by: of the triangles whose coordinates are all finite (a broken triangle is skipped whole),
 * so the transform made from them is the one voxelising the same soup gives. Null when there is no such triangle. Use this, not
 * boundsOf, for the source mesh of a stabilized model.
 */
export function soupBoundsOf(positions: Float32Array): Bounds | null {
    const bounds = finiteBounds(positions, Math.floor(positions.length / 9));
    return bounds.valid > 0 ? { min: bounds.min, max: bounds.max } : null;
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

/** A size from untrusted data (a worker message), or null when it is not three finite numbers that are not negative. */
export function parseSize(value: unknown): Vec3 | null {
    return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ? ([value[0], value[1], value[2]] as Vec3) : null;
}

/** A transform from untrusted data (a worker message), or null when it is not finite numbers with a positive factor. */
export function parseTransform(value: unknown): AnalysisTransform | null {
    if (typeof value !== "object" || value === null) return null;
    const { factor, modelMin, offsetMm } = value as { factor?: unknown; modelMin?: unknown; offsetMm?: unknown };
    const vec = (v: unknown): Vec3 | null =>
        Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? ([v[0], v[1], v[2]] as Vec3) : null;
    const lo = vec(modelMin);
    const off = vec(offsetMm);
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 && lo && off ? { factor, modelMin: lo, offsetMm: off } : null;
}

/** The settings with the scale an assembly has: its own block size, and the target volume its lattice makes. */
export function settingsForAssembly(settings: AnalysisSettings, desc: AssemblyDescriptor): AnalysisSettings {
    return { ...settings, blockSizeMm: desc.blockSizeMm, targetSizeMm: desc.blockSizeMm * desc.grid[0] };
}

/**
 * How the SOURCE mesh a stabilized model was made from sits in the lattice of its blocks: the transform that puts the blocks
 * over the mesh (the one voxelising that mesh gives, at the scale the assembly's lattice has) and the mesh's scaled bounding box
 * (`sizeMm`, what voxelising it reports as the model's size). `bounds`: soupBoundsOf the mesh's triangles, in whatever frame the
 * viewer draws it in. Null when the mesh has no bounds.
 */
export function sourcePlacementOf(bounds: Bounds | null, settings: Partial<AnalysisSettings>, desc: AssemblyDescriptor): Placement | null {
    if (!bounds) return null;
    return placementForBounds(bounds, settingsForAssembly(normalizeSettings(settings), desc));
}

/** The transform of `sourcePlacementOf`: what puts the lattice of a stabilized model's blocks over the mesh they were made from. */
export function sourceTransformOf(bounds: Bounds | null, settings: Partial<AnalysisSettings>, desc: AssemblyDescriptor): AnalysisTransform | null {
    return sourcePlacementOf(bounds, settings, desc)?.transform ?? null;
}

/**
 * The voxel grid of an assembly. `soup`: the bounds of the GLB's triangles in the viewer's display frame, so the
 * result's transform maps that frame onto the lattice; null for a headless analysis (the stabilizer, scripts), where
 * the lattice is the frame (factor 1, no offset). `sourceTransform`: the frame of the source mesh the blocks are drawn
 * over (see the header); it is the result's transform as it is and `soup` and `frame` are not looked at. `sourceSizeMm`
 * (with `sourceTransform`): that mesh's scaled box, which is then the grid's size instead of the lattice's own extent.
 */
export function gridFromAssembly(
    desc: AssemblyDescriptor,
    soup: Bounds | null,
    settings: AnalysisSettings,
    frame: AssemblyDescriptor = desc,
    sourceTransform: AnalysisTransform | null = null,
    sourceSizeMm: Vec3 | null = null,
): VoxelGrid {
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
    let transform: AnalysisTransform = sourceTransform
        ? { factor: sourceTransform.factor, modelMin: [...sourceTransform.modelMin], offsetMm: [...sourceTransform.offsetMm] }
        : { factor: 1, modelMin: [0, 0, 0], offsetMm: [0, 0, 0] };
    if (soup && !sourceTransform) {
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
        // On the source mesh the model is as big as that mesh (the original voxelised from it says the same); otherwise the lattice is all there is.
        sizeMm: sourceTransform && sourceSizeMm ? [sourceSizeMm[0], sourceSizeMm[1], sourceSizeMm[2]] : extent,
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
export function analyzeAssembly(
    desc: AssemblyDescriptor,
    soup: Bounds | null,
    settings: Partial<AnalysisSettings> = {},
    frame: AssemblyDescriptor = desc,
    sourceTransform: AnalysisTransform | null = null,
    sourceSizeMm: Vec3 | null = null,
): AnalysisResult {
    const normalized = settingsForAssembly(normalizeSettings(settings), desc);
    const result = analyzeGrid(gridFromAssembly(desc, soup, normalized, frame, sourceTransform, sourceSizeMm), normalized);
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
