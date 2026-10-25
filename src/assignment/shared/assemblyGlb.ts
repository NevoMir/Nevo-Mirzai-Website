// A block assembly as a GLB, and the strict reader the Worker uses to accept one.
//
//   writeAssemblyGlb(descriptor, meta?, edit?, optimization?)
//                                        -> bytes. Deterministic: the same input gives the same bytes (the example
//                                           build checks that), and nothing here touches the DOM or three.js, so the
//                                           stabilizer's worker, the Node example script and the tests share it.
//                                           At most one of the three logs (meta = the stabilizer's, edit = a block edit's,
//                                           optimization = the optimizer's).
//   readAssemblyGlb(bytes)               -> the descriptor and the log, or the first thing that is wrong.
//
// The file is the glTF 2.0 container with one node + mesh per role present (named like ROLE_NODE_NAMES, so the viewer's
// Parts list shows "Columns", "Footing", ...), one material per role, 24 vertices (flat normals) and 36 uint16 indices
// per block, in metres, glTF Y-up (the same frame every provider's GLB has: the viewer rotates it to Z-up), origin at
// the grid's minimum corner. scenes[0].extras carries the descriptor ("nevo:assembly") and the log of the version the file is:
// the stabilizer's ("nevo:stabilization"), a block edit's ("nevo:edit") or the optimizer's ("nevo:optimization"), never two:
// a downloaded file explains itself, and the Worker stores exactly what it validated.
//
// The reader accepts only what the writer produces: every vertex, normal and index is checked against the cell it
// belongs to, the JSON chunk is compared with the one the writer would emit, and the padding must be zero. So an
// upload cannot show one assembly and claim another, carry other data, or exceed the sizes the grid allows.
// Measured on 1000 blocks (650 KB): write 4 ms, read 0.8 ms in Node.

import { BLOCK_ROLES, DERIVED_GLB_LIMIT, type BlockRole, type DerivedMeta } from "./contract.ts";
import {
    ASSEMBLY_EXTRAS_KEY,
    ASSEMBLY_GRID,
    CELL_STRIDE,
    EDIT_EXTRAS_KEY,
    OPTIMIZATION_EXTRAS_KEY,
    ROLE_HEX,
    ROLE_NODE_NAMES,
    STABILIZATION_EXTRAS_KEY,
    blockCount,
    parseAssemblyDescriptor,
    type AssemblyDescriptor,
} from "./assembly.ts";
import { checkDerivedMeta } from "./derivedMeta.ts";
import { checkOptimizeMeta, type OptimizeMeta } from "./optimizeMeta.ts";
import { checkVoxelEditLog, type VoxelEditLog } from "./voxelEdit/log.ts";

/** The log of a version, as validated: at most one of the three is set. */
interface AssemblyLog {
    meta: DerivedMeta | null;
    edit: VoxelEditLog | null;
    optimization: OptimizeMeta | null;
}

export const GLB_GENERATOR = "Assembly Studio assembly 1";
/** The JSON chunk of a valid file is about 60 KB (5 numbers per block plus the log); more is refused unread. */
export const MAX_GLB_JSON_BYTES = 192 * 1024;

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const VERTICES = 24;
const INDICES = 36;
const METRES = 0.1; // one block edge

// Cube faces: outward normal (x, y, z) and the four corners, counter-clockwise seen from outside, in the Z-up frame
// of the analysis. Unit-cube coordinates; the writer scales and insets them.
const FACES: ReadonlyArray<{ n: readonly [number, number, number]; c: ReadonlyArray<readonly [number, number, number]> }> = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], c: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
    { n: [0, 1, 0], c: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], c: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
];
const QUAD = [0, 1, 2, 0, 2, 3];

// Per-vertex tables for the allocation-free geometry check in readAssemblyGlb: which corner of the cell each of the 24
// vertices is (0 or 1 per axis, Z-up cell frame), the normal as stored (glTF frame) and the 36 triangle indices.
const CORNER_SEL = new Uint8Array(VERTICES * 3);
const NORMAL_TAB = new Float32Array(VERTICES * 3);
const TRI_TAB = new Uint16Array(INDICES);
{
    let v = 0;
    for (const face of FACES) {
        for (const c of face.c) {
            CORNER_SEL.set(c, v * 3);
            NORMAL_TAB[v * 3] = face.n[0];
            NORMAL_TAB[v * 3 + 1] = face.n[2];
            NORMAL_TAB[v * 3 + 2] = -face.n[1];
            v++;
        }
    }
    for (let f = 0; f < FACES.length; f++) for (let q = 0; q < QUAD.length; q++) TRI_TAB[f * QUAD.length + q] = f * 4 + QUAD[q];
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const roleColor = (role: BlockRole): [number, number, number, number] => {
    const n = Number.parseInt(ROLE_HEX[role].slice(1), 16);
    // Rounded to 6 digits so the JSON text is the same wherever it is produced.
    const lin = (shift: number) => Math.round(srgbToLinear(((n >> shift) & 255) / 255) * 1e6) / 1e6;
    return [lin(16), lin(8), lin(0), 1];
};

interface RolePart {
    role: BlockRole;
    roleIdx: number;
    /** Offsets into descriptor.cells of this role's blocks, ascending. */
    at: number[];
}

function partsOf(d: Pick<AssemblyDescriptor, "cells">): RolePart[] {
    const byRole: number[][] = BLOCK_ROLES.map(() => []);
    for (let n = 0; n < d.cells.length; n += CELL_STRIDE) byRole[d.cells[n + 3]].push(n);
    const parts: RolePart[] = [];
    BLOCK_ROLES.forEach((role, roleIdx) => {
        if (byRole[roleIdx].length > 0) parts.push({ role, roleIdx, at: byRole[roleIdx] });
    });
    return parts;
}

/** Corner of block (i, j, k) as stored: glTF (x, y, z) = (X, Z, -Y) of the Z-up frame, in metres. */
function corner(d: Pick<AssemblyDescriptor, "inset">, i: number, j: number, k: number, c: readonly [number, number, number]): [number, number, number] {
    const lo = (1 - d.inset) / 2;
    const x = (i + lo + c[0] * d.inset) * METRES;
    const y = (j + lo + c[1] * d.inset) * METRES;
    const z = (k + lo + c[2] * d.inset) * METRES;
    return [x, z, -y];
}

/** Byte layout of the BIN chunk: per part positions, normals, indices (all multiples of 4 bytes, so no padding). */
interface Layout {
    parts: RolePart[];
    offsets: Array<{ pos: number; nrm: number; idx: number; count: number }>;
    binBytes: number;
}

function layoutOf(parts: RolePart[]): Layout {
    let at = 0;
    const offsets = parts.map((part) => {
        const count = part.at.length;
        const entry = { pos: at, nrm: at + count * VERTICES * 12, idx: at + count * VERTICES * 24, count };
        at = entry.idx + count * INDICES * 2;
        return entry;
    });
    return { parts, offsets, binBytes: at };
}

/** The glTF JSON for a layout. Built the same way by the writer and by the reader's comparison. */
function buildJson(d: AssemblyDescriptor, log: AssemblyLog, layout: Layout, bounds: Array<{ min: number[]; max: number[] }>): Record<string, unknown> {
    const nodes: unknown[] = [];
    const meshes: unknown[] = [];
    const materials: unknown[] = [];
    const accessors: unknown[] = [];
    const bufferViews: unknown[] = [];
    layout.parts.forEach((part, m) => {
        const o = layout.offsets[m];
        const first = bufferViews.length;
        bufferViews.push(
            { buffer: 0, byteOffset: o.pos, byteLength: o.count * VERTICES * 12, target: ARRAY_BUFFER },
            { buffer: 0, byteOffset: o.nrm, byteLength: o.count * VERTICES * 12, target: ARRAY_BUFFER },
            { buffer: 0, byteOffset: o.idx, byteLength: o.count * INDICES * 2, target: ELEMENT_ARRAY_BUFFER },
        );
        const a = accessors.length;
        accessors.push(
            { bufferView: first, componentType: FLOAT, count: o.count * VERTICES, type: "VEC3", min: bounds[m].min, max: bounds[m].max },
            { bufferView: first + 1, componentType: FLOAT, count: o.count * VERTICES, type: "VEC3" },
            { bufferView: first + 2, componentType: UNSIGNED_SHORT, count: o.count * INDICES, type: "SCALAR" },
        );
        materials.push({ name: `role:${part.role}`, pbrMetallicRoughness: { baseColorFactor: roleColor(part.role), metallicFactor: 0, roughnessFactor: 0.85 } });
        meshes.push({ name: ROLE_NODE_NAMES[part.role], primitives: [{ attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: m, mode: 4 }] });
        nodes.push({ name: ROLE_NODE_NAMES[part.role], mesh: m });
    });
    const extras: Record<string, unknown> = { [ASSEMBLY_EXTRAS_KEY]: d };
    if (log.meta) extras[STABILIZATION_EXTRAS_KEY] = log.meta;
    if (log.edit) extras[EDIT_EXTRAS_KEY] = log.edit;
    if (log.optimization) extras[OPTIMIZATION_EXTRAS_KEY] = log.optimization;
    return {
        asset: { version: "2.0", generator: GLB_GENERATOR },
        scene: 0,
        scenes: [{ name: "Assembly", nodes: nodes.map((_, i) => i), extras }],
        nodes,
        meshes,
        materials,
        accessors,
        bufferViews,
        buffers: [{ byteLength: layout.binBytes }],
    };
}

/** Writes block (i, j, k) as vertices [vertex, vertex + 24) and indices [tri, tri + 36); extends `min`/`max` over the float32 positions. */
function fillBlock(
    inset: number,
    i: number,
    j: number,
    k: number,
    pos: Float32Array,
    nrm: Float32Array,
    idx: Uint16Array,
    vertex: number,
    tri: number,
    min: number[],
    max: number[],
): void {
    let v = vertex;
    let t = tri;
    for (const face of FACES) {
        const base = v - vertex; // indices are relative to the block's own first vertex; the caller adds the block's offset
        for (const c of face.c) {
            const p = corner({ inset }, i, j, k, c);
            pos[v * 3] = p[0];
            pos[v * 3 + 1] = p[1];
            pos[v * 3 + 2] = p[2];
            // The float32 value is what the file holds, so the bounds are taken from it.
            for (let a = 0; a < 3; a++) {
                if (pos[v * 3 + a] < min[a]) min[a] = pos[v * 3 + a];
                if (pos[v * 3 + a] > max[a]) max[a] = pos[v * 3 + a];
            }
            nrm[v * 3] = face.n[0];
            nrm[v * 3 + 1] = face.n[2];
            nrm[v * 3 + 2] = -face.n[1];
            v++;
        }
        for (const q of QUAD) idx[t++] = base + q;
    }
}

/** Fills one part's vertex, normal and index arrays, and returns its position bounds. */
function fillPart(d: AssemblyDescriptor, part: RolePart, pos: Float32Array, nrm: Float32Array, idx: Uint16Array): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    part.at.forEach((n, b) => {
        fillBlock(d.inset, d.cells[n], d.cells[n + 1], d.cells[n + 2], pos, nrm, idx, b * VERTICES, b * INDICES, min, max);
        // Make this block's indices absolute within the mesh.
        for (let q = 0; q < INDICES; q++) idx[b * INDICES + q] += b * VERTICES;
    });
    return { min, max };
}

/**
 * The assembly as GLB bytes. `metaIn` is the stabilizer's log (kind "stabilized"), `editIn` a block edit's (kind "edited", target
 * "voxel"), `optimizationIn` the optimizer's (kind "optimized"); all absent for a plain assembly, and at most one set. The log is
 * rebuilt by the same validator the reader uses before it is written, so a file always carries its canonical form
 * (and a log that would be refused on upload throws here, in the browser, instead). Throws RangeError on a bad descriptor.
 */
export function writeAssemblyGlb(
    descriptor: AssemblyDescriptor,
    metaIn: DerivedMeta | null = null,
    editIn: VoxelEditLog | null = null,
    optimizationIn: OptimizeMeta | null = null,
): Uint8Array {
    if (!parseAssemblyDescriptor(descriptor)) throw new RangeError("The assembly is not a valid canonical block list.");
    if ([metaIn, editIn, optimizationIn].filter(Boolean).length > 1) throw new RangeError("A file carries one log: the stabilizer's, an edit's or the optimizer's.");
    const log: AssemblyLog = { meta: null, edit: null, optimization: null };
    if (metaIn) {
        const checked = checkDerivedMeta(metaIn, null);
        if (!checked.ok) throw new RangeError(`The stabilizer's log is invalid (${checked.error}).`);
        log.meta = checked.value;
    }
    if (editIn) {
        const checked = checkVoxelEditLog(editIn, null);
        if (!checked.ok) throw new RangeError(`The edit log is invalid (${checked.error}).`);
        log.edit = checked.value;
    }
    if (optimizationIn) {
        const checked = checkOptimizeMeta(optimizationIn, null);
        if (!checked.ok) throw new RangeError(`The optimization log is invalid (${checked.error}).`);
        log.optimization = checked.value;
    }
    const parts = partsOf(descriptor);
    const layout = layoutOf(parts);
    const bin = new Uint8Array(layout.binBytes);
    const bounds = parts.map((part, m) => {
        const o = layout.offsets[m];
        const pos = new Float32Array(bin.buffer, o.pos, o.count * VERTICES * 3);
        const nrm = new Float32Array(bin.buffer, o.nrm, o.count * VERTICES * 3);
        const idx = new Uint16Array(bin.buffer, o.idx, o.count * INDICES);
        return fillPart(descriptor, part, pos, nrm, idx);
    });
    const jsonBytes = new TextEncoder().encode(JSON.stringify(buildJson(descriptor, log, layout, bounds)));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const jsonLength = jsonBytes.length + jsonPad;
    const total = 12 + 8 + jsonLength + 8 + bin.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength); // JSON padding is spaces
    const binAt = 20 + jsonLength;
    view.setUint32(binAt, bin.length, true);
    view.setUint32(binAt + 4, CHUNK_BIN, true);
    out.set(bin, binAt + 8);
    return out;
}

/** `meta`, `edit` and `optimization` are the three possible logs: at most one is non-null (a file with more is refused). */
export type ReadAssemblyResult =
    | { ok: true; descriptor: AssemblyDescriptor; meta: DerivedMeta | null; edit: VoxelEditLog | null; optimization: OptimizeMeta | null; blocks: number }
    | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * Reads a GLB made by writeAssemblyGlb and refuses everything else. `now` caps the meta's `created_at` (null: as is).
 * The default is no cap, not the clock: a file that is valid today must not be refused on a machine whose clock is behind,
 * so only a caller that wants a "not from the future" check passes the time (no caller does today).
 */
export function readAssemblyGlb(bytes: Uint8Array, now: number | null = null): ReadAssemblyResult {
    if (bytes.byteLength < 28 || bytes.byteLength > DERIVED_GLB_LIMIT) return bad("The file has the wrong size for a block assembly.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) return bad("The file is not a complete GLB.");
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength === 0 || jsonLength > MAX_GLB_JSON_BYTES || jsonLength % 4 !== 0 || 20 + jsonLength + 8 > bytes.byteLength) {
        return bad("The GLB's JSON chunk is missing or too large.");
    }
    const jsonRaw = bytes.subarray(20, 20 + jsonLength);
    let doc: unknown;
    try {
        doc = JSON.parse(new TextDecoder().decode(jsonRaw));
    } catch {
        return bad("The GLB's JSON chunk is not valid JSON.");
    }
    const scene = (doc as { scenes?: Array<{ extras?: Record<string, unknown> }> } | null)?.scenes?.[0];
    const descriptor = parseAssemblyDescriptor(scene?.extras?.[ASSEMBLY_EXTRAS_KEY]);
    if (!descriptor) return bad("The GLB does not describe a valid block assembly.");
    const log: AssemblyLog = { meta: null, edit: null, optimization: null };
    const extras = scene?.extras ?? {};
    const rawMeta = extras[STABILIZATION_EXTRAS_KEY];
    const rawEdit = extras[EDIT_EXTRAS_KEY];
    const rawOptimization = extras[OPTIMIZATION_EXTRAS_KEY];
    if ([rawMeta, rawEdit, rawOptimization].filter((raw) => raw !== undefined).length > 1) return bad("The GLB carries more than one log.");
    if (rawMeta !== undefined) {
        const checked = checkDerivedMeta(rawMeta, now);
        if (!checked.ok) return bad(`The stabilizer's log is invalid (${checked.error}).`);
        log.meta = checked.value;
    } else if (rawEdit !== undefined) {
        const checked = checkVoxelEditLog(rawEdit, now);
        if (!checked.ok) return bad(`The edit log is invalid (${checked.error}).`);
        log.edit = checked.value;
    } else if (rawOptimization !== undefined) {
        const checked = checkOptimizeMeta(rawOptimization, now);
        if (!checked.ok) return bad(`The optimization log is invalid (${checked.error}).`);
        log.optimization = checked.value;
    }

    // The binary chunk: exact size, then every number against the cell it belongs to.
    const parts = partsOf(descriptor);
    const layout = layoutOf(parts);
    const binAt = 20 + jsonLength;
    const binLength = view.getUint32(binAt, true);
    if (view.getUint32(binAt + 4, true) !== CHUNK_BIN || binLength !== layout.binBytes || binAt + 8 + binLength !== bytes.byteLength) {
        return bad("The GLB's binary chunk does not match the assembly.");
    }
    const bounds: Array<{ min: number[]; max: number[] }> = [];
    // The binary chunk starts at a multiple of 4 in a valid file (the JSON is padded), but `bytes` may begin anywhere.
    const binBytes = bytes.slice(binAt + 8, binAt + 8 + binLength);
    const inset = descriptor.inset;
    const lo = (1 - inset) / 2;
    // The same expressions as corner(), rounded to float32 as stored: one value per cell index and side, not per vertex.
    const side = (cell: number, upper: number) => Math.fround((cell + lo + upper * inset) * METRES);
    for (let m = 0; m < parts.length; m++) {
        const o = layout.offsets[m];
        const name = ROLE_NODE_NAMES[parts[m].role];
        const pos = new Float32Array(binBytes.buffer, o.pos, o.count * VERTICES * 3);
        const nrm = new Float32Array(binBytes.buffer, o.nrm, o.count * VERTICES * 3);
        const idx = new Uint16Array(binBytes.buffer, o.idx, o.count * INDICES);
        let minI = ASSEMBLY_GRID, maxI = -1, minJ = ASSEMBLY_GRID, maxJ = -1, minK = ASSEMBLY_GRID, maxK = -1;
        for (let b = 0; b < o.count; b++) {
            const n = parts[m].at[b];
            const i = descriptor.cells[n];
            const j = descriptor.cells[n + 1];
            const k = descriptor.cells[n + 2];
            if (i < minI) minI = i;
            if (i > maxI) maxI = i;
            if (j < minJ) minJ = j;
            if (j > maxJ) maxJ = j;
            if (k < minK) minK = k;
            if (k > maxK) maxK = k;
            // glTF (x, y, z) = (X, Z, -Y) of the Z-up cell frame.
            const x0 = side(i, 0);
            const x1 = side(i, 1);
            const y0 = -side(j, 0);
            const y1 = -side(j, 1);
            const z0 = side(k, 0);
            const z1 = side(k, 1);
            const p = b * VERTICES * 3;
            for (let q = 0; q < VERTICES * 3; q += 3) {
                if (pos[p + q] !== (CORNER_SEL[q] ? x1 : x0) || pos[p + q + 1] !== (CORNER_SEL[q + 2] ? z1 : z0) || pos[p + q + 2] !== (CORNER_SEL[q + 1] ? y1 : y0)) {
                    return bad(`The GLB's geometry does not match block ${b} of ${name}.`);
                }
                if (nrm[p + q] !== NORMAL_TAB[q] || nrm[p + q + 1] !== NORMAL_TAB[q + 1] || nrm[p + q + 2] !== NORMAL_TAB[q + 2]) {
                    return bad(`The GLB's geometry does not match block ${b} of ${name}.`);
                }
            }
            const first = b * INDICES;
            for (let q = 0; q < INDICES; q++) {
                if (idx[first + q] !== b * VERTICES + TRI_TAB[q]) return bad(`The GLB's indices do not match block ${b} of ${name}.`);
            }
        }
        // The float32 bounds of the part: rounding is monotonic, so they come from the extreme cells.
        bounds.push({
            min: [side(minI, 0), side(minK, 0), -side(maxJ, 1)],
            max: [side(maxI, 1), side(maxK, 1), -side(minJ, 0)],
        });
    }
    // The JSON chunk must be exactly what the writer would emit for this content (trailing spaces are padding).
    const expectedJson = new TextEncoder().encode(JSON.stringify(buildJson(descriptor, log, layout, bounds)));
    if (expectedJson.length > jsonRaw.length || jsonRaw.length - expectedJson.length > 3) return bad("The GLB's JSON chunk has unexpected content.");
    for (let q = 0; q < expectedJson.length; q++) if (jsonRaw[q] !== expectedJson[q]) return bad("The GLB's JSON chunk has unexpected content.");
    for (let q = expectedJson.length; q < jsonRaw.length; q++) if (jsonRaw[q] !== 0x20) return bad("The GLB's JSON chunk has unexpected content.");
    return { ok: true, descriptor, meta: log.meta, edit: log.edit, optimization: log.optimization, blocks: blockCount(descriptor) };
}
