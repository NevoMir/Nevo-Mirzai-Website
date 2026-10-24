// The stabilizer's view of the stress solver: an occupancy grid in, the utilisation of every block out.
//
// It is the engine's own stress stage (analysis/stress.ts computeStress) with the same inputs: the blocks that stand on the
// ground, one beam per shared face, the material the analysis settings name, Awatif's solver (or the TypeScript twin), and
// the same per-block rule (the worst joint touching the block). So a number the stabilizer works to is the number the report
// shows. The stabilizer asks for many solves (every candidate move is scored with one), so it calls this instead of building
// a full AnalysisResult each time; measure.ts replays the solver's output through computeStress for the figures that are logged.

import type { FrameModel, FrameSolution, FrameSolver, Material } from "../fem/index.ts";
import { blockUtilisation, buildVoxelFrame, elementStresses, groundedBlockIndices } from "../fem/index.ts";
import type { SolverHandle } from "../stress.ts";
import { cellCoords } from "./grid.ts";
import type { Dims } from "./grid.ts";

export interface StressField {
    /** Per cell index: utilisation of the most loaded joint touching the block (0 = no block, or no load path to the ground). */
    util: Float64Array;
    maxUtil: number;
    maxCell: number; // cell index of maxUtil (-1 when no block stands on the ground)
    solved: number; // blocks in the solve
    /** What the solver was given and returned, kept so computeStress can be replayed on it (replayOf) without solving again. */
    model: FrameModel | null;
    solution: FrameSolution | null;
}

export type StressSolver = (occ: Uint8Array, d: Dims) => StressField;

export interface StressSolverOptions {
    solve: FrameSolver;
    blockSizeMm: number;
    material: Material;
}

export function makeStressSolver(o: StressSolverOptions): StressSolver {
    return (occ, d) => {
        const cells: number[] = [];
        for (let c = 0; c < occ.length; c++) if (occ[c]) cells.push(c); // ascending cell index = the engine's block order
        const blocks = cells.map((c) => ({ cell: cellCoords(d, c) }));
        const idx = groundedBlockIndices(blocks);
        const util = new Float64Array(occ.length);
        if (idx.length === 0) return { util, maxUtil: 0, maxCell: -1, solved: 0, model: null, solution: null };
        const sub = idx.map((q) => blocks[q]);
        const frame = buildVoxelFrame(sub, { blockSizeMm: o.blockSizeMm, material: o.material });
        const solution = o.solve(frame.model);
        const u = blockUtilisation(sub.length, elementStresses(frame, solution));
        let maxUtil = 0;
        let maxCell = -1;
        idx.forEach((q, n) => {
            const c = cells[q];
            util[c] = u[n];
            if (maxCell < 0 || u[n] > maxUtil) {
                maxUtil = u[n];
                maxCell = c;
            }
        });
        return { util, maxUtil, maxCell, solved: sub.length, model: frame.model, solution };
    };
}

const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
};

/**
 * A solver handle for computeStress that hands back the solution already computed for `field` instead of solving again,
 * provided computeStress builds the very same frame (it does for the same blocks, settings and material); otherwise it
 * solves for real, so a mismatch costs time, never correctness.
 */
export function replayOf(field: StressField | null, real: SolverHandle): SolverHandle {
    return {
        backend: real.backend,
        solve: (model) => {
            const m = field?.model;
            if (field?.solution && m && sameArray(m.nodes, model.nodes) && sameArray(m.elems, model.elems) && sameArray(m.supportNodes, model.supportNodes)) return field.solution;
            return real.solve(model);
        },
    };
}
