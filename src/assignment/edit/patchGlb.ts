// Writes the edited mesh as a new GLB, from the file it was made from (so materials, samplers and extensions stay as they were).
//
//   - the mesh's geometry is baked into glTF world space (Y up, metres) and its node loses its transform (the node is lifted to the
//     scene root, so a transform above it cannot move it a second time);
//   - POSITION, NORMAL, TEXCOORD_0 and the indices are rebuilt (uint16 when they fit, else uint32); other attributes are dropped;
//   - the picture is the original's bytes, copied untouched, unless a recolor changed it (then a JPEG replaces it);
//   - parts the program added are nodes under one "Edit parts" parent, sharing one unit mesh per shape (the same construction as the
//     Muse parts models, shared/partsGlb.ts), each carrying its "nevo:part" extras;
//   - everything the file already had that an edit leaves alone (parts an earlier edit added) is copied through;
//   - scenes[0].extras["nevo:edit"] is an informative echo of what was done (the server builds the real record from the job).
// The buffer is re-packed from what is still referenced, so nothing of the old geometry stays in the file. Pure TypeScript.

import { partPrimitive, type PartMesh } from "../shared/partsGlb.ts";
import { rotationMatrix, uniqueNames, type DesignPart } from "../shared/partsDesign.ts";
import { fromFrame, type EditFrame } from "./frame.ts";
import { CHUNK_BIN, CHUNK_JSON, GLB_MAGIC, pad4, type GltfAccessor, type GltfBufferView, type GltfJson, type GltfNode } from "./gltf.ts";
import type { MeshSource } from "./readMeshGlb.ts";
import { MeshEditError, type EditMesh } from "./types.ts";
import { MAX_EDITED_NODES } from "./uploadRules.ts";

export interface WriteInput {
    source: MeshSource;
    frame: EditFrame;
    /** The edited mesh in the frame. */
    mesh: EditMesh;
    /** Write TEXCOORD_0 (the source had texture coordinates). */
    hasUv: boolean;
    /** Parts the program added, mm in the frame. */
    parts: readonly DesignPart[];
    /** Replaces the main picture (a recolored texture). */
    image?: { bytes: Uint8Array; mime: string };
    /** Replaces the base colour factor of the main material (a recolor on a browser that cannot repaint the picture). */
    baseColorFactor?: readonly [number, number, number, number];
    /** scenes[0].extras["nevo:edit"]. */
    echo: Record<string, unknown>;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
export const EDIT_GENERATOR = "Assembly Studio edit 1";
const EDIT_PARTS_NAME = /^Edit parts( \d+)?$/;

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function baseColor(hex: string): [number, number, number, number] {
    const n = Number.parseInt(hex.slice(1), 16);
    const lin = (shift: number) => round6(srgbToLinear(((n >> shift) & 255) / 255));
    return [lin(16), lin(8), lin(0), 1];
}

/** Unit quaternion [x, y, z, w] of a part's rotation in glTF's Y-up frame: R_gltf = C R C^T with C = (x, z, -y). */
function gltfQuaternion(rotation: readonly [number, number, number]): [number, number, number, number] | null {
    const R = rotationMatrix([rotation[0], rotation[1], rotation[2]]);
    const C = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    const CT = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const mul = (a: number[], b: number[]): number[] => {
        const out = new Array<number>(9).fill(0);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
        return out;
    };
    const m = mul(mul(C, R), CT);
    const tr = m[0] + m[4] + m[8];
    let qx: number, qy: number, qz: number, qw: number;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        qw = 0.25 * s; qx = (m[7] - m[5]) / s; qy = (m[2] - m[6]) / s; qz = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        qw = (m[7] - m[5]) / s; qx = 0.25 * s; qy = (m[1] + m[3]) / s; qz = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        qw = (m[2] - m[6]) / s; qx = (m[1] + m[3]) / s; qy = 0.25 * s; qz = (m[5] + m[7]) / s;
    } else {
        const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        qw = (m[3] - m[1]) / s; qx = (m[2] + m[6]) / s; qy = (m[5] + m[7]) / s; qz = 0.25 * s;
    }
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    if (Math.abs(qx) + Math.abs(qy) + Math.abs(qz) < 1e-9) return null;
    return [round6(qx / len), round6(qy / len), round6(qz / len), round6(qw / len)];
}

/** New data waiting to be placed in the buffer: bufferView index -> bytes. */
type Payloads = Map<number, Uint8Array>;

function addView(json: GltfJson, payloads: Payloads, bytes: Uint8Array, target?: number): number {
    const views = (json.bufferViews ??= []);
    const view: GltfBufferView = { buffer: 0, byteOffset: 0, byteLength: bytes.byteLength };
    if (target !== undefined) view.target = target;
    views.push(view);
    payloads.set(views.length - 1, bytes);
    return views.length - 1;
}

function addAccessor(json: GltfJson, accessor: GltfAccessor): number {
    const list = (json.accessors ??= []);
    list.push(accessor);
    return list.length - 1;
}

const bytesOf = (a: Float32Array | Uint16Array | Uint32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function boundsOf(P: Float32Array): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) { const v = P[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
    return { min, max };
}

/**
 * Removes nodes that carry nothing (no mesh, no children, no camera, no skin): lifting the mesh node to the scene root can leave its old
 * parents empty, and an empty node is a validator warning. The rest of the nodes are renumbered (a file with skins or animations never
 * gets here: the reader refuses it, so scenes and children are the only places that name a node).
 */
function pruneEmptyNodes(json: GltfJson): void {
    const nodes = json.nodes ?? [];
    const removed = new Set<number>();
    for (let changed = true; changed; ) {
        changed = false;
        nodes.forEach((node, index) => {
            if (removed.has(index)) return;
            const live = (node.children ?? []).some((c) => !removed.has(c));
            if (node.mesh === undefined && !live && node.camera === undefined && node.skin === undefined) {
                removed.add(index);
                changed = true;
            }
        });
    }
    if (removed.size === 0) return;
    const renumber = new Map<number, number>();
    nodes.forEach((_, index) => {
        if (!removed.has(index)) renumber.set(index, renumber.size);
    });
    json.nodes = nodes
        .filter((_, index) => !removed.has(index))
        .map((node) => {
            const children = (node.children ?? []).filter((c) => !removed.has(c)).map((c) => renumber.get(c) as number);
            const { children: _old, ...rest } = node;
            void _old;
            return children.length > 0 ? { ...rest, children } : rest;
        });
    for (const scene of json.scenes ?? []) if (scene.nodes) scene.nodes = scene.nodes.filter((c) => !removed.has(c)).map((c) => renumber.get(c) as number);
}

/** Drops accessors and buffer views nothing refers to any more and lays the rest out in a new buffer. Returns the BIN payload. */
function repack(json: GltfJson, oldBin: Uint8Array, payloads: Payloads): Uint8Array {
    const accessors = json.accessors ?? [];
    const views = json.bufferViews ?? [];
    const usedAccessors = new Set<number>();
    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives) {
            for (const index of Object.values(prim.attributes)) usedAccessors.add(index);
            if (prim.indices !== undefined) usedAccessors.add(prim.indices);
        }
    }
    const usedViews = new Set<number>();
    for (const index of usedAccessors) {
        const view = accessors[index]?.bufferView;
        if (view !== undefined) usedViews.add(view);
    }
    for (const image of json.images ?? []) if (image.bufferView !== undefined) usedViews.add(image.bufferView);

    const viewMap = new Map<number, number>();
    const newViews: GltfBufferView[] = [];
    const chunks: Array<{ bytes: Uint8Array; at: number }> = [];
    let offset = 0;
    views.forEach((view, index) => {
        if (!usedViews.has(index)) return;
        const bytes = payloads.get(index) ?? oldBin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
        viewMap.set(index, newViews.length);
        newViews.push({ ...view, buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
        chunks.push({ bytes, at: offset });
        offset += pad4(bytes.byteLength);
    });
    const accessorMap = new Map<number, number>();
    const newAccessors: GltfAccessor[] = [];
    accessors.forEach((accessor, index) => {
        if (!usedAccessors.has(index)) return;
        accessorMap.set(index, newAccessors.length);
        newAccessors.push({ ...accessor, bufferView: accessor.bufferView === undefined ? undefined : viewMap.get(accessor.bufferView) });
    });
    for (const mesh of json.meshes ?? []) {
        for (const prim of mesh.primitives) {
            for (const key of Object.keys(prim.attributes)) prim.attributes[key] = accessorMap.get(prim.attributes[key]) as number;
            if (prim.indices !== undefined) prim.indices = accessorMap.get(prim.indices) as number;
        }
    }
    for (const image of json.images ?? []) if (image.bufferView !== undefined) image.bufferView = viewMap.get(image.bufferView);
    // An accessor without a view (all zeros) would have been written as `bufferView: undefined`; drop the key so the JSON stays valid.
    for (const accessor of newAccessors) if (accessor.bufferView === undefined) delete accessor.bufferView;
    json.accessors = newAccessors;
    json.bufferViews = newViews;
    json.buffers = [{ byteLength: offset }];
    const bin = new Uint8Array(offset);
    for (const chunk of chunks) bin.set(chunk.bytes, chunk.at);
    return bin;
}

/** Assembles a GLB from JSON and a BIN payload. */
export function assembleGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = pad4(jsonBytes.byteLength);
    const binLength = pad4(bin.byteLength);
    const total = 12 + 8 + jsonLength + (bin.byteLength > 0 ? 8 + binLength : 0);
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
    if (bin.byteLength > 0) {
        view.setUint32(20 + jsonLength, binLength, true);
        view.setUint32(24 + jsonLength, CHUNK_BIN, true);
        out.set(bin, 28 + jsonLength);
    }
    return out;
}

/** The edited mesh (and the parts a program added) as a new GLB. */
export function writeEditedGlb(input: WriteInput): Uint8Array {
    const { source, frame, mesh } = input;
    const json = JSON.parse(JSON.stringify(source.glb.json)) as GltfJson;
    const payloads: Payloads = new Map();
    const n = mesh.Q.length / 3;

    // Frame mm -> Z-up source metres -> glTF world (x, z, -y).
    const zUp = fromFrame(mesh.Q, frame);
    const P = new Float32Array(n * 3);
    const N = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        P[i * 3] = zUp[i * 3];
        P[i * 3 + 1] = zUp[i * 3 + 2];
        P[i * 3 + 2] = -zUp[i * 3 + 1];
        N[i * 3] = mesh.nor[i * 3];
        N[i * 3 + 1] = mesh.nor[i * 3 + 2];
        N[i * 3 + 2] = -mesh.nor[i * 3 + 1];
    }
    const { min, max } = boundsOf(P);
    const mainMesh = json.meshes![json.nodes![source.mainNode].mesh!];
    const prim = mainMesh.primitives[0];
    const attributes: Record<string, number> = {};
    attributes.POSITION = addAccessor(json, { bufferView: addView(json, payloads, bytesOf(P), ARRAY_BUFFER), componentType: FLOAT, count: n, type: "VEC3", min, max });
    attributes.NORMAL = addAccessor(json, { bufferView: addView(json, payloads, bytesOf(N), ARRAY_BUFFER), componentType: FLOAT, count: n, type: "VEC3" });
    if (input.hasUv) attributes.TEXCOORD_0 = addAccessor(json, { bufferView: addView(json, payloads, bytesOf(mesh.uv), ARRAY_BUFFER), componentType: FLOAT, count: n, type: "VEC2" });
    const small = n <= 65535;
    const indexData = small ? Uint16Array.from(mesh.idx) : mesh.idx;
    prim.attributes = attributes;
    prim.indices = addAccessor(json, { bufferView: addView(json, payloads, bytesOf(indexData), ELEMENT_ARRAY_BUFFER), componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: mesh.idx.length, type: "SCALAR" });

    // The picture and the colour factor.
    if (input.image && source.texture) {
        const image = json.images![source.texture.imageIndex];
        image.bufferView = addView(json, payloads, input.image.bytes);
        image.mimeType = input.image.mime;
    }
    if (input.baseColorFactor && prim.material !== undefined) {
        const pbr = (json.materials![prim.material].pbrMetallicRoughness ??= {});
        pbr.baseColorFactor = [...input.baseColorFactor];
    }

    // The mesh's transform is baked in: its node goes to the scene root with none.
    const nodes = json.nodes!;
    const mainNode = nodes[source.mainNode];
    delete mainNode.rotation;
    delete mainNode.translation;
    delete mainNode.scale;
    delete mainNode.matrix;
    const scene = json.scenes![json.scene ?? 0];
    scene.nodes ??= [];
    if (!scene.nodes.includes(source.mainNode)) {
        for (const node of nodes) if (node.children?.includes(source.mainNode)) node.children = node.children.filter((c) => c !== source.mainNode);
        scene.nodes.push(source.mainNode);
    }

    if (input.parts.length > 0) addParts(json, payloads, input.parts, frame);

    scene.extras = { ...(scene.extras ?? {}), "nevo:edit": input.echo };
    pruneEmptyNodes(json);
    // The upload refuses more nodes than this; found here, the person is told before the file is sent.
    if ((json.nodes?.length ?? 0) > MAX_EDITED_NODES) throw new MeshEditError("toobig", "The edited model would have too many parts to save. Describe a smaller change.");
    json.asset = { ...json.asset, version: "2.0", generator: EDIT_GENERATOR };
    const bin = repack(json, source.glb.bin, payloads);
    return assembleGlb(json, bin);
}

/** Parts under one "Edit parts" parent that maps the frame (mm / 1000) back to the model's own units. */
function addParts(json: GltfJson, payloads: Payloads, parts: readonly DesignPart[], frame: EditFrame): void {
    const nodes = (json.nodes ??= []);
    const meshes = (json.meshes ??= []);
    const materials = (json.materials ??= []);
    const k = 1000 / frame.scale;
    const o = frame.origin;
    const taken = nodes.filter((nd) => EDIT_PARTS_NAME.test(nd.name ?? "")).length;
    const children: number[] = [];
    const parent: GltfNode = { name: taken === 0 ? "Edit parts" : `Edit parts ${taken + 1}`, translation: [o[0], o[2], -o[1]], scale: [k, k, k], children };
    nodes.push(parent);
    const parentIndex = nodes.length - 1;
    const names = uniqueNames(parts.map((p) => p.name));
    const cache = new Map<object, number>();
    const meshCache = new Map<string, PartMesh>();
    parts.forEach((p, i) => {
        const { mesh, scale } = partPrimitive(p.shape, p.size, meshCache);
        let first = cache.get(mesh);
        if (first === undefined) {
            const count = mesh.positions.length / 3;
            const { min, max } = boundsOf(mesh.positions);
            const positionView = addView(json, payloads, bytesOf(mesh.positions), ARRAY_BUFFER);
            const normalView = addView(json, payloads, bytesOf(mesh.normals), ARRAY_BUFFER);
            const indexView = addView(json, payloads, bytesOf(mesh.indices), ELEMENT_ARRAY_BUFFER);
            first = addAccessor(json, { bufferView: positionView, componentType: FLOAT, count, type: "VEC3", min, max });
            addAccessor(json, { bufferView: normalView, componentType: FLOAT, count, type: "VEC3" });
            addAccessor(json, { bufferView: indexView, componentType: UNSIGNED_SHORT, count: mesh.indices.length, type: "SCALAR" });
            cache.set(mesh, first);
        }
        materials.push({ name: names[i], pbrMetallicRoughness: { baseColorFactor: baseColor(p.color), metallicFactor: 0, roughnessFactor: 0.75 } });
        meshes.push({ name: names[i], primitives: [{ attributes: { POSITION: first, NORMAL: first + 1 }, indices: first + 2, material: materials.length - 1, mode: 4 }] });
        const node: GltfNode = {
            name: names[i],
            mesh: meshes.length - 1,
            translation: [round6(p.position[0] * 0.001) + 0, round6(p.position[2] * 0.001) + 0, round6(-p.position[1] * 0.001) + 0],
            extras: { "nevo:part": { shape: p.shape, size_mm: p.size, color: p.color } },
        };
        const q = gltfQuaternion(p.rotation);
        if (q) node.rotation = q;
        if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) node.scale = [round6(scale[0]), round6(scale[2]), round6(scale[1])];
        nodes.push(node);
        children.push(nodes.length - 1);
    });
    const scene = json.scenes![json.scene ?? 0];
    (scene.nodes ??= []).push(parentIndex);
}
