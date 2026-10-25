// A parts design (shared/partsDesign.ts) as a GLB: one node + mesh + material per part, named like the part, so the viewer's
// Parts list shows "Left front leg", "Seat", ... Pure TypeScript: no three.js, no gltf-transform, no DOM, so the Worker's
// queue consumer, the browser and Node share it. Deterministic: the same design gives the same bytes.
//
// Geometry: box (24 vertices, flat normals), cylinder, cone, sphere, capsule and torus with smooth normals (24 segments
// around, 12 rings on a sphere or torus tube, 6 per capsule end). Box, cylinder, cone and sphere are ONE unit mesh each,
// shared by every part of that shape (their glTF meshes point at the same accessors) and sized by the node's scale, so a
// 60-part design costs a few KB of vertex data and almost no CPU (a Free-plan Worker has 10 ms). A capsule or torus depends on
// two numbers, so each distinct one gets its own positions; their normals and triangles never change and are shared. The glTF frame is Y-up: a part's Z-up frame (x, y, z) is written as
// (x, z, -y); the node carries the position, rotation and size. Triangles are counter-clockwise seen from outside.
// Materials are plain PBR: base colour from the part's colour, metallic 0, roughness 0.75.

import { rotationMatrix, uniqueNames, type DesignPart, type PartShape, type PartsDesign, type Vec3 } from "./partsDesign.ts";

export const PARTS_GLB_GENERATOR = "Assembly Studio parts 1";
/** Hard limit of this writer (the design repair keeps 60). */
export const MAX_GLB_PARTS = 200;

const RADIAL = 24; // segments around an axis
const RINGS = 12; // latitude rings from pole to pole of a sphere, and segments around a torus tube
const CAP_RINGS = 6; // latitude rings of one capsule hemisphere
const MM = 0.001;

const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

const TAU = Math.PI * 2;
/** Values that are zero up to rounding (cos of a quarter turn) become exactly 0, so poles and extremes sit on the axes. */
const snap = (v: number): number => (Math.abs(v) < 1e-12 ? 0 : v);
// cos/sin of the segment angles; the last entry repeats the first so a seam is exact. The "mid" tables are the half steps.
const COS = new Float64Array(RADIAL + 1);
const SIN = new Float64Array(RADIAL + 1);
const COS_MID = new Float64Array(RADIAL);
const SIN_MID = new Float64Array(RADIAL);
for (let k = 0; k <= RADIAL; k++) {
    const angle = k === RADIAL ? 0 : (TAU * k) / RADIAL;
    COS[k] = snap(Math.cos(angle));
    SIN[k] = snap(Math.sin(angle));
    if (k < RADIAL) {
        COS_MID[k] = snap(Math.cos((TAU * (k + 0.5)) / RADIAL));
        SIN_MID[k] = snap(Math.sin((TAU * (k + 0.5)) / RADIAL));
    }
}

export interface PartMesh {
    /** glTF frame (Y-up), metres, 3 floats per vertex. */
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint16Array;
    /** The extremes of `positions`, when the builder knows them without looking at every vertex (the GLB's accessor needs them). */
    bounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
}

/** Writes vertices and triangles into preallocated arrays, converting the part's Z-up frame to glTF's Y-up as it goes. */
class MeshBuilder {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint16Array;
    private v = 0;
    private i = 0;

    constructor(vertices: number, triangles: number) {
        this.positions = new Float32Array(vertices * 3);
        this.normals = new Float32Array(vertices * 3);
        this.indices = new Uint16Array(triangles * 3);
    }

    /** A vertex at (x, y, z) with the (not yet unit) normal (nx, ny, nz), both in the Z-up frame. */
    vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
        const at = this.v * 3;
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        this.positions[at] = x;
        this.positions[at + 1] = z;
        this.positions[at + 2] = -y;
        this.normals[at] = nx / length;
        this.normals[at + 1] = nz / length;
        this.normals[at + 2] = -ny / length;
        return this.v++;
    }

    triangle(a: number, b: number, c: number): void {
        this.indices[this.i++] = a;
        this.indices[this.i++] = b;
        this.indices[this.i++] = c;
    }

    /** Two triangles for a quad whose corners a, b, c, d run counter-clockwise seen from outside. */
    quad(a: number, b: number, c: number, d: number): void {
        this.triangle(a, b, c);
        this.triangle(a, c, d);
    }

    done(): PartMesh {
        if (this.v * 3 !== this.positions.length || this.i !== this.indices.length) {
            throw new Error("mesh counts do not match the plan");
        }
        return { positions: this.positions, normals: this.normals, indices: this.indices };
    }
}

// Cube faces: outward normal and the four corners (unit cube, counter-clockwise seen from outside, Z-up).
const FACES: ReadonlyArray<{ n: readonly [number, number, number]; c: ReadonlyArray<readonly [number, number, number]> }> = [
    { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { n: [-1, 0, 0], c: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
    { n: [0, 1, 0], c: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]] },
    { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], c: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
];

function boxMesh(a: number, b: number, c: number): PartMesh {
    const m = new MeshBuilder(24, 12);
    for (const face of FACES) {
        const ids = face.c.map((p) => m.vertex((p[0] * 2 - 1) * a, (p[1] * 2 - 1) * b, (p[2] * 2 - 1) * c, face.n[0], face.n[1], face.n[2]));
        m.quad(ids[0], ids[1], ids[2], ids[3]);
    }
    return m.done();
}

/** Axis along Z: an elliptic side (smooth normals) and two flat caps. Radii a, b; half height c. */
function cylinderMesh(a: number, b: number, c: number): PartMesh {
    const m = new MeshBuilder(2 * (RADIAL + 1) + 2 * (RADIAL + 1), 4 * RADIAL);
    const bottom: number[] = [];
    const top: number[] = [];
    for (let k = 0; k <= RADIAL; k++) {
        bottom.push(m.vertex(a * COS[k], b * SIN[k], -c, COS[k] / a, SIN[k] / b, 0));
        top.push(m.vertex(a * COS[k], b * SIN[k], c, COS[k] / a, SIN[k] / b, 0));
    }
    for (let k = 0; k < RADIAL; k++) m.quad(bottom[k], bottom[k + 1], top[k + 1], top[k]);
    for (const [z, nz] of [[c, 1], [-c, -1]] as const) {
        const centre = m.vertex(0, 0, z, 0, 0, nz);
        const ring: number[] = [];
        for (let k = 0; k < RADIAL; k++) ring.push(m.vertex(a * COS[k], b * SIN[k], z, 0, 0, nz));
        for (let k = 0; k < RADIAL; k++) {
            const next = ring[(k + 1) % RADIAL];
            if (nz > 0) m.triangle(centre, ring[k], next);
            else m.triangle(centre, next, ring[k]);
        }
    }
    return m.done();
}

/** Base on z = -c, point at z = +c. */
function coneMesh(a: number, b: number, c: number): PartMesh {
    const m = new MeshBuilder(2 * (RADIAL + 1) + 1 + RADIAL, 2 * RADIAL);
    const base: number[] = [];
    const apex: number[] = [];
    for (let k = 0; k <= RADIAL; k++) {
        // The slope normal of an elliptic cone is (2 cos/a, 2 sin/b, 1/c) all the way up.
        base.push(m.vertex(a * COS[k], b * SIN[k], -c, (2 * COS[k]) / a, (2 * SIN[k]) / b, 1 / c));
        const mid = k % RADIAL;
        apex.push(m.vertex(0, 0, c, (2 * COS_MID[mid]) / a, (2 * SIN_MID[mid]) / b, 1 / c));
    }
    for (let k = 0; k < RADIAL; k++) m.triangle(base[k], base[k + 1], apex[k]);
    const centre = m.vertex(0, 0, -c, 0, 0, -1);
    const ring: number[] = [];
    for (let k = 0; k < RADIAL; k++) ring.push(m.vertex(a * COS[k], b * SIN[k], -c, 0, 0, -1));
    for (let k = 0; k < RADIAL; k++) m.triangle(centre, ring[(k + 1) % RADIAL], ring[k]);
    return m.done();
}

/**
 * A pole-to-pole stack of rings. Ring j is described by `ring(j)` = [radial scale, z, radial normal part, z normal part];
 * a vertex is (ax sr cos, ay sr sin, z) with normal (nr cos / ax, nr sin / ay, nz). The first and last ring are points.
 */
function latitudeMesh(rows: number, ax: number, ay: number, ring: (j: number) => readonly [number, number, number, number]): PartMesh {
    const m = new MeshBuilder((RADIAL + 1) * (rows + 1), RADIAL * (2 * rows - 2));
    for (let j = 0; j <= rows; j++) {
        const [sr, z, nr, nz] = ring(j);
        for (let k = 0; k <= RADIAL; k++) {
            m.vertex(ax * sr * COS[k], ay * sr * SIN[k], z, (nr * COS[k]) / ax, (nr * SIN[k]) / ay, nz);
        }
    }
    const stride = RADIAL + 1;
    for (let j = 0; j < rows; j++) {
        for (let k = 0; k < RADIAL; k++) {
            const topLeft = j * stride + k;
            const bottomLeft = topLeft + stride;
            // The first row starts at a pole and the last ends at one: of its two triangles one would have no area.
            if (j < rows - 1) m.triangle(topLeft, bottomLeft, bottomLeft + 1);
            if (j > 0) m.triangle(topLeft, bottomLeft + 1, topLeft + 1);
        }
    }
    return m.done();
}

/** Radii a, b, c (semi-axes). */
function sphereMesh(a: number, b: number, c: number): PartMesh {
    return latitudeMesh(RINGS, a, b, (j) => {
        const phi = (Math.PI * j) / RINGS;
        const sin = snap(Math.sin(phi));
        const cos = snap(Math.cos(phi));
        return [sin, c * cos, sin, cos / c];
    });
}

/**
 * What a capsule or torus has in common whatever its size: the normals and the triangles never change, and a vertex is a
 * size-weighted sum of per-ring numbers. They are worked out once per isolate; each capsule or torus then only fills in its
 * positions (a few hundred multiplications, instead of building every vertex and normal again), which keeps a design of sixty
 * different ones well inside a Free-plan Worker's 10 ms. Meshes of one kind share the normals and indices arrays (read-only).
 */
interface RoundKit {
    normals: Float32Array;
    indices: Uint16Array;
    /** Per ring of vertices (one entry for each of the mesh's rows): the two numbers that weight the size. */
    ringA: Float64Array;
    ringB: Float64Array;
}

const CAPSULE_ROWS = 2 * CAP_RINGS + 1;
const capsuleRing = (j: number): readonly [number, number] => {
    // Rings 0..CAP_RINGS climb the top hemisphere from its pole to its equator at z = +h; the rest descend the bottom one.
    const top = j <= CAP_RINGS;
    const phi = top ? (Math.PI / 2) * (j / CAP_RINGS) : Math.PI / 2 + (Math.PI / 2) * ((j - CAP_RINGS - 1) / CAP_RINGS);
    return [snap(Math.sin(phi)), snap(Math.cos(phi))];
};

/** Radius r, half of the straight part h; the axis along Z. */
function capsuleReference(r: number, h: number): PartMesh {
    return latitudeMesh(CAPSULE_ROWS, 1, 1, (j) => {
        const top = j <= CAP_RINGS;
        const [sin, cos] = capsuleRing(j);
        return [r * sin, (top ? h : -h) + r * cos, sin, cos];
    });
}

/** Axis along Z, major radius `big` (to the middle of the tube), tube radius `r`. */
function torusReference(big: number, r: number): PartMesh {
    const m = new MeshBuilder((RADIAL + 1) * (RINGS + 1), 2 * RADIAL * RINGS);
    for (let j = 0; j <= RINGS; j++) {
        const phi = (TAU * j) / RINGS;
        const cp = snap(Math.cos(phi));
        const sp = snap(Math.sin(phi));
        for (let k = 0; k <= RADIAL; k++) {
            const rho = big + r * cp;
            m.vertex(rho * COS[k], rho * SIN[k], r * sp, cp * COS[k], cp * SIN[k], sp);
        }
    }
    const stride = RADIAL + 1;
    for (let j = 0; j < RINGS; j++) {
        for (let k = 0; k < RADIAL; k++) {
            const a = j * stride + k;
            m.quad(a, a + 1, a + stride + 1, a + stride);
        }
    }
    return m.done();
}

let capsuleKit: RoundKit | null = null;
let torusKit: RoundKit | null = null;

function capsuleParts(): RoundKit {
    if (!capsuleKit) {
        const reference = capsuleReference(1, 0); // unit radius, no straight part: the normals and triangles of every capsule
        const ringA = new Float64Array(CAPSULE_ROWS + 1);
        const ringB = new Float64Array(CAPSULE_ROWS + 1);
        for (let j = 0; j <= CAPSULE_ROWS; j++) [ringA[j], ringB[j]] = capsuleRing(j);
        capsuleKit = { normals: reference.normals, indices: reference.indices, ringA, ringB };
    }
    return capsuleKit;
}

function torusParts(): RoundKit {
    if (!torusKit) {
        const reference = torusReference(1, 0.5);
        const ringA = new Float64Array(RINGS + 1);
        const ringB = new Float64Array(RINGS + 1);
        for (let j = 0; j <= RINGS; j++) {
            const phi = (TAU * j) / RINGS;
            ringA[j] = snap(Math.cos(phi));
            ringB[j] = snap(Math.sin(phi));
        }
        torusKit = { normals: reference.normals, indices: reference.indices, ringA, ringB };
    }
    return torusKit;
}

/** Radius r, half of the straight part h; the axis along Z. Same numbers as capsuleReference, without its per-vertex work. */
function capsuleMesh(r: number, h: number): PartMesh {
    const kit = capsuleParts();
    const stride = RADIAL + 1;
    const positions = new Float32Array((CAPSULE_ROWS + 1) * stride * 3);
    let at = 0;
    for (let j = 0; j <= CAPSULE_ROWS; j++) {
        const sr = r * kit.ringA[j];
        const z = (j <= CAP_RINGS ? h : -h) + r * kit.ringB[j];
        for (let k = 0; k < stride; k++) {
            positions[at++] = sr * COS[k];
            positions[at++] = z;
            positions[at++] = -(sr * SIN[k]);
        }
    }
    // The equator ring reaches r on X and Z (cos and sin of the quarter turns are exact), the poles reach h + r on Y.
    const reach = Math.fround(h + r);
    const side = Math.fround(r);
    return { positions, normals: kit.normals, indices: kit.indices, bounds: { min: [-side, -reach, -side], max: [side, reach, side] } };
}

/** Axis along Z, major radius `big` (to the middle of the tube), tube radius `r`. Same numbers as torusReference. */
function torusMesh(big: number, r: number): PartMesh {
    const kit = torusParts();
    const stride = RADIAL + 1;
    const positions = new Float32Array((RINGS + 1) * stride * 3);
    let at = 0;
    for (let j = 0; j <= RINGS; j++) {
        const rho = big + r * kit.ringA[j];
        const z = r * kit.ringB[j];
        for (let k = 0; k < stride; k++) {
            positions[at++] = rho * COS[k];
            positions[at++] = z;
            positions[at++] = -(rho * SIN[k]);
        }
    }
    // The outer equator reaches big + r on X and Z; the tube's top and bottom are at +-r.
    const outer = Math.fround(big + r);
    const tube = Math.fround(r);
    return { positions, normals: kit.normals, indices: kit.indices, bounds: { min: [-outer, -tube, -outer], max: [outer, tube, outer] } };
}

/** A mesh and the scale that turns it into the part: the node's scale in the part's own (Z-up) axes, metres. */
export interface PartPrimitive {
    mesh: PartMesh;
    scale: Vec3;
}

// Unit meshes (a 1 m cube, a cylinder and a cone of diameter 1 and height 1, a sphere of diameter 1), built once per isolate.
const unitMeshes = new Map<PartShape, PartMesh>();
function unitMesh(shape: "box" | "cylinder" | "cone" | "sphere"): PartMesh {
    let mesh = unitMeshes.get(shape);
    if (!mesh) {
        mesh = shape === "box" ? boxMesh(0.5, 0.5, 0.5) : shape === "cylinder" ? cylinderMesh(0.5, 0.5, 0.5) : shape === "cone" ? coneMesh(0.5, 0.5, 0.5) : sphereMesh(0.5, 0.5, 0.5);
        unitMeshes.set(shape, mesh);
    }
    return mesh;
}

/**
 * The mesh of a part from its shape and size (mm). Box, cylinder, cone and sphere share a unit mesh and are sized by `scale`;
 * a capsule or torus is built at its size (`scale` 1), and `cache` (one per file) lets equal ones share a mesh.
 */
export function partPrimitive(shape: PartShape, size: Vec3, cache?: Map<string, PartMesh>): PartPrimitive {
    switch (shape) {
        case "box":
        case "cylinder":
        case "cone":
        case "sphere":
            return { mesh: unitMesh(shape), scale: [size[0] * MM, size[1] * MM, size[2] * MM] };
        case "capsule":
        case "torus": {
            const key = `${shape}|${size[0]}|${size[2]}`;
            let mesh = cache?.get(key);
            if (!mesh) {
                const radius = (size[0] * MM) / 2;
                const third = (size[2] * MM) / 2;
                mesh = shape === "capsule" ? capsuleMesh(radius, Math.max(0, third - radius)) : torusMesh(Math.max(0, radius - third), third);
                cache?.set(key, mesh);
            }
            return { mesh, scale: [1, 1, 1] };
        }
    }
}

/** The part's mesh at its real size (scale applied), centred and unrotated, in glTF's frame and metres. For tests and tools. */
export function buildPartMesh(shape: PartShape, size: Vec3): PartMesh {
    const { mesh, scale } = partPrimitive(shape, size);
    if (scale[0] === 1 && scale[1] === 1 && scale[2] === 1) return mesh;
    const positions = new Float32Array(mesh.positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = mesh.positions[i] * scale[0];
        positions[i + 1] = mesh.positions[i + 1] * scale[2]; // glTF y is the part's z
        positions[i + 2] = mesh.positions[i + 2] * scale[1]; // glTF z is the part's -y
    }
    return { positions, normals: mesh.normals, indices: mesh.indices };
}

// ---------- colour and transform ----------

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function baseColor(hex: string): [number, number, number, number] {
    const n = Number.parseInt(hex.slice(1), 16);
    const lin = (shift: number) => round6(srgbToLinear(((n >> shift) & 255) / 255));
    return [lin(16), lin(8), lin(0), 1];
}

/** Unit quaternion [x, y, z, w] of the part's rotation expressed in glTF's Y-up frame: R_gltf = C R C^T, C = (x, z, -y). */
function gltfQuaternion(rotation: Vec3): [number, number, number, number] | null {
    const r = rotationMatrix(rotation);
    const c = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    const mul = (p: number[], q: number[]) => {
        const out = new Array<number>(9).fill(0);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += p[i * 3 + k] * q[k * 3 + j];
        return out;
    };
    const ct = [c[0], c[3], c[6], c[1], c[4], c[7], c[2], c[5], c[8]];
    const m = mul(mul(c, r), ct);
    const trace = m[0] + m[4] + m[8];
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (m[7] - m[5]) / s;
        y = (m[2] - m[6]) / s;
        z = (m[3] - m[1]) / s;
    } else if (m[0] > m[4] && m[0] > m[8]) {
        const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
        w = (m[7] - m[5]) / s;
        x = 0.25 * s;
        y = (m[1] + m[3]) / s;
        z = (m[2] + m[6]) / s;
    } else if (m[4] > m[8]) {
        const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
        w = (m[2] - m[6]) / s;
        x = (m[1] + m[3]) / s;
        y = 0.25 * s;
        z = (m[5] + m[7]) / s;
    } else {
        const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
        w = (m[3] - m[1]) / s;
        x = (m[2] + m[6]) / s;
        y = (m[5] + m[7]) / s;
        z = 0.25 * s;
    }
    const length = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    const sign = w < 0 ? -1 : 1; // q and -q are the same rotation: keep w >= 0 so the bytes are stable
    const q = [x, y, z, w].map((n) => round6((n * sign) / length) + 0) as [number, number, number, number];
    return Math.abs(q[0]) < 1e-9 && Math.abs(q[1]) < 1e-9 && Math.abs(q[2]) < 1e-9 ? null : q;
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** The design as a binary glTF 2.0 file. The design should come from repairDesign: this only refuses what it cannot write. */
export function buildPartsGlb(design: PartsDesign): Uint8Array {
    const parts: readonly DesignPart[] = design.parts;
    if (parts.length === 0) throw new Error("a design needs at least one part");
    if (parts.length > MAX_GLB_PARTS) throw new Error(`a design is limited to ${MAX_GLB_PARTS} parts`);
    for (const part of parts) {
        if (![...part.size, ...part.position, ...part.rotation].every(Number.isFinite)) {
            throw new Error(`part "${part.name}" has a number that is not finite`);
        }
    }
    const names = uniqueNames(parts.map((p) => p.name));

    // BIN layout: every distinct mesh once (positions, normals, indices padded to 4 bytes); parts of one shape point at it.
    const cache = new Map<string, PartMesh>();
    const meshes: PartMesh[] = [];
    const accessorOf = new Map<PartMesh, number>(); // first accessor of a mesh's three
    const accessors: unknown[] = [];
    const bufferViews: unknown[] = [];
    let binBytes = 0;
    const place = (mesh: PartMesh): number => {
        const known = accessorOf.get(mesh);
        if (known !== undefined) return known;
        const count = mesh.positions.length / 3;
        const posBytes = mesh.positions.byteLength;
        const idxBytes = mesh.indices.byteLength;
        const min = mesh.bounds ? [...mesh.bounds.min] : [Infinity, Infinity, Infinity];
        const max = mesh.bounds ? [...mesh.bounds.max] : [-Infinity, -Infinity, -Infinity];
        if (!mesh.bounds) {
            for (let i = 0; i < mesh.positions.length; i += 3) {
                for (let axis = 0; axis < 3; axis++) {
                    const value = mesh.positions[i + axis];
                    if (value < min[axis]) min[axis] = value;
                    if (value > max[axis]) max[axis] = value;
                }
            }
        }
        const view = bufferViews.length;
        bufferViews.push(
            { buffer: 0, byteOffset: binBytes, byteLength: posBytes, target: ARRAY_BUFFER },
            { buffer: 0, byteOffset: binBytes + posBytes, byteLength: posBytes, target: ARRAY_BUFFER },
            { buffer: 0, byteOffset: binBytes + 2 * posBytes, byteLength: idxBytes, target: ELEMENT_ARRAY_BUFFER },
        );
        const first = accessors.length;
        accessors.push(
            { bufferView: view, componentType: FLOAT, count, type: "VEC3", min: min.map(round6), max: max.map(round6) },
            { bufferView: view + 1, componentType: FLOAT, count, type: "VEC3" },
            { bufferView: view + 2, componentType: UNSIGNED_SHORT, count: mesh.indices.length, type: "SCALAR" },
        );
        binBytes += 2 * posBytes + pad4(idxBytes);
        accessorOf.set(mesh, first);
        meshes.push(mesh);
        return first;
    };

    const nodes: unknown[] = [];
    const gltfMeshes: unknown[] = [];
    const materials: unknown[] = [];
    parts.forEach((part, n) => {
        const { mesh, scale } = partPrimitive(part.shape, part.size, cache);
        const accessor = place(mesh);
        gltfMeshes.push({
            name: names[n],
            primitives: [{ attributes: { POSITION: accessor, NORMAL: accessor + 1 }, indices: accessor + 2, material: n, mode: 4 }],
        });
        materials.push({
            name: names[n],
            pbrMetallicRoughness: { baseColorFactor: baseColor(part.color), metallicFactor: 0, roughnessFactor: 0.75 },
        });
        // glTF position = (x, z, -y) of the design's Z-up position, in metres; the size is a scale along the part's own axes.
        const node: Record<string, unknown> = {
            name: names[n],
            mesh: n,
            translation: [round6(part.position[0] * MM) + 0, round6(part.position[2] * MM) + 0, round6(-part.position[1] * MM) + 0],
        };
        const q = gltfQuaternion(part.rotation);
        if (q) node.rotation = q;
        if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) node.scale = [round6(scale[0]), round6(scale[2]), round6(scale[1])];
        node.extras = { "nevo:part": { shape: part.shape, size_mm: part.size, color: part.color } };
        nodes.push(node);
    });

    const json = {
        asset: { version: "2.0", generator: PARTS_GLB_GENERATOR },
        scene: 0,
        scenes: [{ name: design.name, nodes: parts.map((_, i) => i), extras: { "nevo:parts": { version: 1, count: parts.length } } }],
        nodes,
        meshes: gltfMeshes,
        materials,
        accessors,
        bufferViews,
        buffers: [{ byteLength: binBytes }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = pad4(jsonBytes.byteLength);
    const total = 12 + 8 + jsonLength + 8 + binBytes;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength); // JSON is padded with spaces
    const binHeader = 20 + jsonLength;
    view.setUint32(binHeader, binBytes, true);
    view.setUint32(binHeader + 4, CHUNK_BIN, true);
    let at = binHeader + 8;
    for (const mesh of meshes) {
        for (const array of [mesh.positions, mesh.normals, mesh.indices]) {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            out.set(bytes, at);
            at += pad4(bytes.byteLength);
        }
    }
    return out;
}
