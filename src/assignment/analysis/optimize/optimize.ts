// The optimizer: a bi-directional evolutionary structural optimization (BESO, Huang & Xie) on the block lattice, with the engine's own
// rules as the constraints.
//
//   every iteration  1. sensitivities of the state just accepted: stress (utilisation of the worst joint at a block), strain energy
//                       (exact, evaluate.ts), and the exact change of the centre-of-gravity margin of every candidate move
//                    2. a BATCH of moves: the blocks with the lowest sensitivity out (ER of the blocks, at most MAX_BATCH), the empty
//                       cells with the highest merit in (AR of the blocks, never past the budget); each move is checked with the
//                       engine's geometry (floating, cantilever reach, base margin, bodies) as it is added to the batch, so a batch is
//                       geometry-feasible by construction and costs no FEM when it is not
//                    3. ONE Awatif solve for the batch; accepted when no constraint is worse than before (lexicographic, like the
//                       stabilizer's isWorse) and the objective improved; else BACKTRACK: the batch is halved (its safest half is kept)
//                       until a single move; a single move that fails is locked for a few iterations
//   at the end       a SWEEP: every remaining candidate once, one at a time, first feasible improvement wins (removals and additions
//                    interleaved, so neither starves the other). When a whole pass finds nothing the result is a 1-opt optimum and
//                    `complete` says so; when the sweep gave up first (patience, diminishing returns) `complete` is false.
//
// The state is never allowed to get worse: the accepted states are monotone in (violations, objective), so the last one is the best.
// A move counts only when the goal itself improves (the stress tie-break alone is not a reason to change a model).

import type { FrameSolver, Material } from "../fem/index.ts";
import { NB6, cellCoords, cellIndex, inGrid } from "../stabilize/grid.ts";
import type { Geometry } from "../stabilize/grid.ts";
import { CELLS, DIMS, GEOMETRY_VIOLATIONS, GOAL_TOL, MARGIN_CAP_MM, compareViolations, createEvaluator, goalOf, isFeasible, metricsOf, objectiveOf, violationSize, violationsOf } from "./evaluate.ts";
import type { Evaluator, Field, Reference } from "./evaluate.ts";
import type { IterationRecord, Metrics, OptimizeConfig, OptimizeEvent, OptimizeResult, StopReason, Symmetry } from "./types.ts";

export interface OptimizeRun {
    solve: FrameSolver;
    material: Material;
    onEvent?: (event: OptimizeEvent) => void;
    /** Polled between iterations; true stops the run (stop = "canceled", the best state so far is returned). */
    cancelled?: () => boolean;
    /** Awaited between iterations so a worker can receive "cancel" and a page can paint. */
    pause?: () => Promise<void>;
    /** Clock; performance.now by default. */
    now?: () => number;
}

/** Share of the blocks one iteration may take out / put in (BESO's evolution and addition ratios). */
const ER = 0.05;
const AR = 0.03;
const MAX_BATCH = 24;
const LOCK_ITERATIONS = 4;
/** After this many single moves in a row that failed, the batch phase hands over to the sweep. */
const MAX_SINGLE_FAILS = 6;
const SWEEP_PASSES = 3;
/** The sweep gives up on a pass after this many solves in a row that found nothing (the candidates are sorted, later ones are worse bets). */
const SWEEP_PATIENCE = 24;
/** Most empty cells a sweep pass tries (the best-ranked ones). */
const SWEEP_ADD_CANDIDATES = 40;
const MAX_HISTORY = 120;
const J_TOL = 1e-9;
/**
 * Ranking cells to add: the exact change of the centre-of-gravity margin is the strong signal (a geometry pass, no solve); the stress
 * and strain-energy hint (the utilisation of the neighbouring blocks) is a weak one, so it counts a tenth. Measured on 7 examples x 3
 * budgets (sum of the final objective, lower is better): 1.0 -> -7.9, 0.25 -> -16.3, 0.1 -> -19.4, 0.05 -> -19.1, 0.01 -> -17.7.
 * Once the margin reaches MARGIN_CAP_MM its gain is zero and the hint alone orders the cells.
 */
const ADD_HINT_SCALE = 0.1;
/** Diminishing returns: the last PLATEAU_ITERATIONS accepted iterations together improved the objective by less than PLATEAU_GAIN. */
const PLATEAU_ITERATIONS = 5;
const PLATEAU_GAIN = 0.0015;

// ---------- orbits (symmetry) ----------

interface Orbits {
    of: Int32Array; // cell -> orbit id (the lowest cell index of its members)
    members: Map<number, number[]>;
}

function mirror(c: number, sym: Symmetry): number[] {
    const [i, j, k] = cellCoords(DIMS, c);
    const out = new Set<number>([c]);
    const xs = sym === "x" || sym === "xy" ? [i, 9 - i] : [i];
    const ys = sym === "y" || sym === "xy" ? [j, 9 - j] : [j];
    for (const a of xs) for (const b of ys) out.add(cellIndex(DIMS, a, b, k));
    return [...out].sort((a, b) => a - b);
}

function makeOrbits(sym: Symmetry): Orbits {
    const of = new Int32Array(CELLS);
    const members = new Map<number, number[]>();
    for (let c = 0; c < CELLS; c++) {
        const m = mirror(c, sym);
        of[c] = m[0];
        if (!members.has(m[0])) members.set(m[0], m);
    }
    return { of, members };
}

const isSymmetric = (occ: Uint8Array, orbits: Orbits): boolean => {
    for (const m of orbits.members.values()) {
        const v = occ[m[0]];
        for (const c of m) if (occ[c] !== v) return false;
    }
    return true;
};

// ---------- a state ----------

interface State {
    occ: Uint8Array;
    geom: Geometry;
    field: Field | null;
    m: Metrics;
    viol: number[];
    /** The objective, and its goal part without the tie-break. */
    j: number;
    g: number;
}

/** One single move of the sweep: take the orbit out ("rem") or put it in ("add"). */
interface SweepMove {
    o: number;
    kind: "rem" | "add";
}

/** The two lists woven together, `first` ahead at every step: a sweep that tries them in turn starves neither kind of move. */
function interleave<T>(first: readonly T[], second: readonly T[]): T[] {
    const out: T[] = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
        if (i < first.length) out.push(first[i]);
        if (i < second.length) out.push(second[i]);
    }
    return out;
}

export async function optimize(startOcc: Uint8Array, config: OptimizeConfig, run: OptimizeRun): Promise<OptimizeResult> {
    const now = run.now ?? (() => performance.now());
    const t0 = now();
    const lim = config.limits;
    const notes: string[] = [];
    /** Cells taken out / put in so far (net: a block taken out and put back is neither) and the iteration that did it. */
    const removedAt = new Map<number, number>();
    const addedAt = new Map<number, number>();
    const allAdded = { has: (c: number): boolean => addedAt.has(c), get size(): number { return addedAt.size; } };
    /** What this phase may do (a run with both directions has two phases). */
    const flags = { remove: config.allowRemove, add: config.allowAdd };
    const ev: Evaluator = createEvaluator({ solve: run.solve, blockSizeMm: config.blockSizeMm, material: run.material, cantileverLimit: lim.cantileverLimit });
    const bs = config.blockSizeMm;

    let orbits = makeOrbits(config.symmetry);
    if (config.symmetry !== "none" && !isSymmetric(startOcc, orbits)) {
        notes.push(`The model is not mirror-symmetric ${config.symmetry === "xy" ? "both ways" : config.symmetry === "x" ? "left to right" : "front to back"}, so symmetry was not kept.`);
        orbits = makeOrbits("none");
    }

    // ----- evaluation -----
    const stateOf = (occ: Uint8Array, geom: Geometry, field: Field | null, ref: Reference | null): State => {
        const m = metricsOf(geom, field);
        const r = ref ?? { blocks0: m.blocks, deflection0Mm: m.maxDeflectionMm ?? 1, uRef: lim.maxUtil ?? 0.75, blockSizeMm: bs };
        return { occ, geom, field, m, viol: violationsOf(m, lim, r, true), j: objectiveOf(m, config.terms, r), g: goalOf(m, config.terms, r) };
    };
    const startGeom = ev.geometry(startOcc);
    const startField = startGeom.floatingCells === startGeom.count ? null : ev.field(startOcc);
    const m0 = metricsOf(startGeom, startField);
    const ref: Reference = { blocks0: Math.max(1, m0.blocks), deflection0Mm: m0.maxDeflectionMm && m0.maxDeflectionMm > 0 ? m0.maxDeflectionMm : 1, uRef: lim.maxUtil ?? 0.75, blockSizeMm: bs };
    const start = stateOf(startOcc.slice(), startGeom, startField, ref);
    let cur = start;

    const wOf = (k: string): number => config.terms.filter((t) => t.metric === k).reduce((s, t) => s + t.weight, 0);
    const wBlocks = wOf("blocks");
    const wStress = wOf("peak_stress");
    const wCog = wOf("cog_margin");
    const wDefl = wOf("deflection");

    const history: IterationRecord[] = [];
    const record = (s: State, iteration: number, removed: number, added: number, attempts: number): IterationRecord => ({
        iteration,
        blocks: s.m.blocks,
        maxUtil: s.m.maxUtil,
        cogMarginMm: s.m.cogMarginMm,
        maxDeflectionMm: s.m.maxDeflectionMm,
        objective: s.j - start.j,
        violation: violationSize(s.viol),
        removed,
        added,
        attempts,
        solves: ev.solves,
        elapsedMs: now() - t0,
    });
    history.push(record(cur, 0, 0, 0, 0));

    // ----- sensitivities -----
    const prevSens = new Float64Array(CELLS).fill(-1);
    const sensitivity = (s: State): Float64Array => {
        const out = new Float64Array(CELLS);
        const f = s.field;
        if (!f) return out;
        let eMax = 0;
        for (let c = 0; c < CELLS; c++) if (f.energy[c] > eMax) eMax = f.energy[c];
        for (let c = 0; c < CELLS; c++) {
            if (!s.occ[c]) continue;
            const u = f.util[c] / ref.uRef;
            const e = eMax > 0 ? f.energy[c] / eMax : 0;
            // stress is always in play (it is a constraint); strain energy as much as the goal cares about stiffness
            let a = u + wDefl * e;
            if (prevSens[c] >= 0) a = 0.5 * (a + prevSens[c]); // BESO's history average: damps oscillation
            out[c] = a;
        }
        for (let c = 0; c < CELLS; c++) prevSens[c] = s.occ[c] ? out[c] : -1;
        return out;
    };

    const solidNeighbours = (occ: Uint8Array, c: number): number[] => {
        const [i, j, k] = cellCoords(DIMS, c);
        const out: number[] = [];
        for (const [a, b, d] of NB6) {
            const ni = i + a, nj = j + b, nk = k + d;
            if (inGrid(DIMS, ni, nj, nk)) {
                const n = cellIndex(DIMS, ni, nj, nk);
                if (occ[n]) out.push(n);
            }
        }
        return out;
    };

    interface Cand {
        orbit: number;
        key: number; // smaller = tried first
    }

    const lockedUntil = new Map<number, number>(); // orbit -> iteration

    // A block this run put in may be taken out again (a batch of additions can carry a useless block along) even when the
    // user did not allow removing anything else.
    const canTakeOut = (c: number): boolean => (flags.remove ? config.canRemove[c] === 1 || allAdded.has(c) : allAdded.has(c));
    const removalCandidates = (s: State, iteration: number, ownOnly = false): Cand[] => {
        if (!flags.remove && !(ownOnly && allAdded.size > 0)) return [];
        const sens = sensitivity(s);
        const out: Cand[] = [];
        for (const [o, members] of orbits.members) {
            if ((lockedUntil.get(o) ?? -1) > iteration) continue;
            let ok = true;
            let a = 0;
            for (const c of members) {
                if (!s.occ[c] || !canTakeOut(c)) { ok = false; break; }
                a = Math.max(a, sens[c]);
            }
            if (!ok) continue;
            let key = a;
            if (wCog > 0 && s.m.cogMarginMm !== null) {
                const t = s.occ.slice();
                for (const c of members) t[c] = 0;
                const g = ev.geometry(t);
                const after = Number.isFinite(g.marginMm) ? g.marginMm : -1e6;
                const gain = Math.max(-2, Math.min(2, (Math.min(after, MARGIN_CAP_MM) - Math.min(s.m.cogMarginMm, MARGIN_CAP_MM)) / bs));
                key = (1 - wCog) * a - wCog * gain;
            }
            // symmetric moves free more blocks per FEM solve: prefer the bigger orbit at equal sensitivity
            out.push({ orbit: o, key: key - 1e-6 * members.length });
        }
        out.sort((p, q) => p.key - q.key || p.orbit - q.orbit);
        return out;
    };

    const additionCandidates = (s: State, iteration: number): Cand[] => {
        if (!flags.add) return [];
        const f = s.field;
        let eMax = 0;
        if (f) for (let c = 0; c < CELLS; c++) if (f.energy[c] > eMax) eMax = f.energy[c];
        const out: Cand[] = [];
        for (const [o, members] of orbits.members) {
            if ((lockedUntil.get(o) ?? -1) > iteration) continue;
            let ok = true;
            let merit = 0;
            for (const c of members) {
                if (s.occ[c] || !config.canAdd[c]) { ok = false; break; }
            }
            if (!ok) continue;
            let touches = false;
            for (const c of members) {
                const nb = solidNeighbours(s.occ, c);
                if (nb.length === 0) continue;
                touches = true;
                if (f) {
                    const [, , k] = cellCoords(DIMS, c);
                    let hot = 0;
                    for (const n of nb) {
                        const [, , nk] = cellCoords(DIMS, n);
                        const u = f.util[n] / ref.uRef + wDefl * (eMax > 0 ? f.energy[n] / eMax : 0);
                        // a block under a stressed overhang relieves it most; one beside it, less; one above it, hardly
                        const place = nk > k ? 1.5 : nk === k ? 1.0 : 0.5;
                        hot = Math.max(hot, u * place);
                    }
                    merit = Math.max(merit, hot);
                }
            }
            if (!touches) continue;
            let key = -merit * (wStress + wDefl) * (config.addMeritScale ?? ADD_HINT_SCALE);
            if (wCog > 0 && s.m.cogMarginMm !== null) {
                const t = s.occ.slice();
                for (const c of members) t[c] = 1;
                const g = ev.geometry(t);
                const gain = Math.max(-2, Math.min(2, (Math.min(Number.isFinite(g.marginMm) ? g.marginMm : -1e6, MARGIN_CAP_MM) - Math.min(s.m.cogMarginMm, MARGIN_CAP_MM)) / bs));
                key += -wCog * gain;
            }
            // the blocks term makes every block cost; the budget decides how many are bought, so only a tie-break here
            out.push({ orbit: o, key: key + 1e-6 * members.length });
        }
        out.sort((p, q) => p.key - q.key || p.orbit - q.orbit);
        // a cell with no merit at all is not worth a solve unless the goal is about the centre of gravity
        return out.filter((c) => c.key < -1e-9);
    };

    // ----- batches -----
    const geomViolNow = (s: State): number[] => s.viol.slice(0, GEOMETRY_VIOLATIONS);

    interface Trial {
        occ: Uint8Array;
        removedOrbits: number[];
        addedOrbits: number[];
        rejected: number[]; // orbits dropped by the geometry check
        geom: Geometry;
        geomViol: number[];
    }

    const buildTrial = (s: State, rem: Cand[], add: Cand[], nR: number, nA: number, forbid: ReadonlySet<number>): Trial | null => {
        const occ = s.occ.slice();
        const removedOrbits: number[] = [];
        const addedOrbits: number[] = [];
        const rejected: number[] = [];
        let blocks = s.m.blocks;
        let geom = s.geom;
        let geomViol = geomViolNow(s);
        let tries = 0;
        const apply = (o: number, v: 0 | 1): boolean => {
            const members = orbits.members.get(o) as number[];
            for (const c of members) occ[c] = v;
            const g = ev.geometry(occ);
            const m = metricsOf(g, null);
            const viol = violationsOf(m, lim, ref, false).slice(0, GEOMETRY_VIOLATIONS);
            // a move that makes the geometry (floating, reach, bodies, budget, margin) worse than the batch so far is skipped
            if (compareViolations(viol, geomViol) > 0) {
                for (const c of members) occ[c] = v ? 0 : 1;
                return false;
            }
            geom = g;
            geomViol = viol;
            blocks = m.blocks;
            return true;
        };
        for (const c of rem) {
            if (removedOrbits.length >= nR) break;
            if (forbid.has(c.orbit)) continue;
            if (tries++ > 4 * nR + 8) break;
            if (apply(c.orbit, 0)) removedOrbits.push(c.orbit);
            else rejected.push(c.orbit);
        }
        let triesA = 0;
        for (const c of add) {
            if (addedOrbits.length >= nA) break;
            if (forbid.has(c.orbit)) continue;
            if (triesA++ > 4 * nA + 8) break;
            // do not stack two additions that touch each other in one batch (their effects are not independent); columns come one block at a time
            const members = orbits.members.get(c.orbit) as number[];
            let touchesNew = false;
            for (const a of addedOrbits) for (const x of orbits.members.get(a) as number[]) for (const y of members) if (isFaceNeighbour(x, y)) touchesNew = true;
            if (touchesNew) continue;
            if (apply(c.orbit, 1)) addedOrbits.push(c.orbit);
            else rejected.push(c.orbit);
        }
        void blocks;
        if (removedOrbits.length === 0 && addedOrbits.length === 0) return null;
        return { occ, removedOrbits, addedOrbits, rejected, geom, geomViol };
    };

    const isFaceNeighbour = (a: number, b: number): boolean => {
        const [i, j, k] = cellCoords(DIMS, a);
        const [x, y, z] = cellCoords(DIMS, b);
        return Math.abs(i - x) + Math.abs(j - y) + Math.abs(k - z) === 1;
    };

    const evaluateTrial = (t: Trial): State => {
        const field = t.geom.floatingCells === t.geom.count || t.geom.count === 0 ? null : ev.field(t.occ);
        return stateOf(t.occ, t.geom, field, ref);
    };

    const better = (a: State, b: State): boolean => {
        const c = compareViolations(a.viol, b.viol);
        if (c !== 0) return c < 0;
        // The objective must fall and so must the goal itself: a gain that is only the stress tie-break is not worth a change.
        return a.j < b.j - J_TOL * Math.max(1, Math.abs(b.j)) && a.g < b.g - GOAL_TOL;
    };

    // ----- the loop -----
    let iteration = 0;
    let stop: StopReason | null = null;
    /** The last sweep tried every single move and none helped (see OptimizeResult.complete). */
    let complete = false;
    let lastProgress = 0;
    let bScale = 1;
    const cellsOf = (os: number[]): number[] => os.flatMap((o) => orbits.members.get(o) as number[]);

    const overBudget = (): StopReason | null => {
        if (run.cancelled?.()) return "canceled";
        if (ev.solves >= config.maxSolves) return "max-solves";
        if (now() - t0 > config.timeBudgetMs) return "time-budget";
        return null;
    };

    const accept = (next: State, t: Trial, attempts: number): void => {
        iteration++;
        const rem = cellsOf(t.removedOrbits);
        const add = cellsOf(t.addedOrbits);
        for (const c of rem) { if (addedAt.has(c)) addedAt.delete(c); else removedAt.set(c, iteration); }
        for (const c of add) { if (removedAt.has(c)) removedAt.delete(c); else addedAt.set(c, iteration); }
        cur = next;
        const rec = record(next, iteration, rem.length, add.length, attempts);
        history.push(rec);
        run.onEvent?.({ kind: "iteration", record: rec, removedCells: rem, addedCells: add });
    };

    const plateau = (): boolean => {
        const h = history;
        if (h.length <= PLATEAU_ITERATIONS) return false;
        return h[h.length - 1 - PLATEAU_ITERATIONS].objective - h[h.length - 1].objective < PLATEAU_GAIN;
    };
    const reached = (): boolean => config.stopAtBlocks !== null && cur.m.blocks <= config.stopAtBlocks && isFeasible(cur.viol);

    /** One phase: BESO batches until they are stuck, then the single-move sweep. Returns why it ended (null = "stuck, nothing more to try"). */
    const phase = async (): Promise<StopReason | null> => {
        complete = false;
        batch: while (iteration < config.maxIterations) {
            const over = overBudget();
            if (over) return over;
            if (reached()) return "target-reached";
            if (plateau()) return null; // diminishing returns: the phase ends here and `complete` stays false
            if (run.pause) await run.pause();
            if (now() - lastProgress > 100) {
                lastProgress = now();
                run.onEvent?.({ kind: "progress", phase: "evaluating", iteration, solves: ev.solves, blocks: cur.m.blocks, elapsedMs: now() - t0 });
            }
            const rem = removalCandidates(cur, iteration);
            const add = additionCandidates(cur, iteration);
            if (rem.length === 0 && add.length === 0) break;

            const n = cur.m.blocks;
            const headroom = Math.max(0, lim.maxBlocks - n);
            const maxBatch = config.maxBatch ?? MAX_BATCH;
            let nR = flags.remove ? Math.min(maxBatch, rem.length, Math.max(1, Math.ceil((config.evolutionRatio ?? ER) * n * bScale))) : 0;
            let nA = flags.add && add.length > 0 ? Math.min(maxBatch, add.length, headroom + nR, Math.max(1, Math.ceil(Math.min(AR * n, Math.max(1, headroom / 3)) * bScale))) : 0;
            if (wBlocks >= 0.999 && flags.remove) nA = 0; // a pure weight goal does not buy blocks

            let attempts = 0;
            let accepted = false;
            const forbid = new Set<number>();
            let singleFails = 0;
            while (!accepted) {
                const over2 = overBudget();
                if (over2) return over2;
                const trial = buildTrial(cur, rem, add, nR, nA, forbid);
                if (!trial) break; // nothing left that passes the geometry check
                for (const o of trial.rejected) forbid.add(o);
                attempts++;
                const next = evaluateTrial(trial);
                if (better(next, cur)) {
                    accept(next, trial, attempts);
                    accepted = true;
                    if (attempts === 1) bScale = Math.min(1, bScale * 1.5);
                    break;
                }
                const size = trial.removedOrbits.length + trial.addedOrbits.length;
                if (size <= 1) {
                    // a single move that breaks a constraint or does not help: locked for a few iterations
                    for (const o of [...trial.removedOrbits, ...trial.addedOrbits]) { lockedUntil.set(o, iteration + LOCK_ITERATIONS); forbid.add(o); }
                    if (++singleFails >= MAX_SINGLE_FAILS) break;
                    continue;
                }
                // backtrack: the batch is sorted safest first, so its first half is the safest half
                bScale = Math.max(0.05, bScale * 0.5);
                nR = Math.floor(trial.removedOrbits.length / 2);
                nA = Math.floor(trial.addedOrbits.length / 2);
                if (nR + nA === 0) { nR = trial.removedOrbits.length > 0 ? 1 : 0; nA = nR === 0 ? 1 : 0; }
            }
            if (!accepted) break batch; // stuck: the sweep decides
        }
        if (iteration >= config.maxIterations) return "max-iterations";

        // ----- the sweep: every remaining single move once, first feasible improvement wins -----
        // No allowance of its own: it runs until a pass finds nothing, patience runs out, or the run's budgets (solves, time) do. (A fixed
        // allowance of 0.4 n solves used to end the sweep of an add-goal after the removals, before the better additions had been tried.)
        for (let pass = 0; pass < SWEEP_PASSES; pass++) {
            lockedUntil.clear();
            const rem = removalCandidates(cur, iteration, true);
            const addAll = flags.add && cur.m.blocks < lim.maxBlocks ? additionCandidates(cur, iteration) : [];
            const add = addAll.slice(0, SWEEP_ADD_CANDIDATES);
            const removals = rem.map((c): SweepMove => ({ o: c.orbit, kind: "rem" }));
            const additions = add.map((c): SweepMove => ({ o: c.orbit, kind: "add" }));
            // A goal that is not just weight is served by additions: they go first.
            const queue = wBlocks >= 0.999 ? interleave(removals, additions) : interleave(additions, removals);
            let any = false;
            let dry = 0; // solves since the last success
            let cut = addAll.length > add.length; // candidates left out of the queue
            for (const q of queue) {
                const over = overBudget();
                if (over) return over;
                if (dry >= SWEEP_PATIENCE || plateau()) {
                    cut = true;
                    break;
                }
                if (reached()) return "target-reached";
                if (run.pause) await run.pause();
                const members = orbits.members.get(q.o) as number[];
                // still valid in the current state?
                if (members.some((c) => (q.kind === "rem" ? !cur.occ[c] || !canTakeOut(c) : cur.occ[c] || !config.canAdd[c]))) continue;
                if (iteration >= config.maxIterations) return "max-iterations";
                const trial = buildTrial(cur, q.kind === "rem" ? [{ orbit: q.o, key: 0 }] : [], q.kind === "add" ? [{ orbit: q.o, key: 0 }] : [], q.kind === "rem" ? 1 : 0, q.kind === "add" ? 1 : 0, new Set());
                if (!trial) continue;
                const next = evaluateTrial(trial);
                if (better(next, cur)) {
                    accept(next, trial, 1);
                    any = true;
                    dry = 0;
                } else dry++;
            }
            if (!any) {
                complete = !cut;
                break;
            }
        }
        return null;
    };

    if (!flags.remove && !flags.add) {
        stop = "infeasible";
    } else if (flags.add && flags.remove && wBlocks < 0.999) {
        // Both directions, and the goal is not just weight: first only put blocks where they help (cheap and the best use of a budget),
        // then let removals and additions trade. The second phase starts from the first one's result, so "both" is never worse than "add".
        flags.remove = false;
        stop = await phase();
        flags.remove = true;
        if (stop === null) stop = await phase();
    } else {
        stop = await phase();
    }
    if (stop === null) stop = "converged";

    // ----- result -----
    const removed = [...removedAt.keys()].sort((a, b) => a - b);
    const added = [...addedAt.keys()].sort((a, b) => a - b);
    const feasible = isFeasible(cur.viol);
    if (!feasible && stop === "converged") stop = "infeasible";
    else if (stop === "converged" && config.allowAdd && cur.m.blocks >= lim.maxBlocks) stop = "budget-used";
    if (!feasible) notes.push(describeViolation(cur.viol, lim, cur.m));
    return {
        occupancy: cur.occ,
        removed,
        added,
        removedAt: removed.map((c) => removedAt.get(c) as number),
        addedAt: added.map((c) => addedAt.get(c) as number),
        start: start.m,
        end: cur.m,
        history: thin(history, MAX_HISTORY),
        stop,
        complete: stop === "converged" && complete,
        feasible,
        changed: removed.length + added.length > 0,
        solves: ev.solves,
        elapsedMs: now() - t0,
        notes,
    };
}

function describeViolation(v: readonly number[], lim: OptimizeConfig["limits"], m: Metrics): string {
    if (v[0] > 0) return "Some blocks would float free of the ground.";
    if (v[1] > 0) return "Some overhangs are longer than the limit.";
    if (v[3] > 0) return `The block budget (${lim.minBlocks}-${lim.maxBlocks}) cannot be met.`;
    if (v[4] > 0 && lim.minMarginMm !== null) return `The weight cannot be brought ${lim.minMarginMm} mm inside the base (best ${Math.round(m.cogMarginMm ?? 0)} mm).`;
    if (v[5] > 0 && lim.maxUtil !== null) return `The strength used cannot be brought under ${Math.round(lim.maxUtil * 100)} % (best ${Math.round((m.maxUtil ?? 0) * 100)} %).`;
    return "The constraints cannot all be met.";
}

/** At most `max` rows, always keeping the first and the last: the chart does not need more and the saved log stays small. */
function thin(rows: IterationRecord[], max: number): IterationRecord[] {
    if (rows.length <= max) return rows;
    const out: IterationRecord[] = [];
    for (let i = 0; i < max; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
    return out;
}
