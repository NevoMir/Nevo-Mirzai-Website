// The stress estimate: a second stage after the structural analysis (analysis.worker.ts runs both).
//
//   computeStress(result, solver)  every block that stands on the ground becomes a node of a 3D beam model (Awatif FEM,
//                                  open source, MIT), one beam per shared face, self-weight as the load, the ground
//                                  blocks fixed. The solver's end forces give, for every joint, the tension across it,
//                                  the crushing and the shear, each as a share of what the material allows: its
//                                  utilisation. A block gets the worst of its joints.
//   applyStress(result, stress)    turns that into what the report shows: issues ("Joint overloaded: 198%"), the
//                                  "Joint stress" check row, and the numbers in the summary that is saved with the model.
//                                  The issues are worded for a student (a height and a side, no cell or kPa); the check row
//                                  and the exported report keep the technical terms.
//
// What this is not: a certificate. It is a linear elastic estimate for a perfectly bonded assembly under its own
// weight (no wind, no people, no buckling, no sliding of loose blocks, an infinitely stiff ground). It ranks where a
// structure is most stressed and says by how much a change helps, which is what the stabilizer needs. Tipping is the
// centre-of-gravity check's job: a bonded model held at the ground reports tension at its base instead of toppling.

import type { MaterialId, StressSummary } from "../shared/contract.ts";
import {
    FemError,
    blockUtilisation,
    buildVoxelFrame,
    createAwatifSolver,
    elementStresses,
    groundedBlockIndices,
    solveFrameTs,
    type ElementStress,
    type FrameSolver,
} from "./fem/index.ts";
import { STRESS_FAIL, STRESS_WARN, materialOf, pct } from "./materials.ts";
import { placeOf } from "./plain.ts";
import type { AnalysisResult, CheckRow, Issue, StressAnalysis, StressMode, StressPoint, Vec3 } from "./types.ts";

export interface SolverHandle {
    solve: FrameSolver;
    backend: "wasm" | "ts";
}

/** Awatif's WASM solver when it loads and runs, else the same maths in TypeScript (identical to 1e-10). */
export async function loadSolver(wasmUrl?: string): Promise<SolverHandle> {
    try {
        const wasm = await createAwatifSolver(wasmUrl);
        // A tiny model proves the module works before it is trusted with a real one.
        wasm({
            nodes: Float64Array.from([0.05, 0.05, 0.05, 0.05, 0.05, 0.15]),
            elems: Uint32Array.from([0, 1]),
            supportNodes: Int32Array.from([0]),
            loadNodes: Int32Array.from([1]),
            loadVals: Float64Array.from([0, 0, -1, 0, 0, 0]),
            props: { E: 1e9, G: 4e8, A: 0.01, Iy: 8.3e-6, Iz: 8.3e-6, J: 1.4e-5 },
        });
        return { solve: wasm, backend: "wasm" };
    } catch {
        return { solve: solveFrameTs, backend: "ts" };
    }
}

/** How long the WASM module may take to load before the TypeScript solver is used instead (a stalled fetch on a bad link). */
export const WASM_LOAD_MS = 10_000;

const TS_FALLBACK: SolverHandle = { solve: solveFrameTs, backend: "ts" };

/**
 * `load()` (a loadSolver), but never waits longer than `ms`: past that the TypeScript solver answers (same numbers, only slower
 * on big models) so a stalled download cannot hold a finished analysis back. `onLate` gets the WASM solver if it does arrive
 * after that, so a caller that keeps its solver can upgrade. `load` must not reject (loadSolver never does).
 */
export async function loadSolverWithin(
    load: () => Promise<SolverHandle>,
    ms: number = WASM_LOAD_MS,
    onLate?: (handle: SolverHandle) => void,
): Promise<SolverHandle> {
    const loading = load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const late = new Promise<SolverHandle>((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            resolve(TS_FALLBACK);
        }, ms);
    });
    const handle = await Promise.race([loading, late]);
    clearTimeout(timer);
    if (timedOut && onLate) void loading.then(onLate, () => {});
    return handle;
}

/** The most blocks in a stress point's group, so a pure-bending column does not become one giant "point". */
const CLUSTER_BAND = 0.9;
const MAX_POINTS = 8;
const MIN_POINT_UTIL = 0.05;

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];

/** Null when no block stands on the ground (nothing to solve). Throws FemError if the solver fails on both backends. */
export function computeStress(result: AnalysisResult, solver: SolverHandle, materialId: MaterialId = result.settings.material): StressAnalysis | null {
    const idx = groundedBlockIndices(result.blocks);
    if (idx.length === 0) return null;
    const material = materialOf(materialId);
    const blocks = idx.map((i) => result.blocks[i]);
    const frame = buildVoxelFrame(blocks, { blockSizeMm: result.settings.blockSizeMm, material: material.fem });
    const started = performance.now();
    let backend = solver.backend;
    let solution;
    try {
        solution = solver.solve(frame.model);
    } catch (error) {
        // A WASM module that aborted is dead; the TypeScript solver gives the same answer. A singular system would fail there too.
        if (solver.backend === "ts") throw error;
        backend = "ts";
        solution = solveFrameTs(frame.model);
    }
    const ms = performance.now() - started;
    const stresses = elementStresses(frame, solution);
    const util = blockUtilisation(blocks.length, stresses);

    // Per block: the utilisation and the element that gives it (to name the joint).
    const best: Array<ElementStress | null> = blocks.map(() => null);
    for (const s of stresses) {
        for (const q of [s.nodeA, s.nodeB]) if (!best[q] || s.util > (best[q] as ElementStress).util) best[q] = s;
    }
    const byBlock = new Float32Array(result.blocks.length).fill(Number.NaN);
    idx.forEach((blockIndex, q) => {
        byBlock[blockIndex] = util[q];
    });

    let maxUtilisation = 0;
    let maxBlock: number | null = null;
    let stressedBlocks = 0;
    let overstressedBlocks = 0;
    idx.forEach((blockIndex, q) => {
        if (util[q] > maxUtilisation || maxBlock === null) {
            maxUtilisation = util[q];
            maxBlock = blockIndex;
        }
        if (util[q] > STRESS_WARN) stressedBlocks++;
        if (util[q] > STRESS_FAIL) overstressedBlocks++;
    });

    // Stress points, worst first. A point is a group of neighbouring blocks around one peak. First every connected region
    // above the warning level is one point (an arm that is stressed along its length is one problem, not six); then, to
    // fill the list, the highest peaks among the rest, each with the blocks within 10 % of it.
    const local = new Map<number, number>(); // result block index -> position in `blocks`
    idx.forEach((blockIndex, q) => local.set(blockIndex, q));
    // Keyed by the result's own grid size, and a neighbour outside it is skipped: with a fixed row length a block on one
    // face would be "next to" the one on the opposite face of the row above (two far-apart arms became one stress point).
    const [gx, gy, gz] = result.gridSize;
    const at = new Map<number, number>(); // grid cell -> result block index
    for (const b of result.blocks) at.set((b.cell[2] * gy + b.cell[1]) * gx + b.cell[0], b.index);
    const neighboursOf = (q: number): number[] => {
        const [i, j, k] = blocks[q].cell;
        const out: number[] = [];
        for (const d of NEIGHBOURS) {
            const ni = i + d[0];
            const nj = j + d[1];
            const nk = k + d[2];
            if (ni < 0 || nj < 0 || nk < 0 || ni >= gx || nj >= gy || nk >= gz) continue;
            const n = at.get((nk * gy + nj) * gx + ni);
            const nq = n === undefined ? undefined : local.get(n);
            if (nq !== undefined) out.push(nq);
        }
        return out;
    };
    const taken = new Uint8Array(blocks.length);
    const grow = (seed: number, admits: (q: number) => boolean): number[] => {
        const group: number[] = [];
        const queue = [seed];
        taken[seed] = 1;
        for (let h = 0; h < queue.length; h++) {
            group.push(queue[h]);
            for (const nq of neighboursOf(queue[h])) {
                if (!taken[nq] && admits(nq)) {
                    taken[nq] = 1;
                    queue.push(nq);
                }
            }
        }
        return group;
    };
    const groups: Array<{ peak: number; members: number[] }> = [];
    const byUtil = idx.map((_, q) => q).sort((a, b) => util[b] - util[a] || a - b);
    for (const q of byUtil) {
        if (util[q] <= STRESS_WARN) break;
        if (!taken[q]) groups.push({ peak: q, members: grow(q, (n) => util[n] > STRESS_WARN) });
    }
    for (const q of byUtil) {
        if (groups.length >= MAX_POINTS) break;
        if (util[q] < MIN_POINT_UTIL) break;
        if (!taken[q]) groups.push({ peak: q, members: grow(q, (n) => util[n] >= util[q] * CLUSTER_BAND) });
    }
    groups.sort((a, b) => util[b.peak] - util[a.peak] || a.peak - b.peak);
    const points: StressPoint[] = groups.slice(0, MAX_POINTS).map((g, rank) => {
        const peak = blocks[g.peak];
        const governing = best[g.peak];
        const mode: StressMode = governing?.mode ?? "tension";
        const strength = mode === "tension" ? material.fem.jointTension : mode === "compression" ? material.fem.compression : material.fem.shear;
        return {
            rank: rank + 1,
            blocks: [idx[g.peak], ...g.members.filter((m) => m !== g.peak).map((m) => idx[m])],
            cell: [...peak.cell] as Vec3,
            centreMm: [...peak.centerMm] as Vec3,
            utilisation: util[g.peak],
            mode,
            tensionKPa: governing ? Math.max(0, governing.sigT) / 1000 : 0,
            allowableKPa: strength / 1000,
            joint: governing ? [[...blocks[governing.nodeA].cell] as Vec3, [...blocks[governing.nodeB].cell] as Vec3] : null,
        };
    });

    return {
        version: 1,
        loadCase: "self-weight",
        material: materialId,
        solver: { name: "Awatif", backend, ms },
        byBlock,
        analysedBlocks: idx.length,
        unsupportedBlocks: result.blocks.length - idx.length,
        maxUtilisation,
        maxBlock,
        stressedBlocks,
        overstressedBlocks,
        points,
    };
}

const cellText = (c: Vec3): string => `(${c[0]}, ${c[1]}, ${c[2]})`;

const MODE_PHRASE: Record<StressMode, string> = { tension: "pulled apart", compression: "crushed", shear: "sheared" };

function stressIssue(result: AnalysisResult, point: StressPoint, material: string): Issue {
    const over = point.utilisation > STRESS_FAIL;
    const peak = result.blocks[point.blocks[0]];
    // Where the joint that governs is: the peak block (the first of the point), not the whole region around it.
    const place = placeOf(result.blocks, point.blocks.slice(0, 1), result.settings.blockSizeMm);
    // "At a height of 200-300 mm, at the back left, a concrete joint is pulled apart and uses 132% of its strength ..."
    const where = place ? `${place.sentence[0].toUpperCase()}${place.sentence.slice(1)}, a` : "A";
    const what = `${material} joint is ${MODE_PHRASE[point.mode]} and uses ${pct(point.utilisation)} of its strength`;
    const arm = peak.status === "cantilever" || peak.status === "overreach";
    const help = arm ? "A column or bracket under the arm, or a thicker joint, lowers it." : "A support under the span, a thicker joint or a shorter overhang lowers it.";
    return {
        id: `stress-${point.rank}`,
        kind: over ? "overstressed" : "highly-stressed",
        severity: over ? "error" : "warning",
        title: over ? `Joint overloaded: ${pct(point.utilisation)}` : `Joint heavily loaded: ${pct(point.utilisation)}`,
        detail: `${where} ${what} under the model's own weight. ${over ? "It would open or crush. " : "It is close to its limit. "}${help}`,
        blocks: point.blocks,
        focusMm: point.centreMm,
    };
}

const MAX_STRESS_ISSUES = 4;

/** What the "Joint stress" row says when the solver failed on both backends: the structural verdict stands on its own. */
export const STRESS_UNAVAILABLE = "Stress could not be estimated";

/**
 * The result with the stress estimate in it: issues, the "Joint stress" check row, the summary. Returns a new object.
 * `stress` null means there is nothing to report: `reason` (default "No blocks" / "Nothing stands on the ground") is
 * what the row says then, with the "info" status that never counts against the model.
 */
export function applyStress(result: AnalysisResult, stress: StressAnalysis | null, reason?: string): AnalysisResult {
    const material = materialOf(result.settings.material);
    // Applying twice must not stack: start from the issues the structural analysis made.
    const base = result.issues.filter((i) => i.kind !== "overstressed" && i.kind !== "highly-stressed");
    let issues = base;
    let checks = result.checks;
    let summary = result.summary;
    const empty = result.stats.blockCount === 0;

    let row: CheckRow;
    if (!stress) {
        row = { key: "stress", label: "Joint stress", value: reason ?? (empty ? "No blocks" : "Nothing stands on the ground"), status: "info" };
    } else {
        const found = stress.points.filter((p) => p.utilisation > STRESS_WARN).slice(0, MAX_STRESS_ISSUES).map((p) => stressIssue(result, p, material.label.toLowerCase()));
        const errors = [...base.filter((i) => i.severity === "error"), ...found.filter((i) => i.severity === "error")];
        const warnings = [...base.filter((i) => i.severity === "warning"), ...found.filter((i) => i.severity === "warning")];
        issues = [...errors, ...warnings];
        const worst = stress.maxBlock === null ? null : result.blocks[stress.maxBlock];
        const where = worst ? ` at block ${cellText(worst.cell)}` : "";
        const left = stress.unsupportedBlocks > 0 ? ` · ${stress.unsupportedBlocks} floating, no load path` : "";
        row = {
            key: "stress",
            label: "Joint stress",
            value: `Peak ${pct(stress.maxUtilisation)} of allowable${where}${left}`,
            status: stress.maxUtilisation > STRESS_FAIL ? "fail" : "pass",
        };
        const stressSummary: StressSummary = {
            material: stress.material,
            max_utilisation: Math.min(50, Math.round(stress.maxUtilisation * 1000) / 1000),
            max_at: worst ? ([...worst.cell] as [number, number, number]) : null,
            stressed_blocks: stress.stressedBlocks,
            overstressed_blocks: stress.overstressedBlocks,
            analysed_blocks: stress.analysedBlocks,
            unsupported_blocks: stress.unsupportedBlocks,
        };
        summary = {
            ...result.summary,
            errors: issues.filter((i) => i.severity === "error").length,
            warnings: issues.filter((i) => i.severity === "warning").length,
            stress: stressSummary,
        };
    }
    checks = [...result.checks.filter((c) => c.key !== "stress"), row];
    if (!stress) summary = { ...result.summary, errors: base.filter((i) => i.severity === "error").length, warnings: base.filter((i) => i.severity === "warning").length, stress: null };
    return { ...result, issues, checks, summary, stress };
}

/** The base result with the "stress could not be estimated" row (see STRESS_UNAVAILABLE). */
export const stressUnavailable = (result: AnalysisResult): AnalysisResult => applyStress(result, null, STRESS_UNAVAILABLE);

export { FemError, pct };
