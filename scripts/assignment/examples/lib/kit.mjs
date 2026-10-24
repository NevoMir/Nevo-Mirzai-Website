// Procedural modelling kit: three.js geometries (no DOM needed) merged into named parts.
// Y-up, metres, ground at y = 0, +Z towards the viewer, +X to the right.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

export { THREE };
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const DEG = Math.PI / 180;

/** Matrix from position, Euler rotation in DEGREES (XYZ order), and scale (number or [x,y,z]). */
export function mat4({ at = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], up = null } = {}) {
    const s = typeof scale === "number" ? [scale, scale, scale] : scale;
    // `up`: a direction the local +Y axis should point to (overrides rot)
    const q = up ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), V3(up).normalize()) : new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, "XYZ"));
    return new THREE.Matrix4().compose(V3(at), q, V3(s));
}

/** Level of detail from size: small details get few segments (the whole example set must stay small). */
const lodRadial = (r) => (r < 0.1 ? 8 : r < 0.4 ? 12 : r < 0.9 ? 16 : 24);
const lodSphere = (r) => (r < 0.15 ? [8, 6] : r < 0.6 ? [12, 8] : r < 1.2 ? [16, 10] : [24, 16]);

/** Strip to position+normal, non-indexed (so every geometry can be merged with every other one); fixes inside-out winding. */
function plain(g, crease = null) {
    let out = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(out.attributes)) if (k !== "position" && k !== "normal") out.deleteAttribute(k);
    if (signedVolume(out) < 0) {
        const a = out.attributes.position.array;
        for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
        out.deleteAttribute("normal");
    }
    if (crease !== null) out = toCreasedNormals(out, crease * DEG);
    else if (!out.attributes.normal) out.computeVertexNormals();
    return out;
}

/**
 * Tapered, closed tube along a smooth curve through `points`. radius = number | (t) => r | [[t, r], ...].
 * Rings are placed on parallel-transport frames (no twisting), ends are capped (closed shell: the voxeliser fills it).
 */
export function sweep(points, radius, { segments = 48, radial = 14, ovalY = 1, closedEnds = true, curveType = "centripetal", roundCaps = true } = {}) {
    const curve = new THREE.CatmullRomCurve3(points.map(V3), false, curveType);
    const rf = typeof radius === "function" ? radius : typeof radius === "number" ? () => radius : (t) => {
        const k = radius;
        if (t <= k[0][0]) return k[0][1];
        for (let i = 1; i < k.length; i++) if (t <= k[i][0]) { const u = (t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]); const s = u * u * (3 - 2 * u); return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * s; }
        return k[k.length - 1][1];
    };
    const frames = curve.computeFrenetFrames(segments, false);
    const pos = [];
    const idx = [];
    const ringOf = (i) => {
        const t = i / segments;
        const p = curve.getPointAt(t);
        const r = rf(t);
        const N = frames.normals[i], B = frames.binormals[i];
        const ring = [];
        for (let j = 0; j < radial; j++) {
            const a = (j / radial) * Math.PI * 2;
            const c = Math.cos(a) * r, s = Math.sin(a) * r * (typeof ovalY === "function" ? ovalY(t) : ovalY);
            ring.push(p.x + N.x * c + B.x * s, p.y + N.y * c + B.y * s, p.z + N.z * c + B.z * s);
        }
        return ring;
    };
    const rings = [];
    for (let i = 0; i <= segments; i++) rings.push(ringOf(i));
    for (const r of rings) pos.push(...r);
    for (let i = 0; i < segments; i++) for (let j = 0; j < radial; j++) {
        const a = i * radial + j, b = i * radial + ((j + 1) % radial), c = (i + 1) * radial + j, d = (i + 1) * radial + ((j + 1) % radial);
        idx.push(a, c, b, b, c, d);
    }
    if (closedEnds) {
        const cap = (i, flip) => {
            const t = i === 0 ? 0 : 1;
            const p = curve.getPointAt(t);
            const tan = curve.getTangentAt(t).multiplyScalar(i === 0 ? -1 : 1);
            const r = rf(t);
            // a shallow dome so the tip looks rounded rather than sliced
            const apex = pos.length / 3;
            pos.push(p.x + tan.x * r * (roundCaps ? 0.6 : 0), p.y + tan.y * r * (roundCaps ? 0.6 : 0), p.z + tan.z * r * (roundCaps ? 0.6 : 0));
            for (let j = 0; j < radial; j++) {
                const a = i * radial + j, b = i * radial + ((j + 1) % radial);
                if (flip) idx.push(apex, b, a); else idx.push(apex, a, b);
            }
        };
        cap(0, false);
        cap(segments, true);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Winding check: ensure outward (signed volume positive)
    if (signedVolume(g) < 0) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); }
    return g;
}

export function signedVolume(g) {
    const p = g.attributes.position;
    const ix = g.index ? g.index.array : null;
    const n = ix ? ix.length : p.count;
    let v = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
        a.fromBufferAttribute(p, ix ? ix[i] : i); b.fromBufferAttribute(p, ix ? ix[i + 1] : i + 1); c.fromBufferAttribute(p, ix ? ix[i + 2] : i + 2);
        v += a.dot(b.clone().cross(c)) / 6;
    }
    return v;
}

/** One named part = several geometries merged into a single mesh with one material. */
export class Part {
    constructor(name, material) { this.name = name; this.material = material; this.list = []; }
    /** Add any BufferGeometry. opts: at, rot (deg), scale, crease (deg: smooth normals below this angle, for extrusions). */
    add(geo, opts = {}) {
        const g = plain(geo, opts.crease ?? null);
        g.applyMatrix4(mat4(opts));
        this.list.push(g);
        return this;
    }
    box(w, h, d, opts = {}) { return this.add(new THREE.BoxGeometry(w, h, d), opts); }
    /** Rounded box: radius in metres, smooth = corner segments. */
    rbox(w, h, d, radius, opts = {}) { return this.add(new RoundedBoxGeometry(w, h, d, opts.segments ?? 1, Math.min(radius, Math.min(w, h, d) / 2 - 1e-4)), opts); }
    cyl(rTop, rBottom, h, opts = {}) { return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, opts.radial ?? lodRadial(Math.max(rTop, rBottom)), 1, false), opts); }
    sphere(r, opts = {}) { const [w, h] = lodSphere(r); return this.add(new THREE.SphereGeometry(r, opts.w ?? w, opts.h ?? h), opts); }
    ellipsoid(rx, ry, rz, opts = {}) { const [w, h] = lodSphere(Math.max(rx, ry, rz)); return this.add(new THREE.SphereGeometry(1, opts.w ?? w, opts.h ?? h), { ...opts, scale: [rx, ry, rz] }); }
    capsule(r, len, opts = {}) { return this.add(new THREE.CapsuleGeometry(r, len, 6, opts.radial ?? 18), opts); }
    /** Lathe around Y of a profile [[r, y], ...]; the profile should start and end ON the axis (r = 0) to stay closed. */
    lathe(profile, opts = {}) {
        const pts = profile.map(([r, y]) => [r, y]);
        if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
        if (pts[pts.length - 1][0] > 0) pts.push([0, pts[pts.length - 1][1]]);
        return this.add(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), opts.radial ?? 40), { crease: opts.crease ?? 50, ...opts });
    }
    /** Extrude a THREE.Shape (in XY) by `depth` along +Z, with optional bevel. */
    extrude(shape, depth, opts = {}) {
        const bevel = opts.bevel ?? 0;
        return this.add(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: opts.curveSegments ?? 16, steps: 1 }), { crease: opts.crease ?? 40, ...opts });
    }
    sweep(points, radius, opts = {}) { return this.add(sweep(points, radius, opts), opts.xf ?? {}); }
    /** A beam/strut from a to b with a rectangular (or round) section. */
    beam(a, b, w, h, opts = {}) {
        const A = V3(a), B = V3(b);
        const len = A.distanceTo(B);
        const geo = opts.round ? new THREE.CylinderGeometry(w / 2, w / 2, len, opts.radial ?? 16) : opts.radius ? new RoundedBoxGeometry(w, len, h, 2, opts.radius) : new THREE.BoxGeometry(w, len, h);
        const g = plain(geo);
        // align local Y with (B - A)
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
        // optional roll about the beam axis
        if (opts.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), opts.roll * DEG));
        g.applyMatrix4(new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
        this.list.push(g);
        return this;
    }
    /** Apply a Matrix4 (e.g. a lean/shear) to everything added so far. */
    xform(m) { for (const g of this.list) g.applyMatrix4(m); return this; }
    /** Final merged, indexed geometry (position + normal). */
    geometry() {
        if (!this.list.length) throw new Error(`part ${this.name} is empty`);
        const merged = mergeGeometries(this.list, false);
        // non-uniform scales and shears leave normals that are not unit length (glTF requires unit normals)
        const n = merged.attributes.normal;
        for (let i = 0; i < n.count; i++) {
            const x = n.getX(i), y = n.getY(i), z = n.getZ(i), l = Math.hypot(x, y, z);
            if (l < 1e-9) n.setXYZ(i, 0, 1, 0); else n.setXYZ(i, x / l, y / l, z / l);
        }
        return mergeVertices(merged, 1e-4);
    }
}

/** Material helper: linear-ish sRGB hex -> glTF baseColorFactor (converted to linear). */
export function srgb(hex) {
    const c = new THREE.Color(hex); // Color management on by default: setHex interprets as sRGB, stores linear
    return [c.r, c.g, c.b];
}
export function mat(hex, { metal = 0, rough = 0.6, emissive = null, alpha = 1, doubleSided = false, name = null } = {}) {
    return { color: [...srgb(hex), alpha], metal, rough, emissive: emissive ? srgb(emissive) : null, alpha, doubleSided, name };
}

export function bounds(parts) {
    const b = new THREE.Box3();
    for (const p of parts) { const g = p.geometry(); g.computeBoundingBox(); b.union(g.boundingBox); }
    return b;
}

/** Counts boundary edges (used by an odd number of triangles) after welding by position: 0 means every shell is closed. */
export function openEdges(g) {
    const P = g.attributes.position.array, I = g.index ? g.index.array : null;
    const key = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
    const ids = new Map();
    const vid = (i) => { const k = key(i); let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
    const n = I ? I.length : P.length / 3;
    const edges = new Map();
    for (let t = 0; t < n; t += 3) {
        const v = [0, 1, 2].map((k) => vid(I ? I[t + k] : t + k));
        for (let k = 0; k < 3; k++) {
            const a = v[k], b = v[(k + 1) % 3];
            if (a === b) continue;
            const e = a < b ? `${a}_${b}` : `${b}_${a}`;
            edges.set(e, (edges.get(e) ?? 0) + 1);
        }
    }
    let open = 0;
    for (const c of edges.values()) if (c % 2 === 1) open++;
    return open;
}
export function qa(parts) {
    const out = [];
    for (const p of parts) { const g = p.geometry(); const v = signedVolume(g); const o = openEdges(g); if (v <= 0 || o > 0) out.push(`${p.name}: volume ${v.toFixed(3)} openEdges ${o}`); }
    return out;
}
