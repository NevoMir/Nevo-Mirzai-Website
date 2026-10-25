/**
 * The cubes of the "added supports" overlay: the blocks a stabilizer added to a model (role != "original"), drawn solid in
 * their role colours with crisp edges, placed on the SOURCE mesh the 3D tab shows. Imports three: load it lazily.
 *
 * The layer is a group for the model's own scene (GlbScene.setOverlay): it shares that scene's lights and environment, is
 * framed with the model and picks by its own ray test. Like the block view it builds in analysis mm and puts the whole group
 * into the display frame with one transform (the result's transform maps the loaded mesh's frame to mm), so no vertex is ever
 * converted. Cubes are one InstancedMesh with a colour per instance, plus merged line segments for the edges: two draw
 * calls however many blocks were added.
 *
 * Ownership: the layer owns every geometry, material and instance buffer it makes. dispose() takes it out of its scene and
 * frees them; it never touches the model.
 */
import * as THREE from "three";
import type { AnalysisResult, Block } from "../analysis/types.ts";
import { ROLE_HEX } from "../shared/assembly.ts";
import { PALETTE, boxEdgeSegments, displayPlacement, mmToDisplay, pickBlock } from "./analysisGeometry.ts";
import { SELECT_COLOR } from "./glbScene.ts";
import type { ViewerOverlayHit } from "./orbitViewer.ts";
import { addedBlockIndices, describeSupport, supportId, usableTransform, type SupportInfo } from "./supports.ts";
import type { Vec3, ViewTheme } from "./types.ts";

export interface SupportsLayerOptions {
    /** The stabilized assembly analysed under the source mesh's transform: its blocks with a role other than "original" are drawn. */
    analysis: AnalysisResult;
    theme: ViewTheme;
    /** Steps of earlier stabilizer runs the model carries, so a tooltip numbers the run on screen from 1. */
    stepOffset?: number;
    /** The layer changed after the fact (a hover, a selection, a repaint): render a frame. */
    onChange?: () => void;
}

export interface SupportsLayer {
    /** Goes into the model's scene (display frame). Hide it with `object.visible`. */
    readonly object: THREE.Group;
    /** The cubes alone, without the hover and selection marks: what Fit frames. */
    readonly framed: THREE.Object3D;
    /** World box of the cubes (the display frame), joined to the scene's bounds while the layer is shown. */
    readonly box: THREE.Box3;
    /** Blocks drawn. */
    readonly count: number;
    /** Block indices drawn (into analysis.blocks), ascending. */
    readonly indices: readonly number[];
    info(index: number): SupportInfo | null;
    /** World point at the top centre of a block (where a label would hang). */
    anchorOf(index: number): Vec3 | null;
    /** World box of a block's cell. */
    boxOf(index: number): THREE.Box3 | null;
    /** The nearest cube a world ray meets: its id (supportId), the world point and the distance along the ray. */
    pickRay(ray: THREE.Ray): ViewerOverlayHit | null;
    /** A cube under the pointer gets an outline and a wash; null clears it. */
    setHover(index: number | null): void;
    /** The cube a card is open for gets a heavier outline; null clears it. */
    setSelected(index: number | null): void;
    setTheme(theme: ViewTheme): void;
    dispose(): void;
}

/** Cubes are drawn at this share of their cell, so neighbours read as separate components (the block view's inset). */
const INSET = 0.92;
const HOVER_SCALE = 0.945;
const SELECT_SCALE = 1.04;
const EDGE_VERTICES = 24;
const UNIT_EDGES = boxEdgeSegments([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);

export function createSupportsLayer(options: SupportsLayerOptions): SupportsLayer {
    const { analysis } = options;
    const blocks = analysis.blocks;
    const indices = addedBlockIndices(blocks);
    const count = indices.length;
    const cell = analysis.settings.blockSizeMm;
    const transform = usableTransform(analysis.transform);
    const toWorld = (mm: Vec3): Vec3 => mmToDisplay(mm, transform);
    let theme = options.theme;

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const geo = <G extends THREE.BufferGeometry>(g: G): G => (geometries.add(g), g);
    const mat = <M extends THREE.Material>(m: M): M => (materials.add(m), m);

    // ---- root: mm -> display frame ----
    const object = new THREE.Group();
    object.name = "supports:root";
    const placement = displayPlacement(transform);
    object.scale.setScalar(placement.scale);
    object.position.set(...placement.position);
    object.updateMatrixWorld(true);

    const cubes = new THREE.Group();
    cubes.name = "supports:cubes";
    const marks = new THREE.Group();
    marks.name = "supports:marks";
    object.add(cubes, marks);

    // ---- cubes: one instance per added block, in its role colour ----
    const unit = geo(new THREE.BoxGeometry(1, 1, 1));
    const faces = mat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    const capacity = Math.max(1, count);
    const mesh = new THREE.InstancedMesh(unit, faces, capacity);
    mesh.name = "supports:blocks";
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = count;
    mesh.frustumCulled = false;
    const edgeGeometry = geo(new THREE.BufferGeometry());
    const edgePositions = new Float32Array(capacity * EDGE_VERTICES * 3);
    edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    const edgeMaterial = mat(new THREE.LineBasicMaterial({ color: PALETTE[theme].edge, transparent: true, opacity: 0.9 }));
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    edges.name = "supports:edges";
    edges.frustumCulled = false;
    edges.renderOrder = 1;
    cubes.add(mesh, edges);

    const size = cell * INSET;
    const matrix = new THREE.Matrix4();
    const swatch = new THREE.Color();
    const slotOf = new Map<number, number>();
    const mins = new Float32Array(capacity * 3);
    const maxs = new Float32Array(capacity * 3);
    indices.forEach((blockIndex, slot) => {
        const b: Block = blocks[blockIndex];
        slotOf.set(blockIndex, slot);
        matrix.makeScale(size, size, size).setPosition(b.centerMm[0], b.centerMm[1], b.centerMm[2]);
        mesh.setMatrixAt(slot, matrix);
        swatch.set(ROLE_HEX[b.role ?? "column"] ?? "#94a3b8");
        mesh.setColorAt(slot, swatch);
        const o = slot * EDGE_VERTICES * 3;
        for (let v = 0; v < EDGE_VERTICES; v += 1) {
            edgePositions[o + v * 3] = b.centerMm[0] + UNIT_EDGES[v * 3] * size;
            edgePositions[o + v * 3 + 1] = b.centerMm[1] + UNIT_EDGES[v * 3 + 1] * size;
            edgePositions[o + v * 3 + 2] = b.centerMm[2] + UNIT_EDGES[v * 3 + 2] * size;
        }
        for (let a = 0; a < 3; a += 1) {
            mins[slot * 3 + a] = b.centerMm[a] - cell / 2;
            maxs[slot * 3 + a] = b.centerMm[a] + cell / 2;
        }
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    edgeGeometry.setDrawRange(0, count * EDGE_VERTICES);

    // The world box of the cubes (cells, not the inset cubes: the frame keeps a hair of room).
    const box = new THREE.Box3();
    for (const blockIndex of indices) {
        const b = blocks[blockIndex];
        const h = cell / 2;
        box.expandByPoint(new THREE.Vector3(...toWorld([b.centerMm[0] - h, b.centerMm[1] - h, b.centerMm[2] - h])));
        box.expandByPoint(new THREE.Vector3(...toWorld([b.centerMm[0] + h, b.centerMm[1] + h, b.centerMm[2] + h])));
    }

    // ---- marks: hover (outline and wash), selection (heavier, in the viewer's selection blue) ----
    const line = (positions: Float32Array, material: THREE.Material) => {
        const g = geo(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(g, material);
        lines.frustumCulled = false;
        lines.renderOrder = 8;
        lines.visible = false;
        marks.add(lines);
        return lines;
    };
    const wash = (opacity: number, color: THREE.ColorRepresentation) => {
        const m = new THREE.Mesh(unit, mat(new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })));
        m.frustumCulled = false;
        m.renderOrder = 7;
        m.visible = false;
        marks.add(m);
        return m;
    };
    const hoverMaterial = mat(new THREE.LineBasicMaterial({ color: PALETTE[theme].hover }));
    const selectMaterial = mat(new THREE.LineBasicMaterial({ color: SELECT_COLOR }));
    const hoverOutline = line(UNIT_EDGES.slice(), hoverMaterial);
    hoverOutline.scale.setScalar(cell * 1.005);
    const hoverFill = wash(0.2, 0xffffff);
    hoverFill.scale.setScalar(cell * HOVER_SCALE);
    const selectOutline = line(UNIT_EDGES.slice(), selectMaterial);
    selectOutline.scale.setScalar(cell * SELECT_SCALE);
    const selectFill = wash(0.16, SELECT_COLOR);
    selectFill.scale.setScalar(cell * HOVER_SCALE);
    const place = (parts: THREE.Object3D[], index: number | null) => {
        const slot = index === null ? undefined : slotOf.get(index);
        for (const part of parts) part.visible = slot !== undefined;
        if (slot === undefined || index === null) return;
        const [x, y, z] = blocks[index].centerMm;
        for (const part of parts) part.position.set(x, y, z);
    };
    let hovered: number | null = null;
    let selected: number | null = null;

    // ---- picking: a ray/box test over the cells, in the group's own (mm) frame ----
    const inverse = new THREE.Matrix4();
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const point = new THREE.Vector3();
    const all = Int32Array.from(indices.map((_, slot) => slot));
    let disposed = false;

    const handle: SupportsLayer = {
        object,
        framed: cubes,
        box,
        count,
        indices,

        info: (index) => (slotOf.has(index) ? describeSupport(blocks[index], analysis.settings, options.stepOffset ?? 0) : null),
        anchorOf(index) {
            const b = slotOf.has(index) ? blocks[index] : undefined;
            return b ? toWorld([b.centerMm[0], b.centerMm[1], b.centerMm[2] + cell / 2]) : null;
        },
        boxOf(index) {
            const b = slotOf.has(index) ? blocks[index] : undefined;
            if (!b) return null;
            const h = cell / 2;
            return new THREE.Box3().setFromPoints([new THREE.Vector3(...toWorld([b.centerMm[0] - h, b.centerMm[1] - h, b.centerMm[2] - h])), new THREE.Vector3(...toWorld([b.centerMm[0] + h, b.centerMm[1] + h, b.centerMm[2] + h]))]);
        },

        pickRay(ray) {
            if (disposed || count === 0) return null;
            object.updateWorldMatrix(true, false);
            inverse.copy(object.matrixWorld).invert();
            origin.copy(ray.origin).applyMatrix4(inverse);
            direction.copy(ray.direction).transformDirection(inverse);
            const hit = pickBlock([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], mins, maxs, all);
            if (!hit) return null;
            point.copy(origin).addScaledVector(direction, hit.t);
            object.localToWorld(point);
            return { id: supportId(indices[hit.index]), point: [point.x, point.y, point.z], distance: ray.origin.distanceTo(point) };
        },

        setHover(index) {
            const next = index !== null && slotOf.has(index) ? index : null;
            if (next === hovered) return;
            hovered = next;
            place([hoverOutline, hoverFill], next);
            options.onChange?.();
        },
        setSelected(index) {
            const next = index !== null && slotOf.has(index) ? index : null;
            if (next === selected) return;
            selected = next;
            place([selectOutline, selectFill], next);
            options.onChange?.();
        },
        setTheme(next) {
            if (next === theme) return;
            theme = next;
            edgeMaterial.color.set(PALETTE[theme].edge);
            hoverMaterial.color.set(PALETTE[theme].hover);
            options.onChange?.();
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            object.removeFromParent();
            mesh.dispose();
            for (const g of geometries) g.dispose();
            for (const m of materials) m.dispose();
            geometries.clear();
            materials.clear();
            object.clear();
            cubes.clear();
            marks.clear();
        },
    };
    return handle;
}
