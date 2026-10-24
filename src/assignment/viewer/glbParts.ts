// Part extraction from a glTF node hierarchy. Pure (three types only), so Node can test it.
//
// A part is one node (with its whole subtree) that carries geometry. Text-to-3D assemblies come
// as wrapper nodes ("Sketchfab_model" > "Root" > ...) around the real parts, so single-child
// wrappers are skipped; what is left below them are the parts.
import * as THREE from "three";

/** `userData` flag on a Group that is one glTF mesh with several primitives (one object, many materials). */
export const MESH_GROUP_FLAG = "glbMeshGroup";

/** Names a tool invents when the author gave none ("mesh_3", "Object_12", "Node 4"): they say nothing, so "Part N" wins. */
const GENERIC_NAME = /^(mesh|node|object|group|geometry|scene|primitive|shape)[\s._-]*\d*$/i;

export function isGenericName(name: string): boolean {
    const trimmed = name.trim();
    return trimmed === "" || GENERIC_NAME.test(trimmed);
}

export interface PartSpec {
    /** Pick id: "p1", "p2"... */
    id: string;
    /** Display name, de-duplicated. */
    name: string;
    /** The part's top object; its subtree is the part. */
    object: THREE.Object3D;
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

/** Meshes at or below `object` (skinned and instanced ones included; they are still geometry). */
export function meshesOf(object: THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    object.traverse((o) => {
        if (isMesh(o)) out.push(o);
    });
    return out;
}

/** True when `object` or anything below it is a mesh. */
export function hasGeometry(object: THREE.Object3D): boolean {
    if (isMesh(object)) return true;
    for (const child of object.children) if (hasGeometry(child)) return true;
    return false;
}

/** A node that is one part by itself: it holds geometry (a Mesh), or is a multi-primitive mesh group. */
function isAtomic(object: THREE.Object3D): boolean {
    return isMesh(object) || object.userData[MESH_GROUP_FLAG] === true;
}

/**
 * The part roots of a glTF scene. Descends while exactly one child carries geometry and the node
 * holds none itself (a wrapper); then each child with geometry is a part. A node that is itself a
 * mesh (or a multi-primitive mesh group) is one part with its whole subtree.
 */
export function findPartRoots(scene: THREE.Object3D): THREE.Object3D[] {
    let node = scene;
    for (;;) {
        if (isAtomic(node)) return [node];
        const carriers = node.children.filter(hasGeometry);
        if (carriers.length === 1) {
            node = carriers[0];
            continue;
        }
        return carriers;
    }
}

/** The name the author gave a node: glTF's own (userData.name keeps spaces GLTFLoader sanitised away). */
function authoredName(object: THREE.Object3D): string {
    const original = object.userData.name;
    return (typeof original === "string" ? original : object.name).trim();
}

/**
 * Display names for part roots, in order: the authored name, or "Part N" (N = 1-based position)
 * when there is none or it is generic; a name used before gets " · 2", " · 3"...
 */
export function nameParts(roots: readonly THREE.Object3D[]): string[] {
    const seen = new Map<string, number>();
    return roots.map((root, index) => {
        const authored = authoredName(root);
        const base = isGenericName(authored) ? `Part ${index + 1}` : authored;
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base} · ${count}`;
    });
}

/** The parts of a glTF scene, ids "p1".., names de-duplicated. Empty when the scene holds no geometry. */
export function extractParts(scene: THREE.Object3D): PartSpec[] {
    const roots = findPartRoots(scene);
    const names = nameParts(roots);
    return roots.map((object, i) => ({ id: `p${i + 1}`, name: names[i], object }));
}

/** Triangles drawn by one mesh. */
export function meshTriangles(mesh: THREE.Mesh): number {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return 0;
    const position = geometry.getAttribute("position");
    const count = geometry.index ? geometry.index.count : (position?.count ?? 0);
    return Math.floor(count / 3);
}

/** Triangles of every mesh at or below `object` (an instanced mesh counts once per instance). */
export function countTriangles(object: THREE.Object3D): number {
    let total = 0;
    for (const mesh of meshesOf(object)) {
        const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
        total += meshTriangles(mesh) * instances;
    }
    return total;
}

/**
 * Flags the Groups GLTFLoader made for a mesh with several primitives, using the loader's
 * `parser.associations`: a Group associated with a glTF mesh whose children are all primitives of
 * that same mesh (meshes, and line or point primitives too). findPartRoots then keeps such an object
 * as one part instead of one part per material.
 */
export function tagMeshGroups(scene: THREE.Object3D, associations: ReadonlyMap<unknown, { meshes?: number; primitives?: number }>): number {
    let tagged = 0;
    scene.traverse((o) => {
        if (!(o as THREE.Group).isGroup || o.children.length < 2) return;
        const mesh = associations.get(o)?.meshes;
        if (mesh === undefined) return;
        const primitives = o.children.every((c) => {
            const a = associations.get(c);
            return c.children.length === 0 && a?.meshes === mesh && a.primitives !== undefined;
        });
        if (!primitives) return;
        o.userData[MESH_GROUP_FLAG] = true;
        tagged += 1;
    });
    return tagged;
}

// ---------- triangle soup (for the structural analysis) ----------

/** A mesh's triangles in index order: drawn range respected, a missing index meaning 0, 1, 2... */
function drawnTriangles(mesh: THREE.Mesh): { position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; index: THREE.BufferAttribute | null; first: number; count: number } | null {
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute("position");
    if (!geometry || !position || position.itemSize < 3) return null;
    const total = geometry.index ? geometry.index.count : position.count;
    const first = Math.max(0, geometry.drawRange.start);
    const count = Math.max(0, Math.min(geometry.drawRange.count, total - first));
    return { position, index: geometry.index, first: first - (first % 3), count: count - (count % 3) };
}

/** Triangles `soup` would hold for `root` (instances counted). */
export function soupTriangleCount(root: THREE.Object3D): number {
    let total = 0;
    for (const mesh of meshesOf(root)) {
        const drawn = drawnTriangles(mesh);
        if (!drawn) continue;
        const instances = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
        total += (drawn.count / 3) * instances;
    }
    return total;
}

/**
 * Every triangle of every mesh at or below `root` as 9 floats (x, y, z of 3 vertices), with the meshes' world
 * matrices (and an instanced mesh's per-instance matrices) applied. Visibility is ignored: hidden parts are
 * model too. Skinning and morph targets are not applied (the bind pose). Triangles with a non-finite corner
 * are left out. The caller makes sure the world matrices are current (`root.updateMatrixWorld(true)`).
 */
export function extractTriangleSoup(root: THREE.Object3D): Float32Array {
    const out = new Float32Array(soupTriangleCount(root) * 9);
    let o = 0;
    const m = new THREE.Matrix4();
    const e = m.elements;
    const corner = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const mesh of meshesOf(root)) {
        const drawn = drawnTriangles(mesh);
        if (!drawn) continue;
        const { position, index, first, count } = drawn;
        const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
        const instance = new THREE.Matrix4();
        for (let n = 0; n < (instanced ? instanced.count : 1); n += 1) {
            if (instanced) {
                instanced.getMatrixAt(n, instance);
                m.multiplyMatrices(mesh.matrixWorld, instance);
            } else m.copy(mesh.matrixWorld);
            for (let t = first; t < first + count; t += 3) {
                let finite = true;
                for (let v = 0; v < 3; v += 1) {
                    const at = index ? index.getX(t + v) : t + v;
                    const x = position.getX(at);
                    const y = position.getY(at);
                    const z = position.getZ(at);
                    const px = e[0] * x + e[4] * y + e[8] * z + e[12];
                    const py = e[1] * x + e[5] * y + e[9] * z + e[13];
                    const pz = e[2] * x + e[6] * y + e[10] * z + e[14];
                    if (!Number.isFinite(px + py + pz)) finite = false;
                    corner[v * 3] = px;
                    corner[v * 3 + 1] = py;
                    corner[v * 3 + 2] = pz;
                }
                if (!finite) continue;
                for (let k = 0; k < 9; k += 1) out[o++] = corner[k];
            }
        }
    }
    // Skipped triangles leave a tail of zeros: hand back exactly what was filled.
    return o === out.length ? out : out.slice(0, o);
}
