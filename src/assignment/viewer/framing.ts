// Camera framing maths: pure functions over three's vector types, so Node can test them.
import * as THREE from "three";
import type { Insets } from "./types.ts";

/** Vertical field of view, degrees (Cably's). */
export const FOV = 45;

/** The part of the stage that no floating UI covers, in stage pixels. */
export interface VisibleRect {
    x: number;
    y: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
}

/** Never let the insets squeeze the free rect below this many pixels per side. */
const MIN_FREE_PX = 96;

/**
 * The uncovered rect of a width x height stage. Insets that would leave less than MIN_FREE_PX
 * on an axis are scaled down together, so a tiny stage still frames the model somewhere.
 */
export function visibleRect(width: number, height: number, insets: Insets): VisibleRect {
    const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
    let { left, right, top, bottom } = { left: clean(insets.left), right: clean(insets.right), top: clean(insets.top), bottom: clean(insets.bottom) };
    const minW = Math.min(MIN_FREE_PX, width);
    const minH = Math.min(MIN_FREE_PX, height);
    if (width - left - right < minW) {
        const k = left + right > 0 ? Math.max(0, width - minW) / (left + right) : 0;
        [left, right] = [left * k, right * k];
    }
    if (height - top - bottom < minH) {
        const k = top + bottom > 0 ? Math.max(0, height - minH) / (top + bottom) : 0;
        [top, bottom] = [top * k, bottom * k];
    }
    const w = width - left - right;
    const h = height - top - bottom;
    return { x: left, y: top, width: w, height: h, centerX: left + w / 2, centerY: top + h / 2 };
}

/**
 * Arguments for `camera.setViewOffset(width, height, x, y, width, height)` that move the optical
 * axis from the stage centre to the centre of the free rect: the model framed around the target
 * then sits in the middle of what the floating UI leaves uncovered.
 */
export function viewOffsetFor(width: number, height: number, visible: VisibleRect): { x: number; y: number } {
    return { x: width / 2 - visible.centerX, y: height / 2 - visible.centerY };
}

/**
 * The tangents of the half-angles the free rect spans on each axis, for a camera of vertical FOV
 * `fovDeg` rendering a `stageHeight` px tall stage (a pixel spans the same angle in x and y).
 */
export function visibleTangents(fovDeg: number, stageHeight: number, visible: VisibleRect): { tanH: number; tanV: number } {
    const tan = Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
    return { tanH: (tan * visible.width) / stageHeight, tanV: (tan * visible.height) / stageHeight };
}

export interface FitInput {
    /** What must end up inside the frame (corners of the parts' boxes). */
    points: readonly THREE.Vector3[];
    /** The point the framing is built around (usually the centre of the bounds). */
    center: THREE.Vector3;
    /** Unit vector from the target toward the camera. */
    dir: THREE.Vector3;
    tanH: number;
    tanV: number;
    /** Scale about `center` applied to every point: breathing room around the model. */
    margin?: number;
    /** World up (the scene is Z-up). */
    up?: THREE.Vector3;
}

export interface FitResult {
    target: THREE.Vector3;
    distance: number;
    position: THREE.Vector3;
}

const Z_UP = new THREE.Vector3(0, 0, 1);

/**
 * Frames `points` from `dir`, tight: every point (scaled by `margin` about `center`) inside all four
 * frustum planes. Per screen axis the two planes' needs are A (one side) and B (the other): the
 * distance is (A + B) / 2*tan and the target slides (A - B) / 2 along that axis, so content whose
 * near side projects large is centred instead of leaving the far side empty (Cably's frame()).
 */
export function fitFrame(input: FitInput): FitResult {
    const { points, center, dir, tanH, tanV } = input;
    const margin = input.margin ?? 1.05;
    const m = new THREE.Matrix4().lookAt(center.clone().add(dir), center, input.up ?? Z_UP);
    const right = new THREE.Vector3().setFromMatrixColumn(m, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(m, 1);
    let h0 = -Infinity;
    let h1 = -Infinity;
    let v0 = -Infinity;
    let v1 = -Infinity;
    const v = new THREE.Vector3();
    for (const point of points) {
        v.copy(point).sub(center).multiplyScalar(margin);
        const x = v.dot(right);
        const y = v.dot(up);
        const z = v.dot(dir);
        h0 = Math.max(h0, x + tanH * z);
        h1 = Math.max(h1, -x + tanH * z);
        v0 = Math.max(v0, y + tanV * z);
        v1 = Math.max(v1, -y + tanV * z);
    }
    if (!points.length) return { target: center.clone(), distance: 1, position: center.clone().add(dir) };
    const distance = Math.max((h0 + h1) / (2 * tanH), (v0 + v1) / (2 * tanV), 1);
    const target = center
        .clone()
        .addScaledVector(right, (h0 - h1) / 2)
        .addScaledVector(up, (v0 - v1) / 2);
    return { target, distance, position: target.clone().addScaledVector(dir, distance) };
}

/** The 8 corners of a box, appended to `points`. */
export function boxCorners(box: THREE.Box3, points: THREE.Vector3[] = []): THREE.Vector3[] {
    if (box.isEmpty()) return points;
    for (let i = 0; i < 8; i += 1) {
        points.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    }
    return points;
}
