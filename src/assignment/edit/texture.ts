// The texture side of the editor: sampling vertex colours for the pictures, and the recolor op (a luminance-preserving tint of the picture,
// whole or through a mask drawn in UV space). The pixels are decoded and encoded by a TextureCodec (the browser's canvas; a test brings its
// own), so everything else here is plain typed-array code that Node runs too.

import type { UvTransform } from "./readMeshGlb.ts";
import { imageUv } from "./readMeshGlb.ts";
import type { Paint } from "./types.ts";
import { MAX_EDITED_IMAGE_SIDE } from "./uploadRules.ts";

/** An RGB image, 3 bytes per pixel, row by row from the top. */
export interface RawImage {
    w: number;
    h: number;
    data: Uint8Array;
}

export interface TextureCodec {
    /** Decodes a PNG or JPEG, downscaled so the longer side is at most `maxSide`. null when it cannot. */
    decode(bytes: Uint8Array, mime: string, maxSide: number): Promise<RawImage | null>;
    /** Encodes as JPEG (quality 0..1). null when it cannot. */
    encodeJpeg(image: RawImage, quality: number): Promise<Uint8Array | null>;
}

/** The longer side of the working picture: a 4096 px picture is 12 MB as PNG and 48 MB of pixels. */
export const TEXTURE_SIDE = 2048;
export const TEXTURE_JPEG_QUALITY = 0.9;

/** The browser's codec (OffscreenCanvas + createImageBitmap, which also work in a worker), or null where they are missing (iOS before 16.4). */
export function browserCodec(): TextureCodec | null {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return null;
    return {
        async decode(bytes, mime, maxSide) {
            try {
                const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
                const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
                const w = Math.max(1, Math.round(bitmap.width * k));
                const h = Math.max(1, Math.round(bitmap.height * k));
                const canvas = new OffscreenCanvas(w, h);
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) {
                    bitmap.close();
                    return null;
                }
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(bitmap, 0, 0, w, h);
                bitmap.close();
                const rgba = ctx.getImageData(0, 0, w, h).data;
                const data = new Uint8Array(w * h * 3);
                for (let i = 0; i < w * h; i++) {
                    data[i * 3] = rgba[i * 4];
                    data[i * 3 + 1] = rgba[i * 4 + 1];
                    data[i * 3 + 2] = rgba[i * 4 + 2];
                }
                return { w, h, data };
            } catch {
                return null;
            }
        },
        async encodeJpeg(image, quality) {
            try {
                const canvas = new OffscreenCanvas(image.w, image.h);
                const ctx = canvas.getContext("2d");
                if (!ctx) return null;
                const out = ctx.createImageData(image.w, image.h);
                for (let i = 0; i < image.w * image.h; i++) {
                    out.data[i * 4] = image.data[i * 3];
                    out.data[i * 4 + 1] = image.data[i * 3 + 1];
                    out.data[i * 4 + 2] = image.data[i * 3 + 2];
                    out.data[i * 4 + 3] = 255;
                }
                ctx.putImageData(out, 0, 0);
                const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
                return new Uint8Array(await blob.arrayBuffer());
            } catch {
                return null;
            }
        },
    };
}

const wrap = (x: number): number => ((x % 1) + 1) % 1;

/** The colour of the picture under every vertex (nearest pixel). Vertices of a model without texture coordinates get mid grey. */
export function sampleVertexColors(uv: Float32Array, image: RawImage, transform: UvTransform | null): Uint8Array {
    const n = uv.length / 2;
    const out = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
        const [u, v] = imageUv(uv[i * 2], uv[i * 2 + 1], transform);
        const x = Math.min(image.w - 1, Math.floor(wrap(u) * image.w));
        const y = Math.min(image.h - 1, Math.floor(wrap(v) * image.h));
        const o = (y * image.w + x) * 3;
        out[i * 3] = image.data[o];
        out[i * 3 + 1] = image.data[o + 1];
        out[i * 3 + 2] = image.data[o + 2];
    }
    return out;
}

/** Rasterises the UV triangles weighted per vertex into a mask of w x h (0..255). */
export function uvMask(uv: Float32Array, idx: Uint32Array, weights: Float32Array, w: number, h: number, transform: UvTransform | null = null): Uint8Array {
    const mask = new Uint8Array(w * h);
    const nt = idx.length / 3;
    const px = new Float64Array(3);
    const py = new Float64Array(3);
    for (let t = 0; t < nt; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        const wa = weights[a], wb = weights[b], wc = weights[c];
        if (wa + wb + wc <= 0) continue;
        const tri = [a, b, c];
        for (let k = 0; k < 3; k++) {
            const [u, v] = imageUv(uv[tri[k] * 2], uv[tri[k] * 2 + 1], transform);
            px[k] = u * w;
            py[k] = v * h;
        }
        const minx = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2]))), maxx = Math.min(w - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
        const miny = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2]))), maxy = Math.min(h - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
        const den = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2]);
        if (Math.abs(den) < 1e-12) continue;
        for (let y = miny; y <= maxy; y++) {
            for (let x = minx; x <= maxx; x++) {
                const l0 = ((py[1] - py[2]) * (x + 0.5 - px[2]) + (px[2] - px[1]) * (y + 0.5 - py[2])) / den;
                const l1 = ((py[2] - py[0]) * (x + 0.5 - px[2]) + (px[0] - px[2]) * (y + 0.5 - py[2])) / den;
                const l2 = 1 - l0 - l1;
                if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
                const value = Math.round(255 * (l0 * wa + l1 * wb + l2 * wc));
                const o = y * w + x;
                if (value > mask[o]) mask[o] = value;
            }
        }
    }
    return mask;
}

/** The most pixels a picture may have on a side in an edited model (uploadRules.ts, the same number the server checks). */
const MAX_PICTURE_SIDE = MAX_EDITED_IMAGE_SIDE;
const UV_SLACK = 0.001;

/**
 * The triangles a mirror_copy makes use the texture coordinates of the part they copy, so a colour painted on the copy would also land on
 * the original (and the other way round). This gives the copies a picture of their own: the model's picture is stacked on a second copy
 * of itself (twice as tall), the original triangles keep looking at the upper one and the copies (`page` = 1) at the lower one. Returns
 * the stacked picture and the new coordinates, or why it cannot be done (a picture that is transformed or tiled, or already too tall).
 */
export function stackCopyPicture(image: RawImage, uv: Float32Array, page: Uint8Array, transform: UvTransform | null): { image: RawImage; uv: Float32Array } | { reason: string } {
    if (transform) return { reason: "the picture is offset or scaled in the file" };
    if (image.h * 2 > MAX_PICTURE_SIDE) return { reason: "the picture is too tall to double" };
    const n = uv.length / 2;
    for (let i = 0; i < uv.length; i++) {
        if (!(uv[i] >= -UV_SLACK && uv[i] <= 1 + UV_SLACK)) return { reason: "the picture is tiled" };
    }
    const data = new Uint8Array(image.data.length * 2);
    data.set(image.data, 0);
    data.set(image.data, image.data.length);
    const out = Float32Array.from(uv);
    for (let i = 0; i < n; i++) {
        const v = Math.min(1, Math.max(0, uv[i * 2 + 1]));
        out[i * 2 + 1] = ((page[i] ? 1 : 0) + v) / 2;
    }
    return { image: { w: image.w, h: image.h * 2, data }, uv: out };
}

const hexToRgb = (hex: string): [number, number, number] => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * Tints the picture in place. Each pixel moves toward the target colour by mask * strength, keeping its own shading: the target is scaled
 * by the pixel's luminance over the mean luminance of the area being painted, so wood grain survives and a dark and a light wood both land
 * on the target on average.
 */
export function tintImage(image: RawImage, paints: readonly Paint[], uv: Float32Array, idx: Uint32Array, transform: UvTransform | null): void {
    const { w, h, data } = image;
    for (const paint of paints) {
        const [tr, tg, tb] = hexToRgb(paint.color);
        const mask = paint.weights ? uvMask(uv, idx, paint.weights, w, h, transform) : null;
        let sum = 0;
        let count = 0;
        for (let i = 0; i < w * h; i += 7) {
            if (mask && mask[i] < 128) continue;
            sum += 0.3 * data[i * 3] + 0.59 * data[i * 3 + 1] + 0.11 * data[i * 3 + 2];
            count++;
        }
        const ref = Math.max(1, sum / Math.max(1, count));
        for (let i = 0; i < w * h; i++) {
            const m = (mask ? mask[i] / 255 : 1) * paint.strength;
            if (m <= 0) continue;
            const lum = 0.3 * data[i * 3] + 0.59 * data[i * 3 + 1] + 0.11 * data[i * 3 + 2];
            const k = Math.min(2.2, Math.max(0.15, lum / ref));
            data[i * 3] += (Math.min(255, tr * k) - data[i * 3]) * m;
            data[i * 3 + 1] += (Math.min(255, tg * k) - data[i * 3 + 1]) * m;
            data[i * 3 + 2] += (Math.min(255, tb * k) - data[i * 3 + 2]) * m;
        }
    }
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export interface PaintOutcome {
    /** The recolored picture (JPEG), when the texture was repainted. */
    image?: { bytes: Uint8Array; mime: string };
    /** The new base colour factor, when the picture could not be repainted and the whole model was tinted through the material instead. */
    baseColorFactor?: [number, number, number, number];
    /** Plain-words notes for the card ("region colour needs a newer browser; skipped"). */
    notes: string[];
}

/**
 * Applies the recolors of a program. With a codec and a picture: decode (<= TEXTURE_SIDE), tint, JPEG. Without: a whole-model recolor
 * multiplies the material's colour by the target (an approximation), a region recolor is skipped and said so.
 */
export async function applyPaints(
    codec: TextureCodec | null,
    texture: { bytes: Uint8Array; mime: string; transform: UvTransform | null } | null,
    image: RawImage | null,
    uv: Float32Array,
    idx: Uint32Array,
    paints: readonly Paint[],
    baseColor: readonly [number, number, number, number],
): Promise<PaintOutcome> {
    const notes: string[] = [];
    if (paints.length === 0) return { notes };
    if (codec && texture && image) {
        const work: RawImage = { w: image.w, h: image.h, data: Uint8Array.from(image.data) };
        tintImage(work, paints, uv, idx, texture.transform);
        const jpeg = await codec.encodeJpeg(work, TEXTURE_JPEG_QUALITY);
        if (jpeg) return { image: { bytes: jpeg, mime: "image/jpeg" }, notes };
        notes.push("the colour was applied without repainting the picture");
    }
    const whole = paints.filter((p) => p.weights === null);
    const regions = paints.length - whole.length;
    if (regions > 0) notes.push(`painting one part needs a newer browser; ${regions === 1 ? "that colour was" : "those colours were"} skipped`);
    if (whole.length === 0) return { notes };
    // Multiply the material's colour by the last whole-model colour: an approximation of the tint, close enough for a flat colour change.
    const last = whole[whole.length - 1];
    const [r, g, b] = hexToRgb(last.color);
    const s = last.strength;
    const mix = (target: number, old: number): number => old * (1 - s) + srgbToLinear(target / 255) * s;
    notes.push("the colour is an approximation in this browser");
    return { baseColorFactor: [mix(r, baseColor[0]), mix(g, baseColor[1]), mix(b, baseColor[2]), baseColor[3]], notes };
}
