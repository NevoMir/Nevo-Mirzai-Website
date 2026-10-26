// Tests for the 3D viewer (src/assignment/viewer/*.ts): part extraction, connected-component
// splitting, explode offsets, camera framing, the GLB header reader and loader, the scene's looks and
// disposal, and the orbit viewer itself on a stub WebGL context (environment, hover, insets, context
// loss, GPU memory across model switches). Also the structural-analysis block view: the frame mapping,
// colour ramps, tooltip wording, outline geometry, block picking, triangle extraction, and the block
// scene on the stub context (levels of detail, picking, labels, disposal). And the stabilized-model side: the
// stress ramp and its legend, role colours, the colouring a result can do, the stress tooltip and pins, blocks that
// flash when the stabilizer's preview adds them, the assembly a GLB declares (loaded through GLTFLoader), its roles
// in the parts list, and the hook's version-switch / preview behaviour (the scene is swapped in place, the camera is kept).
// The stage's own view controls: the Colour chip's options (and why one is greyed), the layer cut as the Layers button and its
// popover read it, the legend wording, and the markup of the chip, the toolbar and the legend (server-rendered, so a menu
// that is closed shows only its trigger).
// Last, the added supports (a stabilized model shown on its source mesh): which blocks they are, the chip / tooltip / card
// wording, the cell -> display mapping under a transform, the cube layer (colours, edges, picking, marks, disposal), the
// overlay in the model's scene (bounds, framing, picking against the parts) and the hook that builds and swaps it.
//
//   node scripts/assignment/test-viewer.mjs
//
// The .ts modules are imported directly (Node 22 strips the types). No browser is needed: the orbit
// viewer section runs against a stand-in for the canvas and a WebGL context that only records.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Node < 22.18 only strips types behind a flag; run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const THREE = await import("three");
const viewer = (name) => import(`../../src/assignment/viewer/${name}.ts`);
const { extractParts, findPartRoots, isGenericName, countTriangles, tagMeshGroups, MESH_GROUP_FLAG, extractTriangleSoup } = await viewer("glbParts");
const split = await viewer("splitComponents");
const { explodeFactor, explodeOffsets, worldDeltaToLocal, unionCentre, EXPLODE_MAX } = await viewer("explode");
const framing = await viewer("framing");
const { inspectGlb, isGlb, decodersNeeded } = await viewer("glbHeader");
const viewerFormat = await viewer("format");
const { num, formatCount, safeFileName } = viewerFormat;
const stage = await viewer("stage");
const loadGlbModule = await viewer("loadGlb");
const { buildGlbScene, disposeObject } = await viewer("glbScene");
const { mountOrbitViewer, createEmptyViewerScene } = await viewer("orbitViewer");
const geom = await viewer("analysisGeometry");
const vocab = await import("../../src/assignment/components/analysis/vocabulary.ts");
const labelsModule = await viewer("overlayLabels");
const { createBlocksScene } = await viewer("analysisLayer");
const { planFocus } = await viewer("analysisFocus");
const { createModelHandle } = await viewer("loadedModel");

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}
const near = (actual, expected, eps = 1e-6, message = "") => assert.ok(Math.abs(actual - expected) <= eps, `${message} expected ${expected}, got ${actual}`);

// ---------- builders ----------

const mesh = (name, geometry = new THREE.BoxGeometry(1, 1, 1)) => {
    const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    m.name = name;
    return m;
};
const group = (name, ...children) => {
    const g = new THREE.Group();
    g.name = name;
    if (children.length) g.add(...children);
    return g;
};
/** A box with `seg` segments per side: 12 * seg^2 triangles, 6 material groups, UVs and normals. */
const box = (seg, size = 1, at = [0, 0, 0]) => {
    const g = new THREE.BoxGeometry(size, size, size, seg, seg, seg);
    g.translate(...at);
    return g;
};
/** One triangle, far from everything. */
const fragment = (at) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...at, at[0] + 0.1, at[1], at[2], at[0], at[1] + 0.1, at[2]]), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    return g;
};
const merge = (geometries) => {
    // Concatenate geometries (all indexed, same attributes) into one: a fused mesh of several bodies.
    const out = new THREE.BufferGeometry();
    for (const name of ["position", "normal", "uv"]) {
        const parts = geometries.map((g) => g.getAttribute(name));
        if (parts.some((p) => !p)) continue;
        const size = parts[0].itemSize;
        const array = new Float32Array(parts.reduce((s, p) => s + p.count * size, 0));
        let offset = 0;
        for (const p of parts) {
            array.set(p.array, offset);
            offset += p.count * size;
        }
        out.setAttribute(name, new THREE.BufferAttribute(array, size));
    }
    const indices = [];
    let base = 0;
    for (const g of geometries) {
        const index = g.index ? Array.from(g.index.array) : Array.from({ length: g.getAttribute("position").count }, (_, i) => i);
        for (const i of index) indices.push(i + base);
        base += g.getAttribute("position").count;
    }
    out.setIndex(indices);
    return out;
};

// ---------- part extraction ----------

console.log("glbParts");

await test("skips single-child wrappers, names parts, de-duplicates, numbers the unnamed", () => {
    const scene = group(
        "Scene",
        group(
            "Sketchfab_model",
            group(
                "Root",
                group(
                    "Assembly",
                    mesh("Gear"),
                    mesh("Gear"),
                    mesh(""),
                    group("Housing", mesh("Housing_a"), mesh("Housing_b")),
                    new THREE.Object3D(), // an empty node carries no geometry: not a part
                    mesh("mesh_5"), // a generated name says nothing: "Part 6"
                    mesh("Gear"),
                ),
            ),
        ),
    );
    const parts = extractParts(scene);
    assert.deepEqual(
        parts.map((p) => p.name),
        ["Gear", "Gear · 2", "Part 3", "Housing", "Part 5", "Gear · 3"],
    );
    assert.deepEqual(
        parts.map((p) => p.id),
        ["p1", "p2", "p3", "p4", "p5", "p6"],
    );
    assert.equal(parts[3].object.name, "Housing", "a group with meshes below it is one part");
    assert.equal(countTriangles(parts[3].object), 24, "its subtree is the part (2 boxes x 12)");
});

await test("a wrapper chain around one mesh is one part; a bare mesh is one part", () => {
    const only = mesh("Statue");
    assert.deepEqual(
        extractParts(group("S", group("W1", group("W2", only)))).map((p) => [p.name, p.object === only]),
        [["Statue", true]],
    );
    assert.equal(extractParts(only).length, 1);
    assert.equal(extractParts(mesh("")).at(0).name, "Part 1");
});

await test("a scene without geometry has no parts", () => {
    assert.deepEqual(extractParts(group("S", new THREE.Object3D(), group("Empty"))), []);
    assert.deepEqual(findPartRoots(new THREE.Object3D()), []);
});

await test("a flagged multi-primitive mesh group stays one part; unflagged groups split", () => {
    const material = (name) => mesh(name);
    const flagged = group("Body", material("Body"), material("Body_1"), material("Body_2"));
    flagged.userData[MESH_GROUP_FLAG] = true;
    assert.deepEqual(
        extractParts(group("S", flagged)).map((p) => p.name),
        ["Body"],
    );
    const plain = group("Wheels", material("A"), material("B"));
    assert.deepEqual(
        extractParts(group("S", plain)).map((p) => p.name),
        ["A", "B"],
    );
});

await test("the authored name (userData.name) beats the sanitised node name", () => {
    const m = mesh("Left_Wheel");
    m.userData.name = "Left Wheel";
    const n = mesh("Left_Wheel_1");
    n.userData.name = "Left Wheel";
    assert.deepEqual(
        extractParts(group("S", m, n)).map((p) => p.name),
        ["Left Wheel", "Left Wheel · 2"],
    );
});

await test("generic names are recognised", () => {
    for (const name of ["", "  ", "mesh_0", "Mesh", "Object_12", "node 4", "Group.001", "Scene", "Geometry-3"]) assert.ok(isGenericName(name), name);
    for (const name of ["Gear", "Housing", "Wheel_front", "Mesh_Roof", "Cube"]) assert.ok(!isGenericName(name), name);
});

await test("counts triangles of indexed and non-indexed meshes", () => {
    const indexed = mesh("a", box(2)); // 12 * 4 = 48
    const flat = mesh("b", box(1).toNonIndexed()); // 12
    assert.equal(countTriangles(group("g", indexed, flat)), 60);
});

// ---------- splitting ----------

console.log("splitComponents");

/** Every piece's meshes as [name, triangles] plus a total sanity check against the source. */
const summary = (result) => result.pieces.map((p) => [p.name, p.triangles]);
const trianglesOf = (p) => p.meshes.reduce((s, m) => s + split.triangleCount(m.geometry), 0);

await test("3 disjoint boxes + a tiny fragment -> 3 pieces + Small pieces", async () => {
    const fused = merge([box(8, 1, [0, 0, 0]), box(8, 1, [3, 0, 0]), box(8, 1, [0, 3, 0]), fragment([9, 9, 9])]);
    const result = await split.splitGeometries([fused]);
    assert.equal(result.componentCount, 4);
    assert.equal(result.mergedCount, 1);
    assert.equal(result.totalTriangles, 3 * 768 + 1);
    assert.deepEqual(summary(result), [
        ["Piece 1", 768],
        ["Piece 2", 768],
        ["Piece 3", 768],
        ["Small pieces", 1],
    ]);
    assert.equal(result.pieces[3].small, true);
    assert.deepEqual(
        result.pieces.map(trianglesOf),
        result.pieces.map((p) => p.triangles),
    );
    // Welding joined the 6 per-face copies of each corner: no box fell apart into faces.
    assert.ok(result.pieces.slice(0, 3).every((p) => p.meshes.length === 1));
});

await test("pieces are compact, keep UVs/normals, stay inside their body", async () => {
    const a = box(4, 1, [0, 0, 0]);
    const b = box(4, 1, [10, 0, 0]);
    const result = await split.splitGeometries([merge([a, b])]);
    assert.equal(result.pieces.length, 2);
    const full = merge([a, b]).getAttribute("position").count;
    let vertices = 0;
    for (const piece of result.pieces) {
        const g = piece.meshes[0].geometry;
        for (const name of ["position", "normal", "uv"]) assert.ok(g.getAttribute(name), `${piece.name} keeps ${name}`);
        assert.equal(g.getAttribute("uv").count, g.getAttribute("position").count);
        assert.equal(g.getAttribute("uv").itemSize, 2);
        assert.ok(g.index.array instanceof Uint16Array, "16-bit index when it fits");
        for (let i = 0; i < g.index.count; i += 1) assert.ok(g.index.array[i] < g.getAttribute("position").count);
        g.computeBoundingBox();
        assert.ok(g.boundingBox.max.x - g.boundingBox.min.x <= 1 + 1e-6, "one 1-unit box per piece");
        vertices += g.getAttribute("position").count;
    }
    assert.equal(vertices, full, "every vertex lands in exactly one piece");
    const xs = result.pieces.map((p) => p.meshes[0].geometry.boundingBox.getCenter(new THREE.Vector3()).x).sort((m, n) => m - n);
    near(xs[0], 0, 1e-6);
    near(xs[1], 10, 1e-6);
});

await test("UV values survive the split, vertex for vertex", async () => {
    const a = box(3, 1, [0, 0, 0]);
    const b = box(3, 2, [20, 0, 0]);
    const fused = merge([a, b]);
    const source = new Map();
    const p = fused.getAttribute("position");
    const uv = fused.getAttribute("uv");
    for (let i = 0; i < p.count; i += 1) source.set(`${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}|${uv.getX(i).toFixed(5)},${uv.getY(i).toFixed(5)}`, true);
    const result = await split.splitGeometries([fused]);
    for (const piece of result.pieces) {
        const g = piece.meshes[0].geometry;
        const gp = g.getAttribute("position");
        const gu = g.getAttribute("uv");
        for (let i = 0; i < gp.count; i += 1) {
            const key = `${gp.getX(i).toFixed(5)},${gp.getY(i).toFixed(5)},${gp.getZ(i).toFixed(5)}|${gu.getX(i).toFixed(5)},${gu.getY(i).toFixed(5)}`;
            assert.ok(source.has(key), `vertex ${i} of ${piece.name} was in the source with the same UV`);
        }
    }
});

await test("material groups: one mesh per material per piece, source materials kept", async () => {
    // BoxGeometry carries 6 groups (materialIndex 0..5, one per face).
    const result = await split.splitGeometries([box(2, 1, [0, 0, 0]), box(2, 1, [5, 0, 0])]);
    assert.equal(result.pieces.length, 2);
    for (const piece of result.pieces) {
        assert.equal(piece.meshes.length, 6, "6 material groups -> 6 meshes");
        assert.deepEqual(
            piece.meshes.map((m) => m.materialIndex),
            [0, 1, 2, 3, 4, 5],
        );
        for (const m of piece.meshes) assert.equal(split.triangleCount(m.geometry), 8, "a face of a 2x2 box side: 8 triangles");
        assert.equal(piece.triangles, 48);
    }
    // Equal sizes tie-break by source order: Piece 1 is source 0, Piece 2 source 1, and each stays in one source.
    assert.deepEqual(
        result.pieces.map((p) => [...new Set(p.meshes.map((m) => m.sourceIndex))]),
        [[0], [1]],
    );
});

await test("groups that do not cover every triangle drop the uncovered ones", async () => {
    const g = box(1, 1);
    g.clearGroups();
    g.addGroup(0, 18, 0); // 6 of the 12 triangles
    const result = await split.splitGeometries([g]);
    assert.equal(result.pieces.length, 1);
    assert.equal(result.pieces[0].triangles, 6);
});

await test("non-indexed geometry splits too", async () => {
    const fused = merge([box(4, 1, [0, 0, 0]), box(4, 1, [4, 0, 0])]).toNonIndexed();
    const result = await split.splitGeometries([fused]);
    assert.deepEqual(summary(result), [
        ["Piece 1", 192],
        ["Piece 2", 192],
    ]);
});

await test("interleaved attributes are read through", async () => {
    const base = merge([box(2, 1, [0, 0, 0]), box(2, 1, [4, 0, 0])]);
    const count = base.getAttribute("position").count;
    const interleaved = new THREE.InterleavedBuffer(new Float32Array(count * 5), 5);
    const pos = new THREE.InterleavedBufferAttribute(interleaved, 3, 0);
    const uv = new THREE.InterleavedBufferAttribute(interleaved, 2, 3);
    for (let i = 0; i < count; i += 1) {
        pos.setXYZ(i, base.getAttribute("position").getX(i), base.getAttribute("position").getY(i), base.getAttribute("position").getZ(i));
        uv.setXY(i, base.getAttribute("uv").getX(i), base.getAttribute("uv").getY(i));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", pos);
    g.setAttribute("uv", uv);
    g.setIndex(base.index);
    const result = await split.splitGeometries([g]);
    assert.equal(result.pieces.length, 2);
    const out = result.pieces[0].meshes[0].geometry;
    assert.ok(out.getAttribute("position").array instanceof Float32Array);
    assert.equal(out.getAttribute("uv").itemSize, 2);
});

await test("quantised (normalised integer) attributes keep their type and values", async () => {
    // KHR_mesh_quantization / Meshopt output: Int16 normalised positions, Uint16 normalised UVs.
    const base = merge([box(2, 1, [0, 0, 0]), box(2, 1, [4, 0, 0])]);
    const count = base.getAttribute("position").count;
    const positions = new Int16Array(count * 3);
    const uvs = new Uint16Array(count * 2);
    for (let i = 0; i < count; i += 1) {
        for (let c = 0; c < 3; c += 1) positions[i * 3 + c] = Math.round((base.getAttribute("position").array[i * 3 + c] / 8) * 32767);
        for (let c = 0; c < 2; c += 1) uvs[i * 2 + c] = Math.round(base.getAttribute("uv").array[i * 2 + c] * 65535);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3, true));
    g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2, true));
    g.setIndex(base.index);
    const result = await split.splitGeometries([g]);
    assert.equal(result.pieces.length, 2);
    const out = result.pieces[1].meshes[0].geometry; // the box at x = 4
    assert.ok(out.getAttribute("position").array instanceof Int16Array);
    assert.ok(out.getAttribute("uv").array instanceof Uint16Array);
    assert.equal(out.getAttribute("position").normalized, true);
    out.computeBoundingBox();
    near(out.boundingBox.min.x, (4 - 0.5) / 8, 1e-3);
    near(out.boundingBox.max.x, (4 + 0.5) / 8, 1e-3);
});

await test("ranks pieces across several source geometries, tracks their sources", async () => {
    const result = await split.splitGeometries([box(2, 1), box(6, 1)]); // 48 and 432 triangles
    assert.deepEqual(summary(result), [
        ["Piece 1", 432],
        ["Piece 2", 48],
    ]);
    assert.equal(result.pieces[0].meshes[0].sourceIndex, 1);
    assert.equal(result.pieces[1].meshes[0].sourceIndex, 0);
});

await test("maxPieces merges the rest into Small pieces", async () => {
    const bodies = [0, 1, 2, 3, 4].map((i) => box(4, 1, [i * 3, 0, 0]));
    const result = await split.splitGeometries([merge(bodies)], { maxPieces: 2 });
    assert.deepEqual(summary(result), [
        ["Piece 1", 192],
        ["Piece 2", 192],
        ["Small pieces", 576],
    ]);
    assert.equal(result.mergedCount, 3);
    assert.equal(result.pieces[2].meshes.length, 1, "the small bodies share a mesh when they share a material");
});

await test("one connected body gives one piece (callers treat that as nothing to split)", async () => {
    const result = await split.splitGeometries([box(5, 1)]);
    assert.equal(result.pieces.length, 1);
    assert.equal(result.componentCount, 1);
});

await test("welding tolerates float noise below the weld cell", async () => {
    // Two halves of a quad strip whose shared edge differs by 1e-9: still one body.
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, /**/ 1 + 1e-9, 0, 0, 1, 1, 0, 0 + 1e-9, 1, 0]), 3));
    const result = await split.splitGeometries([g], { minFraction: 0 });
    assert.equal(result.componentCount, 1);
});

await test("too many triangles are refused before any work", async () => {
    await assert.rejects(split.splitGeometries([box(8)], { maxTriangles: 100 }), (error) => error instanceof split.SplitTooLargeError && error.triangles === 768 && error.limit === 100);
    assert.equal(split.SPLIT_MAX_TRIANGLES, 2_000_000);
});

await test("an aborted signal stops the split", async () => {
    const controller = new AbortController();
    const pending = split.splitGeometries([merge([box(20), box(20, 1, [4, 0, 0])])], {
        signal: controller.signal,
        sliceMs: 0,
        yieldFn: async () => controller.abort(),
    });
    await assert.rejects(pending, (error) => error?.name === "AbortError");
});

await test("progress is monotonic and ends at 1; work yields in slices", async () => {
    const seen = [];
    let yields = 0;
    await split.splitGeometries([merge([box(10), box(10, 1, [4, 0, 0])])], {
        sliceMs: 0,
        yieldFn: async () => {
            yields += 1;
        },
        onProgress: (f) => seen.push(f),
    });
    assert.ok(yields > 0, "yielded to the event loop");
    assert.ok(seen.every((f, i) => i === 0 || f >= seen[i - 1]), "monotonic");
    near(seen.at(-1), 1, 1e-9);
});

await test("a ~500k-triangle model splits quickly and never blocks long", async () => {
    // Ten 1-unit icospheres-by-box-subdivision: 5 bodies x 100k triangles = 500k (box(91): 12*91^2 = 99,372 each).
    const bodies = [0, 1, 2, 3, 4].map((i) => box(91, 1, [i * 3, 0, 0]));
    const fused = merge([...bodies, fragment([50, 50, 50])]);
    const triangles = split.triangleCount(fused);
    assert.ok(triangles > 490_000, `${triangles} triangles`);
    // Longest stretch of work between two yields = how long the page could be unresponsive.
    let last = performance.now();
    let longest = 0;
    const started = last;
    const result = await split.splitGeometries([fused], {
        yieldFn: async () => {
            const t = performance.now();
            longest = Math.max(longest, t - last);
            await new Promise((resolve) => setTimeout(resolve, 0));
            last = performance.now();
        },
    });
    longest = Math.max(longest, performance.now() - last);
    const total = performance.now() - started;
    assert.equal(result.pieces.length, 6);
    assert.equal(result.pieces[5].name, "Small pieces");
    assert.equal(
        result.pieces.reduce((s, p) => s + p.triangles, 0),
        triangles,
    );
    console.log(`       ${triangles.toLocaleString("en-US")} triangles: ${Math.round(total)} ms in total, longest stretch without yielding ${longest.toFixed(1)} ms`);
    assert.ok(longest < 100, `longest stretch ${longest.toFixed(1)} ms`);
});

// ---------- explode ----------

console.log("explode");

await test("explodeFactor maps 0-100 % to 0..EXPLODE_MAX and clamps", () => {
    assert.equal(explodeFactor(0), 0);
    near(explodeFactor(100), EXPLODE_MAX);
    near(explodeFactor(50), EXPLODE_MAX / 2);
    assert.equal(explodeFactor(-20), 0);
    near(explodeFactor(500), EXPLODE_MAX);
    assert.equal(explodeFactor(NaN), 0);
});

await test("offsets run from the assembly centre through each part centre", () => {
    const centres = [new THREE.Vector3(10, 0, 0), new THREE.Vector3(-10, 0, 0), new THREE.Vector3(0, 0, 4), new THREE.Vector3(0, 0, 0)];
    const centre = new THREE.Vector3(0, 0, 0);
    const offsets = explodeOffsets(centres, centre, 0.5);
    assert.deepEqual(offsets.map((o) => o.toArray()), [[5, 0, 0], [-5, 0, 0], [0, 0, 2], [0, 0, 0]]);
    assert.deepEqual(explodeOffsets(centres, centre, 0).map((o) => o.length()), [0, 0, 0, 0], "k = 0 leaves everything in place");
    assert.deepEqual(centres[0].toArray(), [10, 0, 0], "inputs are not mutated");
});

await test("the assembly centre is the centre of the union of the boxes", () => {
    const boxes = [new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2)), new THREE.Box3(new THREE.Vector3(8, 0, 0), new THREE.Vector3(10, 2, 2)), new THREE.Box3()];
    assert.deepEqual(unionCentre(boxes).toArray(), [5, 1, 1]);
    assert.equal(unionCentre([new THREE.Box3()]), null);
});

await test("a world displacement is the same displacement through a rotated, scaled parent", () => {
    // Our scene: glTF content under a group rotated +90 degrees about X and scaled.
    const parent = new THREE.Group();
    parent.rotation.x = Math.PI / 2;
    parent.scale.setScalar(0.25);
    parent.position.set(3, -2, 1);
    const child = new THREE.Object3D();
    child.position.set(1, 2, 3);
    parent.add(child);
    parent.updateMatrixWorld(true);
    const before = child.getWorldPosition(new THREE.Vector3());
    const world = new THREE.Vector3(5, -7, 2);
    child.position.add(worldDeltaToLocal(parent.matrixWorld, world));
    parent.updateMatrixWorld(true);
    const moved = child.getWorldPosition(new THREE.Vector3()).sub(before);
    near(moved.x, 5, 1e-9);
    near(moved.y, -7, 1e-9);
    near(moved.z, 2, 1e-9);
    assert.deepEqual(worldDeltaToLocal(null, world).toArray(), [5, -7, 2]);
});

await test("explode moves split pieces and native parts alike (parts spread from the centre)", () => {
    const model = new THREE.Group();
    model.rotation.x = Math.PI / 2;
    model.scale.setScalar(2);
    const parts = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)].map((p) => {
        const holder = new THREE.Group();
        holder.add(mesh("p"));
        holder.position.copy(p);
        model.add(holder);
        return holder;
    });
    model.updateMatrixWorld(true);
    const base = parts.map((p) => p.position.clone());
    const centres = parts.map((p) => new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3()));
    const c = unionCentre(parts.map((p) => new THREE.Box3().setFromObject(p)));
    const k = explodeFactor(100);
    const offsets = explodeOffsets(centres, c, k);
    parts.forEach((p, i) => p.position.copy(base[i]).add(worldDeltaToLocal(model.matrixWorld, offsets[i])));
    model.updateMatrixWorld(true);
    parts.forEach((p, i) => {
        const after = new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3());
        const want = centres[i].clone().add(offsets[i]);
        near(after.distanceTo(want), 0, 1e-9, `part ${i}`);
        // Farther from the centre than before, on the same ray.
        near(after.clone().sub(c).length(), centres[i].clone().sub(c).length() * (1 + k), 1e-9);
    });
});

// ---------- framing ----------

console.log("framing");

const cube = (half, at = new THREE.Vector3()) => framing.boxCorners(new THREE.Box3(at.clone().subScalar(half), at.clone().addScalar(half)));

await test("fitFrame puts every point inside the frame, tightly", () => {
    const aspect = 16 / 9;
    const tanV = Math.tan(THREE.MathUtils.degToRad(framing.FOV / 2));
    const points = [...cube(50, new THREE.Vector3(0, 0, 50)), new THREE.Vector3(80, 10, 0)];
    const dir = new THREE.Vector3(1, -1, 1).normalize();
    const { position, target } = framing.fitFrame({ points, center: new THREE.Vector3(0, 0, 50), dir, tanH: tanV * aspect, tanV, margin: 1 });
    const camera = new THREE.PerspectiveCamera(framing.FOV, aspect, 0.1, 10000);
    camera.up.set(0, 0, 1);
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let worst = 0;
    for (const p of points) {
        const ndc = p.clone().project(camera);
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
    }
    assert.ok(worst <= 1 + 1e-9, `all inside (worst ${worst})`);
    assert.ok(worst > 0.99, `and tight (worst ${worst})`);
});

await test("visibleRect and viewOffsetFor centre the optical axis in the free rect", () => {
    const v = framing.visibleRect(1000, 600, { top: 0, right: 0, bottom: 0, left: 400 });
    assert.deepEqual([v.x, v.y, v.width, v.height, v.centerX, v.centerY], [400, 0, 600, 600, 700, 300]);
    assert.deepEqual(framing.viewOffsetFor(1000, 600, v), { x: -200, y: 0 });
    const w = framing.visibleRect(1000, 600, { top: 60, right: 20, bottom: 100, left: 0 });
    assert.deepEqual([w.x, w.y, w.width, w.height], [0, 60, 980, 440]);
    // Insets that would leave nothing are scaled down, not trusted.
    const tiny = framing.visibleRect(300, 200, { top: 0, right: 250, bottom: 0, left: 250 });
    assert.ok(tiny.width >= 96 - 1e-9 && tiny.x >= 0 && tiny.x + tiny.width <= 300 + 1e-9);
    assert.deepEqual(framing.visibleRect(500, 400, { top: NaN, right: -5, bottom: 0, left: 0 }).width, 500);
});

await test("with the view offset, a model fitted to the free rect lands inside it", () => {
    const [W, H] = [1000, 600];
    const insets = { top: 70, right: 30, bottom: 90, left: 420 };
    const visible = framing.visibleRect(W, H, insets);
    const { x, y } = framing.viewOffsetFor(W, H, visible);
    const { tanH, tanV } = framing.visibleTangents(framing.FOV, H, visible);
    const points = cube(40, new THREE.Vector3(5, -3, 40));
    const center = new THREE.Vector3(5, -3, 40);
    const dir = new THREE.Vector3(1, -1, 1).normalize();
    const { position, target } = framing.fitFrame({ points, center, dir, tanH, tanV, margin: 1 });
    const camera = new THREE.PerspectiveCamera(framing.FOV, W / H, 0.1, 10000);
    camera.up.set(0, 0, 1);
    camera.position.copy(position);
    camera.lookAt(target);
    camera.setViewOffset(W, H, x, y, W, H);
    camera.updateMatrixWorld();
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of points) {
        const ndc = p.clone().project(camera);
        const px = ((ndc.x + 1) / 2) * W;
        const py = ((1 - ndc.y) / 2) * H;
        [minX, maxX, minY, maxY] = [Math.min(minX, px), Math.max(maxX, px), Math.min(minY, py), Math.max(maxY, py)];
    }
    const eps = 1e-6;
    assert.ok(minX >= visible.x - eps && maxX <= visible.x + visible.width + eps, `x ${minX.toFixed(1)}..${maxX.toFixed(1)} in ${visible.x}..${visible.x + visible.width}`);
    assert.ok(minY >= visible.y - eps && maxY <= visible.y + visible.height + eps, `y ${minY.toFixed(1)}..${maxY.toFixed(1)} in ${visible.y}..${visible.y + visible.height}`);
    // Centred in the free rect, not just inside it.
    near((minX + maxX) / 2, visible.centerX, 25, "centred horizontally");
    near((minY + maxY) / 2, visible.centerY, 25, "centred vertically");
});

// ---------- GLB header and a real glTF round trip ----------

console.log("glb");

await test("number and file name helpers", () => {
    assert.equal(num(100), "100");
    assert.equal(num(12.345), "12.3");
    assert.equal(num(0.456), "0.46");
    assert.equal(formatCount(999), "999");
    assert.equal(formatCount(1234), "1,234");
    assert.equal(formatCount(84_300), "84.3k");
    assert.equal(formatCount(1_250_000), "1.25M");
    assert.equal(safeFileName('a/b\\c:d*e?"f<g>h|i'), "a b c d e f g h i");
    assert.equal(safeFileName("   "), "model");
    assert.equal(safeFileName(undefined, "x"), "x");
});

const { Document, WebIO } = await import("@gltf-transform/core");

/** A GLB with wrapper nodes, three named parts (one with two primitives). `single`: one node with three primitives instead. */
async function makeGlb(single = false, withLines = false) {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const prim = (x) =>
        doc
            .createPrimitive()
            .setAttribute("POSITION", accessor("VEC3", new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0, x, 0, 1])))
            .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2])));
    let top;
    if (single) {
        const lines = doc
            .createPrimitive()
            .setMode(1) // LINES: baked feature edges, as in KiCad models
            .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0])))
            .setIndices(accessor("SCALAR", new Uint16Array([0, 1])));
        const model = doc.createNode("Model").setMesh(doc.createMesh("ModelMesh").addPrimitive(prim(0)).addPrimitive(prim(3)).addPrimitive(withLines ? lines : prim(6)));
        top = doc.createNode("Sketchfab_model").addChild(model);
    } else {
        const gear = doc.createNode("Gear").setMesh(doc.createMesh("GearMesh").addPrimitive(prim(0)));
        const shaft = doc.createNode("Drive Shaft").setMesh(doc.createMesh("ShaftMesh").addPrimitive(prim(3)));
        const body = doc.createNode("Body").setMesh(doc.createMesh("BodyMesh").addPrimitive(prim(6)).addPrimitive(prim(9)));
        const root = doc.createNode("Root").addChild(gear).addChild(shaft).addChild(body);
        top = doc.createNode("Sketchfab_model").addChild(root);
    }
    doc.createScene("Scene").addChild(top);
    return new WebIO().writeBinary(doc);
}
const toBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

await test("inspectGlb reads the container and the declared extensions", async () => {
    const bytes = await makeGlb();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    assert.ok(isGlb(buffer));
    const info = inspectGlb(buffer);
    assert.equal(info.version, 2);
    assert.equal(info.length, buffer.byteLength);
    assert.deepEqual(info.extensionsUsed, []);
    assert.equal(inspectGlb(new ArrayBuffer(8)), null);
    assert.equal(inspectGlb(new TextEncoder().encode("<!doctype html><html></html>").buffer), null, "an HTML error page is not a GLB");

    // Splice extension names into the JSON chunk (re-padded with spaces, as the spec asks).
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, new DataView(buffer).getUint32(12, true))));
    json.extensionsUsed = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];
    json.extensionsRequired = ["KHR_draco_mesh_compression"];
    let text = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    padded.set(text);
    const oldSize = new DataView(buffer).getUint32(12, true);
    const rest = new Uint8Array(buffer, 20 + oldSize);
    const out = new Uint8Array(20 + padded.length + rest.length);
    out.set(new Uint8Array(buffer, 0, 20));
    out.set(padded, 20);
    out.set(rest, 20 + padded.length);
    new DataView(out.buffer).setUint32(12, padded.length, true);
    new DataView(out.buffer).setUint32(8, out.length, true);
    const patched = inspectGlb(out.buffer);
    assert.deepEqual(patched.extensionsUsed, ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"]);
    assert.deepEqual(patched.extensionsRequired, ["KHR_draco_mesh_compression"]);
});

await test("GLTFLoader output: wrappers skipped, authored names used, multi-primitive node kept whole", async () => {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loaded = await new GLTFLoader().parseAsync(toBuffer(await makeGlb()), "");
    assert.equal(tagMeshGroups(loaded.scene, loaded.parser.associations), 1, "only the node with two primitives is a mesh group");
    const parts = extractParts(loaded.scene);
    assert.deepEqual(
        parts.map((p) => p.name),
        ["Gear", "Drive Shaft", "Body"],
    );
    assert.deepEqual(
        parts.map((p) => countTriangles(p.object)),
        [4, 4, 8],
    );

    // One object with three materials sits behind wrappers: without the tag it would read as three parts.
    const single = await new GLTFLoader().parseAsync(toBuffer(await makeGlb(true)), "");
    assert.equal(extractParts(single.scene).length, 3, "untagged: one part per primitive");
    assert.equal(tagMeshGroups(single.scene, single.parser.associations), 1);
    const one = extractParts(single.scene);
    assert.deepEqual(
        one.map((p) => [p.name, countTriangles(p.object)]),
        [["Model", 12]],
    );

    // A line primitive among the triangle ones (baked edges) does not make the object an assembly.
    const edged = await new GLTFLoader().parseAsync(toBuffer(await makeGlb(true, true)), "");
    assert.equal(tagMeshGroups(edged.scene, edged.parser.associations), 1);
    assert.deepEqual(
        extractParts(edged.scene).map((p) => [p.name, countTriangles(p.object)]),
        [["Model", 8]],
    );
});


// ---------- splitting, more ----------

console.log("splitComponents (more)");

await test("hundreds of comparable small bodies still split (none reaches the 0.3 % threshold)", async () => {
    const bodies = Array.from({ length: 400 }, (_, i) => box(1, 1, [(i % 20) * 3, Math.floor(i / 20) * 3, 0]));
    const result = await split.splitGeometries([merge(bodies)]);
    assert.equal(result.componentCount, 400);
    assert.equal(result.pieces.length, split.SPLIT_MAX_PIECES + 1, "the biggest 64 are pieces, the rest are Small pieces");
    assert.equal(result.pieces.at(-1).name, "Small pieces");
    assert.equal(result.mergedCount, 400 - split.SPLIT_MAX_PIECES);
    assert.equal(
        result.pieces.reduce((sum, p) => sum + p.triangles, 0),
        400 * 12,
    );
    // Fewer bodies than the cap: every one is a piece.
    const few = await split.splitGeometries([merge(Array.from({ length: 350 }, (_, i) => box(1, 1, [i * 3, 0, 0])))], { maxPieces: 400 });
    assert.equal(few.pieces.length, 350);
});

await test("a model that really is one piece stays one piece, and a lone tiny stray is still small", async () => {
    assert.equal((await split.splitGeometries([box(3)])).pieces.length, 1);
    const stray = await split.splitGeometries([merge([box(6, 1), fragment([9, 9, 9])])]);
    assert.deepEqual(summary(stray), [
        ["Piece 1", 432],
        ["Small pieces", 1],
    ]);
});

await test("a mesh with one material is split whole even when its geometry carries groups (three draws it whole)", async () => {
    const g = box(2, 1);
    g.clearGroups();
    g.addGroup(0, 18, 0); // 6 of 48 triangles: with several materials the rest would not be drawn
    const grouped = await split.splitGeometries([g]);
    assert.equal(grouped.pieces[0].triangles, 6);
    const whole = await split.splitGeometries([g], { ignoreGroups: [true] });
    assert.equal(whole.pieces[0].triangles, 48);
    assert.equal(whole.pieces[0].meshes.length, 1);
    assert.equal(whole.pieces[0].meshes[0].materialIndex, 0);
});

await test("morph targets are left behind and skinned attributes are copied as plain attributes", async () => {
    const base = merge([box(2, 1, [0, 0, 0]), box(2, 1, [5, 0, 0])]);
    base.morphAttributes.position = [base.getAttribute("position").clone()];
    const count = base.getAttribute("position").count;
    base.setAttribute("skinIndex", new THREE.BufferAttribute(new Uint16Array(count * 4), 4));
    base.setAttribute("skinWeight", new THREE.BufferAttribute(new Float32Array(count * 4).fill(0.25), 4));
    const result = await split.splitGeometries([base]);
    assert.equal(result.pieces.length, 2);
    for (const piece of result.pieces) {
        const g = piece.meshes[0].geometry;
        assert.equal(Object.keys(g.morphAttributes).length, 0, "the pieces are static");
        assert.equal(g.getAttribute("skinIndex").itemSize, 4);
        assert.equal(g.getAttribute("skinWeight").count, g.getAttribute("position").count);
    }
});

await test("a ~500k-triangle NON-indexed model splits without a long stall either", async () => {
    const fused = merge([0, 1, 2, 3, 4].map((i) => box(91, 1, [i * 3, 0, 0]))).toNonIndexed();
    const triangles = split.triangleCount(fused);
    assert.ok(triangles > 490_000 && !fused.index, `${triangles} triangles, non-indexed`);
    let last = performance.now();
    let longest = 0;
    const started = last;
    const result = await split.splitGeometries([fused], {
        yieldFn: async () => {
            longest = Math.max(longest, performance.now() - last);
            await new Promise((resolve) => setTimeout(resolve, 0));
            last = performance.now();
        },
    });
    longest = Math.max(longest, performance.now() - last);
    assert.equal(result.pieces.length, 5);
    assert.equal(
        result.pieces.reduce((sum, p) => sum + p.triangles, 0),
        triangles,
    );
    console.log(`       ${triangles.toLocaleString("en-US")} triangles: ${Math.round(performance.now() - started)} ms in total, longest stretch without yielding ${longest.toFixed(1)} ms`);
    assert.ok(longest < 100, `longest stretch ${longest.toFixed(1)} ms`);
});

// ---------- loader ----------

console.log("loadGlb");

/** A GLB around hand-written JSON and a BIN chunk. */
function rawGlb(json, bin) {
    const text = new TextEncoder().encode(JSON.stringify(json));
    const jsonChunk = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
    jsonChunk.set(text);
    const binChunk = new Uint8Array(Math.ceil(bin.length / 4) * 4);
    binChunk.set(bin);
    const out = new Uint8Array(12 + 8 + jsonChunk.length + 8 + binChunk.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, out.length, true);
    view.setUint32(12, jsonChunk.length, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.set(jsonChunk, 20);
    view.setUint32(20 + jsonChunk.length, binChunk.length, true);
    view.setUint32(24 + jsonChunk.length, 0x004e4942, true);
    out.set(binChunk, 28 + jsonChunk.length);
    return out;
}
const info = (used, required = []) => ({ version: 2, length: 0, extensionsUsed: used, extensionsRequired: required });
const stream = (chunks, { error, onCancel } = {}) =>
    new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            if (error) controller.error(error);
            else controller.close();
        },
        cancel: onCancel,
    });
/** Runs `fn` with `fetch` answering `response`. */
async function withFetch(response, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = async () => response;
    try {
        return await fn();
    } finally {
        globalThis.fetch = real;
    }
}
const bytesOf = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const glbBytes = (n) => {
    const out = bytesOf(n);
    new DataView(out.buffer).setUint32(0, 0x46546c67, true); // the magic, so only the transfer is under test
    return out;
};

await test("decoders are chosen from the declared extensions, both Meshopt names included", () => {
    assert.deepEqual(decodersNeeded(null), { draco: false, meshopt: false, ktx2: false });
    assert.deepEqual(decodersNeeded(info(["KHR_materials_unlit"])), { draco: false, meshopt: false, ktx2: false });
    assert.deepEqual(decodersNeeded(info(["KHR_draco_mesh_compression", "KHR_texture_basisu"])), { draco: true, meshopt: false, ktx2: true });
    assert.equal(decodersNeeded(info(["EXT_meshopt_compression"])).meshopt, true);
    assert.equal(decodersNeeded(info(["KHR_meshopt_compression"])).meshopt, true, "the ratified name");
    assert.equal(decodersNeeded(info([], ["KHR_meshopt_compression"])).meshopt, true, "required but not listed as used");
});

await test("the decoder files are served where the loader looks, and are the ones this three version loads", async () => {
    const { readFile } = await import("node:fs/promises");
    assert.equal(loadGlbModule.DRACO_DECODER_PATH, "/assignment_alex/draco/");
    assert.equal(loadGlbModule.BASIS_TRANSCODER_PATH, "/assignment_alex/basis/");
    const three = new URL("../../node_modules/three/examples/jsm/", import.meta.url);
    const pub = new URL("../../public/", import.meta.url);
    const mentioned = async (loader, file) => assert.ok((await readFile(new URL(`loaders/${loader}.js`, three), "utf8")).includes(file), `${loader} loads ${file}`);
    for (const file of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) {
        await mentioned("DRACOLoader", file);
        const ours = await readFile(new URL(`${loadGlbModule.DRACO_DECODER_PATH.slice(1)}${file}`, pub));
        assert.ok(ours.equals(await readFile(new URL(`libs/draco/gltf/${file}`, three))), `public draco/${file} matches three's`);
    }
    for (const file of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
        await mentioned("KTX2Loader", file);
        const ours = await readFile(new URL(`${loadGlbModule.BASIS_TRANSCODER_PATH.slice(1)}${file}`, pub));
        assert.ok(ours.equals(await readFile(new URL(`libs/basis/${file}`, three))), `public basis/${file} matches three's`);
    }
});

await test("a compressed file reaches the Meshopt decoder under either extension name", async () => {
    for (const name of ["EXT_meshopt_compression", "KHR_meshopt_compression"]) {
        const json = {
            asset: { version: "2.0" },
            extensionsUsed: [name],
            extensionsRequired: [name],
            buffers: [{ byteLength: 64 }],
            bufferViews: [{ buffer: 0, byteLength: 36, byteStride: 12, extensions: { [name]: { buffer: 0, byteOffset: 0, byteLength: 16, byteStride: 12, count: 3, mode: "ATTRIBUTES" } } }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
            nodes: [{ mesh: 0 }],
            scenes: [{ nodes: [0] }],
            scene: 0,
        };
        // The data is garbage: with a decoder attached the failure is the decoder's, without one it is "setMeshoptDecoder must be called".
        const bytes = rawGlb(json, new Uint8Array(64).fill(0xff));
        await withFetch(new Response(bytes, { headers: { "content-length": String(bytes.length) } }), () =>
            assert.rejects(loadGlbModule.loadGlb("/x.glb"), (error) => /Malformed buffer data/.test(error.message) && !/setMeshoptDecoder/.test(error.message), name),
        );
    }
});

await test("a download lands in one buffer whether its size is known, missing or understated", async () => {
    const data = glbBytes(5000);
    const chunks = [data.slice(0, 1200), data.slice(1200, 1201), data.slice(1201, 4000), data.slice(4000)];
    const progress = [];
    for (const headers of [{ "content-length": "5000" }, {}, { "content-length": "100" }]) {
        progress.length = 0;
        const buffer = await withFetch(new Response(stream(chunks), { headers }), () => loadGlbModule.fetchGlb("/x.glb", { onProgress: (f) => progress.push(f) }));
        assert.equal(buffer.byteLength, 5000);
        assert.ok(new Uint8Array(buffer).every((b, i) => b === data[i]), `bytes intact (${JSON.stringify(headers)})`);
        assert.equal(progress.at(-1), 1);
        assert.ok(progress.every((f) => f === null || (f >= 0 && f <= 1)));
    }
});

await test("the size cap holds: by header, by stream without a length, and by a body without a stream", async () => {
    const cap = 4096;
    await withFetch(new Response(stream([glbBytes(100)]), { headers: { "content-length": String(cap + 1) } }), () =>
        assert.rejects(loadGlbModule.fetchGlb("/x.glb", { maxBytes: cap }), (error) => error.name === "GlbLoadError" && /too large/.test(error.message)),
    );
    let cancelled = false;
    const big = Array.from({ length: 10 }, () => bytesOf(1000));
    await withFetch(new Response(stream(big, { onCancel: () => (cancelled = true) })), () => assert.rejects(loadGlbModule.fetchGlb("/x.glb", { maxBytes: cap }), (error) => /too large/.test(error.message)));
    assert.ok(cancelled, "the rest of the download is dropped");
    const noStream = { ok: true, status: 200, headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(cap + 1) };
    await withFetch(noStream, () => assert.rejects(loadGlbModule.fetchGlb("/x.glb", { maxBytes: cap }), (error) => /too large/.test(error.message)));
    assert.equal(loadGlbModule.MAX_GLB_BYTES, 150 * 1024 * 1024);
    // A file exactly at the cap is fine.
    const exact = await withFetch(new Response(stream([glbBytes(cap)]), { headers: { "content-length": String(cap) } }), () => loadGlbModule.fetchGlb("/x.glb", { maxBytes: cap }));
    assert.equal(exact.byteLength, cap);
});

await test("download failures say what happened; an abort stays an abort", async () => {
    await withFetch(new Response("nope", { status: 404 }), () => assert.rejects(loadGlbModule.fetchGlb("/x.glb"), (error) => /not found/.test(error.message)));
    await withFetch(new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }), () => assert.rejects(loadGlbModule.fetchGlb("/x.glb"), (error) => /not a valid 3D model/.test(error.message)));
    await withFetch(new Response(stream([glbBytes(100)], { error: new TypeError("network error") })), () => assert.rejects(loadGlbModule.fetchGlb("/x.glb"), (error) => error.name === "GlbLoadError" && /interrupted/.test(error.message)));
    const controller = new AbortController();
    const real = globalThis.fetch;
    globalThis.fetch = async (_url, init) =>
        new Response(
            new ReadableStream({
                start(c) {
                    c.enqueue(glbBytes(50));
                    init.signal.addEventListener("abort", () => c.error(init.signal.reason));
                },
            }),
        );
    try {
        const pending = loadGlbModule.fetchGlb("/x.glb", { signal: controller.signal });
        setTimeout(() => controller.abort(), 5);
        await assert.rejects(pending, (error) => error.name === "AbortError");
    } finally {
        globalThis.fetch = real;
    }
});

// ---------- scene looks and disposal ----------

console.log("glbScene");

/** A glTF-like scene of `count` boxes side by side, each with its own map texture. */
const modelOf = (count) => {
    const group = new THREE.Group();
    for (let i = 0; i < count; i += 1) {
        const map = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
        map.needsUpdate = true;
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ map }));
        m.name = `Part ${i}`;
        m.position.x = i * 3;
        group.add(m);
    }
    return group;
};

await test("update() does the work only for what changed (an unchanged hover, selection or look draws nothing)", () => {
    let frames = 0;
    const scene = buildGlbScene(modelOf(3), { onChange: () => (frames += 1) });
    const step = (patch) => {
        const before = frames;
        scene.update(patch);
        return frames - before;
    };
    assert.equal(step({ hover: "p1" }), 1);
    assert.equal(step({ hover: "p1" }), 0, "same hover again");
    assert.equal(step({ hover: "nope" }), 1, "an unknown id is no hover: the old one ends");
    assert.equal(step({ hover: null }), 0);
    assert.equal(step({ selected: ["p1", "p2"] }), 1);
    assert.equal(step({ selected: ["p1", "p2"] }), 0);
    assert.equal(step({ selected: ["p1", "p2"], hidden: [], isolated: null }), 0, "the whole looks re-sent");
    assert.equal(step({ selected: ["p2", "p1"] }), 1, "order is the selection's");
    assert.equal(step({ hidden: ["p3"] }), 1);
    assert.equal(step({ hidden: ["p3", "p9"] }), 0, "unknown ids are ignored");
    assert.equal(step({ isolated: ["p1"] }), 1);
    assert.equal(step({ isolated: ["p1"] }), 0);
    assert.equal(step({ isolated: null }), 1);
    assert.equal(step({ selected: [], hidden: [], isolated: null }), 1, "clearing a selection and the hidden part is a change");
    assert.equal(step({ selected: [], hidden: [], isolated: null }), 0);
    scene.dispose();
    assert.equal(step({ hover: "p1" }), 0, "a disposed scene is inert");
});

await test("a hidden selected part gets its edges again when it is shown", async () => {
    const scene = buildGlbScene(modelOf(2), {});
    const edgeLines = () => scene.scene.getObjectByName("assembly:highlight").children.length;
    scene.update({ selected: ["p1"], hidden: ["p1"] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(edgeLines(), 0, "nothing drawn for a hidden part");
    scene.update({ hidden: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(edgeLines() > 0, "shown again: its edges are built and drawn");
    scene.dispose();
});

await test("split reports how many components there were, and splits a model of comparable small bodies", async () => {
    const scene = buildGlbScene(
        (() => {
            const g = new THREE.Group();
            g.add(mesh("Fused", merge(Array.from({ length: 400 }, (_, i) => box(1, 1, [(i % 20) * 3, Math.floor(i / 20) * 3, 0])))));
            return g;
        })(),
        {},
    );
    assert.ok(scene.canSplit);
    const summary = await scene.split();
    assert.equal(summary.changed, true);
    assert.equal(summary.components, 400);
    assert.equal(scene.rows.length, split.SPLIT_MAX_PIECES + 1);
    scene.unsplit();
    assert.equal(scene.rows.length, 1);
    scene.dispose();

    const one = buildGlbScene(group("g", mesh("Solid", box(4))), {});
    const solid = await one.split();
    assert.deepEqual([solid.changed, solid.components], [false, 1]);
    one.dispose();
});

await test("split follows how three draws: one material draws the whole geometry, an array only its groups", async () => {
    const fused = () => {
        const g = merge([box(2, 1, [0, 0, 0]), box(2, 1, [5, 0, 0])]); // 2 x 48 triangles
        g.addGroup(0, 18, 0); // the first 6 only
        return g;
    };
    const drawnBy = async (material) => {
        const scene = buildGlbScene(group("g", new THREE.Mesh(fused(), material)), {});
        const summary = await scene.split();
        const triangles = scene.rows.reduce((sum, row) => sum + row.triangles, 0);
        scene.dispose();
        return { summary, triangles };
    };
    const whole = await drawnBy(new THREE.MeshStandardMaterial());
    assert.deepEqual([whole.summary.changed, whole.summary.pieces, whole.triangles], [true, 2, 96]);
    const grouped = await drawnBy([new THREE.MeshStandardMaterial()]);
    // The second body lies outside every group: nothing of it is drawn, so it is no piece.
    assert.deepEqual([grouped.summary.changed, grouped.summary.pieces, grouped.summary.components], [false, 1, 2]);
});

await test("disposeObject frees textures, geometries, skeletons and instance buffers", () => {
    const calls = [];
    const track = (object, name) => {
        const real = object.dispose.bind(object);
        object.dispose = () => {
            calls.push(name);
            real();
        };
    };
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
    track(material.map, "map");
    track(material, "material");
    const skinned = new THREE.SkinnedMesh(new THREE.BoxGeometry(1, 1, 1), material);
    const bone = new THREE.Bone();
    skinned.add(bone);
    skinned.bind(new THREE.Skeleton([bone]));
    skinned.skeleton.boneTexture = new THREE.DataTexture(new Float32Array(16 * 4), 4, 1);
    track(skinned.skeleton.boneTexture, "boneTexture");
    track(skinned.geometry, "geometry");
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 3);
    track(instanced, "instanced");
    root.add(skinned, instanced);
    disposeObject(root);
    for (const name of ["map", "material", "boneTexture", "geometry", "instanced"]) assert.ok(calls.includes(name), `${name} disposed`);
    assert.equal(calls.filter((n) => n === "map").length, 1, "a shared texture once");
});

// ---------- stage ----------

console.log("stage");

await test("a thumbnail background is the same grey in every theme", () => {
    const paint = () => {
        const record = { stops: [], rect: null, fill: null, from: null };
        const ctx = {
            createLinearGradient: (...from) => ((record.from = from), { addColorStop: (offset, colour) => record.stops.push([offset, colour]) }),
            fillRect: (...rect) => (record.rect = rect),
            set fillStyle(value) {
                record.fill = value;
            },
        };
        stage.paintThumbnailBackground(ctx, 512, 384);
        return record;
    };
    const first = paint();
    assert.deepEqual(first.stops, [
        [0, "#8a8f98"],
        [1, "#787d86"],
    ]);
    assert.deepEqual(first.rect, [0, 0, 512, 384]);
    assert.deepEqual(first.from, [0, 0, 0, 384]);
    assert.equal(stage.paintThumbnailBackground.length, 3, "it takes no theme");
    assert.notEqual(stage.stageBackgroundCss("light"), stage.stageBackgroundCss("dark"));
});

// ---------- the orbit viewer on a stub WebGL context ----------

console.log("orbitViewer (stub WebGL)");

/** A WebGL context that records shader sources and answers everything else with nothing; plus the canvas around it. */
function stubDom() {
    const shaders = [];
    const names = new Map();
    const numbers = new Map();
    let next = 1000;
    const constant = (name) => {
        if (!names.has(name)) {
            names.set(name, next);
            numbers.set(next, name);
            next += 1;
        }
        return names.get(name);
    };
    const state = { lost: false, rect: { left: 0, top: 0, width: 400, height: 300 } };
    const target = {
        drawingBufferWidth: 100,
        drawingBufferHeight: 100,
        getContextAttributes: () => ({ alpha: true, antialias: true, depth: true, stencil: false, premultipliedAlpha: true }),
        getParameter: (p) => {
            const name = numbers.get(p);
            if (name === "VERSION") return "WebGL 2.0 stub";
            if (name === "SHADING_LANGUAGE_VERSION") return "WebGL GLSL ES 3.00";
            if (name === "VENDOR" || name === "RENDERER") return "stub";
            if (name === "SCISSOR_BOX" || name === "VIEWPORT") return new Int32Array([0, 0, 100, 100]);
            return 16384;
        },
        getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
        getExtension: () => null,
        getSupportedExtensions: () => [],
        createShader: (type) => ({ type }),
        shaderSource: (shader, source) => {
            shader.source = source;
            shaders.push(source);
        },
        getShaderParameter: () => true,
        getProgramParameter: (_program, key) => (["ACTIVE_UNIFORMS", "ACTIVE_ATTRIBUTES"].includes(numbers.get(key)) ? 0 : true),
        getShaderInfoLog: () => "",
        getProgramInfoLog: () => "",
        getShaderSource: (shader) => shader.source,
        isContextLost: () => state.lost,
    };
    const gl = new Proxy(target, {
        get(t, key) {
            if (key in t) return t[key];
            if (typeof key === "string" && /^[A-Z][A-Z0-9_]+$/.test(key)) return constant(key);
            return () => ({});
        },
    });
    const listeners = new Map();
    const canvas = {
        width: 300,
        height: 150,
        style: {},
        ownerDocument: { addEventListener() {}, removeEventListener() {} },
        addEventListener: (type, fn) => (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn),
        removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
        dispatch(type, event = {}) {
            for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault() {}, ...event });
        },
        listenerCount: (type) => listeners.get(type)?.size ?? 0,
        getContext: () => gl,
        getBoundingClientRect: () => state.rect,
        getRootNode: () => ({ addEventListener() {}, removeEventListener() {} }),
        setAttribute() {},
        setPointerCapture() {},
        releasePointerCapture() {},
        remove() {
            canvas.removed = true;
        },
    };
    const drawn = [];
    const out = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (...args) => drawn.push(["drawImage", ...args]) }),
        toBlob: (resolve, type) => resolve(new Blob(["x"], { type })),
    };
    globalThis.document = { createElementNS: () => canvas, createElement: () => out };
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => frames.push(fn);
    globalThis.cancelAnimationFrame = () => {};
    const container = { appendChild() {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => state.rect, clientWidth: 400, clientHeight: 300 };
    /** Runs the animation frames queued so far (a hover flush waits out its cool-down: call again). */
    const flush = async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        frames.splice(0).forEach((fn) => fn());
    };
    return { shaders, canvas, container, state, drawn, flush };
}
const stubEnvironment = () => {
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    texture.mapping = THREE.CubeUVReflectionMapping;
    texture.needsUpdate = true;
    return texture;
};
const physicalPrograms = (v) => v.renderer.info.programs.filter((p) => p.cacheKey.startsWith("physical,")).length;

await test("the environment applies to the model, and the pre-warm compiles the programs the render uses", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const scene = buildGlbScene(modelOf(1), { environment: stubEnvironment() });
    dom.shaders.length = 0;
    v.setScene(scene);
    v.setView("iso");
    v.requestFrame();
    assert.ok(dom.shaders.some((source) => /#define USE_ENVMAP\b/.test(source)), "USE_ENVMAP: the environment lights the material");
    assert.equal(physicalPrograms(v), 1, "compile and render agree: one program for the model");
    // Without an environment on the scene there is none in the shader either.
    const bare = buildGlbScene(modelOf(1), {});
    dom.shaders.length = 0;
    v.setScene(bare);
    v.requestFrame();
    assert.ok(!dom.shaders.some((source) => /#define USE_ENVMAP\b/.test(source)));
    v.dispose();
});

await test("hover: leaving a part, or dragging, is told once, not on every pointer move", async () => {
    const dom = stubDom();
    const hovers = [];
    let enabled = true;
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light", hoverEnabled: () => enabled, onHover: (hit) => hovers.push(hit && hit.id) });
    v.setScene(buildGlbScene(modelOf(1), {}));
    v.setView("iso");
    const move = (x, y, buttons = 0) => dom.canvas.dispatch("pointermove", { clientX: x, clientY: y, buttons });
    // Nothing to tell while the pointer was never on a part.
    for (let i = 0; i < 5; i += 1) move(2 + i, 2);
    await dom.flush();
    assert.deepEqual(hovers, []);
    // On the part: told with each flush (the tooltip follows the pointer).
    move(200, 150);
    await dom.flush();
    assert.deepEqual(hovers, ["p1"]);
    // A drag ends the hover once.
    for (let i = 0; i < 6; i += 1) move(200 + i, 150, 1);
    assert.deepEqual(hovers, ["p1", null]);
    // Onto empty space and moving about there: no more calls after the pointer left the part.
    move(200, 150);
    await dom.flush();
    move(2, 2);
    await dom.flush();
    for (let i = 0; i < 4; i += 1) {
        move(3 + i, 2);
        await dom.flush();
    }
    assert.deepEqual(hovers.slice(2), ["p1", null]);
    // A one-part model turns hover off: a single null at most, then nothing.
    move(200, 150);
    await dom.flush();
    enabled = false;
    const before = hovers.length;
    for (let i = 0; i < 6; i += 1) move(200 + i, 150);
    assert.equal(hovers.length - before, 1);
    assert.equal(hovers.at(-1), null);
    // The pointer leaving the canvas ends a hover once as well.
    enabled = true;
    move(200, 150);
    await dom.flush();
    const mark = hovers.length;
    dom.canvas.dispatch("pointerleave");
    dom.canvas.dispatch("pointerleave");
    assert.deepEqual(hovers.slice(mark), [null]);
    v.dispose();
});

await test("a scene swap ends a hover that was on the old scene", async () => {
    const dom = stubDom();
    const hovers = [];
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light", onHover: (hit) => hovers.push(hit && hit.id) });
    v.setScene(buildGlbScene(modelOf(1), {}));
    v.setView("iso");
    dom.canvas.dispatch("pointermove", { clientX: 200, clientY: 150, buttons: 0 });
    await dom.flush();
    assert.deepEqual(hovers, ["p1"]);
    v.setScene(createEmptyViewerScene());
    assert.deepEqual(hovers, ["p1", null]);
    v.dispose();
});

await test("small inset steps add up: the camera is re-framed once they pass the threshold from the last framing", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    v.setScene(buildGlbScene(modelOf(2), {}));
    v.setView("iso");
    const at = () => v.camera().position.map((x) => +x.toFixed(6));
    const start = at();
    for (let left = 5; left <= 45; left += 5) v.setInsets({ top: 0, right: 0, bottom: 0, left }); // nine steps of 5 px, each under 12
    const stepped = at();
    assert.notDeepEqual(stepped, start, "the camera followed the insets");
    v.setView("fit");
    assert.deepEqual(stepped, at(), "the same framing as one big change to those insets");
    // A change under the threshold from the last framing only shifts the view offset.
    v.setInsets({ top: 0, right: 0, bottom: 0, left: 50 });
    assert.deepEqual(at(), stepped);
    v.dispose();
});

/** The client-pixel position of a world point, through a camera rebuilt from what the viewer reports. */
function screenOf(v, point, { width = 400, height = 300 } = {}) {
    const camera = new THREE.PerspectiveCamera(framing.FOV, width / height, 0.1, 100_000);
    camera.up.set(0, 0, 1);
    camera.position.fromArray(v.camera().position);
    camera.lookAt(new THREE.Vector3().fromArray(v.camera().target));
    camera.updateMatrixWorld();
    const ndc = point.clone().project(camera);
    return [((ndc.x + 1) / 2) * width, ((1 - ndc.y) / 2) * height];
}
const centreOf = (object) => new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());

await test("picking finds the part under the pointer in an exploded view, and among split pieces", async () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const scene = buildGlbScene(modelOf(3), { onChange: () => v.requestFrame() });
    v.setScene(scene);
    v.setView("iso");
    const pickEach = (expected) => {
        for (const [id, part] of scene.parts) assert.equal(v.pick(...screenOf(v, centreOf(part))), id, `${expected}: the centre of ${id}`);
    };
    pickEach("assembled");
    scene.setExplode(100);
    v.refresh();
    pickEach("exploded");
    scene.setExplode(35);
    v.refresh();
    pickEach("part way");
    assert.equal(v.pick(2, 2), null, "empty space");
    // Hidden and left-out (isolated) parts are clicked through.
    scene.update({ hidden: ["p2"] });
    assert.notEqual(v.pick(...screenOf(v, centreOf(scene.parts.get("p1")))), "p2");
    scene.update({ hidden: [], isolated: ["p3"] });
    assert.equal(v.pick(...screenOf(v, centreOf(scene.parts.get("p1")))), null);
    assert.equal(v.pick(...screenOf(v, centreOf(scene.parts.get("p3")))), "p3");
    scene.update({ isolated: null });
    scene.dispose();

    const fused = new THREE.Group();
    fused.add(mesh("Fused", merge([box(2, 1, [0, 0, 0]), box(2, 1, [3, 0, 0]), box(2, 1, [6, 0, 0])])));
    const whole = buildGlbScene(fused, { onChange: () => v.requestFrame() });
    v.setScene(whole);
    v.setView("iso");
    assert.equal((await whole.split()).pieces, 3);
    v.refresh();
    assert.equal(whole.rows.length, 3);
    for (const percent of [0, 80]) {
        whole.setExplode(percent);
        v.refresh();
        for (const [id, part] of whole.parts) assert.equal(v.pick(...screenOf(v, centreOf(part))), id, `split piece ${id} at ${percent} %`);
    }
    whole.unsplit();
    v.refresh();
    assert.equal(v.pick(...screenOf(v, centreOf(whole.parts.get("p1")))), "p1");
    v.dispose();
});

await test("a snapshot is framed on its own camera, restores the stage, and is refused on a lost context", async () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "dark" });
    assert.equal(await v.snapshot({ width: 64, height: 48 }), null, "nothing to show yet");
    v.setScene(buildGlbScene(modelOf(1), {}));
    v.setView("iso");
    const camera = v.camera();
    const size = v.renderer.getSize(new THREE.Vector2()).toArray();
    const painted = [];
    const blob = await v.snapshot({ width: 64, height: 48, paintBackground: (_ctx, w, h) => painted.push([w, h]) });
    assert.ok(blob instanceof Blob);
    assert.deepEqual(painted, [[64, 48]]);
    assert.deepEqual(dom.drawn.at(-1).slice(2), [0, 0, 64, 48]);
    assert.deepEqual(v.camera(), camera, "the user's camera is left alone");
    assert.deepEqual(v.renderer.getSize(new THREE.Vector2()).toArray(), size);
    assert.equal(v.renderer.getPixelRatio(), 1);
    // Lost: nothing would be drawn, so no cover is made.
    dom.state.lost = true;
    assert.equal(v.contextLost(), true);
    assert.equal(await v.snapshot({ width: 64, height: 48, paintBackground: () => assert.fail("must not paint") }), null);
    v.dispose();
});

await test("context loss is reported, a restore is reported, and a disposed viewer stops listening", () => {
    const dom = stubDom();
    const events = [];
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light", onContextLost: () => events.push("lost"), onContextRestored: () => events.push("restored") });
    let prevented = false;
    dom.canvas.dispatch("webglcontextlost", { preventDefault: () => (prevented = true) });
    assert.ok(prevented, "so the browser may restore it");
    dom.canvas.dispatch("webglcontextrestored");
    assert.deepEqual(events, ["lost", "restored"]);
    v.dispose();
    assert.equal(dom.canvas.listenerCount("webglcontextrestored"), 0);
    assert.equal(dom.canvas.listenerCount("webglcontextlost"), 0);
    assert.ok(dom.canvas.removed);
});

await test("model switches leave no geometry, texture, program or edge line behind", async () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const environment = stubEnvironment();
    const memory = () => ({ geometries: v.renderer.info.memory.geometries, textures: v.renderer.info.memory.textures, programs: v.renderer.info.programs.length });
    /** What a render would upload: the stub reads no uniforms, so textures are uploaded by hand. */
    const upload = (root) =>
        root.traverse((o) => {
            for (const m of [o.material ?? []].flat()) for (const value of Object.values(m)) if (value?.isTexture) v.renderer.initTexture(value);
        });
    const baseline = memory();
    for (let round = 0; round < 4; round += 1) {
        const scene = buildGlbScene(modelOf(3), { environment, onChange: () => v.requestFrame() });
        v.setScene(scene);
        v.setView("iso");
        upload(scene.scene);
        scene.update({ hover: "p1" });
        scene.update({ selected: ["p1", "p2"] });
        await new Promise((resolve) => setTimeout(resolve, 20)); // the selection's edges are built when idle
        scene.update({ isolated: ["p2"] });
        scene.update({ hover: "p3" });
        upload(scene.scene);
        if (round === 0) {
            const during = memory();
            assert.ok(during.geometries > 3 && during.textures >= 3 && during.programs > baseline.programs, `the harness sees the allocations ${JSON.stringify(during)}`);
        }
        scene.update({ hover: null, selected: [], isolated: null });
        v.setScene(createEmptyViewerScene());
        scene.dispose();
        assert.deepEqual(memory(), baseline, `round ${round}`);
    }
    v.dispose();
});

await test("splitting and joining again leave no piece geometry behind", async () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const geometries = () => v.renderer.info.memory.geometries;
    const fused = new THREE.Group();
    fused.add(mesh("Fused", merge([box(2, 1, [0, 0, 0]), box(2, 1, [5, 0, 0]), box(2, 1, [10, 0, 0])])));
    const scene = buildGlbScene(fused, { onChange: () => v.requestFrame() });
    v.setScene(scene);
    v.setView("iso");
    const joined = geometries();
    for (let round = 0; round < 3; round += 1) {
        const summary = await scene.split();
        assert.equal(summary.pieces, 3);
        v.refresh();
        assert.ok(geometries() > joined, "the pieces are drawn");
        scene.update({ selected: ["s1"] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        scene.unsplit();
        v.refresh();
        assert.equal(geometries(), joined, `round ${round}: back to the one mesh and the grid`);
        scene.update({ selected: [] });
    }
    v.setScene(createEmptyViewerScene());
    scene.dispose();
    assert.equal(geometries(), 0);
    v.dispose();
});

// ---------- the block view (structural analysis) ----------

console.log("analysisGeometry");

/** A hand-built analysis: a tower (4, 4, 0..5) with an arm along +x from (5..9, 4, 5) and a block floating at (1, 1, 7). */
function makeAnalysis({ inside = false, limit = 4 } = {}) {
    const cell = 100;
    const blocks = [];
    const add = (i, j, k, status, reach) =>
        blocks.push({ index: blocks.length, cell: [i, j, k], centerMm: [(i + 0.5) * cell, (j + 0.5) * cell, (k + 0.5) * cell], status, reach, body: status === "floating" ? 1 : 0, fill: 1, cantilever: null });
    for (let k = 0; k <= 5; k += 1) add(4, 4, k, "supported", 0);
    for (let i = 5; i <= 9; i += 1) add(i, 4, 5, i - 4 > limit ? "overreach" : "cantilever", i - 4);
    add(1, 1, 7, "floating", null);
    const hull = [[400, 400], [500, 400], [500, 500], [400, 500]];
    const stability = {
        cogMm: inside ? [450, 450, 300] : [720, 450, 400],
        groundPointMm: inside ? [450, 450] : [720, 450],
        supportHull: hull,
        footprint: [[4, 4]],
        inside,
        marginMm: inside ? 50 : -220,
        tipDirection: inside ? null : [1, 0],
        pivotMm: [500, 450],
    };
    return {
        settings: { targetSizeMm: 1000, blockSizeMm: cell, fillThreshold: 0.3, cantileverLimit: limit, maxBlocks: null },
        gridSize: [10, 10, 10],
        transform: { factor: 10, modelMin: [-30, -10, 0], offsetMm: [200, 300, 0] },
        sizeMm: [1000, 600, 800],
        blocks,
        bodies: [],
        cantilevers: [],
        stability,
        issues: [],
        checks: [],
        stats: { blockCount: blocks.length, groundBlocks: 1, cantileveredCount: 5, longestCantilever: 5, overLimitCount: 1, floatingCount: 1, bodyCount: 2, layers: 8, coverage: 1 },
        summary: {},
        timingsMs: { voxelize: 0, analyze: 0 },
    };
}
const DEFAULT_VIEW = { colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [] };
const triArea = (positions) => {
    let sum = 0;
    for (let t = 0; t < positions.length; t += 9) {
        const [ax, ay, bx, by, cx, cy] = [positions[t], positions[t + 1], positions[t + 3], positions[t + 4], positions[t + 6], positions[t + 7]];
        sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    }
    return sum;
};

await test("the frame mapping inverts the engine's (mm = (p - modelMin) * factor + offset) and places the mm-built scene", () => {
    const t = { factor: 10, modelMin: [-30, -10, 0], offsetMm: [200, 300, 0] };
    assert.deepEqual(geom.mmToDisplay([200, 300, 0], t), [-30, -10, 0]);
    assert.deepEqual(geom.mmToDisplay([0, 0, 0], t), [-50, -40, 0]);
    assert.deepEqual(geom.mmToDisplay([1000, 1000, 1000], t), [50, 60, 100]);
    for (const p of [[3, -7, 12], [-30, -10, 0]]) near(geom.displayToMm(geom.mmToDisplay(p, t), t)[1], p[1], 1e-9);
    const placement = geom.displayPlacement(t);
    assert.equal(placement.scale, 0.1);
    assert.deepEqual(placement.position, [-50, -40, 0]);
    assert.deepEqual(geom.volumeMm(makeAnalysis()), [1000, 1000, 1000]);
});

await test("colours: statuses per theme, the reach ramp against the limit, the layer ramp, floating and supported in reach mode", () => {
    assert.equal(geom.statusColor("supported", "light"), "#94a3b8");
    assert.equal(geom.statusColor("supported", "dark"), "#475062", "a deep slate: the mid slate had the dark stage's own luminance");
    assert.equal(geom.statusColor("cantilever", "dark"), "#f59e0b");
    assert.equal(geom.statusColor("overreach", "light"), "#ef4444");
    assert.equal(geom.statusColor("floating", "light"), "#a855f7");
    assert.equal(geom.reachColor(1, 4), "#3b82f6", "one block out is blue");
    assert.equal(geom.reachColor(4, 4), "#f59e0b", "at the limit it is amber");
    assert.equal(geom.reachColor(5, 4), "#ef4444", "past it is red");
    assert.equal(geom.reachColor(9, 4), "#ef4444");
    assert.equal(geom.reachColor(1, 1), "#f59e0b", "a limit of one: the first block is at it");
    assert.equal(geom.layerColor(0, 8), "#471365");
    assert.equal(geom.layerColor(7, 8), "#fde725");
    assert.equal(geom.layerColor(0, 1), geom.layerColor(0, 1));
    const a = makeAnalysis();
    const ctx = { theme: "light", limit: 4, layers: 8 };
    const [tower, arm1, arm5, floating] = [a.blocks[0], a.blocks[6], a.blocks[10], a.blocks[11]];
    assert.equal(geom.blockColor(tower, "status", ctx), "#94a3b8");
    assert.equal(geom.blockColor(tower, "reach", ctx), "#94a3b8", "supported is grey in reach mode");
    assert.equal(geom.blockColor(arm1, "reach", ctx), "#3b82f6");
    assert.equal(geom.blockColor(arm5, "reach", ctx), "#ef4444");
    assert.equal(geom.blockColor(floating, "reach", ctx), "#a855f7", "no reach for a floating block");
    assert.equal(geom.blockColor(tower, "layer", ctx), "#471365");
    const [r, g, b] = geom.hexToRgb(geom.dimColor("#ef4444"));
    assert.ok(Math.abs(r - g) < Math.abs(0.937 - 0.267), "dimming drains the colour toward grey");
    assert.equal(geom.rgbToHex(geom.hexToRgb("#ce5222")), "#ce5222");
    assert.ok(b > 0.2);
});

await test("a block's tooltip says where it is and why: supported, overhang, overhang too long, floating", () => {
    const a = makeAnalysis();
    const info = (i) => geom.describeBlock(a.blocks[i], a.settings);
    assert.equal(info(0).text, "Block, 0–100 mm up · Supported · rests on the ground");
    assert.equal(info(3).detail, "carried down to the ground");
    assert.equal(info(6).text, "Block, 500–600 mm up · Overhang · 1 block from the nearest support");
    assert.equal(info(8).detail, "3 blocks from the nearest support");
    assert.equal(info(10).text, "Block, 500–600 mm up · Overhang too long · 5 blocks from the nearest support, the limit is 4");
    assert.equal(info(10).status, "overreach");
    assert.equal(info(11).detail, "not connected to the ground");
    assert.equal(info(11).title, "Block");
    assert.equal(info(11).zRange, "700–800 mm up", "where it is in words, not as cell coordinates");
    for (let i = 0; i < a.blocks.length; i++) {
        assert.doesNotMatch(info(i).text, /\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)|\bz \d|kPa/, `block ${i}: ${info(i).text}`);
        assert.deepEqual(vocab.technicalWordsIn(info(i).text), [], `block ${i}: ${info(i).text}`);
    }
    // The stage speaks plainly; the engine's words (cantilever, overreach) stay in the report files.
    assert.deepEqual(geom.STATUS_LABELS, { supported: "Supported", cantilever: "Overhang", overreach: "Overhang too long", floating: "Floating" });
    assert.deepEqual(a.blocks.map((b) => geom.describeBlock(b, a.settings).statusLabel).filter((v, i, all) => all.indexOf(v) === i), ["Supported", "Overhang", "Overhang too long", "Floating"]);
});

await test("counts, layers and the cut", () => {
    const a = makeAnalysis();
    assert.deepEqual(geom.countByStatus(a.blocks), { supported: 6, cantilever: 4, overreach: 1, floating: 1 });
    assert.equal(geom.topLayer(a.blocks), 7);
    assert.equal(geom.topLayer([]), -1);
    assert.equal(geom.cutActive(a.blocks, 9), false);
    assert.equal(geom.cutActive(a.blocks, 7), false);
    assert.equal(geom.cutActive(a.blocks, 6), true);
    assert.deepEqual(geom.shownBlocks(a.blocks, 4), [0, 1, 2, 3, 4]);
});

await test("ribbons: a square outline covers the band between the offset squares, whichever way it is wound; two points make a bar", () => {
    const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const ring = geom.ribbonTriangles(square, 0.1, 2);
    near(triArea(ring), 1.2 * 1.2 - 0.8 * 0.8, 1e-6, "ccw band");
    near(triArea(geom.ribbonTriangles([...square].reverse(), 0.1, 2)), 0.8, 1e-6, "cw band");
    assert.ok([...ring].every((v, i) => i % 3 !== 2 || v === 2), "at the given height");
    near(triArea(geom.ribbonTriangles([[0, 0], [2, 0]], 0.5, 0)), 2, 1e-6, "a bar");
    assert.equal(geom.ribbonTriangles([[1, 1]], 0.5, 0).length, 0);
    assert.equal(geom.ribbonTriangles([[1, 1], [1, 1], [1, 1]], 0.5, 0).length, 0, "repeats collapse to nothing");
    assert.equal(geom.ribbonTriangles(square, 0, 0).length, 0);
    // A sharp corner is cut short rather than spiking out (the mitre limit).
    const spike = geom.ribbonTriangles([[0, 0], [10, 0], [0, 0.5]], 0.2, 0);
    assert.ok(Math.max(...spike.filter((_, i) => i % 3 === 0)) < 10.6 + 1, "bounded");
});

await test("fans, cell quads and box edges", () => {
    near(triArea(geom.fanTriangles([[0, 0], [2, 0], [2, 2], [0, 2]], 1)), 4, 1e-9);
    assert.equal(geom.fanTriangles([[0, 0], [1, 1]], 0).length, 0);
    near(triArea(geom.cellTriangles([[0, 0], [3, 2]], 100, 0, 5)), 2 * 90 * 90, 1e-6);
    assert.equal(geom.cellTriangles([[0, 0]], 100, 0).length, 18);
    const edges = geom.boxEdgeSegments([0, 0, 0], [1, 2, 3]);
    assert.equal(edges.length, 12 * 6);
    // Every edge runs along one axis.
    for (let e = 0; e < 12; e += 1) {
        const d = [0, 1, 2].map((a) => Math.abs(edges[e * 6 + 3 + a] - edges[e * 6 + a]));
        assert.equal(d.filter((v) => v > 0).length, 1);
    }
    const outline = geom.cellOutlineSegments([[2, 3]], 100, 500);
    assert.equal(outline.length, 24);
    assert.ok([...outline].filter((_, i) => i % 3 === 2).every((z) => z === 500));
});

await test("the tip arrow starts at the pivot, points the way it tips, and reaches past the ground point", () => {
    const a = makeAnalysis({ inside: false });
    const arrow = geom.tipArrow(a.stability, 100);
    assert.deepEqual(arrow.from, [500, 450]);
    assert.deepEqual(arrow.dir, [1, 0]);
    near(arrow.to[0], 500 + 330, 1e-9, "past the ground point (220 mm out) by a block and a bit");
    assert.equal(geom.tipArrow(makeAnalysis({ inside: true }).stability, 100), null);
    assert.equal(geom.cogSummary(a.stability).sub, "Outside the base by 220 mm: tips over");
    assert.equal(geom.cogSummary(makeAnalysis({ inside: true }).stability).sub, "Inside the base by 50 mm");
});

await test("scene labels: the 1000 mm dimensions always, the COG and tip only with the COG shown, the cut only when something is hidden", () => {
    const a = makeAnalysis({ inside: false });
    const ids = (view) => geom.sceneLabels(a, view).map((l) => l.id);
    assert.deepEqual(ids({ showCog: true, layerMax: 9 }), ["dim-x", "dim-z", "cog", "tip"]);
    assert.deepEqual(ids({ showCog: false, layerMax: 9 }), ["dim-x", "dim-z"]);
    assert.deepEqual(ids({ showCog: false, layerMax: 3 }), ["dim-x", "dim-z", "cut"]);
    const labels = geom.sceneLabels(a, { showCog: true, layerMax: 3 });
    assert.equal(labels.find((l) => l.id === "dim-x").text, "1000 mm");
    assert.equal(labels.find((l) => l.id === "cut").text, "Layers 1–4");
    assert.equal(labels.find((l) => l.id === "cut").sub, "cut at z = 400 mm");
    assert.equal(labels.find((l) => l.id === "cog").tone, "bad");
    assert.equal(geom.sceneLabels(makeAnalysis({ inside: true }), { showCog: true, layerMax: 9 }).find((l) => l.id === "cog").tone, "ok");
    assert.equal(geom.sceneLabels({ ...a, stability: null }, { showCog: true, layerMax: 9 }).some((l) => l.id === "cog"), false, "no COG when nothing touches the ground");
});

await test("block picking: the nearest box along the ray, a preferred set wins over nearer ones, misses and edge cases", () => {
    // Three unit boxes in a row along +x at x = 0, 2, 4.
    const mins = [0, 0, 0, 2, 0, 0, 4, 0, 0];
    const maxs = [1, 1, 1, 3, 1, 1, 5, 1, 1];
    const all = [0, 1, 2];
    assert.equal(geom.rayBox([-1, 0.5, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1]), 1);
    assert.equal(geom.rayBox([0.5, 0.5, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1]), 0, "from inside");
    assert.equal(geom.rayBox([-1, 2, 0.5], [1, 0, 0], [0, 0, 0], [1, 1, 1]), null, "above");
    assert.equal(geom.rayBox([-1, 0.5, 0.5], [-1, 0, 0], [0, 0, 0], [1, 1, 1]), null, "away");
    assert.equal(geom.rayBox([0.5, 5, 0.5], [0, 1, 0], [0, 0, 0], [1, 1, 1]), null, "parallel and outside the slab... moving away");
    const hit = geom.pickBlock([-1, 0.5, 0.5], [1, 0, 0], mins, maxs, all);
    assert.equal(hit.index, 0);
    assert.equal(hit.t, 1);
    assert.equal(geom.pickBlock([-1, 0.5, 0.5], [1, 0, 0], mins, maxs, [1, 2]).index, 1, "a hidden block is not hit");
    assert.equal(geom.pickBlock([-1, 0.5, 0.5], [1, 0, 0], mins, maxs, all, new Set([2])).index, 2, "the preferred block behind others");
    assert.equal(geom.pickBlock([-1, 0.5, 0.5], [1, 0, 0], mins, maxs, all, new Set([7])).index, 0, "a preferred set nobody hits changes nothing");
    assert.equal(geom.pickBlock([-1, 3, 0.5], [1, 0, 0], mins, maxs, all), null);
    assert.equal(geom.pickBlock([-1, 0.5, 0.5], [1, 0, 0], mins, maxs, []), null);
});

await test("the focus box holds the point and the blocks highlighted", () => {
    const a = makeAnalysis();
    const plain = geom.focusBounds([500, 500, 500], [], 100);
    assert.deepEqual(plain.min, [340, 340, 340]);
    assert.deepEqual(plain.max, [660, 660, 660]);
    const grown = geom.focusBounds([500, 500, 500], [a.blocks[10], a.blocks[11]], 100);
    assert.equal(grown.max[0], 1000, "reaches the end of the arm");
    assert.equal(grown.min[0], 100, "and the floating block");
    assert.equal(grown.max[2], 800);
});

await test("readability: blocks keep their distance from the stage in both themes, dimmed blocks and their edges stay visible", () => {
    // The lighting estimate of glbScene.ts per face (top / front / right), the block material at 0.94, sRGB out, sRGB blend over the stage.
    const FACES = [1.15, 0.87, 0.52];
    const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const lit = (hex, light) => rgb(hex).map((c) => Math.min(1, srgb(lin(c) * 0.94 * light)));
    const over = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
    const stageOf = { light: [0.97, 0.97, 0.97], dark: rgb(stage.STAGE_BACKGROUND.dark.top) };
    const statuses = ["supported", "cantilever", "overreach", "floating"];
    // The supported blocks are most of any design: on the dark theme's mid-grey stage they must not be the stage's own luminance.
    for (const light of FACES) assert.ok(ratio(lit(geom.statusColor("supported", "dark"), light), stageOf.dark) >= 1.6, `dark supported face at light ${light}`);
    for (const theme of ["light", "dark"]) {
        for (const status of statuses) {
            const hex = geom.statusColor(status, theme);
            for (const light of FACES) {
                const dimmed = over(lit(geom.dimColor(hex, theme), light), stageOf[theme], geom.DIM_OPACITY[theme]);
                assert.ok(ratio(dimmed, stageOf[theme]) >= 1.25, `${theme} dimmed ${status} at light ${light}: ${ratio(dimmed, stageOf[theme]).toFixed(2)}:1 (was 1.0-1.2)`);
            }
        }
        const edge = over(rgb(geom.PALETTE[theme].edge), stageOf[theme], geom.DIM_EDGE_OPACITY);
        assert.ok(ratio(edge, stageOf[theme]) >= 1.5, `${theme} dimmed edges: ${ratio(edge, stageOf[theme]).toFixed(2)}:1 (was 1.2-1.3)`);
    }
    // The drain toward the tone is theme-aware: the old single grey is the dark stage's luminance.
    assert.notEqual(geom.dimColor("#ef4444", "light"), geom.dimColor("#ef4444", "dark"));
    assert.equal(geom.dimColor("#ef4444"), geom.dimColor("#ef4444", "light"), "light is the default");
});

await test("the layer cut: the outline sits on the highest occupied layer at or below it, and a highlight can be cut away", () => {
    // Layers 0-2 and 6-9 are occupied; 3-5 are a gap.
    const at = (k, i) => ({ index: i, cell: [0, 0, k], centerMm: [50, 50, k * 100 + 50], status: "supported", reach: 0, body: 0, fill: 1, cantilever: null });
    const blocks = [0, 1, 2, 6, 7, 8, 9].map((k, i) => at(k, i));
    assert.equal(geom.sectionLayer(blocks, 9), 9);
    assert.equal(geom.sectionLayer(blocks, 7), 7);
    assert.equal(geom.sectionLayer(blocks, 6), 6);
    assert.equal(geom.sectionLayer(blocks, 5), 2, "in the gap: the last layer that has blocks");
    assert.equal(geom.sectionLayer(blocks, 3), 2);
    assert.equal(geom.sectionLayer(blocks, 0), 0);
    assert.equal(geom.sectionLayer(blocks, -1), -1, "nothing shown");
    assert.equal(geom.sectionLayer([], 4), -1);
    assert.equal(geom.sectionLayer(blocks, 99), 9, "a cut above the top");
    // Which of a highlight the cut hides.
    assert.deepEqual(geom.highlightCut(blocks, [0, 1, 4], 5), { total: 3, hidden: 1 });
    assert.deepEqual(geom.highlightCut(blocks, [4, 5, 6], 5), { total: 3, hidden: 3 });
    assert.deepEqual(geom.highlightCut(blocks, [4, 99], 9), { total: 1, hidden: 0 }, "an index that is no block counts for nothing");
    assert.deepEqual(geom.highlightCut(blocks, [], 0), { total: 0, hidden: 0 });
});

await test("the COG label says when floating blocks are left out of it, and keeps its verdict", () => {
    const a = makeAnalysis({ inside: true });
    assert.equal(geom.cogSummary(a.stability).note, undefined, "nothing floats: nothing to add");
    const some = geom.cogSummary(a.stability, 28);
    assert.equal(some.note, "Grounded blocks only, 28 floating left out");
    assert.equal(some.sub, "Inside the base by 50 mm", "the verdict line is the plain one");
    assert.equal(some.tone, "ok");
    assert.equal(geom.cogSummary(makeAnalysis({ inside: false }).stability, 1).tone, "bad");
    // The scene counts them from the blocks themselves (the hand-built analysis has one floating block).
    assert.equal(geom.sceneLabels(a, { showCog: true, layerMax: 9 }).find((l) => l.id === "cog").note, "Grounded blocks only, 1 floating left out");
    const grounded = { ...a, blocks: a.blocks.filter((b) => b.status !== "floating") };
    assert.equal(geom.sceneLabels(grounded, { showCog: true, layerMax: 9 }).find((l) => l.id === "cog").note, undefined);
});

await test("the callout follows the pick it was made for: flown to once, retired with the highlight, kept across a tab round trip", () => {
    const base = { token: 1, active: true, highlightKey: "10", allHidden: false, appliedToken: null, calloutFor: null };
    const first = planFocus(base);
    assert.deepEqual(first, { fly: true, showCallout: true, appliedToken: 1, calloutFor: "10" }, "a new pick: fly and point");
    const again = (state, patch) => planFocus({ ...base, appliedToken: state.appliedToken, calloutFor: state.calloutFor, ...patch });
    assert.deepEqual(again(first, {}), { fly: false, showCallout: true, appliedToken: 1, calloutFor: "10" }, "the same pick again: no second flight");
    // (a) The selection is cleared, or (b) another issue's block is clicked: the highlight is not the one the callout was made for.
    assert.equal(again(first, { highlightKey: "" }).showCallout, false, "cleared");
    assert.equal(again(first, { highlightKey: "8,9" }).showCallout, false, "another issue is lit");
    assert.equal(again(first, { highlightKey: "8,9" }).fly, false, "and no flight for it");
    // (c) Off stage the callout is down, remembered, and comes back with no flight.
    const away = again(first, { active: false });
    assert.deepEqual(away, { fly: false, showCallout: false, appliedToken: 1, calloutFor: "10" });
    assert.deepEqual(again(away, {}), { fly: false, showCallout: true, appliedToken: 1, calloutFor: "10" });
    // Nothing picked: forgotten, so an older pick cannot come back by itself.
    const none = again(first, { token: null });
    assert.deepEqual(none, { fly: false, showCallout: false, appliedToken: 1, calloutFor: null });
    assert.equal(again(none, { token: 1 }).showCallout, false, "the same token after a null is not a new pick");
    // A new token is a new pick, whatever happened before.
    assert.deepEqual(again(none, { token: 2, highlightKey: "8,9" }), { fly: true, showCallout: true, appliedToken: 2, calloutFor: "8,9" });
    // An issue with no blocks of its own (thin features) still gets its callout: its key is the empty highlight.
    assert.equal(planFocus({ ...base, highlightKey: "" }).showCallout, true);
    // The cut hides every block of the pick: no flight to nothing, no marker in empty space; the callout joins in when the cut lets one show.
    const hidden = planFocus({ ...base, allHidden: true });
    assert.deepEqual(hidden, { fly: false, showCallout: false, appliedToken: 1, calloutFor: "10" });
    assert.deepEqual(planFocus({ ...base, appliedToken: 1, calloutFor: "10", allHidden: false }), { fly: false, showCallout: true, appliedToken: 1, calloutFor: "10" }, "revealed later: pointed at, not flown to");
});

await test("a model handle reads while its model is shown and throws once retired or freed, never an empty soup", () => {
    let live = new Float32Array(18);
    const handle = createModelHandle("/m.glb", () => live);
    assert.equal(handle.model.url, "/m.glb");
    assert.equal(handle.model.extractTriangles().positions.length, 18);
    // The scene was freed under the handle (the viewer's own read comes back empty or missing): that is an error, not a model with no triangles.
    live = new Float32Array(0);
    assert.throws(() => handle.model.extractTriangles(), /no longer shown/);
    live = null;
    assert.throws(() => handle.model.extractTriangles(), /no longer shown/);
    live = new Float32Array(9);
    assert.equal(handle.model.extractTriangles().positions.length, 9);
    // Retiring says whether it was the first time (the owner tells the workspace once), and ends the handle for good.
    assert.equal(handle.retire(), true);
    assert.equal(handle.retire(), false);
    assert.throws(() => handle.model.extractTriangles(), /no longer shown/, "even though the scene is back");
});

console.log("overlayLabels (fake DOM)");

/** Just enough DOM for the label layer and its builders: elements with a style, dataset, children and sizes. */
function fakeDocument() {
    const camel = (attr) => attr.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const element = (tag) => {
        const el = {
            tag, style: {}, dataset: {}, attrs: {}, children: [], className: "", offsetWidth: 100, offsetHeight: 20, parent: null,
            set textContent(value) { this.children = [{ text: String(value) }]; },
            get textContent() { return this.children.map((c) => (c.text !== undefined ? c.text : c.textContent)).join(""); },
            append(...nodes) { for (const n of nodes) { this.children.push(n); n.parent = this; } },
            appendChild(n) { this.append(n); return n; },
            remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
            setAttribute(k, v) { this.attrs[k] = v; },
            querySelector(selector) {
                const key = camel(selector.slice(1, -1));
                for (const c of this.children) {
                    if (c.dataset && key in c.dataset) return c;
                    const deeper = c.querySelector?.(selector);
                    if (deeper) return deeper;
                }
                return null;
            },
        };
        return el;
    };
    globalThis.document = { createElement: element, createTextNode: (text) => ({ text }) };
    return element;
}

await test("the label layer places a label above its anchor, keeps it inside the stage, hides it behind the camera, and reuses unchanged ones", () => {
    const make = fakeDocument();
    const host = Object.assign(make("div"), { clientWidth: 400, clientHeight: 300 });
    let at = { x: 200, y: 100, visible: true };
    const layer = labelsModule.createLabelLayer(host, () => at);
    const build = (tag = "div") => () => make(tag);
    layer.set("a", { anchor: [0, 0, 0], key: "1", el: build(), placement: "above", offset: 8, clamp: true });
    const a = host.children[0];
    assert.equal(a.style.visibility, "hidden", "hidden until the first update");
    layer.update();
    assert.equal(a.style.visibility, "visible");
    assert.equal(a.style.transform, "translate3d(150px, 72px, 0)", "centred above the anchor");
    at = { x: 10, y: 100, visible: true };
    layer.update();
    assert.equal(a.style.transform, "translate3d(6px, 72px, 0)", "kept inside the stage");
    at = { x: 200, y: 10, visible: true };
    layer.update();
    assert.equal(a.style.transform, "translate3d(150px, 18px, 0)", "below the anchor when there is no room above");
    at = { x: 200, y: 100, visible: false };
    layer.update();
    assert.equal(a.style.visibility, "hidden", "behind the camera");
    // The same key keeps the element and moves it; another key replaces it.
    at = { x: 300, y: 200, visible: true };
    layer.set("a", { anchor: [1, 1, 1], key: "1", el: build("span"), placement: "above" });
    assert.equal(host.children[0], a);
    layer.set("a", { anchor: [1, 1, 1], key: "2", el: build("span"), placement: "above" });
    assert.equal(host.children.length, 1);
    assert.equal(host.children[0].tag, "span");
    assert.equal(a.parent, null, "the old one is gone");
    layer.set("b", { anchor: [0, 0, 0], key: "x", el: build(), placement: "right", offset: 10 });
    layer.update();
    assert.equal(host.children[1].style.transform, "translate3d(310px, 190px, 0)", "to the right, centred on the anchor");
    layer.retain(new Set(["b"]));
    assert.equal(host.children.length, 1);
    assert.ok(layer.has("b") && !layer.has("a"));
    layer.remove("b");
    assert.equal(host.children.length, 0);
    layer.set("c", { anchor: [0, 0, 0], key: "x", el: build() });
    layer.dispose();
    assert.equal(host.children.length, 0);
});

await test("a callout's bubble swings to the left near the right edge of the stage", () => {
    const make = fakeDocument();
    const host = Object.assign(make("div"), { clientWidth: 400, clientHeight: 300 });
    let at = { x: 100, y: 100, visible: true };
    const layer = labelsModule.createLabelLayer(host, () => at);
    layer.set("callout", { anchor: [0, 0, 0], key: "k", el: () => labelsModule.calloutElement("Cantilever too long: 6 blocks"), placement: "center", offset: 0 });
    const el = host.children[0];
    [el.offsetWidth, el.offsetHeight] = [0, 0]; // the wrapper is h-0 w-0: only its children have a size
    el.children.find((c) => c.dataset?.bubbleBody !== undefined).offsetWidth = 180;
    layer.update();
    assert.equal(el.dataset.flip, "false");
    assert.equal(el.style.transform, "translate3d(100px, 100px, 0)", "the marker sits on the point");
    at = { x: 350, y: 100, visible: true };
    layer.update();
    assert.equal(el.dataset.flip, "true");
    // A callout without text is only the marker.
    assert.equal(labelsModule.calloutElement(undefined).children.length, 2);
    assert.equal(labelsModule.calloutElement("x").children.length, 3);
    layer.dispose();
});

await test("labels keep to the part of the stage the floating UI leaves free: clamped, flipped to the side with room, never under the dock", () => {
    const make = fakeDocument();
    const host = Object.assign(make("div"), { clientWidth: 1440, clientHeight: 900 });
    // The report dock (344 px), the chat (352 px), the top bar with the chips (122 px) and the toolbar (56 px).
    const insets = { top: 122, right: 352, bottom: 56, left: 344 };
    const sized = (w, h) => () => Object.assign(make("div"), { offsetWidth: w, offsetHeight: h });
    let at = { x: 447, y: 500, visible: true };
    const layer = labelsModule.createLabelLayer(host, () => at);
    const transform = (n) => host.children[n].style.transform;
    // The layer cut's label, left of the plate corner: with the dock open its first 90 px ("Layers 1-5") would be under it.
    layer.set("cut", { anchor: [0, 0, 0], key: "cut", el: sized(175, 22), placement: "left", offset: 8, clamp: true });
    layer.update();
    assert.equal(transform(0), "translate3d(264px, 489px, 0)", "the whole stage is free until it is told otherwise");
    layer.setInsets(insets);
    layer.update();
    assert.equal(transform(0), "translate3d(455px, 489px, 0)", "no room on the left inside the free part: it swings to the right of the corner");
    // A label that fits where it is stays.
    at = { x: 800, y: 500, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(617px, 489px, 0)");
    // A label on the right of its anchor swings left at the chat panel's edge (the free part ends at 1088).
    layer.remove("cut");
    layer.set("cog", { anchor: [0, 0, 0], key: "cog", el: sized(240, 42), placement: "right", offset: 16, clamp: true });
    at = { x: 1000, y: 500, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(744px, 479px, 0)", "left of the anchor: 1000 - 16 - 240");
    layer.remove("cog");
    // A tooltip (above its anchor, centred) is clamped on both sides to the free part.
    layer.set("tip", { anchor: [0, 0, 0], key: "tip", el: sized(200, 40), placement: "above", offset: 12, clamp: true });
    at = { x: 360, y: 400, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(350px, 348px, 0)", "not under the dock: its left edge at 344 + 6");
    at = { x: 1080, y: 400, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(882px, 348px, 0)", "not under the chat: its right edge at 1088 - 6");
    at = { x: 700, y: 140, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(600px, 152px, 0)", "below the anchor when above would be under the top bar");
    at = { x: 700, y: 840, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(600px, 788px, 0)", "above the anchor when below would be under the toolbar (the free part ends at 844)");
    // Labels that are not clamped (the dimensions) are left alone, and no insets at all is the whole stage again.
    layer.remove("tip");
    layer.set("dim", { anchor: [0, 0, 0], key: "dim", el: sized(60, 14), placement: "center", clamp: false });
    at = { x: 100, y: 100, visible: true };
    layer.update();
    assert.equal(transform(0), "translate3d(70px, 93px, 0)");
    layer.dispose();
    // The free rect: insets taken off the sides; too little left (a tiny window) and the whole stage is used instead.
    assert.deepEqual(labelsModule.freeRect(1440, 900, insets), { x0: 344, y0: 122, x1: 1088, y1: 844 });
    assert.deepEqual(labelsModule.freeRect(1440, 900, null), { x0: 0, y0: 0, x1: 1440, y1: 900 });
    assert.deepEqual(labelsModule.freeRect(400, 300, { top: 0, right: 0, bottom: 0, left: 300 }), { x0: 0, y0: 0, x1: 400, y1: 300 }, "100 px of width is not a stage");
    assert.deepEqual(labelsModule.freeRect(400, 300, { top: 250, right: 0, bottom: 0, left: 0 }), { x0: 0, y0: 0, x1: 400, y1: 300 }, "nor 50 px of height");
});

await test("a callout's bubble swings and drops to the side and the end of its marker where the free part of the stage has room", () => {
    const make = fakeDocument();
    const host = Object.assign(make("div"), { clientWidth: 1440, clientHeight: 900 });
    let at = { x: 1050, y: 400, visible: true };
    const layer = labelsModule.createLabelLayer(host, () => at);
    layer.set("callout", { anchor: [0, 0, 0], key: "k", el: () => labelsModule.calloutElement("Cantilever too long: 6 blocks"), placement: "center", offset: 0 });
    const el = host.children[0];
    [el.offsetWidth, el.offsetHeight] = [0, 0];
    const bubble = el.children.find((c) => c.dataset?.bubbleBody !== undefined);
    [bubble.offsetWidth, bubble.offsetHeight] = [180, 28];
    layer.update();
    assert.deepEqual([el.dataset.flip, el.dataset.vflip], ["false", "false"], "room on the right of the whole stage");
    layer.setInsets({ top: 122, right: 352, bottom: 56, left: 344 });
    layer.update();
    assert.equal(el.dataset.flip, "true", "the chat panel starts at 1088: the bubble goes to the left of the marker");
    at = { x: 600, y: 400, visible: true };
    layer.update();
    assert.equal(el.dataset.flip, "false", "back");
    // Near the top of the free part there is no room above for a bubble that stands 28 px clear; below there is.
    at = { x: 600, y: 140, visible: true };
    layer.update();
    assert.equal(el.dataset.vflip, "true");
    at = { x: 600, y: 400, visible: true };
    layer.update();
    assert.equal(el.dataset.vflip, "false");
    // With room on neither side the bubble stays where it is (it does not trade one overflow for a bigger one).
    layer.setInsets(null);
    at = { x: 20, y: 400, visible: true };
    host.clientWidth = 150;
    layer.update();
    assert.equal(el.dataset.flip, "false");
    layer.dispose();
});

await test("the callout's bubble stands clear of the marker, so it does not cover the COG label that shares its point", () => {
    fakeDocument();
    const callout = labelsModule.calloutElement("Centre of gravity outside the base");
    const bubble = callout.children.find((c) => c.dataset?.bubbleBody !== undefined);
    const classes = bubble.className.split(" ");
    assert.ok(classes.includes("bottom-7"), "28 px above the marker's centre; the COG label (centred on the point, ~42 px tall) reaches 21 px up");
    assert.ok(!classes.includes("bottom-3"));
    // A stem joins the bubble's square corner to the marker, so it still reads as the marker's.
    assert.equal(bubble.children.filter((c) => c.className?.includes("w-0.5")).length, 1);
    assert.equal(bubble.textContent, "Centre of gravity outside the base", "the stem adds no text");
});

await test("the label builders say what the hover, the scene labels and the callout carry", () => {
    fakeDocument();
    const a = makeAnalysis();
    const info = geom.describeBlock(a.blocks[10], a.settings);
    const tooltip = labelsModule.blockTooltip(info, "#ef4444");
    assert.equal(tooltip.attrs.role, "tooltip");
    assert.ok(tooltip.textContent.includes("Block") && tooltip.textContent.includes("500–600 mm up") && !/\(9, 4, 5\)/.test(tooltip.textContent) && tooltip.textContent.includes("Overhang too long") && tooltip.textContent.includes("5 blocks from the nearest support"));
    const labels = geom.sceneLabels(a, { showCog: true, layerMax: 3 });
    const text = (id) => labelsModule.sceneLabelElement(labels.find((l) => l.id === id)).textContent;
    assert.equal(text("dim-x"), "1000 mm");
    assert.equal(text("tip"), "Tips over this way");
    assert.equal(text("cog"), "Centre of gravity" + "Outside the base by 220 mm: tips over" + "Grounded blocks only, 1 floating left out", "the design has a floating block: the COG says it is left out");
    assert.equal(text("cut"), "Layers 1–4cut at z = 400 mm");
    assert.equal(labelsModule.calloutElement("Floating part: 2 blocks").textContent, "Floating part: 2 blocks");
});

console.log("glbParts: triangle soup");

await test("the soup is 9 floats per triangle with world transforms baked, indexed or not, hidden parts and instances included", () => {
    const root = new THREE.Group();
    // An indexed unit box (12 triangles) moved to x = 10 and scaled by 2.
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    a.position.set(10, 0, 0);
    a.scale.setScalar(2);
    // A non-indexed triangle in a hidden group.
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.position.set(0, 5, 0);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    hidden.add(new THREE.Mesh(tri, new THREE.MeshBasicMaterial()));
    // Two instances of the triangle.
    const instances = new THREE.InstancedMesh(tri, new THREE.MeshBasicMaterial(), 2);
    instances.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 100));
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 200));
    root.add(a, hidden, instances);
    root.updateMatrixWorld(true);
    const soup = extractTriangleSoup(root);
    assert.equal(soup.length, (12 + 1 + 2) * 9);
    const box = new THREE.Box3();
    for (let v = 0; v < 36; v += 1) box.expandByPoint(new THREE.Vector3(soup[v * 3], soup[v * 3 + 1], soup[v * 3 + 2]));
    assert.deepEqual(box.min.toArray(), [9, -1, -1]);
    assert.deepEqual(box.max.toArray(), [11, 1, 1]);
    const hiddenAt = 12 * 9;
    assert.deepEqual([...soup.slice(hiddenAt, hiddenAt + 9)], [0, 5, 0, 1, 5, 0, 0, 6, 0], "the hidden group's triangle, in world space");
    assert.deepEqual([soup[(13 * 9) + 2], soup[(14 * 9) + 2]], [100, 200], "each instance");
    // A degenerate corner is left out; a mesh without positions adds nothing.
    const bad = new THREE.BufferGeometry();
    bad.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, NaN, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    const lone = new THREE.Group();
    lone.add(new THREE.Mesh(bad, new THREE.MeshBasicMaterial()), new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    assert.equal(extractTriangleSoup(lone).length, 9);
});

await test("a scene reports its triangles as loaded: not exploded, not split, and empty once disposed", async () => {
    const scene = buildGlbScene(modelOf(3), {});
    const loaded = scene.extractTriangles();
    assert.equal(loaded.length, 3 * 12 * 9);
    const bounds = (soup) => {
        const b = new THREE.Box3();
        for (let v = 0; v < soup.length / 3; v += 1) b.expandByPoint(new THREE.Vector3(soup[v * 3], soup[v * 3 + 1], soup[v * 3 + 2]));
        return b;
    };
    // The display frame: Z-up, longest side 100, centred on x and y, bottom on z = 0.
    const box = bounds(loaded);
    near(Math.max(...box.getSize(new THREE.Vector3()).toArray()), 100, 1e-4);
    near(box.min.z, 0, 1e-4);
    near((box.min.x + box.max.x) / 2, 0, 1e-4);
    scene.setExplode(100);
    assert.deepEqual([...scene.extractTriangles()].map((v) => +v.toFixed(4)), [...loaded].map((v) => +v.toFixed(4)), "exploded: the same triangles");
    near(new THREE.Box3().setFromObject(scene.scene).getSize(new THREE.Vector3()).x, new THREE.Box3().setFromObject(scene.scene).getSize(new THREE.Vector3()).x);
    const exploded = new THREE.Box3().setFromObject(scene.parts.get("p1")).getCenter(new THREE.Vector3()).x;
    scene.setExplode(0);
    scene.setExplode(100);
    near(new THREE.Box3().setFromObject(scene.parts.get("p1")).getCenter(new THREE.Vector3()).x, exploded, 1e-9, "extracting left the exploded view as it was");
    const sources = scene.ghostSources();
    assert.equal(sources.length, 3);
    assert.ok(sources.every((s) => s.geometry.getAttribute("position") && s.matrix.elements.length === 16));
    scene.dispose();
    assert.equal(scene.extractTriangles().length, 0);
    assert.deepEqual(scene.ghostSources(), []);
});

console.log("analysisLayer (stub WebGL)");

const blocksOptions = (extra = {}) => ({ analysis: makeAnalysis(), view: DEFAULT_VIEW, theme: "light", ...extra });
const worldPoint = (blocks, mm) => new THREE.Vector3(...blocks.toWorld(mm));

await test("the block scene is placed in the display frame, bounds the 1 m volume, and offers the viewer what it needs", () => {
    const blocks = createBlocksScene(blocksOptions());
    assert.equal(blocks.grid, false, "it draws its own ground");
    assert.equal(blocks.parts.size, 0);
    assert.deepEqual(blocks.bounds.min.toArray(), [-50, -40, 0]);
    assert.deepEqual(blocks.bounds.max.toArray(), [50, 60, 100]);
    assert.deepEqual(blocks.toWorld([450, 450, 50]), [-5, 5, 5]);
    assert.deepEqual(blocks.anchorOf(0), [-5, 5, 10], "the top centre of the first block");
    const box = blocks.boxOf(0);
    assert.deepEqual(box.min.toArray(), [-10, 0, 0]);
    assert.deepEqual(box.max.toArray(), [0, 10, 10]);
    assert.equal(blocks.anchorOf(99), null);
    assert.equal(blocks.info(11).statusLabel, "Floating");
    assert.equal(blocks.colorOf(6), "#f59e0b");
    assert.equal(blocks.info(-1), null);
    blocks.dispose();
});

await test("instances follow the view: layer cut, highlight dimming, colour by, and setView says whether anything changed", () => {
    const frames = [];
    const blocks = createBlocksScene(blocksOptions({ onChange: () => frames.push(1) }));
    const meshes = () => blocks.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.filter((o) => o.isInstancedMesh);
    const [dimmed, halo, active] = (() => {
        const [d, h, a] = [meshes().find((m) => m.renderOrder === -3), meshes().find((m) => m.renderOrder === -2), meshes().find((m) => m.renderOrder === 0)];
        return [d, h, a];
    })();
    assert.equal(active.count, 12, "every block");
    assert.equal(dimmed.count, 0);
    assert.equal(halo.count, 0);
    assert.equal(blocks.setView({ ...DEFAULT_VIEW }), false, "the same view again: nothing to draw");
    assert.equal(frames.length, 0);
    // Cut to layer 4: the tower's first five blocks.
    assert.equal(blocks.setView({ ...DEFAULT_VIEW, layerMax: 4 }), true);
    assert.equal(active.count, 5);
    assert.equal(blocks.isShown(0), true);
    assert.equal(blocks.isShown(5), false, "layer 5 is cut away");
    assert.ok(frames.length > 0, "a frame is asked for");
    // Highlight the over-limit block: it keeps its place, the rest are dimmed, a halo is behind it.
    blocks.setView({ ...DEFAULT_VIEW, highlight: [10] });
    assert.equal(active.count, 1);
    assert.equal(dimmed.count, 11);
    assert.equal(halo.count, 1);
    const colorOfFirst = [...active.instanceColor.array.slice(0, 3)];
    const c = new THREE.Color("#ef4444");
    near(colorOfFirst[0], c.r, 1e-6);
    near(colorOfFirst[1], c.g, 1e-6);
    // A highlight of blocks that are cut away dims nothing.
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 2, highlight: [10] });
    assert.equal(active.count, 3);
    assert.equal(dimmed.count, 0);
    // Colour by reach changes the colours of the same blocks.
    blocks.setView({ ...DEFAULT_VIEW, colorBy: "reach" });
    assert.equal(blocks.colorOf(6), "#3b82f6");
    assert.equal(blocks.colorOf(0), "#94a3b8");
    blocks.setView({ ...DEFAULT_VIEW, colorBy: "layer" });
    assert.equal(blocks.colorOf(0), "#471365");
    blocks.dispose();
});

await test("the COG, the ground ghost and the support base can be switched off", () => {
    const blocks = createBlocksScene(blocksOptions());
    const verdict = blocks.scene.getObjectByName("blocks:verdict");
    const ghost = blocks.scene.getObjectByName("blocks:ghost");
    assert.equal(verdict.visible, true);
    assert.equal(ghost.visible, false);
    blocks.setView({ ...DEFAULT_VIEW, showCog: false, showGhost: true });
    assert.equal(verdict.visible, false);
    assert.equal(ghost.visible, true);
    blocks.dispose();
    const none = createBlocksScene(blocksOptions({ analysis: { ...makeAnalysis(), stability: null } }));
    assert.equal(none.scene.getObjectByName("blocks:verdict").children.length, 0, "nothing on the ground: nothing to show");
    none.dispose();
});

await test("the verdict's colour follows the COG: green and a ring inside the base, red and a cross with an arrow outside", () => {
    const palette = geom.PALETTE.light;
    const colorsOf = (analysis) => {
        const blocks = createBlocksScene(blocksOptions({ analysis }));
        const verdict = blocks.scene.getObjectByName("blocks:verdict");
        const out = new Set();
        verdict.traverse((o) => {
            if (o.material?.color && o.material.type === "MeshBasicMaterial" && o.material.transparent && o.geometry?.getAttribute("position").count > 4) out.add(o.material.color.getHexString());
        });
        const meshes = verdict.children.filter((o) => o.isMesh).length;
        blocks.dispose();
        return { out, meshes };
    };
    const inside = colorsOf(makeAnalysis({ inside: true }));
    const outside = colorsOf(makeAnalysis({ inside: false }));
    const want = (hex) => new THREE.Color(hex).getHexString();
    assert.ok(inside.out.has(want(palette.ok)), "green");
    assert.ok(!inside.out.has(want(palette.bad)));
    assert.ok(outside.out.has(want(palette.bad)), "red");
    assert.ok(outside.meshes > inside.meshes, "the pivot and the arrow are drawn only outside");
    const blocks = createBlocksScene(blocksOptions({ analysis: makeAnalysis({ inside: true }) }));
    blocks.setTheme("dark");
    const ring = blocks.scene.getObjectByName("blocks:verdict").children.find((o) => o.isMesh && o.material.depthTest !== false && o.material.type === "MeshBasicMaterial" && o.geometry.type === "RingGeometry");
    assert.equal(ring.material.color.getHexString(), want(geom.PALETTE.dark.ok), "repainted for the dark stage");
    blocks.dispose();
});

await test("the scene's labels carry world anchors", () => {
    const blocks = createBlocksScene(blocksOptions());
    const labels = blocks.labels();
    const cog = labels.find((l) => l.id === "cog");
    assert.deepEqual(cog.anchor, blocks.toWorld([720, 450, 400]));
    assert.ok(labels.find((l) => l.id === "dim-x").anchor[0] > -50);
    assert.equal(blocks.labels(), labels, "cached while the view is the same");
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 3 });
    assert.ok(blocks.labels().some((l) => l.id === "cut"));
    blocks.dispose();
});

/** Mounts a viewer on the stub context with the model's scene, then the blocks. */
function blockStage(extra = {}) {
    const dom = stubDom();
    const hovers = [];
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light", hoverEnabled: () => true, onHover: (hit) => hovers.push(hit && hit.id), ...extra });
    const model = buildGlbScene(modelOf(2), { onChange: () => v.requestFrame() });
    v.setScene(model);
    v.setView("iso");
    const blocks = createBlocksScene(blocksOptions({ ghost: model.ghostSources(), onChange: () => v.requestFrame() }));
    return { dom, v, model, blocks, hovers };
}

await test("on stage: the camera is kept across the swap, the viewer's grid goes, and the ground ghost is drawn from the model's geometry", () => {
    const { v, model, blocks } = blockStage();
    const before = v.camera();
    const gridBefore = v.renderer.info.memory.geometries;
    v.setScene(blocks);
    assert.deepEqual(v.camera(), before, "the camera stays");
    v.requestFrame();
    blocks.setView({ ...DEFAULT_VIEW, showGhost: true });
    const ghost = blocks.scene.getObjectByName("blocks:ghost");
    assert.equal(ghost.children.length, 2);
    assert.ok(ghost.children.every((m, i) => m.geometry === model.ghostSources()[i].geometry), "the model's geometry, shared");
    v.requestFrame();
    assert.ok(v.renderer.info.memory.geometries > 0 && gridBefore > 0);
    v.fitView();
    const volumeCentre = new THREE.Box3(new THREE.Vector3(-50, -40, 0), new THREE.Vector3(50, 60, 100)).getCenter(new THREE.Vector3());
    assert.ok(v.project(volumeCentre.toArray()).visible);
    v.setScene(model);
    blocks.dispose();
    model.dispose();
    v.dispose();
});

await test("picking: a ray through a block finds it (the nearest, the top of a tower first), through the viewer's own hit test", async () => {
    const { dom, v, model, blocks, hovers } = blockStage();
    v.setScene(blocks);
    v.setView("top");
    // Looking down: the pixel over the tower's cell reaches its top block (layer 5, index 5), not the ground block under it.
    const top = worldPoint(blocks, [450, 450, 600]);
    assert.equal(v.pick(...screenOf(v, top)), "5");
    // The arm's last block is picked over the empty space beside it.
    assert.equal(v.pick(...screenOf(v, worldPoint(blocks, [950, 450, 550]))), "10");
    assert.equal(v.pick(...screenOf(v, worldPoint(blocks, [150, 850, 0]))), null, "empty ground");
    // A cut layer is not pickable.
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 3 });
    assert.equal(v.pick(...screenOf(v, top)), "3", "the tower now ends at layer 3");
    // While an issue is highlighted its blocks win over dimmed ones in front.
    blocks.setView({ ...DEFAULT_VIEW, highlight: [0] });
    assert.equal(v.pick(...screenOf(v, top)), "0", "the highlighted ground block, through the dimmed tower");
    // The viewer's hover reports block ids.
    const [x, y] = screenOf(v, worldPoint(blocks, [950, 450, 550]));
    blocks.setView({ ...DEFAULT_VIEW });
    dom.canvas.dispatch("pointermove", { clientX: x, clientY: y, buttons: 0 });
    await dom.flush();
    assert.deepEqual(hovers, ["10"]);
    v.setScene(model);
    blocks.dispose();
    model.dispose();
    v.dispose();
});

await test("hover outline follows the block under the pointer and is cleared when its layer is cut away", () => {
    const blocks = createBlocksScene(blocksOptions());
    const outline = () => blocks.scene.getObjectByName("blocks:blocks").children.filter((o) => o.isLineSegments && o.renderOrder === 8)[0];
    assert.equal(outline().visible, false);
    blocks.setHover(10);
    assert.equal(outline().visible, true);
    assert.deepEqual(outline().position.toArray(), [950, 450, 550]);
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 3 });
    assert.equal(outline().visible, false, "the hovered block was cut away");
    blocks.setHover(99);
    assert.equal(outline().visible, false);
    blocks.dispose();
});

await test("the highlight pulses for a moment and then settles; reduced motion keeps it still", () => {
    const blocks = createBlocksScene(blocksOptions({ view: { ...DEFAULT_VIEW, highlight: [10] } }));
    const halo = blocks.scene.getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.renderOrder === -2);
    assert.equal(blocks.animate(1000), true, "starts");
    const first = halo.material.opacity;
    assert.equal(blocks.animate(1300), true);
    assert.notEqual(halo.material.opacity, first, "the opacity moves");
    assert.equal(blocks.animate(3000), false, "done");
    assert.equal(halo.material.opacity, 0.9);
    blocks.setView({ ...DEFAULT_VIEW, highlight: [8, 9] });
    assert.equal(blocks.animate(5000), true, "a new highlight pulses again");
    blocks.dispose();
    const still = createBlocksScene(blocksOptions({ view: { ...DEFAULT_VIEW, highlight: [10] }, reducedMotion: true }));
    assert.equal(still.animate(0), false);
    still.dispose();
});

await test("focus: the box holds the point and the highlighted blocks, in the display frame", () => {
    const blocks = createBlocksScene(blocksOptions({ view: { ...DEFAULT_VIEW, highlight: [10] } }));
    const box = blocks.focusBox([500, 500, 500]);
    assert.ok(box.containsPoint(new THREE.Vector3(...blocks.toWorld([500, 500, 500]))));
    assert.ok(box.containsPoint(new THREE.Vector3(...blocks.toWorld([950, 450, 550]))), "and the over-limit block");
    blocks.dispose();
});

await test("dimmed blocks and their edges follow the theme's look, so they stay readable on both stages", () => {
    const blocks = createBlocksScene(blocksOptions({ view: { ...DEFAULT_VIEW, highlight: [10] } }));
    const group = blocks.scene.getObjectByName("blocks:blocks");
    const dimmed = group.children.find((o) => o.isInstancedMesh && o.renderOrder === -3);
    const edges = group.children.find((o) => o.isLineSegments && o.renderOrder === -2);
    assert.equal(dimmed.count, 11);
    assert.equal(dimmed.material.opacity, geom.DIM_OPACITY.light);
    assert.equal(edges.material.opacity, geom.DIM_EDGE_OPACITY);
    const colorOf = (i) => [...dimmed.instanceColor.array.slice(i * 3, i * 3 + 3)];
    const want = (hex) => {
        const c = new THREE.Color(hex);
        return [c.r, c.g, c.b];
    };
    const sameColor = (got, expected, message) => got.forEach((v, k) => near(v, expected[k], 1e-6, message));
    // Block 0 is a supported block, dimmed while block 10 is highlighted.
    sameColor(colorOf(0), want(geom.dimColor(geom.statusColor("supported", "light"), "light")), "light");
    blocks.setTheme("dark");
    assert.equal(dimmed.material.opacity, geom.DIM_OPACITY.dark, "the dark stage needs more of it");
    assert.ok(geom.DIM_OPACITY.dark > geom.DIM_OPACITY.light);
    sameColor(colorOf(0), want(geom.dimColor(geom.statusColor("supported", "dark"), "dark")), "repainted for the dark stage");
    blocks.setTheme("light");
    assert.equal(dimmed.material.opacity, geom.DIM_OPACITY.light);
    blocks.dispose();
});

await test("the layer cut's outline stays on the model across a gap in the layers, and goes with the cut", () => {
    // The hand-built design occupies layers 0-5 and 7; layer 6 is empty.
    const blocks = createBlocksScene(blocksOptions());
    const group = blocks.scene.getObjectByName("blocks:blocks");
    const outline = group.children.find((o) => o.isLineSegments && o.renderOrder === 6);
    const fill = group.children.find((o) => o.isMesh && !o.isInstancedMesh && o.renderOrder === 5);
    const drawn = (mesh) => mesh.geometry.drawRange.count;
    assert.equal(drawn(outline), 0, "nothing is cut");
    // Cut at layer 6 (empty): the model ends at layer 5, whose top faces are the tower's and the arm's (6 cells).
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 6 });
    assert.equal(drawn(outline), 6 * 8, "4 segments of 2 vertices per cell");
    assert.equal(drawn(fill), 6 * 6);
    const z = [...outline.geometry.getAttribute("position").array.slice(0, 6 * 8 * 3)].filter((_, i) => i % 3 === 2);
    assert.ok(z.every((v) => v === 600), "on top of layer 5");
    // Cut at layer 4: the tower alone.
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 4 });
    assert.equal(drawn(outline), 8);
    assert.equal(outline.geometry.getAttribute("position").array[2], 500);
    // Cut at the top layer: not a cut.
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 7 });
    assert.equal(drawn(outline), 0);
    blocks.dispose();
});

await test("the viewer projects world points to stage pixels, reports frames, and eases the camera onto a box", async () => {
    const { dom, v, model, blocks } = blockStage();
    v.setScene(blocks);
    v.fitView();
    const target = new THREE.Vector3(...v.camera().target);
    const at = v.project(target.toArray());
    near(at.x, 200, 1, "the target is the middle of the 400 x 300 stage");
    near(at.y, 150, 1);
    assert.equal(at.visible, true);
    const behind = new THREE.Vector3(...v.camera().position).multiplyScalar(3).sub(target.clone().multiplyScalar(2));
    assert.equal(v.project(behind.toArray()).visible, false, "behind the camera");
    let frames = 0;
    const off = v.onFrame(() => (frames += 1));
    v.requestFrame();
    assert.equal(frames, 1);
    off();
    v.requestFrame();
    assert.equal(frames, 1, "unsubscribed");
    // A jump, and an eased flight that a view preset cancels.
    const box = blocks.boxOf(10);
    v.flyToBox(box, 0);
    const middle = v.project(box.getCenter(new THREE.Vector3()).toArray());
    assert.ok(Math.abs(middle.x - 200) < 25 && Math.abs(middle.y - 150) < 25, `the box is in the middle of the stage (${middle.x}, ${middle.y})`);
    v.setView("iso");
    v.flyToBox(blocks.boxOf(0), 400);
    const start = new THREE.Vector3(...v.camera().target);
    await dom.flush(); // the first frame fixes the start time...
    await new Promise((resolve) => setTimeout(resolve, 450));
    await dom.flush(); // ...a later one is past the end
    const arrived = v.project(blocks.boxOf(0).getCenter(new THREE.Vector3()).toArray());
    assert.ok(Math.abs(arrived.x - 200) < 25 && Math.abs(arrived.y - 150) < 25, "arrived: the block is in the middle");
    assert.ok(new THREE.Vector3(...v.camera().target).distanceTo(start) > 1, "and the camera moved to get there");
    v.flyToBox(blocks.boxOf(5), 400);
    v.setView("top"); // cancels the flight
    const preset = v.camera().position.map((x) => +x.toFixed(6));
    await dom.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dom.flush();
    assert.deepEqual(v.camera().position.map((x) => +x.toFixed(6)), preset, "the flight stopped");
    v.setScene(model);
    blocks.dispose();
    model.dispose();
    v.dispose();
});

await test("a thumbnail is of the model even while the blocks are on stage, and leaves the stage as it was", async () => {
    const { v, model, blocks } = blockStage();
    v.setScene(blocks);
    const before = v.camera();
    const blob = await v.snapshot({ width: 64, height: 48, scene: model });
    assert.ok(blob);
    assert.equal(v.scene(), blocks);
    assert.ok(blocks.scene.parent, "the blocks are back in the viewer");
    assert.equal(model.scene.parent, null, "and the model's scene is out again");
    assert.deepEqual(v.camera(), before, "the user's camera is untouched");
    v.setScene(model);
    blocks.dispose();
    model.dispose();
    v.dispose();
});

await test("blocks leave no geometry, material, program or buffer behind, however often the view changes or the scene is replaced", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const model = buildGlbScene(modelOf(2), { onChange: () => v.requestFrame() });
    v.setScene(model);
    v.setView("iso");
    v.requestFrame();
    const memory = () => ({ geometries: v.renderer.info.memory.geometries, textures: v.renderer.info.memory.textures, programs: v.renderer.info.programs.length });
    const baseline = memory();
    for (let round = 0; round < 4; round += 1) {
        const blocks = createBlocksScene(blocksOptions({ ghost: model.ghostSources(), onChange: () => v.requestFrame(), view: { ...DEFAULT_VIEW, showGhost: true } }));
        v.setScene(blocks);
        v.requestFrame();
        blocks.setView({ ...DEFAULT_VIEW, showGhost: true, highlight: [10, 11], layerMax: 5 });
        blocks.setView({ ...DEFAULT_VIEW, colorBy: "layer", showGhost: true, layerMax: 3 });
        blocks.setHover(2);
        blocks.setTheme("dark");
        v.requestFrame();
        if (round === 0) assert.ok(memory().geometries > baseline.geometries, "the harness sees the allocations");
        v.setScene(model);
        blocks.dispose();
        v.requestFrame();
        assert.deepEqual(memory(), baseline, `round ${round}`);
    }
    model.dispose();
    v.dispose();
});

// ---------- the block view's hook, on a stand-in for React's hooks ----------

console.log("useAnalysisView (hook runtime stub)");

// "react" resolves to a small hook runtime from here on, so the hook runs in Node without a DOM or a renderer.
const { register } = await import("node:module");
register("./react-shim-hooks.mjs", import.meta.url);
const { renderHook } = await import("./react-hook-shim.mjs");
const { useAnalysisView } = await viewer("useAnalysisView");

const BLOCKS_VIEW = { mode: "blocks", colorBy: "status", layerMax: 9, showGhost: false, showCog: true, highlight: [], focus: null };
const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/** The hook with a stand-in viewer (it records flights and frames) and the real label layer over a fake DOM. */
async function hookStage(overrides = {}) {
    const make = fakeDocument();
    const host = Object.assign(make("div"), { clientWidth: 1440, clientHeight: 900 });
    const analysis = makeAnalysis();
    const log = { flights: [], frames: 0, hovers: [], clicks: [], errors: [], fits: 0, refreshes: 0, sets: [] };
    const listeners = new Set();
    let onStage = null;
    let at = { x: 600, y: 400, visible: true };
    const viewer = {
        scene: () => onStage,
        setScene: (scene) => (log.sets.push(scene), (onStage = scene)),
        fitView: () => (log.fits += 1),
        refresh: () => (log.refreshes += 1),
        contextLost: () => false,
        flyToBox: (box, ms) => log.flights.push({ box, ms }),
        requestFrame: () => (log.frames += 1),
        project: () => at,
        onFrame: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    };
    const base = {
        viewerRef: { current: viewer },
        sceneRef: { current: { ghostSources: () => [] } },
        envRef: { current: null },
        labelsHostRef: { current: host },
        stageRef: { current: { style: {} } },
        ready: true,
        viewerEpoch: 1,
        modelEpoch: 1,
        url: "/m.glb",
        theme: "light",
        analysis,
        view: { ...BLOCKS_VIEW },
        onBlockHover: (i) => log.hovers.push(i),
        onBlockClick: (i) => log.clicks.push(i),
        ...overrides,
    };
    const hook = renderHook(useAnalysisView, base);
    const state = { hook, host, log, analysis, viewer, listeners, base, props: { ...base } };
    state.update = async (patch) => {
        state.props = { ...state.props, ...patch };
        hook.rerender(state.props);
        await wait();
    };
    state.view = (patch) => state.update({ view: { ...state.props.view, ...patch } });
    state.frame = () => listeners.forEach((fn) => fn());
    state.move = (next) => (at = next);
    state.callout = () => host.children.find((c) => c.dataset?.bubble !== undefined) ?? null;
    state.hoverLabel = () => host.children.find((c) => c.attrs?.role === "tooltip") ?? null;
    await wait();
    return state;
}

const FOCUS = { mm: [950, 450, 550], token: 1, label: "Cantilever too long: 5 blocks" };

await test("hook: the block scene is built when asked for, put on stage, and freed on unmount", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, mode: "model" } });
    const model = t.base.sceneRef.current;
    assert.equal(t.hook.result.active, false, "the model is asked for: no blocks yet");
    assert.equal(t.viewer.scene(), model, "the model is on stage");
    await t.view({ mode: "blocks" });
    assert.equal(t.hook.result.active, true);
    assert.equal(t.viewer.scene().analysis, t.analysis, "the blocks took its place");
    assert.equal(t.hook.result.buildFailed, false);
    const blocks = t.viewer.scene();
    t.hook.unmount();
    assert.equal(t.viewer.scene(), model, "the model is back on stage before the blocks are freed");
    assert.equal(blocks.scene.children.length, 0, "and the blocks are freed");
});

await test("hook: the callout is retired with the highlight it points at (cleared, or another issue lit) and the camera flew once", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, highlight: [10], focus: FOCUS } });
    assert.equal(t.log.flights.length, 1, "flown to the issue");
    assert.ok(t.callout(), "pointing at it");
    assert.ok(t.callout().children.some((c) => c.textContent === FOCUS.label), "with its title");
    // The selection is cleared but the pick is still handed over (a store that does not clear it): the pointer goes.
    await t.view({ highlight: [] });
    assert.equal(t.callout(), null, "no highlight, no pointer");
    // Another issue's block is clicked (the highlight changes, the focus stays): the pointer is not shown on it.
    await t.view({ highlight: [8, 9] });
    assert.equal(t.callout(), null, "the old title at the old point while another issue glows is a lie");
    assert.equal(t.log.flights.length, 1, "and the camera did not move for either");
    // Back to the highlight the pointer was made for: it points at it again.
    await t.view({ highlight: [10] });
    assert.ok(t.callout());
    // A new pick: flown to, and its own pointer.
    await t.view({ highlight: [8, 9], focus: { mm: [650, 450, 550], token: 2, label: "Floating part: 2 blocks" } });
    assert.equal(t.log.flights.length, 2);
    assert.ok(t.callout().children.some((c) => c.textContent === "Floating part: 2 blocks"));
    assert.equal(t.host.children.filter((c) => c.dataset?.bubble !== undefined).length, 1, "one callout at a time");
    // The pick is dropped by the store: nothing to point at.
    await t.view({ highlight: [], focus: null });
    assert.equal(t.callout(), null);
    t.hook.unmount();
});

await test("hook: a click on nothing (or Escape) lets go of the callout for good", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, highlight: [10], focus: FOCUS } });
    assert.ok(t.callout());
    t.hook.result.click(null);
    assert.equal(t.callout(), null, "gone at once, before the store has answered");
    assert.deepEqual(t.log.clicks, [null], "and the host is told");
    // The same pick shown again (re-render, a tab round trip) does not bring it back; only a new pick does.
    await t.update({});
    assert.equal(t.callout(), null);
    await t.view({ mode: "model" });
    await t.view({ mode: "blocks" });
    assert.equal(t.callout(), null);
    await t.view({ focus: { ...FOCUS, token: 2 } });
    assert.ok(t.callout(), "a new pick");
    t.hook.unmount();
});

await test("hook: the callout is taken down off the Analysis tab and is back on return, without flying again", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, highlight: [10], focus: FOCUS } });
    assert.ok(t.callout());
    assert.equal(t.log.flights.length, 1);
    await t.view({ mode: "model" });
    assert.equal(t.hook.result.active, false);
    assert.equal(t.callout(), null, "the model is on stage: no marker in it");
    await t.view({ mode: "blocks" });
    assert.equal(t.hook.result.active, true);
    assert.ok(t.callout(), "the highlight is back on, and so is its pointer");
    assert.equal(t.log.flights.length, 1, "the camera is where the user left it");
    t.hook.unmount();
});

await test("hook: when the layer cut hides the whole pick there is no flight and no marker in empty space; showing one brings the marker, not a flight", async () => {
    // Block 10 is on layer 5; the cut shows layers 0-2.
    const t = await hookStage({ view: { ...BLOCKS_VIEW, layerMax: 2, highlight: [10], focus: FOCUS } });
    assert.equal(t.log.flights.length, 0);
    assert.equal(t.callout(), null);
    await t.view({ layerMax: 9 });
    assert.ok(t.callout(), "the block is on screen: pointed at");
    assert.equal(t.log.flights.length, 0, "the user moved a slider; the camera stays");
    t.hook.unmount();
});

await test("hook: an issue without blocks of its own (thin features) still gets its callout", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, highlight: [], focus: { mm: [500, 500, 300], token: 7, label: "Thin parts left out" } } });
    assert.ok(t.callout());
    assert.equal(t.log.flights.length, 1);
    t.hook.unmount();
});

await test("hook: labels stay inside the free rect the stage hands over, flipping where there is no room", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, layerMax: 3 } });
    t.hook.result.setLabelInsets({ top: 122, right: 352, bottom: 56, left: 344 });
    const cut = () => t.host.children.find((c) => c.textContent.startsWith("Layers 1–4"));
    t.move({ x: 447, y: 500, visible: true });
    t.frame();
    assert.ok(cut(), "the cut label is on stage");
    // The label is 100 px wide in the fake DOM; to the left of the plate corner would be x 339: under the 344 px dock.
    assert.equal(cut().style.transform, "translate3d(455px, 490px, 0)", "to the right of the corner instead");
    // A hovered block's tooltip is clamped to the free part.
    t.move({ x: 340, y: 400, visible: true });
    assert.equal(t.hook.result.handleHover({ id: "10" }), true);
    t.frame();
    assert.equal(t.hoverLabel().style.transform, "translate3d(350px, 368px, 0)");
    // The same insets again are free; a new stage layout is applied at once.
    t.hook.result.setLabelInsets({ top: 122, right: 352, bottom: 56, left: 344 });
    t.hook.result.setLabelInsets({ top: 122, right: 352, bottom: 56, left: 0 });
    t.frame();
    assert.equal(t.hoverLabel().style.transform, "translate3d(290px, 368px, 0)", "centred on the anchor again");
    t.hook.unmount();
});

await test("hook: a block view that cannot be built says so, and clears when the analysis can be", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, mode: "model" } });
    const errors = [];
    const log = console.error;
    console.error = (...args) => errors.push(args);
    try {
        // A result the scene cannot be made from (what a lazy chunk that will not load looks like to the hook: the build rejects).
        await t.update({ view: { ...BLOCKS_VIEW }, analysis: { ...t.analysis, blocks: null } });
        assert.equal(t.hook.result.active, false, "the plain model stays on stage");
        assert.equal(t.hook.result.buildFailed, true, "and the stage can tell the user");
        assert.ok(errors.length >= 1, "and the cause is logged");
        await t.update({ analysis: makeAnalysis() });
        assert.equal(t.hook.result.buildFailed, false, "a result it can build: cleared");
        assert.equal(t.hook.result.active, true);
        await t.update({ analysis: { ...t.analysis, blocks: null } });
        assert.equal(t.hook.result.buildFailed, true);
        await t.view({ mode: "model" });
        assert.equal(t.hook.result.buildFailed, false, "not asked for any more: nothing failed");
    } finally {
        console.error = log;
    }
    t.hook.unmount();
});

// ---------- stress, roles, compare and loading an assembly (a stabilized model) ----------

console.log("stress colours, roles, compare (a stabilized model)");

const engine = (name) => import(`../../src/assignment/${name}.ts`);
const sharedAssembly = await engine("shared/assembly");
const sharedGlb = await engine("shared/assemblyGlb");
const sharedContract = await engine("shared/contract");
const assemblyEngine = await engine("analysis/assembly");
const stressEngine = await engine("analysis/stress");
const femEngine = await engine("analysis/fem/index");
const materialsEngine = await engine("analysis/materials");
const assemblyParts = await viewer("assemblyParts");

const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
/** A 6-block column with a 6-block arm on top: far past the joint limit. */
const ARM = [...range(6).map((k) => [0, 0, k]), ...range(6, 1).map((i) => [i, 0, 5])];
/** What a stabilizer adds under the arm's tip: a column (step 1) and a bracket (step 2). */
const ADDED = [...range(5).map((k) => ({ cell: [6, 0, k], role: "column", step: 1 })), { cell: [5, 0, 4], role: "bracket", step: 2 }];
const ORIGINAL_DESC = sharedAssembly.descriptorFromBlocks(ARM.map((cell) => ({ cell })));
const STABILIZED_DESC = sharedAssembly.descriptorFromBlocks([...ARM.map((cell) => ({ cell })), ...ADDED]);
const tsSolver = { solve: femEngine.solveFrameTs, backend: "ts" };
/** The real engine's result, stress included (the TypeScript solver, so no WASM is needed). */
const solved = (desc, frame = desc) => {
    const result = assemblyEngine.analyzeAssembly(desc, null, {}, frame);
    return stressEngine.applyStress(result, stressEngine.computeStress(result, tsSolver));
};
const ORIGINAL = solved(ORIGINAL_DESC);
const STABILIZED = solved(STABILIZED_DESC);
const ONLY_ORIGINAL = solved(assemblyEngine.originalOf(STABILIZED_DESC), STABILIZED_DESC);

await test("fixtures: the arm is overstressed, the stabilized model is not, and the original blocks on their own match the first", () => {
    assert.ok(ORIGINAL.stress.maxUtilisation > 1.4, "overstressed");
    assert.ok(STABILIZED.stress.maxUtilisation < geom.STRESS_WARN_SHARE, "stabilized");
    assert.equal(STABILIZED.blocks.length, ARM.length + ADDED.length);
    assert.deepEqual(STABILIZED.assembly.roleCounts, [12, 5, 0, 1, 0, 0, 0]);
    near(ONLY_ORIGINAL.stress.maxUtilisation, ORIGINAL.stress.maxUtilisation, 1e-6, "the original subset");
});

await test("the stress ramp: blue at 0, teal 35 %, amber 70 %, red at 100 %, dark red from 150 %; NaN is the floating purple", () => {
    assert.equal(geom.stressColor(0), "#3b82f6");
    assert.equal(geom.stressColor(0.35), "#14b8a6");
    assert.equal(geom.stressColor(0.7), "#f59e0b");
    assert.equal(geom.stressColor(1), "#ef4444");
    assert.equal(geom.stressColor(1.5), "#7f1d1d");
    assert.equal(geom.stressColor(2.4), "#7f1d1d", "beyond the end of the ramp");
    assert.equal(geom.stressColor(Infinity), "#7f1d1d");
    assert.equal(geom.stressColor(-0.2), "#3b82f6", "below zero is zero");
    assert.equal(geom.stressColor(Number.NaN), geom.statusColor("floating", "light"));
    assert.equal(geom.stressColor(Number.NaN, "dark"), geom.statusColor("floating", "dark"));
    assert.equal(geom.stressColor(Number.NaN), "#a855f7");
    // Between stops it blends the two neighbours, by where it sits between them.
    assert.equal(geom.stressColor(0.175), geom.mixHex("#3b82f6", "#14b8a6", 0.5));
    assert.equal(geom.stressColor(0.85), geom.mixHex("#f59e0b", "#ef4444", 0.5));
    assert.equal(geom.stressColor(1.25), geom.mixHex("#ef4444", "#7f1d1d", 0.5));
    // Hotter reads warmer: the hue only falls (blue, teal, amber, red) up to 100 %, and past it the colour darkens.
    const hue = (u) => {
        const [r, g, b] = geom.hexToRgb(geom.stressColor(u));
        const max = Math.max(r, g, b);
        const d = max - Math.min(r, g, b);
        const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return ((h * 60) + 360) % 360;
    };
    for (let u = 0; u < 1; u += 0.05) assert.ok(hue(u + 0.05) <= hue(u) + 1e-6, `hue at ${u}`);
    const light = (u) => geom.hexToRgb(geom.stressColor(u)).reduce((a, b) => a + b, 0);
    for (let u = 1; u < 1.5; u += 0.05) assert.ok(light(u + 0.05) <= light(u) + 1e-9, `darker past the limit at ${u}`);
});

await test("the legend bar and the blocks share one function: the bar's stops are stressColor at the ramp's own stops", () => {
    const stops = geom.stressGradientStops();
    assert.equal(stops.length, geom.STRESS_RAMP.length);
    stops.forEach((s, i) => {
        const [u] = geom.STRESS_RAMP[i];
        assert.equal(s.color, geom.stressColor(u));
        near(s.offset, u / geom.STRESS_RAMP_MAX, 1e-12);
    });
    assert.equal(stops[0].offset, 0);
    assert.equal(stops.at(-1).offset, 1);
    const css = geom.stressGradientCss();
    assert.ok(css.startsWith("linear-gradient(to right, #3b82f6 0%"), css);
    for (const s of stops) assert.ok(css.includes(s.color), s.color);
    assert.deepEqual(geom.STRESS_TICKS, [0, 0.25, 0.5, 0.75, 1], "ticks at 0, 25, 50, 75 and 100%+");
    assert.equal(geom.percentText(0.734), "73%");
});

await test("the thresholds and labels this file keeps are the engine's (it cannot import them: that pulls the FEM solver into the page)", () => {
    assert.equal(geom.STRESS_WARN_SHARE, materialsEngine.STRESS_WARN);
    assert.equal(geom.STRESS_FAIL_SHARE, materialsEngine.STRESS_FAIL);
    for (const id of sharedContract.MATERIAL_IDS) {
        assert.equal(geom.MATERIAL_LABELS[id], materialsEngine.materialOf(id).label);
    }
});

await test("block colours by stress: the utilisation of the block; no load path or no stress analysis at all is the floating purple", () => {
    const ctx = { theme: "light", limit: 4, layers: 6, stress: STABILIZED.stress.byBlock };
    for (const b of ORIGINAL.blocks) {
        const own = geom.blockColor(b, "stress", { ...ctx, stress: ORIGINAL.stress.byBlock });
        assert.equal(own, geom.stressColor(ORIGINAL.stress.byBlock[b.index]), `block ${b.index}`);
    }
    const hot = ORIGINAL.blocks[ORIGINAL.stress.maxBlock];
    assert.equal(geom.blockColor(hot, "stress", { ...ctx, stress: ORIGINAL.stress.byBlock }), geom.stressColor(ORIGINAL.stress.maxUtilisation), "the hottest block");
    const nan = [Number.NaN];
    assert.equal(geom.blockColor({ ...hot, index: 0 }, "stress", { ...ctx, stress: nan }), "#a855f7");
    assert.equal(geom.blockColor(hot, "stress", { theme: "light", limit: 4, layers: 6 }), "#a855f7", "no stress array");
    assert.equal(geom.blockColor(hot, "stress", { ...ctx, stress: [] }), "#a855f7", "a block the array does not cover");
});

await test("roles: original blocks are the theme's slate, each added role has one hue on both stages", () => {
    assert.equal(geom.roleColor("original", "light"), geom.statusColor("supported", "light"));
    assert.equal(geom.roleColor("original", "dark"), geom.statusColor("supported", "dark"));
    assert.notEqual(geom.roleColor("original", "light"), geom.roleColor("original", "dark"));
    const hues = { column: "#f59e0b", footing: "#8b5cf6", bracket: "#22c55e", bridge: "#06b6d4", reinforcement: "#ec4899", user: "#0ea5e9" };
    for (const [role, hex] of Object.entries(hues)) {
        assert.equal(geom.roleColor(role, "light"), hex, role);
        assert.equal(geom.roleColor(role, "dark"), hex, role);
        assert.equal(sharedAssembly.ROLE_HEX[role], hex, "the GLB's materials use the same hues");
    }
    const ctx = { theme: "dark", limit: 4, layers: 6 };
    for (const b of STABILIZED.blocks) assert.equal(geom.blockColor(b, "role", ctx), geom.roleColor(b.role, "dark"));
    assert.equal(geom.blockColor({ ...STABILIZED.blocks[0], role: undefined }, "role", ctx), geom.roleColor("original", "dark"), "a mesh's blocks have no role: original");
    assert.deepEqual(geom.countByRole(STABILIZED.blocks), { original: 12, column: 5, footing: 0, bracket: 1, bridge: 0, reinforcement: 0, user: 0 });
    assert.equal(geom.ROLE_LABELS.column, "Column");
    assert.equal(geom.ROLE_PLURALS.original, "Original blocks");
    assert.equal(geom.ROLE_LABELS.reinforcement, "Thicker joint");
    assert.equal(geom.ROLE_PLURALS.reinforcement, "Thicker joints");
    assert.equal(geom.ROLE_PLURALS.footing, "Footings");
    assert.equal(geom.ROLE_LABELS.user, "Your edit");
    assert.equal(geom.ROLE_PLURALS.user, "Your edits");
    // The legend, the parts list and the panel say the roles with one set of words; only the GLB's node names (the file keeps them) are older.
    assert.deepEqual(geom.ROLE_PLURALS, vocab.ROLE_WORDS, "the legend and the panel name the roles alike");
    assert.deepEqual(geom.STATUS_LABELS, vocab.STATUS_WORDS);
    assert.deepEqual(geom.COLOR_MODE_LABELS, vocab.COLOR_WORDS);
    assert.deepEqual(Object.values(sharedAssembly.ROLE_NODE_NAMES), ["Original blocks", "Columns", "Footing", "Brackets", "Bridges", "Reinforcement", "Your edits"], "the stored files keep their node names: renaming them would break reading a saved model");
});

await test("the colouring the stage uses: the view's, unless the result cannot do it; a preview is in role colours", () => {
    const plain = makeAnalysis(); // a voxelised mesh: no stress, no assembly
    const view = (colorBy) => ({ colorBy });
    assert.equal(geom.resolveColorBy(view("stress"), plain), "status", "no stress analysis");
    assert.equal(geom.resolveColorBy(view("role"), plain), "status", "no assembly");
    assert.equal(geom.resolveColorBy(view("reach"), plain), "reach");
    assert.equal(geom.resolveColorBy(view("stress"), STABILIZED), "stress");
    assert.equal(geom.resolveColorBy(view("role"), STABILIZED), "role");
    assert.equal(geom.resolveColorBy(view("status"), STABILIZED), "status", "the version on stage does not touch the colouring");
    assert.equal(geom.resolveColorBy(view("stress"), STABILIZED, true), "role", "a preview of the stabilizer");
    assert.equal(geom.resolveColorBy(view("stress"), plain, true), "status", "a preview means nothing for a mesh");
    assert.equal(geom.resolveColorBy(view("stress"), null), "status");
    assert.equal(geom.resolveColorBy({ colorBy: "layer" }, STABILIZED), "layer");
});

await test("the stress tooltip: the share used and what the joint is going through, in words; the peak of a point has the solver's own mode", () => {
    // A hand-made stress: block 0 is a point's peak (73 %, 146 of 200 kPa); block 1 is 50 %; block 2 has no load path.
    const stress = {
        material: "concrete",
        byBlock: Float32Array.from([0.73, 0.5, Number.NaN]),
        points: [{ rank: 1, blocks: [0], cell: [0, 0, 0], centreMm: [50, 50, 50], utilisation: 0.73, mode: "tension", tensionKPa: 146, allowableKPa: 200, joint: null }],
    };
    assert.equal(geom.describeStress({ stress }, 0).text, "Strength used 73% (being pulled apart)");
    assert.equal(geom.describeStress({ stress }, 1).text, "Strength used 50% (being pulled apart)", "another block: its share, read as tension");
    assert.equal(geom.describeStress({ stress: { ...stress, material: "timber" } }, 1).text, "Strength used 50% (being pulled apart)", "no kPa: the share says it for either material");
    assert.deepEqual(geom.describeStress({ stress }, 2), { utilisation: null, text: "Not carrying weight (not connected to the ground)" });
    assert.equal(geom.describeStress({ stress }, 9), null, "a block the stress does not cover");
    assert.equal(geom.describeStress({ stress: null }, 0), null, "no stress analysis: nothing to say");
    const shear = { ...stress, points: [{ ...stress.points[0], mode: "shear" }] };
    assert.equal(geom.describeStress({ stress: shear }, 0).text, "Strength used 73% (being sheared)");
    const crush = { ...stress, points: [{ ...stress.points[0], mode: "compression" }] };
    assert.equal(geom.describeStress({ stress: crush }, 0).text, "Strength used 73% (being crushed)");
    // On the real result: the text carries the real peak.
    const peak = ORIGINAL.stress.points[0];
    const real = geom.describeStress(ORIGINAL, peak.blocks[0]);
    assert.equal(real.text, `Strength used ${Math.round(peak.utilisation * 100)}% (${{ tension: "being pulled apart", compression: "being crushed", shear: "being sheared" }[peak.mode]})`);
    assert.deepEqual(vocab.technicalWordsIn(real.text), [], real.text);
    assert.doesNotMatch(real.text, /kPa|\d+ of \d+/);
});

await test("the block tooltip text says what was added and, when there is a stress analysis, the stress", () => {
    const column = STABILIZED.blocks.find((b) => b.role === "column");
    const plainText = geom.describeBlock(column, STABILIZED.settings);
    assert.equal(plainText.added, `Column, added in step 1`);
    assert.ok(plainText.text.endsWith("Column, added in step 1"));
    assert.equal(plainText.stress, undefined);
    const withStress = geom.describeBlock(column, STABILIZED.settings, geom.describeStress(STABILIZED, column.index));
    assert.match(withStress.text, / · Column, added in step 1 · Strength used \d+% \(being (pulled apart|crushed|sheared)\)$/);
    const original = STABILIZED.blocks.find((b) => b.role === "original");
    assert.equal(geom.describeBlock(original, STABILIZED.settings).added, undefined, "an original block was not added");
    // A mesh's block: exactly the old wording.
    const old = makeAnalysis();
    assert.equal(geom.describeBlock(old.blocks[0], old.settings).text, "Block, 0–100 mm up · Supported · rests on the ground");
});

await test("the tooltip element shows the lines (fake DOM)", () => {
    fakeDocument();
    const column = STABILIZED.blocks.find((b) => b.role === "column");
    const info = geom.describeBlock(column, STABILIZED.settings, geom.describeStress(STABILIZED, column.index));
    const el = labelsModule.blockTooltip(info, "#f59e0b");
    const text = el.textContent;
    assert.ok(text.includes(info.added), text);
    assert.ok(text.includes(info.stress.text), text);
    const none = labelsModule.blockTooltip(geom.describeBlock(makeAnalysis().blocks[0], makeAnalysis().settings), "#94a3b8");
    assert.ok(!none.textContent.includes("Stress") && !none.textContent.includes("added"));
});

await test("stress pins: the top three points get '1 · 148%' on their peak block, only in the stress colouring, and not above the layer cut", () => {
    const base = { showCog: false, layerMax: 9 };
    assert.deepEqual(geom.sceneLabels(ORIGINAL, { ...base, colorBy: "status" }).filter((l) => l.kind === "stress"), [], "only when colouring by stress");
    assert.deepEqual(geom.sceneLabels(ORIGINAL, base).filter((l) => l.kind === "stress"), [], "a view without a colouring: none");
    const pins = geom.sceneLabels(ORIGINAL, { ...base, colorBy: "stress" }).filter((l) => l.kind === "stress");
    assert.equal(pins.length, geom.STRESS_PINS);
    assert.equal(geom.STRESS_PINS, 3);
    const points = ORIGINAL.stress.points;
    pins.forEach((pin, n) => {
        const point = points[n];
        const peak = ORIGINAL.blocks[point.blocks[0]];
        assert.equal(pin.id, `stress-${point.rank}`);
        assert.equal(pin.text, `${point.rank} · ${Math.round(point.utilisation * 100)}%`);
        assert.deepEqual(pin.anchor, [peak.centerMm[0], peak.centerMm[1], peak.centerMm[2] + 50], "on top of its block");
        assert.equal(pin.color, geom.stressColor(point.utilisation));
    });
    assert.equal(pins[0].tone, "bad", "over the limit");
    assert.equal(pins[1].tone, "accent", "under it");
    // The layer cut hides the pins of blocks it cuts away.
    const lowest = Math.min(...pins.map((p) => ORIGINAL.blocks[points[Number(p.id.slice(7)) - 1].blocks[0]].cell[2]));
    const cut = geom.sceneLabels(ORIGINAL, { ...base, layerMax: lowest - 1, colorBy: "stress" }).filter((l) => l.kind === "stress");
    assert.ok(cut.length < pins.length);
    assert.deepEqual(geom.sceneLabels(STABILIZED, { ...base, colorBy: "stress" }).filter((l) => l.kind === "stress").map((l) => l.text.split(" · ")[0]), ["1", "2", "3"]);
    assert.deepEqual(geom.sceneLabels({ ...ORIGINAL, stress: null }, { ...base, colorBy: "stress" }).filter((l) => l.kind === "stress"), [], "no stress analysis: no pins");
    // The pin is drawn as a pill with the point's colour (fake DOM).
    fakeDocument();
    const el = labelsModule.sceneLabelElement(pins[0]);
    assert.equal(el.textContent, pins[0].text);
    assert.equal(el.children[0].style.background, pins[0].color);
});

await test("the block scene paints by stress and by role from the same functions as the legend, and follows the theme", () => {
    const stress = createBlocksScene({ analysis: ORIGINAL, view: { ...DEFAULT_VIEW, colorBy: "stress" }, theme: "light" });
    ORIGINAL.blocks.forEach((b) => assert.equal(stress.colorOf(b.index), geom.stressColor(ORIGINAL.stress.byBlock[b.index]), `block ${b.index}`));
    const active = stress.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.renderOrder === 0);
    const first = new THREE.Color(geom.stressColor(ORIGINAL.stress.byBlock[0]));
    near(active.instanceColor.array[0], first.r, 1e-6);
    near(active.instanceColor.array[1], first.g, 1e-6);
    // Pins reach the viewer through the scene's own labels, with world anchors, and only while colouring by stress.
    assert.equal(stress.labels().filter((l) => l.kind === "stress").length, 3);
    stress.setView({ ...DEFAULT_VIEW, colorBy: "status" });
    assert.equal(stress.labels().filter((l) => l.kind === "stress").length, 0, "the label cache follows the colouring");
    // Tooltips of the scene carry the stress.
    stress.setView({ ...DEFAULT_VIEW, colorBy: "stress" });
    assert.match(stress.info(ORIGINAL.stress.maxBlock).text, /Strength used 148% \(being pulled apart\)/);
    stress.dispose();

    const role = createBlocksScene({ analysis: STABILIZED, view: { ...DEFAULT_VIEW, colorBy: "role" }, theme: "light" });
    STABILIZED.blocks.forEach((b) => assert.equal(role.colorOf(b.index), geom.roleColor(b.role, "light")));
    const original = STABILIZED.blocks.findIndex((b) => b.role === "original");
    const column = STABILIZED.blocks.findIndex((b) => b.role === "column");
    role.setTheme("dark");
    assert.equal(role.colorOf(original), geom.statusColor("supported", "dark"), "the slate follows the theme");
    assert.equal(role.colorOf(column), "#f59e0b", "an added role does not");
    role.dispose();
});

await test("appearedBlocks: the cells of the new result that held no block before", () => {
    const before = [{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }];
    const after = [{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1] }, { cell: [1, 0, 0] }];
    assert.deepEqual(geom.appearedBlocks(before, after), [2, 3]);
    assert.deepEqual(geom.appearedBlocks(before, before), []);
    assert.deepEqual(geom.appearedBlocks([], after), [], "nothing before: nothing 'appears'");
    const step1 = solved(sharedAssembly.descriptorFromBlocks([...ARM.map((cell) => ({ cell })), ...ADDED.slice(0, 5)]), STABILIZED_DESC);
    const stepAdded = geom.appearedBlocks(ORIGINAL.blocks, step1.blocks);
    assert.deepEqual(stepAdded.map((i) => step1.blocks[i].role), ["column", "column", "column", "column", "column"]);
});

await test("fresh blocks flash once and then settle; reduced motion, a layer cut and a disposed scene keep them off", () => {
    const fresh = [ORIGINAL.blocks.length - 1, 0];
    const frames = [];
    const blocks = createBlocksScene({ analysis: ORIGINAL, view: DEFAULT_VIEW, theme: "light", fresh, onChange: () => frames.push(1) });
    const flashRing = () => blocks.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.material.side === THREE.BackSide && o.renderOrder === -2 && o.material.color.getHexString() === "ce5222");
    assert.equal(blocks.flashing(), true, "the host must run frames");
    assert.equal(flashRing().count, 2);
    assert.equal(blocks.animate(1000), true);
    const start = flashRing().material.opacity;
    assert.ok(start > 0.9, "starts bright");
    blocks.animate(1600);
    const mid = flashRing().material.opacity;
    assert.ok(mid < start && mid > 0, "fades");
    assert.equal(blocks.animate(1000 + 5000), false, "over");
    assert.equal(flashRing().count, 0);
    assert.equal(flashRing().material.opacity, 0);
    assert.equal(blocks.flashing(), false);
    blocks.setView({ ...DEFAULT_VIEW, layerMax: 3 });
    assert.equal(flashRing().count, 0, "does not come back with the cut");
    blocks.dispose();

    const still = createBlocksScene({ analysis: ORIGINAL, view: DEFAULT_VIEW, theme: "light", fresh, reducedMotion: true });
    assert.equal(still.flashing(), false);
    still.animate(0);
    assert.equal(still.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.filter((o) => o.isInstancedMesh && o.count > 0 && o.renderOrder === -2).length, 0, "no ring at all");
    still.dispose();

    // The layer cut hides the flash of a block it cuts away; indices that are not blocks are ignored.
    const cut = createBlocksScene({ analysis: ORIGINAL, view: { ...DEFAULT_VIEW, layerMax: 2 }, theme: "light", fresh: [0, ORIGINAL.blocks.length - 1, 999, -1, 1.5] });
    const ring = cut.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.renderOrder === -2 && o.material.color.getHexString() === "ce5222");
    assert.equal(ring.count, 1, "block 0 is on layer 0; the last block is in the arm, above the cut");
    cut.dispose();
    const none = createBlocksScene({ analysis: ORIGINAL, view: DEFAULT_VIEW, theme: "light" });
    assert.equal(none.flashing(), false, "nothing fresh: nothing flashes");
    none.dispose();
});

await test("a scene with stress colours, role colours and a flashing ring leaves nothing behind on the GPU", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const model = buildGlbScene(modelOf(2), { onChange: () => v.requestFrame() });
    v.setScene(model);
    v.setView("iso");
    v.requestFrame();
    const memory = () => ({ geometries: v.renderer.info.memory.geometries, textures: v.renderer.info.memory.textures, programs: v.renderer.info.programs.length });
    const baseline = memory();
    for (let round = 0; round < 3; round += 1) {
        const blocks = createBlocksScene({ analysis: STABILIZED, view: { ...DEFAULT_VIEW, colorBy: "stress" }, theme: "light", fresh: [12, 13, 14], onChange: () => v.requestFrame() });
        v.setScene(blocks);
        v.requestFrame();
        blocks.animate(100);
        blocks.setView({ ...DEFAULT_VIEW, colorBy: "role" });
        blocks.setView({ ...DEFAULT_VIEW, colorBy: "stress", layerMax: 3 });
        blocks.animate(2000);
        v.requestFrame();
        if (round === 0) assert.ok(memory().geometries > baseline.geometries, "the harness sees the allocations");
        v.setScene(model);
        blocks.dispose();
        v.requestFrame();
        assert.deepEqual(memory(), baseline, `round ${round}`);
        assert.equal(blocks.flashing(), false);
    }
    model.dispose();
    v.dispose();
});

// ---------- loading an assembly ----------

await test("assemblyOf reads the descriptor GLTFLoader leaves on scene.userData; anything else reads as a plain mesh", () => {
    const { assemblyOf } = loadGlbModule;
    const read = assemblyOf({ userData: { "nevo:assembly": STABILIZED_DESC } });
    assert.deepEqual(read, STABILIZED_DESC);
    assert.equal(assemblyOf({ userData: {} }), null, "no extras");
    assert.equal(assemblyOf({ userData: undefined }), null);
    assert.equal(assemblyOf({ userData: { "nevo:assembly": "nope" } }), null);
    assert.equal(assemblyOf({ userData: { "nevo:assembly": { ...STABILIZED_DESC, version: 2 } } }), null, "another version");
    assert.equal(assemblyOf({ userData: { "nevo:assembly": { ...STABILIZED_DESC, cells: STABILIZED_DESC.cells.slice(0, 7) } } }), null, "a truncated list");
    const shuffled = [...STABILIZED_DESC.cells];
    shuffled.splice(0, 5, ...STABILIZED_DESC.cells.slice(-5));
    assert.equal(assemblyOf({ userData: { "nevo:assembly": { ...STABILIZED_DESC, cells: shuffled } } }), null, "not in canonical order");
    assert.equal(assemblyOf({ userData: { "nevo:assembly": { ...STABILIZED_DESC, cells: STABILIZED_DESC.cells.map((c, n) => (n === 3 ? 99 : c)) } } }), null, "a role that does not exist");
});

const assemblyBytes = (desc) => sharedGlb.writeAssemblyGlb(desc);
const responseOf = (bytes) => new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } });

await test("loadGlb of a stabilized model's GLB returns its assembly; a plain mesh's GLB returns none", async () => {
    const loaded = await withFetch(responseOf(assemblyBytes(STABILIZED_DESC)), () => loadGlbModule.loadGlb("/a.glb"));
    assert.deepEqual(loaded.assembly, STABILIZED_DESC, "lossless through the writer, the container and GLTFLoader");
    assert.equal(loaded.scene.userData["nevo:assembly"].cells.length, STABILIZED_DESC.cells.length);
    const plain = await withFetch(responseOf(await makeGlb()), () => loadGlbModule.loadGlb("/m.glb"));
    assert.equal(plain.assembly, null);
    disposeObject(plain.scene);
    disposeObject(loaded.scene);
});

await test("a model handle carries the assembly (null for a mesh), and a retired handle still refuses", () => {
    const soup = new Float32Array(9);
    const mesh = createModelHandle("/m.glb", () => soup);
    assert.equal(mesh.model.assembly, null);
    const stabilized = createModelHandle("/a.glb", () => soup, STABILIZED_DESC);
    assert.equal(stabilized.model.assembly, STABILIZED_DESC);
    assert.equal(stabilized.model.url, "/a.glb");
    assert.equal(stabilized.retire(), true);
    assert.throws(() => stabilized.model.extractTriangles(), /no longer shown/);
    assert.equal(stabilized.model.assembly, STABILIZED_DESC, "what the model is does not change when it leaves the stage");
});

await test("an assembly's GLB shows as its roles in the parts list (names, colours, block counts), and Explode works", async () => {
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loaded = await new GLTFLoader().parseAsync(toBuffer(assemblyBytes(STABILIZED_DESC)), "");
    tagMeshGroups(loaded.scene, loaded.parser.associations);
    const parts = extractParts(loaded.scene);
    assert.deepEqual(
        parts.map((p) => p.name),
        ["Original blocks", "Columns", "Brackets"],
        "one part per role present, named like the legend says",
    );
    assert.deepEqual(parts.map((p) => countTriangles(p.object)), [12 * 12, 5 * 12, 1 * 12], "12 triangles per cube");
    const scene = buildGlbScene(loaded.scene);
    assert.equal(scene.rows.length, 3);
    const rows = assemblyParts.decorateAssemblyRows(scene.rows, STABILIZED_DESC);
    assert.deepEqual(rows.map((r) => [r.name, r.detail, r.swatch]), [["Original blocks", "12 blocks", "#64748b"], ["Columns", "5 blocks", "#f59e0b"], ["Brackets", "1 block", "#22c55e"]]);
    assert.equal(rows[0].triangles, scene.rows[0].triangles, "the rest of the row is untouched");
    assert.equal(assemblyParts.decorateAssemblyRows(scene.rows, null), scene.rows, "a mesh's rows are returned as they are");
    assert.equal(assemblyParts.decorateAssemblyRows([{ id: "p1", name: "Gear", triangles: 4, size: null }], STABILIZED_DESC)[0].detail, undefined, "a part that is no role stays");
    // The file's node names for two of the roles are older words; the list says them as the panel and the legend do.
    assert.deepEqual(
        assemblyParts.decorateAssemblyRows([{ id: "p8", name: "Footing", triangles: 12, size: null }, { id: "p9", name: "Reinforcement", triangles: 12, size: null }], STABILIZED_DESC).map((r) => [r.id, r.name]),
        [["p8", "Footings"], ["p9", "Thicker joints"]],
        "the pick ids are the rows' identity; only the shown name changes",
    );
    assert.deepEqual(assemblyParts.assemblyCounts(STABILIZED_DESC), { original: 12, added: 6, edited: 0 });
    assert.deepEqual(assemblyParts.assemblyCounts(ORIGINAL_DESC), { original: 12, added: 0, edited: 0 });
    assert.equal(assemblyParts.roleOfPart("Columns"), "column");
    assert.equal(assemblyParts.roleOfPart("Gear"), undefined);
    // The blocks of a person's own edit are counted on their own: they were not added by a stabilizer step.
    const edited = sharedAssembly.descriptorFromBlocks([...Array.from({ length: 4 }, (_, k) => ({ cell: [0, 0, k] })), { cell: [1, 0, 0], role: "column", step: 1 }, { cell: [2, 0, 0], role: "user", step: 2 }, { cell: [3, 0, 0], role: "user", step: 2 }]);
    assert.deepEqual(assemblyParts.assemblyCounts(edited), { original: 4, added: 1, edited: 2 });
    assert.equal(assemblyParts.assemblyNote({ added: 1, edited: 2 }), " (1 added, 2 from your edits)");
    assert.equal(assemblyParts.assemblyNote({ added: 0, edited: 2 }), " (2 from your edits)");
    assert.equal(assemblyParts.assemblyNote({ added: 0, edited: 0 }), "");

    // Explode moves the roles apart and back without leaving anything behind; the triangles (what the analysis reads) are the same.
    const soup0 = scene.extractTriangles();
    assert.equal(soup0.length, 18 * 12 * 9);
    const centreOf = (id) => new THREE.Box3().setFromObject(scene.parts.get(id)).getCenter(new THREE.Vector3());
    const rest = parts.map((p) => centreOf(p.id).toArray());
    scene.setExplode(100);
    const apart = parts.map((p) => centreOf(p.id).toArray());
    assert.ok(apart.some((c, i) => c.some((v, a) => Math.abs(v - rest[i][a]) > 1e-6)), "the roles moved");
    assert.deepEqual(Array.from(scene.extractTriangles()), Array.from(soup0), "the analysis never sees the explode offsets");
    scene.setExplode(0);
    parts.forEach((p, i) => centreOf(p.id).toArray().forEach((v, a) => near(v, rest[i][a], 1e-6)));
    // Split would turn each cube into a piece and lose the roles; the viewer does not offer it for an assembly, but it must not break.
    const summary = await scene.split();
    assert.equal(typeof summary.pieces, "number");
    scene.unsplit();
    assert.deepEqual(scene.rows.map((r) => r.name), ["Original blocks", "Columns", "Brackets"], "joined again: the roles are back");
    scene.dispose();
});

// ---------- the hook: compare, preview, pins ----------

await test("hook: switching the version on stage (a new result) and the colouring swaps the scene in place; the camera is not touched", async () => {
    const t = await hookStage({ analysis: STABILIZED, view: { ...BLOCKS_VIEW, colorBy: "stress" } });
    const first = t.viewer.scene();
    assert.ok(first?.analysis === STABILIZED, "the stabilized result is on stage");
    assert.equal(t.log.fits, 1, "the first look at this model's blocks frames the volume once");
    const camera = { fits: t.log.fits, refreshes: t.log.refreshes, flights: t.log.flights.length };
    // The original version: the workspace hands over the original blocks' result.
    await t.update({ analysis: ONLY_ORIGINAL });
    const second = t.viewer.scene();
    assert.notEqual(second, first, "a new scene");
    assert.ok(second.analysis === ONLY_ORIGINAL);
    assert.equal(t.log.sets.at(-1), second, "put on stage by the swap");
    assert.equal(t.log.fits, camera.fits, "no re-framing");
    assert.equal(t.log.refreshes, camera.refreshes, "no re-fit of the camera");
    assert.equal(t.log.flights.length, camera.flights, "no flight");
    ONLY_ORIGINAL.blocks.forEach((b) => assert.equal(second.colorOf(b.index), geom.stressColor(ONLY_ORIGINAL.stress.byBlock[b.index]), "the colouring chosen survives a switch of version"));
    // Back to the stabilized model, then "Added blocks" from the Colour menu: what was added in its role colours, no pins.
    await t.update({ analysis: STABILIZED });
    await t.view({ colorBy: "role" });
    const added = t.viewer.scene();
    assert.ok(added.analysis === STABILIZED);
    STABILIZED.blocks.forEach((b) => assert.equal(added.colorOf(b.index), geom.roleColor(b.role, "light"), `block ${b.index}`));
    assert.equal(added.labels().filter((l) => l.kind === "stress").length, 0, "no pins in role colours");
    // Strength again: the colours and the pins return, on the same scene (nothing to rebuild for a colouring).
    await t.view({ colorBy: "stress" });
    const back = t.viewer.scene();
    assert.equal(back, added, "the same scene recoloured");
    STABILIZED.blocks.forEach((b) => assert.equal(back.colorOf(b.index), geom.stressColor(STABILIZED.stress.byBlock[b.index])));
    assert.equal(back.labels().filter((l) => l.kind === "stress").length, 3);
    assert.equal(t.log.fits, camera.fits);
    assert.equal(t.log.refreshes, camera.refreshes);
    assert.equal(t.log.flights.length, camera.flights);
    t.hook.unmount();
});

await test("hook: stress pins are HTML labels on the stage while colouring by stress, and go with the colouring", async () => {
    const t = await hookStage({ analysis: ORIGINAL, view: { ...BLOCKS_VIEW, colorBy: "stress" } });
    const pins = () => t.host.children.filter((c) => /^\d · \d+%$/.test(c.textContent));
    const want = ORIGINAL.stress.points.slice(0, 3).map((p) => `${p.rank} · ${Math.round(p.utilisation * 100)}%`);
    assert.deepEqual(pins().map((c) => c.textContent).sort(), want.sort());
    await t.view({ colorBy: "status" });
    assert.equal(pins().length, 0);
    await t.view({ colorBy: "stress" });
    assert.equal(pins().length, 3);
    await t.view({ layerMax: 0 });
    assert.ok(pins().length < 3, "the pins of cut-away blocks go");
    // A result with no stress analysis (a mesh, or the estimate failed) is coloured by status, and has no pins.
    await t.update({ analysis: { ...ORIGINAL, stress: null }, view: { ...t.props.view, layerMax: 9 } });
    assert.equal(pins().length, 0);
    assert.equal(t.viewer.scene().colorOf(0), geom.statusColor(ORIGINAL.blocks[0].status, "light"));
    t.hook.unmount();
});

await test("hook: a preview of the stabilizer is drawn in role colours and the blocks each step adds flash once", async () => {
    const step1 = solved(sharedAssembly.descriptorFromBlocks([...ARM.map((cell) => ({ cell })), ...ADDED.slice(0, 5)]), STABILIZED_DESC);
    const t = await hookStage({ analysis: ORIGINAL, view: { ...BLOCKS_VIEW, colorBy: "stress" } });
    // The original result's block scene is on stage (stress colours; the arm has no roles but the assembly's: all original).
    assert.ok(t.viewer.scene().analysis === ORIGINAL);
    assert.equal(t.viewer.scene().flashing(), false);
    const fitsBefore = t.log.fits;
    await t.update({ analysis: step1, previewing: true });
    const preview = t.viewer.scene();
    assert.ok(preview.analysis === step1);
    step1.blocks.forEach((b) => assert.equal(preview.colorOf(b.index), geom.roleColor(b.role, "light")));
    assert.equal(preview.flashing(), true, "the five new column blocks flash");
    const ring = preview.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.renderOrder === -2 && o.material.color.getHexString() === "ce5222");
    assert.equal(ring.count, 5);
    assert.equal(t.log.fits, fitsBefore, "the preview does not move the camera");
    // The next step: only what it adds flashes, against the step before.
    const step2 = solved(STABILIZED_DESC, STABILIZED_DESC);
    await t.update({ analysis: step2 });
    const next = t.viewer.scene();
    assert.equal(next.scene.getObjectByName("blocks:root").getObjectByName("blocks:blocks").children.find((o) => o.isInstancedMesh && o.renderOrder === -2 && o.material.color.getHexString() === "ce5222").count, 1, "the bracket");
    // The preview ends and the saved model's result takes its place: no flash for a result that is not a preview.
    await t.update({ analysis: STABILIZED, previewing: false });
    assert.equal(t.viewer.scene().flashing(), false);
    assert.equal(t.viewer.scene().colorOf(0), geom.stressColor(STABILIZED.stress.byBlock[0]), "back to the asked-for colouring");
    t.hook.unmount();
});

await test("hook: a mesh's block view is unchanged by all of this (status colours, no pins, no flash)", async () => {
    const t = await hookStage({ view: { ...BLOCKS_VIEW, colorBy: "role" } });
    const scene = t.viewer.scene();
    assert.equal(scene.colorOf(0), geom.statusColor("supported", "light"), "added blocks mean nothing for a mesh");
    assert.equal(scene.flashing(), false);
    assert.equal(scene.labels().some((l) => l.kind === "stress"), false);
    t.hook.unmount();
});

// ---------- findings: labels, step numbering, ghost, chip text ----------

console.log("steps, ghost, labels (review findings)");

await test("the stage's name and the download name tell a stabilized version from its source (V4)", () => {
    const { stageLabel, downloadStem } = viewerFormat;
    assert.equal(stageLabel("A desk lamp"), "3D model of A desk lamp");
    assert.equal(stageLabel("A desk lamp", true), "3D model of A desk lamp (stabilized)");
    assert.equal(stageLabel("Stabilized · A desk lamp", true), "3D model of Stabilized · A desk lamp", "a title that says so already");
    assert.equal(stageLabel(undefined), "3D model");
    assert.equal(stageLabel(undefined, true), "3D model (stabilized)");
    assert.equal(downloadStem("A desk lamp"), "A desk lamp");
    assert.equal(downloadStem("A desk lamp", true), "A desk lamp-stabilized");
    assert.notEqual(downloadStem("A desk lamp"), downloadStem("A desk lamp", true), "two files, two names");
    assert.equal(downloadStem("Stabilized · A desk lamp", true), "Stabilized · A desk lamp");
    assert.equal(downloadStem(undefined, true), "model-stabilized");
    assert.equal(downloadStem("a/b:c", true), "a b c-stabilized", "still a safe file name");
});

await test("a part's line is the same in the list and the hover tooltip: a role says blocks, a mesh part says triangles (V5)", () => {
    const { partDetail } = viewerFormat;
    assert.equal(partDetail({ triangles: 108, detail: "9 blocks" }), "9 blocks");
    assert.equal(partDetail({ triangles: 1234 }), "1,234 triangles");
    // The rows the tooltip is looked up in are the decorated ones.
    const rows = assemblyParts.decorateAssemblyRows([{ id: "p2", name: "Columns", triangles: 60, size: null }], STABILIZED_DESC);
    assert.equal(partDetail(rows[0]), "5 blocks");
});

await test("steps: a first run is numbered as logged; a re-stabilized model's tooltips count its own run from 1, earlier blocks say so (V3)", () => {
    assert.equal(geom.addedWhen(2), "in step 2");
    assert.equal(geom.addedWhen(2, 0), "in step 2");
    assert.equal(geom.addedWhen(9, 6), "in step 3");
    assert.equal(geom.addedWhen(6, 6), "in an earlier version");
    assert.equal(geom.addedWhen(2, 6), "in an earlier version");
    assert.equal(geom.addedWhen(undefined, 6), "in step 1", "no step recorded: the first of the run");
    const column = STABILIZED.blocks.find((b) => b.role === "column"); // step 1
    const bracket = STABILIZED.blocks.find((b) => b.role === "bracket"); // step 2
    assert.equal(geom.describeBlock(column, STABILIZED.settings).added, "Column, added in step 1");
    assert.equal(geom.describeBlock(bracket, STABILIZED.settings, null, 0).added, "Bracket, added in step 2");
    // The same blocks in a model whose own run started after step 1: the column is from before, the bracket is its step 1.
    assert.equal(geom.describeBlock(column, STABILIZED.settings, null, 1).added, "Column, added in an earlier version");
    assert.equal(geom.describeBlock(bracket, STABILIZED.settings, null, 1).added, "Bracket, added in step 1");
    assert.ok(geom.describeBlock(bracket, STABILIZED.settings, null, 1).text.endsWith("Bracket, added in step 1"));
    const original = STABILIZED.blocks.find((b) => b.role === "original");
    assert.equal(geom.describeBlock(original, STABILIZED.settings, null, 5).added, undefined, "an original block was never added");
});

// The second run on top of STABILIZED_DESC (steps 1-2): a footing at step 3 and a column at step 4. Its log lists two steps, from 1.
const RE_DESC = sharedAssembly.descriptorFromBlocks([...ARM.map((cell) => ({ cell })), ...ADDED, { cell: [7, 0, 0], role: "footing", step: 3 }, { cell: [8, 0, 0], role: "column", step: 4 }]);
const logMetrics = (blocks, bad) => ({ blocks, errors: bad ? 1 : 0, warnings: 0, floating_blocks: 0, over_limit: bad ? 3 : 0, longest_cantilever: bad ? 7 : 3, cog_margin_mm: 17, max_utilisation: bad ? 1.98 : 0.21, overstressed_blocks: bad ? 3 : 0 });
const logStep = (m) => ({ blocks: m.blocks, errors: m.errors, floating_blocks: m.floating_blocks, over_limit: m.over_limit, longest_cantilever: m.longest_cantilever, cog_margin_mm: m.cog_margin_mm, max_utilisation: m.max_utilisation });
const reMeta = async () => {
    const before = logMetrics(18, true);
    const after = logMetrics(20, false);
    const summary = { version: 1, blocks: 20, bodies: 1, floating_blocks: 0, cantilevered: 0, longest_cantilever: 0, over_limit: 0, cantilever_limit: 4, cog_mm: [150, 150, 100], cog_inside: true, cog_margin_mm: 50, size_mm: [300, 300, 300], coverage: 1, fill_threshold: 0.1, errors: 0, warnings: 0, stress: { material: "concrete", max_utilisation: 0.21, max_at: [1, 1, 0], stressed_blocks: 0, overstressed_blocks: 0, analysed_blocks: 20, unsupported_blocks: 0 }, analyzed_at: "2026-10-24T10:00:00.000Z" };
    return {
        version: 1, depth: 2, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.6, cantilever_limit: 4, fill_threshold: 0.1, complete: true, stop: "stable", added_blocks: 2, added_by_role: { footing: 1, column: 1 }, before, after,
        steps: [
            { n: 1, move: "footing", reason: "stress", added: 1, text: "Added a footing.", at_mm: [750, 50, 50], before: logStep(before), after: logStep(logMetrics(19, true)) },
            { n: 2, move: "column", reason: "stress", added: 1, text: "Added a column.", at_mm: [850, 50, 50], before: logStep(logMetrics(19, true)), after: logStep(after) },
        ],
        duration_ms: 42, assembly_hash: await sharedAssembly.assemblyHash(RE_DESC), after_summary: summary, created_at: "2026-10-24T10:00:01.000Z",
    };
};

await test("earlierSteps: the descriptor's top step minus the steps its own log lists; no log, no offset (V3)", async () => {
    const { earlierSteps, topStep } = assemblyParts;
    assert.equal(topStep(ORIGINAL_DESC), 0);
    assert.equal(topStep(STABILIZED_DESC), 2);
    assert.equal(topStep(RE_DESC), 4);
    const log = (n) => ({ "nevo:stabilization": { steps: Array.from({ length: n }, (_, i) => ({ n: i + 1 })) } });
    assert.equal(earlierSteps(log(2), STABILIZED_DESC), 0, "a first run lists every step it has");
    assert.equal(earlierSteps(log(2), RE_DESC), 2, "the second run's two steps sit on the first run's two");
    assert.equal(earlierSteps(undefined, RE_DESC), 0);
    assert.equal(earlierSteps({}, RE_DESC), 0, "no log: nothing says how the steps were counted");
    assert.equal(earlierSteps({ "nevo:stabilization": "nope" }, RE_DESC), 0);
    assert.equal(earlierSteps({ "nevo:stabilization": { steps: "nope" } }, RE_DESC), 0);
    assert.equal(earlierSteps(log(9), STABILIZED_DESC), 0, "never negative");
    // Through the real writer, container and GLTFLoader.
    const meta = await reMeta();
    const loaded = await withFetch(responseOf(sharedGlb.writeAssemblyGlb(RE_DESC, meta)), () => loadGlbModule.loadGlb("/re.glb"));
    assert.deepEqual(loaded.assembly, RE_DESC);
    assert.equal(loaded.stepOffset, 2, "a re-stabilized model");
    disposeObject(loaded.scene);
    const first = await withFetch(responseOf(assemblyBytes(STABILIZED_DESC)), () => loadGlbModule.loadGlb("/a.glb"));
    assert.equal(first.stepOffset, 0, "no log in this file");
    disposeObject(first.scene);
    const plain = await withFetch(responseOf(await makeGlb()), () => loadGlbModule.loadGlb("/m.glb"));
    assert.equal(plain.stepOffset, 0, "a mesh");
    disposeObject(plain.scene);
});

await test("hook: a stabilized model has no ghost (its cubes would only veil the blocks); a mesh keeps it (V2)", async () => {
    const source = { geometry: new THREE.BoxGeometry(100, 100, 100), matrix: new THREE.Matrix4() };
    const scene = { current: { ghostSources: () => [source] } };
    const ghostOf = (t) => t.viewer.scene().scene.getObjectByName("blocks:ghost");
    const mesh = await hookStage({ sceneRef: scene, view: { ...BLOCKS_VIEW, showGhost: true } });
    assert.equal(ghostOf(mesh).children.length, 1, "the original model's ghost");
    assert.equal(ghostOf(mesh).visible, true);
    mesh.hook.unmount();
    const assembly = await hookStage({ sceneRef: scene, analysis: STABILIZED, noGhost: true, view: { ...BLOCKS_VIEW, showGhost: true } });
    assert.equal(ghostOf(assembly).children.length, 0, "nothing to show, whatever the stored flag says");
    assembly.hook.unmount();
    source.geometry.dispose();
});

await test("hook: the block tooltip counts the run on screen from step 1 (V3)", async () => {
    const column = STABILIZED.blocks.find((b) => b.role === "column");
    const bracket = STABILIZED.blocks.find((b) => b.role === "bracket");
    const plain = await hookStage({ analysis: STABILIZED });
    assert.equal(plain.viewer.scene().info(column.index).added, "Column, added in step 1");
    assert.equal(plain.viewer.scene().info(bracket.index).added, "Bracket, added in step 2");
    plain.hook.unmount();
    const again = await hookStage({ analysis: STABILIZED, stepOffset: 1 });
    assert.equal(again.viewer.scene().info(column.index).added, "Column, added in an earlier version");
    assert.equal(again.viewer.scene().info(bracket.index).added, "Bracket, added in step 1");
    again.hook.unmount();
});

const stageControls = await viewer("stageControls");
const { stackHeight } = await viewer("stackHeight");

await test("the chip stack's height is the measured one for the view on screen, else the estimate (V6, V8)", () => {
    assert.equal(stackHeight(null, true, 92, 8), 92, "not measured yet");
    assert.equal(stackHeight({ blocks: true, px: 114 }, true, 92, 8), 114, "the legend wrapped: more than the estimate");
    assert.equal(stackHeight({ blocks: true, px: 63 }, true, 92, 8), 63);
    assert.equal(stackHeight({ blocks: false, px: 29 }, true, 92, 8), 92, "measured in the other view: no word on this one");
    assert.equal(stackHeight({ blocks: true, px: 8 }, true, 92, 8), 92, "an element with no size (hidden): the estimate");
    assert.equal(stackHeight({ blocks: true, px: 0 }, true, 92, 8), 92);
});

// ---------- the added supports: a stabilized model shown on its source mesh ----------

console.log("added supports (a stabilized model on its source mesh)");

const supportsModule = await viewer("supports");
const { createSupportsLayer } = await viewer("supportsLayer");
const { useSupportsOverlay } = await viewer("useSupportsOverlay");

/** makeAnalysis' tower and arm with some blocks given a role: [index, role, step]. The transform is makeAnalysis' (factor 10, modelMin [-30, -10, 0], offset [200, 300, 0]). */
function withRoles(roles) {
    const analysis = makeAnalysis();
    const blocks = analysis.blocks.map((b) => ({ ...b, role: "original", step: 0 }));
    for (const [index, role, step] of roles) Object.assign(blocks[index], { role, step });
    return { ...analysis, blocks };
}
/** A column (block 6, cell (5, 4, 5)) and a footing (block 7, cell (6, 4, 5)) added in steps 1 and 2. */
const TWO_ADDED = () => withRoles([[6, "column", 1], [7, "footing", 2]]);
const MANY_ADDED = () => withRoles([[1, "column", 1], [2, "column", 1], [3, "column", 2], [8, "footing", 2], [9, "reinforcement", 3], [10, "reinforcement", 3]]);

await test("which blocks are supports: a role other than original; a mesh's blocks have none", () => {
    const m = supportsModule;
    assert.deepEqual(m.addedBlockIndices(TWO_ADDED().blocks), [6, 7]);
    assert.deepEqual(m.addedBlockIndices(makeAnalysis().blocks), [], "no roles at all: a mesh");
    assert.deepEqual(m.addedBlockIndices(withRoles([]).blocks), [], "all original");
    assert.equal(m.hasAddedSupports(TWO_ADDED()), true);
    assert.equal(m.hasAddedSupports(makeAnalysis()), false);
    assert.equal(m.hasAddedSupports(null), false);
    assert.equal(m.isAddedBlock({ role: "original" }), false);
    assert.equal(m.isAddedBlock({}), false);
    assert.equal(m.isAddedBlock({ role: "bridge" }), true);
    // The real engine's result: 12 blocks it started with, 5 columns and a bracket added.
    assert.equal(m.addedBlockIndices(STABILIZED.blocks).length, ADDED.length);
});

await test("the legend chip's text: 1 column · 1 footing; counts per role in the role order, plural by count", () => {
    const m = supportsModule;
    assert.equal(m.supportsLegendText(m.supportCounts(TWO_ADDED().blocks)), "Added supports: 1 column · 1 footing");
    assert.equal(m.supportsLegendText(m.supportCounts(MANY_ADDED().blocks)), "Added supports: 3 columns · 1 footing · 2 reinforcements", "BLOCK_ROLES order, whatever order the blocks come in");
    assert.equal(m.supportsLegendText(m.supportCounts(STABILIZED.blocks)), "Added supports: 5 columns · 1 bracket");
    assert.equal(m.supportsLegendText(m.supportCounts(makeAnalysis().blocks)), "", "nothing added: no chip");
    const counts = m.supportCounts(MANY_ADDED().blocks);
    assert.deepEqual(counts.map((c) => [c.role, c.count]), [["column", 3], ["footing", 1], ["reinforcement", 2]]);
    assert.deepEqual(counts.map((c) => c.color), ["#f59e0b", "#8b5cf6", "#ec4899"], "the role colours of the 3D tab");
    assert.equal(m.supportsTotal(counts), 6);
    // Every added role has its colour and noun.
    for (const role of ["column", "footing", "bracket", "bridge", "reinforcement"]) assert.ok(m.ROLE_NOUNS[role][0] && m.ROLE_NOUNS[role][1] && sharedAssembly.ROLE_HEX[role], role);
    assert.deepEqual([sharedAssembly.ROLE_HEX.column, sharedAssembly.ROLE_HEX.footing, sharedAssembly.ROLE_HEX.bracket, sharedAssembly.ROLE_HEX.bridge, sharedAssembly.ROLE_HEX.reinforcement], ["#f59e0b", "#8b5cf6", "#22c55e", "#06b6d4", "#ec4899"]);
});

await test("a support's tooltip and card: Column · added in step 1; steps count the run on screen; an original block has none", () => {
    const m = supportsModule;
    const a = TWO_ADDED();
    const column = m.describeSupport(a.blocks[6], a.settings);
    assert.equal(column.tooltip, "Column · added in step 1");
    assert.equal(column.heading, "Added support: column, step 1");
    assert.equal(column.zRange, "500–600 mm up");
    assert.ok(!("cell" in column), "a support's card gives its height in words, not its cell");
    assert.equal(column.color, "#f59e0b");
    assert.equal(column.index, 6);
    assert.equal(column.text, "Column · added in step 1 · 500–600 mm up");
    assert.equal(m.describeSupport(a.blocks[7], a.settings).tooltip, "Footing · added in step 2");
    assert.equal(m.describeSupport(a.blocks[0], a.settings), null, "an original block is not a support");
    // A re-stabilized model: the first run's blocks are an earlier version, the second run counts from 1.
    assert.equal(m.describeSupport(a.blocks[6], a.settings, 1).tooltip, "Column · added in an earlier version");
    assert.equal(m.describeSupport(a.blocks[6], a.settings, 1).step, null);
    assert.equal(m.describeSupport(a.blocks[6], a.settings, 1).heading, "Added support: column, earlier version");
    assert.equal(m.describeSupport(a.blocks[7], a.settings, 1).tooltip, "Footing · added in step 1");
    // It agrees with the block view's own wording for the same block.
    assert.equal(geom.describeBlock(a.blocks[6], a.settings).added, "Column, added in step 1");
});

await test("support ids are theirs alone: a part's id is never one, and only a whole index reads back", () => {
    const m = supportsModule;
    assert.equal(m.supportId(7), "support:7");
    assert.equal(m.supportIndexOf("support:7"), 7);
    assert.equal(m.supportIndexOf("support:0"), 0);
    for (const id of ["p1", "s2", "7", "support:", "support:x", "support:-1", "support:1.5", "", null, undefined]) assert.equal(m.supportIndexOf(id), null, String(id));
});

await test("a known cell lands where the mesh's transform puts it: the display frame of the loaded model", () => {
    const m = supportsModule;
    const a = TWO_ADDED();
    // Cell (5, 4, 5): centre (550, 450, 550) mm; x = (550 - 200) / 10 - 30 = 5, y = (450 - 300) / 10 - 10 = 5, z = 550 / 10 = 55.
    assert.deepEqual(m.blockDisplayCenter(a.blocks[6], a.transform), [5, 5, 55]);
    assert.deepEqual(m.blockDisplayBox(a.blocks[6], 100, a.transform), { min: [0, 0, 50], max: [10, 10, 60] });
    // The same numbers the block view's own mapping gives (they must never drift).
    assert.deepEqual(m.blockDisplayCenter(a.blocks[6], a.transform), geom.mmToDisplay(a.blocks[6].centerMm, a.transform));
    // Both added cells: the footing next to the column, along +x.
    assert.deepEqual(m.blockDisplayBox(a.blocks[7], 100, a.transform), { min: [10, 0, 50], max: [20, 10, 60] });
    assert.deepEqual(m.supportsDisplayBox(a), { min: [0, 0, 50], max: [20, 10, 60] }, "what Fit has to hold");
    assert.equal(m.supportsDisplayBox(makeAnalysis()), null);
    // A mesh at another scale: the factor shrinks or grows the cell in the display frame.
    const doubled = { ...a.transform, factor: 5 };
    assert.deepEqual(m.blockDisplayBox(a.blocks[6], 100, doubled), { min: [-30 + (500 - 200) / 5, -10 + (400 - 300) / 5, 100], max: [-30 + (600 - 200) / 5, -10 + (500 - 300) / 5, 120] });
    // A factor that is not a positive number would collapse the cubes: the block view's fallback of 1.
    assert.equal(m.usableTransform({ ...a.transform, factor: 0 }).factor, 1);
    assert.equal(m.usableTransform({ ...a.transform, factor: Number.NaN }).factor, 1);
    assert.equal(m.usableTransform(a.transform), a.transform);
});

// ---- the cubes ----

const meshOf = (layer, name) => layer.object.getObjectByName(name);

await test("the layer draws one cube per added block in its role colour, placed in the display frame by one transform", () => {
    const a = TWO_ADDED();
    const layer = createSupportsLayer({ analysis: a, theme: "light" });
    assert.equal(layer.count, 2);
    assert.deepEqual([...layer.indices], [6, 7]);
    assert.equal(layer.object.scale.x, 0.1);
    assert.deepEqual(layer.object.position.toArray(), [-50, -40, 0], "the volume's corner in the display frame");
    const cubes = meshOf(layer, "supports:blocks");
    assert.equal(cubes.isInstancedMesh, true);
    assert.equal(cubes.count, 2);
    // Instance 0 is the column: its world centre is the cell's display centre, its edge is the inset cube.
    const world = new THREE.Matrix4();
    cubes.getMatrixAt(0, world);
    world.premultiply(layer.object.matrixWorld);
    const centre = new THREE.Vector3().setFromMatrixPosition(world);
    assert.deepEqual(centre.toArray().map((v) => Math.round(v * 1e6) / 1e6), [5, 5, 55]);
    near(new THREE.Vector3().setFromMatrixScale(world).x, 100 * 0.92 * 0.1, 1e-9, "the cube is 92% of the 10 unit cell");
    const colour = new THREE.Color();
    cubes.getColorAt(0, colour);
    assert.equal(colour.getHexString(), new THREE.Color("#f59e0b").getHexString(), "column amber");
    cubes.getColorAt(1, colour);
    assert.equal(colour.getHexString(), new THREE.Color("#8b5cf6").getHexString(), "footing violet");
    // Crisp edges: 12 segments (24 vertices) a cube, in the theme's edge colour.
    const edges = meshOf(layer, "supports:edges");
    assert.equal(edges.geometry.drawRange.count, 2 * 24);
    assert.equal(edges.material.color.getHexString(), new THREE.Color(geom.PALETTE.light.edge).getHexString());
    // The box Fit holds: the two cells.
    assert.deepEqual(layer.box.min.toArray(), [0, 0, 50]);
    assert.deepEqual(layer.box.max.toArray(), [20, 10, 60]);
    assert.deepEqual(new THREE.Box3().setFromObject(layer.framed).min.toArray().map((v) => Math.round(v * 1e6) / 1e6), [0.4, 0.4, 50.4], "the framed object measures the cubes, not the hover marks");
    layer.object.updateMatrixWorld(true);
    assert.deepEqual(layer.anchorOf(6), [5, 5, 60], "the top centre of the column");
    assert.equal(layer.anchorOf(0), null, "an original block is not drawn");
    assert.equal(layer.info(6).tooltip, "Column · added in step 1");
    assert.equal(layer.info(0), null);
    layer.dispose();
});

await test("picking: the nearest cube along a world ray, with its distance; a miss, an original block and a behind-the-ray cube are null", () => {
    const a = withRoles([[6, "column", 1], [7, "footing", 2]]);
    const layer = createSupportsLayer({ analysis: a, theme: "light" });
    const scene = new THREE.Scene();
    scene.add(layer.object);
    scene.updateMatrixWorld(true);
    // Straight down onto the column's cell (display x 0-10, y 0-10, z 50-60) from z = 100.
    const down = layer.pickRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1)));
    assert.equal(down.id, "support:6");
    near(down.distance, 40, 1e-6, "from z 100 to the top face at z 60");
    near(down.point[2], 60, 1e-6);
    // Along +x through both: the column is met first, the footing is behind it.
    const along = layer.pickRay(new THREE.Ray(new THREE.Vector3(-30, 5, 55), new THREE.Vector3(1, 0, 0)));
    assert.equal(along.id, "support:6");
    near(along.distance, 30, 1e-6);
    // From the other side the footing is first.
    assert.equal(layer.pickRay(new THREE.Ray(new THREE.Vector3(60, 5, 55), new THREE.Vector3(-1, 0, 0))).id, "support:7");
    // Over the tower's original blocks (display x -10..0, y -10..0): nothing drawn there.
    assert.equal(layer.pickRay(new THREE.Ray(new THREE.Vector3(-5, -5, 100), new THREE.Vector3(0, 0, -1))), null);
    // A ray pointing away.
    assert.equal(layer.pickRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, 1))), null);
    layer.dispose();
    assert.equal(layer.pickRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))), null, "a freed layer picks nothing");
});

await test("hover and selection marks sit on the cube, ask for a frame once per change, and ignore blocks that are not drawn", () => {
    let frames = 0;
    const layer = createSupportsLayer({ analysis: TWO_ADDED(), theme: "light", onChange: () => (frames += 1) });
    const marks = layer.object.getObjectByName("supports:marks");
    assert.equal(marks.children.filter((o) => o.visible).length, 0, "nothing marked at first");
    layer.setHover(6);
    assert.equal(frames, 1);
    assert.equal(marks.children.filter((o) => o.visible).length, 2, "an outline and a wash");
    assert.deepEqual(marks.children.find((o) => o.visible).position.toArray(), [550, 450, 550], "at the cell, in mm (the group scales it)");
    layer.setHover(6);
    assert.equal(frames, 1, "the same hover again costs nothing");
    layer.setHover(0);
    assert.equal(marks.children.filter((o) => o.visible).length, 0, "an original block is no support: the hover ends");
    layer.setSelected(7);
    assert.equal(marks.children.filter((o) => o.visible).length, 2);
    layer.setSelected(null);
    assert.equal(marks.children.filter((o) => o.visible).length, 0);
    layer.setSelected(99);
    layer.setSelected(-1);
    // The marks are outside what Fit frames.
    layer.setHover(6);
    assert.equal(layer.framed.getObjectByName("supports:marks"), undefined);
    // The theme repaints the edges and the hover outline.
    layer.setTheme("dark");
    assert.equal(meshOf(layer, "supports:edges").material.color.getHexString(), new THREE.Color(geom.PALETTE.dark.edge).getHexString());
    layer.dispose();
});

await test("disposing frees every geometry and material the layer made, takes it out of its scene, and is idempotent", () => {
    const layer = createSupportsLayer({ analysis: MANY_ADDED(), theme: "light" });
    const scene = new THREE.Scene();
    scene.add(layer.object);
    const freed = { geometries: 0, materials: 0, instanced: 0 };
    const seen = { geometries: new Set(), materials: new Set() };
    layer.object.traverse((o) => {
        if (o.geometry && !seen.geometries.has(o.geometry)) {
            seen.geometries.add(o.geometry);
            o.geometry.addEventListener("dispose", () => (freed.geometries += 1));
        }
        for (const m of [o.material].flat().filter(Boolean)) {
            if (!seen.materials.has(m)) {
                seen.materials.add(m);
                m.addEventListener("dispose", () => (freed.materials += 1));
            }
        }
        if (o.isInstancedMesh) o.addEventListener("dispose", () => (freed.instanced += 1));
    });
    assert.ok(seen.geometries.size >= 3 && seen.materials.size >= 3);
    layer.dispose();
    assert.equal(freed.geometries, seen.geometries.size, "every geometry");
    assert.equal(freed.materials, seen.materials.size, "every material");
    assert.equal(freed.instanced, 1, "the instance buffers");
    assert.equal(layer.object.parent, null, "out of its scene");
    layer.dispose();
    assert.equal(freed.geometries, seen.geometries.size, "twice frees nothing more");
});

// ---- in the model's scene ----

/** A model scene (two boxes) and a layer for TWO_ADDED, attached as the viewer's hook does. */
function modelWithSupports(analysis = TWO_ADDED()) {
    const scene = buildGlbScene(modelOf(2), {});
    const layer = createSupportsLayer({ analysis, theme: "light" });
    return { scene, layer, attach: () => scene.setOverlay({ object: layer.object, framed: layer.framed, box: layer.box, pick: layer.pickRay }) };
}

await test("an overlay joins the scene's bounds and framing while it is shown, and is no part: no row, no hiding, no pick of a part", () => {
    const { scene, layer, attach } = modelWithSupports();
    const before = scene.bounds.clone();
    const revision = scene.revision();
    const rows = scene.rows.length;
    const frames = [];
    attach();
    assert.ok(scene.revision() > revision, "what Fit re-reads");
    assert.equal(scene.scene.getObjectByName("supports:root"), layer.object, "in the scene");
    assert.ok(scene.bounds.containsBox(layer.box), "the cubes are inside the bounds");
    assert.ok(scene.bounds.containsBox(before), "and the model still is");
    assert.ok(scene.framed().includes(layer.framed), "Fit frames them");
    assert.equal(scene.framed().length, scene.rows.length + 1);
    assert.equal(scene.rows.length, rows, "no new part");
    assert.equal(scene.parts.size, rows);
    // Hidden: back to the model's own bounds and framing.
    assert.equal(scene.setOverlayVisible(false), true);
    assert.deepEqual(scene.bounds.min.toArray(), before.min.toArray());
    assert.deepEqual(scene.bounds.max.toArray(), before.max.toArray());
    assert.equal(scene.setOverlayVisible(false), false, "no change, no work");
    assert.equal(scene.overlayRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))), null, "a hidden overlay is not picked");
    assert.equal(scene.setOverlayVisible(true), true);
    assert.ok(scene.overlayRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))));
    assert.equal(frames.length, 0);
    // Taken away: the scene is as it was.
    scene.setOverlay(null);
    assert.equal(layer.object.parent, null);
    assert.deepEqual(scene.bounds.max.toArray(), before.max.toArray());
    assert.equal(scene.overlayRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))), null);
    assert.equal(scene.framed().length, scene.rows.length);
    layer.dispose();
    scene.dispose();
});

await test("a scene that is disposed ignores its overlay, and does not free it (the owner does)", () => {
    const { scene, layer, attach } = modelWithSupports();
    attach();
    let freed = 0;
    layer.object.getObjectByName("supports:blocks").addEventListener("dispose", () => (freed += 1));
    scene.dispose();
    assert.equal(freed, 0, "the layer is the hook's to free");
    assert.equal(scene.setOverlay(null), undefined);
    assert.equal(scene.setOverlayVisible(true), false);
    assert.equal(scene.overlayRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))), null);
    layer.dispose();
    assert.equal(freed, 1);
});

await test("Fit and the presets include the supports when shown (a footing can stick out of the mesh), and not when hidden", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const a = TWO_ADDED();
    // A footing far out on +x of the little model: the transform puts display x at (cell - 200) / 10 - 30.
    a.blocks[7] = { ...a.blocks[7], cell: [9, 4, 0], centerMm: [950, 450, 50] };
    const { scene, layer, attach } = modelWithSupports(a);
    v.setScene(scene);
    v.setView("iso");
    const distance = () => new THREE.Vector3(...v.camera().position).distanceTo(new THREE.Vector3(...v.camera().target));
    const bare = distance();
    attach();
    v.refresh();
    const withSupports = distance();
    assert.ok(withSupports > bare * 1.05, `the camera backs off to hold the footing (${bare} -> ${withSupports})`);
    scene.setOverlayVisible(false);
    v.refresh();
    near(distance(), bare, 1e-6, "hidden: framed on the model alone again");
    scene.setOverlayVisible(true);
    v.setView("top");
    const top = distance();
    assert.ok(top > 0);
    // The thumbnail's shot is framed on the model with the supports too.
    return v.snapshot({ width: 64, height: 48, scene }).then((blob) => {
        assert.ok(blob);
        v.dispose();
        layer.dispose();
        scene.dispose();
    });
});

await test("the viewer picks a support in front of a part and a part in front of a support; a support alone is what is under the pointer over empty space", () => {
    const dom = stubDom();
    const v = mountOrbitViewer(dom.container, createEmptyViewerScene(), { theme: "light" });
    const scene = buildGlbScene(modelOf(1), {});
    v.setScene(scene);
    v.setView("iso");
    const fake = (hit) => ({ object: new THREE.Group(), framed: new THREE.Group(), box: new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)), pick: () => hit });
    // The model's single box is at the middle of the canvas.
    assert.equal(v.pick(200, 150), "p1");
    scene.setOverlay(fake({ id: "support:3", point: [0, 0, 0], distance: 0.001 }));
    assert.equal(v.pick(200, 150), "support:3", "the support is nearer than the part");
    assert.equal(v.hit(200, 150).normal, null);
    scene.setOverlay(fake({ id: "support:3", point: [0, 0, 0], distance: 1e9 }));
    assert.equal(v.pick(200, 150), "p1", "the part is nearer");
    assert.equal(v.pick(2, 2), "support:3", "nothing of the model there: the support is what is under the pointer");
    scene.setOverlay(fake(null));
    assert.equal(v.pick(200, 150), "p1");
    assert.equal(v.pick(2, 2), null);
    // Hidden parts are clicked through, to a support behind them.
    scene.setOverlay(fake({ id: "support:3", point: [0, 0, 0], distance: 1e9 }));
    scene.update({ hidden: ["p1"] });
    assert.equal(v.pick(200, 150), "support:3");
    v.dispose();
    scene.dispose();
});

// ---- the hook ----

/** The hook over a real model scene, with a stand-in viewer. */
async function overlayStage(overrides = {}) {
    const dom = stubDom();
    const model = { current: buildGlbScene(modelOf(1), {}) };
    const log = { refreshes: 0, frames: 0, flights: [] };
    let onStage = model.current;
    const viewer = {
        scene: () => onStage,
        refresh: () => (log.refreshes += 1),
        requestFrame: () => (log.frames += 1),
        contextLost: () => false,
        flyToBox: (box, ms) => log.flights.push({ box, ms }),
    };
    void dom;
    const base = { viewerRef: { current: viewer }, sceneRef: model, ready: true, viewerEpoch: 1, modelEpoch: 1, theme: "light", supports: TWO_ADDED(), visible: true, ...overrides };
    const hook = renderHook(useSupportsOverlay, base);
    const state = { hook, model, log, viewer, base, props: { ...base } };
    state.update = async (patch) => {
        state.props = { ...state.props, ...patch };
        hook.rerender(state.props);
        await wait();
    };
    state.setScene = (scene) => (onStage = scene);
    state.layerRoot = (scene = model.current) => scene.scene.getObjectByName("supports:root") ?? null;
    await wait();
    return state;
}

await test("hook: the cubes are built once the model is shown, put into its scene, framed, and freed on unmount", async () => {
    const t = await overlayStage();
    assert.equal(t.hook.result.built, true);
    assert.equal(t.hook.result.failed, false);
    const root = t.layerRoot();
    assert.ok(root, "in the model's scene");
    assert.ok(t.model.current.bounds.containsBox(new THREE.Box3(new THREE.Vector3(0, 0, 50), new THREE.Vector3(20, 10, 60))));
    assert.ok(t.log.refreshes >= 1, "the viewer re-read the bounds and framing");
    let freed = 0;
    root.getObjectByName("supports:blocks").addEventListener("dispose", () => (freed += 1));
    t.hook.unmount();
    assert.equal(t.layerRoot(), null, "out of the scene");
    assert.equal(freed, 1, "and freed");
    t.model.current.dispose();
});

await test("hook: nothing is built until the model is ready, or for no result; a result that goes takes the cubes with it", async () => {
    const t = await overlayStage({ ready: false });
    const bare = t.model.current.bounds.clone();
    assert.equal(t.layerRoot(), null);
    assert.equal(t.hook.result.built, false);
    await t.update({ ready: true });
    assert.ok(t.layerRoot());
    const refreshes = t.log.refreshes;
    await t.update({ supports: null });
    assert.equal(t.layerRoot(), null, "the version without supports is shown: no cubes");
    assert.equal(t.hook.result.built, false);
    assert.ok(t.log.refreshes > refreshes, "the camera is told to frame the model alone again");
    assert.ok(t.model.current.bounds.equals(bare), "and the bounds are the model's again");
    await t.update({ supports: TWO_ADDED() });
    assert.ok(t.layerRoot());
    await t.update({ ready: false });
    assert.equal(t.layerRoot(), null, "a model that is loading has none");
    t.hook.unmount();
    t.model.current.dispose();
});

await test("hook: a new result replaces the cubes in place (the bare mesh never shows), and the old ones are freed", async () => {
    const t = await overlayStage();
    const first = t.layerRoot();
    let freed = 0;
    first.getObjectByName("supports:blocks").addEventListener("dispose", () => (freed += 1));
    const seen = [];
    const scene = t.model.current.scene;
    const originalAdd = scene.add.bind(scene);
    scene.add = (...objects) => (seen.push(...objects.map((o) => o.name)), originalAdd(...objects));
    await t.update({ supports: MANY_ADDED() });
    const second = t.layerRoot();
    assert.ok(second && second !== first, "other cubes");
    assert.equal(second.getObjectByName("supports:blocks").count, 6);
    assert.equal(first.parent, null);
    assert.equal(freed, 1, "the old cubes are freed");
    assert.ok(seen.includes("supports:root"));
    assert.equal(scene.children.filter((o) => o.name === "supports:root").length, 1, "one layer at a time");
    t.hook.unmount();
    t.model.current.dispose();
});

await test("hook: the switch hides the cubes and re-frames; a new model's scene gets its own cubes and the old scene's are freed", async () => {
    const t = await overlayStage();
    const refreshes = t.log.refreshes;
    await t.update({ visible: false });
    assert.equal(t.layerRoot().visible, false);
    assert.ok(t.log.refreshes > refreshes, "framed on the model alone again");
    assert.equal(t.model.current.overlayRay(new THREE.Ray(new THREE.Vector3(5, 5, 100), new THREE.Vector3(0, 0, -1))), null);
    await t.update({ visible: true });
    assert.equal(t.layerRoot().visible, true);
    // The model is replaced (another url): its scene is disposed, the hook is told through the epoch.
    const old = t.model.current;
    const oldRoot = t.layerRoot();
    const next = buildGlbScene(modelOf(1), {});
    t.model.current = next;
    t.setScene(next);
    old.dispose();
    await t.update({ modelEpoch: 2 });
    assert.equal(oldRoot.parent, null);
    assert.ok(t.layerRoot(next), "cubes in the new scene");
    t.hook.unmount();
    next.dispose();
});

await test("hook: hover, selection and framing go to the cube; the theme repaints; with nothing asked for there is nothing to hover", async () => {
    const t = await overlayStage();
    const marks = t.layerRoot().getObjectByName("supports:marks");
    t.hook.result.setHover(6);
    assert.equal(marks.children.filter((o) => o.visible).length, 2);
    t.hook.result.setHover(null);
    t.hook.result.setSelected(7);
    assert.equal(marks.children.filter((o) => o.visible).length, 2);
    t.hook.result.setSelected(null);
    t.hook.result.frame(6);
    assert.equal(t.log.flights.length, 1);
    const { box } = t.log.flights[0];
    assert.ok(box.containsBox(new THREE.Box3(new THREE.Vector3(0, 0, 50), new THREE.Vector3(10, 10, 60))), "the cube, with room round it");
    near(t.log.flights[0].ms, 400, 0);
    t.hook.result.frame(0);
    assert.equal(t.log.flights.length, 1, "an original block has no cube to fly to");
    await t.update({ theme: "dark" });
    assert.equal(t.layerRoot().getObjectByName("supports:edges").material.color.getHexString(), new THREE.Color(geom.PALETTE.dark.edge).getHexString());
    t.hook.unmount();
    t.model.current.dispose();
    const none = await overlayStage({ supports: null });
    none.hook.result.setHover(1);
    none.hook.unmount();
    none.model.current.dispose();
});

await test("hook: a cube layer that cannot be built says so, and the mesh stays", async () => {
    const log = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    const t = await overlayStage({ supports: TWO_ADDED() });
    try {
        // A result the cubes cannot be made from (what a lazy chunk that will not load looks like to the hook: the build rejects).
        await t.update({ supports: { ...TWO_ADDED(), settings: null } });
        assert.equal(t.hook.result.failed, true);
        assert.equal(t.layerRoot(), null, "the old cubes went with the result they were made from");
        assert.ok(errors.length >= 1, "logged");
        await t.update({ supports: TWO_ADDED() });
        assert.equal(t.hook.result.failed, false, "a result it can build: cleared");
        assert.ok(t.layerRoot());
    } finally {
        console.error = log;
    }
    t.hook.unmount();
    t.model.current.dispose();
});

await test("the block view of a stabilized result over its source mesh: the ghost is that mesh, and the counts come from the result", async () => {
    const source = { geometry: new THREE.BoxGeometry(100, 100, 100), matrix: new THREE.Matrix4() };
    const scene = { current: { ghostSources: () => [source] } };
    const t = await hookStage({ sceneRef: scene, analysis: STABILIZED, view: { ...BLOCKS_VIEW, showGhost: true } });
    const ghost = t.viewer.scene().scene.getObjectByName("blocks:ghost");
    assert.equal(ghost.children.length, 1, "a stabilized result on a mesh keeps the mesh's ghost (noGhost is only for a loaded assembly)");
    assert.equal(ghost.visible, true);
    assert.ok(ghost.children[0].geometry === source.geometry, "the source mesh's geometry, shared");
    assert.equal(t.viewer.scene().info(STABILIZED.blocks.find((b) => b.role === "column").index).added, "Column, added in step 1");
    t.hook.unmount();
    source.geometry.dispose();
    // The numbers the stage names a stabilized model by when the model on stage is a mesh come from the result's assembly.
    assert.deepEqual(assemblyParts.assemblyCounts(STABILIZED.assembly.descriptor), { original: 12, added: 6, edited: 0 });
});

// ---------- fixes found in review (V1-V5) ----------

await test("V1: a re-stabilized model shown on its source mesh numbers its steps from its own run; the mesh has no log, so the host says how many came before", async () => {
    const { stepsBeforeOwnRun, stageStepOffset, topStep } = assemblyParts;
    // O -> V1 (steps 1-2) -> V2 (steps 3-4; V2's own log lists 2 steps). The viewer loads the ROOT mesh: no assembly, no log, `earlier` is 0.
    assert.equal(topStep(RE_DESC), 4);
    assert.equal(stepsBeforeOwnRun(topStep(RE_DESC), 2), 2, "two steps of V1 sit under V2's own two");
    assert.equal(stepsBeforeOwnRun(2, 2), 0, "a first run");
    assert.equal(stepsBeforeOwnRun(2, 9), 0, "never negative");
    for (const none of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(stepsBeforeOwnRun(4, none), 0, `no usable log: ${none}`);
    // earlierSteps is the same arithmetic over the log a loaded GLB carries.
    const log = (n) => ({ "nevo:stabilization": { steps: Array.from({ length: n }, (_, i) => ({ n: i + 1 })) } });
    assert.equal(assemblyParts.earlierSteps(log(2), RE_DESC), stepsBeforeOwnRun(topStep(RE_DESC), 2));

    // What the stage uses.
    const base = { assembly: RE_DESC, previewing: false, earlier: 0 };
    assert.equal(stageStepOffset({ ...base, assembly: null, hosted: 2, earlier: 5 }), 0, "a plain mesh with nothing behind it");
    assert.equal(stageStepOffset(base), 0, "the old behaviour: the mesh on stage has no log, so nothing is subtracted");
    assert.equal(stageStepOffset({ ...base, hosted: 2 }), 2, "the host's count");
    assert.equal(stageStepOffset({ ...base, hosted: 0, earlier: 3 }), 0, "an explicit 0 is a count too");
    for (const bad of [undefined, null, -1, Number.NaN]) assert.equal(stageStepOffset({ ...base, hosted: bad, earlier: 3 }), 3, `not a count (${bad}): the loaded assembly's own log decides`);
    assert.equal(stageStepOffset({ ...base, hosted: 1.9 }), 1, "whole steps");
    assert.equal(stageStepOffset({ ...base, previewing: true, hosted: 2, earlier: 1 }), 4, "the stabilizer's preview continues from the top step, whatever the host says");

    // The wording the tooltip and the card give, on the real engine's result of V2 under the offset the host computes.
    const v2 = solved(RE_DESC);
    const block = (role, step) => v2.blocks.find((b) => b.role === role && b.step === step);
    const offset = stageStepOffset({ ...base, hosted: stepsBeforeOwnRun(topStep(RE_DESC), 2) });
    const say = (b, o) => supportsModule.describeSupport(b, v2.settings, o).tooltip;
    assert.equal(say(block("footing", 3), 0), "Footing · added in step 3", "what the unfixed viewer said: the timeline says step 1");
    assert.equal(say(block("footing", 3), offset), "Footing · added in step 1");
    assert.equal(say(block("column", 4), offset), "Column · added in step 2");
    assert.equal(say(block("column", 1), offset), "Column · added in an earlier version", "V1's column");
    assert.equal(supportsModule.describeSupport(block("column", 1), v2.settings, offset).heading, "Added support: column, earlier version");
    assert.equal(geom.describeBlock(block("footing", 3), v2.settings, null, offset).added, "Footing, added in step 1", "the Analysis tab's block tooltip agrees");
});

await test("V1: the cubes are rebuilt when the step offset changes, so their tooltips are never numbered by a stale one", async () => {
    const t = await overlayStage({ stepOffset: 0 });
    const first = t.layerRoot();
    assert.ok(first);
    await t.update({ stepOffset: 2 });
    const second = t.layerRoot();
    assert.ok(second && second !== first, "other cubes");
    assert.equal(first.parent, null, "the old ones are out of the scene");
    await t.update({ stepOffset: 2 });
    assert.ok(t.layerRoot() === second, "the same offset: the same cubes");
    t.hook.unmount();
    t.model.current.dispose();
});

await test("V2: a one-part model gets neither the part tint nor the part tooltip from a hover, even while the pointer tracks it for the cubes; a support is always routed", () => {
    const { routeHover, supportId } = supportsModule;
    assert.deepEqual(routeHover("p1", 1), { support: null, part: null, tip: null }, "the lone mesh: nothing to point at");
    assert.deepEqual(routeHover("p1", 0), { support: null, part: null, tip: null });
    assert.deepEqual(routeHover("p2", 3), { support: null, part: "p2", tip: "p2" }, "several parts: lit and described");
    assert.deepEqual(routeHover(supportId(6), 1), { support: 6, part: null, tip: "support:6" }, "a cube on a one-part mesh");
    assert.deepEqual(routeHover(supportId(6), 4), { support: 6, part: null, tip: "support:6" }, "a cube is never lit as a part");
    for (const none of [null, undefined, ""]) assert.deepEqual(routeHover(none, 3), { support: null, part: null, tip: null }, `no hit (${JSON.stringify(none)})`);
});

await test("V4: a cube is only pointed at, described and carded while it is drawn: the switch, the parts exploded and the block view put it away", () => {
    const { supportsDrawn } = supportsModule;
    const on = { has: true, shown: true, explode: 0, blocks: false };
    assert.equal(supportsDrawn(on), true);
    assert.equal(supportsDrawn({ ...on, has: false }), false, "nothing was added");
    assert.equal(supportsDrawn({ ...on, shown: false }), false, "the switch is off");
    assert.equal(supportsDrawn({ ...on, explode: 1 }), false, "exploded: the cubes would be left behind");
    assert.equal(supportsDrawn({ ...on, explode: 60 }), false);
    assert.equal(supportsDrawn({ ...on, blocks: true }), false, "the block view has its own blocks");
});

await test("V5: the toolbar download says it is the stabilized GLB whenever it is not the file on stage, result or no result", () => {
    const { downloadLabelFor } = viewerFormat;
    assert.equal(downloadLabelFor("/files/stab.glb", "/files/root.glb"), "Download stabilized GLB", "a stabilized model on its source mesh");
    assert.equal(downloadLabelFor("/files/root.glb", "/files/root.glb"), undefined, "the file on stage: the toolbar's own wording");
    assert.equal(downloadLabelFor(undefined, "/files/root.glb"), undefined, "no other file given");
    assert.equal(downloadLabelFor(null, "/files/root.glb"), undefined, "no download at all");
    assert.equal(downloadLabelFor("/files/opt.glb", "/files/root.glb", "Download optimized GLB"), "Download optimized GLB", "an optimized version on the original mesh says so");
    assert.equal(downloadLabelFor("/files/root.glb", "/files/root.glb", "Download optimized GLB"), undefined, "the given words only apply to another file");
});

// ---------- the stage's own view controls: the Colour chip, the layer cut, the Show menu, the legend ----------

console.log("stage controls (Colour chip, Layers, Show, legend)");

/** A model of `layers` layers (cells on the ground to the top), one block each. */
const layersOf = (layers) => Array.from({ length: layers }, (_, k) => ({ index: k, cell: [0, 0, k] }));

await test("hasAddedBlocks: only a result with blocks added to its assembly has the Added blocks colouring", () => {
    const { hasAddedBlocks } = stageControls;
    assert.equal(hasAddedBlocks(STABILIZED), true);
    assert.equal(hasAddedBlocks(ONLY_ORIGINAL), false, "the original blocks on their own have nothing added");
    assert.equal(hasAddedBlocks(ORIGINAL), false);
    assert.equal(hasAddedBlocks(makeAnalysis()), false, "a mesh has no roles at all");
    assert.equal(hasAddedBlocks(null), false);
    assert.equal(hasAddedBlocks(undefined), false);
});

await test("the Colour menu lists Status, Overhang, Strength, Layers, and Added blocks only when blocks were added", () => {
    const { colorOptions } = stageControls;
    const labels = (analysis, extra) => colorOptions({ analysis, ...extra }).map((o) => o.label);
    assert.deepEqual(labels(STABILIZED), ["Status", "Overhang", "Strength", "Layers", "Added blocks"]);
    assert.deepEqual(labels(ORIGINAL), ["Status", "Overhang", "Strength", "Layers"], "an assembly with nothing added");
    assert.deepEqual(labels(ONLY_ORIGINAL), ["Status", "Overhang", "Strength", "Layers"], "the original version of a stabilized model");
    assert.deepEqual(labels(makeAnalysis()), ["Status", "Overhang", "Strength", "Layers"], "a mesh");
    assert.deepEqual(colorOptions({ analysis: STABILIZED }).map((o) => o.value), ["status", "reach", "stress", "layer", "role"], "the values the view stores");
    assert.deepEqual(Object.values(geom.COLOR_MODE_LABELS).sort(), ["Added blocks", "Layers", "Overhang", "Status", "Strength"]);
    // The colouring on stage is always in the menu, so the chip never names something the menu lacks.
    assert.deepEqual(labels(ORIGINAL, { current: "role" }), ["Status", "Overhang", "Strength", "Layers", "Added blocks"]);
    // Every option says what it is in one plain line.
    for (const option of colorOptions({ analysis: STABILIZED })) assert.ok(option.hint.length > 8 && !/cantilever|utilis|allowable|COG/i.test(option.hint), option.value);
    assert.equal(colorOptions({ analysis: null }).length, 4, "no result: the four that need nothing special are listed");
});

await test("Strength is greyed with the reason when there is no stress estimate (still coming, or none for this model), and open otherwise", () => {
    const { colorOptions } = stageControls;
    const strength = (analysis, busy) => colorOptions({ analysis, busy }).find((o) => o.value === "stress");
    assert.equal(strength(STABILIZED).disabled, undefined, "a stress estimate: usable");
    assert.equal(strength(STABILIZED).reason, undefined);
    const plain = strength(makeAnalysis());
    assert.equal(plain.disabled, true);
    assert.equal(plain.reason, "There is no strength estimate for this model.");
    const coming = strength(makeAnalysis(), true);
    assert.equal(coming.disabled, true);
    assert.equal(coming.reason, "Still being worked out.", "an analysis is running: it may come");
    assert.equal(strength({ ...ORIGINAL, stress: null }).disabled, true, "the estimate failed");
    assert.equal(strength({ ...ORIGINAL, stress: null }, true).reason, "Still being worked out.");
    // Nothing else is ever greyed.
    for (const o of colorOptions({ analysis: makeAnalysis() })) if (o.value !== "stress") assert.equal(o.disabled, undefined, o.value);
});

await test("the Colour chip reads 'Colour: Status', and is locked to 'Added blocks (live preview)' while the stabilizer previews", () => {
    const { colorChipModel, PREVIEW_COLOR_LABEL } = stageControls;
    for (const [colorBy, label] of [["status", "Status"], ["reach", "Overhang"], ["stress", "Strength"], ["layer", "Layers"], ["role", "Added blocks"]]) {
        const model = colorChipModel({ analysis: STABILIZED, colorBy });
        assert.equal(model.text, `Colour: ${label}`);
        assert.equal(model.value, colorBy);
        assert.equal(model.locked, undefined);
        assert.ok(model.options.some((o) => o.value === colorBy), "what is on stage is in the menu");
    }
    const locked = colorChipModel({ analysis: STABILIZED, colorBy: "stress", previewing: true });
    assert.equal(PREVIEW_COLOR_LABEL, "Added blocks (live preview)");
    assert.equal(locked.text, "Colour: Added blocks (live preview)");
    assert.equal(locked.locked, PREVIEW_COLOR_LABEL);
    assert.equal(locked.value, "role", "the stage paints what was added, whatever was chosen");
    assert.equal(geom.resolveColorBy({ colorBy: "stress" }, STABILIZED, true), locked.value, "the chip says what resolveColorBy paints");
});

await test("the layer cut: 'Layers 1–7 of 10', 'up to 700 mm', a '1–7' badge when it hides something, none when everything shows", () => {
    const { layerCut } = stageControls;
    const ten = layersOf(10);
    const cut = layerCut(ten, 6, 100);
    assert.deepEqual(cut, { count: 10, shown: 7, cut: true, max: 6, badge: "1–7", heading: "Layers 1–7 of 10", upTo: "up to 700 mm" });
    assert.deepEqual(layerCut(ten, 9, 100), { count: 10, shown: 10, cut: false, max: 9, badge: null, heading: "Layers 1–10 of 10", upTo: "up to 1000 mm" }, "Show all: no badge");
    assert.equal(layerCut(ten, 99, 100).cut, false, "a cut above the top shows everything");
    assert.equal(layerCut(ten, 99, 100).max, 9, "and the slider rests on the top layer");
    assert.deepEqual(layerCut(ten, 0, 100), { count: 10, shown: 1, cut: true, max: 0, badge: "1", heading: "Layer 1 of 10", upTo: "up to 100 mm" }, "ground layer only");
    assert.equal(layerCut(ten, -1, 100).max, 0, "the slider has no position below the ground layer");
    assert.equal(layerCut(ten, Number.NaN, 100).cut, false, "no number: everything");
    assert.equal(layerCut(ten, 4, 50).upTo, "up to 250 mm", "the block size sets the height");
    const none = layerCut([], 3, 100);
    assert.deepEqual([none.count, none.cut, none.badge], [1, false, null], "no blocks: one layer, nothing cut");
    // The hand-built analysis: 8 layers (a floating block at layer 7).
    const a = makeAnalysis();
    for (let layerMax = -1; layerMax <= 9; layerMax += 1) {
        if (layerMax < 0) continue;
        assert.equal(layerCut(a.blocks, layerMax, 100).cut, geom.cutActive(a.blocks, layerMax), `agrees with the scene's own cut at ${layerMax}`);
    }
    assert.equal(layerCut(a.blocks, 3, 100).heading, "Layers 1–4 of 8", "and with the scene's cut label (Layers 1–4)");
});

await test("the stage's words: the legend, the colour names and the stage no longer say cantilever, overreach, allowable or load path", () => {
    const words = [...Object.values(geom.STATUS_LABELS), ...Object.values(geom.COLOR_MODE_LABELS), ...Object.values(geom.COLOR_MODE_HINTS)].join(" | ");
    assert.doesNotMatch(words, /cantilever|overreach|allowable|load path|utilis/i, words);
    const a = makeAnalysis();
    const all = a.blocks.map((b, i) => geom.describeBlock(b, a.settings, geom.describeStress(STABILIZED, i % STABILIZED.blocks.length)).text).join("\n") + geom.cogSummary(a.stability).sub + geom.cogSummary(makeAnalysis({ inside: true }).stability).sub;
    assert.doesNotMatch(all, /cantilever|overreach|allowable|load path|utilis|margin/i, all);
    assert.equal(geom.cogSummary(makeAnalysis({ inside: true }).stability).sub, "Inside the base by 50 mm");
});

// ---- the markup of the chip, the toolbar and the legend (React server-rendered; a closed menu shows only its trigger) ----

const { build } = await import("esbuild");
const { mkdirSync, readFileSync, existsSync, readdirSync } = await import("node:fs");
const nodePath = await import("node:path");
const { pathToFileURL } = await import("node:url");
const repoRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "../..");
const viewerBundleDir = nodePath.join(repoRoot, "node_modules/.tmp/assignment-viewer-test");
mkdirSync(viewerBundleDir, { recursive: true });
await build({
    stdin: {
        contents: `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "@/assignment/components/ui/tooltip";
export { React, renderToStaticMarkup, TooltipProvider };
export { ColorChip } from "@/assignment/viewer/ColorChip";
export { AnalysisLegend } from "@/assignment/viewer/AnalysisLegend";
export { ViewerToolbar, LayersPopover } from "@/assignment/viewer/ViewerToolbar";
// The report's Strength section, to check it counts what the stage's legend counts (S1).
export { StrengthDetails } from "@/assignment/components/analysis/StrengthDetails";
`,
        resolveDir: repoRoot,
        sourcefile: "viewer-entry.tsx",
        loader: "tsx",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    outfile: nodePath.join(viewerBundleDir, "bundle.mjs"),
    tsconfig: nodePath.join(repoRoot, "tsconfig.app.json"),
    nodePaths: [nodePath.join(repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    // react-dom/server is CommonJS and asks for node's own modules.
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    logLevel: "error",
});
const ui = await import(pathToFileURL(nodePath.join(viewerBundleDir, "bundle.mjs")).href);
const h = ui.React.createElement;
const html = (el) => ui.renderToStaticMarkup(el);
/** The visible text of some markup: tags gone, whitespace folded. */
const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

await test("ColorChip: a button 'Colour: Status' with a menu; without a handler or while previewing it is plain text, not a button", () => {
    const { colorChipModel } = stageControls;
    const live = html(h(ui.ColorChip, { model: colorChipModel({ analysis: STABILIZED, colorBy: "status" }), onChange: () => undefined }));
    assert.match(live, /<button\b[^>]*data-testid="stage-color-chip"/);
    assert.match(live, /aria-haspopup="menu"/);
    assert.match(live, /aria-expanded="false"/);
    assert.equal(textOf(live), "Colour: Status");
    assert.doesNotMatch(live, /aria-label=/, "the visible text is the accessible name");
    // Read-only (the host gave no handler): the colouring on stage, nothing to press.
    const readOnly = html(h(ui.ColorChip, { model: colorChipModel({ analysis: STABILIZED, colorBy: "layer" }) }));
    assert.doesNotMatch(readOnly, /<button/);
    assert.equal(textOf(readOnly), "Colour: Layers");
    // Locked by the stabilizer's preview, even with a handler.
    const locked = html(h(ui.ColorChip, { model: colorChipModel({ analysis: STABILIZED, colorBy: "stress", previewing: true }), onChange: () => undefined }));
    assert.doesNotMatch(locked, /<button/);
    assert.match(locked, /data-locked="true"/);
    assert.equal(textOf(locked), "Colour: Added blocks (live preview)");
    assert.match(locked, /title="[^"]*previewing a run/);
});

await test("AnalysisLegend: the only legend, in plain words (Supported / Overhang / Overhang too long / Floating; Strength used (% of what the joints take))", () => {
    const legend = (analysis, colorBy) => html(h(ui.AnalysisLegend, { analysis, colorBy, theme: "light" }));
    const a = makeAnalysis();
    const status = legend(a, "status");
    assert.match(status, /aria-label="Block colours: status"/);
    assert.equal(textOf(status), "Supported 6 Overhang 4 Overhang too long 1 Floating 1");
    const reach = textOf(legend(a, "reach"));
    assert.equal(reach, "Supported 1 4 blocks from support Overhang too long Floating");
    const strength = legend(ORIGINAL, "stress");
    assert.match(strength, /aria-label="Block colours: strength used"/);
    assert.match(textOf(strength), /Strength used \(% of what the joints take\)/);
    // The bands add up and do not overlap: heavily loaded is 75-100%, overloaded is above 100% (S1; the estimate's own "stressed" count
    // includes the overloaded blocks). The arm here has 12 blocks that carry weight, 8 of them past the limit: none is merely heavy.
    assert.match(textOf(strength), /Heavily loaded \(75–100%\) 0 Overloaded \(above 100%\) 8/);
    assert.deepEqual([ORIGINAL.stress.analysedBlocks, ORIGINAL.stress.stressedBlocks, ORIGINAL.stress.overstressedBlocks], [12, 8, 8]);
    // That strength is the model's own weight only is said in words on the stage, not in a tooltip the chip stack never delivers (S6).
    assert.match(textOf(strength), /From its own weight only \(Concrete\)/);
    assert.doesNotMatch(strength, /title=/, "no tooltip carries a caveat the stage must state");
    assert.match(textOf(html(h(ui.AnalysisLegend, { analysis: { ...ORIGINAL, stress: { ...ORIGINAL.stress, material: "timber" } }, colorBy: "stress", theme: "light" }))), /From its own weight only \(Timber\)/);
    const added = legend(STABILIZED, "role");
    assert.match(added, /aria-label="Block colours: added blocks"/);
    assert.match(textOf(added), /Original blocks 12 Columns 5 Brackets 1/);
    const layers = legend(a, "layer");
    assert.match(layers, /aria-label="Block colours: layers"/);
    assert.match(textOf(layers), /Layers 1 8 8 × 100 mm/);
    // A colouring the result cannot do is drawn, and so explained, as status.
    assert.match(legend(a, "stress"), /Block colours: status/);
    assert.match(legend(a, "role"), /Block colours: status/);
    for (const markup of [status, reach, strength, added, layers]) assert.doesNotMatch(textOf(markup), /cantilever|overreach|allowable|load path|utilis|Over the limit/i, textOf(markup));
});

await test("S1: the stage's legend and the report's Strength section count 'heavily loaded' and 'overloaded' alike (three bands that add up)", () => {
    const { stressBands } = geom;
    assert.deepEqual(stressBands({ analysedBlocks: 12, stressedBlocks: 8, overstressedBlocks: 8 }), { over: 8, heavy: 0, fine: 4 });
    assert.deepEqual(stressBands({ analysedBlocks: 12, stressedBlocks: 8, overstressedBlocks: 3 }), { over: 3, heavy: 5, fine: 4 });
    assert.deepEqual(stressBands({ analysedBlocks: 12, stressedBlocks: 0, overstressedBlocks: 0 }), { over: 0, heavy: 0, fine: 12 });
    assert.deepEqual(stressBands({ analysedBlocks: 5, stressedBlocks: 5, overstressedBlocks: 5 }), { over: 5, heavy: 0, fine: 0 });
    for (const counts of [
        { stressedBlocks: 8, overstressedBlocks: 8 },
        { stressedBlocks: 8, overstressedBlocks: 3 },
        { stressedBlocks: 0, overstressedBlocks: 0 },
        { stressedBlocks: 12, overstressedBlocks: 1 },
    ]) {
        const result = { ...ORIGINAL, stress: { ...ORIGINAL.stress, analysedBlocks: 12, ...counts } };
        const { over, heavy, fine } = stressBands(result.stress);
        assert.equal(over + heavy + fine, 12, "every block that carries weight is in exactly one band");
        const legend = textOf(html(h(ui.AnalysisLegend, { analysis: result, colorBy: "stress", theme: "light" })));
        assert.match(legend, new RegExp(`Heavily loaded \\(75–100%\\) ${heavy} Overloaded \\(above 100%\\) ${over}\\b`), legend);
        // The report's section, rendered for the very same stress: its three counts are the legend's (and the 'fine' one, which the stage does not print).
        const panel = html(h(ui.TooltipProvider, null, h(ui.StrengthDetails, { result, onAbout: () => undefined })));
        const countIn = (id) => Number(textOf(panel.match(new RegExp(`<div[^>]*data-testid="${id}"[\\s\\S]*?</div>`))[0]).match(/\d+/)[0]);
        assert.deepEqual([countIn("stress-over"), countIn("stress-high"), countIn("stress-fine")], [over, heavy, fine], `the panel and the legend agree for ${JSON.stringify(counts)}`);
    }
});

const toolbarProps = (extra = {}) => ({
    compact: false,
    blocks: true,
    partCount: 0,
    treeOpen: false,
    onToggleTree: () => undefined,
    onView: () => undefined,
    onZoom: () => undefined,
    canExplode: false,
    explode: 0,
    onExplode: () => undefined,
    canSplit: false,
    split: "off",
    splitProgress: 0,
    onSplit: () => undefined,
    downloadUrl: "/m.glb",
    downloadName: "m",
    ...extra,
});
const toolbar = (extra) => html(h(ui.TooltipProvider, null, h(ui.ViewerToolbar, toolbarProps(extra))));

await test("the toolbar of the block view: a Layers button with a '1–7' badge when the cut hides something, and a Show menu; no Parts, Explode or Split", () => {
    const { layerCut } = stageControls;
    const ten = layersOf(10);
    const show = { cog: true, onCog: () => undefined, ghost: false, onGhost: () => undefined };
    const cutOn = toolbar({ layers: { cut: layerCut(ten, 6, 100), onChange: () => undefined }, show });
    assert.match(cutOn, /data-testid="stage-layers"/);
    assert.match(cutOn, /aria-label="Layers, showing 1–7"/);
    assert.match(cutOn, /aria-expanded="false"/);
    assert.match(textOf(cutOn), /Layers 1–7/, "the visible name and the badge");
    assert.match(cutOn, /data-testid="stage-show"/);
    assert.match(cutOn, /aria-label="Show"/);
    for (const gone of ['aria-label="Parts"', 'aria-label="Explode"', 'aria-label="Split into parts"']) assert.ok(!cutOn.includes(gone), gone);
    assert.match(cutOn, /aria-label="Fit"/, "the rest of the bar is as it was");
    assert.match(cutOn, /aria-label="Download GLB"/);
    // Nothing hidden: no badge, the plain name.
    const all = toolbar({ layers: { cut: layerCut(ten, 9, 100), onChange: () => undefined }, show });
    assert.match(all, /aria-label="Layers"/);
    assert.doesNotMatch(all, /showing/);
    assert.doesNotMatch(textOf(all), /1–/);
    // A narrow stage keeps the icons and drops the words (the names stay for assistive technology).
    const narrow = toolbar({ compact: true, layers: { cut: layerCut(ten, 6, 100), onChange: () => undefined }, show });
    assert.match(narrow, /aria-label="Layers, showing 1–7"/);
    assert.doesNotMatch(textOf(narrow), /Layers|Show/);
    // Without the host's handlers the controls are not offered; in the model view they are never.
    const bare = toolbar({});
    assert.ok(!bare.includes("stage-layers") && !bare.includes("stage-show"));
    const model = toolbar({ blocks: false, canExplode: true, partCount: 3, layers: { cut: layerCut(ten, 6, 100), onChange: () => undefined }, show });
    assert.ok(!model.includes("stage-layers") && !model.includes("stage-show"), "the model view has no block controls");
    assert.match(model, /aria-label="Parts"/);
    assert.match(model, /aria-label="Explode"/);
    // Only Layers, or only Show: each alone.
    const layersOnly = toolbar({ layers: { cut: layerCut(ten, 6, 100), onChange: () => undefined } });
    assert.ok(layersOnly.includes("stage-layers") && !layersOnly.includes("stage-show"));
    const showOnly = toolbar({ show });
    assert.ok(!showOnly.includes("stage-layers") && showOnly.includes("stage-show"));
});

await test("the Layers popover: 'Layers 1–7 of 10', 'up to 700 mm', a slider over the layers, Show all (off while nothing is cut), and the raised note", () => {
    const { layerCut } = stageControls;
    const ten = layersOf(10);
    const pop = (cut, raised) => html(h(ui.LayersPopover, { cut, raised, onChange: () => undefined, onClose: () => undefined }));
    const cutOn = pop(layerCut(ten, 6, 100), false);
    assert.match(cutOn, /role="group"[^>]*aria-label="Layers"|aria-label="Layers"[^>]*role="group"/);
    assert.match(cutOn, /<label[^>]*for="stage-layers"[^>]*>Layers 1–7 of 10<\/label>/);
    assert.match(textOf(cutOn), /up to 700 mm/);
    assert.match(cutOn, /<input[^>]*type="range"[^>]*min="0"[^>]*max="9"[^>]*step="1"[^>]*value="6"/);
    assert.match(cutOn, /aria-valuetext="Layers 1–7 of 10, up to 700 mm"/);
    assert.doesNotMatch(cutOn, /<button[^>]*\sdisabled(=""|\s|>)/, "Show all works while something is cut");
    assert.doesNotMatch(textOf(cutOn), /raised/);
    const all = pop(layerCut(ten, 9, 100), true);
    assert.match(all, /<button[^>]*\sdisabled=""[^>]*>Show all<\/button>/, "everything is shown: nothing to show");
    assert.match(textOf(all), /The cut was raised to show what you picked\./);
    const one = pop(layerCut(layersOf(1), 0, 100), false);
    assert.match(one, /<input[^>]*\sdisabled=""/, "one layer: nothing to cut");
    assert.doesNotMatch(cutOn, /<input[^>]*\sdisabled=""/, "and a model with layers can be cut");
});

await test("P3: the compare chip, the compare state and the 'Stabilized from' chip are gone; the Colour chip sits right above the legend", () => {
    const viewerDir = nodePath.join(repoRoot, "src/assignment/viewer");
    assert.ok(!existsSync(nodePath.join(viewerDir, "CompareChip.tsx")));
    assert.ok(!existsSync(nodePath.join(viewerDir, "compareState.ts")));
    const source = readFileSync(nodePath.join(viewerDir, "GlbViewer.tsx"), "utf8");
    for (const gone of ["CompareChip", "compareState", "compareStatus", "onCompareChange", "derivedFrom", "ORIGINAL_WAIT_MS", "Stabilized from", "View original"]) assert.ok(!source.includes(gone), `GlbViewer still mentions ${gone}`);
    for (const there of ["onViewChange", "layerRaised", "<ColorChip", "<AnalysisLegend"]) assert.ok(source.includes(there), `GlbViewer lacks ${there}`);
    assert.ok(source.indexOf("<ColorChip") < source.indexOf("<AnalysisLegend"), "the legend comes right after the Colour chip");
    // The legend is drawn by the viewer alone.
    const users = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = nodePath.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.tsx?$/.test(entry.name) && /import[^;]*\bAnalysisLegend\b/.test(readFileSync(full, "utf8"))) users.push(nodePath.relative(repoRoot, full));
        }
    };
    walk(nodePath.join(repoRoot, "src/assignment"));
    assert.deepEqual(users, ["src/assignment/viewer/GlbViewer.tsx"]);
});

// ---------- the stage between two versions (S2) ----------

console.log("the stage between two versions (stageHold)");

const { holdStage, useHeldStage, stageColorBy } = await import("../../src/assignment/components/workspace/stageHold.ts");

await test("S2: a version whose own analysis is still on its way is drawn over the last picture; the report never gets it", () => {
    const source = { id: "source's result" };
    const preview = { id: "the run's final preview" };
    const landed = { id: "the stabilized version's result" };
    const on = { url: "/m.glb", family: "m" };
    // The run is finishing: the stage draws the preview of the source, whose own result is there too.
    const running = holdStage(null, { ...on, own: source, preview, waiting: false });
    assert.equal(running.analysis, source, "the viewer is handed the model's own result (it draws the preview over it)");
    assert.equal(running.holding, false);
    assert.equal(running.held?.result, preview, "what the stage draws is what is kept: the preview wins");
    // The run is saved and the new version opens by itself: no result, no preview, the analysis not started yet or running.
    for (const phase of ["loading", "running"]) {
        const between = holdStage(running.held, { ...on, own: null, preview: null, waiting: true });
        assert.equal(between.analysis, preview, `${phase}: the stage keeps drawing the last picture, so it never falls back to the plain mesh`);
        assert.equal(between.holding, true, "and says so, so the host ignores hovers and clicks on blocks that are not the report's");
        assert.equal(between.held, running.held, "the hold is kept as it was");
    }
    // The version's own result lands: that is drawn, and kept in turn.
    const done = holdStage(running.held, { ...on, own: landed, preview: null, waiting: false });
    assert.deepEqual([done.analysis, done.holding, done.held?.result], [landed, false, landed]);
    // A flip back (same mesh, the other model's result is gone from the store): the stabilized picture is held while the original's analysis runs.
    const back = holdStage(done.held, { ...on, own: null, preview: null, waiting: true });
    assert.deepEqual([back.analysis, back.holding], [landed, true]);
    // The same inputs give the same hold: a render that is thrown away leaves nothing behind.
    assert.equal(holdStage(done.held, { ...on, own: landed, preview: null, waiting: false }).held, done.held);
});

await test("S2: nothing is held for a stage that is not coming back: another mesh, another model, a failed analysis, a viewer that cannot show it", () => {
    const picture = { id: "picture" };
    const held = holdStage(null, { url: "/m.glb", family: "m", own: picture, preview: null, waiting: false }).held;
    const wait = { own: null, preview: null, waiting: true };
    assert.equal(holdStage(held, { ...wait, url: "/m.glb", family: "m" }).analysis, picture, "the control: same mesh, same family");
    for (const [name, input] of [
        ["another mesh (the source failed to load, so the version shows its own file)", { ...wait, url: "/s1.glb", family: "m" }],
        ["another model's family", { ...wait, url: "/m.glb", family: "other" }],
        ["no mesh on stage", { ...wait, url: null, family: "m" }],
        ["the analysis failed (the plain stage and the error are the honest picture)", { ...wait, url: "/m.glb", family: "m", waiting: false }],
    ]) {
        const out = holdStage(held, input);
        assert.deepEqual([out.analysis, out.holding, out.held], [null, false, null], name);
    }
    // Nothing was ever drawn: nothing to hold.
    assert.deepEqual(holdStage(null, { ...wait, url: "/m.glb", family: "m" }), { analysis: null, held: null, holding: false });
    // The active model's own result is always handed over as it is, hold or no hold.
    assert.equal(holdStage(held, { url: "/m.glb", family: "m", own: picture, preview: null, waiting: true }).analysis, picture);
});

await test("S2: while a picture is held it is coloured as the user asked (the store settled that choice against the other version's result)", () => {
    assert.equal(stageColorBy("status", "role", true), "role");
    assert.equal(stageColorBy("status", "role", false), "status", "no hold: the store's settled colouring, as ever");
    assert.equal(stageColorBy("stress", "stress", true), "stress");
});

await test("S2: the hook keeps the hold between renders and lets go of it when the mesh changes", () => {
    const source = { id: "source" };
    const preview = { id: "preview" };
    const landed = { id: "landed" };
    const on = { url: "/m.glb", family: "m" };
    const hook = renderHook(useHeldStage, { ...on, own: source, preview, waiting: false });
    assert.deepEqual(hook.result, { analysis: source, holding: false });
    hook.rerender({ ...on, own: null, preview: null, waiting: true }); // the saved run opens the new version
    assert.deepEqual(hook.result, { analysis: preview, holding: true });
    hook.rerender({ ...on, own: null, preview: null, waiting: true }); // still on its way (the analysis starts)
    assert.deepEqual(hook.result, { analysis: preview, holding: true });
    hook.rerender({ ...on, own: landed, preview: null, waiting: false });
    assert.deepEqual(hook.result, { analysis: landed, holding: false });
    hook.rerender({ ...on, own: null, preview: null, waiting: true }); // flipped to the other version
    assert.deepEqual(hook.result, { analysis: landed, holding: true });
    hook.rerender({ url: "/other.glb", family: "o", own: null, preview: null, waiting: true }); // another model altogether
    assert.deepEqual(hook.result, { analysis: null, holding: false });
    hook.rerender({ ...on, own: null, preview: null, waiting: true }); // and back: what was held is gone
    assert.deepEqual(hook.result, { analysis: null, holding: false });
    hook.unmount();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
