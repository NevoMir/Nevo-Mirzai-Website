// Shared by the mesh-edit scripts (test-edit-mesh.mjs, live-edit-mesh.mjs): the texture codec a Node run uses (the browser has canvas; Node
// borrows `sharp`, which wrangler already installs), and where the local Hunyuan fixture is.
import { existsSync, readFileSync } from "node:fs";

/** The 27.8 MB Hunyuan rocking chair the design was measured on. It is not part of the repo (set HUNYUAN_GLB to use another copy). */
export const HUNYUAN_GLB =
    process.env.HUNYUAN_GLB ??
    "/private/tmp/claude-501/-Users-josephmirzai-Documents-Nevo-website/f150fdea-65e6-490a-bbdb-a687fe25ab2f/scratchpad/design2-edit/hunyuan.glb";

export const hasHunyuan = () => existsSync(HUNYUAN_GLB);
export const readHunyuan = () => new Uint8Array(readFileSync(HUNYUAN_GLB));

/** A TextureCodec (edit/texture.ts) on sharp, or null when sharp is not installed. */
export async function sharpCodec() {
    let sharp;
    try {
        sharp = (await import("sharp")).default;
    } catch {
        return null;
    }
    return {
        async decode(bytes, _mime, maxSide) {
            const img = sharp(Buffer.from(bytes), { limitInputPixels: false });
            const meta = await img.metadata();
            const k = Math.min(1, maxSide / Math.max(meta.width, meta.height));
            const out = await img.resize(Math.max(1, Math.round(meta.width * k)), Math.max(1, Math.round(meta.height * k))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            return { w: out.info.width, h: out.info.height, data: new Uint8Array(out.data) };
        },
        async encodeJpeg(image, quality) {
            return new Uint8Array(await sharp(Buffer.from(image.data), { raw: { width: image.w, height: image.h, channels: 3 } }).jpeg({ quality: Math.round(quality * 100) }).toBuffer());
        },
    };
}

/** JPEG bytes of an RGB picture through sharp (the browser's canvas does this for the pictures; a Node run borrows sharp). */
export async function sharpJpeg(rgb, W, H, quality = 0.8) {
    const sharp = (await import("sharp")).default;
    return new Uint8Array(await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: Math.round(quality * 100) }).toBuffer());
}

/**
 * A small plain model file (a subdivided box on a node with a rotation, as a text-to-3D file would be), written without any helper library, so
 * a script has something to edit. Returns the GLB bytes.
 */
export async function plainBoxGlb() {
    const { assembleGlb } = await import("../../src/assignment/edit/patchGlb.ts");
    const n = 6; // 6 x 6 quads per face
    const pos = [], idx = [];
    const face = (O, U, V) => {
        const base = pos.length / 3;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(O[0] + (U[0] * i + V[0] * j) / n, O[1] + (U[1] * i + V[1] * j) / n, O[2] + (U[2] * i + V[2] * j) / n);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const p = base + j * (n + 1) + i; idx.push(p, p + 1, p + n + 1, p + 1, p + n + 2, p + n + 1); }
    };
    // a 0.3 x 0.3 x 0.6 m box (faces wound outward)
    face([0, 0, 0], [0, 0.3, 0], [0.3, 0, 0]); face([0, 0, 0.6], [0.3, 0, 0], [0, 0.3, 0]);
    face([0, 0, 0], [0.3, 0, 0], [0, 0, 0.6]); face([0, 0.3, 0], [0, 0, 0.6], [0.3, 0, 0]);
    face([0, 0, 0], [0, 0, 0.6], [0, 0.3, 0]); face([0.3, 0, 0], [0, 0.3, 0], [0, 0, 0.6]);
    const P = Float32Array.from(pos), I = Uint32Array.from(idx);
    const bin = new Uint8Array(P.byteLength + I.byteLength);
    bin.set(new Uint8Array(P.buffer), 0);
    bin.set(new Uint8Array(I.buffer), P.byteLength);
    const json = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name: "Model", mesh: 0, rotation: [0.7071068, 0, 0, 0.7071068] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: P.length / 3, type: "VEC3", min: [0, 0, 0], max: [0.3, 0.3, 0.6] },
            { bufferView: 1, componentType: 5125, count: I.length, type: "SCALAR" },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength, target: 34962 }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength, target: 34963 }],
        buffers: [{ byteLength: bin.length }],
    };
    return assembleGlb(json, bin);
}

/** An edited file made the way the page makes one: read, framed, a program run (a stretch and two added parts), written. */
export async function smallEditedGlb() {
    const { readMeshGlb } = await import("../../src/assignment/edit/readMeshGlb.ts");
    const { buildEditSetup } = await import("../../src/assignment/edit/frame.ts");
    const { runProgram } = await import("../../src/assignment/edit/runProgram.ts");
    const { writeEditedGlb } = await import("../../src/assignment/edit/patchGlb.ts");
    const source = readMeshGlb(await plainBoxGlb()).source;
    const setup = buildEditSetup(source);
    const box = { min: [-400, -400, 300], max: [400, 400, 1100] };
    const part = (name, shape, z) => ({ name, shape, size: [80, 80, 40], position: [0, 0, z], rotation: [0, 0, 0], color: "#336699" });
    const program = { summary: "Made it taller and added two parts.", applied: true, ops: [
        { op: "stretch", label: "top", boxes: [box], exclude: [], feather_mm: 20, axis: "z", from_mm: 500, to_mm: 900, amount_mm: 100 },
        { op: "add_parts", label: "knobs", boxes: [], exclude: [], feather_mm: 20, axis: "z", parts: [part("knob", "sphere", 1010), part("ring", "torus", 900)] },
    ] };
    const run = runProgram(setup.mesh, program);
    return { glb: writeEditedGlb({ source, frame: setup.frame, mesh: run.state, hasUv: false, parts: run.state.parts, echo: { version: 1, target: "mesh" } }), program };
}
