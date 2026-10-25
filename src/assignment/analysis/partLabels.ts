// Which part of a mesh model each block of its voxelisation belongs to (the labels natural-language edits refer to: "the backrest").
//
//   labelParts(parts, usedCells, settings)  parts: one triangle soup per glTF part (viewer/glbScene.ts partSoups()), in the viewer's Z-up
//                                           frame; usedCells: the codes of the blocks of the model's analysis (AnalysisResult.blocks).
//
// Every part is voxelised ALONE on the lattice of the WHOLE model (voxelize's `placeBy`), and a block goes to the part with the most
// solid fine cells in it. Runs in the analysis worker (protocol.ts "labels" request): 12-20 ms a part in Node, so a 16-part model takes
// 0.2 s and a 60-part one about 0.8 s. Parts that own no block are dropped, and at most 26 parts are kept (shared/voxelEdit/labels.ts).
// A model with fewer than two parts that own a block gets no labels at all: its structure is told by pieces ("o1", "c1") instead.

import { CELLS, type PartLabels } from "../shared/voxelEdit/grid.ts";
import { assignOwners, cleanPartName } from "../shared/voxelEdit/labels.ts";
import type { AnalysisSettings } from "./types.ts";
import { finiteBounds, voxelize, type ProgressFn } from "./voxelize.ts";

export interface PartSoup {
    name: string;
    /** 9 floats per triangle, Z-up, any units: the same frame for every part. */
    positions: Float32Array;
}

export function labelParts(partsIn: readonly PartSoup[], usedCells: readonly number[], settings: AnalysisSettings, onProgress?: ProgressFn): PartLabels {
    // A part whose triangles are not a float array (a message that is not ours) has none.
    const parts = partsIn.map((p) => ({ name: String(p.name), positions: p.positions instanceof Float32Array ? p.positions : new Float32Array(0) }));
    // The bounds of the whole model, from all its triangles: what voxelize() would use for the whole soup.
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
        const b = finiteBounds(part.positions, Math.floor(part.positions.length / 9));
        if (b.valid === 0) continue;
        for (let a = 0; a < 3; a++) {
            if (b.min[a] < min[a]) min[a] = b.min[a];
            if (b.max[a] > max[a]) max[a] = b.max[a];
        }
    }
    const whole = { min, max };
    const solid: Uint16Array[] = [];
    parts.forEach((part, n) => {
        // A part with no triangle owns nothing (an all-zero count per block).
        solid.push(part.positions.length >= 9 ? voxelize({ positions: part.positions }, settings, undefined, whole).solid : new Uint16Array(CELLS));
        onProgress?.((n + 1) / parts.length, "voxelize");
    });
    return assignOwners(parts.map((p, n) => cleanPartName(p.name, n)), solid, usedCells);
}
