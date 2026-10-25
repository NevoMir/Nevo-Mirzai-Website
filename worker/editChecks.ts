// Facts about an uploaded block-edited model that the server can work out from its blocks, set against what its edit log says
// (POST /models/:sourceId/derived with an "nevo:edit" log, worker/derived.ts). Like derivedChecks.ts: one pass over the cells,
// nothing from the Workers runtime, so a Node script runs it too. Returns an error message, or null when the log fits the blocks.
//
// The reader (shared/assemblyGlb.ts) already ties the cells to the GLB's geometry and the log to its own shape; what it cannot know is
// whether the log's counts and steps are the ones these blocks have. A client could otherwise claim any instruction history.

import { BLOCK_ROLES } from "../src/assignment/shared/contract.ts";
import { CELL_STRIDE, type AssemblyDescriptor } from "../src/assignment/shared/assembly.ts";
import type { VoxelEditLog } from "../src/assignment/shared/voxelEdit/log.ts";

const USER = BLOCK_ROLES.indexOf("user");

export function crossCheckVoxelEdit(descriptor: Pick<AssemblyDescriptor, "cells">, log: VoxelEditLog): string | null {
    const cells = descriptor.cells;
    const blocks = cells.length / CELL_STRIDE;
    if (log.after.blocks !== blocks) return `The edit log counts ${log.after.blocks} blocks, the file has ${blocks}.`;
    if (log.after_summary.blocks !== blocks) return `The analysis in the edit log counts ${log.after_summary.blocks} blocks, the file has ${blocks}.`;
    if (log.labels.length !== blocks) return "The edit log has a label for every block but not for the blocks in the file.";
    let delta = 0;
    for (const e of log.edits) delta += e.added - e.removed;
    if (log.after.blocks !== log.before.blocks + delta) return "The edit log's counts do not add up: before + added - removed is not the number of blocks.";
    const top = log.base_steps + log.edits.length;
    const perStep: number[] = Array.from({ length: log.edits.length }, () => 0);
    for (let n = 0; n < cells.length; n += CELL_STRIDE) {
        const step = cells[n + 4];
        if (step <= log.base_steps) continue; // a block of the model this one was edited from
        if (cells[n + 3] !== USER) return "A block added by an edit must have the role 'user'.";
        if (step > top) return `A block has step ${step}, the log has edits up to ${top}.`;
        perStep[step - log.base_steps - 1]++;
    }
    // Later edits may remove or overwrite what an earlier one made, so the file holds at most what each edit made or moved.
    for (let i = 0; i < perStep.length; i++) {
        if (perStep[i] > log.edits[i].added + log.edits[i].moved) return `Edit ${i + 1} of the log made fewer blocks than the file has of its step.`;
    }
    return null;
}
