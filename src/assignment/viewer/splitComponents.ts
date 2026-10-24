// "Split into parts": cuts one fused mesh into its connected pieces. Pure (three types only), so
// Node can test it, and chunked (async, yielding to the event loop every few milliseconds) so a
// ~500k-triangle model stays responsive in the browser.
//
// Method: weld vertices by quantised position (a seam that duplicates a vertex for UVs or normals
// is still one point), union-find the welded vertices of every triangle, and give each root one
// component. Components with at least `minFraction` of all triangles become pieces (largest first,
// at most `maxPieces`; when none is that big, the biggest still are); the rest are merged into one
// "Small pieces" part. Each piece is a compact
// copy of the source geometry (every attribute, so UVs and normals survive), one mesh per material
// group, so textured and multi-material models keep their look.
import * as THREE from "three";

/** Components below this share of all triangles are merged into "Small pieces". */
export const SPLIT_MIN_FRACTION = 0.003;
export const SPLIT_MAX_PIECES = 64;
/** Above this many triangles splitting is refused (the work and the copies would be too big for a tab). */
export const SPLIT_MAX_TRIANGLES = 2_000_000;
export const SMALL_PIECES_NAME = "Small pieces";

export class SplitTooLargeError extends Error {
    triangles: number;
    limit: number;
    constructor(triangles: number, limit: number) {
        super(`Too many triangles to split (${triangles.toLocaleString("en-US")}; the limit is ${limit.toLocaleString("en-US")}).`);
        this.name = "SplitTooLargeError";
        this.triangles = triangles;
        this.limit = limit;
    }
}

export interface SplitOptions {
    minFraction?: number;
    maxPieces?: number;
    maxTriangles?: number;
    /** Milliseconds of work between yields to the event loop (default 12). */
    sliceMs?: number;
    signal?: AbortSignal;
    /** 0..1, called after each chunk of work. */
    onProgress?: (fraction: number) => void;
    /** How to give the event loop a turn (default: scheduler.yield or setTimeout 0). */
    yieldFn?: () => Promise<void>;
    /** Per geometry: true when its mesh has one material, which three draws whole, groups or not (no triangle is dropped for lying outside a group). */
    ignoreGroups?: readonly boolean[];
}

/** One mesh of a piece: the triangles of one source geometry that belong to it and share one material. */
export interface PieceMesh {
    /** Index into the `geometries` passed in. */
    sourceIndex: number;
    /** Index into the source mesh's material array (0 for a single material). */
    materialIndex: number;
    geometry: THREE.BufferGeometry;
}

export interface SplitPiece {
    /** "Piece 1".. (largest first) or "Small pieces". */
    name: string;
    triangles: number;
    small: boolean;
    meshes: PieceMesh[];
}

export interface SplitResult {
    pieces: SplitPiece[];
    totalTriangles: number;
    /** Connected components found, before small ones were merged. */
    componentCount: number;
    /** Components merged into "Small pieces". */
    mergedCount: number;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function defaultYield(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === "function") return scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Slicer {
    due(): boolean;
    yield(): Promise<void>;
}

function createSlicer(sliceMs: number, yieldFn: () => Promise<void>, signal: AbortSignal | undefined): Slicer {
    let last = now();
    return {
        due: () => now() - last >= sliceMs,
        async yield() {
            signal?.throwIfAborted();
            await yieldFn();
            signal?.throwIfAborted();
            last = now();
        },
    };
}

/** Iterations per check of the clock: small enough to stay inside a slice, big enough to be cheap. */
const CHUNK = 16_384;

/** Runs body(0..count-1), yielding whenever the slice is used up; `done` gets the iterations since the last call. */
async function loop(count: number, slicer: Slicer, done: (iterations: number) => void, body: (i: number) => void): Promise<void> {
    for (let i = 0; i < count; ) {
        const end = Math.min(count, i + CHUNK);
        const from = i;
        for (; i < end; i += 1) body(i);
        done(end - from);
        if (slicer.due()) await slicer.yield();
    }
}

/** Triangles of a geometry (indexed or not). */
export function triangleCount(geometry: THREE.BufferGeometry): number {
    const position = geometry.getAttribute("position");
    const count = geometry.index ? geometry.index.count : (position?.count ?? 0);
    return Math.floor(count / 3);
}

/** Per triangle: its material index, or SKIP when geometry groups exist and none covers it (three would not draw it). */
const SKIP = 0xffff;

function materialMap(geometry: THREE.BufferGeometry, triangles: number): { count: number; of: Uint16Array | null } {
    const groups = geometry.groups;
    if (!groups.length) return { count: 1, of: null };
    const of = new Uint16Array(triangles).fill(SKIP);
    let max = 0;
    for (const group of groups) {
        const material = group.materialIndex ?? 0;
        const first = Math.max(0, Math.floor(group.start / 3));
        const last = Math.min(triangles, Math.floor((group.start + group.count) / 3));
        for (let t = first; t < last; t += 1) of[t] = material;
        max = Math.max(max, material);
    }
    return { count: max + 1, of };
}

/** Welded vertices live on a grid of this many cells per axis at most (3 x 17 bits fit a double exactly). */
const GRID_CELLS = 131_072;

interface Labelled {
    /** Per triangle: its component (0..sizes.length-1). */
    triComponent: Int32Array;
    /** Triangles per component. */
    sizes: number[];
}

/** Connected components of a geometry's triangles. */
async function labelComponents(geometry: THREE.BufferGeometry, slicer: Slicer, done: (units: number) => void): Promise<Labelled> {
    const position = geometry.getAttribute("position");
    const n = position.count;
    const indexArray = geometry.index ? geometry.index.array : null;
    const triangles = triangleCount(geometry);
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    const diagonal = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() || 1;
    // Cells of 1e-5 of the diagonal: bit-identical duplicates always land together, float noise from an export does too.
    const inverse = 1 / (diagonal * 1e-5);
    const [minX, minY, minZ] = [box.min.x, box.min.y, box.min.z];

    // 1. weld vertices by quantised position (open-addressing hash table over the packed cell key)
    let capacity = 16;
    while (capacity < n * 2) capacity *= 2;
    const mask = capacity - 1;
    const keys = new Float64Array(capacity).fill(-1);
    const values = new Int32Array(capacity);
    const weld = new Int32Array(n);
    let welds = 0;
    const cell = (value: number) => {
        const c = Math.floor(value);
        return c >= 0 ? Math.min(c, GRID_CELLS - 1) : 0;
    };
    await loop(n, slicer, done, (v) => {
        const ix = cell((position.getX(v) - minX) * inverse);
        const iy = cell((position.getY(v) - minY) * inverse);
        const iz = cell((position.getZ(v) - minZ) * inverse);
        const key = (ix * GRID_CELLS + iy) * GRID_CELLS + iz;
        let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
        for (;;) {
            const k = keys[h];
            if (k === key) {
                weld[v] = values[h];
                return;
            }
            if (k === -1) {
                keys[h] = key;
                values[h] = welds;
                weld[v] = welds;
                welds += 1;
                return;
            }
            h = (h + 1) & mask;
        }
    });

    // 2. union the welded vertices of every triangle
    const parent = new Int32Array(welds);
    for (let i = 0; i < welds; i += 1) parent[i] = i;
    const find = (x: number) => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        if (ra < rb) parent[rb] = ra;
        else parent[ra] = rb;
    };
    const vertex = (t: number, k: number) => (indexArray ? indexArray[3 * t + k] : 3 * t + k);
    await loop(triangles, slicer, done, (t) => {
        const a = weld[vertex(t, 0)];
        const b = weld[vertex(t, 1)];
        const c = weld[vertex(t, 2)];
        union(a, b);
        union(b, c);
    });

    // 3. number the roots and count their triangles
    const componentOfRoot = new Int32Array(welds).fill(-1);
    const triComponent = new Int32Array(triangles);
    const sizes: number[] = [];
    await loop(triangles, slicer, done, (t) => {
        const root = find(weld[vertex(t, 0)]);
        let component = componentOfRoot[root];
        if (component < 0) {
            component = sizes.length;
            componentOfRoot[root] = component;
            sizes.push(0);
        }
        triComponent[t] = component;
        sizes[component] += 1;
    });
    return { triComponent, sizes };
}

const nothing = () => {};

const readComponent = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number, component: number): number => {
    switch (component) {
        case 0:
            return attribute.getX(index);
        case 1:
            return attribute.getY(index);
        case 2:
            return attribute.getZ(index);
        default:
            return attribute.getW(index);
    }
};

type TypedArrayCtor = new (length: number) => THREE.TypedArray;

/**
 * A compact copy of `source` holding only the given triangles: used vertices renumbered in first-use
 * order, every attribute copied (interleaved ones become plain float attributes), a 16-bit index
 * when it fits. `remap` is scratch space of source.vertexCount, all -1 on entry and on exit.
 */
async function extractTriangles(source: THREE.BufferGeometry, triangleIds: Uint32Array, remap: Int32Array, slicer: Slicer, done: (units: number) => void): Promise<THREE.BufferGeometry> {
    const indexArray = source.index ? source.index.array : null;
    const count = triangleIds.length;
    const used = new Uint32Array(Math.min(remap.length, count * 3));
    const index = new Uint32Array(count * 3);
    let usedCount = 0;
    await loop(count, slicer, done, (i) => {
        const t = triangleIds[i];
        for (let k = 0; k < 3; k += 1) {
            const v = indexArray ? indexArray[3 * t + k] : 3 * t + k;
            let local = remap[v];
            if (local < 0) {
                local = usedCount;
                remap[v] = local;
                used[usedCount] = v;
                usedCount += 1;
            }
            index[3 * i + k] = local;
        }
    });

    const geometry = new THREE.BufferGeometry();
    for (const name of Object.keys(source.attributes)) {
        const attribute = source.attributes[name];
        const itemSize = attribute.itemSize;
        const interleaved = (attribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute === true;
        const Ctor = (interleaved ? Float32Array : attribute.array.constructor) as unknown as TypedArrayCtor;
        const out = new Ctor(usedCount * itemSize);
        // Per attribute and sliced like the rest: a 1.5M-vertex piece would otherwise hold the page for tens of milliseconds.
        if (interleaved) {
            await loop(usedCount, slicer, nothing, (u) => {
                for (let c = 0; c < itemSize; c += 1) out[u * itemSize + c] = readComponent(attribute as THREE.InterleavedBufferAttribute, used[u], c);
            });
        } else {
            const from = attribute.array as ArrayLike<number>;
            await loop(usedCount, slicer, nothing, (u) => {
                const src = used[u] * itemSize;
                const dst = u * itemSize;
                for (let c = 0; c < itemSize; c += 1) out[dst + c] = from[src + c];
            });
        }
        geometry.setAttribute(name, new THREE.BufferAttribute(out, itemSize, interleaved ? false : attribute.normalized));
    }
    geometry.setIndex(new THREE.BufferAttribute(usedCount <= 65_535 ? new Uint16Array(index) : index, 1));
    for (let u = 0; u < usedCount; u += 1) remap[used[u]] = -1;
    return geometry;
}

/**
 * Splits geometries into connected pieces (see the header). Components are ranked across all the
 * geometries together, so "Piece 1" is the biggest piece of the whole model.
 * @throws SplitTooLargeError over `maxTriangles`; the signal's reason when aborted.
 */
export async function splitGeometries(geometries: readonly THREE.BufferGeometry[], options: SplitOptions = {}): Promise<SplitResult> {
    const minFraction = options.minFraction ?? SPLIT_MIN_FRACTION;
    const maxPieces = options.maxPieces ?? SPLIT_MAX_PIECES;
    const maxTriangles = options.maxTriangles ?? SPLIT_MAX_TRIANGLES;
    const counts = geometries.map(triangleCount);
    const total = counts.reduce((sum, c) => sum + c, 0);
    if (total > maxTriangles) throw new SplitTooLargeError(total, maxTriangles);

    const slicer = createSlicer(options.sliceMs ?? 12, options.yieldFn ?? defaultYield, options.signal);
    // Work units: a weld per vertex, then a union, a label and a copy per triangle.
    const totalUnits = Math.max(
        1,
        geometries.reduce((sum, g, i) => sum + (g.getAttribute("position")?.count ?? 0) + 3 * counts[i], 0),
    );
    let doneUnits = 0;
    const done = (units: number) => {
        doneUnits += units;
        options.onProgress?.(Math.min(1, doneUnits / totalUnits));
    };

    const labelled: Labelled[] = [];
    for (const geometry of geometries) labelled.push(await labelComponents(geometry, slicer, done));

    // Rank every component of every geometry by size; keep the big ones.
    const all: Array<{ source: number; component: number; size: number }> = [];
    labelled.forEach((l, source) => l.sizes.forEach((size, component) => all.push({ source, component, size })));
    all.sort((a, b) => b.size - a.size || a.source - b.source || a.component - b.component);
    const threshold = total * minFraction;
    const limit = Math.max(0, maxPieces);
    let kept = all.filter((e) => e.size >= threshold).slice(0, limit);
    // Many comparable bodies (a bead string, a bolt array) can each fall under the threshold: the biggest are still the pieces.
    if (kept.length === 0 && all.length > 1) kept = all.slice(0, limit);
    const pieceOf = labelled.map((l) => new Int32Array(l.sizes.length).fill(-1));
    kept.forEach((e, i) => {
        pieceOf[e.source][e.component] = i;
    });

    const pieces: SplitPiece[] = kept.map((_, i) => ({ name: `Piece ${i + 1}`, triangles: 0, small: false, meshes: [] }));
    const small: SplitPiece = { name: SMALL_PIECES_NAME, triangles: 0, small: true, meshes: [] };
    const smallBucket = kept.length;

    for (let source = 0; source < geometries.length; source += 1) {
        const geometry = geometries[source];
        const triangles = counts[source];
        const { triComponent } = labelled[source];
        const { count: materials, of: materialOf } = options.ignoreGroups?.[source] ? { count: 1, of: null } : materialMap(geometry, triangles);
        const buckets = (smallBucket + 1) * materials;
        const sizes = new Uint32Array(buckets);
        const keyOf = (t: number) => {
            const material = materialOf ? materialOf[t] : 0;
            if (material === SKIP) return -1;
            const piece = pieceOf[source][triComponent[t]];
            return (piece >= 0 ? piece : smallBucket) * materials + material;
        };
        await loop(triangles, slicer, nothing, (t) => {
            const key = keyOf(t);
            if (key >= 0) sizes[key] += 1;
        });
        const lists: Array<Uint32Array | undefined> = [];
        const fill = new Uint32Array(buckets);
        for (let key = 0; key < buckets; key += 1) if (sizes[key]) lists[key] = new Uint32Array(sizes[key]);
        await loop(triangles, slicer, nothing, (t) => {
            const key = keyOf(t);
            if (key >= 0) lists[key]![fill[key]++] = t;
        });
        const remap = new Int32Array(geometry.getAttribute("position").count).fill(-1);
        for (let key = 0; key < buckets; key += 1) {
            const list = lists[key];
            if (!list) continue;
            const piece = Math.floor(key / materials) === smallBucket ? small : pieces[Math.floor(key / materials)];
            const part = await extractTriangles(geometry, list, remap, slicer, done);
            piece.meshes.push({ sourceIndex: source, materialIndex: key % materials, geometry: part });
            piece.triangles += list.length;
        }
    }

    // A body whose triangles all lie outside the material groups draws nothing: it is not a piece (the numbering closes up).
    const drawn = pieces.filter((piece) => piece.meshes.length);
    drawn.forEach((piece, i) => (piece.name = `Piece ${i + 1}`));
    return {
        pieces: small.meshes.length ? [...drawn, small] : drawn,
        totalTriangles: total,
        componentCount: all.length,
        mergedCount: all.length - kept.length,
    };
}
