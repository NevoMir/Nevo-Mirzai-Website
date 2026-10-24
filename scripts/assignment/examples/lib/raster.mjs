// A small software renderer for the example covers (no GPU, no DOM, no dependencies): z-buffered, supersampled, lit
// like the viewer's stage (hemisphere + key + fill), on the light stage colour with the viewer's 10/50 mm ground grid
// and a soft contact shadow. PNG is encoded with node:zlib. Same input, same pixels: covers are checked by their pixels.
import zlib from "node:zlib";
import { NodeIO } from "@gltf-transform/core";

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lin2srgb = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexLin = (hex) => [1, 3, 5].map((i) => srgb2lin(parseInt(hex.slice(i, i + 2), 16) / 255));

/** The viewer's light stage (viewer/stage.ts: --background 97% grey, GRID_COLORS.light), a touch deeper toward the floor. */
export const STAGE = { top: "#f7f8fa", bottom: "#eceef2", minor: "#e0e3e8", major: "#c9cdd3" };

/** Any GLB (bytes) -> render triangles [{p, n, color (linear rgba), metal, rough, alpha}] in Y-up model space. */
export async function glbToTris(bytes) {
    const doc = await new NodeIO().readBinary(bytes);
    const tris = [];
    for (const scene of doc.getRoot().listScenes()) scene.traverse((node) => {
        const mesh = node.getMesh(); if (!mesh) return;
        const m = node.getWorldMatrix();
        const W = (p) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
        for (const prim of mesh.listPrimitives()) {
            const mat = prim.getMaterial();
            const color = mat ? mat.getBaseColorFactor() : [0.7, 0.7, 0.7, 1];
            const P = prim.getAttribute("POSITION").getArray(), N = prim.getAttribute("NORMAL")?.getArray();
            const I = prim.getIndices()?.getArray() ?? Array.from({ length: P.length / 3 }, (_, i) => i);
            for (let i = 0; i < I.length; i += 3) {
                const v = [0, 1, 2].map((k) => W([P[I[i+k]*3], P[I[i+k]*3+1], P[I[i+k]*3+2]]));
                let n;
                if (N) n = [0, 1, 2].map((k) => { const q = [N[I[i+k]*3], N[I[i+k]*3+1], N[I[i+k]*3+2]]; return [m[0]*q[0]+m[4]*q[1]+m[8]*q[2], m[1]*q[0]+m[5]*q[1]+m[9]*q[2], m[2]*q[0]+m[6]*q[1]+m[10]*q[2]]; });
                else { const e1 = sub(v[1], v[0]), e2 = sub(v[2], v[0]); const c = norm([e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]]); n = [c, c, c]; }
                tris.push({ p: v, n, color, metal: mat ? mat.getMetallicFactor() : 0, rough: mat ? mat.getRoughnessFactor() : 0.7, alpha: color[3] ?? 1 });
            }
        }
    });
    return tris;
}

/**
 * Renders triangles on the stage. Returns {width, height, rgb} (opaque, sRGB). yaw/pitch in degrees; the view is an
 * orthographic isometric-style one, auto-fitted. `ground` (default on) draws the viewer's grid and a contact shadow.
 */
export function render(tris, { width = 512, height = 384, yaw = 35, pitch = 20, ssaa = 3, margin = 0.1, ground = true, shadowStrength = 0.28 } = {}) {
    const W = width * ssaa, H = height * ssaa;
    const ya = (yaw * Math.PI) / 180, pa = (pitch * Math.PI) / 180;
    const cy = Math.cos(ya), sy = Math.sin(ya), cp = Math.cos(pa), sp = Math.sin(pa);
    const toView = (p) => { const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy; return [x1, p[1] * cp - z1 * sp, p[1] * sp + z1 * cp]; };
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (const p of t.p) {
        const v = toView(p);
        for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], v[k]); mx[k] = Math.max(mx[k], v[k]); lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    }
    const sx = mx[0] - mn[0], sy2 = mx[1] - mn[1];
    // Fit the model, not the grid: the grid is allowed to run out of the frame, as it does in the viewer.
    const scale = Math.min((W * (1 - 2 * margin)) / sx, (H * (1 - 2 * margin)) / sy2);
    const ox = W / 2 - ((mn[0] + mx[0]) / 2) * scale, oy = H / 2 + ((mn[1] + mx[1]) / 2) * scale + H * 0.015;
    const proj = (v) => [v[0] * scale + ox, -v[1] * scale + oy, v[2]];
    const pm = new Float32Array(W * H * 3); // premultiplied linear colour
    const al = new Float32Array(W * H);
    const zbuf = new Float32Array(W * H).fill(-Infinity);
    const light = norm([-0.45, 0.8, 0.55]);
    const fill = norm([0.6, 0.2, 0.5]);
    const hv = norm([light[0], light[1], light[2] + 1]);
    const draw = (t) => {
        const vp = t.p.map((p) => proj(toView(p)));
        const vn = t.n.map(toView);
        const [a, b, c] = vp;
        const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(den) < 1e-12) return;
        const translucent = (t.alpha ?? 1) < 1;
        for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
            const px = x + 0.5, py = y + 0.5;
            const l0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / den;
            const l1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / den;
            const l2 = 1 - l0 - l1;
            if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
            const z = l0 * a[2] + l1 * b[2] + l2 * c[2];
            const i = y * W + x;
            if (z <= zbuf[i]) continue;
            const n = norm([l0 * vn[0][0] + l1 * vn[1][0] + l2 * vn[2][0], l0 * vn[0][1] + l1 * vn[1][1] + l2 * vn[2][1], l0 * vn[0][2] + l1 * vn[1][2] + l2 * vn[2][2]]);
            const d1 = Math.max(0, dot(n, light)), d2 = Math.max(0, dot(n, fill));
            const hemi = 0.5 + 0.5 * n[1];
            const spec = Math.pow(Math.max(0, dot(n, hv)), 8 + (1 - t.rough) * 80) * (0.08 + 0.5 * t.metal) * (1 - t.rough * 0.7);
            const diffuseK = 1 - t.metal * 0.6;
            const al0 = translucent ? t.alpha : 1;
            for (let k = 0; k < 3; k++) {
                const base = t.color[k];
                const lit = base * diffuseK * (0.28 * hemi + 0.78 * d1 + 0.18 * d2) + spec * (t.metal ? base : 1) + t.metal * base * 0.18 * hemi;
                pm[i * 3 + k] = translucent ? lit * al0 + pm[i * 3 + k] * (1 - al0) : lit;
            }
            al[i] = translucent ? al0 + al[i] * (1 - al0) : 1;
            if (!translucent) zbuf[i] = z;
        }
    };
    for (const t of tris) if ((t.alpha ?? 1) >= 1) draw(t);
    for (const t of tris) if ((t.alpha ?? 1) < 1) draw(t);

    // ---- ground: the viewer's grid (10 mm minor, 50 mm major, the longest side of the model being 100 mm) and a contact shadow ----
    const floor = new Uint8Array(W * H); // 0 none, 1 minor line, 2 major line
    let shadow = null;
    if (ground) {
        const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        const u = longest / 100; // one viewer millimetre, in model units
        const footprint = Math.max(hi[0] - lo[0], hi[2] - lo[2]) / u;
        const size = Math.ceil((Math.max(footprint, 50) + 200) / 50) * 50;
        const gx = (lo[0] + hi[0]) / 2, gz = (lo[2] + hi[2]) / 2, gy = lo[1];
        const half = (size / 2) * u;
        const lw = ssaa * 0.55; // line radius in samples: ~1.1 output pixels thick
        const stamp = (x, y, v) => {
            const r = Math.ceil(lw);
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > lw * lw + 0.25) continue;
                const xx = Math.round(x) + dx, yy = Math.round(y) + dy;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                if (floor[yy * W + xx] < v) floor[yy * W + xx] = v;
            }
        };
        const line = (p, q, v) => {
            const a = proj(toView(p)), b = proj(toView(q));
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const steps = Math.max(1, Math.ceil(len * 2));
            for (let s = 0; s <= steps; s++) stamp(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps, v);
        };
        for (const major of [false, true]) {
            const stepUnits = major ? 50 : 10;
            for (let n = -size / 2; n <= size / 2 + 1e-9; n += stepUnits) {
                if (!major && n % 50 === 0) continue; // majors draw these
                line([gx + n * u, gy, gz - half], [gx + n * u, gy, gz + half], major ? 2 : 1);
                line([gx - half, gy, gz + n * u], [gx + half, gy, gz + n * u], major ? 2 : 1);
            }
        }
        const corners = [[lo[0], gy, lo[2]], [hi[0], gy, lo[2]], [hi[0], gy, hi[2]], [lo[0], gy, hi[2]]].map((p) => proj(toView(p)));
        const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
        shadow = {
            cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
            a: ((Math.max(...xs) - Math.min(...xs)) / 2) * 1.05 + 5 * ssaa, b: ((Math.max(...ys) - Math.min(...ys)) / 2) * 1.05 + 4 * ssaa,
        };
    }
    const top = hexLin(STAGE.top), bottom = hexLin(STAGE.bottom), minor = hexLin(STAGE.minor), major = hexLin(STAGE.major);
    const out = new Uint8Array(width * height * 3);
    const n2 = ssaa * ssaa;
    for (let y = 0; y < height; y++) {
        const t = y / (height - 1);
        const bg = [0, 1, 2].map((k) => top[k] + (bottom[k] - top[k]) * t);
        for (let x = 0; x < width; x++) {
            let r = 0, g = 0, b = 0, a = 0, s = 0, f1 = 0, f2 = 0;
            for (let dy = 0; dy < ssaa; dy++) for (let dx = 0; dx < ssaa; dx++) {
                const sx0 = x * ssaa + dx, sy0 = y * ssaa + dy;
                const i = sy0 * W + sx0;
                r += pm[i * 3]; g += pm[i * 3 + 1]; b += pm[i * 3 + 2]; a += al[i];
                if (floor[i] === 1) f1++; else if (floor[i] === 2) f2++;
                if (shadow) { const u = ((sx0 + 0.5 - shadow.cx) / shadow.a) ** 2 + ((sy0 + 0.5 - shadow.cy) / shadow.b) ** 2; if (u < 1) s += shadowStrength * Math.pow(1 - u, 1.4); }
            }
            r /= n2; g /= n2; b /= n2; a /= n2; s /= n2; f1 /= n2; f2 /= n2;
            // stage -> grid lines -> contact shadow (darkens what is under the model) -> model over it
            const base = [0, 1, 2].map((k) => {
                let c = bg[k];
                c = c * (1 - f1) + minor[k] * f1;
                c = c * (1 - f2) + major[k] * f2;
                return c * (1 - s);
            });
            const o = (y * width + x) * 3;
            out[o] = Math.round(255 * lin2srgb(r + base[0] * (1 - a)));
            out[o + 1] = Math.round(255 * lin2srgb(g + base[1] * (1 - a)));
            out[o + 2] = Math.round(255 * lin2srgb(b + base[2] * (1 - a)));
        }
    }
    return { width, height, rgb: out };
}

// ---------- PNG (8-bit RGB) ----------

const crcOf = (buf) => zlib.crc32(buf) >>> 0;
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcOf(td));
    return Buffer.concat([len, td, crc]);
};

/** Per row the PNG filter (none, sub, up, average, paeth) with the smallest sum of absolute values: about half the bytes of "none" on a render. */
export function encodePng({ width, height, rgb }) {
    const bpp = 3, row = width * bpp;
    const raw = Buffer.alloc((row + 1) * height);
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(row));
    for (let y = 0; y < height; y++) {
        const cur = rgb.subarray(y * row, (y + 1) * row);
        const up = y > 0 ? rgb.subarray((y - 1) * row, y * row) : new Uint8Array(row);
        for (let i = 0; i < row; i++) {
            const left = i >= bpp ? cur[i - bpp] : 0, upLeft = i >= bpp ? up[i - bpp] : 0;
            cand[0][i] = cur[i];
            cand[1][i] = (cur[i] - left) & 255;
            cand[2][i] = (cur[i] - up[i]) & 255;
            cand[3][i] = (cur[i] - ((left + up[i]) >> 1)) & 255;
            cand[4][i] = (cur[i] - paeth(left, up[i], upLeft)) & 255;
        }
        let best = 0, bestSum = Infinity;
        for (let f = 0; f < 5; f++) { let sum = 0; for (let i = 0; i < row; i++) { const v = cand[f][i]; sum += v < 128 ? v : 256 - v; } if (sum < bestSum) { bestSum = sum; best = f; } }
        raw[y * (row + 1)] = best;
        raw.set(cand[best], y * (row + 1) + 1);
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
    return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

/** Decodes a PNG made by encodePng (8-bit RGB, one or more IDAT chunks) to {width, height, rgb}; null for anything else. */
export function decodePng(bytes) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let at = 8, width = 0, height = 0;
    const idat = [];
    while (at + 12 <= buf.length) {
        const len = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8);
        const data = buf.subarray(at + 8, at + 8 + len);
        if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) return null; }
        else if (type === "IDAT") idat.push(data);
        at += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 3, row = width * bpp;
    const rgb = new Uint8Array(row * height);
    const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
    for (let y = 0; y < height; y++) {
        const f = raw[y * (row + 1)];
        for (let i = 0; i < row; i++) {
            const x = raw[y * (row + 1) + 1 + i];
            const left = i >= bpp ? rgb[y * row + i - bpp] : 0, up = y > 0 ? rgb[(y - 1) * row + i] : 0, upLeft = y > 0 && i >= bpp ? rgb[(y - 1) * row + i - bpp] : 0;
            rgb[y * row + i] = (x + (f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, upLeft))) & 255;
        }
    }
    return { width, height, rgb };
}
