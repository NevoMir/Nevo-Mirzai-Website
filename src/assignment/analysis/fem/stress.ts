// Per-element stress / utilisation from a FrameSolution, the stress points (hot spots), and support reactions.
//
// Conventions (see types.ts): N is positive in COMPRESSION. Per element end e in {0, 1}:
//   bending fibre stress  sigB = (|My| + |Mz|) / W                     (biaxial, summed: conservative)
//   max tension fibre     sigT = -N/A + sigB          (> 0 means the joint is pulled open)
//   max compression fibre sigC = +N/A + sigB
//   shear + torsion       tau  = 1.5 hypot(Vy, Vz) / A + |Mx| / Wt
//   utilisation           util = max( max(sigT, 0) / jointTension, sigC / compression, tau / shear )
// util >= 1 means a bonded joint of that material would fail. "|N|/A + |My|/Wy + |Mz|/Wz" from the task text is
// reported as sigAbs.

import type { FrameSolution } from "./types.ts";
import type { VoxelFrame } from "./voxelFrame.ts";

export interface ElementStress {
    element: number;
    nodeA: number; // block indices
    nodeB: number;
    sigT: number; // Pa
    sigC: number;
    sigAbs: number;
    tau: number;
    util: number;
    /** 0 or 1: the element end that governs `util`. */
    governingEnd: 0 | 1;
    /** Which check gives `util`: tension across the joint, crushing, or shear + torsion. */
    mode: "tension" | "compression" | "shear";
}

export function elementStresses(frame: Pick<VoxelFrame, "model" | "section" | "material">, solution: FrameSolution): ElementStress[] {
    const { model, section, material } = frame;
    const m = model.elems.length / 2;
    const F = solution.forces;
    const out: ElementStress[] = [];
    for (let e = 0; e < m; e++) {
        const o = 13 * e;
        let sigT = -Infinity, sigC = -Infinity, sigAbs = 0, tau = 0, util = 0, gov: 0 | 1 = 0;
        let mode: ElementStress["mode"] = "tension";
        for (let s = 0; s < 2; s++) {
            const N = F[o + 1 + s];
            const sigB = (Math.abs(F[o + 9 + s]) + Math.abs(F[o + 11 + s])) / section.W;
            const t = -N / section.A + sigB;
            const c = N / section.A + sigB;
            const sh = (1.5 * Math.hypot(F[o + 3 + s], F[o + 5 + s])) / section.A + Math.abs(F[o + 7 + s]) / section.Wt;
            const uT = Math.max(t, 0) / material.jointTension;
            const uC = c / material.compression;
            const uS = sh / material.shear;
            const u = Math.max(uT, uC, uS);
            sigT = Math.max(sigT, t);
            sigC = Math.max(sigC, c);
            sigAbs = Math.max(sigAbs, Math.abs(N) / section.A + sigB);
            tau = Math.max(tau, sh);
            if (u > util) {
                util = u;
                gov = s as 0 | 1;
                mode = u === uT ? "tension" : u === uC ? "compression" : "shear";
            }
        }
        out.push({ element: e, nodeA: model.elems[2 * e], nodeB: model.elems[2 * e + 1], sigT, sigC, sigAbs, tau, util, governingEnd: gov, mode });
    }
    return out;
}

/** Utilisation per block = the largest util of the elements touching it (0 for a block with no element). */
export function blockUtilisation(blockCount: number, stresses: readonly ElementStress[]): Float64Array {
    const u = new Float64Array(blockCount);
    for (const s of stresses) {
        if (s.util > u[s.nodeA]) u[s.nodeA] = s.util;
        if (s.util > u[s.nodeB]) u[s.nodeB] = s.util;
    }
    return u;
}

export interface StressPoint {
    block: number; // index into the blocks array
    util: number;
    sigT: number; // Pa
    sigC: number;
}

/** Stress points: blocks whose utilisation is >= threshold, worst first, at most `limit`. */
export function stressPoints(stresses: readonly ElementStress[], threshold = 0.5, limit = 20): StressPoint[] {
    const best = new Map<number, StressPoint>();
    for (const s of stresses) {
        for (const q of [s.nodeA, s.nodeB]) {
            const cur = best.get(q);
            if (!cur || s.util > cur.util) best.set(q, { block: q, util: s.util, sigT: s.sigT, sigC: s.sigC });
        }
    }
    return [...best.values()].filter((p) => p.util >= threshold).sort((a, b) => b.util - a.util).slice(0, limit);
}

/**
 * Reactions at the support nodes [N, N m], world axes: R = (sum of element end forces at the node) - applied load.
 * Awatif's lSolve does not return them. Fz > 0 is the ground pushing up; Fz < 0 at a ground block means the base
 * is being PULLED (an unbonded block would lift off).
 */
export function supportReactions(frame: Pick<VoxelFrame, "model">, solution: FrameSolution): Map<number, number[]> {
    const { model } = frame;
    const nodes = model.nodes, elems = model.elems;
    const isSupport = new Uint8Array(nodes.length / 3);
    for (const q of model.supportNodes) isSupport[q] = 1;
    const sum = new Map<number, number[]>();
    for (const q of model.supportNodes) sum.set(q, [0, 0, 0, 0, 0, 0]);
    const F = solution.forces;
    for (let e = 0; e < elems.length / 2; e++) {
        const a = elems[2 * e], c = elems[2 * e + 1];
        if (!isSupport[a] && !isSupport[c]) continue;
        const o = 13 * e;
        // undo the sign flips applied by lSolve to recover the raw local end-force vector f = k T u
        const f = [F[o + 1], -F[o + 3], -F[o + 5], F[o + 7], -F[o + 9], -F[o + 11], -F[o + 2], F[o + 4], F[o + 6], -F[o + 8], F[o + 10], F[o + 12]];
        const dx = nodes[3 * c] - nodes[3 * a], dy = nodes[3 * c + 1] - nodes[3 * a + 1], dz = nodes[3 * c + 2] - nodes[3 * a + 2];
        const L = Math.hypot(dx, dy, dz);
        const l = dx / L, mm = dy / L, nn = dz / L, D = Math.sqrt(l * l + mm * mm);
        let lam: number[];
        if (Math.abs(nn - 1) < 1e-12) lam = [0, 0, 1, 0, 1, 0, -1, 0, 0];
        else if (Math.abs(nn + 1) < 1e-12) lam = [0, 0, -1, 0, 1, 0, 1, 0, 0];
        else lam = [l, mm, nn, -mm / D, l / D, 0, (-l * nn) / D, (-mm * nn) / D, D];
        for (const [end, node] of [[0, a], [1, c]] as const) {
            if (!isSupport[node]) continue;
            const acc = sum.get(node) as number[];
            for (let blk = 0; blk < 2; blk++) {
                for (let r = 0; r < 3; r++) {
                    let s = 0;
                    for (let q = 0; q < 3; q++) s += lam[3 * q + r] * f[6 * end + 3 * blk + q]; // (T^T f)_r
                    acc[3 * blk + r] += s;
                }
            }
        }
    }
    const loadAt = new Map<number, number>();
    model.loadNodes.forEach((node, i) => loadAt.set(node, i));
    for (const q of model.supportNodes) {
        const acc = sum.get(q) as number[];
        const li = loadAt.get(q);
        if (li !== undefined) for (let r = 0; r < 6; r++) acc[r] -= model.loadVals[6 * li + r];
    }
    return sum;
}
