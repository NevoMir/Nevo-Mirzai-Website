// An edit log is replayable: applyEdit is deterministic, and the region ids an instruction used (parts, roles, pieces like "c1") are
// functions of the grid it was planned against, so base grid + logged operations = the edited grid, exactly. That is how a draft
// survives a reload (only the log is kept in sessionStorage) and how an earlier state of a version is rebuilt without storing grids.

import { applyEdit, type RawAnswer, type RawOp, type VoxelEditEntry } from "./ops.ts";
import { pieceRegions } from "./scene.ts";
import { cloneGrid, type EditGrid } from "./grid.ts";

/** A logged (normalised) operation as the raw form applyEdit takes: absent fields are null. */
export function rawOpOf(op: VoxelEditEntry["ops"][number]): RawOp {
    return {
        op: op.op,
        region: op.region ?? null,
        box: op.box ?? null,
        dirs: op.dirs ?? null,
        amount: op.amount ?? null,
        axis: op.axis ?? null,
        at: op.at ?? null,
        plane: op.plane ?? null,
        offset: op.offset ?? null,
        wall: op.wall ?? null,
        include_added: op.include_added ?? false,
    };
}

/**
 * Applies the logged edits in order to a copy of `base`. Edit n creates blocks of step baseSteps + n. `failed` is the 1-based number of
 * the first edit that could not be applied (a log made against another base), else null.
 */
export function replayEdits(base: EditGrid, entries: ReadonlyArray<Pick<VoxelEditEntry, "n" | "ops">>, baseSteps: number): { grid: EditGrid; failed: number | null } {
    let grid = cloneGrid(base);
    for (const entry of entries) {
        const answer: RawAnswer = { summary: "", notes: "", clarification: "", ops: entry.ops.map(rawOpOf) };
        const result = applyEdit(grid, answer, pieceRegions(grid), baseSteps + entry.n);
        if (!result.ok) return { grid, failed: entry.n };
        grid = result.grid;
    }
    return { grid, failed: null };
}
