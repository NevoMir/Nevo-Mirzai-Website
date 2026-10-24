// Pure TypeScript 3D-frame solver: no WASM, no dependencies. Same element formulation and the same output layout /
// sign conventions as Awatif's lSolve (so the two are interchangeable and cross-checked in test/verify.ts):
// 12x12 Euler-Bernoulli beam stiffness (Przemieniecki), T^T k T assembly, reverse Cuthill-McKee ordering of the
// free nodes, banded Cholesky (A = L L^T), element end forces f = k T u.
// Measured (Node 22): 1000-block random blob 245 ms, full 10x10x10 cube 475 ms, 424-block hollow shell 32 ms.

import type { FrameModel, FrameSolution, FrameSolver } from "./types.ts";
import { FemError } from "./types.ts";

/** Awatif's local axes: x along the member, y horizontal (-m/D, l/D, 0), z = x cross y; vertical: see below. */
function localAxes(dx: number, dy: number, dz: number, L: number): number[] {
    const l = dx / L, m = dy / L, n = dz / L;
    const D = Math.sqrt(l * l + m * m);
    if (Math.abs(n - 1) < 1e-12) return [0, 0, 1, 0, 1, 0, -1, 0, 0];
    if (Math.abs(n + 1) < 1e-12) return [0, 0, -1, 0, 1, 0, 1, 0, 0];
    return [l, m, n, -m / D, l / D, 0, (-l * n) / D, (-m * n) / D, D];
}

export const solveFrameTs: FrameSolver = (model: FrameModel): FrameSolution => {
    const { nodes, elems, props } = model;
    const n = nodes.length / 3, m = elems.length / 2;
    const fixed = new Uint8Array(n);
    for (let i = 0; i < model.supportNodes.length; i++) fixed[model.supportNodes[i]] = 1;

    // adjacency of free nodes -> RCM
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < m; e++) {
        const a = elems[2 * e], b = elems[2 * e + 1];
        adj[a].push(b);
        adj[b].push(a);
    }
    const order: number[] = [];
    const seen = new Uint8Array(n);
    const bfs = (start: number): number[] => {
        const queue = [start];
        seen[start] = 1;
        const out: number[] = [];
        for (let h = 0; h < queue.length; h++) {
            const v = queue[h];
            out.push(v);
            const next = adj[v].filter((u) => !fixed[u] && !seen[u]).sort((p, q) => adj[p].length - adj[q].length);
            for (const u of next) {
                seen[u] = 1;
                queue.push(u);
            }
        }
        return out;
    };
    for (let s = 0; s < n; s++) {
        if (fixed[s] || seen[s]) continue;
        let comp = bfs(s); // pseudo-peripheral start: BFS twice
        for (const v of comp) seen[v] = 0;
        comp = bfs(comp[comp.length - 1]);
        order.push(...comp.reverse());
    }
    const nf = order.length;
    const pos = new Int32Array(n).fill(-1);
    order.forEach((v, i) => (pos[v] = i));
    let bw = 0;
    for (let e = 0; e < m; e++) {
        const a = pos[elems[2 * e]], b = pos[elems[2 * e + 1]];
        if (a >= 0 && b >= 0) bw = Math.max(bw, Math.abs(a - b));
    }
    const N = nf * 6, b = Math.min(6 * bw + 5, Math.max(N - 1, 0)), W = b + 1;
    const band = new Float64Array(N * W); // row i holds columns i-b..i at i*W + (j - i + b)
    const rhs = new Float64Array(N);

    const { E, A, Iz, Iy, G, J } = props;
    const k = new Float64Array(144), T = new Float64Array(144), KT = new Float64Array(144), Kg = new Float64Array(144);
    const kAll = new Float64Array(144 * m), tAll = new Float64Array(144 * m);
    for (let e = 0; e < m; e++) {
        const a = elems[2 * e], c = elems[2 * e + 1];
        const dx = nodes[3 * c] - nodes[3 * a], dy = nodes[3 * c + 1] - nodes[3 * a + 1], dz = nodes[3 * c + 2] - nodes[3 * a + 2];
        const L = Math.hypot(dx, dy, dz);
        if (!(L > 0)) throw new FemError("zero-length element", 4);
        const lam = localAxes(dx, dy, dz, L);
        k.fill(0);
        const EA = (E * A) / L, GJ = (G * J) / L;
        // Timoshenko factors phi = 12 E I / (kappa G A L^2); 0 -> Euler-Bernoulli (Awatif)
        const py = props.kappa ? (12 * E * Iz) / (props.kappa * G * A * L * L) : 0;
        const pz = props.kappa ? (12 * E * Iy) / (props.kappa * G * A * L * L) : 0;
        const a1 = (12 * E * Iz) / ((1 + py) * L ** 3), a2 = (6 * E * Iz) / ((1 + py) * L ** 2), a3 = ((4 + py) * E * Iz) / ((1 + py) * L), a4 = ((2 - py) * E * Iz) / ((1 + py) * L);
        const b1 = (12 * E * Iy) / ((1 + pz) * L ** 3), b2 = (6 * E * Iy) / ((1 + pz) * L ** 2), b3 = ((4 + pz) * E * Iy) / ((1 + pz) * L), b4 = ((2 - pz) * E * Iy) / ((1 + pz) * L);
        const S = (i: number, j: number, v: number) => {
            k[i * 12 + j] = v;
            k[j * 12 + i] = v;
        };
        S(0, 0, EA); S(0, 6, -EA); S(6, 6, EA);
        S(3, 3, GJ); S(3, 9, -GJ); S(9, 9, GJ);
        S(1, 1, a1); S(1, 5, a2); S(1, 7, -a1); S(1, 11, a2); S(5, 5, a3); S(5, 7, -a2); S(5, 11, a4); S(7, 7, a1); S(7, 11, -a2); S(11, 11, a3);
        S(2, 2, b1); S(2, 4, -b2); S(2, 8, -b1); S(2, 10, -b2); S(4, 4, b3); S(4, 8, b2); S(4, 10, b4); S(8, 8, b1); S(8, 10, b2); S(10, 10, b3);
        T.fill(0);
        for (let blk = 0; blk < 4; blk++) for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) T[(3 * blk + r) * 12 + 3 * blk + q] = lam[3 * r + q];
        for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
            let s = 0;
            for (let q = 0; q < 12; q++) s += k[i * 12 + q] * T[q * 12 + j];
            KT[i * 12 + j] = s;
        }
        for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
            let s = 0;
            for (let q = 0; q < 12; q++) s += T[q * 12 + i] * KT[q * 12 + j];
            Kg[i * 12 + j] = s;
        }
        kAll.set(k, 144 * e);
        tAll.set(T, 144 * e);
        const nd = [a, c];
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
            const pi = pos[nd[i]], pj = pos[nd[j]];
            if (pi < 0 || pj < 0) continue;
            for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) {
                const gi = 6 * pi + r, gj = 6 * pj + q;
                if (gj <= gi) band[gi * W + (gj - gi + b)] += Kg[(6 * i + r) * 12 + 6 * j + q];
            }
        }
    }
    for (let i = 0; i < model.loadNodes.length; i++) {
        const p = pos[model.loadNodes[i]];
        if (p >= 0) for (let r = 0; r < 6; r++) rhs[6 * p + r] += model.loadVals[6 * i + r];
    }
    // banded Cholesky, in place
    for (let i = 0; i < N; i++) {
        const j0 = Math.max(0, i - b);
        const bi = i * W - i + b;
        for (let j = j0; j <= i; j++) {
            let s = band[bi + j];
            const bj = j * W - j + b;
            for (let q = Math.max(j0, j - b); q < j; q++) s -= band[bi + q] * band[bj + q];
            if (i === j) {
                if (!(s > 0)) throw new FemError("stiffness matrix is not positive definite (part of the structure is not supported)", 1);
                band[bi + i] = Math.sqrt(s);
            } else band[bi + j] = s / band[bj + j];
        }
    }
    const y = Float64Array.from(rhs);
    for (let i = 0; i < N; i++) {
        let s = y[i];
        const bi = i * W - i + b;
        for (let q = Math.max(0, i - b); q < i; q++) s -= band[bi + q] * y[q];
        y[i] = s / band[bi + i];
    }
    for (let i = N - 1; i >= 0; i--) {
        const bi = i * W - i + b;
        y[i] /= band[bi + i];
        for (let q = Math.max(0, i - b); q < i; q++) y[q] -= band[bi + q] * y[i];
    }
    const u = new Float64Array(6 * n);
    for (let v = 0; v < n; v++) if (pos[v] >= 0) for (let r = 0; r < 6; r++) u[6 * v + r] = y[6 * pos[v] + r];

    const displacements = new Float64Array(3 * n);
    for (let v = 0; v < n; v++) for (let r = 0; r < 3; r++) displacements[3 * v + r] = u[6 * v + r];

    // element end forces, written with Awatif's layout and sign flips (see FrameSolution)
    const forces = new Float64Array(13 * m);
    const ug = new Float64Array(12), ul = new Float64Array(12), f = new Float64Array(12);
    for (let e = 0; e < m; e++) {
        const a = elems[2 * e], c = elems[2 * e + 1];
        for (let r = 0; r < 6; r++) {
            ug[r] = u[6 * a + r];
            ug[6 + r] = u[6 * c + r];
        }
        for (let i = 0; i < 12; i++) {
            let s = 0;
            for (let q = 0; q < 12; q++) s += tAll[144 * e + i * 12 + q] * ug[q];
            ul[i] = s;
        }
        for (let i = 0; i < 12; i++) {
            let s = 0;
            for (let q = 0; q < 12; q++) s += kAll[144 * e + i * 12 + q] * ul[q];
            f[i] = s;
        }
        const o = 13 * e;
        forces[o] = e;
        forces[o + 1] = f[0]; forces[o + 2] = -f[6];
        forces[o + 3] = -f[1]; forces[o + 4] = f[7];
        forces[o + 5] = -f[2]; forces[o + 6] = f[8];
        forces[o + 7] = f[3]; forces[o + 8] = -f[9];
        forces[o + 9] = -f[4]; forces[o + 10] = f[10];
        forces[o + 11] = -f[5]; forces[o + 12] = f[11];
    }
    return { displacements, forces };
};
