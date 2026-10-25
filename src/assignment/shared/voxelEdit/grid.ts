// The mutable working copy of a block assembly that natural-language edits operate on, and its conversions to and from the
// canonical AssemblyDescriptor (shared/assembly.ts). Pure TypeScript, no DOM: the browser, the Worker and the Node tests share it.
//
// A grid is four flat arrays over the 10 x 10 x 10 cells, indexed by cellCode (k * 10 + j) * 10 + i:
//   occ    1 where a block is
//   role   index into BLOCK_ROLES (0 original ... 5 reinforcement, 6 user)
//   step   0 for a block of the analysed model, n for a block a stabilizer move or an edit added (assembly.ts: role 0 <=> step 0)
//   label  index into `parts` (the part of the source model the block belongs to, by name), -1 for none. Labels follow blocks that
//          are moved or extruded, so "the backrest" still means the backrest after "make the back taller".

import { ASSEMBLY_BLOCK_MM, ASSEMBLY_GRID, CELL_STRIDE, DEFAULT_INSET, cellCode, type AssemblyDescriptor } from "../assembly.ts";
import { BLOCK_ROLES } from "../contract.ts";

export const GRID = ASSEMBLY_GRID;
export const CELLS = GRID ** 3;
/** Role index of the blocks an edit created or moved. */
export const USER_ROLE = BLOCK_ROLES.indexOf("user");
/** Role indexes the stabilizer adds (column ... reinforcement): the blocks an edit leaves alone unless told otherwise. */
export const isStabilizerRole = (role: number): boolean => role >= 1 && role <= 5;

export const code = cellCode;
export const iOf = (c: number): number => c % GRID;
export const jOf = (c: number): number => Math.floor(c / GRID) % GRID;
export const kOf = (c: number): number => Math.floor(c / (GRID * GRID));
export const inGrid = (i: number, j: number, k: number): boolean => i >= 0 && j >= 0 && k >= 0 && i < GRID && j < GRID && k < GRID;

export interface EditGrid {
    occ: Uint8Array;
    role: Uint8Array;
    step: Uint8Array;
    label: Int8Array;
    /** Names of the labelled parts; label n is parts[n]. At most 26 (the scene gives them the letters A-Z). */
    parts: string[];
}

export function emptyGrid(parts: readonly string[] = []): EditGrid {
    return { occ: new Uint8Array(CELLS), role: new Uint8Array(CELLS), step: new Uint8Array(CELLS), label: new Int8Array(CELLS).fill(-1), parts: [...parts] };
}

export function cloneGrid(g: EditGrid): EditGrid {
    return { occ: g.occ.slice(), role: g.role.slice(), step: g.step.slice(), label: g.label.slice(), parts: [...g.parts] };
}

/** Copies every array of `from` into `into` (same parts). */
export function assignGrid(into: EditGrid, from: EditGrid): void {
    into.occ.set(from.occ);
    into.role.set(from.role);
    into.step.set(from.step);
    into.label.set(from.label);
}

export function countBlocks(g: EditGrid): number {
    let n = 0;
    for (let c = 0; c < CELLS; c++) n += g.occ[c];
    return n;
}

/** Highest step among the blocks (0 when none was added by a move or an edit). */
export function maxStep(g: EditGrid): number {
    let m = 0;
    for (let c = 0; c < CELLS; c++) if (g.occ[c] && g.step[c] > m) m = g.step[c];
    return m;
}

/** Which part each cell belongs to: owner[c] is an index into `names`, -1 for none. */
export interface PartLabels {
    names: string[];
    owner: Int8Array;
}

export function gridFromDescriptor(d: AssemblyDescriptor, labels: PartLabels | null = null): EditGrid {
    const g = emptyGrid(labels?.names ?? []);
    for (let n = 0; n < d.cells.length; n += CELL_STRIDE) {
        const c = code(d.cells[n], d.cells[n + 1], d.cells[n + 2]);
        g.occ[c] = 1;
        g.role[c] = d.cells[n + 3];
        g.step[c] = d.cells[n + 4];
        if (labels) g.label[c] = labels.owner[c];
    }
    return g;
}

/** Canonical descriptor: ascending k, then j, then i (assembly.ts). */
export function descriptorOfGrid(g: EditGrid, inset: number = DEFAULT_INSET): AssemblyDescriptor {
    const cells: number[] = [];
    for (let c = 0; c < CELLS; c++) if (g.occ[c]) cells.push(iOf(c), jOf(c), kOf(c), g.role[c], g.step[c]);
    return { version: 1, blockSizeMm: ASSEMBLY_BLOCK_MM, grid: [GRID, GRID, GRID], inset, cells };
}

/** EditMeta.labels: one character per block in canonical order, 'A' + part index, or '.' for none. */
export function labelString(g: EditGrid): string {
    let s = "";
    for (let c = 0; c < CELLS; c++) if (g.occ[c]) s += g.label[c] >= 0 ? String.fromCharCode(65 + g.label[c]) : ".";
    return s;
}

/** The inverse of labelString for a descriptor (same canonical order). Null when the string does not fit the blocks. */
export function labelsFromString(names: readonly string[], s: string, d: Pick<AssemblyDescriptor, "cells">): PartLabels | null {
    if (s.length * CELL_STRIDE !== d.cells.length) return null;
    const owner = new Int8Array(CELLS).fill(-1);
    for (let n = 0; n < s.length; n++) {
        const ch = s.charCodeAt(n);
        if (ch === 46) continue; // '.'
        const part = ch - 65;
        if (part < 0 || part >= names.length) return null;
        owner[code(d.cells[n * CELL_STRIDE], d.cells[n * CELL_STRIDE + 1], d.cells[n * CELL_STRIDE + 2])] = part;
    }
    return { names: [...names], owner };
}

/**
 * Labels for a version whose blocks include those of a labelled one (a stabilization of it: it never moves or removes a block).
 * Cells the labelled version does not have get -1.
 */
export function inheritLabels(parent: PartLabels, parentOcc: Uint8Array, child: Pick<AssemblyDescriptor, "cells">): PartLabels {
    const owner = new Int8Array(CELLS).fill(-1);
    for (let n = 0; n < child.cells.length; n += CELL_STRIDE) {
        const c = code(child.cells[n], child.cells[n + 1], child.cells[n + 2]);
        if (parentOcc[c]) owner[c] = parent.owner[c];
    }
    return { names: [...parent.names], owner };
}
