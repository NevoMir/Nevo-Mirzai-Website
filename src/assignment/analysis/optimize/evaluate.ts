// One state of the assembly -> the figures the optimizer works to.
//
// Geometry (floating, cantilever reach, centre-of-gravity margin, bodies) is stabilize/grid.ts: the engine's own definitions on a
// plain Uint8Array, ~0.05-0.2 ms. The FEM stage is the engine's stress stage (stabilize/stressAdapter.ts is the same recipe) plus
// two things the optimizer needs and the stabilizer did not: the nodal displacements (deflection) and the strain energy of every
// beam. The energy is exact, not a proxy: for Awatif's Euler-Bernoulli beam it is
//     U_e = L/6 * [ (N0^2 + N0 N1 + N1^2)/(EA) + (Mx0^2 + Mx0 Mx1 + Mx1^2)/(GJ) + ((My0^2 + My0 My1 + My1^2) + (Mz0^2 + Mz0 Mz1 + Mz1^2))/(EI) ]
// from the 13 numbers per element lSolve returns, and the sum over the elements equals 1/2 F.u (the work of the self-weight) to 4+ digits
// (measured on three stabilized examples). A block's energy is half of the energy of the beams that touch it.

import { blockUtilisation, buildVoxelFrame, elementStresses, groundedBlockIndices } from "../fem/index.ts";
import type { FrameSolver, Material } from "../fem/index.ts";
import { evaluateGeometry } from "../stabilize/grid.ts";
import type { Dims, Geometry } from "../stabilize/grid.ts";
import { cellCoords } from "../stabilize/grid.ts";
import type { Limits, Metrics, ObjectiveTerm } from "./types.ts";

export const DIMS: Dims = { gx: 10, gy: 10, gz: 10 };
export const CELLS = 1000;

/** The FEM stage of one state. All arrays are indexed by CELL index (0 where there is no block or no load path to the ground). */
export interface Field {
    util: Float64Array;
    /** Half of the strain energy of the beams touching the block [J]. */
    energy: Float64Array;
    /** |displacement| of the block centre [m]. */
    defl: Float64Array;
    maxUtil: number;
    maxCell: number;
    maxDeflM: number;
    /** 1/2 sum F.u over the loads = total strain energy [J]. */
    strainEnergy: number;
    solved: number;
}

export interface EvaluatorOptions {
    solve: FrameSolver;
    blockSizeMm: number;
    material: Material;
    cantileverLimit: number;
}

export interface Evaluator {
    geometry(occ: Uint8Array): Geometry;
    field(occ: Uint8Array): Field | null;
    /** Number of FEM solves so far. */
    readonly solves: number;
}

export function createEvaluator(o: EvaluatorOptions): Evaluator {
    let solves = 0;
    return {
        get solves() {
            return solves;
        },
        geometry: (occ) => evaluateGeometry(occ, DIMS, o.blockSizeMm, o.cantileverLimit, 100),
        field: (occ) => {
            const cells: number[] = [];
            for (let c = 0; c < occ.length; c++) if (occ[c]) cells.push(c);
            const blocks = cells.map((c) => ({ cell: cellCoords(DIMS, c) }));
            const idx = groundedBlockIndices(blocks);
            if (idx.length === 0) return null;
            const sub = idx.map((q) => blocks[q]);
            const frame = buildVoxelFrame(sub, { blockSizeMm: o.blockSizeMm, material: o.material });
            const solution = o.solve(frame.model);
            solves++;
            const stresses = elementStresses(frame, solution);
            const util = new Float64Array(occ.length);
            const energy = new Float64Array(occ.length);
            const defl = new Float64Array(occ.length);
            const u = blockUtilisation(sub.length, stresses);
            let maxUtil = 0;
            let maxCell = -1;
            let maxDeflM = 0;
            const nodeCell = idx.map((q) => cells[q]);
            nodeCell.forEach((c, n) => {
                util[c] = u[n];
                if (maxCell < 0 || u[n] > maxUtil) {
                    maxUtil = u[n];
                    maxCell = c;
                }
                const d = Math.hypot(solution.displacements[3 * n], solution.displacements[3 * n + 1], solution.displacements[3 * n + 2]);
                defl[c] = d;
                if (d > maxDeflM) maxDeflM = d;
            });
            // strain energy per beam, shared by its two blocks
            const p = frame.model.props;
            const L = o.blockSizeMm / 1000;
            const F = solution.forces;
            const elems = frame.model.elems;
            let total = 0;
            for (let e = 0; e < elems.length / 2; e++) {
                const b = 13 * e;
                const N0 = F[b + 1], N1 = F[b + 2];
                const Mx0 = F[b + 7], Mx1 = F[b + 8];
                const My0 = F[b + 9], My1 = F[b + 10];
                const Mz0 = F[b + 11], Mz1 = F[b + 12];
                const U =
                    (L / 6) *
                    ((N0 * N0 + N0 * N1 + N1 * N1) / (p.E * p.A) +
                        (Mx0 * Mx0 + Mx0 * Mx1 + Mx1 * Mx1) / (p.G * p.J) +
                        (My0 * My0 + My0 * My1 + My1 * My1 + (Mz0 * Mz0 + Mz0 * Mz1 + Mz1 * Mz1)) / (p.E * p.Iy));
                total += U;
                energy[nodeCell[elems[2 * e]]] += U / 2;
                energy[nodeCell[elems[2 * e + 1]]] += U / 2;
            }
            return { util, energy, defl, maxUtil, maxCell, maxDeflM, strainEnergy: total, solved: sub.length };
        },
    };
}

/** The figures of a state. `field` null: nothing stands on the ground. */
export function metricsOf(geom: Geometry, field: Field | null): Metrics {
    const grounded = geom.bodies.filter((b) => b.grounded).length;
    return {
        blocks: geom.count,
        floating: geom.floatingCells,
        overLimit: geom.overreachCells,
        longestReach: geom.longestReach,
        bodies: grounded,
        cogMarginMm: Number.isFinite(geom.marginMm) ? geom.marginMm : null,
        maxUtil: field ? field.maxUtil : null,
        maxDeflectionMm: field ? field.maxDeflM * 1000 : null,
        compliance: field ? 2 * field.strainEnergy : null,
    };
}

// ---------- violations and the objective ----------

/** What the objective is normalised by: the start's figures and the block size. */
export interface Reference {
    blocks0: number;
    deflection0Mm: number;
    uRef: number;
    blockSizeMm: number;
}

export const VIOLATION_NAMES = ["floating", "reach", "bodies", "budget", "margin", "stress", "deflection"] as const;
export const GEOMETRY_VIOLATIONS = 5; // the first five need no FEM

/**
 * The constraints as a vector, most important first; all zero = feasible. Compared lexicographically with a tolerance, like the
 * stabilizer's isWorse: a move may leave a lesser violation worse, never trade a more important one for it.
 * `m` without FEM figures (maxUtil / deflection null while blocks stand on the ground) counts the stress terms as 0.
 */
export function violationsOf(m: Metrics, lim: Limits, ref: Reference, withFem: boolean): number[] {
    const margin = m.cogMarginMm;
    const v = [
        m.floating,
        m.overLimit,
        Math.max(0, m.bodies - lim.maxBodies),
        Math.max(0, m.blocks - lim.maxBlocks) + Math.max(0, lim.minBlocks - m.blocks),
        lim.minMarginMm === null || margin === null ? 0 : Math.max(0, lim.minMarginMm - margin) / ref.blockSizeMm,
        withFem && lim.maxUtil !== null && m.maxUtil !== null ? Math.max(0, m.maxUtil - lim.maxUtil) : 0,
        withFem && lim.maxDeflectionMm !== null && m.maxDeflectionMm !== null ? Math.max(0, m.maxDeflectionMm - lim.maxDeflectionMm) / Math.max(1e-9, ref.deflection0Mm) : 0,
    ];
    if (m.blocks === 0) v[0] = 1; // an empty model is not a structure
    return v;
}

/** The comparison of two violation vectors: negative = `a` is better, 0 = tied (within tolerance), positive = `a` is worse. */
export function compareViolations(a: readonly number[], b: readonly number[], tol = 1e-7): number {
    for (let i = 0; i < a.length; i++) {
        if (a[i] > b[i] + tol) return 1;
        if (a[i] < b[i] - tol) return -1;
    }
    return 0;
}

export const isFeasible = (v: readonly number[]): boolean => v.every((x) => x <= 1e-9);

/** One scalar for the log and the chart: the first violation that is not zero, else 0. */
export const violationSize = (v: readonly number[]): number => v.reduce((s, x, i) => s + x * (i < 4 ? 1000 : 10), 0);

/**
 * What a block ABOVE the start's count costs in objective units: an added block must buy at least this much improvement (0.2 % of
 * the objective's scale). Without it a goal like "most stable" spends its whole budget on blocks that gain 0.01 % (measured: +32
 * blocks for 6 % -> 4 % peak stress on a pyramid at 6 % to begin with). Removing a block below the start's count earns nothing
 * from it (a "most stable" goal must not trade strength for weight); only a "blocks" term rewards that.
 */
export const BLOCK_PRICE = 0.002;
/** Among equal objectives prefer the lower peak stress (a tie-break, never a goal). */
const STRESS_TIE = 0.002;

/**
 * Where "better" stops being worth a block. A goal like "most stable" must not spend blocks on a margin that is already huge or a
 * stress that is already tiny (measured before this: +11 blocks for 496 -> 500 mm on a pyramid, 8 s of solves). So the stress term
 * gets no credit below STRESS_FLOOR of the allowable (a safety factor of 5) and the margin term none above MARGIN_CAP.
 */
export const STRESS_FLOOR = 0.2;
export const MARGIN_CAP_MM = 300;

/**
 * The goal part of the objective, smaller is better. Terms are dimensionless: blocks / start, max(stress, floor) / limit,
 * -min(margin, cap) / block, deflection / start; plus BLOCK_PRICE per block above the start's count. Only differences matter, the
 * history shows it relative to the start.
 */
export function goalOf(m: Metrics, terms: readonly ObjectiveTerm[], ref: Reference): number {
    let j = 0;
    for (const t of terms) {
        switch (t.metric) {
            case "blocks":
                j += t.weight * (m.blocks / ref.blocks0);
                break;
            case "peak_stress":
                j += t.weight * (Math.max(m.maxUtil ?? 0, STRESS_FLOOR) / ref.uRef);
                break;
            case "cog_margin":
                j += t.weight * (-Math.min(m.cogMarginMm ?? 0, MARGIN_CAP_MM) / ref.blockSizeMm);
                break;
            case "deflection":
                j += t.weight * ((m.maxDeflectionMm ?? 0) / Math.max(1e-9, ref.deflection0Mm));
                break;
        }
    }
    return j + BLOCK_PRICE * Math.max(0, m.blocks - ref.blocks0);
}

/** The objective: the goal plus a small stress tie-break. The loop accepts a move only when the goal part itself improves (see GOAL_TOL). */
export const objectiveOf = (m: Metrics, terms: readonly ObjectiveTerm[], ref: Reference): number => goalOf(m, terms, ref) + STRESS_TIE * ((m.maxUtil ?? 0) / ref.uRef);

/**
 * How much the goal part must fall for a move to count. The tie-break alone never makes a move worth it: on a model already past the
 * stress floor and the margin cap (a pyramid at 6 % strength used and 496 mm of margin) every removal still lowered the tie-break a
 * little, and the "best balanced" goal then took 8 blocks out and put 3 in for a margin that got 1 mm worse.
 */
export const GOAL_TOL = 1e-6;
