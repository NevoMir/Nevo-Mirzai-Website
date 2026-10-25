// The text the LLM reads: a compact, labelled picture of the block assembly (about 2.4k characters, 1k tokens; never more than ~4k).
//
// Measured on the ten bundled examples: 1.6-3.1k characters. Sections, in order:
//   MODEL / AXES      what the numbers mean, in the words of the app's Front view (i = left->right, j = 0 is the FRONT, k = up)
//   CURRENT STATE     the metrics of the analysis in one sentence, so "the arm is too long" can be reasoned about
//   ISSUES            up to 6 analysis issues with the cell range they cover ("Arm too long: 6 blocks (max 4) - i8-9 j4-5 k5")
//   ROOM              empty blocks around the model per direction (so "taller" is refused when the model touches the top)
//   PARTS             the source model's own named parts (A, B, ...) with block count and cell range
//   PIECES            ids for blocks that belong to no part: "o1" unlabelled model blocks, "c1" columns, "f1" footing, "b1" brackets,
//                     "g1" bridges, "r1" reinforcement, "u1" the user's earlier edits; each a box of the greedy box partition
//   TOP HEIGHT        silhouette: highest occupied k of every (i,j) column
//   LAYERS            one map per height, rows j (back at the top, front at the bottom) x columns i, letters = parts, lower-case = roles;
//                     identical consecutive layers are folded ("k=1..3 identical")
// Region ids (A, o1, c2, role:column, all) are what the model's operations refer to (ops.ts resolveRegion).

import { CELLS, GRID, USER_ROLE, code, iOf, jOf, kOf, type EditGrid } from "./grid.ts";
import type { AnalysisSummary } from "../contract.ts";
import type { SceneRegions } from "./ops.ts";

export interface SceneIssue {
    severity: "error" | "warning";
    title: string; // "Arm too long: 6 blocks (max 4)"
    cells: ReadonlyArray<readonly [number, number, number]>; // the blocks it points at
}

export interface SceneInput {
    /** "pencil-leg-chair (stabilized version)" - a label for the model; never instructions. */
    name: string;
    summary: AnalysisSummary;
    issues: readonly SceneIssue[];
    /** The last edits of this session, oldest first (at most 3 are shown). */
    history?: ReadonlyArray<{ instruction: string; summary: string }>;
}

export interface Scene {
    text: string;
    regions: SceneRegions;
    stats: { chars: number; parts: number; pieces: number; layers: number };
}

/** glyph of a role in the layer maps (parts use capital letters, "#" is an unlabelled model block). */
const ROLE_GLYPH: Record<number, string> = { 1: "c", 2: "f", 3: "b", 4: "g", 5: "r", [USER_ROLE]: "u" };
const ROLE_WORD: Record<string, string> = { c: "column", f: "footing", b: "bracket", g: "bridge", r: "reinforcement", u: "user-added", o: "unlabelled model" };
const MAX_PIECES = 28;
const MAX_PIECES_PER_GROUP = 12;
const MAX_ISSUES = 6;

interface Box {
    lo: [number, number, number];
    hi: [number, number, number];
    cells: number[];
}

/** Greedy partition of a cell set into axis-aligned boxes, the biggest first (ties: first in k, j, i order). Deterministic. */
export function boxPartition(cells: readonly number[], maxBoxes: number): Box[] {
    const left = new Uint8Array(CELLS);
    for (const c of cells) left[c] = 1;
    const S = GRID + 1;
    const at = (i: number, j: number, k: number): number => (k * S + j) * S + i;
    const boxes: Box[] = [];
    while (boxes.length < maxBoxes) {
        const ps = new Int32Array(S * S * S); // 3-D prefix sums of what is left
        for (let k = 1; k <= GRID; k++)
            for (let j = 1; j <= GRID; j++)
                for (let i = 1; i <= GRID; i++) {
                    ps[at(i, j, k)] =
                        left[code(i - 1, j - 1, k - 1)] + ps[at(i - 1, j, k)] + ps[at(i, j - 1, k)] + ps[at(i, j, k - 1)] - ps[at(i - 1, j - 1, k)] - ps[at(i - 1, j, k - 1)] - ps[at(i, j - 1, k - 1)] + ps[at(i - 1, j - 1, k - 1)];
                }
        const sum = (i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): number =>
            ps[at(i1 + 1, j1 + 1, k1 + 1)] - ps[at(i0, j1 + 1, k1 + 1)] - ps[at(i1 + 1, j0, k1 + 1)] - ps[at(i1 + 1, j1 + 1, k0)] + ps[at(i0, j0, k1 + 1)] + ps[at(i0, j1 + 1, k0)] + ps[at(i1 + 1, j0, k0)] - ps[at(i0, j0, k0)];
        let best: [number, number, number, number, number, number] | null = null;
        let bestVolume = 0;
        for (let k0 = 0; k0 < GRID; k0++)
            for (let j0 = 0; j0 < GRID; j0++)
                for (let i0 = 0; i0 < GRID; i0++) {
                    if (!left[code(i0, j0, k0)]) continue;
                    for (let k1 = k0; k1 < GRID; k1++) {
                        if (!left[code(i0, j0, k1)]) break;
                        for (let j1 = j0; j1 < GRID; j1++) {
                            if (!left[code(i0, j1, k1)]) break;
                            for (let i1 = i0; i1 < GRID; i1++) {
                                const volume = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
                                if (volume <= bestVolume) {
                                    if (!left[code(i1, j1, k1)]) break;
                                    continue;
                                }
                                if (sum(i0, j0, k0, i1, j1, k1) !== volume) break;
                                best = [i0, j0, k0, i1, j1, k1];
                                bestVolume = volume;
                            }
                        }
                    }
                }
        if (!best) break;
        const box: Box = { lo: [best[0], best[1], best[2]], hi: [best[3], best[4], best[5]], cells: [] };
        for (let k = best[2]; k <= best[5]; k++)
            for (let j = best[1]; j <= best[4]; j++)
                for (let i = best[0]; i <= best[3]; i++) {
                    box.cells.push(code(i, j, k));
                    left[code(i, j, k)] = 0;
                }
        boxes.push(box);
    }
    return boxes;
}


/** Region ids of the blocks that belong to no part: boxes of the greedy partition of each group ("o" unlabelled, then the roles). */
function piecesOf(groups: ReadonlyMap<string, number[]>): { regions: SceneRegions; lines: string[] } {
    const pieces = new Map<string, number[]>();
    const lines: string[] = [];
    let listed = 0;
    for (const key of ["o", "c", "f", "b", "g", "r", "u"]) {
        const cells = groups.get(key);
        if (!cells) continue;
        const boxes = boxPartition(cells, Math.max(1, Math.min(MAX_PIECES_PER_GROUP, MAX_PIECES - listed)));
        let used = 0;
        boxes.forEach((box, n) => {
            const id = `${key}${n + 1}`;
            pieces.set(id, box.cells);
            used += box.cells.length;
            listed++;
            lines.push(`${id} ${ROLE_WORD[key]} box: ${rangesText(box.lo, box.hi)} (${box.cells.length})`);
        });
        if (used < cells.length) lines.push(`(${cells.length - used} more ${ROLE_WORD[key]} blocks are in small scraps that have no id; address them with a box)`);
    }
    return { regions: { pieces }, lines };
}

/** The group of cells a glyph stands for in the PIECES section: "o" unlabelled model blocks, "c" columns, ... */
function groupsOf(grid: EditGrid): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    const add = (key: string, c: number): void => void (groups.get(key) ?? groups.set(key, []).get(key))?.push(c);
    for (let c = 0; c < CELLS; c++) {
        if (!grid.occ[c]) continue;
        const label = grid.label[c];
        if (label >= 0 && label < grid.parts.length && label < 26) continue;
        add(grid.role[c] === 0 ? "o" : (ROLE_GLYPH[grid.role[c]] ?? "?"), c);
    }
    return groups;
}

/** The region table of a grid without writing the whole scene: what replaying a logged edit needs (the ids it was planned against). */
export function pieceRegions(grid: EditGrid): SceneRegions {
    return piecesOf(groupsOf(grid)).regions;
}

const range = (a: number, b: number, prefix: string): string => (a === b ? `${prefix}${a}` : `${prefix}${a}-${b}`);
const rangesText = (lo: readonly number[], hi: readonly number[]): string => `${range(lo[0], hi[0], "i")} ${range(lo[1], hi[1], "j")} ${range(lo[2], hi[2], "k")}`;

function boundsOf(cells: Iterable<number>): { lo: [number, number, number]; hi: [number, number, number] } {
    const lo: [number, number, number] = [GRID, GRID, GRID];
    const hi: [number, number, number] = [-1, -1, -1];
    for (const c of cells) {
        const p = [iOf(c), jOf(c), kOf(c)];
        for (let a = 0; a < 3; a++) {
            if (p[a] < lo[a]) lo[a] = p[a];
            if (p[a] > hi[a]) hi[a] = p[a];
        }
    }
    return { lo, hi };
}

// eslint-disable-next-line no-control-regex
const cleanText = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function buildScene(grid: EditGrid, input: SceneInput): Scene {
    const glyph: string[] = new Array<string>(CELLS).fill(".");
    const partCells: number[][] = grid.parts.map(() => []);
    const groups = new Map<string, number[]>();
    const occupied: number[] = [];
    const group = (key: string): number[] => groups.get(key) ?? groups.set(key, []).get(key) ?? [];
    for (let c = 0; c < CELLS; c++) {
        if (!grid.occ[c]) continue;
        occupied.push(c);
        const role = grid.role[c];
        const label = grid.label[c];
        if (label >= 0 && label < grid.parts.length && label < 26) {
            glyph[c] = String.fromCharCode(65 + label);
            partCells[label].push(c);
        } else if (role === 0) {
            glyph[c] = "#";
            group("o").push(c);
        } else {
            glyph[c] = ROLE_GLYPH[role] ?? "?";
            group(glyph[c]).push(c);
        }
    }

    const partLines: string[] = [];
    grid.parts.forEach((name, p) => {
        const cells = partCells[p];
        if (!cells || cells.length === 0) return;
        const b = boundsOf(cells);
        const edited = cells.filter((c) => grid.role[c] === USER_ROLE).length;
        partLines.push(`${String.fromCharCode(65 + p)} "${cleanText(name, 40)}": ${cells.length} blocks, ${rangesText(b.lo, b.hi)}${edited > 0 ? ` (${edited} added or moved by edits)` : ""}`);
    });

    const { regions, lines: pieceLines } = piecesOf(groups);
    const pieces = regions.pieces as Map<string, number[]>;

    // Only the rows and columns the model uses are printed; the labels keep the true indices.
    const bb = boundsOf(occupied);
    const [I0, J0] = [bb.lo[0], bb.lo[1]];
    const [I1, J1] = [bb.hi[0], bb.hi[1]];
    const iHead = `   i${Array.from({ length: I1 - I0 + 1 }, (_, n) => (I0 + n) % 10).join("")}`;
    const room = `ROOM (empty blocks the model can still grow into): left(-i) ${I0}, right(+i) ${GRID - 1 - I1}, front(-j) ${J0}, back(+j) ${GRID - 1 - J1}, up(+k) ${GRID - 1 - bb.hi[2]}${bb.hi[2] === GRID - 1 ? " (it already reaches the top of the grid)" : ""}.`;

    const topRows: string[] = [];
    for (let j = J1; j >= J0; j--) {
        let row = "";
        for (let i = I0; i <= I1; i++) {
            let top = -1;
            for (let k = GRID - 1; k >= 0; k--) if (grid.occ[code(i, j, k)]) { top = k; break; }
            row += top < 0 ? "." : String(top);
        }
        topRows.push(`j${j}|${row}`);
    }

    const rowsOf = (k: number): string[] => {
        const rows: string[] = [];
        for (let j = J1; j >= J0; j--) {
            let row = "";
            for (let i = I0; i <= I1; i++) row += glyph[code(i, j, k)];
            rows.push(`j${j}|${row}`);
        }
        return rows;
    };
    const maps = Array.from({ length: GRID }, (_, k) => rowsOf(k).join("\n"));
    const topLayer = bb.hi[2];
    const layerText: string[] = [];
    for (let k = 0; k <= topLayer; k++) {
        if (k > 0 && maps[k] === maps[k - 1]) continue;
        let end = k;
        while (end + 1 <= topLayer && maps[end + 1] === maps[k]) end++;
        layerText.push(`${end > k ? `k=${k}..${end} (these ${end - k + 1} layers are identical)` : `k=${k}`}\n${maps[k]}`);
    }

    const s = input.summary;
    const stress = s.stress;
    const cog = s.cog_mm === null ? "no block touches the ground, so there is no support base" : s.cog_inside ? `centre of gravity inside the base, margin ${Math.round(s.cog_margin_mm)} mm` : `centre of gravity OUTSIDE the base by ${Math.round(-s.cog_margin_mm)} mm (it tips over)`;
    const state = `blocks ${s.blocks}, separate structures ${s.bodies}, floating blocks ${s.floating_blocks}, longest cantilever ${s.longest_cantilever} blocks (limit ${s.cantilever_limit}), blocks over the limit ${s.over_limit}; ${cog}; ${stress ? `peak joint stress ${Math.round(stress.max_utilisation * 100)}% of allowable (${stress.overstressed_blocks} blocks over 100%)` : "joint stress not computed"}`;
    const issueLines = input.issues.slice(0, MAX_ISSUES).map((issue) => {
        const b = boundsOf(issue.cells.map((p) => code(p[0], p[1], p[2])));
        return `- ${issue.severity}: ${cleanText(issue.title, 80)}${issue.cells.length > 0 ? ` - ${rangesText(b.lo, b.hi)}` : ""}`;
    });

    const legend = ["# = model block without a part", "c = column", "f = footing", "b = bracket", "g = bridge", "r = reinforcement", "u = added or moved by an edit", ". = empty"].join(", ");
    const out: string[] = [];
    out.push(`MODEL: ${cleanText(input.name, 80)}. GRID 10x10x10, one block = 100 mm. A cell is (i,j,k).`);
    out.push("AXES (as seen in the app's Front view): i = left->right (i=0 is the LEFT side, i=9 the RIGHT). j = depth (j=0 is the FRONT, nearest the viewer; j=9 is the BACK). k = height (k=0 rests on the ground, k=9 is the top).");
    out.push(`CURRENT STATE: ${state}.\n${issueLines.length > 0 ? `ISSUES:\n${issueLines.join("\n")}` : "ISSUES: none."}`);
    out.push(room);
    if (partLines.length > 0) out.push(`PARTS (names come from the model; the letter is the region id; trust the cell ranges, not the words left/right in a name):\n${partLines.join("\n")}`);
    if (pieceLines.length > 0) out.push(`PIECES (region ids for blocks that are not in a named part):\n${pieceLines.join("\n")}`);
    out.push(`TOP HEIGHT of each (i,j) column = highest occupied k ('.' = empty column). Rows: back (high j) at the top, front (low j) at the bottom; columns i=${I0}..${I1} left to right.\n${iHead}\n${topRows.join("\n")}`);
    out.push(`LAYERS, one map per height k (empty layers above the top are not listed). Rows: back (high j) at the top, front (low j) at the bottom; columns i=${I0}..${I1} left to right; the digits in the header are i. Letters A-Z = named parts. ${legend}.\n${iHead}\n${layerText.join("\n")}`);
    const history = (input.history ?? []).slice(-3);
    if (history.length > 0) out.push(`EARLIER EDITS IN THIS SESSION (already applied in the maps above): ${history.map((h, n) => `${n + 1}. "${cleanText(h.instruction, 120)}" -> ${cleanText(h.summary, 120)}`).join(" ")}`);
    const text = out.join("\n");
    return { text, regions: { pieces }, stats: { chars: text.length, parts: partLines.length, pieces: pieceLines.length, layers: layerText.length } };
}
