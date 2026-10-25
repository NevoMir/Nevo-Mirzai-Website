/**
 * The scene a GLB becomes in the viewer: Cably's three lights plus a RoomEnvironment (PBR and metal
 * textures render black without one), the glTF (metres, +Y up) wrapped into Cably's convention
 * (millimetres, +Z up, longest side ~100 mm, centred on XY, bottom on z = 0), the parts, and the
 * hover / selection / isolate / hide looks ported from Cably's scene.ts. Also the exploded view and
 * "split into parts". Imports three: load it lazily.
 *
 * Ownership: this scene owns everything under the glTF scene (geometries, materials, textures) and
 * the pieces it makes; the environment texture belongs to the viewer and is shared by every scene.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { GhostSource } from "./analysisLayer.ts";
import { explodeFactor, explodeOffsets, unionCentre, worldDeltaToLocal } from "./explode.ts";
import { countTriangles, extractParts, extractTriangleSoup, meshesOf } from "./glbParts.ts";
import { rememberPartSoups } from "./partSoups.ts";
import type { PartSoup } from "../analysis/partLabels.ts";
import type { ViewerOverlayHit, ViewerScene } from "./orbitViewer.ts";
import { splitGeometries, type SplitOptions } from "./splitComponents.ts";
import type { LookPatch, PartRow, Vec3 } from "./types.ts";

/** Text-to-3D scale is arbitrary; the grid and clip logic assume mm, so the longest side is made this long. */
export const TARGET_SIZE_MM = 100;
/**
 * Diffuse light per unit albedo (top / front / right / bottom): the three lights alone gave 1.10 / 0.64 /
 * 0.54 / 0.17. The environment only counts since the viewer hands it to its root scene; with the first
 * tuning (hemisphere 1.9, environment 0.5) it would give 1.9 / 1.5 / 0.97 / 0.43 and light parts clip to
 * white. These two values give 1.15 / 0.87 / 0.52 / 0.20 (a CPU estimate from RoomEnvironment's
 * cosine-weighted radiance, not a GPU render).
 */
export const ENVIRONMENT_INTENSITY = 0.3;
const HEMISPHERE_INTENSITY = 0.5;
/** Cably's selection blue; a selected part's colour goes this far toward it, a hovered one's less. */
export const SELECT_COLOR = "#2563eb";
const SELECT_TINT = { selected: 0.35, hover: 0.15 } as const;
/** The other parts while isolating. */
const GHOST_OPACITY = 0.15;
/** A part with more triangles than this gets no feature edges: EdgesGeometry runs on the main thread (~2 ms per 1k triangles). */
export const EDGES_MAX_TRIANGLES = 20_000;
const EDGE_ANGLE_DEG = 38;

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

/** Drawn: the object and every ancestor visible. */
const shown = (o: THREE.Object3D) => {
    for (let a: THREE.Object3D | null = o; a; a = a.parent) if (!a.visible) return false;
    return true;
};

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

// ---------- environment ----------

export interface Environment {
    texture: THREE.Texture;
    dispose(): void;
}

/** A prefiltered RoomEnvironment for `renderer`: made once per viewer, shared by every scene it shows. */
export function createEnvironment(renderer: THREE.WebGLRenderer): Environment {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    return { texture: target.texture, dispose: () => target.dispose() };
}

/** Cably's three lights, and the shared environment when there is one: what both the model and the block view are lit by. */
export function addStageLighting(scene: THREE.Scene, environment?: THREE.Texture | null): void {
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8a8f98, HEMISPHERE_INTENSITY);
    hemisphere.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, -1, 1.6);
    const fill = new THREE.DirectionalLight(0xffffff, 0.55);
    fill.position.set(-1, 0.8, 0.7);
    scene.add(hemisphere, key, fill);
    if (environment) {
        scene.environment = environment;
        scene.environmentIntensity = ENVIRONMENT_INTENSITY;
        scene.environmentRotation.x = Math.PI / 2; // the room's up is +Y; ours is +Z
    }
}

// ---------- disposal ----------

/** Frees the GPU and bitmap memory of everything under `root`: geometries, materials, their textures. */
export function disposeObject(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    root.traverse((o) => {
        const { geometry, material } = o as THREE.Mesh;
        if (geometry) geometries.add(geometry);
        if (material) for (const m of [material].flat()) materials.add(m);
        // Not covered by geometry or material disposal: a skeleton's bone texture, an instanced mesh's matrix buffers.
        (o as THREE.SkinnedMesh).skeleton?.dispose();
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    const textures = new Set<THREE.Texture>();
    for (const material of materials) {
        for (const value of Object.values(material)) if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
        material.dispose();
    }
    for (const texture of textures) {
        // Decoded textures are ImageBitmaps: dispose() frees the GPU copy, close() the CPU one.
        const image = texture.image as unknown;
        texture.dispose();
        if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close();
    }
    for (const geometry of geometries) geometry.dispose();
}

// ---------- the scene ----------

export interface GlbSceneOptions {
    /** Shared PBR environment (see createEnvironment); none: the three lights alone. */
    environment?: THREE.Texture | null;
    /** The scene changed after the fact (edges built when idle): render a frame. */
    onChange?: () => void;
}

export interface SplitSummary {
    /** False when nothing was split (one connected piece): the scene is as it was. */
    changed: boolean;
    pieces: number;
    /** Connected components merged into "Small pieces". */
    merged: number;
    /** Connected components the model has (1: it really is one piece). */
    components: number;
}

/**
 * Something drawn with the model that is not part of it: the cubes of the stabilizer's added supports. The scene adds `object`
 * to itself, frames `framed` and joins `box` to its bounds while `object` is visible, and offers `pick` to the viewer's
 * pointer tests. The owner (see useSupportsOverlay) builds it, shows or hides it and disposes it; the scene never frees it.
 */
export interface SceneOverlay {
    /** Goes into the scene (the display frame). Hidden with `object.visible`. */
    object: THREE.Object3D;
    /** The part of `object` Fit frames (the marks of a hover are left out). */
    framed: THREE.Object3D;
    /** World bounds of what is framed: joined to the scene's bounds while the overlay is shown. */
    box: THREE.Box3;
    /** The nearest thing a world ray meets: its id (never a part's), the world point and the distance along the ray. */
    pick?(ray: THREE.Ray): ViewerOverlayHit | null;
}

export interface GlbScene extends ViewerScene {
    /** The parts as the list and the card say them (the glTF's, or the split pieces). */
    readonly rows: readonly PartRow[];
    /** Triangles of the whole model. */
    readonly triangles: number;
    /** Parts the glTF itself has. */
    readonly nativePartCount: number;
    /** A single-part model can be cut into connected pieces. */
    readonly canSplit: boolean;
    readonly isSplit: boolean;
    /** Hover, selection, hidden parts, isolation: what is lit, ghosted or hidden. Unknown ids are ignored. */
    update(patch: LookPatch): void;
    objectsOf(id: string): THREE.Object3D[];
    /** 0-100: parts move away from the assembly centre. Kept across split and unsplit. */
    setExplode(percent: number): void;
    /**
     * The model's triangles as 9 floats each, in this scene's frame (Z-up, longest side ~100) as loaded: no explode
     * or split offsets, hidden parts and every mesh included, world transforms baked. Empty once disposed.
     */
    extractTriangles(): Float32Array;
    /**
     * The model's triangles cut into the glTF's own parts (not the split pieces), each in the same frame as extractTriangles, named as the
     * Parts list names them. For labelling the blocks by part (analysis/partLabels.ts). Empty once disposed.
     */
    partSoups(): PartSoup[];
    /** The glTF's meshes as loaded (geometry shared, not copied), for the block view's ghost of the model. */
    ghostSources(): GhostSource[];
    /**
     * Puts an overlay (or none) beside the parts. It is framed with them (Fit, the presets, the thumbnail), counts in the bounds and
     * is picked by the viewer, all while its `object` is visible; it is not a part: no row, no hiding, no isolating, no explode.
     * Replacing it takes the old one out of the scene (the caller disposes that one). No-op once the scene is disposed.
     */
    setOverlay(overlay: SceneOverlay | null): void;
    /** Shows or hides the overlay (bounds and framing follow); true when that changed something. */
    setOverlayVisible(visible: boolean): boolean;
    /** Cuts the model into connected pieces. Resets selection, hiding and isolation. */
    split(options?: SplitOptions): Promise<SplitSummary>;
    unsplit(): void;
    dispose(): void;
}

/** Glue between the glTF and Cably's frame: Y-up metres -> Z-up mm, longest side TARGET_SIZE_MM, centred on XY, bottom on z = 0. */
function normalise(model: THREE.Group, content: THREE.Object3D): void {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(content, true);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const scale = longest > 0 && Number.isFinite(longest) ? TARGET_SIZE_MM / longest : 1;
    model.rotation.x = Math.PI / 2;
    model.scale.setScalar(scale);
    // A glTF point (x, y, z) lands at (x, -z, y) * scale: centre x and y, put the lowest point (glTF y) on z = 0.
    const centreX = ((box.min.x + box.max.x) / 2) * scale;
    const centreY = (-(box.min.z + box.max.z) / 2) * scale;
    model.position.set(-centreX, -centreY, -box.min.y * scale);
    model.updateMatrixWorld(true);
}

/** Runs `fn` when the browser is idle (soon at the latest); returns the cancel. */
function whenIdle(fn: () => void): () => void {
    if (typeof requestIdleCallback === "function") {
        const handle = requestIdleCallback(fn, { timeout: 500 });
        return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(fn, 1);
    return () => clearTimeout(handle);
}

/**
 * Builds the scene for a parsed glTF. The scene takes ownership of `gltfScene` (dispose() frees it).
 * @throws Error when the glTF holds no geometry.
 */
export function buildGlbScene(gltfScene: THREE.Object3D, options: GlbSceneOptions = {}): GlbScene {
    const specs = extractParts(gltfScene);
    if (!specs.length) throw new Error("This model has no 3D geometry to show.");

    const scene = new THREE.Scene();
    addStageLighting(scene, options.environment);

    const root = new THREE.Group();
    root.name = "assembly:root";
    const model = new THREE.Group();
    model.name = "assembly:model";
    model.add(gltfScene);
    root.add(model);
    scene.add(root);
    normalise(model, gltfScene);

    // Parts: the glTF's own, or (after split) the pieces. `parts` is one Map, mutated in place, because the viewer holds the handle.
    const parts = new Map<string, THREE.Object3D>();
    const nativeParts = new Map<string, THREE.Object3D>();
    const names = new Map<string, string>();
    for (const spec of specs) {
        spec.object.userData.componentId = spec.id;
        nativeParts.set(spec.id, spec.object);
        parts.set(spec.id, spec.object);
        names.set(spec.id, spec.name);
    }
    const rowFor = (id: string, part: THREE.Object3D): PartRow => {
        const box = new THREE.Box3().setFromObject(part, true);
        return { id, name: names.get(id) ?? id, triangles: countTriangles(part), size: box.isEmpty() ? null : (box.getSize(new THREE.Vector3()).toArray() as Vec3) };
    };
    const buildRows = () => [...parts].map(([id, part]) => rowFor(id, part));
    let rows = buildRows();
    const triangles = countTriangles(gltfScene);

    const bounds = new THREE.Box3();
    let revision = 0;
    /** What is drawn with the parts without being one (see SceneOverlay). */
    let overlay: SceneOverlay | null = null;
    const refreshBounds = () => {
        bounds.makeEmpty();
        for (const part of parts.values()) bounds.union(new THREE.Box3().setFromObject(part));
        if (overlay?.object.visible) bounds.union(overlay.box);
        revision += 1;
    };
    refreshBounds();

    // ---- looks (ported from Cably's scene.ts) ----
    let hoverId: string | null = null;
    let selectedIds: readonly string[] = [];
    let hiddenIds = new Set<string>();
    let isolatedIds: Set<string> | null = null;
    /** Each mesh or line not showing its own material: its own, and what it shows (a clone tinted toward the blue, or the ghost). */
    type Looked = THREE.Mesh | THREE.LineSegments;
    const looks = new Map<Looked, { original: THREE.Material | THREE.Material[]; look: number | "ghost" }>();
    const hiddenObjects = new Set<THREE.Object3D>();
    /** Feature edges per geometry (null: over EDGES_MAX_TRIANGLES), built once. */
    const edgeCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry | null>();
    const highlight = new THREE.Group();
    highlight.name = "assembly:highlight";
    scene.add(highlight);
    const blue = new THREE.Color(SELECT_COLOR);
    const selectEdges = new THREE.LineBasicMaterial({ color: SELECT_COLOR });
    const ghostMaterial = new THREE.MeshStandardMaterial({ color: "#8b929c", roughness: 0.8, transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    const ghostLine = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.06 });
    let disposed = false;
    let cancelEdges: (() => void) | null = null;

    const ghosted = (id: string) => !!isolatedIds && !isolatedIds.has(id);
    /** The drawn meshes of a part (none while it, or an ancestor, is hidden). */
    const drawnMeshes = (id: string | null): THREE.Mesh[] => {
        const part = id === null ? undefined : parts.get(id);
        if (!part || !shown(part)) return [];
        const out: THREE.Mesh[] = [];
        part.traverseVisible((o) => {
            if (isMesh(o)) out.push(o);
        });
        return out;
    };
    /** Its meshes and its lines (baked edge lines): what isolate ghosts. */
    const drawnLooked = (id: string): Looked[] => {
        const part = parts.get(id);
        if (!part || !shown(part)) return [];
        const out: Looked[] = [];
        part.traverseVisible((o) => {
            if (isMesh(o) || (o as THREE.LineSegments).isLineSegments) out.push(o as Looked);
        });
        return out;
    };

    const tint = (material: THREE.Material, k: number) => {
        const clone = material.clone();
        const standard = clone as THREE.MeshStandardMaterial;
        standard.color?.lerp(blue, k);
        if (k === SELECT_TINT.selected) {
            standard.emissive?.copy(blue).multiplyScalar(0.12);
            // Pushed back a hair, so the selection's edge lines win the depth test against the faces they lie on.
            clone.polygonOffset = true;
            clone.polygonOffsetFactor = 1;
            clone.polygonOffsetUnits = 1;
        }
        return clone;
    };
    /** A mesh back to its own material, a clone disposed (textures are shared with the original: never touched). */
    const restore = (mesh: Looked) => {
        const entry = looks.get(mesh);
        if (!entry) return;
        if (entry.look !== "ghost") for (const clone of [mesh.material].flat()) clone.dispose();
        mesh.material = entry.original;
        looks.delete(mesh);
    };
    const unlight = () => {
        for (const mesh of [...looks.keys()]) restore(mesh);
        highlight.clear();
    };
    const edgesFor = (meshes: THREE.Mesh[]) => {
        for (const { geometry } of meshes) {
            if (edgeCache.has(geometry)) continue;
            const position = geometry.getAttribute("position");
            const count = (geometry.index ? geometry.index.count : (position?.count ?? 0)) / 3;
            edgeCache.set(geometry, position && count <= EDGES_MAX_TRIANGLES ? new THREE.EdgesGeometry(geometry, EDGE_ANGLE_DEG) : null);
        }
    };
    /** The selection's edges built so far, as world-space lines. */
    const drawEdges = () => {
        highlight.clear();
        scene.updateMatrixWorld(true);
        for (const id of selectedIds) {
            for (const mesh of drawnMeshes(id)) {
                const edges = edgeCache.get(mesh.geometry);
                if (!edges) continue;
                const lines = new THREE.LineSegments(edges, selectEdges);
                lines.matrixAutoUpdate = false;
                lines.matrix.copy(mesh.matrixWorld);
                lines.renderOrder = 3;
                highlight.add(lines);
            }
        }
    };
    const applyHidden = () => {
        for (const o of hiddenObjects) o.visible = true;
        hiddenObjects.clear();
        for (const id of hiddenIds) {
            const part = parts.get(id);
            if (!part) continue;
            part.visible = false;
            hiddenObjects.add(part);
        }
    };
    /** The looks for the current hover, selection and isolation. A mesh already showing what it should keeps it. */
    const relight = (redrawEdges = true) => {
        const want = new Map<Looked, number | "ghost">();
        if (isolatedIds) {
            for (const id of parts.keys()) if (ghosted(id)) for (const o of drawnLooked(id)) want.set(o, "ghost");
        }
        for (const mesh of selectedIds.flatMap(drawnMeshes)) want.set(mesh, SELECT_TINT.selected);
        for (const mesh of drawnMeshes(hoverId)) if (!want.has(mesh)) want.set(mesh, SELECT_TINT.hover);
        for (const [mesh, { look }] of [...looks]) if (want.get(mesh) !== look) restore(mesh);
        for (const [mesh, look] of want) {
            if (looks.has(mesh)) continue;
            looks.set(mesh, { original: mesh.material, look });
            if (look === "ghost") mesh.material = isMesh(mesh) ? ghostMaterial : ghostLine;
            else mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => tint(m, look)) : tint(mesh.material, look);
        }
        if (redrawEdges) drawEdges();
    };
    /** Builds the selection's missing edges when the browser is idle, then draws them. */
    const scheduleEdges = () => {
        cancelEdges?.();
        cancelEdges = whenIdle(() => {
            cancelEdges = null;
            if (disposed) return;
            edgesFor(selectedIds.flatMap(drawnMeshes));
            drawEdges();
            options.onChange?.();
        });
    };

    // ---- exploded view ----
    let explodePercent = 0;
    /** Per part: its local position and world centre at 0 %, captured the first time the view is exploded. */
    let explodeBase: { positions: Map<string, THREE.Vector3>; centres: Map<string, THREE.Vector3>; centre: THREE.Vector3 } | null = null;
    const captureExplodeBase = () => {
        scene.updateMatrixWorld(true);
        const boxes = new Map<string, THREE.Box3>();
        const positions = new Map<string, THREE.Vector3>();
        for (const [id, part] of parts) {
            boxes.set(id, new THREE.Box3().setFromObject(part));
            positions.set(id, part.position.clone());
        }
        const centres = new Map<string, THREE.Vector3>();
        for (const [id, box] of boxes) centres.set(id, box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()));
        explodeBase = { positions, centres, centre: unionCentre([...boxes.values()]) ?? new THREE.Vector3() };
    };
    /** Every part back at its 0 % position (before the part set changes). */
    const resetExplode = () => {
        if (!explodeBase) return;
        for (const [id, part] of parts) {
            const base = explodeBase.positions.get(id);
            if (base) part.position.copy(base);
        }
        explodeBase = null;
        scene.updateMatrixWorld(true);
    };
    const applyExplode = () => {
        if (!explodeBase && explodePercent === 0) return;
        if (!explodeBase) captureExplodeBase();
        const base = explodeBase!;
        const ids = [...parts.keys()];
        const offsets = explodeOffsets(
            ids.map((id) => base.centres.get(id) ?? base.centre),
            base.centre,
            explodeFactor(explodePercent),
        );
        ids.forEach((id, i) => {
            const part = parts.get(id)!;
            part.position.copy(base.positions.get(id)!).add(worldDeltaToLocal(part.parent?.matrixWorld, offsets[i]));
        });
        scene.updateMatrixWorld(true);
        refreshBounds();
        drawEdges();
        options.onChange?.();
    };

    /**
     * Runs `fn` with the glTF's meshes where they were when the file was loaded: parts moved by the exploded view
     * are put back for the duration (split pieces are separate objects and never move the glTF's meshes).
     */
    const asLoaded = <T>(fn: () => T): T => {
        const moved = explodeBase !== null && splitGroup === null ? [...parts] : [];
        const saved = moved.map(([, part]) => part.position.clone());
        if (explodeBase) for (const [id, part] of moved) part.position.copy(explodeBase.positions.get(id) ?? part.position);
        scene.updateMatrixWorld(true);
        try {
            return fn();
        } finally {
            moved.forEach(([, part], i) => part.position.copy(saved[i]));
            scene.updateMatrixWorld(true);
        }
    };

    // ---- split ----
    let splitGroup: THREE.Group | null = null;
    const forgetLooks = () => {
        unlight();
        hoverId = null;
        selectedIds = [];
        hiddenIds = new Set();
        isolatedIds = null;
        applyHidden();
    };
    const swapParts = (next: Map<string, THREE.Object3D>) => {
        resetExplode();
        forgetLooks();
        parts.clear();
        for (const [id, part] of next) parts.set(id, part);
        // New objects have never had their world matrix computed: sizes and bounds read it.
        scene.updateMatrixWorld(true);
        rows = buildRows();
        refreshBounds();
        applyExplode();
        revision += 1;
    };
    const dropSplit = () => {
        if (!splitGroup) return;
        splitGroup.removeFromParent();
        // Materials are the glTF's own and stay with it: only the pieces' geometries are ours.
        for (const mesh of meshesOf(splitGroup)) {
            edgeCache.get(mesh.geometry)?.dispose();
            edgeCache.delete(mesh.geometry);
            mesh.geometry.dispose();
        }
        splitGroup = null;
    };

    const handle: GlbScene = {
        scene,
        bounds,
        parts,
        triangles,
        nativePartCount: nativeParts.size,
        get rows() {
            return rows;
        },
        get canSplit() {
            return nativeParts.size === 1;
        },
        get isSplit() {
            return splitGroup !== null;
        },
        pickable: (id) => !isolatedIds || isolatedIds.has(id),
        revision: () => revision,
        framed: () => {
            const framed = [...parts].filter(([id]) => !ghosted(id)).map(([, part]) => part);
            if (overlay) framed.push(overlay.framed); // dropped by the viewer while it is hidden (an invisible ancestor)
            return framed;
        },
        overlayRay: (ray) => (!disposed && overlay?.pick && overlay.object.visible ? overlay.pick(ray) : null),

        setOverlay(next) {
            if (disposed || next === overlay) return;
            overlay?.object.removeFromParent();
            overlay = next;
            if (next) scene.add(next.object);
            scene.updateMatrixWorld(true);
            refreshBounds();
            options.onChange?.();
        },

        setOverlayVisible(visible) {
            if (disposed || !overlay || overlay.object.visible === visible) return false;
            overlay.object.visible = visible;
            refreshBounds();
            options.onChange?.();
            return true;
        },
        objectsOf: (id) => {
            const part = parts.get(id);
            return part ? [part] : [];
        },

        update(patch) {
            if (disposed) return;
            // What actually changes decides the work: the host re-sends the same hover on every pointer move and the same looks after a split.
            let hover = false;
            let selection = false;
            let visibility = false;
            if (patch.hover !== undefined) {
                const next = patch.hover !== null && parts.has(patch.hover) ? patch.hover : null;
                if (next !== hoverId) {
                    hoverId = next;
                    hover = true;
                }
            }
            if (patch.selected) {
                const next = patch.selected.filter((id) => parts.has(id));
                if (next.length !== selectedIds.length || next.some((id, i) => id !== selectedIds[i])) {
                    selectedIds = next;
                    selection = true;
                }
            }
            if (patch.hidden) {
                const next = new Set(patch.hidden.filter((id) => parts.has(id)));
                if (!sameIds(next, hiddenIds)) {
                    hiddenIds = next;
                    visibility = true;
                }
            }
            if (patch.isolated !== undefined) {
                const next = patch.isolated ? new Set(patch.isolated.filter((id) => parts.has(id))) : null;
                if (next === null ? isolatedIds !== null : !isolatedIds || !sameIds(next, isolatedIds)) {
                    isolatedIds = next;
                    visibility = true;
                }
            }
            if (!hover && !selection && !visibility) return;
            if (visibility) {
                applyHidden();
                revision += 1;
            }
            // A hover alone leaves the selection's edges as they are.
            relight(selection || visibility);
            if ((selection || visibility) && selectedIds.length) scheduleEdges();
            options.onChange?.();
        },

        setExplode(percent) {
            explodePercent = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
            applyExplode();
        },

        extractTriangles: () => {
            if (disposed) return new Float32Array(0);
            const soup = asLoaded(() => extractTriangleSoup(gltfScene));
            // Whoever holds this soup (the analysis' handle) can ask for the same model cut into parts (viewer/partSoups.ts).
            rememberPartSoups(soup, () => handle.partSoups());
            return soup;
        },

        partSoups: () => (disposed ? [] : asLoaded(() => specs.map((spec) => ({ name: spec.name, positions: extractTriangleSoup(spec.object) })))),

        ghostSources: () =>
            disposed
                ? []
                : asLoaded(() =>
                      meshesOf(gltfScene)
                          .filter((m) => !!m.geometry?.getAttribute("position"))
                          .map((m): GhostSource => {
                              const instanced = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh) : null;
                              return {
                                  geometry: m.geometry,
                                  matrix: m.matrixWorld.clone(),
                                  instances: instanced ? { matrices: Float32Array.from(instanced.instanceMatrix.array), count: instanced.count } : undefined,
                              };
                          }),
                  ),

        async split(splitOptions = {}) {
            if (splitGroup || disposed) return { changed: false, pieces: parts.size, merged: 0, components: 1 };
            const sources = meshesOf(gltfScene);
            if (!sources.length || sources.some((m) => (m as THREE.SkinnedMesh).isSkinnedMesh || (m as THREE.InstancedMesh).isInstancedMesh || !m.geometry.getAttribute("position"))) {
                throw new Error("This model cannot be split into parts.");
            }
            const result = await splitGeometries(
                sources.map((m) => m.geometry),
                { ignoreGroups: sources.map((m) => !Array.isArray(m.material)), ...splitOptions },
            );
            if (disposed) {
                for (const piece of result.pieces) for (const m of piece.meshes) m.geometry.dispose();
                return { changed: false, pieces: 0, merged: 0, components: result.componentCount };
            }
            if (result.pieces.length < 2) {
                for (const piece of result.pieces) for (const m of piece.meshes) m.geometry.dispose();
                return { changed: false, pieces: result.pieces.length, merged: result.mergedCount, components: result.componentCount };
            }

            // Pieces live beside the glTF, in the model's frame: each mesh keeps the world placement of the mesh it came from.
            model.updateMatrixWorld(true);
            const toModel = model.matrixWorld.clone().invert();
            const group = new THREE.Group();
            group.name = "assembly:split";
            const pieceParts = new Map<string, THREE.Object3D>();
            result.pieces.forEach((piece, i) => {
                const id = `s${i + 1}`;
                const holder = new THREE.Group();
                holder.name = piece.name;
                holder.userData.componentId = id;
                for (const part of piece.meshes) {
                    const source = sources[part.sourceIndex];
                    const material = Array.isArray(source.material) ? (source.material[part.materialIndex] ?? source.material[0]) : source.material;
                    const mesh = new THREE.Mesh(part.geometry, material);
                    mesh.name = `${piece.name} · ${source.name || "mesh"}`;
                    new THREE.Matrix4().multiplyMatrices(toModel, source.matrixWorld).decompose(mesh.position, mesh.quaternion, mesh.scale);
                    holder.add(mesh);
                }
                group.add(holder);
                pieceParts.set(id, holder);
                names.set(id, piece.name);
            });
            model.add(group);
            splitGroup = group;
            gltfScene.visible = false;
            swapParts(pieceParts);
            return { changed: true, pieces: result.pieces.length, merged: result.mergedCount, components: result.componentCount };
        },

        unsplit() {
            if (!splitGroup || disposed) return;
            gltfScene.visible = true;
            swapParts(nativeParts);
            dropSplit();
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            cancelEdges?.();
            unlight();
            for (const edges of edgeCache.values()) edges?.dispose();
            edgeCache.clear();
            selectEdges.dispose();
            ghostMaterial.dispose();
            ghostLine.dispose();
            dropSplit();
            disposeObject(gltfScene);
            parts.clear();
            overlay = null; // its owner frees it
            scene.clear();
        },
    };
    return handle;
}
