// What the model gets to see of a mesh: three labelled pictures (FRONT, SIDE, TOP) with a 100 mm grid and a line of facts, packed as a
// MeshPackage for POST /models/:id/edits. And, for the second pass (MESH_REFINE_OPS), three zoomed pictures of the region a first program
// selects, with the selection tinted red.

import type { MeshPackage, MeshView } from "../shared/contract.ts";
import { factsText, toExecutorOp, type MeshProgram } from "../shared/meshProgram.ts";
import type { EditSetup } from "./frame.ts";
import { canEncodePng, encodeJpegFromRgb, encodePng, toDataUrl } from "./png.ts";
import { VIEWS, drawGrid, drawText, rasterize, tintSelected, type Layer, type Picture, type ViewSpec } from "./rasterize.ts";
import type { MeshSource } from "./readMeshGlb.ts";
import { selectionWeights } from "./selection.ts";
import { sampleVertexColors, type RawImage } from "./texture.ts";
import { MeshEditError, type Vec3 } from "./types.ts";

export type PictureFormat = "png" | "jpeg";

/** Pixels per side of a picture the model reads. */
export const PICTURE_SIZE = 512;
export const ZOOM_PICTURE_SIZE = 640;
const JPEG_QUALITY = 0.8;
/** How far around the first selection the zoomed pictures reach, mm. */
export const ZOOM_MARGIN_MM = 70;

const linearToSrgb = (c: number): number => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

export interface DescribeInput {
    setup: EditSetup;
    source: MeshSource;
    /** The decoded picture of the model, when the browser could decode it (else the pictures are flat-coloured). */
    image: RawImage | null;
    originalPrompt: string | null;
    format?: PictureFormat;
    size?: number;
}

/** The colour of every vertex of the mesh as the pictures draw it. */
export function vertexColorsOf(input: Pick<DescribeInput, "setup" | "source" | "image">): Uint8Array {
    const { setup, source, image } = input;
    const n = setup.mesh.Q.length / 3;
    if (image && source.texture && setup.hasUv) return sampleVertexColors(setup.mesh.uv, image, source.texture.transform);
    const out = new Uint8Array(n * 3);
    const base = [linearToSrgb(source.baseColor[0]), linearToSrgb(source.baseColor[1]), linearToSrgb(source.baseColor[2])];
    for (let i = 0; i < n; i++) { out[i * 3] = base[0]; out[i * 3 + 1] = base[1]; out[i * 3 + 2] = base[2]; }
    return out;
}

function layersOf(input: Pick<DescribeInput, "setup" | "source" | "image">, colors: Uint8Array): Layer[] {
    const layers: Layer[] = [{ Q: input.setup.mesh.Q, idx: input.setup.mesh.idx, colors }];
    for (const piece of input.setup.pieces) {
        const c = new Uint8Array((piece.Q.length / 3) * 3);
        for (let i = 0; i < c.length; i += 3) { c[i] = piece.color[0]; c[i + 1] = piece.color[1]; c[i + 2] = piece.color[2]; }
        layers.push({ Q: piece.Q, idx: piece.idx, colors: c });
    }
    return layers;
}

/** Plain words for the main colours of the model ("brown 48%, orange 21%"): 3-bit-per-channel bins named by hue, saturation and lightness. */
export function mainColorNames(colors: Uint8Array): string[] {
    const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
    const total = colors.length / 3;
    const step = Math.max(1, Math.floor(total / 20_000));
    let seen = 0;
    for (let i = 0; i < total; i += step) {
        const r = colors[i * 3], g = colors[i * 3 + 1], b = colors[i * 3 + 2];
        const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bin.n++; bin.r += r; bin.g += g; bin.b += b;
        bins.set(key, bin);
        seen++;
    }
    const names = new Map<string, number>();
    for (const bin of bins.values()) {
        const name = colorName(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n);
        names.set(name, (names.get(name) ?? 0) + bin.n);
    }
    return [...names.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([, n]) => n / seen >= 0.08)
        .slice(0, 3)
        .map(([name, n]) => `${name} ${Math.round((100 * n) / seen)}%`);
}

function colorName(r: number, g: number, b: number): string {
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (l < 0.12) return "black";
    if (l > 0.9) return "white";
    if (s < 0.14) return l < 0.35 ? "dark grey" : l > 0.7 ? "light grey" : "grey";
    let h: number;
    const R = r / 255, G = g / 255, B = b / 255;
    if (max === R) h = ((G - B) / d + 6) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 15 || h >= 345) return l > 0.6 ? "pink" : "red";
    if (h < 40) return l < 0.45 ? "brown" : s < 0.5 && l > 0.6 ? "tan" : "orange";
    if (h < 65) return l < 0.4 ? "olive" : "yellow";
    if (h < 160) return "green";
    if (h < 200) return "teal";
    if (h < 260) return "blue";
    if (h < 300) return "purple";
    return "pink";
}

async function encodePicture(pic: Picture, format: PictureFormat): Promise<{ bytes: Uint8Array; mime: string }> {
    if (format === "jpeg") {
        const jpeg = await encodeJpegFromRgb(pic.rgb, pic.W, pic.H, JPEG_QUALITY);
        if (jpeg) return { bytes: jpeg, mime: "image/jpeg" };
    }
    if (!canEncodePng()) throw new MeshEditError("unsupported", "Editing a model by words needs a newer browser.");
    return { bytes: await encodePng(pic.rgb, pic.W, pic.H), mime: "image/png" };
}

/** What an earlier edit added, in words the model can use ("cup holder cup: x -275..-185, y -195..-105, z 550..620 mm"), or null. */
function extrasText(setup: EditSetup): string | null {
    if (setup.pieces.length === 0) return null;
    const r = (v: number) => Math.round(v);
    const lines = setup.pieces.slice(0, 12).map((p) => `${p.name}: x ${r(p.min[0])}..${r(p.max[0])}, y ${r(p.min[1])}..${r(p.max[1])}, z ${r(p.min[2])}..${r(p.max[2])} mm`);
    return `Parts added by an earlier edit (they stay as they are): ${lines.join("; ")}.`;
}

/** The package that goes with the instruction: facts, three pictures, notes. */
export async function describeMesh(input: DescribeInput): Promise<MeshPackage> {
    const { setup } = input;
    const size = input.size ?? PICTURE_SIZE;
    const format = input.format ?? "png";
    const colors = vertexColorsOf(input);
    const layers = layersOf(input, colors);
    const [sx, sy, sz] = setup.frame.sizeMm;
    const fit = { min: [-sx / 2, -sy / 2, 0] as Vec3, max: [sx / 2, sy / 2, sz] as Vec3 };
    const views: MeshView[] = [];
    for (const view of VIEWS) {
        const pic = rasterize(layers, view, { size, fit });
        drawGrid(pic, view, { step: 100, major: 100, labelEvery: 100, fit });
        drawText(pic, 6, size - 18, view.id, [15, 23, 42], 2);
        const encoded = await encodePicture(pic, format);
        views.push({ id: view.id, caption: view.caption, image: toDataUrl(encoded.bytes, encoded.mime) });
    }
    const facts = factsText({
        sizeMm: setup.frame.sizeMm,
        tris: setup.mesh.idx.length / 3,
        textured: input.source.texture !== null,
        colors: mainColorNames(colors),
    });
    return {
        version: 1,
        frame: { size_mm: [Math.round(sx), Math.round(sy), Math.round(sz)], facing: "-Y" },
        facts,
        views,
        pieces: null,
        extras: extrasText(setup),
        original_prompt: input.originalPrompt ? input.originalPrompt.slice(0, 600) : null,
    };
}

/** The box of the first program's selections, grown by ZOOM_MARGIN_MM and kept on the ground; null when no op selects a place. */
export function zoomBox(program: Pick<MeshProgram, "ops">): { min: Vec3; max: Vec3 } | null {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const op of program.ops) {
        for (const b of op.boxes) {
            any = true;
            for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], b.min[a]); max[a] = Math.max(max[a], b.max[a]); }
        }
    }
    if (!any) return null;
    const lo = min.map((v) => v - ZOOM_MARGIN_MM) as Vec3;
    const hi = max.map((v) => v + ZOOM_MARGIN_MM) as Vec3;
    lo[2] = Math.max(0, lo[2]);
    return { min: lo, max: hi };
}

const ZOOM_CAPTIONS: Record<string, string> = {
    FRONT: "FRONT zoom (picture right = +X = the object's LEFT)",
    SIDE: "SIDE zoom from +X (picture right = +Y = the object's back)",
    TOP: "TOP zoom (picture right = +X, picture up = +Y = the object's back)",
};

/** Zoomed pictures of the region a first program selects, the selection tinted red, with a 20 mm grid (the second pass). */
export async function zoomViews(input: DescribeInput, program: Pick<MeshProgram, "ops">): Promise<MeshView[]> {
    const box = zoomBox(program);
    if (!box) return [];
    const { setup } = input;
    const size = ZOOM_PICTURE_SIZE;
    const format = input.format ?? "png";
    const colors = vertexColorsOf(input);
    const n = setup.mesh.Q.length / 3;
    const selected = new Float32Array(n);
    for (const op of program.ops) {
        if (op.boxes.length === 0) continue;
        const w = selectionWeights(setup.mesh.Q, toExecutorOp(op).where);
        for (let v = 0; v < n; v++) if (w[v] > selected[v]) selected[v] = w[v];
    }
    const layers = layersOf(input, tintSelected(colors, selected, 0.6));
    const views: MeshView[] = [];
    for (const view of VIEWS as readonly ViewSpec[]) {
        const pic = rasterize(layers, view, { size, fit: box });
        drawGrid(pic, view, { step: 20, major: 100, labelEvery: 40, fit: box });
        drawText(pic, 6, size - 18, `${view.id} zoom`, [15, 23, 42], 2);
        const encoded = await encodePicture(pic, format);
        views.push({ id: view.id, caption: ZOOM_CAPTIONS[view.id] ?? view.caption, image: toDataUrl(encoded.bytes, encoded.mime) });
    }
    return views;
}
