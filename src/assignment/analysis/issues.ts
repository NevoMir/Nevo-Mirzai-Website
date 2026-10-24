// Turns the structural model into what the user reads: issues that say where and why a constraint is violated,
// the five constraint rows of the report, and the headline summary that is saved with the model.

import type { AnalysisSummary } from "@/assignment/shared/contract";
import type { AnalysisSettings, Block, Body, CheckRow, Issue, Stability, Vec3 } from "./types.ts";
import type { Structure } from "./structure.ts";
import { coverageAt, groundedCellsAt, occupancyOf, reachFrom } from "./structure.ts";
import { CELLS_PER_BLOCK } from "./voxelize.ts";
import type { VoxelGrid } from "./voxelize.ts";
import { directionLabel, hullDistance, outwardNormal } from "./geometry.ts";

/** Coverage below this raises the "thin features" warning. */
export const COVERAGE_WARN = 0.8;

/** A centre of gravity within this of the edge of the base is balanced on it, not safely inside (mm). */
export const EDGE_MARGIN_MM = 1;

/**
 * The fill thresholds the hints may suggest: steps of 5 points from 90% down to 10%, the range of the settings
 * panel (store/analysisLogic FILL_RANGE). Below 10% the grazing layers of the voxeliser (8.3% of a block) would
 * start to count as blocks, so no hint goes there either.
 */
const HINT_MAX = 0.9;
const HINT_MIN = 0.1;
const HINT_STEP = 0.05;

/** Share of the over-limit blocks a direction needs to be named in the cantilever message. */
const DIRECTION_SHARE = 0.1;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const mm = (v: number): string => `${Math.round(v)} mm`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** A distance for the "outside the base" wording: "13 mm", or "less than 1 mm" instead of a misleading "0 mm". */
const missText = (v: number): string => (v < 1 ? "less than 1 mm" : mm(v));
const missShort = (v: number): string => (v < 1 ? "< 1 mm" : mm(v));

/** "500-600 mm" for the layers [k0, k1]. */
function heightRange(k0: number, k1: number, bs: number): string {
    return `${Math.round(k0 * bs)}-${Math.round((k1 + 1) * bs)} mm`;
}

function centroid(blocks: Block[], ids: number[]): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const id of ids) {
        x += blocks[id].centerMm[0];
        y += blocks[id].centerMm[1];
        z += blocks[id].centerMm[2];
    }
    const n = Math.max(1, ids.length);
    return [x / n, y / n, z / n];
}

/** The fill thresholds below `current` a hint may suggest, highest first. */
function thresholdLadder(current: number): number[] {
    const ladder: number[] = [];
    for (let step = Math.round(HINT_MAX / HINT_STEP); step * HINT_STEP >= HINT_MIN - 1e-9; step--) {
        const t = Math.round(step * HINT_STEP * 100) / 100;
        if (t < current - 1e-9) ladder.push(t);
    }
    return ladder;
}

/** Hull distance of a block's centre (negative = beyond the base). */
const beyondBase = (b: Block, stability: Stability): number => hullDistance([b.centerMm[0], b.centerMm[1]], stability.supportHull).signed;

export function buildIssues(structure: Structure, grid: VoxelGrid, settings: AnalysisSettings): Issue[] {
    const { blocks, bodies, cantilevers, stability, stats } = structure;
    const bs = settings.blockSizeMm;
    const limit = settings.cantileverLimit;
    const errors: Issue[] = [];
    const warnings: Issue[] = [];
    const centreOfVolume: Vec3 = [grid.sizeMm[0] / 2 + grid.transform.offsetMm[0], grid.sizeMm[1] / 2 + grid.transform.offsetMm[1], grid.sizeMm[2] / 2];

    // ----- no blocks at all -----
    if (blocks.length === 0) {
        const why =
            grid.totalSolid === 0
                ? "The model has no usable geometry (no triangles, or only points and broken faces)."
                : `No ${bs} mm block is at least ${pct(settings.fillThreshold)} filled by the model, so nothing is left to analyse. The model is probably very thin or hollow; try a lower fill threshold.`;
        errors.push({ id: "empty", kind: "empty", severity: "error", title: "No blocks", detail: why, blocks: [], focusMm: centreOfVolume });
        return errors;
    }

    // ----- centre of gravity outside (or on the edge of) the support base -----
    if (stability) {
        const issue = stabilityIssue(structure, stability);
        if (issue) (issue.severity === "error" ? errors : warnings).push(issue);
    }

    // ----- cantilevers longer than the limit, longest first -----
    const longRuns = cantilevers.filter((run) => run.overLimit.length > 0).sort((a, b) => b.reach - a.reach || b.overLimit.length - a.overLimit.length || a.id - b.id);
    for (const run of longRuns) {
        // Where each over-limit block sticks out: away from the supports its reach path starts at (every root that
        // is as close as the block's reach says; a cap above a stem has several, and their centre is used).
        const fromRoot = run.roots.map((root) => reachFrom(blocks, structure.blockAt, structure.gridSize, [root]));
        let far = blocks[run.overLimit[0]];
        let farDist = -1;
        const counts = new Map<string, number>();
        let labelled = 0;
        for (const id of run.overLimit) {
            const b = blocks[id];
            let sx = 0;
            let sy = 0;
            let n = 0;
            fromRoot.forEach((fromThisRoot, r) => {
                if (fromThisRoot[id] !== b.reach) return;
                sx += blocks[run.roots[r]].centerMm[0];
                sy += blocks[run.roots[r]].centerMm[1];
                n++;
            });
            const dx = n > 0 ? b.centerMm[0] - sx / n : 0;
            const dy = n > 0 ? b.centerMm[1] - sy / n : 0;
            const dist = Math.hypot(dx, dy);
            if ((b.reach ?? 0) > (far.reach ?? 0) || ((b.reach ?? 0) === (far.reach ?? 0) && dist > farDist)) {
                far = b;
                farDist = dist;
            }
            const label = directionLabel(dx, dy);
            if (label) {
                counts.set(label, (counts.get(label) ?? 0) + 1);
                labelled++;
            }
        }
        const where = describeDirections(counts, labelled);
        let k0 = Infinity;
        let k1 = -Infinity;
        for (const id of run.overLimit) {
            k0 = Math.min(k0, blocks[id].cell[2]);
            k1 = Math.max(k1, blocks[id].cell[2]);
        }
        // One direction: "sticks out 6 blocks towards +X". Several (a cap, an umbrella, an arm with branches on
        // both sides): "sticks out up to 6 blocks in 3 directions (+X, -X, +Y)" instead of pointing at one corner.
        const sticks = where.directions > 1 ? `sticks out up to ${plural(run.reach, "block")} (${mm(run.reach * bs)})` : `sticks out ${plural(run.reach, "block")} (${mm(run.reach * bs)})`;
        errors.push({
            id: `cantilever-${run.id}`,
            kind: "cantilever-too-long",
            severity: "error",
            title: `Cantilever too long: ${plural(run.reach, "block")}`,
            detail:
                `At ${heightRange(k0, k1, bs)} height, a part ${sticks}` +
                `${where.text ? ` ${where.text}` : ""} from its last support; the limit is ${plural(limit, "block")} (${mm(limit * bs)}). ` +
                `${plural(run.overLimit.length, "block")} ${run.overLimit.length === 1 ? "is" : "are"} beyond the limit and would need extra support.`,
            blocks: run.overLimit,
            focusMm: far.centerMm,
        });
    }

    // ----- floating parts, biggest first -----
    const floating = bodies.filter((body) => !body.grounded).sort((a, b) => b.blocks.length - a.blocks.length || a.id - b.id);
    const advice = new FloatingAdvice(structure, grid, settings);
    const joinable: Body[] = [];
    for (const body of floating) {
        let k0 = Infinity;
        let k1 = -Infinity;
        for (const id of body.blocks) {
            k0 = Math.min(k0, blocks[id].cell[2]);
            k1 = Math.max(k1, blocks[id].cell[2]);
        }
        const many = body.blocks.length !== 1;
        // Why it floats: a thin joint a lower threshold would keep (with the numbers), else how far away it is.
        const joint = advice.thinJoint(body);
        if (joint) joinable.push(body);
        const gap = joint ? "" : gapNote(nearestGroundedDistance(structure, body.blocks), many, settings.fillThreshold);
        errors.push({
            id: `floating-${body.id}`,
            kind: "floating",
            severity: "error",
            title: `Floating part: ${plural(body.blocks.length, "block")}`,
            detail:
                `${plural(body.blocks.length, "block")} at ${heightRange(k0, k1, bs)} height ${many ? "are" : "is"} not connected to the ground or to anything resting on it${gap}. ` +
                `${many ? "They" : "It"} would fall.${joint ? ` ${joint.text}` : ""}${stability ? "" : " No block of the design reaches the ground."}`,
            blocks: body.blocks,
            focusMm: centroid(blocks, body.blocks),
        });
    }

    // ----- over budget -----
    if (settings.maxBlocks !== null && stats.blockCount > settings.maxBlocks) {
        const over = stats.blockCount - settings.maxBlocks;
        errors.push({
            id: "too-many-blocks",
            kind: "too-many-blocks",
            severity: "error",
            title: `Too many components: ${plural(stats.blockCount, "block")}`,
            detail: `The design uses ${plural(stats.blockCount, "block")} but the budget is ${settings.maxBlocks}: ${plural(over, "block")} over. Raising the fill threshold above ${pct(settings.fillThreshold)} drops the most weakly filled blocks first.`,
            blocks: [],
            focusMm: centreOfVolume,
        });
    }

    // ----- thin parts that did not make it into any block -----
    const lowCoverage = stats.coverage < COVERAGE_WARN;
    if (lowCoverage || joinable.length > 0) {
        let focusMm: Vec3 = centreOfVolume;
        let title: string;
        let detail = "";
        let highlight: number[] = [];
        if (lowCoverage) {
            // Where the left-out material is: the centre of the solid cells in blocks that were not used.
            let wx = 0;
            let wy = 0;
            let wz = 0;
            let w = 0;
            const [gx, gy, gz] = grid.gridSize;
            for (let k = 0; k < gz; k++) {
                for (let j = 0; j < gy; j++) {
                    for (let i = 0; i < gx; i++) {
                        const c = (k * gy + j) * gx + i;
                        if (structure.occupancy.used[c] || grid.solid[c] === 0) continue;
                        wx += (i + 0.5) * bs * grid.solid[c];
                        wy += (j + 0.5) * bs * grid.solid[c];
                        wz += (k + 0.5) * bs * grid.solid[c];
                        w += grid.solid[c];
                    }
                }
            }
            if (w > 0) focusMm = [wx / w, wy / w, wz / w];
            title = `Thin parts left out: ${pct(stats.coverage)} of the model kept`;
            detail = `Only ${pct(stats.coverage)} of the model's volume ended up inside blocks. Features thinner than a block (fins, wires, hollow shells) fill too little of a ${bs} mm block and were dropped.`;
        } else {
            title = `Thin joints left out: ${plural(joinable.length, "floating part")} would connect`;
        }
        // What a lower threshold would do: keep most of the model (the highest step on the ladder that keeps at
        // least 80% of it) and/or hold the floating parts up (the step that holds up the most of them).
        const ladder = thresholdLadder(settings.fillThreshold);
        const keepAt = lowCoverage ? ladder.find((t) => coverageAt(grid, t) >= COVERAGE_WARN) : undefined;
        const best = joinable.length > 0 ? advice.bestThreshold(floating) : null;
        const from = pct(settings.fillThreshold);
        const effects: Array<{ at: number; text: string }> = [];
        if (keepAt !== undefined) effects.push({ at: keepAt, text: `keep about ${pct(coverageAt(grid, keepAt))}` });
        if (best) {
            const usedNow = structure.occupancy.used.reduce((n, u) => n + u, 0);
            const added = occupancyOf(grid, best.threshold).used.reduce((n, u) => n + u, 0) - usedNow;
            const joined = best.joined === floating.length ? (floating.length === 1 ? "the floating part" : `all ${floating.length} floating parts`) : `${best.joined} of the ${floating.length} floating parts`;
            effects.push({ at: best.threshold, text: `join ${joined} to the structure (it adds ${plural(added, "block")})` });
            const ids = new Set<number>();
            for (const body of joinable) for (const id of body.blocks) ids.add(id);
            highlight = [...ids].sort((a, b) => a - b);
            if (!lowCoverage) focusMm = centroid(blocks, highlight);
        }
        // One sentence when both effects come at the same threshold, else one sentence each.
        if (effects.length === 2 && effects[0].at === effects[1].at) {
            detail += ` Lowering the fill threshold from ${from} to ${pct(effects[0].at)} would ${effects[0].text} and ${effects[1].text}.`;
        } else {
            effects.forEach((e, n) => {
                detail += n === 0 ? ` Lowering the fill threshold from ${from} to ${pct(e.at)} would ${e.text}.` : ` Lowering it to ${pct(e.at)} would ${e.text}.`;
            });
        }
        if (best) detail += " Compare with the original model to check that the joint is really there.";
        detail = detail.trim();
        warnings.push({ id: "thin-features", kind: "thin-features", severity: "warning", title, detail, blocks: highlight, focusMm });
    }

    return errors.concat(warnings);
}

// ---------- stability ----------

/**
 * The centre-of-gravity issue of the weakest free-standing structure: an error when it is outside its base, a
 * warning when it sits on the very edge of it, nothing otherwise.
 */
function stabilityIssue(structure: Structure, stability: Stability): Issue | null {
    const { blocks, bodies } = structure;
    const body = stability.bodyId !== undefined ? bodies[stability.bodyId] : null;
    const members = body ? body.blocks.map((id) => blocks[id]) : blocks.filter((b) => b.status !== "floating");
    const several = (stability.groundedBodies ?? 1) > 1;
    const who = several ? `one of the ${stability.groundedBodies} separate structures standing on the ground (${plural(members.length, "block")})` : "";

    if (!stability.inside) {
        const dist = -stability.marginMm;
        const dir = stability.tipDirection ? directionLabel(stability.tipDirection[0], stability.tipDirection[1]) : "";
        const towards = dir ? `, towards ${dir}` : "";
        // The blocks pulling the structure over: beyond the base AND on the side it tips to. Blocks beyond the
        // base on the far side balance it and are not part of the cause.
        const beyond = members.filter((b) => beyondBase(b, stability) < 0);
        const tip = stability.tipDirection;
        const pull = tip ? beyond.filter((b) => (b.centerMm[0] - stability.pivotMm[0]) * tip[0] + (b.centerMm[1] - stability.pivotMm[1]) * tip[1] > 1e-9) : beyond;
        const culprits = (pull.length > 0 ? pull : beyond).sort((a, b) => beyondBase(a, stability) - beyondBase(b, stability)).map((b) => b.index);
        const counter = beyond.length - culprits.length;
        const counterNote = counter > 0 ? ` ${plural(counter, "further block")} beyond the base on the other side counterbalance${counter === 1 ? "s" : ""} it.` : "";
        return {
            id: "cog",
            kind: "cog-outside",
            severity: "error",
            title: "Centre of gravity outside the base",
            detail:
                (several
                    ? `The centre of gravity of ${who} is ${missText(dist)} outside its support base${towards}: that structure would tip over. `
                    : `The centre of gravity is ${missText(dist)} outside the support base${towards}: the structure would tip over. `) +
                `${plural(culprits.length, "block")} ${culprits.length === 1 ? "lies" : "lie"} beyond the base${tip ? " on the side it tips to" : ""}; widen the base or move mass back over it.${counterNote}`,
            blocks: culprits,
            focusMm: stability.cogMm,
        };
    }

    if (stability.marginMm < EDGE_MARGIN_MM) {
        // Balanced on the edge: the next block added on that side, or a threshold that moves one, tips it.
        const { edge } = hullDistance(stability.groundPointMm, stability.supportHull);
        const out = outwardNormal(stability.supportHull, edge);
        const towards = out ? directionLabel(out[0], out[1]) : "";
        const lean = out
            ? members
                  .filter((b) => beyondBase(b, stability) < 0 && (b.centerMm[0] - stability.groundPointMm[0]) * out[0] + (b.centerMm[1] - stability.groundPointMm[1]) * out[1] > 0)
                  .map((b) => b.index)
            : [];
        return {
            id: "cog-edge",
            kind: "cog-outside",
            severity: "warning",
            title: "Centre of gravity on the edge of the base",
            detail:
                `The centre of gravity is within ${EDGE_MARGIN_MM} mm of the edge of ${several ? `the support base of ${who}` : "the support base"}${towards ? ` (the ${towards} side)` : ""}: ` +
                `the structure is balanced on the edge of tipping, and the smallest change moves it outside. Widen the base or move mass back over it.`,
            blocks: lean,
            focusMm: stability.cogMm,
        };
    }
    return null;
}

/**
 * "towards +X", "in 3 directions (+X, -X, +Y)" or "in all directions" for the way the over-limit blocks of a
 * cantilever stick out, from the share of blocks that point each way.
 */
function describeDirections(counts: Map<string, number>, total: number): { text: string; directions: number } {
    if (total === 0 || counts.size === 0) return { text: "", directions: 0 };
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const notable = ranked.filter(([, n]) => n / total >= DIRECTION_SHARE).map(([label]) => label);
    if (notable.length === 0) notable.push(ranked[0][0]);
    if (notable.length === 1) return { text: `towards ${notable[0]}`, directions: 1 };
    // 5 or more of the 8 compass sectors: a cap or a fan, not a few arms.
    if (notable.length >= 5) return { text: "in all directions", directions: notable.length };
    return { text: `in ${notable.length} directions (${notable.map((label) => label.replace(" and ", "/")).join(", ")})`, directions: notable.length };
}

// ---------- floating parts ----------

/**
 * How close a group of blocks comes to the grounded structure, in blocks (Chebyshev distance between cells):
 * 1 = touching along an edge or a corner (never a face, or it would be connected), 2 = one block of space between.
 * null when nothing is grounded.
 */
function nearestGroundedDistance(structure: Structure, group: number[]): number | null {
    const { blocks, bodies } = structure;
    const grounded = blocks.filter((b) => bodies[b.body].grounded);
    if (grounded.length === 0) return null;
    // Pairs are few for the 10 x 10 x 10 grid; a huge grid skips the search and only reports the closest case.
    const exhaustive = group.length * grounded.length <= 4_000_000;
    let best = Infinity;
    for (const id of group) {
        const [i, j, k] = blocks[id].cell;
        for (const g of grounded) {
            const d = Math.max(Math.abs(g.cell[0] - i), Math.abs(g.cell[1] - j), Math.abs(g.cell[2] - k));
            if (d < best) best = d;
            if (best <= 1) return 1;
        }
        if (!exhaustive) break;
    }
    return Number.isFinite(best) ? best : null;
}

/**
 * The part of a floating-part message that says how it relates to the structure when no lower threshold would
 * join it. It states the distance and, for a gap, that a joint thinner than the threshold would not show: it does
 * not claim there is material in the gap, because grazing layers and thin joints look alike below the threshold.
 */
function gapNote(distance: number | null, many: boolean, threshold: number): string {
    if (distance === null) return "";
    if (distance <= 1) return ` (${many ? "they touch" : "it touches"} the structure only along an edge or a corner, which does not hold anything)`;
    const joint = `if the model is joined there, the joint fills less than ${pct(threshold)} of a block and was left out`;
    if (distance === 2) return ` (one block of space separates ${many ? "them" : "it"} from the structure; ${joint})`;
    return ` (the nearest block of the structure is ${distance - 1} blocks away; ${joint})`;
}

interface ThinJoint {
    /** Sentence for the floating-part message. */
    text: string;
}

/**
 * Would a lower fill threshold hold a floating part up? The fill threshold drops every block the model fills too
 * little, so a thin joint can cut a model that is one piece into several; re-running the connectivity at the
 * thresholds below the current one (cheap: one flood fill each) finds out, and says which blocks would appear.
 */
class FloatingAdvice {
    private readonly structure: Structure;
    private readonly grid: VoxelGrid;
    private readonly settings: AnalysisSettings;
    private readonly ladder: number[];
    private readonly grounded = new Map<number, Uint8Array>();
    private readonly used = new Map<number, Uint8Array>();

    constructor(structure: Structure, grid: VoxelGrid, settings: AnalysisSettings) {
        this.structure = structure;
        this.grid = grid;
        this.settings = settings;
        this.ladder = thresholdLadder(settings.fillThreshold);
    }

    private groundedAt(t: number): Uint8Array {
        let cells = this.grounded.get(t);
        if (!cells) {
            cells = groundedCellsAt(this.grid, t);
            this.grounded.set(t, cells);
        }
        return cells;
    }

    private usedAt(t: number): Uint8Array {
        let cells = this.used.get(t);
        if (!cells) {
            cells = occupancyOf(this.grid, t).used;
            this.used.set(t, cells);
        }
        return cells;
    }

    private cellsOf(body: Body): number[] {
        const [gx, gy] = this.grid.gridSize;
        return body.blocks.map((id) => {
            const [i, j, k] = this.structure.blocks[id].cell;
            return (k * gy + j) * gx + i;
        });
    }

    /** The highest ladder threshold at which any block of the body is held up, or null. */
    private joinThreshold(cells: number[]): number | null {
        for (const t of this.ladder) {
            const grounded = this.groundedAt(t);
            if (cells.some((c) => grounded[c])) return t;
        }
        return null;
    }

    thinJoint(body: Body): ThinJoint | null {
        if (this.ladder.length === 0) return null;
        const cells = this.cellsOf(body);
        const joinAt = this.joinThreshold(cells);
        if (joinAt === null) return null;

        // The blocks that appear at joinAt next to the part (and next to each other): the joint itself.
        const [gx, gy, gz] = this.grid.gridSize;
        const plane = gx * gy;
        const now = this.structure.occupancy.used;
        const later = this.usedAt(joinAt);
        const seen = new Uint8Array(now.length);
        const queue: number[] = [];
        for (const c of cells) {
            seen[c] = 1;
            queue.push(c);
        }
        let count = 0;
        let lo = 1;
        let hi = 0;
        for (let q = 0; q < queue.length; q++) {
            const c = queue[q];
            const i = c % gx;
            const j = ((c / gx) | 0) % gy;
            const k = (c / plane) | 0;
            const visit = (n: number) => {
                if (seen[n] || now[n] || !later[n]) return;
                seen[n] = 1;
                queue.push(n);
                count++;
                const fill = this.grid.solid[n] / CELLS_PER_BLOCK;
                if (fill < lo) lo = fill;
                if (fill > hi) hi = fill;
            };
            if (i > 0) visit(c - 1);
            if (i < gx - 1) visit(c + 1);
            if (j > 0) visit(c - gx);
            if (j < gy - 1) visit(c + gx);
            if (k > 0) visit(c - plane);
            if (k < gz - 1) visit(c + plane);
        }
        const many = body.blocks.length !== 1;
        const range = Math.round(lo * 100) === Math.round(hi * 100) ? pct(hi) : `${Math.round(lo * 100)}-${pct(hi)}`;
        const text =
            `${plural(count, "block")} of thin material (${range} filled) next to ${many ? "these blocks" : "this block"} ${count === 1 ? "was" : "were"} left out at the ${pct(this.settings.fillThreshold)} fill threshold. ` +
            `At ${pct(joinAt)} ${count === 1 ? "it is" : "they are"} kept and join${count === 1 ? "s" : ""} the part to the structure, so the model itself may be one piece here.`;
        return { text };
    }

    /** The ladder threshold that holds up the most of the given floating parts (the highest among equals). */
    bestThreshold(floating: Body[]): { threshold: number; joined: number } | null {
        let best: { threshold: number; joined: number } | null = null;
        for (const t of this.ladder) {
            const grounded = this.groundedAt(t);
            let joined = 0;
            for (const body of floating) if (this.cellsOf(body).some((c) => grounded[c])) joined++;
            if (joined > 0 && (!best || joined > best.joined)) best = { threshold: t, joined };
        }
        return best;
    }
}

// ---------- checks ----------

/** The five constraint rows, in the order they are shown. */
export function buildChecks(structure: Structure, settings: AnalysisSettings): CheckRow[] {
    const { stability, stats, cantilevers } = structure;
    const limit = settings.cantileverLimit;
    const empty = stats.blockCount === 0;
    const longRuns = cantilevers.filter((run) => run.overLimit.length > 0).length;
    const floatingBodies = structure.bodies.filter((body) => !body.grounded).length;
    const capacity = structure.gridSize[0] * structure.gridSize[1] * structure.gridSize[2];

    let cog: CheckRow;
    if (empty) cog = { key: "cog", label: "Centre of gravity", value: "No blocks", status: "info" };
    else if (!stability) cog = { key: "cog", label: "Centre of gravity", value: "Nothing touches the ground", status: "fail" };
    else {
        // With several free-standing structures the row reports the weakest one and says so.
        const weakest = (stability.groundedBodies ?? 1) > 1 ? ` (weakest of ${stability.groundedBodies} structures)` : "";
        // Floating blocks are not part of the balance (they are their own error), so the row says they were left out.
        const leftOut = stats.floatingCount > 0 ? ` · ${plural(stats.floatingCount, "floating block")} not counted` : "";
        const note = `${weakest}${leftOut}`;
        if (!stability.inside) {
            const dir = stability.tipDirection ? directionLabel(stability.tipDirection[0], stability.tipDirection[1]) : "";
            cog = { key: "cog", label: "Centre of gravity", value: `Outside the base · ${missShort(-stability.marginMm)}${dir ? ` towards ${dir}` : ""}${note}`, status: "fail" };
        } else if (stability.marginMm < EDGE_MARGIN_MM) {
            cog = { key: "cog", label: "Centre of gravity", value: `On the edge of the base · ${missShort(stability.marginMm)} margin${note}`, status: "pass" };
        } else {
            cog = { key: "cog", label: "Centre of gravity", value: `Inside the base · ${Math.round(stability.marginMm)} mm margin${note}`, status: "pass" };
        }
    }

    const cantilevered: CheckRow = {
        key: "cantilevered",
        label: "Cantilevered blocks",
        value: empty ? "No blocks" : stats.cantileveredCount === 0 ? "None" : plural(stats.cantileveredCount, "block"),
        status: "info",
    };

    const longValue = empty ? "No blocks" : longRuns === 0 ? `None longer than ${plural(limit, "block")}` : `${plural(longRuns, "run")} longer than ${plural(limit, "block")}`;
    const long: CheckRow = { key: "long-cantilevers", label: "Long cantilevers", value: longValue, status: empty ? "info" : longRuns === 0 ? "pass" : "fail" };

    let components: CheckRow;
    if (settings.maxBlocks !== null) {
        components = {
            key: "components",
            label: "Components used",
            value: `${plural(stats.blockCount, "block")} (budget ${settings.maxBlocks})`,
            status: stats.blockCount > 0 && stats.blockCount <= settings.maxBlocks ? "pass" : "fail",
        };
    } else {
        components = { key: "components", label: "Components used", value: `${plural(stats.blockCount, "block")} (of ${capacity})`, status: empty ? "fail" : "info" };
    }

    const floating: CheckRow = {
        key: "floating",
        label: "Floating parts",
        value: empty ? "No blocks" : floatingBodies === 0 ? "None" : `${plural(stats.floatingCount, "block")} in ${plural(floatingBodies, "floating part")}`,
        status: empty ? "info" : floatingBodies === 0 ? "pass" : "fail",
    };

    return [cog, cantilevered, long, components, floating];
}

const round = (v: number, digits = 1): number => {
    const f = 10 ** digits;
    return Math.round(v * f) / f;
};

/** The numbers saved with the model (PUT /models/:id/analysis). */
export function buildSummary(structure: Structure, issues: Issue[], grid: VoxelGrid, settings: AnalysisSettings): AnalysisSummary {
    const { stability, stats } = structure;
    return {
        version: 1,
        blocks: stats.blockCount,
        bodies: stats.bodyCount,
        floating_blocks: stats.floatingCount,
        cantilevered: stats.cantileveredCount,
        longest_cantilever: stats.longestCantilever,
        over_limit: stats.overLimitCount,
        cantilever_limit: settings.cantileverLimit,
        cog_mm: stability ? [round(stability.cogMm[0]), round(stability.cogMm[1]), round(stability.cogMm[2])] : null,
        cog_inside: stability ? stability.inside : false,
        cog_margin_mm: stability ? round(stability.marginMm) : 0,
        size_mm: [round(grid.sizeMm[0]), round(grid.sizeMm[1]), round(grid.sizeMm[2])],
        coverage: round(stats.coverage, 3),
        fill_threshold: round(settings.fillThreshold, 3),
        errors: issues.filter((issue) => issue.severity === "error").length,
        warnings: issues.filter((issue) => issue.severity === "warning").length,
        analyzed_at: new Date().toISOString(),
    };
}
