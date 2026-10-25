// POST /models/:sourceId/edited?job=<jobId>: stores the GLB the browser made for a finished mesh edit (spec 3.5).
//
// A mesh edit is planned on the queue (the job ends "succeeded" with the program in jobs.plan and no model), run in the browser on
// the person's own copy of the file, and the result comes back here: 15 to 28 MB, far over what a Free-plan Worker may read in
// JavaScript (10 ms of CPU). So, like worker/glb.ts storeStreamed, the body is piped straight into R2 (FixedLengthStream, a server-chosen
// key `models/<uuid>.glb`) without being touched, and only the header and the JSON chunk are read back (a few KB). What is checked:
//
//   - the job exists, is an edit job of target "mesh" on this very source, has succeeded, and has no model yet (a retry of an upload that
//     did get through is answered with the model that is there: 200, nothing stored twice);
//   - the file is a GLB 2.0 whose JSON chunk is at most 256 KB, whose buffers carry no URI but "data:" and whose pictures live in the BIN
//     chunk, whose extensions are only those the editor writes, that has at most 200 nodes (a tree, no cycles), triangles only, at most
//     MAX_EDIT_TRIANGLES of them and 3 times as many points, no skeleton or animation, whose buffer views and accessors lie inside its BIN
//     chunk (the views add up to no more than twice its length; a stride is at least the size of what it strides over), and whose pictures
//     are PNG or JPEG of at most 4096 x 4096 pixels (read from their own headers, a ranged read of R2 each: checkEditedImages);
//   - the job's stored plan says the edit changed something (applied), so a job the model could not carry out never takes an upload;
//   - the record (models.meta, EditMeta) is built here from the job row and its stored plan, never from anything the client says (D15);
//   - the number of versions per source, per project and of mesh edits per project are conditions of the INSERT itself (a COUNT before it
//     would let parallel requests all pass), and the daily counter of uploads (usage.edited) is one atomic upsert.
// The geometry bytes are never read, so garbage triangles inside those bounds can still be saved. What is bounded is what makes a viewer run
// out of memory or time on opening the version, because the API has no owner and everyone can open any project: the number of points and
// triangles, the bytes the accessors add up to (with a stride that cannot be smaller than the data), and the pixels of every picture (the
// browser decodes each to 4 bytes a pixel, whatever the file size: a 400 KB PNG can declare 20000 x 20000).
//
// CPU: the 28 MB body is never in JavaScript. What runs is reading the 20-byte header, the JSON chunk (<= 256 KB, about 1 ms to parse and
// check in Node), the first 128 KB of each picture (a copy, no decoding) and a few queries.

import {
    EDITED_GLB_LIMIT,
    EDIT_META_LIMIT,
    MAX_EDIT_TRIANGLES,
    MAX_MESH_EDITS_PER_PROJECT,
    MAX_VERSIONS_PER_PROJECT,
    MAX_VERSIONS_PER_SOURCE,
    MAX_VERSION_DEPTH,
    type EditMeta,
    type ModelAsset,
    type ModelKind,
} from "../src/assignment/shared/contract.ts";
import type { MeshProgram } from "../src/assignment/shared/meshProgram.ts";
import { readEditMeta, representationOf, stabilizationsOf } from "../src/assignment/shared/versionMeta.ts";
import { MODEL_COLS, readStoredEditResult, toModelAsset, touchProject, type ModelRow } from "./db.ts";
import { GLB_CONTENT_TYPE } from "./glb.ts";
import type { Env } from "./providers/types.ts";
import { HttpError, errorSummary, imageSize, isRecord, nowIso, requireUuid, sniffImageType } from "./util.ts";
import { MESH_EDITS_SQL, refundUpload, reserveUpload } from "./versions.ts";

/** The JSON chunk of an edited model (nodes, accessors, materials of up to MAX_ADDED_PARTS parts) is a few KB; this is the most one may be. */
export const MAX_EDITED_JSON_BYTES = 256 * 1024;
export const MAX_EDITED_NODES = 200;
const MAX_ACCESSOR_COUNT = 10_000_000;
/** Points of all the meshes the nodes draw: an unwelded mesh of MAX_EDIT_TRIANGLES triangles has 3 per triangle, so no real file is above this. */
export const MAX_EDITED_VERTICES = 3 * MAX_EDIT_TRIANGLES;
/** Bytes the accessors of all drawn primitives add up to (what the viewer holds as typed arrays): the file's own limit, 4 times over for widening. */
export const MAX_EDITED_GEOMETRY_BYTES = 4 * EDITED_GLB_LIMIT;
const MAX_PRIMITIVE_ATTRIBUTES = 16;
/** A picture's side and pixels: the Hunyuan texture is 4096 x 4096, the biggest the editor keeps. */
export const MAX_EDITED_IMAGE_SIDE = 4096;
export const MAX_EDITED_IMAGE_PIXELS = 4096 * 4096;
/** All pictures together: four of the largest. The viewer decodes each to 4 bytes a pixel (268 MB for these). */
export const MAX_EDITED_IMAGES_PIXELS = 4 * MAX_EDITED_IMAGE_PIXELS;
/** How much of a picture is read to find its size: a PNG needs 33 bytes, a JPEG as far as its first frame header (after the metadata segments). */
const IMAGE_HEAD_BYTES = 128 * 1024;
const MAX_TREE_DEPTH = 64;
/** The glTF extensions an edited model may use: what the Hunyuan files carry and what the editor writes. */
export const EDITED_EXTENSIONS: readonly string[] = ["KHR_materials_specular", "KHR_texture_transform", "KHR_materials_unlit"];

// ---------- reading the file's own description of itself ----------

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

export interface GlbLayout {
    jsonLength: number;
    /** The BIN chunk's payload length, 0 when the file has none. */
    binLength: number;
}

/** The 20-byte header: magic, version, the declared length (must be the file's size) and the JSON chunk's header. */
export function readEditedHeader(head: Uint8Array, size: number): number {
    if (head.byteLength < 20) throw new HttpError(400, "The edited model is not a GLB file.");
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (view.getUint32(0, true) !== GLB_MAGIC) throw new HttpError(400, "The edited model is not a GLB file.");
    if (view.getUint32(4, true) !== 2) throw new HttpError(400, "The edited model is not a GLB 2.0 file.");
    if (view.getUint32(8, true) !== size) throw new HttpError(400, "The edited model's length does not match its header.");
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== CHUNK_JSON || jsonLength === 0) throw new HttpError(400, "The edited model is malformed.");
    if (jsonLength > MAX_EDITED_JSON_BYTES) throw new HttpError(400, "The edited model's description is too large.");
    if (20 + jsonLength > size) throw new HttpError(400, "The edited model is incomplete.");
    return jsonLength;
}

/** The header of the BIN chunk that follows the JSON chunk (8 bytes), or none. Returns the payload length. */
export function readEditedBinHeader(chunk: Uint8Array, jsonLength: number, size: number): number {
    const at = 20 + jsonLength;
    if (at === size) return 0;
    if (chunk.byteLength < 8) throw new HttpError(400, "The edited model is malformed.");
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const binLength = view.getUint32(0, true);
    if (view.getUint32(4, true) !== CHUNK_BIN) throw new HttpError(400, "The edited model has an unexpected part after its description.");
    if (at + 8 + binLength > size) throw new HttpError(400, "The edited model is incomplete.");
    return binLength;
}

const TYPE_WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

const isIndex = (value: unknown, length: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length;
const isList = (value: unknown): value is unknown[] => Array.isArray(value);
/** Nodes that draw a mesh: the parts of an assembly (what `countMeshNodes` in glb.ts counts for a generated model). The source's own count is wrong once a program adds or removes parts. */
export const countMeshNodes = (json: unknown): number => {
    const nodes = isRecord(json) && isList(json.nodes) ? json.nodes : [];
    return nodes.filter((node) => isRecord(node) && typeof node.mesh === "number").length;
};

/** The extensions named anywhere in the document (every object's "extensions" keys), at most a few hundred. */
function extensionNames(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 12 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
        for (const item of value) extensionNames(item, out, depth + 1);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "extensions" && isRecord(child)) for (const name of Object.keys(child)) out.add(name);
        else if (key !== "extras") extensionNames(child, out, depth + 1);
    }
}

/**
 * Checks the parsed JSON chunk of an edited GLB against the rules of spec 3.5. Returns what is wrong in a sentence, or null when it is
 * acceptable. Pure (no Workers APIs), so the Node tests run it directly.
 */
export function checkEditedGlbJson(raw: unknown, binLength: number): string | null {
    if (!isRecord(raw)) return "The edited model's description is not an object.";
    if (!isRecord(raw.asset) || raw.asset.version !== "2.0") return "The edited model is not glTF 2.0.";

    // Extensions: declared, and used anywhere.
    for (const key of ["extensionsUsed", "extensionsRequired"] as const) {
        const list = raw[key];
        if (list === undefined) continue;
        if (!isList(list) || list.length > 20 || list.some((e) => typeof e !== "string")) return `The edited model's ${key} is not valid.`;
        const bad = (list as string[]).find((e) => !EDITED_EXTENSIONS.includes(e));
        if (bad) return `The edited model uses an extension that is not allowed (${bad.slice(0, 40)}).`;
    }
    const named = new Set<string>();
    extensionNames(raw, named);
    for (const name of named) if (!EDITED_EXTENSIONS.includes(name)) return `The edited model uses an extension that is not allowed (${name.slice(0, 40)}).`;

    // Buffers and images: nothing outside the file.
    const buffers = raw.buffers === undefined ? [] : raw.buffers;
    if (!isList(buffers) || buffers.length > 1) return "The edited model must have one buffer.";
    for (const buffer of buffers) {
        if (!isRecord(buffer) || typeof buffer.byteLength !== "number" || buffer.byteLength < 0) return "The edited model's buffer is not valid.";
        if (buffer.uri !== undefined && !(typeof buffer.uri === "string" && buffer.uri.startsWith("data:"))) return "The edited model refers to a file outside itself.";
    }
    const images = raw.images === undefined ? [] : raw.images;
    if (!isList(images) || images.length > 20) return "The edited model's pictures are not valid.";
    for (const image of images) {
        if (!isRecord(image)) return "The edited model's pictures are not valid.";
        if (image.uri !== undefined) {
            // A data: picture would hide its size in the JSON chunk's text, out of reach of the header check; the editor never writes one.
            return typeof image.uri === "string" && image.uri.startsWith("data:") ? "The edited model's pictures must be stored in the model's data part." : "The edited model refers to a picture outside itself.";
        }
        if (image.mimeType !== undefined && image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") return "The edited model has a picture in an unsupported format.";
        if (image.bufferView === undefined) return "The edited model's pictures are not valid.";
    }

    // Buffer views and accessors lie inside the BIN chunk.
    const views = raw.bufferViews === undefined ? [] : raw.bufferViews;
    if (!isList(views) || views.length > 2000) return "The edited model's buffer views are not valid.";
    const viewLength: number[] = [];
    let viewTotal = 0;
    for (const view of views) {
        if (!isRecord(view) || view.buffer !== 0 || typeof view.byteLength !== "number" || !Number.isInteger(view.byteLength) || view.byteLength <= 0) return "The edited model's buffer views are not valid.";
        const offset = view.byteOffset === undefined ? 0 : view.byteOffset;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset + view.byteLength > binLength) return "The edited model's data lies outside its file.";
        // glTF: a stride is 4 to 252 bytes (0 is read as "tightly packed"). A stride of 1 over 3-float elements would let a few bytes claim millions of points.
        const stride = view.byteStride;
        if (stride !== undefined && (typeof stride !== "number" || !Number.isInteger(stride) || (stride !== 0 && (stride < 4 || stride > 252)))) return "The edited model's buffer views are not valid.";
        viewLength.push(view.byteLength);
        // A loader copies each view it needs. The views of a file are pieces of its BIN chunk, so together they are no longer than it (twice,
        // for a writer that shares bytes between two views); 2000 views of the whole chunk each would be 96 GB of copies.
        viewTotal += view.byteLength;
        if (viewTotal > 2 * binLength) return "The edited model's buffer views add up to more than its data.";
    }
    for (const image of images) if (isRecord(image) && image.bufferView !== undefined && !isIndex(image.bufferView, views.length)) return "The edited model's picture lies outside its file.";
    const accessors = raw.accessors === undefined ? [] : raw.accessors;
    if (!isList(accessors) || accessors.length > 4000) return "The edited model's accessors are not valid.";
    const counts: number[] = [];
    /** Bytes of one element of each accessor, as the viewer holds it. */
    const elementBytes: number[] = [];
    for (const accessor of accessors) {
        if (!isRecord(accessor) || accessor.sparse !== undefined) return "The edited model's accessors are not valid.";
        const size = COMPONENT_SIZE[accessor.componentType as number];
        const width = TYPE_WIDTH[accessor.type as string];
        const count = accessor.count;
        if (size === undefined || width === undefined || typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > MAX_ACCESSOR_COUNT) return "The edited model's accessors are not valid.";
        if (!isIndex(accessor.bufferView, views.length)) return "The edited model's accessors are not valid.";
        const view = views[accessor.bufferView] as Record<string, unknown>;
        const stride = typeof view.byteStride === "number" && view.byteStride > 0 ? view.byteStride : size * width;
        // Elements do not overlap: with a smaller stride the same few bytes would serve as every one of millions of elements.
        if (stride < size * width) return "The edited model's accessors are not valid.";
        const offset = accessor.byteOffset === undefined ? 0 : accessor.byteOffset;
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return "The edited model's accessors are not valid.";
        const need = offset + (count > 0 ? (count - 1) * stride + size * width : 0);
        if (need > viewLength[accessor.bufferView]) return "The edited model's data lies outside its file.";
        counts.push(count);
        elementBytes.push(size * width);
    }

    // The editor refuses a model with a skeleton or an animation (edit/readMeshGlb.ts), so the file it writes has none; each would add accessors the checks below do not count.
    for (const key of ["skins", "animations"] as const) if (raw[key] !== undefined && !(isList(raw[key]) && raw[key].length === 0)) return "The edited model cannot carry an animation or a skeleton.";

    // Materials, textures, meshes.
    const materials = raw.materials === undefined ? [] : raw.materials;
    const textures = raw.textures === undefined ? [] : raw.textures;
    if (!isList(materials) || !isList(textures) || materials.length > 500 || textures.length > 20) return "The edited model's materials are not valid.";
    for (const texture of textures) if (!isRecord(texture) || (texture.source !== undefined && !isIndex(texture.source, images.length))) return "The edited model's textures are not valid.";
    const meshes = raw.meshes;
    if (!isList(meshes) || meshes.length === 0 || meshes.length > 500) return "The edited model has no mesh.";
    const trianglesOfMesh: number[] = [];
    const verticesOfMesh: number[] = [];
    const bytesOfMesh: number[] = [];
    for (const mesh of meshes) {
        if (!isRecord(mesh) || !isList(mesh.primitives) || mesh.primitives.length === 0 || mesh.primitives.length > 8) return "The edited model's meshes are not valid.";
        let triangles = 0;
        let vertices = 0;
        let bytes = 0;
        for (const prim of mesh.primitives) {
            if (!isRecord(prim) || !isRecord(prim.attributes)) return "The edited model's meshes are not valid.";
            const attributes = Object.values(prim.attributes);
            if (attributes.length > MAX_PRIMITIVE_ATTRIBUTES) return "The edited model's meshes are not valid.";
            let points = 0;
            for (const value of attributes) {
                if (!isIndex(value, accessors.length)) return "The edited model's meshes are not valid.";
                points = Math.max(points, counts[value]);
                bytes += counts[value] * elementBytes[value];
            }
            if (prim.indices !== undefined) {
                if (!isIndex(prim.indices, accessors.length)) return "The edited model's meshes are not valid.";
                bytes += counts[prim.indices] * elementBytes[prim.indices];
            }
            // Morph targets are more attributes of the same points.
            if (prim.targets !== undefined) {
                if (!isList(prim.targets) || prim.targets.length > 32) return "The edited model's meshes are not valid.";
                for (const target of prim.targets) {
                    if (!isRecord(target)) return "The edited model's meshes are not valid.";
                    for (const value of Object.values(target)) {
                        if (!isIndex(value, accessors.length)) return "The edited model's meshes are not valid.";
                        bytes += counts[value] * elementBytes[value];
                    }
                }
            }
            if (prim.material !== undefined && !isIndex(prim.material, materials.length)) return "The edited model's meshes are not valid.";
            // Triangles only: a strip or a fan of a few million indices would draw millions of triangles that the count below does not see.
            if (prim.mode !== undefined && prim.mode !== 4) return "The edited model must be made of triangles.";
            const position = prim.attributes.POSITION;
            const used = prim.indices !== undefined ? counts[prim.indices as number] : isIndex(position, accessors.length) ? counts[position as number] : 0;
            triangles += Math.floor(used / 3);
            vertices += points;
        }
        trianglesOfMesh.push(triangles);
        verticesOfMesh.push(vertices);
        bytesOfMesh.push(bytes);
    }

    // Nodes: a tree, not too many, and the triangles they draw.
    const nodes = raw.nodes;
    if (!isList(nodes) || nodes.length === 0) return "The edited model has no nodes.";
    if (nodes.length > MAX_EDITED_NODES) return `The edited model has too many parts (more than ${MAX_EDITED_NODES}).`;
    const parent = new Array<number>(nodes.length).fill(-1);
    let triangles = 0;
    let vertices = 0;
    let geometryBytes = 0;
    for (const [index, node] of nodes.entries()) {
        if (!isRecord(node)) return "The edited model's nodes are not valid.";
        if (node.mesh !== undefined) {
            if (!isIndex(node.mesh, meshes.length)) return "The edited model's nodes are not valid.";
            // Once per node that draws the mesh: that is how often the viewer builds it.
            triangles += trianglesOfMesh[node.mesh];
            vertices += verticesOfMesh[node.mesh];
            geometryBytes += bytesOfMesh[node.mesh];
        }
        if (node.children !== undefined) {
            if (!isList(node.children) || node.children.length > MAX_EDITED_NODES) return "The edited model's nodes are not valid.";
            for (const child of node.children) {
                if (!isIndex(child, nodes.length) || parent[child] !== -1 || child === index) return "The edited model's nodes are not a tree.";
                parent[child] = index;
            }
        }
    }
    for (let start = 0; start < nodes.length; start++) {
        let at = start;
        for (let depth = 0; parent[at] !== -1; depth++) {
            if (depth > MAX_TREE_DEPTH) return "The edited model's nodes are not a tree.";
            at = parent[at];
        }
    }
    if (triangles === 0) return "The edited model has no triangles.";
    if (triangles > MAX_EDIT_TRIANGLES) return "The edited model has too many triangles to save.";
    if (vertices > MAX_EDITED_VERTICES || geometryBytes > MAX_EDITED_GEOMETRY_BYTES) return "The edited model has too many points to save.";
    const scenes = raw.scenes;
    if (!isList(scenes) || scenes.length === 0) return "The edited model has no scene.";
    for (const scene of scenes) {
        if (!isRecord(scene)) return "The edited model's scenes are not valid.";
        if (scene.nodes !== undefined && (!isList(scene.nodes) || scene.nodes.length > MAX_EDITED_NODES || !scene.nodes.every((n) => isIndex(n, nodes.length)))) return "The edited model's scenes are not valid.";
    }
    return null;
}

/**
 * The pictures of an edited GLB that passed checkEditedGlbJson: each is a PNG or a JPEG (by its first bytes, whatever it says it is), its
 * size is read from its own header (nothing is decoded) and is at most MAX_EDITED_IMAGE_SIDE a side and MAX_EDITED_IMAGE_PIXELS in all, and
 * all of them together are at most MAX_EDITED_IMAGES_PIXELS. `readPart(offset, length)` returns up to `length` bytes of the BIN chunk from
 * `offset` (a ranged read of R2 in the handler, a slice in the tests). Returns what is wrong in a sentence, or null.
 */
export async function checkEditedImages(raw: unknown, readPart: (offset: number, length: number) => Promise<Uint8Array>): Promise<string | null> {
    if (!isRecord(raw) || !isList(raw.images) || raw.images.length === 0) return null;
    const views = isList(raw.bufferViews) ? raw.bufferViews : [];
    const heads = await Promise.all(
        raw.images.map(async (image) => {
            const view = isRecord(image) && isIndex(image.bufferView, views.length) ? views[image.bufferView] : null;
            if (!isRecord(view) || typeof view.byteLength !== "number" || !Number.isInteger(view.byteLength) || view.byteLength <= 0) return null;
            const offset = view.byteOffset === undefined ? 0 : view.byteOffset;
            if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
            return { head: await readPart(offset, Math.min(view.byteLength, IMAGE_HEAD_BYTES)), length: view.byteLength, mimeType: (image as Record<string, unknown>).mimeType };
        }),
    );
    let pixels = 0;
    let bytes = 0;
    for (const part of heads) {
        if (part === null) return "The edited model's pictures are not valid.";
        const type = sniffImageType(part.head);
        if (type !== "image/png" && type !== "image/jpeg") return "The edited model has a picture in an unsupported format.";
        if (part.mimeType !== undefined && part.mimeType !== type) return "The edited model has a picture that is not the format it says.";
        const size = imageSize(part.head, type);
        if (!size || size.width < 1 || size.height < 1) return "The size of a picture in the edited model could not be read.";
        if (size.width > MAX_EDITED_IMAGE_SIDE || size.height > MAX_EDITED_IMAGE_SIDE || size.width * size.height > MAX_EDITED_IMAGE_PIXELS) {
            return `The edited model has a picture that is too large (at most ${MAX_EDITED_IMAGE_SIDE} x ${MAX_EDITED_IMAGE_SIDE} pixels).`;
        }
        pixels += size.width * size.height;
        bytes += part.length;
    }
    if (pixels > MAX_EDITED_IMAGES_PIXELS) return "The pictures of the edited model are too large together.";
    if (bytes > EDITED_GLB_LIMIT) return "The pictures of the edited model are too large together.";
    return null;
}

// ---------- the record (EditMeta) ----------

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** The version's short name, from the person's words ("Make the backrest taller"), cut at a word. */
export function editLabel(instruction: string): string {
    const flat = instruction.replace(/\s+/g, " ").trim();
    if (!flat) return "Edited";
    const text = flat[0].toUpperCase() + flat.slice(1);
    if (text.length <= 40) return text;
    const room = text.slice(0, 39);
    const space = room.lastIndexOf(" ");
    return `${(space >= 16 ? room.slice(0, space) : room).replace(/[\s,.;:!?-]+$/, "")}…`;
}

export interface MeshEditRecordInput {
    instruction: string;
    plan: { summary: string; notes: string[]; program?: MeshProgram } | null;
    depth: number;
    stabilizedDepth: number;
    jobId: string;
    engine: string;
    createdAt: string;
}

/** The EditMeta of a mesh edit, built from the job (D15). Bounded: it is stored in models.meta, which every project read parses. */
export function buildMeshEditMeta(input: MeshEditRecordInput): EditMeta {
    const program = input.plan?.program;
    const ops = (program?.ops ?? []).slice(0, 12).map((o) => ({ op: o.op, label: clip(o.label, 60) }));
    const added = (program?.ops ?? []).reduce((n, o) => n + (o.op === "add_parts" ? (o.parts?.length ?? 0) : 0), 0);
    const removed = (program?.ops ?? []).filter((o) => o.op === "delete").length;
    const moved = (program?.ops ?? []).filter((o) => o.op === "stretch" || o.op === "move" || o.op === "scale" || o.op === "rotate" || o.op === "mirror_copy").length;
    const summary = clip(input.plan?.summary || "Edited the model", 240);
    const meta: EditMeta = {
        version: 1,
        target: "mesh",
        depth: input.depth,
        label: editLabel(input.instruction),
        summary,
        entries: [{ n: 1, instruction: clip(input.instruction, 160), summary: clip(summary, 200), added: Math.min(added, 1000), removed: Math.min(removed, 1000), moved: Math.min(moved, 1000) }],
        engine: clip(input.engine, 80),
        changes: null,
        ops,
        notes: (input.plan?.notes ?? []).slice(0, 8).map((n) => clip(n, 160)),
        stabilized_depth: input.stabilizedDepth,
        base_steps: 0,
        job_id: input.jobId,
        created_at: input.createdAt,
    };
    // Unreachable with these bounds (a few hundred bytes to ~4 KB); the guard keeps a future change from storing a row that cannot be read.
    if (JSON.stringify(meta).length > EDIT_META_LIMIT) meta.notes = [];
    return meta;
}

// ---------- the handler ----------

interface JobRow {
    id: string;
    project_id: string;
    kind: string;
    status: string;
    edit_target: string | null;
    source_model_id: string | null;
    model_id: string | null;
    prompt: string;
    plan: string | null;
}

interface SourceRow {
    id: string;
    project_id: string;
    provider: string;
    prompt: string;
    kind: string;
    meta: string | null;
    deleted_at: string | null;
}

interface Counts {
    per_source: number;
    per_project: number;
    mesh_edits: number;
    depth: number;
}

const readCounts = (env: Env, sourceId: string, projectId: string): Promise<Counts | null> =>
    env.DB.prepare(
        `WITH RECURSIVE up(id, source_model_id, n) AS (
             SELECT id, source_model_id, 0 FROM models WHERE id = ?1
             UNION ALL SELECT m.id, m.source_model_id, up.n + 1 FROM models m JOIN up ON m.id = up.source_model_id WHERE up.n < ${MAX_VERSION_DEPTH + 2}
         )
         SELECT (SELECT COUNT(*) FROM models WHERE source_model_id = ?1) AS per_source,
                (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind IN ('stabilized', 'edited', 'optimized')) AS per_project,
                ${MESH_EDITS_SQL} AS mesh_edits,
                (SELECT COUNT(*) FROM up) AS depth`,
    )
        .bind(sourceId, projectId)
        .first<Counts>();

/** The error for a limit that is used up (or a chain that is too deep), else null. `depth` counts the source and its ancestors. */
function limitError(counts: Counts | null): HttpError | null {
    if (!counts) return null;
    if (counts.depth > MAX_VERSION_DEPTH) return new HttpError(409, `This version is ${MAX_VERSION_DEPTH} edits deep already. Start from an earlier version.`);
    if (counts.per_source >= MAX_VERSIONS_PER_SOURCE) return new HttpError(429, `A model can have at most ${MAX_VERSIONS_PER_SOURCE} versions. Delete one first.`);
    if (counts.per_project >= MAX_VERSIONS_PER_PROJECT) return new HttpError(429, `A project can hold at most ${MAX_VERSIONS_PER_PROJECT} versions. Delete some first.`);
    if (counts.mesh_edits >= MAX_MESH_EDITS_PER_PROJECT) return new HttpError(429, `A project can hold at most ${MAX_MESH_EDITS_PER_PROJECT} edited meshes (each is a large file). Delete one first.`);
    return null;
}

const EXISTING_BY_JOB = `SELECT ${MODEL_COLS} FROM models WHERE job_id = ?1 AND kind = 'edited' AND source_model_id = ?2`;

/** The model the job already made, if any (an upload that got through before). */
async function existingModel(env: Env, job: JobRow, sourceId: string): Promise<ModelAsset | null> {
    if (job.model_id) {
        const row = await env.DB.prepare(`SELECT ${MODEL_COLS} FROM models WHERE id = ?1`).bind(job.model_id).first<ModelRow>();
        if (row) return toModelAsset(row);
    }
    const row = await env.DB.prepare(EXISTING_BY_JOB).bind(job.id, sourceId).first<ModelRow>();
    return row ? toModelAsset(row) : null;
}

/** POST /models/:sourceId/edited?job=<id>. Resolves to the status and the model (201 new, 200 the one stored before). */
export async function handleUploadEdited(env: Env, request: Request, rawSourceId: string, rawJobId: string | null): Promise<{ status: 200 | 201; model: ModelAsset }> {
    // Cheapest refusals first: nothing below touches D1 or the body until the request looks like an upload of an edit.
    const sourceId = requireUuid(rawSourceId, "model id");
    if (rawJobId === null || rawJobId === "") throw new HttpError(400, "Say which edit this is (?job=<id>).");
    const jobId = requireUuid(rawJobId, "job id");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== GLB_CONTENT_TYPE) throw new HttpError(415, `The body must be ${GLB_CONTENT_TYPE}`);
    const length = Number(request.headers.get("content-length"));
    if (!Number.isFinite(length) || length <= 0 || !Number.isInteger(length)) throw new HttpError(411, "The size of the edited model must be sent (Content-Length).");
    if (length > EDITED_GLB_LIMIT) throw new HttpError(413, "The edited model is larger than the 48 MB limit.");
    if (!request.body) throw new HttpError(400, "The edited model is empty.");

    const job = await env.DB.prepare("SELECT id, project_id, kind, status, edit_target, source_model_id, model_id, prompt, plan FROM jobs WHERE id = ?1").bind(jobId).first<JobRow>();
    if (!job) throw new HttpError(404, "Edit not found");
    if (job.kind !== "edit" || job.edit_target !== "mesh" || job.source_model_id !== sourceId) throw new HttpError(409, "This edit does not belong to that model.");
    // A retry of an upload that got through: answered with that model, before anything else is looked at.
    const done = await existingModel(env, job, sourceId);
    if (done) {
        await request.body.cancel().catch(() => {});
        return { status: 200, model: done };
    }
    if (job.status !== "succeeded") throw new HttpError(409, "The edit is not ready yet.");
    // A plan that carries nothing out ("this cannot be done") has no version to save, whatever the person's browser says.
    const plan = readStoredEditResult(job.plan);
    if (!plan || plan.target !== "mesh" || !plan.applied) throw new HttpError(409, "This edit made no changes, so there is nothing to save.");

    const source = await env.DB.prepare(
        `SELECT m.id, m.project_id, m.provider, m.prompt, m.kind, m.meta, p.deleted_at
         FROM models m JOIN projects p ON p.id = m.project_id WHERE m.id = ?1`,
    )
        .bind(sourceId)
        .first<SourceRow>();
    if (!source) throw new HttpError(404, "Model not found");
    if (source.project_id !== job.project_id) throw new HttpError(409, "This edit does not belong to that model.");
    if (source.deleted_at) throw new HttpError(409, "This project is in the bin. Restore it first.");
    // The edit start refused sources that cannot be edited; the upload does not trust that the job says so.
    if (source.kind === "example" || representationOf({ kind: source.kind as ModelKind, meta: source.meta }) !== "mesh") throw new HttpError(409, "This model cannot be edited as a mesh.");

    const counts = await readCounts(env, sourceId, source.project_id);
    const early = limitError(counts);
    if (early) throw early;
    if (!(await reserveUpload(env, "edited"))) throw new HttpError(429, "Today's limit of edited models is used up. Try again tomorrow.");

    const id = crypto.randomUUID();
    const key = `models/${id}.glb`;
    let row: ModelRow | undefined;
    try {
        // Straight into R2: the bytes never pass through JavaScript.
        const { readable, writable } = new FixedLengthStream(length);
        const [piped, put] = await Promise.allSettled([request.body.pipeTo(writable), env.FILES.put(key, readable, { httpMetadata: { contentType: GLB_CONTENT_TYPE } })]);
        if (piped.status === "rejected" || put.status === "rejected") throw new HttpError(400, "Receiving the edited model was interrupted. Try again.");

        // Read back the header and the description (a few KB) and check them.
        const head = await env.FILES.get(key, { range: { offset: 0, length: 20 } });
        const jsonLength = readEditedHeader(new Uint8Array(await (head?.arrayBuffer() ?? new ArrayBuffer(0))), length);
        const chunk = await env.FILES.get(key, { range: { offset: 20, length: jsonLength + (20 + jsonLength < length ? 8 : 0) } });
        const bytes = new Uint8Array(await (chunk?.arrayBuffer() ?? new ArrayBuffer(0)));
        if (bytes.byteLength < jsonLength) throw new HttpError(400, "The edited model is incomplete.");
        const binLength = readEditedBinHeader(bytes.subarray(jsonLength), jsonLength, length);
        let json: unknown;
        try {
            json = JSON.parse(new TextDecoder().decode(bytes.subarray(0, jsonLength)));
        } catch {
            throw new HttpError(400, "The edited model is malformed.");
        }
        const problem = checkEditedGlbJson(json, binLength);
        if (problem) throw new HttpError(400, problem);
        // The pictures' own headers (the BIN chunk starts after its 8-byte header). Everyone's viewer decodes these.
        const binStart = 20 + jsonLength + 8;
        const pictureProblem = await checkEditedImages(json, async (offset, size) => {
            const part = await env.FILES.get(key, { range: { offset: binStart + offset, length: size } });
            return new Uint8Array(await (part?.arrayBuffer() ?? new ArrayBuffer(0)));
        });
        if (pictureProblem) throw new HttpError(400, pictureProblem);

        const meta = buildMeshEditMeta({
            instruction: job.prompt,
            plan: plan ? { summary: plan.summary, notes: plan.notes, program: plan.program } : null,
            depth: Math.min(MAX_VERSION_DEPTH, (counts?.depth ?? 1)),
            stabilizedDepth: stabilizationsOf({ kind: source.kind as ModelKind, meta: source.meta }),
            jobId,
            engine: env.OPENROUTER_EDIT_MODEL?.trim() || env.OPENROUTER_MODEL?.trim() || "meta/muse-spark-1.3-contributor",
            createdAt: nowIso(),
        });
        // Re-read through the same reader every project read uses, so a record that could not be read back is never stored.
        if (!readEditMeta(meta)) throw new HttpError(500, "The edit record could not be built.");

        // INSERT ... SELECT ... WHERE: the caps, "the source still exists" and "this job has no model yet" are conditions of the statement.
        const now = nowIso();
        const [inserted] = await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, thumb_key, size_bytes, part_count, created_at,
                                     analysis, kind, source_model_id, assembly_hash, meta)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, NULL, 'edited', ?10, NULL, ?11
                 WHERE EXISTS (SELECT 1 FROM models WHERE id = ?10 AND project_id = ?2)
                   AND NOT EXISTS (SELECT 1 FROM models WHERE job_id = ?3 AND kind = 'edited')
                   AND (SELECT COUNT(*) FROM models WHERE source_model_id = ?10) < ${MAX_VERSIONS_PER_SOURCE}
                   AND (SELECT COUNT(*) FROM models WHERE project_id = ?2 AND kind IN ('stabilized', 'edited', 'optimized')) < ${MAX_VERSIONS_PER_PROJECT}
                   AND ${MESH_EDITS_SQL} < ${MAX_MESH_EDITS_PER_PROJECT}
                 RETURNING ${MODEL_COLS}`,
            ).bind(id, source.project_id, jobId, source.provider, source.prompt, key, length, countMeshNodes(json), now, sourceId, JSON.stringify(meta)),
            // (A model_id of a version that was undone since is stale: it does not count as "the job has a model".)
            env.DB.prepare(
                "UPDATE jobs SET model_id = ?1, updated_at = ?2 WHERE id = ?3 AND (model_id IS NULL OR NOT EXISTS (SELECT 1 FROM models WHERE id = jobs.model_id)) AND EXISTS (SELECT 1 FROM models WHERE id = ?1)",
            ).bind(id, now, jobId),
        ]);
        row = (inserted.results as unknown as ModelRow[])[0];
    } catch (err) {
        await env.FILES.delete(key).catch(() => {});
        await refundUpload(env, "edited");
        if (err instanceof HttpError) throw err;
        // The project was purged while the file was being checked.
        if (err instanceof Error && /FOREIGN KEY constraint/i.test(err.message)) throw new HttpError(404, "Model not found");
        console.error(`mesh edit upload failed: ${errorSummary(err)}`);
        throw err;
    }
    if (!row) {
        // Nothing was inserted: a condition failed. Undo the file and the daily slot, then say why.
        await env.FILES.delete(key).catch(() => {});
        await refundUpload(env, "edited");
        // The same job was stored by a request that got in just before.
        const winner = await env.DB.prepare(EXISTING_BY_JOB).bind(jobId, sourceId).first<ModelRow>();
        if (winner) return { status: 200, model: toModelAsset(winner) };
        const limit = limitError(await readCounts(env, sourceId, source.project_id));
        throw limit ?? new HttpError(409, "The model changed while it was being saved. Try again.");
    }
    // Outside the try: a failed touch must not delete the file of a row that exists. Saving a version is an edit.
    await touchProject(env, source.project_id).catch(() => {});
    return { status: 201, model: toModelAsset(row) };
}
