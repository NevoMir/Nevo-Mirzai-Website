// Small 2D geometry helpers for the stability check (support base = convex hull of the ground footprint).

import type { Vec2 } from "./types.ts";

const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeated end point. */
export function convexHull(points: Vec2[]): Vec2[] {
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const pts: Vec2[] = [];
    for (const p of sorted) {
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
    }
    if (pts.length < 3) return pts;
    const lower: Vec2[] = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: Vec2[] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/** Nearest point to `p` on the segment a-b. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return [a[0] + t * dx, a[1] + t * dy];
}

export interface HullDistance {
    /** > 0 inside the polygon (distance to the nearest edge), < 0 outside (minus the distance to the polygon). */
    signed: number;
    /** Nearest point on the polygon's boundary. */
    nearest: Vec2;
    /** Index i of the nearest edge hull[i] -> hull[i + 1]; -1 when the hull has no edge (empty). */
    edge: number;
}

/** Signed distance from `p` to a convex polygon given counter-clockwise (a single point or a segment also work). */
export function hullDistance(p: Vec2, hull: Vec2[]): HullDistance {
    let best = Infinity;
    let nearest: Vec2 = hull[0] ?? [0, 0];
    let edge = -1;
    let inside = hull.length >= 3;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i];
        const b = hull[(i + 1) % hull.length];
        const q = closestOnSegment(p, a, b);
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < best) {
            best = d;
            nearest = q;
            edge = i;
        }
        // CCW polygon: inside is on the left of every edge (1e-6 mm of slack so float noise on an edge is not "outside").
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (inside && len > 0 && cross(a, b, p) / len < -1e-6) inside = false;
    }
    return { signed: inside ? best : -best, nearest, edge };
}

/** "+X", "-Y" or "+X and -Y" for a horizontal direction (the analysis frame's axes). */
export function directionLabel(dx: number, dy: number): string {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax === 0 && ay === 0) return "";
    const sx = dx >= 0 ? "+X" : "-X";
    const sy = dy >= 0 ? "+Y" : "-Y";
    // A direction within ~22 degrees of an axis counts as that axis; anything between is a diagonal.
    if (ay < 0.4 * ax) return sx;
    if (ax < 0.4 * ay) return sy;
    return `${sx} and ${sy}`;
}

/**
 * Unit vector pointing out of a counter-clockwise polygon through its edge `edge` (hull[edge] -> hull[edge + 1]);
 * null for a degenerate edge. Used to say which side of the base a centre of gravity sitting on the edge leans to.
 */
export function outwardNormal(hull: Vec2[], edge: number): Vec2 | null {
    if (edge < 0 || hull.length < 2) return null;
    const a = hull[edge];
    const b = hull[(edge + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // CCW: the interior is on the left of a -> b, so outside is on the right.
    return len > 0 ? [(b[1] - a[1]) / len, -(b[0] - a[0]) / len] : null;
}
