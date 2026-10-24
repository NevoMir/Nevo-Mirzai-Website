// The pure side of the block view: mapping between the analysis frame and the viewer's frame, the colour
// ramps, the wording of a block's tooltip, and the flat geometry (ribbons, fans, quads) the overlays are
// built from. No three.js and no DOM, so Node can test all of it.
//
// Two frames are in play. "mm" is the analysis frame (Z-up, origin at the min corner of the 10 x 10 x 10
// grid). "display" is the viewer's frame, where the loaded model's longest side is ~100 units. The two are
// related by AnalysisTransform: mm = (p - modelMin) * factor + offsetMm. The block scene is built in mm and
// placed in the display frame by one group transform, so these helpers only map points that cross over
// (labels, the camera focus).
import type { AnalysisColorBy, AnalysisResult, AnalysisSettings, AnalysisTransform, Block, BlockStatus, Stability, Vec2, Vec3 } from "../analysis/types.ts";
import type { ViewTheme } from "./types.ts";

// ---------- frames ----------

/** Analysis mm -> the viewer's display frame (the inverse of the engine's toModelSpace mapping). */
export function mmToDisplay(mm: Vec3, t: AnalysisTransform): Vec3 {
    return [(mm[0] - t.offsetMm[0]) / t.factor + t.modelMin[0], (mm[1] - t.offsetMm[1]) / t.factor + t.modelMin[1], (mm[2] - t.offsetMm[2]) / t.factor + t.modelMin[2]];
}

/** The viewer's display frame -> analysis mm. */
export function displayToMm(p: Vec3, t: AnalysisTransform): Vec3 {
    return [(p[0] - t.modelMin[0]) * t.factor + t.offsetMm[0], (p[1] - t.modelMin[1]) * t.factor + t.offsetMm[1], (p[2] - t.modelMin[2]) * t.factor + t.offsetMm[2]];
}

/** Placement of the mm-built block scene in the display frame: scale first, then move. */
export function displayPlacement(t: AnalysisTransform): { scale: number; position: Vec3 } {
    return { scale: 1 / t.factor, position: mmToDisplay([0, 0, 0], t) };
}

/** The volume the grid spans, in mm. */
export function volumeMm(analysis: Pick<AnalysisResult, "gridSize" | "settings">): Vec3 {
    const b = analysis.settings.blockSizeMm;
    return [analysis.gridSize[0] * b, analysis.gridSize[1] * b, analysis.gridSize[2] * b];
}

/** Highest layer k that holds a block (-1 when there are none). */
export function topLayer(blocks: readonly Block[]): number {
    let top = -1;
    for (const b of blocks) if (b.cell[2] > top) top = b.cell[2];
    return top;
}

/** The layer cut hides something: the top layer is above layerMax. */
export function cutActive(blocks: readonly Block[], layerMax: number): boolean {
    return topLayer(blocks) > layerMax;
}

/**
 * The layer the cut's outline is drawn on: the highest layer at or below `layerMax` that holds a block (-1 when
 * there is none). With a gap in the occupied layers the cut would otherwise sit on an empty one and draw nothing.
 */
export function sectionLayer(blocks: readonly Block[], layerMax: number): number {
    const occupied = new Set<number>();
    for (const b of blocks) occupied.add(b.cell[2]);
    for (let k = Math.min(layerMax, topLayer(blocks)); k >= 0; k -= 1) if (occupied.has(k)) return k;
    return -1;
}

/** How many of the highlighted blocks the layer cut hides (they sit above `layerMax`). */
export function highlightCut(blocks: readonly Block[], highlight: readonly number[], layerMax: number): { total: number; hidden: number } {
    let total = 0;
    let hidden = 0;
    for (const i of highlight) {
        const b = blocks[i];
        if (!b) continue;
        total += 1;
        if (b.cell[2] > layerMax) hidden += 1;
    }
    return { total, hidden };
}

export function countByStatus(blocks: readonly Block[]): Record<BlockStatus, number> {
    const counts: Record<BlockStatus, number> = { supported: 0, cantilever: 0, overreach: 0, floating: 0 };
    for (const b of blocks) counts[b.status] += 1;
    return counts;
}

// ---------- colours ----------

/**
 * Block colours by structural status. Supported blocks are a quiet slate so the problems carry the colour. On the
 * dark theme's mid-grey stage (#8a8f98) a mid slate has the stage's own luminance (1.10-1.65:1 on its lit faces),
 * so the supported blocks there are a deep slate instead: 2.4:1 or better on every face.
 */
export const STATUS_COLORS: Record<BlockStatus, { light: string; dark: string }> = {
    supported: { light: "#94a3b8", dark: "#475062" },
    cantilever: { light: "#f59e0b", dark: "#f59e0b" },
    overreach: { light: "#ef4444", dark: "#ef4444" },
    floating: { light: "#a855f7", dark: "#a855f7" },
};

export const STATUS_LABELS: Record<BlockStatus, string> = { supported: "Supported", cantilever: "Cantilever", overreach: "Over the limit", floating: "Floating" };

export function statusColor(status: BlockStatus, theme: ViewTheme): string {
    return STATUS_COLORS[status][theme];
}

/** Reach ramp stops: 1 block from support is blue, the limit amber (through teal, which keeps the middle clean), past it red. */
const REACH_RAMP = ["#3b82f6", "#14b8a6", "#f59e0b"];
const REACH_OVER = "#ef4444";
/** Layer ramp (viridis, without its darkest end, which is lost on the dark stage). */
const LAYER_RAMP = ["#471365", "#3b528b", "#21918c", "#5ec962", "#fde725"];

export function hexToRgb(hex: string): Vec3 {
    const n = Number.parseInt(hex.replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: Vec3): string {
    const part = (v: number) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** `a` toward `b` by t (0..1), in sRGB. */
export function mixHex(a: string, b: string, t: number): string {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** A colour along evenly spaced stops, t in 0..1. */
function ramp(stops: readonly string[], t: number): string {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
    const x = clamped * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    return mixHex(stops[i], stops[i + 1], x - i);
}

/**
 * Blocks `reach` steps from the nearest support, against the limit: blue at 1, amber at the limit, red beyond.
 * A reach of 0 (supported) is the caller's neutral.
 */
export function reachColor(reach: number, limit: number): string {
    const top = Math.max(1, limit);
    if (reach > top) return REACH_OVER;
    return ramp(REACH_RAMP, top === 1 ? 1 : (reach - 1) / (top - 1));
}

export function layerColor(k: number, layers: number): string {
    return ramp(LAYER_RAMP, layers > 1 ? k / (layers - 1) : 0.5);
}

export interface ColorContext {
    theme: ViewTheme;
    limit: number;
    layers: number;
}

/** The colour of one block under a colouring. */
export function blockColor(block: Block, colorBy: AnalysisColorBy, ctx: ColorContext): string {
    if (colorBy === "layer") return layerColor(block.cell[2], ctx.layers);
    if (colorBy === "reach") {
        if (block.status === "floating" || block.reach === null) return statusColor("floating", ctx.theme);
        if (block.reach <= 0) return statusColor("supported", ctx.theme);
        return reachColor(block.reach, ctx.limit);
    }
    return statusColor(block.status, ctx.theme);
}

/**
 * The tone a dimmed block's colour is drained toward, per stage. It has to differ in brightness from the stage: the
 * old single grey (#9aa1ab) is the dark stage's own luminance, so dimmed blocks there were invisible at any opacity.
 */
const DIM_TARGET: Record<ViewTheme, string> = { light: "#475569", dark: "#0f172a" };

/** A block that is not being looked at (it is not one an issue points at): its colour drained toward a stage-contrasting tone. */
export function dimColor(hex: string, theme: ViewTheme = "light"): string {
    return mixHex(hex, DIM_TARGET[theme], 0.6);
}

/**
 * How present the dimmed blocks and their edges are. Faint, but a structure that is out of focus must still show
 * where the highlighted blocks sit in it: with these, a dimmed face is 1.3-1.7:1 against the stage (it was 1.0-1.2).
 */
export const DIM_OPACITY: Record<ViewTheme, number> = { light: 0.3, dark: 0.35 };
export const DIM_EDGE_OPACITY = 0.28;

/** Everything else the block view paints, per theme. */
export interface BlockPalette {
    edge: string; // block edges
    plate: string; // the ground plate's fill
    plateLine: string; // its 100 mm grid
    plateBorder: string;
    footprint: string; // cells under the structure
    cube: string; // the 1 m target cube, dashed
    dimension: string; // dimension lines
    section: string; // the cut layer's top faces
    ghost: string;
    hover: string;
    highlight: string; // the ring round the blocks an issue points at
    cog: string;
    ok: string;
    bad: string;
}

export const PALETTE: Record<ViewTheme, BlockPalette> = {
    light: {
        edge: "#0f172a",
        plate: "#e2e8f0",
        plateLine: "#94a3b8",
        plateBorder: "#64748b",
        footprint: "#3b82f6",
        cube: "#475569",
        dimension: "#475569",
        section: "#2563eb",
        ghost: "#8b929c",
        hover: "#0f172a",
        highlight: "#2563eb",
        cog: "#ce5222",
        ok: "#16a34a",
        bad: "#ef4444",
    },
    dark: {
        edge: "#111827",
        plate: "#5f6570",
        plateLine: "#c3c8d0",
        plateBorder: "#e5e7eb",
        footprint: "#bfdbfe",
        cube: "#f1f5f9",
        dimension: "#f1f5f9",
        section: "#dbeafe",
        ghost: "#d1d5db",
        hover: "#ffffff",
        highlight: "#93c5fd",
        cog: "#ce5222",
        ok: "#4ade80",
        bad: "#f87171",
    },
};

// ---------- wording ----------

const blocksOf = (n: number) => `${n} ${n === 1 ? "block" : "blocks"}`;

export interface BlockInfo {
    title: string; // "Block (3, 5, 2)"
    zRange: string; // "z 200–300 mm"
    status: BlockStatus;
    statusLabel: string; // "Cantilever"
    detail: string; // "3 blocks from support"
    /** All of it on one line, for assistive technology and tests. */
    text: string;
}

/** What a block tooltip says: where the block is, and why it is the colour it is. */
export function describeBlock(block: Block, settings: Pick<AnalysisSettings, "blockSizeMm" | "cantileverLimit">): BlockInfo {
    const [i, j, k] = block.cell;
    const half = settings.blockSizeMm / 2;
    const z0 = Math.round(block.centerMm[2] - half);
    const z1 = Math.round(block.centerMm[2] + half);
    let detail: string;
    if (block.status === "supported") detail = k === 0 ? "rests on the ground" : "carried down to the ground";
    else if (block.status === "floating") detail = "not connected to the ground";
    else if (block.reach === null) detail = "nothing underneath";
    else if (block.status === "overreach") detail = `${blocksOf(block.reach)} from support, the limit is ${settings.cantileverLimit}`;
    else detail = `${blocksOf(block.reach)} from support`;
    const statusLabel = STATUS_LABELS[block.status];
    const title = `Block (${i}, ${j}, ${k})`;
    const zRange = `z ${z0}–${z1} mm`;
    return { title, zRange, status: block.status, statusLabel, detail, text: `${title} · ${zRange} · ${statusLabel} · ${detail}` };
}

// ---------- labels ----------

export type LabelTone = "neutral" | "ok" | "bad" | "accent";

/** Text pinned to a point of the scene; the stage turns it into HTML. `anchor` is in the frame the producer says. */
export interface SceneLabel {
    id: string;
    kind: "dimension" | "cog" | "tip" | "cut";
    anchor: Vec3;
    text: string;
    sub?: string;
    /** A quieter extra line under `sub`. */
    note?: string;
    tone: LabelTone;
}

const mmText = (value: number) => `${Math.round(value)} mm`;

/** Distance a dimension line sits off the cube. */
export function dimensionOffset(volume: Vec3): number {
    return Math.max(volume[0], volume[1], volume[2]) * 0.07;
}

/**
 * The COG label's verdict line, and a note when the marker is not where the whole design's mass would put it: the
 * engine takes the COG of the grounded blocks only, so floating blocks are left out of it.
 */
export function cogSummary(stability: Stability, floatingCount = 0): { sub: string; tone: LabelTone; note?: string } {
    const note = floatingCount > 0 ? `Grounded blocks only, ${floatingCount} floating left out` : undefined;
    if (stability.inside) return { sub: `Inside the base, ${mmText(stability.marginMm)} margin`, tone: "ok", note };
    return { sub: `Outside the base by ${mmText(-stability.marginMm)}: tips over`, tone: "bad", note };
}

/** The ground arrow of a COG outside its base: from the pivot, along the tip direction, past the ground point. */
export function tipArrow(stability: Stability, blockMm: number): { from: Vec2; to: Vec2; dir: Vec2 } | null {
    if (stability.inside || !stability.tipDirection) return null;
    const [dx, dy] = stability.tipDirection;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    const dir: Vec2 = [dx / len, dy / len];
    const from = stability.pivotMm;
    const gap = Math.hypot(stability.groundPointMm[0] - from[0], stability.groundPointMm[1] - from[1]);
    const length = Math.max(blockMm * 1.8, gap + blockMm * 1.1);
    return { from, to: [from[0] + dir[0] * length, from[1] + dir[1] * length], dir };
}

/** The labels that belong to the scene itself (not to a hovered block), in analysis mm. */
export function sceneLabels(analysis: AnalysisResult, view: { showCog: boolean; layerMax: number }): SceneLabel[] {
    const volume = volumeMm(analysis);
    const d = dimensionOffset(volume);
    const labels: SceneLabel[] = [
        { id: "dim-x", kind: "dimension", anchor: [volume[0] / 2, -d, 0], text: mmText(volume[0]), tone: "neutral" },
        { id: "dim-z", kind: "dimension", anchor: [volume[0] + d * 0.7, -d * 0.7, volume[2] / 2], text: mmText(volume[2]), tone: "neutral" },
    ];
    const block = analysis.settings.blockSizeMm;
    if (cutActive(analysis.blocks, view.layerMax)) {
        const z = (Math.max(-1, view.layerMax) + 1) * block;
        // Layers are numbered from 1 (the one on the ground), as in the report panel; the (i, j, k) of a block is the zero-based index.
        const shown = view.layerMax < 0 ? "No layers shown" : view.layerMax === 0 ? "Layer 1 only" : `Layers 1–${view.layerMax + 1}`;
        labels.push({ id: "cut", kind: "cut", anchor: [0, 0, z], text: shown, sub: `cut at z = ${mmText(z)}`, tone: "accent" });
    }
    const stability = analysis.stability;
    if (view.showCog && stability) {
        const summary = cogSummary(stability, countByStatus(analysis.blocks).floating);
        labels.push({ id: "cog", kind: "cog", anchor: stability.cogMm, text: "Centre of gravity", sub: summary.sub, note: summary.note, tone: summary.tone });
        const arrow = tipArrow(stability, block);
        if (arrow) labels.push({ id: "tip", kind: "tip", anchor: [arrow.to[0], arrow.to[1], block * 0.15], text: "Tips over this way", tone: "bad" });
    }
    return labels;
}

// ---------- flat geometry (mm, Z-up) ----------

const push = (out: number[], x: number, y: number, z: number) => out.push(x, y, z);

/** Consecutive repeats (and a closing repeat of the first) removed. */
function distinct(points: readonly Vec2[]): Vec2[] {
    const out: Vec2[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
    }
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length > 1 && Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-9) out.pop();
    return out;
}

export function polygonArea(points: readonly Vec2[]): number {
    let sum = 0;
    for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        sum += a[0] * b[1] - b[0] * a[1];
    }
    return sum / 2;
}

/** Longest a mitre may grow, in half-widths: a sharp corner is cut short rather than spiking out. */
const MITRE_LIMIT = 2.5;

/**
 * Triangles (9 floats each) of a closed outline drawn `halfWidth` to either side of the polygon's edges, at
 * height z, with mitred corners. A polygon of two points draws a bar; fewer than two draw nothing.
 */
export function ribbonTriangles(points: readonly Vec2[], halfWidth: number, z: number): Float32Array {
    const pts = distinct(points);
    const out: number[] = [];
    if (pts.length < 2 || !(halfWidth > 0)) return new Float32Array(0);
    if (pts.length === 2) {
        const [a, b] = pts;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const nx = (-(b[1] - a[1]) / len) * halfWidth;
        const ny = ((b[0] - a[0]) / len) * halfWidth;
        const q: Vec2[] = [
            [a[0] + nx, a[1] + ny],
            [a[0] - nx, a[1] - ny],
            [b[0] - nx, b[1] - ny],
            [b[0] + nx, b[1] + ny],
        ];
        for (const i of [0, 1, 2, 0, 2, 3]) push(out, q[i][0], q[i][1], z);
        return Float32Array.from(out);
    }
    const ring = polygonArea(pts) < 0 ? pts.slice().reverse() : pts; // counter-clockwise: the outside is on the right of each edge
    const n = ring.length;
    const normal = (a: Vec2, b: Vec2): Vec2 => {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
    };
    const inner: Vec2[] = [];
    const outer: Vec2[] = [];
    for (let i = 0; i < n; i += 1) {
        const n0 = normal(ring[(i + n - 1) % n], ring[i]);
        const n1 = normal(ring[i], ring[(i + 1) % n]);
        let mx = n0[0] + n1[0];
        let my = n0[1] + n1[1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-9) [mx, my] = n1;
        else [mx, my] = [mx / ml, my / ml];
        const cos = Math.max(mx * n1[0] + my * n1[1], 1 / MITRE_LIMIT);
        const reach = halfWidth / cos;
        inner.push([ring[i][0] - mx * reach, ring[i][1] - my * reach]);
        outer.push([ring[i][0] + mx * reach, ring[i][1] + my * reach]);
    }
    for (let i = 0; i < n; i += 1) {
        const j = (i + 1) % n;
        for (const p of [inner[i], outer[i], outer[j], inner[i], outer[j], inner[j]]) push(out, p[0], p[1], z);
    }
    return Float32Array.from(out);
}

/** A convex polygon as a triangle fan (9 floats per triangle), at height z. */
export function fanTriangles(points: readonly Vec2[], z: number): Float32Array {
    const pts = distinct(points);
    if (pts.length < 3) return new Float32Array(0);
    const out: number[] = [];
    for (let i = 1; i < pts.length - 1; i += 1) for (const p of [pts[0], pts[i], pts[i + 1]]) push(out, p[0], p[1], z);
    return Float32Array.from(out);
}

/** Squares of `size` mm for grid cells (i, j), as triangles at height z. */
export function cellTriangles(cells: readonly Vec2[], size: number, z: number, inset = 0): Float32Array {
    const out = new Float32Array(cells.length * 18);
    let o = 0;
    for (const [i, j] of cells) {
        const x0 = i * size + inset;
        const y0 = j * size + inset;
        const x1 = (i + 1) * size - inset;
        const y1 = (j + 1) * size - inset;
        for (const [x, y] of [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y0],
            [x1, y1],
            [x0, y1],
        ]) {
            out[o++] = x;
            out[o++] = y;
            out[o++] = z;
        }
    }
    return out;
}

/** Segment end points (6 floats each) of the 12 edges of an axis-aligned box. */
export function boxEdgeSegments(min: Vec3, max: Vec3): Float32Array {
    const c = (i: number): Vec3 => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const pairs: Array<[number, number]> = [
        [0, 1], [2, 3], [4, 5], [6, 7], // along x
        [0, 2], [1, 3], [4, 6], [5, 7], // along y
        [0, 4], [1, 5], [2, 6], [3, 7], // along z
    ];
    const out = new Float32Array(pairs.length * 6);
    pairs.forEach(([a, b], i) => out.set([...c(a), ...c(b)], i * 6));
    return out;
}

/** Outline segments (4 per cell, 6 floats each) round the top faces of grid cells (i, j) at height z. */
export function cellOutlineSegments(cells: readonly Vec2[], size: number, z: number): Float32Array {
    const out = new Float32Array(cells.length * 24);
    let o = 0;
    for (const [i, j] of cells) {
        const x0 = i * size;
        const y0 = j * size;
        const x1 = x0 + size;
        const y1 = y0 + size;
        for (const v of [x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z]) out[o++] = v;
    }
    return out;
}

// ---------- picking ----------

/**
 * Distance along a ray to an axis-aligned box (slab test): 0 when the origin is inside, null on a miss. The
 * direction need not be unit length.
 */
export function rayBox(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3): number | null {
    let near = 0;
    let far = Infinity;
    for (let a = 0; a < 3; a += 1) {
        const d = dir[a];
        if (Math.abs(d) < 1e-12) {
            if (origin[a] < min[a] || origin[a] > max[a]) return null;
            continue;
        }
        let t0 = (min[a] - origin[a]) / d;
        let t1 = (max[a] - origin[a]) / d;
        if (t0 > t1) [t0, t1] = [t1, t0];
        near = Math.max(near, t0);
        far = Math.min(far, t1);
        if (near > far) return null;
    }
    return near;
}

/**
 * The block a ray meets first, and how far along the ray. `mins` and `maxs` hold 3 floats per block (indexed by
 * block index); `candidates` are the blocks that can be hit (the shown ones). With a `preferred` set, a hit on one
 * of those wins over a nearer hit on another: while an issue is highlighted, the blocks it names stay reachable
 * behind dimmed ones.
 */
export function pickBlock(origin: Vec3, dir: Vec3, mins: ArrayLike<number>, maxs: ArrayLike<number>, candidates: ArrayLike<number>, preferred?: ReadonlySet<number> | null): { index: number; t: number } | null {
    let best = -1;
    let bestT = Infinity;
    let bestPreferred = -1;
    let bestPreferredT = Infinity;
    const min: Vec3 = [0, 0, 0];
    const max: Vec3 = [0, 0, 0];
    for (let n = 0; n < candidates.length; n += 1) {
        const i = candidates[n];
        min[0] = mins[i * 3];
        min[1] = mins[i * 3 + 1];
        min[2] = mins[i * 3 + 2];
        max[0] = maxs[i * 3];
        max[1] = maxs[i * 3 + 1];
        max[2] = maxs[i * 3 + 2];
        const t = rayBox(origin, dir, min, max);
        if (t === null) continue;
        if (t < bestT) [best, bestT] = [i, t];
        if (preferred && preferred.has(i) && t < bestPreferredT) [bestPreferred, bestPreferredT] = [i, t];
    }
    if (bestPreferred >= 0) return { index: bestPreferred, t: bestPreferredT };
    return best >= 0 ? { index: best, t: bestT } : null;
}

// ---------- focus ----------

/**
 * The box the camera frames for an issue: the point it names, with room round it, grown to hold the blocks
 * it highlights. In mm.
 */
export function focusBounds(focusMm: Vec3, highlighted: readonly Block[], blockMm: number): { min: Vec3; max: Vec3 } {
    const pad = blockMm * 1.6;
    const min: Vec3 = [focusMm[0] - pad, focusMm[1] - pad, focusMm[2] - pad];
    const max: Vec3 = [focusMm[0] + pad, focusMm[1] + pad, focusMm[2] + pad];
    const half = blockMm / 2;
    for (const b of highlighted) {
        for (let a = 0; a < 3; a += 1) {
            min[a] = Math.min(min[a], b.centerMm[a] - half);
            max[a] = Math.max(max[a], b.centerMm[a] + half);
        }
    }
    return { min, max };
}

/** Which blocks the layer cut leaves on screen. */
export function shownBlocks(blocks: readonly Block[], layerMax: number): number[] {
    const out: number[] = [];
    for (const b of blocks) if (b.cell[2] <= layerMax) out.push(b.index);
    return out;
}
