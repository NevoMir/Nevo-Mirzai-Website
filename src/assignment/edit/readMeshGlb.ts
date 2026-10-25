// Reads the GLB of a fused mesh (a Hunyuan model, or one this editor wrote before) into typed arrays in glTF world space.
//
// What it handles: one textured (or plain) triangle mesh on a node of the default scene, float attributes (or normalised UVs), any
// node hierarchy above it (the transform is baked into the vertices), plus the pieces an earlier edit added ("Edit parts" nodes), which
// are kept as they are and only drawn in the pictures. What it refuses, with a message that says the format cannot be edited here:
// Draco, meshopt or quantised geometry, compressed textures, sparse accessors, external buffers, several textured pieces, more triangles
// than MAX_EDIT_TRIANGLES. Pure TypeScript; no DOM.

import { MAX_EDIT_TRIANGLES } from "../shared/contract.ts";
import {
    determinant3,
    normalMatrix,
    parentsOf,
    parseGlb,
    readFloats,
    readIndices,
    worldMatrices,
    type Glb,
    type GltfJson,
    type GltfMaterial,
    type Mat4,
} from "./gltf.ts";
import { MeshEditError } from "./types.ts";
import { MAX_EDITED_IMAGE_SIDE, firstDisallowedExtension, pictureTooBig } from "./uploadRules.ts";

/** KHR_texture_transform of the base colour texture. */
export interface UvTransform {
    offset: [number, number];
    rotation: number;
    scale: [number, number];
}

export interface SourceTexture {
    imageIndex: number;
    /** The encoded image (PNG or JPEG), a view into the file. */
    bytes: Uint8Array;
    mime: string;
    transform: UvTransform | null;
}

/** A mesh node of the file that the editor does not change (parts an earlier edit added): drawn in the pictures, written back as they are. */
export interface CarriedPiece {
    nodeIndex: number;
    name: string;
    /** glTF world space, Y up, metres. */
    positions: Float32Array;
    indices: Uint32Array;
    /** sRGB 0..255. */
    color: [number, number, number];
}

export interface MeshSource {
    /** The whole file (the writer copies untouched bytes out of it). */
    bytes: Uint8Array;
    glb: Glb;
    mainNode: number;
    materialIndex: number | null;
    /** Baked into glTF world space (Y up, metres), vertex by vertex as stored. */
    positions: Float32Array;
    normals: Float32Array | null;
    /** null when the source has no texture coordinates. */
    uv: Float32Array | null;
    indices: Uint32Array;
    texture: SourceTexture | null;
    /** The base colour factor of the main material (linear RGBA), [1,1,1,1] when absent. */
    baseColor: [number, number, number, number];
    carried: CarriedPiece[];
}

export type ReadResult = { ok: true; source: MeshSource } | { ok: false; reason: string };

const UNSUPPORTED_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_mesh_quantization", "KHR_texture_basisu", "EXT_texture_webp", "KHR_materials_variants"];
const EDIT_PARTS_NAME = /^Edit parts( \d+)?$/;

const unsupported = (why: string): MeshEditError => new MeshEditError("unsupported", `This model's format can't be edited here (${why}).`);

const linearToSrgb = (c: number): number => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

function transformOf(info: { extensions?: Record<string, unknown> } | undefined): UvTransform | null {
    const raw = info?.extensions?.KHR_texture_transform;
    if (typeof raw !== "object" || raw === null) return null;
    const t = raw as { offset?: number[]; rotation?: number; scale?: number[]; texCoord?: number };
    if (t.texCoord !== undefined && t.texCoord !== 0) throw unsupported("second texture coordinates");
    return {
        offset: [t.offset?.[0] ?? 0, t.offset?.[1] ?? 0],
        rotation: t.rotation ?? 0,
        scale: [t.scale?.[0] ?? 1, t.scale?.[1] ?? 1],
    };
}

/** The texture coordinate (u, v) as the image is addressed: KHR_texture_transform applied, when the file has one. */
export function imageUv(u: number, v: number, t: UvTransform | null): [number, number] {
    if (!t) return [u, v];
    const c = Math.cos(t.rotation);
    const s = Math.sin(t.rotation);
    return [c * t.scale[0] * u + s * t.scale[1] * v + t.offset[0], -s * t.scale[0] * u + c * t.scale[1] * v + t.offset[1]];
}

interface PrimitiveData {
    positions: Float32Array;
    normals: Float32Array | null;
    uv: Float32Array | null;
    indices: Uint32Array;
}

/** One triangle primitive of a node, in world space. */
function readPrimitive(g: Glb, meshIndex: number, world: Mat4, wantAttributes: boolean): PrimitiveData & { materialIndex: number | null } {
    const mesh = g.json.meshes?.[meshIndex];
    if (!mesh || mesh.primitives.length !== 1) throw unsupported("a piece made of several parts");
    const prim = mesh.primitives[0];
    if ((prim.mode ?? 4) !== 4) throw unsupported("not triangles");
    const posAccessor = prim.attributes.POSITION;
    if (posAccessor === undefined) throw unsupported("no positions");
    const local = readFloats(g, posAccessor, 3);
    const n = local.length / 3;
    const positions = new Float32Array(local.length);
    for (let i = 0; i < n; i++) {
        const x = local[i * 3], y = local[i * 3 + 1], z = local[i * 3 + 2];
        positions[i * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
        positions[i * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
        positions[i * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
    }
    let indices: Uint32Array;
    if (prim.indices !== undefined) {
        indices = readIndices(g, prim.indices);
    } else {
        indices = new Uint32Array(n - (n % 3));
        for (let i = 0; i < indices.length; i++) indices[i] = i;
    }
    if (indices.length % 3 !== 0) indices = indices.subarray(0, indices.length - (indices.length % 3));
    for (let i = 0; i < indices.length; i++) if (indices[i] >= n) throw unsupported("damaged triangles");
    // A mirrored transform turns the triangles inside out: restore their winding.
    if (determinant3(world) < 0) {
        indices = Uint32Array.from(indices);
        for (let t = 0; t < indices.length; t += 3) {
            const tmp = indices[t + 1];
            indices[t + 1] = indices[t + 2];
            indices[t + 2] = tmp;
        }
    }
    let normals: Float32Array | null = null;
    let uv: Float32Array | null = null;
    if (wantAttributes) {
        if (prim.attributes.NORMAL !== undefined) {
            const local3 = readFloats(g, prim.attributes.NORMAL, 3);
            if (local3.length !== local.length) throw unsupported("damaged normals");
            const nm = normalMatrix(world);
            normals = new Float32Array(local3.length);
            for (let i = 0; i < n; i++) {
                const x = local3[i * 3], y = local3[i * 3 + 1], z = local3[i * 3 + 2];
                const nx = nm[0] * x + nm[1] * y + nm[2] * z, ny = nm[3] * x + nm[4] * y + nm[5] * z, nz = nm[6] * x + nm[7] * y + nm[8] * z;
                const len = Math.hypot(nx, ny, nz) || 1;
                normals[i * 3] = nx / len;
                normals[i * 3 + 1] = ny / len;
                normals[i * 3 + 2] = nz / len;
            }
        }
        if (prim.attributes.TEXCOORD_0 !== undefined) {
            uv = readFloats(g, prim.attributes.TEXCOORD_0, 2);
            if (uv.length !== n * 2) throw unsupported("damaged texture coordinates");
        }
    }
    return { positions, normals, uv, indices, materialIndex: prim.material ?? null };
}

function textureOf(json: GltfJson, g: Glb, material: GltfMaterial | undefined): SourceTexture | null {
    const info = material?.pbrMetallicRoughness?.baseColorTexture;
    if (!info) return null;
    if ((info.texCoord ?? 0) !== 0) throw unsupported("second texture coordinates");
    const texture = json.textures?.[info.index];
    const image = texture?.source === undefined ? undefined : json.images?.[texture.source];
    if (!image || image.bufferView === undefined) throw unsupported("the picture is outside the file");
    const view = json.bufferViews?.[image.bufferView];
    if (!view || view.buffer !== 0) throw unsupported("the picture is outside the file");
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > g.bin.byteLength) throw unsupported("damaged picture");
    const mime = image.mimeType;
    if (mime !== "image/png" && mime !== "image/jpeg") throw unsupported("an unusual picture format");
    const bytes = g.bin.subarray(start, start + view.byteLength);
    // The picture goes into the result as it is (unless repainted), and the upload refuses a bigger one: say so before the work, not after.
    if (pictureTooBig(bytes, mime)) throw unsupported(`its picture is larger than ${MAX_EDITED_IMAGE_SIDE} pixels on a side`);
    return { imageIndex: texture!.source!, bytes, mime, transform: transformOf(info) };
}

function colorOf(material: GltfMaterial | undefined): [number, number, number] {
    const f = material?.pbrMetallicRoughness?.baseColorFactor;
    const c = Array.isArray(f) && f.length >= 3 ? f : [0.8, 0.8, 0.8];
    return [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])];
}

/**
 * Reads the file. `ok: false` carries a sentence fit to show the person (the format cannot be edited here); it never throws. The arrays
 * of the result are fresh copies (the file's bytes are only referenced for the picture).
 */
export function readMeshGlb(bytes: Uint8Array): ReadResult {
    try {
        return { ok: true, source: read(bytes) };
    } catch (error) {
        if (error instanceof MeshEditError) return { ok: false, reason: error.message };
        return { ok: false, reason: "This model's format can't be edited here (it could not be read)." };
    }
}

function read(bytes: Uint8Array): MeshSource {
    const glb = parseGlb(bytes);
    const json = glb.json;
    if (json.asset?.version !== "2.0") throw unsupported("not glTF 2.0");
    for (const ext of [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])]) {
        if (UNSUPPORTED_EXTENSIONS.includes(ext)) throw unsupported(ext.includes("draco") ? "compressed with Draco" : ext.includes("meshopt") ? "compressed with meshopt" : "compressed or quantised data");
    }
    // An extension the upload would refuse (the writer keeps extensions as they are): better said now than after the work.
    const foreign = firstDisallowedExtension(json);
    if (foreign) throw unsupported(`it uses a feature that cannot be saved after an edit: ${foreign.slice(0, 40)}`);
    if ((json.skins as unknown[] | undefined)?.length || (json.animations as unknown[] | undefined)?.length) throw unsupported("an animated or rigged model");
    if (json.buffers?.some((b) => b.uri !== undefined) || json.images?.some((i) => i.uri !== undefined)) throw unsupported("data outside the file");
    const nodes = json.nodes ?? [];
    const worlds = worldMatrices(json);
    const parents = parentsOf(json);

    // Nodes an earlier edit of this editor added (children of "Edit parts") are carried; every other mesh node is a candidate.
    const underEditParts = (index: number): boolean => {
        for (let at = parents.get(index); at !== undefined; at = parents.get(at)) if (EDIT_PARTS_NAME.test(nodes[at]?.name ?? "")) return true;
        return false;
    };
    const meshNodes = [...worlds.keys()].filter((i) => nodes[i].mesh !== undefined && (json.meshes?.[nodes[i].mesh!]?.primitives.length ?? 0) > 0).sort((a, b) => a - b);
    const candidates = meshNodes.filter((i) => !underEditParts(i));
    if (candidates.length === 0) throw unsupported("no mesh found");
    const materialOf = (node: number): GltfMaterial | undefined => {
        const prim = json.meshes?.[nodes[node].mesh!]?.primitives[0];
        return prim?.material === undefined ? undefined : json.materials?.[prim.material];
    };
    const textured = candidates.filter((i) => materialOf(i)?.pbrMetallicRoughness?.baseColorTexture !== undefined);
    let main: number;
    if (textured.length === 1) main = textured[0];
    else if (textured.length > 1) throw unsupported("several textured pieces");
    else if (candidates.length === 1) main = candidates[0];
    else throw unsupported("several separate pieces");

    const prim = readPrimitive(glb, nodes[main].mesh!, worlds.get(main)!, true);
    if (prim.indices.length / 3 > MAX_EDIT_TRIANGLES) throw new MeshEditError("unsupported", "This model is too detailed to edit here.");
    const material = prim.materialIndex === null ? undefined : json.materials?.[prim.materialIndex];
    const texture = textureOf(json, glb, material);
    const f = material?.pbrMetallicRoughness?.baseColorFactor;
    const baseColor: [number, number, number, number] = Array.isArray(f) && f.length === 4 ? [f[0], f[1], f[2], f[3]] : [1, 1, 1, 1];

    const carried: CarriedPiece[] = [];
    for (const index of meshNodes) {
        if (index === main) continue;
        const piece = readPrimitive(glb, nodes[index].mesh!, worlds.get(index)!, false);
        carried.push({ nodeIndex: index, name: nodes[index].name ?? json.meshes?.[nodes[index].mesh!]?.name ?? "part", positions: piece.positions, indices: piece.indices, color: colorOf(materialOf(index)) });
    }
    return { bytes, glb, mainNode: main, materialIndex: prim.materialIndex, positions: prim.positions, normals: prim.normals, uv: prim.uv, indices: prim.indices, texture, baseColor, carried };
}
