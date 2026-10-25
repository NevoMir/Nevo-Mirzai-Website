// Plain-language helpers for the words the screen shows about the analysis: which way something points as the Front
// view shows it, and where a group of blocks is (a height and a side). Shared by the issue texts (issues.ts, stress.ts) and
// the panel's one-line briefs (store/analysisBrief.ts), so "right", "back left" and "600-700 mm up" are worded in one place.
//
// Pure and light on purpose: the page imports this (through the store), so it must not pull in the engine. The exported report
// keeps the technical terms (+X, cells, kPa); only the text a student reads on screen goes through here.

import type { Block, Vec3 } from "./types.ts";

/**
 * Which way a horizontal direction points as the Front view shows it: +X is right, -X left, -Y towards the viewer (the
 * front) and +Y away (the back). A direction within ~22 degrees of an axis counts as that axis, anything between is a
 * diagonal ("back right"). "" for no direction. The same classes as geometry.ts directionLabel, in words.
 */
export function plainDirection(dx: number, dy: number): string {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax === 0 && ay === 0) return "";
    const x = dx >= 0 ? "right" : "left";
    const y = dy >= 0 ? "back" : "front";
    if (ay < 0.4 * ax) return x;
    if (ax < 0.4 * ay) return y;
    return `${y} ${x}`;
}

/** "right" -> "towards the right", "back left" -> "towards the back left". */
export const towardsText = (direction: string): string => `towards the ${direction}`;

/** "500-600 mm" for the layers [k0, k1]. */
export function heightRange(k0: number, k1: number, blockSizeMm: number): string {
    return `${Math.round(k0 * blockSizeMm)}-${Math.round((k1 + 1) * blockSizeMm)} mm`;
}

/** A group of blocks, located in words. */
export interface Place {
    /** Lowest and highest layer (k) of the blocks. */
    layers: [number, number];
    /** "600-700 mm": the heights the blocks span above the ground. */
    height: string;
    /** "right side", "left side", "back", "front", "back left", ... or "middle" when the group sits near the middle of the model. */
    side: string;
    /** For a line of its own: "600-700 mm up, right side" / "200-300 mm up, in the middle". */
    line: string;
    /** For a sentence: "at a height of 600-700 mm, on the right side" / "..., at the back left" / "..., in the middle". */
    sentence: string;
}

/** A group this close to the middle of the model (in blocks) is "in the middle", not on a side. */
const MIDDLE_BLOCKS = 0.75;

const SIDE_WORDS: Record<string, { line: string; at: string }> = {
    right: { line: "right side", at: "on the right side" },
    left: { line: "left side", at: "on the left side" },
    back: { line: "back", at: "at the back" },
    front: { line: "front", at: "at the front" },
};

/** The middle of the model: the centre of the extent of its blocks, in the floor plan. */
function middleOf(all: readonly Block[]): [number, number] {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const b of all) {
        x0 = Math.min(x0, b.centerMm[0]);
        x1 = Math.max(x1, b.centerMm[0]);
        y0 = Math.min(y0, b.centerMm[1]);
        y1 = Math.max(y1, b.centerMm[1]);
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** The place of a group centred at (cx, cy) spanning layers k0..k1, as seen from the middle of `all`. */
function describe(all: readonly Block[], k0: number, k1: number, cx: number, cy: number, blockSizeMm: number): Place {
    const [mx, my] = middleOf(all);
    const dx = cx - mx;
    const dy = cy - my;
    const height = heightRange(k0, k1, blockSizeMm);
    const direction = Math.hypot(dx, dy) < MIDDLE_BLOCKS * blockSizeMm ? "" : plainDirection(dx, dy);
    const known = SIDE_WORDS[direction];
    const side = direction === "" ? "middle" : (known?.line ?? direction);
    const at = direction === "" ? "in the middle" : (known?.at ?? `at the ${direction}`);
    return {
        layers: [k0, k1],
        height,
        side,
        line: `${height} up, ${direction === "" ? "in the middle" : side}`,
        sentence: `at a height of ${height}, ${at}`,
    };
}

/**
 * Where `ids` (indices into `all`) are: the heights they span and the side of the model they are on, as the Front view shows
 * it. The side is the direction from the middle of the model to the group's centre. Never a cell coordinate. null for no blocks.
 */
export function placeOf(all: readonly Block[], ids: readonly number[], blockSizeMm: number): Place | null {
    const group = ids.map((id) => all[id]).filter((b): b is Block => !!b);
    if (group.length === 0) return null;
    let k0 = Infinity;
    let k1 = -Infinity;
    let cx = 0;
    let cy = 0;
    for (const b of group) {
        k0 = Math.min(k0, b.cell[2]);
        k1 = Math.max(k1, b.cell[2]);
        cx += b.centerMm[0];
        cy += b.centerMm[1];
    }
    return describe(all, k0, k1, cx / group.length, cy / group.length, blockSizeMm);
}

/** Where a point is (an issue with no blocks of its own, like thin parts left out): the layer it is in and its side of the model. */
export function placeAtPoint(all: readonly Block[], point: Readonly<Vec3>, blockSizeMm: number): Place | null {
    if (all.length === 0) return null;
    const k = Math.max(0, Math.floor(point[2] / blockSizeMm));
    return describe(all, k, k, point[0], point[1], blockSizeMm);
}
