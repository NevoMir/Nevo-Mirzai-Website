// Which part of the source model each block belongs to, so "the backrest" or "the left armrest" can be a region of the grid.
//
// How the labels are made (browser, once per source mesh, in the analysis worker):
//   1. The viewer hands over one triangle soup per glTF part (viewer/glbScene.ts partSoups()): the same parts the Parts list shows.
//   2. Every part is voxelised ALONE on the lattice of the WHOLE model (voxelize(soup, settings, onProgress, wholeBounds): the placement
//      comes from the whole model's bounds, not the part's), giving solid fine cells per block for that part.
//   3. A block of the analysed model belongs to the part with the most solid cells in it (ties: the lower index).
// Measured in Node, cold: 12-20 ms per part (a 5-part chair 74 ms, a 16-part crane 193 ms, 60 parts about 0.8 s), and the cells of the
// whole-model voxelisation equal the role-0 cells of the bundled stabilized examples exactly (10 of 10).
// A model that has one part (a Hunyuan mesh) gets no labels; the scene then lists box pieces ("o1", ...) instead.

import { CELLS, type PartLabels } from "./grid.ts";

const MAX_LETTERS = 26;
/** The longest part name the saved log accepts (log.ts). */
export const MAX_PART_NAME = 40;

/** A part name fit for the scene text and the saved log: no control characters, at most 40 characters, never empty. */
export function cleanPartName(name: string, index: number): string {
    // eslint-disable-next-line no-control-regex
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PART_NAME).trim();
    return clean || `Part ${index + 1}`;
}

/** No labels: a model whose blocks have no named parts (a single mesh). */
export function noLabels(): PartLabels {
    return { names: [], owner: new Int8Array(CELLS).fill(-1) };
}

/**
 * `solidPerPart[p][c]`: solid fine cells of part p in block c. `usedCells`: the codes of the blocks to label (the analysed model's).
 * Parts beyond the 26 that own the most blocks are dropped (their blocks become unlabelled); the names are reordered by block count.
 * When fewer than two parts own a block there are no labels at all.
 */
export function assignOwners(names: readonly string[], solidPerPart: ReadonlyArray<ArrayLike<number>>, usedCells: readonly number[]): PartLabels {
    const owner = new Int8Array(CELLS).fill(-1);
    const counts = new Array<number>(names.length).fill(0);
    for (const c of usedCells) {
        let best = -1;
        let bestSolid = 0;
        for (let p = 0; p < names.length; p++) {
            const solid = solidPerPart[p]?.[c] ?? 0;
            if (solid > bestSolid) {
                best = p;
                bestSolid = solid;
            }
        }
        owner[c] = best;
        if (best >= 0) counts[best]++;
    }
    // Keep the parts that own blocks, biggest first, at most 26 (letters A-Z).
    const keep = counts.map((n, p) => ({ n, p })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.p - b.p).slice(0, MAX_LETTERS);
    // One part (a single-mesh model, or every block in one node) says nothing a region of unlabelled blocks does not: no labels.
    if (keep.length <= 1) return noLabels();
    const remap = new Map(keep.map((x, index) => [x.p, index] as const));
    for (const c of usedCells) owner[c] = owner[c] >= 0 ? (remap.get(owner[c]) ?? -1) : -1;
    return { names: keep.map((x) => names[x.p]), owner };
}
