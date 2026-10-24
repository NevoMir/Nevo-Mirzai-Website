// The stabilizer's search: takes the occupied cells of an assembly and adds blocks until every check passes, adding as few as
// it can and never removing or moving a block it was given. Deterministic, pure TypeScript (no DOM, no randomness, no Node API).
//
// One move per iteration, for the first violated check in this priority order:
//   1 floating   join every floating part to the structure: the cheapest path of new blocks (Dijkstra over empty cells), or a
//                balanced set of legs under a big part (a table top, a roof)
//   2 reach      no block further than the cantilever limit from a supported block: support columns
//   3 cog        centre of gravity inside the support hull by COG_TARGET_MM: footing blocks at k = 0 (or props). A COG OUTSIDE
//                the base (the structure tips) is fixed before phase 4; a margin that is merely short is topped up after it
//                (props and braces often widen the base for free)
//   4 stress     joint utilisation at or under the target: props, spread props, brackets and thickening layers around the hot
//                region, each scored with the utilisation the solver actually computes for it
// then a clean-up (reverse-delete of added blocks that later moves made redundant).
//
// Compound moves: where no single column (reach) or run of footing blocks is enough, the plan that the best ones, taken one after
// the other, add up to is offered as one move (a wide cap on a thin stem needs a 2 x 2 stem, and the step on the way, a single
// extra column, makes the stress worse before the last one makes it better); a spread of legs is the same idea for stress.
//
// A move is only taken when the engine's own figures for the result (measure.ts: floating, overhang, centre of gravity, peak
// stress) are no worse than before, most important problem first (types.ts isWorse): no step of the log trades a more
// important problem for a less important one.
//
// The search is a generator: it yields between the expensive parts so a caller on the page can stay responsive and stop it;
// the worker simply drives it to the end (see stabilize.ts).

import { directionLabel } from "../geometry.ts";
import type { AddedRole, StabilizeReason, StabilizeStop } from "../../shared/contract.ts";
import { BLOCK_ROLES } from "../../shared/contract.ts";
import { cellCoords, cellIndex, evaluateGeometry, inGrid, NB6, occupiedNeighbours } from "./grid.ts";
import type { CogInfo, Dims, Geometry } from "./grid.ts";
import { measure } from "./measure.ts";
import type { Measured, MeasureEnv } from "./measure.ts";
import type { StressField, StressSolver } from "./stressAdapter.ts";
import { COG_TARGET_MM, isWorse } from "./types.ts";

const EPS = 1e-9;
const REL = 1e-7; // relative tolerance when comparing scores (WASM and TS solvers agree to ~1e-10)
const FOOTING_MARGIN = 2; // a footing may reach this many cells beyond the box of the given blocks
const STRESS_CANDIDATES = 12; // most FEM-scored proposals per stress move
const MAX_TRIES = 4; // ranked moves measured per iteration before the phase is given up
const MAX_PLAN_COLUMNS = 6; // columns in one reach plan
const MAX_PLAN_RUNS = 6; // footing runs or props in one centre-of-gravity plan
const MAX_SOLVES = 400;
const MAX_CLEANUP_SOLVES = 300;

export type Phase = "floating" | "reach" | "cog" | "stress";
type Operator = "bridge" | "column" | "footing" | "bracket" | "thicken";

/** What describe.ts needs to know about a move that the numbers do not say. */
export interface StepNote {
    /** What the move holds up or fixes: "arm tip", "overhang", "slab", "arm", "floating part", "joint". */
    target: string;
    /** Footings: "+X", "-Y" ... the side of the structure the blocks were put on. */
    side?: string;
    /** Floating moves: blocks in the part, and its mean height. */
    partBlocks?: number;
    partHeightMm?: number;
    /** Stress moves: the most stressed block that triggered it, and its utilisation. */
    hotCell?: [number, number, number];
    trigger?: number;
}

export interface SearchStep {
    /** 1-based position among the accepted moves. */
    n: number;
    phase: Phase;
    reason: StabilizeReason;
    move: AddedRole;
    cells: number[]; // cell indices, in insertion order
    roles: AddedRole[]; // same order
    note: StepNote;
    before: Measured;
    after: Measured;
}

export type SearchEvent =
    | { kind: "progress"; candidatesDone: number; candidatesTotal: number; steps: number; blocks: number }
    | { kind: "step"; step: SearchStep; blocks: number };

export interface SearchInput {
    dims: Dims;
    /** The blocks to start from. None of them is ever removed. */
    occupancy: Uint8Array;
    cantileverLimit: number;
    blockSizeMm: number;
    /** Stress level (share of the allowable) to get under. */
    target: number;
    /** Most blocks the assembly may end up with. */
    maxBlocks: number;
    maxSteps: number;
    timeBudgetMs: number;
    solve: StressSolver;
    env: MeasureEnv;
    onEvent?: (event: SearchEvent) => void;
    /** Polled between moves; true stops the search (stop = "canceled"). */
    cancelled?: () => boolean;
}

export interface SearchOutcome {
    /** The assembly: the given blocks plus every kept added block. */
    occ: Uint8Array;
    /** The accepted moves as they were made (before the clean-up). */
    steps: SearchStep[];
    /** Added cells the clean-up took out again. */
    removed: number[];
    stop: StabilizeStop;
    /** Figures for the starting state and for the state the loop ended in (before the clean-up). */
    start: Measured;
    end: Measured;
    stats: { solves: number; candidates: number; ms: number };
}

interface Box {
    i0: number;
    i1: number;
    j0: number;
    j1: number;
    kmax: number;
}

interface Ctx {
    input: SearchInput;
    d: Dims;
    N: number;
    plane: number;
    bs: number;
    limit: number;
    target: number;
    box: Box;
    solves: number;
    candidates: number;
    centroid: [number, number]; // xy centroid of the given blocks (mm), for the "outer" tie-break
    maxAdded: number;
    t0: number;
    lastProgress: number;
}

interface Placed {
    cell: number;
    role: AddedRole;
    step: number;
}

interface State {
    occ: Uint8Array;
    geo: Geometry;
    stress: StressField;
    measured: Measured;
    added: Placed[];
}

interface Cand {
    op: Operator;
    cells: number[]; // new cells, in insertion order
    roleOf: (c: number, geoAfter: Geometry) => AddedRole;
    cost: number; // number of blocks (plus a charge for any dip of the COG margin)
    gain: number; // reduction of the active phase's potential
    resolves: boolean;
    next: number; // secondary potential (smaller is better) for tie-breaking
    tuck: number;
    outer: number;
    geo: Geometry;
    stress?: StressField;
    note: StepNote;
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

/** Deterministic stand-in for the duration of one FEM solve of `n` blocks (measured: 14 ms at 206, 71 at 406, 573 at 1000). */
const estimatedSolveMs = (n: number): number => Math.max(1, 3.5e-4 * n * n);

function allowed(ctx: Ctx, i: number, j: number, k: number): boolean {
    const { box, d } = ctx;
    if (!inGrid(d, i, j, k) || k > box.kmax) return false;
    const m = k === 0 ? FOOTING_MARGIN : 0;
    return i >= box.i0 - m && i <= box.i1 + m && j >= box.j0 - m && j <= box.j1 + m;
}

/** Empty cells straight below `root` down to the first supported block or the ground; null when impossible/nothing to add. */
function dropColumn(ctx: Ctx, st: State, root: number): number[] | null {
    const [i, j, k] = cellCoords(ctx.d, root);
    const cells: number[] = [];
    for (let kk = k - 1; kk >= 0; kk--) {
        const c = cellIndex(ctx.d, i, j, kk);
        if (st.occ[c]) {
            if (st.geo.supported[c]) return cells.length > 0 ? cells : null;
            continue; // an unsupported block below: it becomes supported when the column is complete
        }
        if (!allowed(ctx, i, j, kk)) return null;
        cells.push(c);
    }
    return cells.length > 0 ? cells : null;
}

function withCells(occ: Uint8Array, cells: number[]): Uint8Array {
    const out = occ.slice();
    for (const c of cells) out[c] = 1;
    return out;
}

function tuckOf(ctx: Ctx, occAfter: Uint8Array, cells: number[]): number {
    let s = 0;
    for (const c of cells) s += occupiedNeighbours(occAfter, ctx.d, c);
    return s / cells.length;
}

function outerOf(ctx: Ctx, cells: number[]): number {
    let x = 0;
    let y = 0;
    for (const c of cells) {
        const [i, j] = cellCoords(ctx.d, c);
        x += (i + 0.5) * ctx.bs;
        y += (j + 0.5) * ctx.bs;
    }
    return Math.hypot(x / cells.length - ctx.centroid[0], y / cells.length - ctx.centroid[1]);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Most stressed first, the lower cell index among equals. "Equal" is within REL: two mirror-image joints of a symmetric model
 * differ by the solvers' 1e-12 noise, and an exact comparison would let WASM and TS pick different twins (and so different blocks).
 */
const hotter = (util: ArrayLike<number>) => (a: number, b: number): number => (near(util[a], util[b]) ? a - b : util[b] - util[a]);

/** Candidate order: resolves-the-phase first (cheapest, then lower secondary potential), else best gain per cost. */
function rank(a: Cand, b: Cand): number {
    if (a.resolves !== b.resolves) return a.resolves ? -1 : 1;
    if (a.resolves) {
        if (!near(a.cost, b.cost)) return a.cost - b.cost;
        if (!near(a.next, b.next)) return a.next - b.next;
    } else {
        const sa = a.gain / a.cost;
        const sb = b.gain / b.cost;
        if (!near(sa, sb)) return sb - sa;
        if (!near(a.cost, b.cost)) return a.cost - b.cost;
    }
    if (!near(a.tuck, b.tuck)) return b.tuck - a.tuck;
    if (!near(a.outer, b.outer)) return b.outer - a.outer;
    return a.cells[0] - b.cells[0] || a.cells.length - b.cells.length;
}

function solve(ctx: Ctx, occ: Uint8Array): StressField {
    ctx.solves++;
    return ctx.input.solve(occ, ctx.d);
}

/** Is a measured state worse than another (types.ts isWorse), compared on the unrounded figures? */
const worseThan = (ctx: Ctx, after: Measured, before: Measured): boolean => {
    const figures = (m: Measured) => ({ floating_blocks: m.metrics.floating_blocks, over_limit: m.metrics.over_limit, cog_margin_mm: m.raw.cogMarginMm, max_utilisation: m.raw.maxUtil });
    return isWorse(figures(after), figures(before), ctx.target);
};

const mmOf = (ctx: Ctx, cells: number[]): [number, number, number] => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of cells) {
        const [i, j, k] = cellCoords(ctx.d, c);
        x += (i + 0.5) * ctx.bs;
        y += (j + 0.5) * ctx.bs;
        z += (k + 0.5) * ctx.bs;
    }
    return [x / cells.length, y / cells.length, z / cells.length];
};

/** The role that names a move: a bridge if any block bridges, else the commonest (ties in BLOCK_ROLES order). */
export function moveOf(roles: readonly AddedRole[]): AddedRole {
    if (roles.includes("bridge")) return "bridge";
    let best: AddedRole = roles[0];
    let bestN = 0;
    for (const role of BLOCK_ROLES) {
        if (role === "original") continue;
        const n = roles.filter((r) => r === role).length;
        if (n > bestN) {
            best = role;
            bestN = n;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------------------------------------------
// binary heap for Dijkstra

class Heap {
    private keys: number[] = [];
    private ids: number[] = [];
    get size(): number {
        return this.keys.length;
    }
    push(key: number, id: number): void {
        const k = this.keys;
        const v = this.ids;
        let i = k.length;
        k.push(key);
        v.push(id);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (k[p] < key || (k[p] === key && v[p] <= id)) break;
            k[i] = k[p];
            v[i] = v[p];
            i = p;
        }
        k[i] = key;
        v[i] = id;
    }
    pop(): [number, number] {
        const k = this.keys;
        const v = this.ids;
        const topK = k[0];
        const topV = v[0];
        const lastK = k.pop() as number;
        const lastV = v.pop() as number;
        const n = k.length;
        if (n > 0) {
            let i = 0;
            for (;;) {
                let c = 2 * i + 1;
                if (c >= n) break;
                if (c + 1 < n && (k[c + 1] < k[c] || (k[c + 1] === k[c] && v[c + 1] < v[c]))) c++;
                if (lastK < k[c] || (lastK === k[c] && lastV <= v[c])) break;
                k[i] = k[c];
                v[i] = v[c];
                i = c;
            }
            k[i] = lastK;
            v[i] = lastV;
        }
        return [topK, topV];
    }
}

// ---------------------------------------------------------------------------------------------------------------
// phase 1: floating parts -> bridges

type TermClass = "supported" | "ground" | "cantilever";

function floatingNote(ctx: Ctx, cells: number[]): StepNote {
    return { target: "floating part", partBlocks: cells.length, partHeightMm: mmOf(ctx, cells)[2] };
}

function bridgeCandidates(ctx: Ctx, st: State): Cand[] {
    const { d, N } = ctx;
    const out: Cand[] = [];
    const geo = st.geo;
    const floating = geo.bodies.filter((b) => !b.grounded);
    const TURN = 0.15;
    for (const body of floating) {
        const dist = new Float64Array(N * 6).fill(Infinity);
        const parent = new Int32Array(N * 6).fill(-1);
        const heap = new Heap();
        let cx = 0;
        let cy = 0;
        for (const c of body.cells) {
            const [i, j] = cellCoords(d, c);
            cx += (i + 0.5) * ctx.bs;
            cy += (j + 0.5) * ctx.bs;
        }
        cx /= body.cells.length;
        cy /= body.cells.length;
        const best = new Map<TermClass, { cost: number; state: number; central: number }>();
        const offer = (cls: TermClass, cost: number, state: number, p: number) => {
            const [pi, pj] = cellCoords(d, p);
            const central = Math.hypot((pi + 0.5) * ctx.bs - cx, (pj + 0.5) * ctx.bs - cy);
            const cur = best.get(cls);
            if (!cur || cost < cur.cost - EPS || (Math.abs(cost - cur.cost) <= EPS && (central < cur.central - EPS || (Math.abs(central - cur.central) <= EPS && state < cur.state)))) best.set(cls, { cost, state, central });
        };
        for (const s of body.cells) {
            const [i, j, k] = cellCoords(d, s);
            for (let q = 0; q < 6; q++) {
                const ni = i + NB6[q][0];
                const nj = j + NB6[q][1];
                const nk = k + NB6[q][2];
                if (!allowed(ctx, ni, nj, nk)) continue;
                const n = cellIndex(d, ni, nj, nk);
                if (st.occ[n]) continue;
                const sid = n * 6 + q;
                if (1 < dist[sid]) {
                    dist[sid] = 1;
                    heap.push(1, sid);
                }
            }
        }
        let floor = Infinity;
        while (heap.size > 0) {
            const [g, sid] = heap.pop();
            if (g > dist[sid] + EPS) continue;
            if (g > floor + 6) break;
            const p = (sid / 6) | 0;
            const dir = sid - p * 6;
            const [i, j, k] = cellCoords(d, p);
            if (k === 0) {
                offer("ground", g, sid, p);
                floor = Math.min(floor, g);
            }
            for (let q = 0; q < 6; q++) {
                const ni = i + NB6[q][0];
                const nj = j + NB6[q][1];
                const nk = k + NB6[q][2];
                if (!inGrid(d, ni, nj, nk)) continue;
                const n = cellIndex(d, ni, nj, nk);
                if (st.occ[n]) {
                    const b = geo.bodyOf[n];
                    if (b !== body.id && geo.bodies[b].grounded) {
                        offer(st.geo.supported[n] ? "supported" : "cantilever", g, sid, p);
                        floor = Math.min(floor, g);
                    }
                    continue;
                }
                if (!allowed(ctx, ni, nj, nk)) continue;
                const ng = g + 1 + (q !== dir ? TURN : 0);
                const nsid = n * 6 + q;
                if (ng < dist[nsid] - EPS) {
                    dist[nsid] = ng;
                    parent[nsid] = sid;
                    heap.push(ng, nsid);
                }
            }
        }
        for (const [, rec] of [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
            const cells: number[] = [];
            for (let s = rec.state; s >= 0; s = parent[s]) cells.push((s / 6) | 0);
            cells.reverse(); // from the floating part outwards
            if (cells.length === 0) continue;
            const occAfter = withCells(st.occ, cells);
            const geoAfter = evaluateGeometry(occAfter, d, ctx.bs, ctx.limit, COG_TARGET_MM);
            ctx.candidates++;
            // what the join leaves behind: overhang that the next phase must still support (about 1 block per step)
            const resid = 1.5 * geoAfter.overreachExcess;
            out.push({
                op: "bridge",
                cells,
                roleOf: (c, g) => (g.supported[c] ? "column" : "bridge"),
                cost: cells.length,
                gain: body.cells.length,
                resolves: true,
                next: cells.length + resid,
                tuck: tuckOf(ctx, occAfter, cells),
                outer: outerOf(ctx, cells),
                geo: geoAfter,
                note: floatingNote(ctx, body.cells),
            });
        }
    }
    // balanced multi-column joins for big floating parts (a table top, a roof): the cheapest single path leaves a
    // huge overhang (key = cost + 1.5 x overhang), so a set of legs under the part often has the lower key
    for (const body of floating) {
        const roots: number[] = [];
        let cx = 0;
        let cy = 0;
        for (const c of body.cells) {
            const [i, j] = cellCoords(d, c);
            cx += i / body.cells.length;
            cy += j / body.cells.length;
            if (c >= ctx.plane && !st.occ[c - ctx.plane]) roots.push(c);
        }
        for (const cells of spreadSets(ctx, st, roots, [cx, cy])) {
            const occAfter = withCells(st.occ, cells);
            const geoAfter = evaluateGeometry(occAfter, d, ctx.bs, ctx.limit, COG_TARGET_MM);
            ctx.candidates++;
            out.push({
                op: "bridge",
                cells,
                roleOf: (c, g) => (g.supported[c] ? "column" : "bridge"),
                cost: cells.length,
                gain: body.cells.length,
                resolves: true,
                next: cells.length + 1.5 * geoAfter.overreachExcess,
                tuck: tuckOf(ctx, occAfter, cells),
                outer: outerOf(ctx, cells),
                geo: geoAfter,
                note: floatingNote(ctx, body.cells),
            });
        }
    }
    // the cheapest "join" overall (own cost + the overhang it leaves behind), then the usual tie-breaks
    out.sort((a, b) => {
        if (!near(a.next, b.next)) return a.next - b.next;
        if (!near(a.tuck, b.tuck)) return b.tuck - a.tuck;
        return a.cells[0] - b.cells[0];
    });
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 2: reach -> support columns

function columnRoots(st: State): number[] {
    const { occ, geo } = st;
    const { dims } = geo;
    const plane = dims.gx * dims.gy;
    const roots: number[] = [];
    for (let c = plane; c < occ.length; c++) {
        if (!occ[c] || geo.supported[c] || occ[c - plane]) continue;
        if (!geo.bodies[geo.bodyOf[c]].grounded) continue;
        roots.push(c);
    }
    return roots;
}

function columnCandidates(ctx: Ctx, st: State, phase: "reach" | "cog", roots: number[], guard: (g: Geometry) => boolean, noteOf: (root: number) => StepNote): Cand[] {
    const out: Cand[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
        const cells = dropColumn(ctx, st, root);
        if (!cells) continue;
        const key = cells.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        const occAfter = withCells(st.occ, cells);
        const geoAfter = evaluateGeometry(occAfter, ctx.d, ctx.bs, ctx.limit, COG_TARGET_MM);
        ctx.candidates++;
        if (!guard(geoAfter)) continue;
        out.push({
            op: "column",
            cells,
            roleOf: () => "column",
            cost: cells.length,
            gain: phase === "reach" ? st.geo.overreachExcess - geoAfter.overreachExcess : st.geo.cogPhi - geoAfter.cogPhi,
            resolves: phase === "reach" ? geoAfter.overreachExcess === 0 : geoAfter.marginMm >= COG_TARGET_MM - 1e-6,
            next: phase === "reach" ? geoAfter.cogPhi : 0,
            tuck: tuckOf(ctx, occAfter, cells),
            outer: outerOf(ctx, cells),
            geo: geoAfter,
            note: noteOf(root),
        });
    }
    return out;
}

function reachCandidates(ctx: Ctx, st: State): Cand[] {
    const guard = (g: Geometry) => g.floatingCells <= st.geo.floatingCells;
    // The tip of an arm (as far from support as anything is) reads "arm tip"; a block part-way along "overhang".
    const noteOf = (root: number, s: State): StepNote => ({ target: s.geo.reach[root] >= s.geo.longestReach ? "arm tip" : "overhang" });
    const best = (s: State): Cand[] =>
        columnCandidates(ctx, s, "reach", columnRoots(s), guard, (root) => noteOf(root, s))
            .filter((c) => c.gain > EPS)
            .sort(rank);
    const singles = best(st);
    if (singles.length === 0 || singles[0].resolves) return singles;
    // No single column is enough (a wide slab on a thin stem, an arm with a long branch): the plan that the best columns,
    // taken one after the other, add up to. Offered as one move, so the moves in between (which may well make the stress
    // worse before the last column makes it better) do not have to pass on their own.
    const cells: number[] = [];
    let scratch: State = st;
    let pick: Cand | undefined = singles[0];
    for (let n = 0; pick && n < MAX_PLAN_COLUMNS; n++) {
        cells.push(...pick.cells);
        scratch = { ...st, occ: withCells(st.occ, cells), geo: pick.geo };
        if (pick.geo.overreachExcess === 0) {
            const occAfter = scratch.occ;
            const plan: Cand = {
                op: "column",
                cells,
                roleOf: () => "column",
                cost: cells.length,
                gain: st.geo.overreachExcess,
                resolves: true,
                next: pick.geo.cogPhi,
                tuck: tuckOf(ctx, occAfter, cells),
                outer: outerOf(ctx, cells),
                geo: pick.geo,
                note: singles[0].note,
            };
            return [plan, ...singles];
        }
        pick = best(scratch)[0];
    }
    return singles;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 3: centre of gravity -> footing (and props)

/** The side of the structure some blocks went on, seen from the middle of its footprint: "+X", "-X and +Y", or "" when they went all round. */
function sideFor(ctx: Ctx, st: State, weak: CogInfo, cells: number[]): string {
    const ground = st.geo.bodies[weak.bodyId].cells.filter((c) => c < ctx.plane);
    if (ground.length === 0) return "";
    const [fx, fy] = mmOf(ctx, ground);
    const [x, y] = mmOf(ctx, cells);
    return directionLabel(x - fx, y - fy);
}

function cogSingles(ctx: Ctx, st: State): Cand[] {
    const weak = st.geo.weakest;
    if (!weak) return [];
    const body = st.geo.bodies[weak.bodyId];
    const { d } = ctx;
    const groundCells = body.cells.filter((c) => c < ctx.plane);
    const guard = (g: Geometry) => g.floatingCells <= st.geo.floatingCells && g.overreachExcess <= st.geo.overreachExcess;
    const sideOf = (cells: number[]): string => sideFor(ctx, st, weak, cells);
    const out: Cand[] = [];
    const seen = new Set<string>();
    // footing runs: 1..3 blocks in a straight line, starting next to the footprint and going outwards
    const frontier = new Set<number>();
    for (const c of groundCells) {
        const [i, j] = cellCoords(d, c);
        for (let q = 0; q < 4; q++) {
            const ni = i + NB6[q][0];
            const nj = j + NB6[q][1];
            if (!allowed(ctx, ni, nj, 0)) continue;
            const n = cellIndex(d, ni, nj, 0);
            if (!st.occ[n]) frontier.add(n);
        }
    }
    for (const f of [...frontier].sort((a, b) => a - b)) {
        const [fi, fj] = cellCoords(d, f);
        for (let q = 0; q < 4; q++) {
            const cells: number[] = [];
            for (let len = 1; len <= 3; len++) {
                const ni = fi + NB6[q][0] * (len - 1);
                const nj = fj + NB6[q][1] * (len - 1);
                if (!allowed(ctx, ni, nj, 0)) break;
                const n = cellIndex(d, ni, nj, 0);
                if (st.occ[n]) break;
                cells.push(n);
                const key = [...cells].sort((a, b) => a - b).join(",");
                if (seen.has(key)) continue;
                seen.add(key);
                const occAfter = withCells(st.occ, cells);
                const geoAfter = evaluateGeometry(occAfter, d, ctx.bs, ctx.limit, COG_TARGET_MM);
                ctx.candidates++;
                if (!guard(geoAfter)) continue;
                const gain = st.geo.cogPhi - geoAfter.cogPhi;
                if (gain <= EPS) continue;
                const here = [...cells];
                out.push({
                    op: "footing",
                    cells: here,
                    roleOf: () => "footing",
                    cost: here.length,
                    gain,
                    resolves: geoAfter.marginMm >= COG_TARGET_MM - 1e-6,
                    next: 0,
                    tuck: tuckOf(ctx, occAfter, here),
                    outer: outerOf(ctx, here),
                    geo: geoAfter,
                    note: { target: "base", side: sideOf(here) || undefined },
                });
            }
        }
    }
    // props under unsupported blocks of the same body also widen the base
    const roots = columnRoots(st).filter((c) => st.geo.bodyOf[c] === weak.bodyId);
    const props = columnCandidates(ctx, st, "cog", roots, guard, () => ({ target: "base" }));
    for (const cand of props) {
        if (cand.gain <= EPS) continue;
        cand.note.side = sideOf(cand.cells) || undefined;
        out.push(cand);
    }
    return out.sort(rank);
}

/**
 * The footing blocks (or props) the best moves, taken one after the other, add up to: offered as one move when no single run of
 * blocks clears what the phase is for (a tower needs a footing on every side; a column flanked on both sides), so the log reads
 * "4 footings" rather than four steps. Stops as soon as the phase is cleared: out of tipping (margin 1 mm), else the full margin.
 */
function cogCandidates(ctx: Ctx, st: State): Cand[] {
    const singles = cogSingles(ctx, st);
    if (singles.length === 0) return singles;
    const tipping = st.geo.marginMm < 1;
    const cleared = (g: Geometry): boolean => g.marginMm >= (tipping ? 1 : COG_TARGET_MM) - 1e-6;
    if (cleared(singles[0].geo)) return singles;
    const cells: number[] = [];
    const roleAt = new Map<number, AddedRole>();
    let scratch: State = st;
    let pick: Cand | undefined = singles[0];
    for (let n = 0; pick && n < MAX_PLAN_RUNS; n++) {
        for (const c of pick.cells) {
            cells.push(c);
            roleAt.set(c, pick.roleOf(c, pick.geo));
        }
        scratch = { ...st, occ: withCells(st.occ, cells), geo: pick.geo };
        if (cleared(pick.geo)) {
            const occAfter = scratch.occ;
            const plan: Cand = {
                op: "footing",
                cells,
                roleOf: (c) => roleAt.get(c) as AddedRole,
                cost: cells.length,
                gain: st.geo.cogPhi - pick.geo.cogPhi,
                resolves: true,
                next: 0,
                tuck: tuckOf(ctx, occAfter, cells),
                outer: outerOf(ctx, cells),
                geo: pick.geo,
                note: { target: "base", side: (st.geo.weakest && sideFor(ctx, st, st.geo.weakest, cells)) || undefined },
            };
            return [plan, ...singles];
        }
        pick = cogSingles(ctx, scratch)[0];
    }
    return singles;
}

// ---------------------------------------------------------------------------------------------------------------
// phase 4: stress -> props, brackets, thickening, each scored with the FEM

/**
 * Balanced sets of support columns around a centre (cell units): for each distance r in {2, 3, 4} (Chebyshev, in
 * cells) one column per quadrant, taken from `roots` (unsupported blocks with room underneath), the one closest to
 * the diagonal. Needs >= 2 quadrants. Deterministic.
 */
function spreadSets(ctx: Ctx, st: State, roots: number[], centre: [number, number]): number[][] {
    const usable: Array<{ r: number; cells: number[]; cost: number }> = [];
    for (const r of roots) {
        const cells = dropColumn(ctx, st, r);
        if (cells) usable.push({ r, cells, cost: cells.length });
    }
    const sets: number[][] = [];
    for (const rStar of [2, 3, 4]) {
        const pick = new Map<string, { r: number; cells: number[]; score: number }>();
        for (const u of usable) {
            const [ui, uj] = cellCoords(ctx.d, u.r);
            const dx = ui - centre[0];
            const dy = uj - centre[1];
            if (Math.floor(Math.max(Math.abs(dx), Math.abs(dy)) + 0.5 + 1e-6) !== rStar) continue; // round half up, immune to float noise
            const q = `${dx >= 0 ? "+" : "-"}${dy >= 0 ? "+" : "-"}`;
            const score = Math.abs(Math.abs(dx) - Math.abs(dy)) * 100 + u.cost * 10;
            const cur = pick.get(q);
            if (!cur || score < cur.score - 1e-9 || (Math.abs(score - cur.score) <= 1e-9 && u.r < cur.r)) pick.set(q, { r: u.r, cells: u.cells, score });
        }
        if (pick.size >= 2) sets.push([...new Set([...pick.values()].sort((x, y) => x.r - y.r).flatMap((p) => p.cells))]);
    }
    return sets;
}

const phiStress = (f: StressField, target: number): number => {
    let s = 0;
    for (let c = 0; c < f.util.length; c++) {
        const e = f.util[c] - target;
        if (e > 0) s += e * e;
    }
    return s;
};

/** A new cell that sits in an inner corner (neighbours on >= 2 axes): a bracket/haunch rather than a plain layer. */
function cornerLike(ctx: Ctx, g: Geometry, c: number): boolean {
    const [i, j, k] = cellCoords(ctx.d, c);
    const axes = new Set<number>();
    NB6.forEach(([a, b, e], q) => {
        if (inGrid(ctx.d, i + a, j + b, k + e)) {
            const n = cellIndex(ctx.d, i + a, j + b, k + e);
            if (g.bodyOf[n] >= 0) axes.add(q >> 1);
        }
    });
    return axes.size >= 2;
}

function progress(ctx: Ctx, st: State, steps: number, done: number, total: number): void {
    const now = performance.now();
    if (now - ctx.lastProgress < 100) return; // at most ten a second
    ctx.lastProgress = now;
    ctx.input.onEvent?.({ kind: "progress", candidatesDone: done, candidatesTotal: total, steps, blocks: st.geo.count });
}

function* stressCandidates(ctx: Ctx, st: State, steps: number): Generator<void, Cand[]> {
    const stress = st.stress;
    const { d } = ctx;
    const target = ctx.target;
    // hot regions: 6-connected groups of blocks above the target, worst first
    const hot: number[] = [];
    for (let c = 0; c < stress.util.length; c++) if (stress.util[c] > target) hot.push(c);
    hot.sort(hotter(stress.util));
    const inHot = new Set(hot);
    const seen = new Set<number>();
    const regions: number[][] = [];
    for (const h of hot) {
        if (seen.has(h)) continue;
        const reg: number[] = [];
        const stack = [h];
        seen.add(h);
        while (stack.length) {
            const c = stack.pop() as number;
            reg.push(c);
            const [i, j, k] = cellCoords(d, c);
            for (const [di, dj, dk] of NB6) {
                if (!inGrid(d, i + di, j + dj, k + dk)) continue;
                const n = cellIndex(d, i + di, j + dj, k + dk);
                if (inHot.has(n) && !seen.has(n)) {
                    seen.add(n);
                    stack.push(n);
                }
            }
        }
        reg.sort(hotter(stress.util));
        regions.push(reg.slice(0, 12));
        if (regions.length >= 2) break;
    }

    interface Proposal {
        op: Operator;
        cells: number[];
        role: (c: number, g: Geometry) => AddedRole;
        prio: number;
        note: StepNote;
    }
    const proposals: Proposal[] = [];
    const keys = new Set<string>();
    const add = (op: Operator, cells: number[], role: (c: number, g: Geometry) => AddedRole, prio: number, note: StepNote) => {
        if (cells.length === 0) return;
        const key = [...cells].sort((a, b) => a - b).join(",");
        if (keys.has(key)) return;
        keys.add(key);
        proposals.push({ op, cells, role, prio, note });
    };

    for (const region of regions) {
        const worst = region[0];
        const [wi, wj, wk] = cellCoords(d, worst);
        const regionSet = new Set(region);
        const hotCell: [number, number, number] = [wi, wj, wk];
        // A wide region (3 x 3 blocks or more in plan) is a slab, a narrow one an arm.
        let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
        for (const r of region) {
            const [ri, rj] = cellCoords(d, r);
            i0 = Math.min(i0, ri); i1 = Math.max(i1, ri); j0 = Math.min(j0, rj); j1 = Math.max(j1, rj);
        }
        const wide = i1 - i0 >= 2 && j1 - j0 >= 2;
        const propNote: StepNote = { target: wide ? "slab" : "arm", hotCell, trigger: stress.util[worst] };
        const jointNote: StepNote = { target: "joint", hotCell, trigger: stress.util[worst] };
        // downstream: blocks whose only way to the ground leads through the region (an arm beyond a hot root)
        const reached = new Uint8Array(ctx.N);
        const queue: number[] = [];
        for (let c = 0; c < ctx.plane; c++) if (st.occ[c] && !regionSet.has(c)) { reached[c] = 1; queue.push(c); }
        for (let q = 0; q < queue.length; q++) {
            const c = queue[q];
            const [i, j, k] = cellCoords(d, c);
            for (const [di, dj, dk] of NB6) {
                if (!inGrid(d, i + di, j + dj, k + dk)) continue;
                const n = cellIndex(d, i + di, j + dj, k + dk);
                if (st.occ[n] && !reached[n] && !regionSet.has(n)) {
                    reached[n] = 1;
                    queue.push(n);
                }
            }
        }
        // props: unsupported block bottoms downstream of the region or within 2 blocks of it
        const nearRegion = (c: number): boolean => {
            const [i, j, k] = cellCoords(d, c);
            for (const r of region) {
                const [ri, rj, rk] = cellCoords(d, r);
                if (Math.max(Math.abs(ri - i), Math.abs(rj - j), Math.abs(rk - k)) <= 2) return true;
            }
            return false;
        };
        const roots = columnRoots(st).filter((c) => st.geo.bodyOf[c] === st.geo.bodyOf[worst] && (!reached[c] || nearRegion(c)));
        // one prop per distinct reach value (the nearest to the hot spot), so the candidates differ in lever arm:
        // a column right next to the hot root, one half way out, one at the far end of the overhang
        const byReach = new Map<number, { r: number; cells: number[]; dist: number }>();
        for (const r of roots) {
            const cells = dropColumn(ctx, st, r);
            if (!cells) continue;
            const [ri, rj, rk] = cellCoords(d, r);
            const dist = Math.hypot(ri - wi, rj - wj, rk - wk);
            const rr = st.geo.reach[r];
            const cur = byReach.get(rr);
            if (!cur || cells.length < cur.cells.length || (cells.length === cur.cells.length && (dist < cur.dist - 1e-9 || (Math.abs(dist - cur.dist) <= 1e-9 && r < cur.r)))) byReach.set(rr, { r, cells, dist });
        }
        const props = [...byReach.values()].sort((a, b) => a.cells.length - b.cells.length || a.dist - b.dist || a.r - b.r).slice(0, 5);
        // spread props (compound move): one column in each quadrant around the region at the same distance, added
        // together. A single extra support next to a stressed slab often RAISES the peak (it attracts load and makes
        // a new hard point); a balanced set splits the span for real.
        const rc: [number, number] = [0, 0];
        for (const r of region) {
            const [ri, rj] = cellCoords(d, r);
            rc[0] += ri / region.length;
            rc[1] += rj / region.length;
        }
        for (const cells of spreadSets(ctx, st, roots, rc)) add("column", cells, () => "column", 4, propNote);
        for (const p of props) add("column", p.cells, () => "column", 1, propNote);

        // brackets: inner-corner cells next to the region (>= 2 occupied neighbours on different axes)
        const corner: Array<{ c: number; n: number; dist: number }> = [];
        const tried = new Set<number>();
        for (const r of region) {
            const [ri, rj, rk] = cellCoords(d, r);
            for (const [di, dj, dk] of NB6) {
                const ni = ri + di;
                const nj = rj + dj;
                const nk = rk + dk;
                if (!allowed(ctx, ni, nj, nk)) continue;
                const n = cellIndex(d, ni, nj, nk);
                if (st.occ[n] || tried.has(n)) continue;
                tried.add(n);
                const axes = new Set<number>();
                let cnt = 0;
                NB6.forEach(([a, b, e], q) => {
                    if (inGrid(d, ni + a, nj + b, nk + e) && st.occ[cellIndex(d, ni + a, nj + b, nk + e)]) {
                        axes.add(q >> 1);
                        cnt++;
                    }
                });
                if (axes.size >= 2) corner.push({ c: n, n: cnt, dist: Math.hypot(ni - wi, nj - wj, nk - wk) });
            }
        }
        corner.sort((a, b) => b.n - a.n || a.dist - b.dist || a.c - b.c);
        for (const c of corner.slice(0, 3)) add("bracket", [c.c], () => "bracket", 2, jointNote);

        // thickening: a parallel layer of blocks on one side of the region (6 sides), at most 8 blocks
        for (const [di, dj, dk] of NB6) {
            const layer: number[] = [];
            for (const r of region) {
                const [ri, rj, rk] = cellCoords(d, r);
                const ni = ri + di;
                const nj = rj + dj;
                const nk = rk + dk;
                if (!allowed(ctx, ni, nj, nk)) continue;
                const n = cellIndex(d, ni, nj, nk);
                if (!st.occ[n] && !regionSet.has(n)) layer.push(n);
            }
            if (layer.length === 0) continue;
            layer.sort((a, b) => a - b);
            add("thicken", layer.slice(0, 8), (c, g) => (cornerLike(ctx, g, c) ? "bracket" : "reinforcement"), 3, jointNote);
        }
    }

    // geometry guard first (cheap), then FEM on at most K proposals, K shrinking as the solves get slower
    const out: Cand[] = [];
    const before = phiStress(stress, target);
    let evaluated = 0;
    const budget = Math.max(3, Math.min(STRESS_CANDIDATES, Math.floor(1500 / estimatedSolveMs(st.geo.count))));
    // round-robin over the proposal classes (columns, brackets, thickening) so a small budget still tries each kind
    const byClass: Proposal[][] = [[], [], [], []];
    for (const p of proposals) byClass[p.prio - 1].push(p);
    const ordered: Proposal[] = [];
    for (let r = 0; ordered.length < proposals.length; r++) for (const list of byClass) if (r < list.length) ordered.push(list[r]);
    for (const p of ordered) {
        if (evaluated >= budget || performance.now() - ctx.t0 > ctx.input.timeBudgetMs) break;
        if (st.added.length + p.cells.length > ctx.maxAdded) continue;
        const occAfter = withCells(st.occ, p.cells);
        const geoAfter = evaluateGeometry(occAfter, d, ctx.bs, ctx.limit, COG_TARGET_MM);
        ctx.candidates++;
        if (geoAfter.floatingCells > 0 || geoAfter.overreachExcess > st.geo.overreachExcess) continue;
        // The COG margin may dip by up to half the target (a prop or a thicker layer moves the COG a little); the
        // cog phase then pays for it with footing blocks, and the dip is charged to the candidate's cost below.
        const keepMargin = Math.min(st.geo.marginMm, COG_TARGET_MM) - 0.5 * COG_TARGET_MM;
        if (geoAfter.marginMm < keepMargin - 1e-6) continue;
        if (ctx.solves >= MAX_SOLVES) break;
        progress(ctx, st, steps, evaluated, budget);
        const field = solve(ctx, occAfter);
        evaluated++;
        yield;
        const after = phiStress(field, target);
        const gain = before - after;
        if (gain <= EPS * Math.max(1, before)) continue;
        out.push({
            op: p.op,
            cells: p.cells,
            roleOf: p.role,
            cost: p.cells.length + (Math.max(0, COG_TARGET_MM - geoAfter.marginMm) / ctx.bs) * 0.5,
            gain,
            resolves: field.maxUtil <= target + 1e-9,
            next: field.maxUtil,
            tuck: tuckOf(ctx, occAfter, p.cells),
            outer: outerOf(ctx, p.cells),
            geo: geoAfter,
            stress: field,
            note: p.note,
        });
    }
    return out.sort(rank);
}

// ---------------------------------------------------------------------------------------------------------------
// the loop

const REASON: Record<Phase, StabilizeReason> = { floating: "floating", reach: "cantilever", cog: "cog", stress: "stress" };

export function* search(input: SearchInput): Generator<void, SearchOutcome> {
    const d = input.dims;
    const N = d.gx * d.gy * d.gz;
    const t0 = performance.now();
    const bs = input.blockSizeMm;
    // box of the given blocks
    const box: Box = { i0: d.gx, i1: -1, j0: d.gy, j1: -1, kmax: -1 };
    let n0 = 0;
    let cx = 0;
    let cy = 0;
    for (let c = 0; c < N; c++) {
        if (!input.occupancy[c]) continue;
        n0++;
        const [i, j, k] = cellCoords(d, c);
        box.i0 = Math.min(box.i0, i);
        box.i1 = Math.max(box.i1, i);
        box.j0 = Math.min(box.j0, j);
        box.j1 = Math.max(box.j1, j);
        box.kmax = Math.max(box.kmax, k);
        cx += (i + 0.5) * bs;
        cy += (j + 0.5) * bs;
    }
    // Added blocks are capped by the caller's budget and, as a safeguard against a runaway fix of a hopeless model, by
    // three quarters of what was given (at least 24).
    const safeRoom = Math.max(24, Math.ceil(0.75 * n0));
    const userRoom = input.maxBlocks - n0;
    const maxAdded = Math.max(0, Math.min(N - n0, userRoom, safeRoom));
    // Only the caller's own budget (below the grid's 1000 cells, and the tightest limit) is reported as "max-blocks": running
    // into the safeguard is not a budget the user set, and the banner would blame one they never chose.
    const budgetBinds = input.maxBlocks < N && userRoom <= Math.min(N - n0, safeRoom);
    const ctx: Ctx = {
        input,
        d,
        N,
        plane: d.gx * d.gy,
        bs,
        limit: input.cantileverLimit,
        target: input.target,
        box,
        solves: 0,
        candidates: 0,
        centroid: n0 > 0 ? [cx / n0, cy / n0] : [0, 0],
        maxAdded,
        t0,
        lastProgress: 0,
    };
    const occ0 = Uint8Array.from(input.occupancy);
    const field0 = solve(ctx, occ0);
    const start = measure(occ0, field0.solved > 0 ? field0 : null, input.env);
    const st: State = { occ: Uint8Array.from(occ0), geo: evaluateGeometry(occ0, d, bs, ctx.limit, COG_TARGET_MM), stress: field0, measured: start, added: [] };
    const steps: SearchStep[] = [];
    const finish = (stop: StabilizeStop, removed: number[]): SearchOutcome => ({
        occ: st.occ,
        steps,
        removed,
        stop,
        start,
        end: st.measured,
        stats: { solves: ctx.solves, candidates: ctx.candidates, ms: performance.now() - t0 },
    });
    if (n0 === 0) return finish("no-improving-move", []);

    const exhausted = new Set<Phase>();
    let stop: StabilizeStop | null = null;
    let capHit = false;
    let solveCapHit = false;
    const maxSteps = Math.max(0, input.maxSteps);

    const violated = (): Phase | null => {
        const g = st.geo;
        if (g.floatingCells > 0 && !exhausted.has("floating")) return "floating";
        if (g.overreachCells > 0 && !exhausted.has("reach")) return "reach";
        const cogBad = g.marginMm < COG_TARGET_MM - 1e-6 && !exhausted.has("cog");
        // A structure whose centre of gravity is outside (or on the edge of) its base is tipping: the bonded-base stress is
        // then just the overturning moment, so that is fixed first. A margin that is merely below the target is topped
        // up last, after the stress fixes (props and braces often widen the base for free).
        if (cogBad && g.marginMm < 1) return "cog";
        if (st.stress.maxUtil > ctx.target + 1e-9 && !exhausted.has("stress")) return "stress";
        if (cogBad) return "cog";
        return null;
    };

    let iteration = 0;
    while (iteration < maxSteps) {
        yield;
        const phase = violated();
        if (!phase) break; // nothing left to fix, whatever the budget
        if (input.cancelled?.()) {
            stop = "canceled";
            break;
        }
        if (performance.now() - t0 > input.timeBudgetMs) {
            stop = "time-budget";
            break;
        }
        if (ctx.solves >= MAX_SOLVES) {
            // The work limit, not the clock: reported as a limit of steps ("It reached the limit of steps"), never as "out of time".
            stop = "max-steps";
            solveCapHit = true;
            break;
        }
        let cands: Cand[];
        if (phase === "floating") cands = bridgeCandidates(ctx, st);
        else if (phase === "reach") cands = reachCandidates(ctx, st);
        else if (phase === "cog") cands = cogCandidates(ctx, st);
        else cands = yield* stressCandidates(ctx, st, iteration);
        if (phase !== "stress") progress(ctx, st, iteration, cands.length, cands.length);
        const affordable = cands.filter((c) => st.added.length + c.cells.length <= ctx.maxAdded);
        if (affordable.length === 0) {
            if (cands.length > 0) capHit = true;
            exhausted.add(phase);
            continue;
        }
        // Take the best-ranked move whose result is no worse than where we are (the engine's own figures decide).
        let taken = false;
        for (const cand of affordable.slice(0, MAX_TRIES)) {
            const occAfter = withCells(st.occ, cand.cells);
            const field = cand.stress ?? solve(ctx, occAfter);
            const now = measure(occAfter, field.solved > 0 ? field : null, input.env);
            if (worseThan(ctx, now, st.measured)) continue;
            iteration++;
            const roles = cand.cells.map((c) => cand.roleOf(c, cand.geo));
            const step: SearchStep = { n: iteration, phase, reason: REASON[phase], move: moveOf(roles), cells: cand.cells, roles, note: cand.note, before: st.measured, after: now };
            cand.cells.forEach((c, q) => st.added.push({ cell: c, role: roles[q], step: iteration }));
            st.occ = occAfter;
            st.geo = cand.geo;
            st.stress = field;
            st.measured = now;
            steps.push(step);
            exhausted.clear();
            input.onEvent?.({ kind: "step", step, blocks: st.geo.count });
            taken = true;
            break;
        }
        if (!taken) exhausted.add(phase);
    }

    if (stop === null) {
        if (iteration >= maxSteps && violated()) stop = "max-steps";
        else if (violated() === null && exhausted.size === 0) stop = "stable";
        else stop = capHit && budgetBinds ? "max-blocks" : "no-improving-move";
    }

    const removed = stop === "time-budget" || stop === "canceled" || solveCapHit ? [] : yield* cleanup(ctx, st);
    return finish(stop, removed);
}

// ---------------------------------------------------------------------------------------------------------------
// clean-up

/**
 * Reverse-delete of the added blocks, latest move first: a block goes if no floating part, no extra overhang, no lower margin
 * and no higher stress result. On the heavy mushroom it takes out the columns that the spread legs made redundant.
 */
function* cleanup(ctx: Ctx, st: State): Generator<void, number[]> {
    if (st.added.length === 0) return [];
    const { d } = ctx;
    const removed: number[] = [];
    const order = st.added.map((a, idx) => ({ ...a, idx })).sort((a, b) => b.step - a.step || b.idx - a.idx);
    const baseGeo = st.geo;
    const baseUtil = Math.max(st.stress.maxUtil, 0);
    for (const a of order) {
        if (ctx.solves >= MAX_SOLVES + MAX_CLEANUP_SOLVES || performance.now() - ctx.t0 > ctx.input.timeBudgetMs) break;
        yield;
        if (ctx.input.cancelled?.()) break;
        const occ = st.occ.slice();
        occ[a.cell] = 0;
        const g = evaluateGeometry(occ, d, ctx.bs, ctx.limit, COG_TARGET_MM);
        ctx.candidates++;
        if (g.count !== st.geo.count - 1) continue;
        if (g.floatingCells > baseGeo.floatingCells || g.overreachExcess > baseGeo.overreachExcess) continue;
        if (g.marginMm < Math.min(baseGeo.marginMm, COG_TARGET_MM) - 1e-6) continue;
        const field = solve(ctx, occ);
        if (field.maxUtil > Math.max(ctx.target, baseUtil) + 1e-9) continue;
        st.occ = occ;
        st.geo = g;
        st.stress = field;
        removed.push(a.cell);
    }
    return removed;
}
