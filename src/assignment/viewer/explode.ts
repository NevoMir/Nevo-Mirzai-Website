// Exploded-view maths. Pure functions over three's vector types, so Node can test them.
import * as THREE from "three";

/** At 100 % every part sits this multiple of its distance from the assembly centre farther out. */
export const EXPLODE_MAX = 1.5;

/** Slider percent (0-100, clamped) -> the factor k in `offset = (partCentre - centre) * k`. */
export function explodeFactor(percent: number): number {
    if (!Number.isFinite(percent)) return 0;
    return (Math.min(100, Math.max(0, percent)) / 100) * EXPLODE_MAX;
}

/** The centre of the union of boxes (the assembly centre); null for no (or only empty) boxes. */
export function unionCentre(boxes: readonly THREE.Box3[]): THREE.Vector3 | null {
    const union = new THREE.Box3();
    for (const box of boxes) if (!box.isEmpty()) union.union(box);
    return union.isEmpty() ? null : union.getCenter(new THREE.Vector3());
}

/** World-space offsets: each part moves along (partCentre - assemblyCentre) by k times that distance. */
export function explodeOffsets(centres: readonly THREE.Vector3[], assemblyCentre: THREE.Vector3, k: number): THREE.Vector3[] {
    return centres.map((c) => c.clone().sub(assemblyCentre).multiplyScalar(k));
}

/**
 * A world-space displacement as the same displacement in a parent's local frame: the linear part
 * of the parent's world matrix, inverted (no translation, no normalising).
 */
export function worldDeltaToLocal(parentWorld: THREE.Matrix4 | null | undefined, delta: THREE.Vector3): THREE.Vector3 {
    if (!parentWorld) return delta.clone();
    const linear = new THREE.Matrix3().setFromMatrix4(parentWorld);
    if (Math.abs(linear.determinant()) < 1e-18) return delta.clone();
    return delta.clone().applyMatrix3(linear.invert());
}
