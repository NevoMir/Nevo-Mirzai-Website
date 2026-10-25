// Runs a mesh edit program on a mesh in the edit frame. Synchronous and free of the DOM: the worker calls it, and so do the tests.
// The guards of spec 5.2: an op that selects nothing fails with "I couldn't find the <label> on this model.", a delete that would remove
// more than 60% of the triangles is refused, a result over MAX_EDIT_TRIANGLES is refused.

import { MAX_EDIT_TRIANGLES } from "../shared/contract.ts";
import { toExecutorOp, type MeshProgram } from "../shared/meshProgram.ts";
import { uniqueNames } from "../shared/partsDesign.ts";
import { refreshNormals } from "./normals.ts";
import { OPS, makeState } from "./ops.ts";
import { MeshEditError, type EditMesh, type EditState, type OpLog, type RunProgress } from "./types.ts";

export interface RunOptions {
    signal?: AbortSignal;
    /** Called before each op. */
    onProgress?: (progress: RunProgress) => void;
}

export interface RunResult {
    state: EditState;
    log: OpLog[];
    /** What the card should say besides the summary: an op that had to bend the plan (a stretch zone that was too short ...). */
    notes: string[];
}

const aborted = (): MeshEditError => new MeshEditError("aborted", "The edit was stopped.");

/** Triangles a program may still add to the mesh with parts, so the whole file stays within MAX_EDIT_TRIANGLES. */
export const PARTS_TRIANGLE_ALLOWANCE = 40_000;

export function runProgram(mesh: EditMesh, program: MeshProgram, options: RunOptions = {}): RunResult {
    if (!program.applied || program.ops.length === 0) throw new MeshEditError("failed", "There is nothing to do.");
    const state = makeState(mesh);
    const Q0 = Float32Array.from(mesh.Q);
    const log: OpLog[] = [];
    const notes: string[] = [];
    let countChanged = false;
    program.ops.forEach((raw, i) => {
        if (options.signal?.aborted) throw aborted();
        options.onProgress?.({ index: i + 1, total: program.ops.length, op: raw.op, label: raw.label });
        const op = toExecutorOp(raw);
        const run = OPS[op.op];
        const before = state.Q.length;
        const t0 = performance.now();
        const counts = run(state, op);
        if (state.Q.length !== before) countChanged = true;
        if (state.idx.length / 3 > MAX_EDIT_TRIANGLES - PARTS_TRIANGLE_ALLOWANCE) throw new MeshEditError("toobig", "The result would be too detailed to save. Describe a smaller change.");
        log.push({ op: op.op, label: op.label, ...counts, ms: Math.round(performance.now() - t0) });
        if (counts.note && !notes.includes(counts.note)) notes.push(counts.note);
    });
    if (options.signal?.aborted) throw aborted();
    if (state.idx.length === 0) throw new MeshEditError("toomuch", "That would remove the whole model.");

    // Normals: only what moved, unless vertices were added or removed (then every vertex is recomputed, which costs the same).
    const t0 = performance.now();
    let changed: Uint8Array | null = null;
    if (!countChanged && state.Q.length === Q0.length) {
        changed = new Uint8Array(state.Q.length / 3);
        for (let v = 0; v < changed.length; v++) {
            if (state.Q[v * 3] !== Q0[v * 3] || state.Q[v * 3 + 1] !== Q0[v * 3 + 1] || state.Q[v * 3 + 2] !== Q0[v * 3 + 2]) changed[v] = 1;
        }
    }
    const touched = refreshNormals(state.Q, state.idx, state.nor, changed);
    log.push({ op: "normals", touched, ms: Math.round(performance.now() - t0) });

    if (state.parts.length > 0) {
        const names = uniqueNames(state.parts.map((p) => p.name));
        state.parts = state.parts.map((p, i) => ({ ...p, name: names[i] }));
    }
    return { state, log, notes };
}
