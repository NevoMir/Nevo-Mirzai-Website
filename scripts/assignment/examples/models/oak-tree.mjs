// Oak tree: a trunk, a long horizontal limb carrying a leaf cluster on a thin tip, lumpy foliage blobs.
import { Part, mat, THREE } from "../lib/kit.mjs";

// deterministic value noise for lumpy leaf clusters
function hash(x, y, z) { let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const f = (t) => t * t * (3 - 2 * t);
    const u = f(x - xi), v = f(y - yi), w = f(z - zi);
    let r = 0;
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++)
        r += hash(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    return r;
}
function blob(radius, seed, detail = 2, lump = 0.22) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).normalize();
        const n = noise3(v.x * 2.2 + seed, v.y * 2.2 + seed * 1.7, v.z * 2.2 + seed * 0.6) - 0.5;
        v.multiplyScalar(radius * (1 + lump * 2 * n));
        p.setXYZ(i, v.x, v.y * 0.86, v.z); // slightly flattened
    }
    return g;
}

export function build({ limb = 1.0, tipLeaves = true } = {}) {
    const bark = new Part("Trunk", mat("#5d4631", { rough: 0.95 }));
    bark.sweep([[0, -0.1, 0], [0.1, 1.5, 0.1], [0.0, 3.0, 0], [0.2, 4.3, 0]], [[0, 0.72], [0.18, 0.52], [1, 0.34]], { segments: 30, radial: 16, roundCaps: false });
    const roots = new Part("Roots", mat("#54402d", { rough: 0.95 }));
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + 0.4; roots.sweep([[Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3], [Math.cos(a) * 0.75, 0.4, Math.sin(a) * 0.75], [Math.cos(a) * 1.3, -0.05, Math.sin(a) * 1.3]], [[0, 0.3], [1, 0.12]], { segments: 10, radial: 8, roundCaps: false }); }

    const branches = new Part("Branches", mat("#684e36", { rough: 0.92 }));
    const L = limb;
    branches.sweep([[0.1, 3.0, 0], [1.6, 3.7, 0.2], [3.4, 4.1, 0.1], [5.2 * L, 4.55, -0.2], [7.0 * L, 5.1, -0.1]], [[0, 0.36], [0.55, 0.2], [1, 0.07]], { segments: 36, radial: 10 });
    branches.sweep([[0, 3.4, 0], [-1.4, 4.2, 0.2], [-2.6, 4.9, 0.3], [-3.5, 5.7, 0.2]], [[0, 0.3], [1, 0.1]], { segments: 22, radial: 10 });
    branches.sweep([[0.2, 4.0, 0], [0.55, 5.4, 0.2], [0.5, 6.6, 0]], [[0, 0.28], [1, 0.1]], { segments: 16, radial: 10 });
    branches.sweep([[0, 3.3, 0], [0.4, 4.0, 1.4], [0.3, 4.8, 2.9]], [[0, 0.26], [1, 0.1]], { segments: 18, radial: 10 });
    branches.sweep([[3.4, 4.1, 0.1], [3.9, 5.1, 0.5], [4.1, 5.9, 0.5]], [[0, 0.14], [1, 0.06]], { segments: 12, radial: 8 });

    const leaves = new Part("Foliage", mat("#4f8a3a", { rough: 0.8 }));
    const clusters = [
        [0.3, 6.7, 0.0, 2.5, 1], [-1.6, 6.1, 0.5, 1.9, 2], [1.9, 6.3, -0.5, 1.9, 3], [0.2, 8.0, 0.1, 1.7, 4],
        [-3.5, 6.3, 0.3, 1.7, 5], [-2.5, 5.7, -0.7, 1.3, 6], [0.3, 5.5, 2.9, 1.5, 7], [4.0, 6.5, 0.4, 1.6, 8],
    ];
    for (const [x, y, z, r, seed] of clusters) leaves.add(blob(r, seed), { at: [x, y, z], crease: 80 });
    const tip = new Part("Tip foliage", mat("#5a9a43", { rough: 0.8 }));
    if (tipLeaves) { tip.add(blob(2.0, 11), { at: [7.6 * L, 5.9, -0.1], crease: 80 }); tip.add(blob(1.3, 12), { at: [6.3 * L, 5.3, 0.6], crease: 80 }); }
    const parts = [bark, roots, branches, leaves];
    if (tipLeaves) parts.push(tip);
    return parts;
}
