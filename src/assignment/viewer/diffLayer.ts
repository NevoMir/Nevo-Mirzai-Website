/**
 * What changed between two versions of the blocks, drawn in the block view: the blocks that are gone as faint red ghost cubes with red
 * edges, the blocks that are new with a green ring round them (the blocks themselves are drawn by analysisLayer; the ring is only a ring).
 * Cells are grid cells; the layer sits in the block scene's root group, so it works in analysis mm like everything there. Imports three:
 * it is loaded with analysisLayer.
 *
 * Ownership: this layer owns every geometry, material and instanced buffer it makes; dispose() frees them.
 */
import * as THREE from "three";
import type { AnalysisDiff } from "../analysis/types.ts";
import { PALETTE, boxEdgeSegments } from "./analysisGeometry.ts";
import type { ViewTheme } from "./types.ts";

export interface DiffLayer {
    /** Shows `diff` (null clears it); true when something changed and a frame is due. */
    set(diff: AnalysisDiff | null): boolean;
    setTheme(theme: ViewTheme): void;
    dispose(): void;
}

/** Ghosts are drawn at the share of their cell the blocks use, so a ghost fills the hole its block left. */
const INSET = 0.92;
const RING_SCALE = 1.06;
/** 12 edges, 2 vertices each. */
const EDGE_VERTICES = 24;
const UNIT_EDGES = boxEdgeSegments([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
const CAPACITY = 1000;

const valid = (cell: readonly number[]): boolean => cell.length === 3 && cell.every((v) => Number.isInteger(v) && v >= 0 && v < 10);

export function createDiffLayer(parent: THREE.Object3D, options: { cell: number; theme: ViewTheme }): DiffLayer {
    const { cell } = options;
    let palette = PALETTE[options.theme];
    const group = new THREE.Group();
    group.name = "blocks:diff";
    group.visible = false;
    parent.add(group);

    const unit = new THREE.BoxGeometry(1, 1, 1);
    const ghostFill = new THREE.MeshBasicMaterial({ color: palette.bad, transparent: true, opacity: 0.2, depthWrite: false });
    const ghostLine = new THREE.LineBasicMaterial({ color: palette.bad, transparent: true, opacity: 0.8, depthWrite: false });
    const ringFill = new THREE.MeshBasicMaterial({ color: palette.ok, side: THREE.BackSide, transparent: true, opacity: 0.9, depthWrite: false });

    const instanced = (material: THREE.Material, order: number): THREE.InstancedMesh => {
        const mesh = new THREE.InstancedMesh(unit, material, CAPACITY);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        return mesh;
    };
    const ghosts = instanced(ghostFill, 2);
    const rings = instanced(ringFill, -2);

    const edgeGeometry = new THREE.BufferGeometry();
    const edgeAttribute = new THREE.BufferAttribute(new Float32Array(CAPACITY * EDGE_VERTICES * 3), 3);
    edgeAttribute.setUsage(THREE.DynamicDrawUsage);
    edgeGeometry.setAttribute("position", edgeAttribute);
    edgeGeometry.setDrawRange(0, 0);
    const edges = new THREE.LineSegments(edgeGeometry, ghostLine);
    edges.frustumCulled = false;
    edges.renderOrder = 3;
    group.add(rings, ghosts, edges);

    const write = (array: Float32Array, slot: number, c: readonly number[], size: number): void => {
        const o = slot * 16;
        array.fill(0, o, o + 16);
        array[o] = size;
        array[o + 5] = size;
        array[o + 10] = size;
        array[o + 12] = (c[0] + 0.5) * cell;
        array[o + 13] = (c[1] + 0.5) * cell;
        array[o + 14] = (c[2] + 0.5) * cell;
        array[o + 15] = 1;
    };

    let current: AnalysisDiff | null = null;
    return {
        set(diff) {
            if (diff === current) return false;
            current = diff;
            const removed = diff ? diff.removed.filter(valid).slice(0, CAPACITY) : [];
            const added = diff ? diff.added.filter(valid).slice(0, CAPACITY) : [];
            const ghostArray = ghosts.instanceMatrix.array as Float32Array;
            const ringArray = rings.instanceMatrix.array as Float32Array;
            const lines = edgeAttribute.array as Float32Array;
            removed.forEach((c, n) => {
                write(ghostArray, n, c, cell * INSET);
                const o = n * EDGE_VERTICES * 3;
                const size = cell * INSET;
                for (let v = 0; v < EDGE_VERTICES; v++) {
                    lines[o + v * 3] = (c[0] + 0.5) * cell + UNIT_EDGES[v * 3] * size;
                    lines[o + v * 3 + 1] = (c[1] + 0.5) * cell + UNIT_EDGES[v * 3 + 1] * size;
                    lines[o + v * 3 + 2] = (c[2] + 0.5) * cell + UNIT_EDGES[v * 3 + 2] * size;
                }
            });
            added.forEach((c, n) => write(ringArray, n, c, cell * RING_SCALE));
            ghosts.count = removed.length;
            rings.count = added.length;
            ghosts.instanceMatrix.needsUpdate = true;
            rings.instanceMatrix.needsUpdate = true;
            edgeGeometry.setDrawRange(0, removed.length * EDGE_VERTICES);
            edgeAttribute.needsUpdate = true;
            group.visible = removed.length + added.length > 0;
            return true;
        },
        setTheme(theme) {
            palette = PALETTE[theme];
            ghostFill.color.set(palette.bad);
            ghostLine.color.set(palette.bad);
            ringFill.color.set(palette.ok);
        },
        dispose() {
            ghosts.dispose();
            rings.dispose();
            unit.dispose();
            edgeGeometry.dispose();
            ghostFill.dispose();
            ghostLine.dispose();
            ringFill.dispose();
            parent.remove(group);
            group.clear();
        },
    };
}
