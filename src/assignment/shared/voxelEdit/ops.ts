// The cell operations a natural-language edit of the blocks is made of, and the code that applies them.
//
//   cleanAnswer(raw)    the LLM's JSON (untrusted, any shape) -> RawAnswer, or null when it is not an answer at all
//   applyEdit(...)      RawAnswer + the grid + the scene's region table -> a NEW grid and a report. Never throws on bad model output:
//                       an operation that cannot be used is dropped with a reason, and when nothing is usable the edit is refused.
//
// Seven operations (docs in prompt.ts; the LLM sees the same words):
//   add      fill the empty cells of a box
//   remove   delete the blocks of a region and/or box
//   extrude  grow a region/box by N blocks in some directions (taller, wider, thicker)
//   stretch  insert/delete whole slabs along an axis at an index; everything beyond moves (lengthen legs together with what sits on them)
//   shift    move a region/box
//   mirror   copy a region/box across a plane
//   hollow   keep a wall of N blocks, remove the inside (never splits the model into more pieces than it had)
//
// Rules that make an edit safe to apply to anything the model says:
//   - every coordinate is rounded and clamped to the grid, a box is ordered; an operation that misses the grid is dropped;
//   - an operation that would push a block out of the grid (shift, stretch) is refused whole, never cut;
//   - additions only fill EMPTY cells; a shift onto existing blocks overwrites them and counts them as removed, except onto blocks the
//     stabilizer added (protected, see below): a shift that would land on those is refused whole;
//   - blocks the stabilizer added (roles 1-5) are PROTECTED: remove, shift, hollow and slab deletion leave them alone unless the
//     operation names them (region "role:column", or a piece id such as "c1") or sets include_added, which the model is told to do
//     only when the instruction is about them. The report says how many were kept;
//   - blocks an edit creates or moves get role "user" and step = `step`; blocks it only shifts along (stretch) keep theirs;
//   - piece ids ("o1", "c1") follow their blocks through the operations of one answer, like part letters and roles do: after "shift o1" a
//     later "remove o1" in the same answer means the blocks that were moved, not the cells they left (blocks an operation grows from a
//     piece, by extrude, stretch or mirror, join that piece);
//   - the input grid is never modified.
//
// The types and name lists at the top are also what shared/voxelEdit/log.ts (the saved log) and worker/editChecks.ts depend on.

import { MAX_VOXEL_OPS } from "../contract.ts";
import { CELLS, GRID, USER_ROLE, cloneGrid, code, countBlocks, emptyGrid, iOf, inGrid, isStabilizerRole, jOf, kOf, type EditGrid } from "./grid.ts";

// ---------- the operations as the app applied them (what the log keeps) ----------

export const VOXEL_OP_NAMES = ["add", "remove", "extrude", "stretch", "shift", "mirror", "hollow"] as const;
export type VoxelOpName = (typeof VOXEL_OP_NAMES)[number];
export const VOXEL_DIRS = ["+i", "-i", "+j", "-j", "+k", "-k"] as const;
export type VoxelDir = (typeof VOXEL_DIRS)[number];

/** One operation as the app applied it. Fields that do not apply to the op are absent. */
export interface VoxelOp {
    op: VoxelOpName;
    region?: string; // "A".."Z" part, "c1".."u9" piece, "role:column", "all"
    box?: [number, number, number, number, number, number]; // i0, j0, k0, i1, j1, k1, ordered, inside the grid
    dirs?: VoxelDir[];
    amount?: number;
    axis?: "i" | "j" | "k";
    at?: number;
    plane?: number;
    offset?: [number, number, number];
    wall?: number;
    include_added?: boolean;
}

/** One instruction of the person and what became of it (an entry of VoxelEditLog.edits). */
export interface VoxelEditEntry {
    n: number; // 1-based; the blocks it created have step base_steps + n
    instruction: string; // the person's words, 1 to EDIT_INSTRUCTION_MAX characters
    summary: string; // the model's sentence, 1 to 200
    notes: string; // how it read an ambiguous word; may be empty, at most 200
    ops: VoxelOp[]; // at most MAX_VOXEL_OPS
    added: number;
    removed: number;
    moved: number;
    skipped_protected: number; // stabilizer blocks an operation would have touched and left alone
    model: string; // the LLM, "" for an edit made without one
    cost_usd: number | null;
}

// ---------- the answer ----------

export interface RawOp {
    op: unknown;
    region: unknown;
    box: unknown;
    dirs: unknown;
    amount: unknown;
    axis: unknown;
    at: unknown;
    plane: unknown;
    offset: unknown;
    wall: unknown;
    include_added: unknown;
}

export interface RawAnswer {
    summary: string;
    notes: string;
    clarification: string;
    ops: RawOp[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/** Shape only: strings are trimmed and bounded, `ops` is a list of objects. Whether an operation makes sense is applyEdit's job. */
export function cleanAnswer(value: unknown): RawAnswer | null {
    if (!isRecord(value)) return null;
    const ops: RawOp[] = [];
    if (Array.isArray(value.ops)) {
        for (const item of value.ops.slice(0, 64)) {
            if (!isRecord(item)) continue;
            ops.push({ op: item.op, region: item.region, box: item.box, dirs: item.dirs, amount: item.amount, axis: item.axis, at: item.at, plane: item.plane, offset: item.offset, wall: item.wall, include_added: item.include_added });
        }
    }
    return { summary: str(value.summary, 200), notes: str(value.notes, 200), clarification: str(value.clarification, 300), ops };
}

// ---------- regions ----------

/** The scene's table of ids that are not parts or roles: "c1", "o3", ... -> the cells of that piece when the scene was written. */
export interface SceneRegions {
    pieces: ReadonlyMap<string, readonly number[]>;
}

const ROLE_REGION = /^role:(column|footing|bracket|bridge|reinforcement|user)$/;
const PIECE_ID = /^[a-z]\d{1,2}$/;
const ROLE_INDEX: Record<string, number> = { column: 1, footing: 2, bracket: 3, bridge: 4, reinforcement: 5, user: USER_ROLE };

/** The cells (blocks now present) a region id stands for; null when the id means nothing in this scene. */
export function resolveRegion(id: string, grid: EditGrid, regions: SceneRegions): Set<number> | null {
    const out = new Set<number>();
    if (id === "all") {
        for (let c = 0; c < CELLS; c++) if (grid.occ[c]) out.add(c);
        return out;
    }
    if (/^[A-Z]$/.test(id)) {
        const part = id.charCodeAt(0) - 65;
        if (part >= grid.parts.length) return null;
        for (let c = 0; c < CELLS; c++) if (grid.occ[c] && grid.label[c] === part) out.add(c);
        return out;
    }
    const role = ROLE_REGION.exec(id);
    if (role) {
        for (let c = 0; c < CELLS; c++) if (grid.occ[c] && grid.role[c] === ROLE_INDEX[role[1]]) out.add(c);
        return out;
    }
    if (PIECE_ID.test(id)) {
        const piece = regions.pieces.get(id);
        if (!piece) return null;
        for (const c of piece) if (grid.occ[c]) out.add(c);
        return out;
    }
    return null;
}

/** The region ids that name added blocks directly: a removal through them needs no include_added. */
const namesAddedBlocks = (region: string | null): boolean => region !== null && (ROLE_REGION.test(region) || /^[cfbgru]\d{1,2}$/.test(region));

// ---------- numbers and boxes ----------

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function num(v: unknown): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
const int = (v: unknown): number | null => {
    const n = num(v);
    return n === null ? null : Math.round(n);
};

type Box = [number, number, number, number, number, number];
interface ParsedBox {
    box: Box; // ordered, inside the grid
    clipped: boolean;
}

/** A box [i0,j0,k0,i1,j1,k1] in any corner order, clipped to the grid; null when malformed or entirely outside. */
function parseBox(value: unknown): ParsedBox | null {
    if (!Array.isArray(value) || value.length !== 6) return null;
    const v = value.map(int);
    if (v.some((x) => x === null)) return null;
    const [a, b, c, d, e, f] = v as number[];
    const lo = [Math.min(a, d), Math.min(b, e), Math.min(c, f)];
    const hi = [Math.max(a, d), Math.max(b, e), Math.max(c, f)];
    if (hi.some((x) => x < 0) || lo.some((x) => x > GRID - 1)) return null;
    const clipped = lo.some((x) => x < 0) || hi.some((x) => x > GRID - 1);
    return { box: [clamp(lo[0], 0, GRID - 1), clamp(lo[1], 0, GRID - 1), clamp(lo[2], 0, GRID - 1), clamp(hi[0], 0, GRID - 1), clamp(hi[1], 0, GRID - 1), clamp(hi[2], 0, GRID - 1)], clipped };
}

function* boxCells(b: Box): Generator<number> {
    for (let k = b[2]; k <= b[5]; k++) for (let j = b[1]; j <= b[4]; j++) for (let i = b[0]; i <= b[3]; i++) yield code(i, j, k);
}

const inBox = (c: number, b: Box): boolean => iOf(c) >= b[0] && iOf(c) <= b[3] && jOf(c) >= b[1] && jOf(c) <= b[4] && kOf(c) >= b[2] && kOf(c) <= b[5];

const DIR_VEC: Record<VoxelDir, readonly [number, number, number]> = { "+i": [1, 0, 0], "-i": [-1, 0, 0], "+j": [0, 1, 0], "-j": [0, -1, 0], "+k": [0, 0, 1], "-k": [0, 0, -1] };
const AXES = ["i", "j", "k"] as const;
type Axis = (typeof AXES)[number];
const NEIGHBOURS = Object.values(DIR_VEC);

/** Plain words for the messages a person reads (the technical letters i, j, k never reach the screen). */
const VERB: Record<VoxelOpName, string> = { add: "add", remove: "remove", extrude: "grow", stretch: "stretch", shift: "move", mirror: "mirror", hollow: "hollow out" };
const DIR_WORD: Record<VoxelDir, string> = { "+i": "to the right", "-i": "to the left", "+j": "at the back", "-j": "at the front", "+k": "on top", "-k": "underneath" };
const AXIS_WORD: Record<Axis, string> = { i: "from left to right", j: "from front to back", k: "in height" };

// ---------- the report ----------

export interface AppliedOp {
    op: VoxelOp; // as applied: normalised, clamped, nulls dropped (this is what the edit log stores)
    text: string; // "extruded +k by 2: +14 blocks"
    added: number;
    removed: number;
    moved: number;
}

export interface EditReport {
    applied: AppliedOp[];
    /** Operations that could not be used, each with the reason (shown to the user as the edit's warnings). */
    rejected: string[];
    /** Operations that ran but did less than asked, or notes about what was clipped or kept. */
    warnings: string[];
    added: number;
    removed: number;
    moved: number;
    /** Stabilizer blocks an operation would have touched and left alone. */
    protectedKept: number;
    /** 1 for every cell this edit created or moved (set when applyEdit returns): what the preview paints in the edit colour. */
    touched: Uint8Array;
    /** A big change (half the blocks gone, or 200 or more added): the card words its warning more strongly. Every edit waits for Apply anyway. */
    large: boolean;
}

/** Share of the blocks an edit may remove, and number it may add, before it counts as large. */
export const LARGE_REMOVED_SHARE = 0.5;
export const LARGE_ADDED = 200;

export type ApplyResult = { ok: true; grid: EditGrid; report: EditReport } | { ok: false; grid: EditGrid; report: EditReport; reason: string };

// ---------- applying ----------

/**
 * Applies the answer to a copy of `grid`. `step` is the step number the blocks it creates get (EditMeta.base_steps + the edit's
 * number, 1..255). On ok === false the returned grid is `grid` itself.
 */
export function applyEdit(input: EditGrid, answer: RawAnswer, regions: SceneRegions, step: number): ApplyResult {
    const grid = cloneGrid(input);
    // Which piece (index into `pieceIds`, -1 = none) each block belongs to. The scene's table names cells as they were when it was written;
    // operations move and delete blocks, so the table is kept in step block by block (a fresh table is made for every operation).
    const pieceIds = [...regions.pieces.keys()];
    const pieceOf = new Int16Array(CELLS).fill(-1);
    pieceIds.forEach((id, n) => {
        for (const c of regions.pieces.get(id) ?? []) if (c >= 0 && c < CELLS && grid.occ[c] && pieceOf[c] === -1) pieceOf[c] = n;
    });
    const liveRegions = (): SceneRegions => {
        const pieces = new Map<string, number[]>(pieceIds.map((id) => [id, []]));
        for (let c = 0; c < CELLS; c++) if (pieceOf[c] >= 0) pieces.get(pieceIds[pieceOf[c]])?.push(c);
        return { pieces };
    };
    const report: EditReport = { applied: [], rejected: [], warnings: [], added: 0, removed: 0, moved: 0, protectedKept: 0, touched: new Uint8Array(CELLS), large: false };
    const warn = (text: string): void => void report.warnings.push(text);
    const stepNo = clamp(Math.round(step), 1, 255);
    if (answer.ops.length > MAX_VOXEL_OPS) warn(`Only the first ${MAX_VOXEL_OPS} steps of the plan were used.`);

    const create = (c: number, label: number, piece = -1): void => {
        grid.occ[c] = 1;
        grid.role[c] = USER_ROLE;
        grid.step[c] = stepNo;
        grid.label[c] = label;
        pieceOf[c] = piece;
    };
    const wipe = (c: number): void => {
        grid.occ[c] = 0;
        grid.role[c] = 0;
        grid.step[c] = 0;
        grid.label[c] = -1;
        pieceOf[c] = -1;
    };
    const take = (c: number, includeAdded: boolean): boolean => {
        if (!grid.occ[c]) return false;
        if (!includeAdded && isStabilizerRole(grid.role[c])) {
            report.protectedKept++;
            return false;
        }
        wipe(c);
        return true;
    };

    answer.ops.slice(0, MAX_VOXEL_OPS).forEach((raw, n) => {
        const label = `Step ${n + 1}`;
        const name = typeof raw.op === "string" ? raw.op : "";
        if (!(VOXEL_OP_NAMES as readonly string[]).includes(name)) {
            report.rejected.push(`${label}: the editor cannot do that.`);
            return;
        }
        const kind = name as VoxelOpName;
        const refuse = (why: string): void => void report.rejected.push(`${label} (${VERB[kind]}): ${why}`);
        const region = typeof raw.region === "string" && raw.region.trim() !== "" ? raw.region.trim() : null;
        const includeAdded = raw.include_added === true || (kind !== "hollow" && namesAddedBlocks(region));
        const before = { added: report.added, removed: report.removed, moved: report.moved };
        const done = (op: VoxelOp, text: string): void => {
            if (includeAdded && kind !== "add") op.include_added = true;
            report.applied.push({ op, text, added: report.added - before.added, removed: report.removed - before.removed, moved: report.moved - before.moved });
        };

        // The target: region ∩ box (either may be absent). `undefined` = neither given, `null` = something did not resolve.
        const target = (): { set: Set<number> | undefined; op: VoxelOp } | null => {
            const op: VoxelOp = { op: kind };
            let set: Set<number> | undefined;
            if (region !== null) {
                const found = resolveRegion(region, grid, liveRegions());
                if (!found) {
                    refuse(`the part or piece "${region}" does not exist in this model.`);
                    return null;
                }
                set = found;
                op.region = region;
            }
            if (raw.box !== null && raw.box !== undefined) {
                const parsed = parseBox(raw.box);
                if (!parsed) {
                    refuse("the place it names is not a box inside the 10 x 10 x 10 space.");
                    return null;
                }
                if (parsed.clipped) warn(`${label}: the box was clipped to the space the model can use.`);
                op.box = parsed.box;
                if (set) {
                    const inside = new Set<number>();
                    for (const c of set) if (inBox(c, parsed.box)) inside.add(c);
                    set = inside;
                } else {
                    set = new Set(boxCells(parsed.box));
                }
            }
            return { set, op };
        };

        switch (kind) {
            case "add": {
                const parsed = parseBox(raw.box);
                if (!parsed) return refuse("it needs a box inside the space the model can use.");
                if (parsed.clipped) warn(`${label}: the box was clipped to the space the model can use.`);
                let count = 0;
                for (const c of boxCells(parsed.box)) {
                    if (grid.occ[c]) continue;
                    create(c, -1);
                    count++;
                }
                report.added += count;
                if (count === 0) warn(`${label}: that place is already full.`);
                return done({ op: kind, box: parsed.box }, `added ${count} ${count === 1 ? "block" : "blocks"}`);
            }
            case "remove": {
                const t = target();
                if (!t) return;
                if (!t.set) return refuse("it needs a part or a place to work on.");
                let count = 0;
                for (const c of t.set) if (take(c, includeAdded)) count++;
                report.removed += count;
                if (count === 0) warn(`${label}: there was nothing to remove there.`);
                return done(t.op, `removed ${count} ${count === 1 ? "block" : "blocks"}`);
            }
            case "extrude": {
                const t = target();
                if (!t) return;
                const dirs = Array.isArray(raw.dirs) ? [...new Set(raw.dirs.filter((d): d is VoxelDir => (VOXEL_DIRS as readonly unknown[]).includes(d)))] : [];
                const amount = clamp(int(raw.amount) ?? 1, 1, GRID - 1);
                if (!t.set || t.set.size === 0 || dirs.length === 0) return refuse("it needs a part or place that has blocks in it, and a direction.");
                const fresh = new Map<number, [number, number]>(); // new cell -> label and piece of the block it grew from
                let outside = 0;
                for (const c of t.set) {
                    if (!grid.occ[c]) continue;
                    for (const d of dirs) {
                        const v = DIR_VEC[d];
                        for (let s = 1; s <= amount; s++) {
                            const i = iOf(c) + v[0] * s;
                            const j = jOf(c) + v[1] * s;
                            const k = kOf(c) + v[2] * s;
                            if (!inGrid(i, j, k)) {
                                outside++;
                                continue;
                            }
                            const cc = code(i, j, k);
                            if (!grid.occ[cc] && !fresh.has(cc)) fresh.set(cc, [grid.label[c], pieceOf[c]]);
                        }
                    }
                }
                for (const [c, [lab, piece]] of fresh) create(c, lab, piece);
                report.added += fresh.size;
                if (fresh.size === 0) warn(`${label}: no room - ${outside > 0 ? "it already reaches the edge of the space the model can use" : "the places next to it are already filled"}.`);
                else if (outside > 0) warn(`${label}: part of it would have left the space the model can use and was cut.`);
                return done({ ...t.op, dirs, amount }, `added ${fresh.size} ${fresh.size === 1 ? "block" : "blocks"} ${dirs.map((d) => DIR_WORD[d]).join(", ")}`);
            }
            case "stretch": {
                const axis = AXES.indexOf(raw.axis as Axis);
                const at = int(raw.at);
                const by = int(raw.amount);
                if (axis < 0 || at === null || by === null || by === 0 || at < 0 || at > GRID - 1) return refuse("it needs a direction, a place along it (0 to 9) and a number that is not zero.");
                const amount = clamp(by, -(GRID - 1), GRID - 1);
                const pos = (c: number): [number, number, number] => [iOf(c), jOf(c), kOf(c)];
                const next = emptyGrid(grid.parts);
                const nextPiece = new Int16Array(CELLS).fill(-1);
                const copy = (from: number, p: [number, number, number], created: boolean): void => {
                    const cc = code(p[0], p[1], p[2]);
                    next.occ[cc] = 1;
                    next.role[cc] = created ? USER_ROLE : grid.role[from];
                    next.step[cc] = created ? stepNo : grid.step[from];
                    next.label[cc] = grid.label[from];
                    nextPiece[cc] = pieceOf[from];
                };
                let moved = 0;
                let made = 0;
                let removed = 0;
                for (let c = 0; c < CELLS; c++) {
                    if (!grid.occ[c]) continue;
                    const p = pos(c);
                    if (amount > 0) {
                        if (p[axis] > at) {
                            p[axis] += amount;
                            moved++;
                        }
                        if (p[axis] >= GRID) return refuse(`does not fit: the model would grow ${amount} past the edge of the space it can use ${AXIS_WORD[AXES[axis]]}.`);
                        copy(c, p, false);
                        if (p[axis] === at) {
                            for (let s = 1; s <= amount; s++) {
                                const q: [number, number, number] = [p[0], p[1], p[2]];
                                q[axis] = at + s;
                                if (q[axis] >= GRID) return refuse("does not fit: the new layers would pass the edge of the space the model can use.");
                                copy(c, q, true);
                                made++;
                            }
                        }
                    } else {
                        const cut = -amount;
                        const last = Math.min(GRID - 1, at + cut - 1);
                        if (p[axis] >= at && p[axis] <= last) {
                            if (!includeAdded && isStabilizerRole(grid.role[c])) return refuse("those layers hold blocks the stabilizer added, which an edit leaves alone unless you name them.");
                            removed++;
                            continue;
                        }
                        if (p[axis] > last) {
                            p[axis] -= last - at + 1;
                            moved++;
                        }
                        copy(c, p, false);
                    }
                }
                // Commit: the new arrays replace the grid's.
                grid.occ.set(next.occ);
                grid.role.set(next.role);
                grid.step.set(next.step);
                grid.label.set(next.label);
                pieceOf.set(nextPiece);
                report.added += made;
                report.removed += removed;
                report.moved += moved;
                return done({ op: kind, axis: AXES[axis], at, amount, ...(includeAdded ? { include_added: true } : {}) }, amount > 0 ? `made the model ${amount} ${amount === 1 ? "block" : "blocks"} longer ${AXIS_WORD[AXES[axis]]}` : `made the model ${-amount} ${amount === -1 ? "block" : "blocks"} shorter ${AXIS_WORD[AXES[axis]]}`);
            }
            case "shift": {
                const t = target();
                if (!t) return;
                const off = Array.isArray(raw.offset) && raw.offset.length === 3 ? raw.offset.map(int) : null;
                if (!t.set || !off || off.some((x) => x === null) || off.every((x) => x === 0)) return refuse("it needs a part or place to move and a distance that is not zero.");
                const offset = off.map((x) => clamp(x as number, -(GRID - 1), GRID - 1)) as [number, number, number];
                const moving = [...t.set].filter((c) => grid.occ[c] && (includeAdded || !isStabilizerRole(grid.role[c])));
                const held = [...t.set].filter((c) => grid.occ[c]).length - moving.length;
                const dest = moving.map((c) => [iOf(c) + offset[0], jOf(c) + offset[1], kOf(c) + offset[2]] as const);
                if (dest.some((p) => !inGrid(p[0], p[1], p[2]))) return refuse("does not fit: part of it would leave the space the model can use.");
                // Landing on a block the stabilizer added would delete it: protected blocks are not overwritten any more than they are removed.
                if (!includeAdded) {
                    const going = new Set(moving);
                    const inTheWay = dest.filter((p) => {
                        const cc = code(p[0], p[1], p[2]);
                        return grid.occ[cc] && !going.has(cc) && isStabilizerRole(grid.role[cc]);
                    }).length;
                    if (inTheWay > 0) return refuse("does not fit: it would land on blocks the stabilizer added, which an edit leaves alone unless you name them.");
                }
                report.protectedKept += held;
                const labels = moving.map((c) => grid.label[c]);
                const pieces = moving.map((c) => pieceOf[c]);
                for (const c of moving) wipe(c);
                let overwritten = 0;
                dest.forEach((p, q) => {
                    const cc = code(p[0], p[1], p[2]);
                    if (grid.occ[cc]) overwritten++;
                    create(cc, labels[q], pieces[q]);
                });
                if (overwritten > 0) {
                    warn(`${label}: the moved blocks landed on ${overwritten} existing ${overwritten === 1 ? "block" : "blocks"}, which they replaced.`);
                    report.removed += overwritten;
                }
                report.moved += moving.length;
                return done({ ...t.op, offset }, `moved ${moving.length} ${moving.length === 1 ? "block" : "blocks"}`);
            }
            case "mirror": {
                const t = target();
                if (!t) return;
                const axis = AXES.indexOf(raw.axis as Axis);
                if (axis < 0) return refuse("it needs a direction to mirror across.");
                if (!t.set || t.set.size === 0) return refuse("it needs a part or place that has blocks in it.");
                let plane = num(raw.plane);
                if (plane === null) {
                    let lo = GRID;
                    let hi = -1;
                    for (let c = 0; c < CELLS; c++) {
                        if (!grid.occ[c]) continue;
                        const v = [iOf(c), jOf(c), kOf(c)][axis];
                        lo = Math.min(lo, v);
                        hi = Math.max(hi, v);
                    }
                    plane = (lo + hi) / 2;
                    warn(`${label}: no mirror line was given, so the middle of the model was used.`);
                }
                plane = clamp(Math.round(plane * 2) / 2, 0, GRID - 1);
                const fresh = new Map<number, [number, number]>(); // new cell -> label and piece of the block it copies
                for (const c of t.set) {
                    if (!grid.occ[c]) continue;
                    const p: [number, number, number] = [iOf(c), jOf(c), kOf(c)];
                    p[axis] = Math.round(2 * plane - p[axis]);
                    if (!inGrid(p[0], p[1], p[2])) continue;
                    const cc = code(p[0], p[1], p[2]);
                    if (!grid.occ[cc] && !fresh.has(cc)) fresh.set(cc, [grid.label[c], pieceOf[c]]);
                }
                for (const [c, [lab, piece]] of fresh) create(c, lab, piece);
                report.added += fresh.size;
                if (fresh.size === 0) warn(`${label}: the mirror image was already there or falls outside the space the model can use.`);
                return done({ ...t.op, axis: AXES[axis], plane }, `mirrored ${fresh.size} ${fresh.size === 1 ? "block" : "blocks"} onto the other side`);
            }
            case "hollow": {
                const t = target();
                if (!t) return;
                const wall = clamp(int(raw.wall) ?? 1, 1, 4);
                const set = t.set ?? resolveRegion("all", grid, regions) ?? new Set<number>();
                // d(c): 6-neighbour steps to the nearest empty cell, or to the grid's side/top (the ground side counts as solid, so a
                // hollow keeps a floor only as far as the walls reach: the inside opens to the ground).
                const dist = new Int16Array(CELLS).fill(-1);
                const queue: number[] = [];
                // Two seed groups in distance order (a single mixed queue would give a block next to both an empty cell and the grid's
                // side the larger of the two distances): empty cells (0) first, then blocks on the grid's side or top (1).
                for (let c = 0; c < CELLS; c++) {
                    if (!grid.occ[c]) {
                        dist[c] = 0;
                        queue.push(c);
                    }
                }
                for (let c = 0; c < CELLS; c++) {
                    if (!grid.occ[c] || dist[c] !== -1) continue;
                    const i = iOf(c);
                    const j = jOf(c);
                    if (i === 0 || j === 0 || i === GRID - 1 || j === GRID - 1 || kOf(c) === GRID - 1) {
                        dist[c] = 1;
                        queue.push(c);
                    }
                }
                for (let h = 0; h < queue.length; h++) {
                    const c = queue[h];
                    for (const v of NEIGHBOURS) {
                        const i = iOf(c) + v[0];
                        const j = jOf(c) + v[1];
                        const k = kOf(c) + v[2];
                        if (!inGrid(i, j, k)) continue;
                        const cc = code(i, j, k);
                        if (grid.occ[cc] && dist[cc] === -1) {
                            dist[cc] = dist[c] + 1;
                            queue.push(cc);
                        }
                    }
                }
                const candidates = [...set].filter((c) => grid.occ[c] && dist[c] > wall && (includeAdded || !isStabilizerRole(grid.role[c]))).sort((a, b) => dist[b] - dist[a] || a - b);
                // Deepest first; a block stays when taking it out would split the model into more pieces than it had.
                const pieces = (): number => {
                    const seen = new Uint8Array(CELLS);
                    let count = 0;
                    for (let c0 = 0; c0 < CELLS; c0++) {
                        if (!grid.occ[c0] || seen[c0]) continue;
                        count++;
                        const stack = [c0];
                        seen[c0] = 1;
                        while (stack.length > 0) {
                            const c = stack.pop() as number;
                            for (const v of NEIGHBOURS) {
                                const i = iOf(c) + v[0];
                                const j = jOf(c) + v[1];
                                const k = kOf(c) + v[2];
                                if (!inGrid(i, j, k)) continue;
                                const cc = code(i, j, k);
                                if (grid.occ[cc] && !seen[cc]) {
                                    seen[cc] = 1;
                                    stack.push(cc);
                                }
                            }
                        }
                    }
                    return count;
                };
                const base = pieces();
                let count = 0;
                let kept = 0;
                for (const c of candidates) {
                    const saved = [grid.role[c], grid.step[c], grid.label[c]] as const;
                    grid.occ[c] = 0;
                    if (pieces() > base) {
                        grid.occ[c] = 1;
                        grid.role[c] = saved[0];
                        grid.step[c] = saved[1];
                        grid.label[c] = saved[2];
                        kept++;
                    } else {
                        wipe(c);
                        count++;
                    }
                }
                const heldBack = [...set].filter((c) => grid.occ[c] && dist[c] > wall && !includeAdded && isStabilizerRole(grid.role[c])).length;
                report.protectedKept += heldBack;
                report.removed += count;
                if (kept > 0) warn(`${label}: ${kept} inner ${kept === 1 ? "block was" : "blocks were"} kept so the model stays in one piece.`);
                if (count === 0) warn(`${label}: nothing to hollow - the walls are already ${wall} thick or thinner.`);
                // The ground side counts as solid for the depth of a wall, so the walls reach down but the floor can go: say so.
                else warn(`${label}: the inside opens to the ground, so the underside is left open.`);
                return done({ ...t.op, wall }, `hollowed out ${count} ${count === 1 ? "block" : "blocks"}, walls ${wall} ${wall === 1 ? "block" : "blocks"} thick`);
            }
        }
    });

    // The cells this edit made (blocks it created or moved carry role user and this edit's step; steps are unique per edit).
    for (let c = 0; c < CELLS; c++) report.touched[c] = grid.occ[c] && grid.role[c] === USER_ROLE && grid.step[c] === stepNo ? 1 : 0;
    if (report.applied.length === 0) return { ok: false, grid: input, report, reason: report.rejected[0] ?? "There was no operation to apply." };
    const left = countBlocks(grid);
    if (left === 0) return { ok: false, grid: input, report, reason: "That would remove every block." };
    report.large = report.removed >= LARGE_REMOVED_SHARE * countBlocks(input) || report.added >= LARGE_ADDED;
    let onGround = false;
    for (let c = 0; c < GRID * GRID && !onGround; c++) onGround = grid.occ[c] === 1;
    if (!onGround) warn("No block touches the ground any more, so the whole model floats. Say \"lower it to the ground\" or use Stabilize.");
    return { ok: true, grid, report };
}

/** Cells that differ between two grids: present only in `after` (added) or only in `before` (removed). For the preview's ghost. */
export function diffGrids(before: EditGrid, after: EditGrid): { added: number[]; removed: number[] } {
    const added: number[] = [];
    const removed: number[] = [];
    for (let c = 0; c < CELLS; c++) {
        if (!before.occ[c] && after.occ[c]) added.push(c);
        else if (before.occ[c] && !after.occ[c]) removed.push(c);
    }
    return { added, removed };
}
