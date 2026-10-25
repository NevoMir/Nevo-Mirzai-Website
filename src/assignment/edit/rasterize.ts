// A software rasteriser for the pictures the model reads: flat-shaded orthographic views of triangle meshes with a labelled grid. No WebGL
// and no canvas, so it runs the same in a worker and in Node (about 0.1 s per view for 500k triangles). Coordinates are the edit frame (mm,
// Z up). The grid is drawn over the picture (the lines stay visible through the object), with the 5x7 pixel font of font.ts.

import { GLYPH_ADVANCE, GLYPH_H, GLYPH_W, glyphRows } from "./font.ts";
import type { Vec3 } from "./types.ts";

/** A mesh to draw: positions in mm, triangles, one sRGB colour per vertex (3 bytes each). */
export interface Layer {
    Q: Float32Array;
    idx: Uint32Array;
    colors: Uint8Array;
}

export interface ViewSpec {
    id: string;
    /** Degrees: 0 looks from -Y toward +Y (so +X is on the right), 90 looks from +X (so +Y is on the right). */
    az: number;
    /** Degrees above the horizon (90 = from the top, +X right, +Y up the picture). */
    el: number;
    /** The world axes shown horizontally and vertically (0 = x, 1 = y, 2 = z). */
    h: 0 | 1 | 2;
    v: 0 | 1 | 2;
    caption: string;
}

/** The three pictures of a mesh. The captions are what the model is told about each (spec 5.2). */
export const VIEWS: readonly ViewSpec[] = [
    { id: "FRONT", az: 0, el: 0, h: 0, v: 2, caption: "FRONT view: the object faces you. Picture right = +X (the object's LEFT). Vertical = Z (height)." },
    { id: "SIDE", az: 90, el: 0, h: 1, v: 2, caption: "SIDE view from +X: the object faces LEFT. Picture right = +Y (the object's back). Vertical = Z." },
    { id: "TOP", az: 0, el: 90, h: 0, v: 1, caption: "TOP view: the object faces the BOTTOM of the picture. Picture right = +X, picture up = +Y (the object's back)." },
];

export const AXIS_NAMES = ["x", "y", "z"] as const;

export interface Picture {
    W: number;
    H: number;
    /** RGB, 3 bytes per pixel, row by row from the top. */
    rgb: Uint8Array;
    /** World point (mm) -> pixel. */
    project: (p: Vec3) => [number, number];
}

export interface RasterOptions {
    size: number;
    /** The box (mm) the picture frames. */
    fit: { min: Vec3; max: Vec3 };
    bg?: [number, number, number];
    light?: number;
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function rasterize(layers: readonly Layer[], view: Pick<ViewSpec, "az" | "el">, options: RasterOptions): Picture {
    const { size, fit } = options;
    const bg = options.bg ?? [255, 255, 255];
    const light = options.light ?? 0.75;
    const a = (view.az * Math.PI) / 180;
    const e = (view.el * Math.PI) / 180;
    const toCam = [Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)];
    const fwd = toCam.map((v) => -v);
    const right = [Math.cos(a), Math.sin(a), 0];
    let up = cross(right, fwd);
    if (up[2] < 0 || (Math.abs(up[2]) < 1e-9 && dot(up, [0, 1, 0]) < 0)) up = up.map((v) => -v);
    if (Math.abs(up[2]) < 1e-6 && view.el >= 89.9) up = [-Math.sin(a), Math.cos(a), 0];
    const centre = [0, 1, 2].map((i) => (fit.min[i] + fit.max[i]) / 2);
    const proj = (x: number, y: number, z: number): [number, number, number] => {
        const dx = x - centre[0], dy = y - centre[1], dz = z - centre[2];
        return [dx * right[0] + dy * right[1] + dz * right[2], dx * up[0] + dy * up[1] + dz * up[2], dx * fwd[0] + dy * fwd[1] + dz * fwd[2]];
    };
    let ext = 1e-6;
    for (const x of [fit.min[0], fit.max[0]]) for (const y of [fit.min[1], fit.max[1]]) for (const z of [fit.min[2], fit.max[2]]) {
        const q = proj(x, y, z);
        ext = Math.max(ext, Math.abs(q[0]), Math.abs(q[1]));
    }
    const scale = (size * 0.46) / ext;
    const W = size, H = size;
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
    const zb = new Float32Array(W * H).fill(Infinity);

    for (const layer of layers) {
        const n = layer.Q.length / 3;
        const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
        for (let v = 0; v < n; v++) {
            const q = proj(layer.Q[v * 3], layer.Q[v * 3 + 1], layer.Q[v * 3 + 2]);
            sx[v] = W / 2 + q[0] * scale;
            sy[v] = H / 2 - q[1] * scale;
            sz[v] = q[2];
        }
        const idx = layer.idx;
        const nt = idx.length / 3;
        for (let t = 0; t < nt; t++) {
            const i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
            const x0 = sx[i0], x1 = sx[i1], x2 = sx[i2], y0 = sy[i0], y1 = sy[i1], y2 = sy[i2];
            const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
            const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
            if (minx > maxx || miny > maxy) continue;
            const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
            if (Math.abs(den) < 1e-9) continue;
            // The face normal's component along the view direction is the area of the projected triangle (screen) over the area in 3D;
            // shading wants the cosine, so take the 3D normal from the vertices' depth: n_z = twice the signed screen area / scale^2.
            const ax = x1 - x0, ay = y1 - y0, bx = x2 - x0, by = y2 - y0;
            const z0 = sz[i0], z1 = sz[i1], z2 = sz[i2];
            // 3D edge vectors in view space: (dx/scale, -dy/scale, dz)
            const ux = ax / scale, uy = -ay / scale, uz = z1 - z0;
            const vx = bx / scale, vy = -by / scale, vz = z2 - z0;
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const nl = Math.hypot(nx, ny, nz) || 1;
            const shade = 0.35 + light * Math.abs(nz / nl);
            const r = (layer.colors[i0 * 3] + layer.colors[i1 * 3] + layer.colors[i2 * 3]) / 3 * shade;
            const g = (layer.colors[i0 * 3 + 1] + layer.colors[i1 * 3 + 1] + layer.colors[i2 * 3 + 1]) / 3 * shade;
            const b = (layer.colors[i0 * 3 + 2] + layer.colors[i1 * 3 + 2] + layer.colors[i2 * 3 + 2]) / 3 * shade;
            const R = r > 255 ? 255 : r, G = g > 255 ? 255 : g, B = b > 255 ? 255 : b;
            for (let y = miny; y <= maxy; y++) {
                const py = y + 0.5;
                for (let x = minx; x <= maxx; x++) {
                    const px = x + 0.5;
                    const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
                    const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
                    const l2 = 1 - l0 - l1;
                    if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
                    const z = l0 * z0 + l1 * z1 + l2 * z2;
                    const at = y * W + x;
                    if (z >= zb[at]) continue;
                    zb[at] = z;
                    rgb[at * 3] = R;
                    rgb[at * 3 + 1] = G;
                    rgb[at * 3 + 2] = B;
                }
            }
        }
    }
    return {
        W,
        H,
        rgb,
        project: (p) => {
            const q = proj(p[0], p[1], p[2]);
            return [W / 2 + q[0] * scale, H / 2 - q[1] * scale];
        },
    };
}

// ---------- drawing on a picture ----------

function blendPixel(rgb: Uint8Array, W: number, H: number, x: number, y: number, c: readonly number[], alpha: number): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const at = (y * W + x) * 3;
    rgb[at] = Math.round(rgb[at] * (1 - alpha) + c[0] * alpha);
    rgb[at + 1] = Math.round(rgb[at + 1] * (1 - alpha) + c[1] * alpha);
    rgb[at + 2] = Math.round(rgb[at + 2] * (1 - alpha) + c[2] * alpha);
}

/** Text in the pixel font at (x, y) = its top-left corner; a white halo keeps it readable over the object. Returns the width drawn. */
export function drawText(pic: Pick<Picture, "rgb" | "W" | "H">, x: number, y: number, text: string, color: readonly number[] = [30, 64, 175], scale = 1): number {
    const { rgb, W, H } = pic;
    const ink: Array<[number, number]> = [];
    let cx = x;
    for (const ch of text) {
        const rows = glyphRows(ch);
        if (rows) for (let r = 0; r < GLYPH_H; r++) for (let c = 0; c < GLYPH_W; c++) if (rows[r][c] === "#") ink.push([cx + c * scale, y + r * scale]);
        cx += GLYPH_ADVANCE * scale;
    }
    // The halo first (a white margin around every ink pixel), then the ink.
    for (const [px, py] of ink) for (let hy = -1; hy <= scale; hy++) for (let hx = -1; hx <= scale; hx++) blendPixel(rgb, W, H, px + hx, py + hy, [255, 255, 255], 0.9);
    for (const [px, py] of ink) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) blendPixel(rgb, W, H, px + dx, py + dy, color, 1);
    return text.length * GLYPH_ADVANCE * scale;
}

export interface GridOptions {
    /** Spacing of the grid lines, mm. */
    step: number;
    /** A stronger line (and the label) every `major` mm; a multiple of step. */
    major: number;
    /** Label every `labelEvery` mm; a multiple of step. */
    labelEvery: number;
    /** The box (mm) the lines span. */
    fit: { min: Vec3; max: Vec3 };
}

/** The grid of a view: lines at every `step` mm of the two axes it shows, blue axis lines at 0, labels like "x-300" and "z200". */
export function drawGrid(pic: Picture, view: Pick<ViewSpec, "h" | "v">, grid: GridOptions): void {
    const { rgb, W, H } = pic;
    const { fit, step, major, labelEvery } = grid;
    const line = (horizontal: boolean, at: number, strong: boolean, axisLine: boolean): void => {
        const color = axisLine ? [37, 99, 235] : [100, 116, 139];
        const alpha = axisLine ? 0.8 : strong ? 0.55 : 0.32;
        const p = Math.round(at);
        if (horizontal) for (let x = 0; x < W; x++) blendPixel(rgb, W, H, x, p, color, alpha);
        else for (let y = 0; y < H; y++) blendPixel(rgb, W, H, p, y, color, alpha);
    };
    const lo = [fit.min[view.h], fit.min[view.v]];
    const hi = [fit.max[view.h], fit.max[view.v]];
    const firstH = Math.ceil(lo[0] / step) * step;
    const firstV = Math.ceil(lo[1] / step) * step;
    const at = (hv: number, vv: number): [number, number] => {
        const p: Vec3 = [0, 0, 0];
        p[view.h] = hv;
        p[view.v] = vv;
        return pic.project(p);
    };
    const labels: Array<() => void> = [];
    let lastLabelX = -1e9;
    for (let hv = firstH; hv <= hi[0] + 1e-6; hv += step) {
        const x = at(hv, lo[1])[0];
        const isAxis = Math.abs(hv) < 1e-6;
        line(false, x, Math.abs(hv % major) < 1e-6, isAxis);
        if (Math.abs(hv % labelEvery) < 1e-6 || isAxis) {
            const text = `${AXIS_NAMES[view.h]}${Math.round(hv)}`;
            if (x - lastLabelX >= text.length * GLYPH_ADVANCE + 2) {
                lastLabelX = x;
                labels.push(() => drawText(pic, Math.round(x) + 2, 3, text));
            }
        }
    }
    let lastLabelY = 1e9;
    for (let vv = firstV; vv <= hi[1] + 1e-6; vv += step) {
        const y = at(lo[0], vv)[1];
        const isAxis = Math.abs(vv) < 1e-6;
        line(true, y, Math.abs(vv % major) < 1e-6, isAxis);
        if (Math.abs(vv % labelEvery) < 1e-6 || isAxis) {
            if (lastLabelY - y >= GLYPH_H + 3) {
                lastLabelY = y;
                const text = `${AXIS_NAMES[view.v]}${Math.round(vv)}`;
                labels.push(() => drawText(pic, 2, Math.round(y) - GLYPH_H - 2, text));
            }
        }
    }
    for (const draw of labels) draw();
}

/** Per-vertex colours with the selection tinted red: weight 1 is `alpha` of the way to red (the second pass shows the model its own selection). */
export function tintSelected(colors: Uint8Array, weights: Float32Array, alpha = 0.6): Uint8Array {
    const out = Uint8Array.from(colors);
    for (let v = 0; v < weights.length; v++) {
        const a = weights[v] * alpha;
        if (a <= 0) continue;
        out[v * 3] = Math.round(colors[v * 3] * (1 - a) + 255 * a);
        out[v * 3 + 1] = Math.round(colors[v * 3 + 1] * (1 - a));
        out[v * 3 + 2] = Math.round(colors[v * 3 + 2] * (1 - a));
    }
    return out;
}
