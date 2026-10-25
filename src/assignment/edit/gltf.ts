// A small, strict reader for the GLB containers the mesh editor handles: the header and chunks, typed access to accessors, node
// transforms. No dependencies and no DOM, so the browser worker, the Node tests and the writer share it. Everything that is not
// plain (sparse accessors, external buffers, quantised or compressed geometry) is reported, never guessed at.

import { MeshEditError } from "./types.ts";

export interface GltfNode {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
    extras?: unknown;
    [key: string]: unknown;
}

export interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
    sparse?: unknown;
    [key: string]: unknown;
}

export interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
    target?: number;
    [key: string]: unknown;
}

export interface GltfPrimitive {
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    [key: string]: unknown;
}

export interface GltfMesh {
    name?: string;
    primitives: GltfPrimitive[];
    [key: string]: unknown;
}

export interface GltfTextureInfo {
    index: number;
    texCoord?: number;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface GltfMaterial {
    name?: string;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureInfo; [key: string]: unknown };
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface GltfJson {
    asset?: { version?: string; generator?: string; [key: string]: unknown };
    scene?: number;
    scenes?: Array<{ nodes?: number[]; extras?: Record<string, unknown>; [key: string]: unknown }>;
    nodes?: GltfNode[];
    meshes?: GltfMesh[];
    materials?: GltfMaterial[];
    textures?: Array<{ source?: number; sampler?: number; [key: string]: unknown }>;
    images?: Array<{ bufferView?: number; mimeType?: string; uri?: string; name?: string; [key: string]: unknown }>;
    samplers?: unknown[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    buffers?: Array<{ byteLength: number; uri?: string }>;
    extensionsUsed?: string[];
    extensionsRequired?: string[];
    [key: string]: unknown;
}

export interface Glb {
    json: GltfJson;
    /** The BIN chunk's payload (a view into the file). */
    bin: Uint8Array;
}

export const GLB_MAGIC = 0x46546c67; // "glTF"
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

export const pad4 = (n: number): number => (n + 3) & ~3;

const unsupported = (why: string): MeshEditError => new MeshEditError("unsupported", `This model's format can't be edited here (${why}).`);

/** Splits a GLB into its JSON and BIN chunks. Throws MeshEditError("unsupported") for anything that is not a plain single-buffer GLB 2.0. */
export function parseGlb(bytes: Uint8Array): Glb {
    if (bytes.byteLength < 28) throw unsupported("not a GLB file");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) throw unsupported("not a GLB 2.0 file");
    const total = Math.min(view.getUint32(8, true), bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLength > total) throw unsupported("damaged GLB");
    let json: GltfJson;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson;
    } catch {
        throw unsupported("damaged GLB");
    }
    let at = 20 + jsonLength;
    let bin = new Uint8Array(0);
    if (at + 8 <= total) {
        const length = view.getUint32(at, true);
        if (view.getUint32(at + 4, true) === CHUNK_BIN && at + 8 + length <= total) bin = bytes.subarray(at + 8, at + 8 + length);
        at += 8 + length;
    }
    return { json, bin };
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

interface AccessorWindow {
    accessor: GltfAccessor;
    width: number;
    size: number;
    start: number;
    stride: number;
}

function windowOf(g: Glb, index: number): AccessorWindow {
    const accessor = g.json.accessors?.[index];
    if (!accessor || typeof accessor.count !== "number" || accessor.count < 0 || accessor.count > 50_000_000) throw unsupported("damaged accessor");
    if (accessor.sparse !== undefined) throw unsupported("sparse data");
    const size = COMPONENT_SIZE[accessor.componentType];
    const width = TYPE_WIDTH[accessor.type];
    if (size === undefined || width === undefined) throw unsupported("unusual data type");
    const view = accessor.bufferView === undefined ? undefined : g.json.bufferViews?.[accessor.bufferView];
    if (!view || view.buffer !== 0) throw unsupported("data outside the file");
    const element = size * width;
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : element;
    const viewStart = view.byteOffset ?? 0;
    const start = viewStart + (accessor.byteOffset ?? 0);
    const end = start + (accessor.count > 0 ? (accessor.count - 1) * stride + element : 0);
    if (stride < element || start < viewStart || end > viewStart + view.byteLength || end > g.bin.byteLength) throw unsupported("damaged accessor");
    return { accessor, width, size, start, stride };
}

/** A float accessor as a fresh Float32Array (normalised small integers are converted; others are refused). */
export function readFloats(g: Glb, index: number, width: number): Float32Array {
    const w = windowOf(g, index);
    if (w.width !== width) throw unsupported("unexpected data shape");
    const { accessor, size, start, stride } = w;
    const out = new Float32Array(accessor.count * width);
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
    const type = accessor.componentType;
    if (type === 5126) {
        if (stride === 4 * width && (g.bin.byteOffset + start) % 4 === 0) return new Float32Array(g.bin.buffer.slice(g.bin.byteOffset + start, g.bin.byteOffset + start + out.byteLength));
        for (let i = 0; i < accessor.count; i++) for (let c = 0; c < width; c++) out[i * width + c] = dv.getFloat32(start + i * stride + c * 4, true);
        return out;
    }
    // Normalised integers (some exporters store texture coordinates that way); anything else would need KHR_mesh_quantization.
    if (!accessor.normalized || (type !== 5121 && type !== 5123)) throw unsupported("quantised geometry");
    const scale = type === 5121 ? 255 : 65535;
    for (let i = 0; i < accessor.count; i++) {
        for (let c = 0; c < width; c++) {
            const at = start + i * stride + c * size;
            out[i * width + c] = (type === 5121 ? dv.getUint8(at) : dv.getUint16(at, true)) / scale;
        }
    }
    return out;
}

/** An index accessor (unsigned byte, short or int) as Uint32Array. */
export function readIndices(g: Glb, index: number): Uint32Array {
    const w = windowOf(g, index);
    if (w.width !== 1 || (w.accessor.componentType !== 5121 && w.accessor.componentType !== 5123 && w.accessor.componentType !== 5125)) throw unsupported("unexpected index type");
    const { accessor, size, start, stride } = w;
    const out = new Uint32Array(accessor.count);
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
    for (let i = 0; i < accessor.count; i++) {
        const at = start + i * stride;
        out[i] = size === 1 ? dv.getUint8(at) : size === 2 ? dv.getUint16(at, true) : dv.getUint32(at, true);
    }
    return out;
}

// ---------- node transforms ----------

/** Column-major 4x4, as glTF stores matrices. */
export type Mat4 = number[];

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

/** The node's own transform: its matrix, or translation * rotation * scale. */
export function localMatrix(node: GltfNode): Mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16 && node.matrix.every((n) => Number.isFinite(n))) return node.matrix.slice();
    const t = Array.isArray(node.translation) && node.translation.length === 3 ? node.translation : [0, 0, 0];
    const s = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale : [1, 1, 1];
    const q = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    const [x, y, z, w] = [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
    const r = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
    ];
    return [
        r[0] * s[0], r[1] * s[0], r[2] * s[0], 0,
        r[3] * s[1], r[4] * s[1], r[5] * s[1], 0,
        r[6] * s[2], r[7] * s[2], r[8] * s[2], 0,
        t[0], t[1], t[2], 1,
    ];
}

/** World matrices of every node reachable from the scene's roots (a cycle or a node reached twice keeps its first matrix). */
export function worldMatrices(json: GltfJson): Map<number, Mat4> {
    const nodes = json.nodes ?? [];
    const scene = json.scenes?.[json.scene ?? 0];
    const out = new Map<number, Mat4>();
    const walk = (index: number, parent: Mat4): void => {
        const node = nodes[index];
        if (!node || out.has(index)) return;
        const world = multiply(parent, localMatrix(node));
        out.set(index, world);
        for (const child of node.children ?? []) walk(child, world);
    };
    for (const root of scene?.nodes ?? []) walk(root, IDENTITY);
    return out;
}

/** The parent of every node (roots have none). */
export function parentsOf(json: GltfJson): Map<number, number> {
    const parents = new Map<number, number>();
    (json.nodes ?? []).forEach((node, index) => {
        for (const child of node.children ?? []) if (!parents.has(child)) parents.set(child, index);
    });
    return parents;
}

export function determinant3(m: Mat4): number {
    return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/** The matrix that carries normals along with a transform: the inverse transpose of its upper 3x3 (row-major result, 9 numbers). */
export function normalMatrix(m: Mat4): number[] {
    const a = m[0], b = m[4], c = m[8];
    const d = m[1], e = m[5], f = m[9];
    const g = m[2], h = m[6], i = m[10];
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-18) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const inv = 1 / det;
    // cofactor matrix / det = inverse transpose
    return [
        (e * i - f * h) * inv, -(d * i - f * g) * inv, (d * h - e * g) * inv,
        -(b * i - c * h) * inv, (a * i - c * g) * inv, -(a * h - b * g) * inv,
        (b * f - c * e) * inv, -(a * f - c * d) * inv, (a * e - b * d) * inv,
    ];
}
