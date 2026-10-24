// Builds public/assignment_alex/fixtures/demo-assembly.glb: an articulated desk lamp made of nine separate parts.
// The offline "Demo" provider (worker/providers/mock.ts) replays this file, so the viewer, parts list and
// export flow can be developed without paying for a real generation.
//
// Run: node scripts/assignment/make-fixture.mjs
// Conventions: glTF 2.0, Y up, metres, ~0.45 m tall, +X to the lamp's right, +Z towards the viewer.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "public/assignment_alex/fixtures/demo-assembly.glb");
// The same bytes, embedded in the Worker so the demo provider also works when the served assets lack the file.
const EMBEDDED = resolve(ROOT, "worker/providers/mock-fixture.ts");

// ---------- Tiny vector helpers ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / len(a));

/** Two unit vectors perpendicular to `w` and to each other, with u x v = w. */
function basis(w) {
    const helper = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(helper, w));
    return [u, cross(w, u)];
}

// ---------- Geometry builder: one merged triangle mesh per part ----------

class Geo {
    positions = [];
    normals = [];
    indices = [];

    vertex(p, n) {
        this.positions.push(p[0], p[1], p[2]);
        this.normals.push(n[0], n[1], n[2]);
        return this.positions.length / 3 - 1;
    }

    tri(a, b, c) {
        this.indices.push(a, b, c);
    }

    /** A (truncated) cone or cylinder from `from` to `to`; smooth side normals, flat cap normals. */
    cylinder(from, to, rFrom, rTo, { segments = 32, capFrom = true, capTo = true } = {}) {
        const axis = sub(to, from);
        const length = len(axis);
        const w = norm(axis);
        const [u, v] = basis(w);
        const slope = (rFrom - rTo) / length; // side normals lean along the axis on a cone
        const ring = (theta) => add(scale(u, Math.cos(theta)), scale(v, Math.sin(theta)));

        const side = [];
        for (let i = 0; i <= segments; i++) {
            const radial = ring((i / segments) * Math.PI * 2);
            const n = norm(add(radial, scale(w, slope)));
            side.push([this.vertex(add(from, scale(radial, rFrom)), n), this.vertex(add(to, scale(radial, rTo)), n)]);
        }
        for (let i = 0; i < segments; i++) {
            const [a0, a1] = side[i];
            const [b0, b1] = side[i + 1];
            this.tri(a0, b0, a1);
            this.tri(b0, b1, a1);
        }
        const cap = (center, radius, normal, flip) => {
            const c = this.vertex(center, normal);
            const rim = [];
            for (let i = 0; i <= segments; i++) {
                rim.push(this.vertex(add(center, scale(ring((i / segments) * Math.PI * 2), radius)), normal));
            }
            for (let i = 0; i < segments; i++) {
                if (flip) this.tri(c, rim[i + 1], rim[i]);
                else this.tri(c, rim[i], rim[i + 1]);
            }
        };
        if (capTo && rTo > 0) cap(to, rTo, w, false);
        if (capFrom && rFrom > 0) cap(from, rFrom, scale(w, -1), true);
    }

    /** UV sphere with smooth normals. */
    sphere(center, radius, { segments = 28, rings = 18 } = {}) {
        const grid = [];
        for (let j = 0; j <= rings; j++) {
            const phi = (j / rings) * Math.PI;
            const row = [];
            for (let i = 0; i <= segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
                row.push(this.vertex(add(center, scale(n, radius)), n));
            }
            grid.push(row);
        }
        for (let j = 0; j < rings; j++) {
            for (let i = 0; i < segments; i++) {
                const a = grid[j][i];
                const b = grid[j][i + 1];
                const c = grid[j + 1][i];
                const d = grid[j + 1][i + 1];
                // Skip the degenerate triangle at each pole.
                if (j > 0) this.tri(a, b, c);
                if (j < rings - 1) this.tri(b, d, c);
            }
        }
    }

    /** Axis-aligned box (flat per-face normals), optionally tilted about one axis through its centre. */
    box(center, size, tilt = null) {
        const half = scale(size, 0.5);
        const rotate = (p) => {
            if (!tilt) return p;
            const a = (tilt.deg * Math.PI) / 180;
            const c = Math.cos(a);
            const s = Math.sin(a);
            if (tilt.axis === "x") return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
            if (tilt.axis === "y") return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
            return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
        };
        // Each face: normal n and in-plane axes s, t with s x t = n, so (0,1,2) and (0,2,3) wind counter-clockwise.
        const faces = [
            [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
            [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
            [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
            [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
            [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
        ];
        for (const [n, s, t] of faces) {
            const corner = (sx, sy) =>
                add(center, rotate(add(scale(n, dot(n, half)), add(scale(s, sx * dot(s, half)), scale(t, sy * dot(t, half))))));
            const normal = rotate(n);
            const ids = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].map((p) => this.vertex(p, normal));
            this.tri(ids[0], ids[1], ids[2]);
            this.tri(ids[0], ids[2], ids[3]);
        }
    }
}

// ---------- The lamp ----------
// Side view in the X/Y plane. Two parallel rods per arm, hinge barrels along Z.

const POST_TOP = [0, 0.05, 0];
const BASE_PIVOT = [0, 0.058, 0];
const ELBOW = [0.09, 0.275, 0];
const HEAD = [0.205, 0.43, 0];
const SHADE_DIR = norm([0.5, -0.866, 0]); // hangs down, tilted 30 degrees towards +X
const SHADE_TOP = [0.205, 0.405, 0];
const SHADE_LENGTH = 0.11;
const ROD_RADIUS = 0.0065;
const ROD_OFFSET = 0.014;

const barrel = (g, center, radius, halfLength) =>
    g.cylinder(add(center, [0, 0, -halfLength]), add(center, [0, 0, halfLength]), radius, radius, { segments: 28 });

const rods = (g, from, to) => {
    for (const z of [-ROD_OFFSET, ROD_OFFSET]) {
        g.cylinder(add(from, [0, 0, z]), add(to, [0, 0, z]), ROD_RADIUS, ROD_RADIUS, { segments: 16 });
    }
};

// Colours are linear glTF baseColorFactors. The shade is the app's burnt orange (#CE5222).
const parts = [
    {
        name: "Base",
        color: [0.12, 0.125, 0.14, 1],
        metallic: 0.85,
        roughness: 0.4,
        build: (g) => g.cylinder([0, 0, 0], [0, 0.022, 0], 0.095, 0.086, { segments: 48 }),
    },
    {
        name: "Power switch",
        color: [0.55, 0.04, 0.03, 1],
        metallic: 0,
        roughness: 0.5,
        build: (g) => {
            g.box([0, 0.027, 0.062], [0.03, 0.01, 0.018]);
            g.box([0, 0.0345, 0.062], [0.022, 0.006, 0.012], { axis: "x", deg: 12 });
        },
    },
    {
        name: "Base joint",
        color: [0.45, 0.47, 0.5, 1],
        metallic: 1,
        roughness: 0.3,
        build: (g) => {
            g.cylinder([0, 0.022, 0], POST_TOP, 0.013, 0.013, { segments: 24 });
            barrel(g, BASE_PIVOT, 0.017, 0.024);
        },
    },
    {
        name: "Lower arm",
        color: [0.72, 0.74, 0.77, 1],
        metallic: 1,
        roughness: 0.22,
        build: (g) => rods(g, BASE_PIVOT, ELBOW),
    },
    {
        name: "Elbow joint",
        color: [0.36, 0.38, 0.42, 1],
        metallic: 1,
        roughness: 0.35,
        build: (g) => {
            barrel(g, ELBOW, 0.016, 0.025);
            for (const z of [-0.027, 0.027]) {
                g.cylinder(add(ELBOW, [0, 0, z - 0.002]), add(ELBOW, [0, 0, z + 0.002]), 0.021, 0.021, { segments: 28 });
            }
        },
    },
    {
        name: "Upper arm",
        color: [0.62, 0.64, 0.68, 1],
        metallic: 1,
        roughness: 0.25,
        build: (g) => rods(g, ELBOW, HEAD),
    },
    {
        name: "Head joint",
        color: [0.5, 0.52, 0.56, 1],
        metallic: 1,
        roughness: 0.3,
        build: (g) => {
            barrel(g, HEAD, 0.014, 0.022);
            g.cylinder(HEAD, SHADE_TOP, 0.008, 0.008, { segments: 20 });
        },
    },
    {
        name: "Shade",
        color: [0.617, 0.084, 0.016, 1],
        metallic: 0.35,
        roughness: 0.45,
        doubleSided: true,
        build: (g) => {
            const bottom = add(SHADE_TOP, scale(SHADE_DIR, SHADE_LENGTH));
            g.cylinder(SHADE_TOP, bottom, 0.02, 0.07, { segments: 48, capFrom: true, capTo: false });
        },
    },
    {
        name: "Bulb",
        color: [1, 0.9, 0.62, 1],
        emissive: [1, 0.72, 0.3],
        metallic: 0,
        roughness: 0.25,
        build: (g) => g.sphere(add(SHADE_TOP, scale(SHADE_DIR, 0.07)), 0.024),
    },
];

// ---------- Assemble the document ----------

const doc = new Document();
doc.getRoot().getAsset().generator = "Assembly Studio demo fixture";
const buffer = doc.createBuffer();
const scene = doc.createScene("Desk lamp");

for (const part of parts) {
    const geo = new Geo();
    part.build(geo);
    const vertexCount = geo.positions.length / 3;
    const position = doc.createAccessor(`${part.name} positions`).setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array(geo.positions));
    const normal = doc.createAccessor(`${part.name} normals`).setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array(geo.normals));
    const indices = doc.createAccessor(`${part.name} indices`).setType("SCALAR").setBuffer(buffer)
        .setArray(vertexCount > 65535 ? new Uint32Array(geo.indices) : new Uint16Array(geo.indices));
    const material = doc.createMaterial(part.name)
        .setBaseColorFactor(part.color)
        .setMetallicFactor(part.metallic)
        .setRoughnessFactor(part.roughness)
        .setDoubleSided(Boolean(part.doubleSided));
    if (part.emissive) material.setEmissiveFactor(part.emissive);
    const primitive = doc.createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("NORMAL", normal)
        .setIndices(indices)
        .setMaterial(material);
    const mesh = doc.createMesh(part.name).addPrimitive(primitive);
    scene.addChild(doc.createNode(part.name).setMesh(mesh));
}

const io = new NodeIO();
const bytes = await io.writeBinary(doc);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, bytes);
await writeFile(
    EMBEDDED,
    `// GENERATED by scripts/assignment/make-fixture.mjs: do not edit. The demo-assembly.glb fixture as base64.\n` +
        `export const DEMO_GLB_BASE64 =\n    "${Buffer.from(bytes).toString("base64")}";\n`,
);

// ---------- Verify by reading the file back ----------

const check = await io.readBinary(new Uint8Array(await (await import("node:fs/promises")).readFile(OUT)));
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
let totalTriangles = 0;
let badNormals = 0;
console.log(`Wrote ${OUT} (${(bytes.byteLength / 1024).toFixed(1)} KB)`);
console.log("node".padEnd(14), "triangles".padStart(9), "  baseColorFactor");
for (const node of check.getRoot().listNodes()) {
    const prim = node.getMesh().listPrimitives()[0];
    const pos = prim.getAttribute("POSITION");
    const nor = prim.getAttribute("NORMAL");
    const idx = prim.getIndices().getArray();
    const triangles = idx.length / 3;
    totalTriangles += triangles;
    const p = (i) => pos.getElement(i, []);
    const n = (i) => nor.getElement(i, []);
    for (let t = 0; t < triangles; t++) {
        const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
        const face = cross(sub(p(b), p(a)), sub(p(c), p(a)));
        if (len(face) < 1e-12) continue; // degenerate sliver (e.g. at a sphere pole)
        const avg = add(add(n(a), n(b)), n(c));
        if (dot(face, avg) <= 0) badNormals++;
    }
    for (let i = 0; i < pos.getCount(); i++) {
        const q = p(i);
        for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], q[k]);
            max[k] = Math.max(max[k], q[k]);
        }
    }
    const color = node.getMesh().listPrimitives()[0].getMaterial().getBaseColorFactor().map((x) => x.toFixed(2)).join(", ");
    console.log(node.getName().padEnd(14), String(triangles).padStart(9), `  [${color}]`, idx.constructor.name);
}
console.log(`${check.getRoot().listNodes().length} parts, ${totalTriangles} triangles`);
console.log(`bounds: ${min.map((x) => x.toFixed(3)).join(", ")} -> ${max.map((x) => x.toFixed(3)).join(", ")} (height ${(max[1] - min[1]).toFixed(3)} m)`);
console.log(`triangles whose winding disagrees with their normals: ${badNormals}`);
if (badNormals > 0 || bytes.byteLength > 200 * 1024) {
    console.error("Fixture failed verification");
    process.exit(1);
}
