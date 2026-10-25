// Tests for the mesh editor (spec 8.1, B2): the program cleaner (shared/meshProgram.ts), the reader, the frame, the ops and their guards,
// the writer (every output goes through Khronos' gltf-validator: 0 errors, 0 warnings, 0 hints, and is read back with @gltf-transform/core),
// the pictures the model reads, the session that ties them together, and the upload's checks (worker/editUpload.ts, the pure part).
//
//   node scripts/assignment/test-edit-mesh.mjs
//
// The real Hunyuan model (a 27.8 MB fixture, not part of the repo: HUNYUAN_GLB or the scratchpad copy) is used when it is there and skipped
// with a note when it is not. The browser's canvas is replaced by `sharp` (what wrangler installs) wherever a picture is decoded or encoded.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const R = (p) => import(`../../src/assignment/${p}`);
const W = (p) => import(`../../worker/${p}`);
const { sanitizeProgram, toExecutorOp, needsRefine, factsText, meshUserText, flatAnswerOf, MESH_PROGRAM_SCHEMA, MESH_SYSTEM_PROMPT } = await R("shared/meshProgram.ts");
const { MAX_MESH_OPS, MAX_ADDED_PARTS, MAX_EDIT_TRIANGLES, EDIT_PACKAGE_LIMIT, EDITED_GLB_LIMIT } = await R("shared/contract.ts");
const { readMeshGlb, imageUv } = await R("edit/readMeshGlb.ts");
const { parseGlb, localMatrix, multiply, worldMatrices } = await R("edit/gltf.ts");
const { buildEditSetup, makeFrame, toFrame, fromFrame } = await R("edit/frame.ts");
const { selectionWeights } = await R("edit/selection.ts");
const { weldIds } = await R("edit/weld.ts");
const { runProgram } = await R("edit/runProgram.ts");
const { makeState, OPS } = await R("edit/ops.ts");
const { refreshNormals } = await R("edit/normals.ts");
const { writeEditedGlb, assembleGlb } = await R("edit/patchGlb.ts");
const { MeshEditError } = await R("edit/types.ts");
const { rasterize, drawGrid, drawText, VIEWS } = await R("edit/rasterize.ts");
const { encodePng } = await R("edit/png.ts");
const { describeMesh, zoomViews, mainColorNames, zoomBox } = await R("edit/describeMesh.ts");
const { openSession } = await R("edit/session.ts");
const { applyPaints, tintImage, uvMask, sampleVertexColors, stackCopyPicture } = await R("edit/texture.ts");
const { checkEditedGlbJson, readEditedHeader, readEditedBinHeader, buildMeshEditMeta, editLabel } = await W("editUpload.ts");
const { readEditMeta } = await R("shared/versionMeta.ts");
const { sharpCodec, sharpJpeg, hasHunyuan, readHunyuan, HUNYUAN_GLB } = await import("./edit-test-support.mjs");
const { NodeIO, Document } = await import("@gltf-transform/core");
const validator = (await import("gltf-validator")).default;
const { Logger } = await import("@gltf-transform/core");
const codec = await sharpCodec();
const sharp = codec ? (await import("sharp")).default : null;

let passed = 0;
const failures = [];
const notes = []; // things that were skipped
const facts = []; // measurements worth reporting
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`);
    }
}
const skip = (name, why) => {
    notes.push(`${name}: ${why}`);
    console.log(`  skip ${name} (${why})`);
};
const section = (title) => console.log(`\n== ${title}`);

// ---------- builders ----------

/** A closed box as 6 separate faces (flat normals, duplicated edge vertices), each face a grid of nu x nv quads. Millimetres, Z up, winding outward. */
function boxGrid(x0, x1, y0, y1, z0, z1, seg = [1, 1, 1]) {
    const pos = [], idx = [];
    const face = (O, U, V, a, b) => {
        // outward means (U x V) points away from the centre of the box
        const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
        const n = [U[1] * V[2] - U[2] * V[1], U[2] * V[0] - U[0] * V[2], U[0] * V[1] - U[1] * V[0]];
        const mid = [O[0] + (U[0] + V[0]) / 2 - c[0], O[1] + (U[1] + V[1]) / 2 - c[1], O[2] + (U[2] + V[2]) / 2 - c[2]];
        const flip = n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0;
        const base = pos.length / 3;
        for (let j = 0; j <= b; j++) for (let i = 0; i <= a; i++) pos.push(O[0] + (U[0] * i) / a + (V[0] * j) / b, O[1] + (U[1] * i) / a + (V[1] * j) / b, O[2] + (U[2] * i) / a + (V[2] * j) / b);
        for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) {
            const p = base + j * (a + 1) + i, q = p + 1, r = p + a + 1, s = r + 1;
            if (flip) idx.push(p, r, q, q, r, s); else idx.push(p, q, r, q, s, r);
        }
    };
    const dx = [x1 - x0, 0, 0], dy = [0, y1 - y0, 0], dz = [0, 0, z1 - z0];
    face([x0, y0, z0], dx, dy, seg[0], seg[1]); face([x0, y0, z1], dx, dy, seg[0], seg[1]);
    face([x0, y0, z0], dx, dz, seg[0], seg[2]); face([x0, y1, z0], dx, dz, seg[0], seg[2]);
    face([x0, y0, z0], dy, dz, seg[1], seg[2]); face([x1, y0, z0], dy, dz, seg[1], seg[2]);
    return { pos, idx };
}
function merge(parts) {
    const pos = [], idx = [];
    for (const p of parts) { const base = pos.length / 3; pos.push(...p.pos); idx.push(...p.idx.map((i) => i + base)); }
    return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}
/** An EditMesh (the executor's input) from boxes, in the edit frame. */
function meshOf(parts) {
    const m = merge(parts);
    const n = m.pos.length / 3;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = (m.pos[i * 3] % 1000) / 1000 + 0.001 * (i % 7); uv[i * 2 + 1] = (m.pos[i * 3 + 2] % 1000) / 1000; }
    const mesh = { Q: m.pos, uv, nor: new Float32Array(n * 3), idx: m.idx };
    refreshNormals(mesh.Q, mesh.idx, mesh.nor, null);
    return mesh;
}
/** A stool: a seat, four legs and two back posts joined by a rail (mm, Z up; 600 wide, 1000 high). */
function stoolParts() {
    // The legs and the posts reach into the seat (410 / 440) and the rail sits inside the posts' width: every box is its own closed
    // surface, with no vertex shared with another (a welded edge then belongs to exactly two triangles).
    return [
        boxGrid(-300, 300, -300, 300, 400, 450, [6, 6, 1]), // seat
        boxGrid(-290, -250, -290, -250, 0, 410, [1, 1, 8]), boxGrid(250, 290, -290, -250, 0, 410, [1, 1, 8]),
        boxGrid(-290, -250, 250, 290, 0, 410, [1, 1, 8]), boxGrid(250, 290, 250, 290, 0, 410, [1, 1, 8]),
        boxGrid(-290, -250, 250, 290, 440, 1000, [1, 1, 11]), boxGrid(250, 290, 250, 290, 440, 1000, [1, 1, 11]), // back posts
        boxGrid(-290, 290, 255, 285, 800, 900, [10, 1, 2]), // rail
    ];
}
const program = (ops, summary = "test") => ({ summary, applied: true, ops });
const op = (o) => ({ label: o.op, boxes: [], exclude: [], feather_mm: 20, axis: "z", ...o });
const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

/** Signed volume of the triangles `from..to` (the divergence theorem); positive for outward winding of a closed surface. */
function signedVolume(Q, idx, from = 0, to = idx.length / 3) {
    let v = 0;
    for (let t = from; t < to; t++) {
        const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
        v += (Q[a] * (Q[b + 1] * Q[c + 2] - Q[b + 2] * Q[c + 1]) - Q[a + 1] * (Q[b] * Q[c + 2] - Q[b + 2] * Q[c]) + Q[a + 2] * (Q[b] * Q[c + 1] - Q[b + 1] * Q[c])) / 6;
    }
    return v;
}
/** Is every welded edge shared by exactly two triangles (a closed, manifold surface)? Returns the number of edges that are not. */
function openEdges(Q, idx) {
    const { ids, count } = weldIds(Q);
    const seen = new Map();
    for (let t = 0; t < idx.length / 3; t++) {
        for (let k = 0; k < 3; k++) {
            const a = ids[idx[t * 3 + k]], b = ids[idx[t * 3 + ((k + 1) % 3)]];
            if (a === b) continue;
            const key = a < b ? a * count + b : b * count + a;
            seen.set(key, (seen.get(key) ?? 0) + 1);
        }
    }
    let bad = 0;
    for (const n of seen.values()) if (n !== 2) bad++;
    return bad;
}
const bounds = (Q) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < Q.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], Q[i + a]); max[a] = Math.max(max[a], Q[i + a]); }
    return { min, max };
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ============================================================ shared/meshProgram.ts
section("the program cleaner (sanitizeProgram)");

await test("a clean program passes and the three stored model answers read back as programs", async () => {
    const stretch = { summary: "Stretched the backrest.", applied: true, regen_prompt: "a taller rocking chair", ops: [{ op: "stretch", label: "backrest", boxes: [{ max: [320, 360, 1020], min: [-320, 80, 350] }], exclude: [], feather_mm: 40, axis: "z", from_mm: 600, to_mm: 900, amount_mm: 150, vector_mm: [0, 0, 0], factors: [1, 1, 1], pivot_mm: [0, 0, 0], degrees: 0, mirror_at_mm: 0, color: "#000000", strength: 0, parts: [] }] };
    const r = sanitizeProgram(stretch);
    assert.ok(r.ok);
    assert.equal(r.program.ops.length, 1);
    assert.deepEqual(r.program.ops[0].boxes, [box(-320, 80, 350, 320, 360, 1020)]);
    assert.equal(r.regen_prompt, "a taller rocking chair");
    assert.deepEqual(r.notes, []);
});

await test("applied false is a success with no ops; no ops list is not", async () => {
    const r = sanitizeProgram({ summary: "Cannot paint a photo", applied: false, ops: [], regen_prompt: "" });
    assert.ok(r.ok);
    assert.equal(r.program.applied, false);
    assert.deepEqual(r.program.ops, []);
    assert.equal(r.regen_prompt, null);
    for (const bad of [null, 5, "x", [], {}, { ops: "no" }]) assert.equal(sanitizeProgram(bad).ok, false);
    assert.equal(sanitizeProgram({ applied: true, ops: [] }).ok, false);
});

await test("every bound: ops, boxes, numbers, selections, colours, parts", async () => {
    const wild = { summary: "x".repeat(900), applied: true, ops: [] };
    for (let i = 0; i < 30; i++) wild.ops.push({ op: "move", label: "y".repeat(200), boxes: Array.from({ length: 20 }, () => ({ min: [9e9, -9e9, 5], max: [-9e9, 9e9, 5] })), exclude: [], feather_mm: 1e9, axis: "q", vector_mm: [1e9, -1e9, 0] });
    const r = sanitizeProgram(wild);
    assert.ok(r.ok);
    assert.equal(r.program.ops.length, MAX_MESH_OPS);
    assert.equal(r.program.summary.length <= 160, true);
    for (const o of r.program.ops) {
        assert.equal(o.boxes.length, 8);
        assert.equal(o.label.length <= 60, true);
        assert.equal(o.feather_mm, 200);
        assert.equal(o.axis, "z");
        assert.deepEqual(o.vector_mm, [1500, -1500, 0]);
        for (const b of o.boxes) for (let a = 0; a < 3; a++) { assert.ok(b.min[a] <= b.max[a]); assert.ok(b.max[a] - b.min[a] >= 1); assert.ok(Math.abs(b.min[a]) <= 3001 && Math.abs(b.max[a]) <= 3001); }
    }
    assert.ok(r.notes.some((n) => /first 12/.test(n)));
    // refusals and drops
    const cases = [
        [{ op: "delete", label: "x", boxes: [] }, /delete/],
        [{ op: "mirror_copy", label: "x", boxes: [] }, /mirror/],
        [{ op: "stretch", label: "x", boxes: [], from_mm: 5, to_mm: 9, amount_mm: 0 }, /stretch by 0/],
        [{ op: "recolor", label: "x", boxes: [], color: "green" }, /colour/],
        [{ op: "add_parts", label: "x", parts: [{ shape: "blob", size: [1, 1, 1], position: [0, 0, 0] }] }, /parts/],
        [{ op: "explode", label: "x" }, /unknown/],
        [{ op: "move", label: "x", vector_mm: [0, 0, 0] }, /move by 0/],
        [{ op: "scale", label: "x", factors: [1, 1, 1] }, /scale by 1/],
        [{ op: "rotate", label: "x", degrees: 0 }, /rotate by 0/],
    ];
    for (const [o, why] of cases) {
        const one = sanitizeProgram({ summary: "s", applied: true, ops: [o, { op: "recolor", label: "ok", boxes: [], color: "#00ff00", strength: 1 }] });
        assert.ok(one.ok, JSON.stringify(o));
        assert.equal(one.program.ops.length, 1, JSON.stringify(o));
        assert.ok(one.notes.some((n) => why.test(n)), `${JSON.stringify(o)} -> ${one.notes}`);
    }
    // an answer of only dropped ops is not a program
    assert.equal(sanitizeProgram({ summary: "s", applied: true, ops: [{ op: "delete", label: "x", boxes: [] }] }).ok, false);
});

await test("add_parts: shapes, sizes, angles and colours are repaired; at most MAX_ADDED_PARTS in all", async () => {
    const part = (i) => ({ name: "cup", shape: i % 2 ? "torus" : "capsule", size: [-30, 50, 900000], position: [1e7, 0, 5], rotation: [400, 0, 0], color: "nope" });
    const r = sanitizeProgram({ summary: "s", applied: true, ops: [{ op: "add_parts", label: "cups", parts: Array.from({ length: 30 }, (_, i) => part(i)) }, { op: "add_parts", label: "more", parts: Array.from({ length: 30 }, (_, i) => part(i)) }] });
    assert.ok(r.ok);
    const all = r.program.ops.flatMap((o) => o.parts);
    assert.equal(all.length, MAX_ADDED_PARTS);
    const names = new Set(r.program.ops[0].parts.map((p) => p.name));
    assert.equal(names.size, r.program.ops[0].parts.length, "names are unique");
    for (const p of all) {
        assert.ok(p.size.every((s, i) => s <= 1000 && (s >= 5 || (p.shape === "torus" && i === 2))));
        assert.ok(Math.abs(p.position[0]) <= 3000);
        assert.ok(p.rotation.every((d) => d > -180 && d <= 180));
        assert.match(p.color, /^#[0-9a-f]{6}$/);
        if (p.shape === "torus") assert.ok(p.size[2] <= p.size[0] * 0.4 + 1e-9);
        if (p.shape === "capsule") assert.ok(p.size[2] >= p.size[0]);
    }
});

await test("fuzz: 3000 random answers never throw and every program obeys its bounds; a clean program is stable under a second clean", async () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const junk = () => pick([null, undefined, NaN, Infinity, -Infinity, "12", "#ff0000", [], {}, [1, 2], [1, 2, 3], [NaN, 1, 2], true, 1e300, -1e300, 0, 7, -3.5, "x".repeat(300), { min: [1, 2, 3], max: [3, 2, 1] }]);
    const maybe = (v) => (rnd() < 0.8 ? v : junk());
    const num = () => maybe((rnd() - 0.5) * pick([1, 10, 1e3, 1e6]));
    const v3 = () => maybe([num(), num(), num()]);
    const bx = () => maybe({ min: v3(), max: v3() });
    const OPS = ["stretch", "move", "scale", "rotate", "delete", "recolor", "add_parts", "mirror_copy", "bogus", 5, null];
    for (let n = 0; n < 3000; n++) {
        const ops = Array.from({ length: Math.floor(rnd() * 16) }, () => maybe({
            op: pick(OPS), label: maybe("a label"), boxes: maybe(Array.from({ length: Math.floor(rnd() * 12) }, bx)), exclude: maybe(Array.from({ length: Math.floor(rnd() * 12) }, bx)),
            feather_mm: num(), axis: pick(["x", "y", "z", "w", 1]), from_mm: num(), to_mm: num(), amount_mm: num(), vector_mm: v3(), factors: v3(), pivot_mm: v3(), degrees: num(), mirror_at_mm: num(),
            color: maybe(pick(["#00ff00", "00ff00", "#0f0", "blue"])), strength: num(),
            parts: maybe(Array.from({ length: Math.floor(rnd() * 50) }, () => maybe({ name: maybe("p"), shape: maybe(pick(["box", "cylinder", "torus", "capsule", "sphere", "cone", "blob"])), size: v3(), position: v3(), rotation: v3(), color: maybe("#112233") }))),
        }));
        const answer = pick([{ summary: maybe("s"), applied: maybe(true), ops: maybe(ops), regen_prompt: maybe("r") }, ops, junk()]);
        const r = sanitizeProgram(answer);
        if (!r.ok) continue;
        const p = r.program;
        assert.ok(p.ops.length <= MAX_MESH_OPS);
        assert.ok(p.summary.length <= 160);
        let parts = 0;
        for (const o of p.ops) {
            assert.ok(o.boxes.length <= 8 && o.exclude.length <= 8);
            assert.ok(o.feather_mm >= 0.5 && o.feather_mm <= 200);
            if (o.op === "delete" || o.op === "mirror_copy") assert.ok(o.boxes.length > 0);
            if (o.op === "stretch") { assert.ok(o.amount_mm !== 0 && Math.abs(o.amount_mm) <= 1500); assert.ok(o.to_mm - o.from_mm >= 1 - 1e-9); }
            if (o.op === "scale") assert.ok(o.factors.every((f) => f >= 0.1 && f <= 5));
            if (o.op === "rotate") assert.ok(Math.abs(o.degrees) <= 360 && o.degrees !== 0);
            if (o.op === "recolor") { assert.match(o.color, /^#[0-9a-f]{6}$/); assert.ok(o.strength > 0 && o.strength <= 1); }
            for (const b of [...o.boxes, ...o.exclude]) for (let a = 0; a < 3; a++) assert.ok(Number.isFinite(b.min[a]) && Number.isFinite(b.max[a]) && b.min[a] < b.max[a] && Math.abs(b.min[a]) <= 3001);
            parts += o.parts?.length ?? 0;
        }
        assert.ok(parts <= MAX_ADDED_PARTS);
        // cleaning a clean program changes nothing
        const again = sanitizeProgram(p);
        assert.ok(again.ok);
        assert.deepEqual(again.program, p);
    }
});

await test("a cleaned program goes back to the flat answer shape (for the second pass) and cleans to itself", async () => {
    const r = sanitizeProgram({ summary: "s", applied: true, regen_prompt: "again", ops: [
        { op: "stretch", label: "a", boxes: [{ min: [0, 0, 0], max: [10, 10, 10] }], exclude: [], feather_mm: 30, axis: "z", from_mm: 5, to_mm: 8, amount_mm: 50 },
        { op: "add_parts", label: "b", parts: [{ name: "p", shape: "box", size: [10, 10, 10], position: [1, 2, 3], rotation: [0, 0, 0], color: "#112233" }] },
        { op: "recolor", label: "c", boxes: [], color: "#00ff00", strength: 0.5 },
    ] });
    assert.ok(r.ok);
    const flat = flatAnswerOf(r.program, r.regen_prompt);
    const schema = MESH_PROGRAM_SCHEMA.schema;
    assert.deepEqual(Object.keys(flat).sort(), [...schema.required].sort());
    for (const o of flat.ops) assert.deepEqual(Object.keys(o).sort(), [...schema.properties.ops.items.required].sort(), "every field of the strict schema is there");
    const again = sanitizeProgram(JSON.parse(JSON.stringify(flat)));
    assert.ok(again.ok);
    assert.deepEqual(again.program, r.program);
    assert.equal(again.regen_prompt, "again");
});

await test("the request: strict schema (every op field required), prompt text, user message, facts", async () => {
    const op = MESH_PROGRAM_SCHEMA.schema.properties.ops.items;
    assert.equal(MESH_PROGRAM_SCHEMA.strict, true);
    assert.deepEqual([...MESH_PROGRAM_SCHEMA.schema.required], ["summary", "applied", "ops", "regen_prompt"]);
    assert.deepEqual([...op.required].sort(), Object.keys(op.properties).sort());
    assert.equal(MESH_PROGRAM_SCHEMA.schema.additionalProperties, false);
    assert.equal(op.additionalProperties, false);
    assert.match(MESH_SYSTEM_PROMPT, /EDIT PROGRAM/);
    assert.match(MESH_SYSTEM_PROMPT, /Units are millimetres/); // the part format paragraph of the designer's prompt
    assert.ok(!/^You design/.test(MESH_SYSTEM_PROMPT.split("Part format for add_parts: ")[1]));
    const facts = factsText({ sizeMm: [643.2, 850.7, 1000], tris: 499808, colors: ["brown 81%"] });
    assert.match(facts, /size X 643 mm, Y 851 mm, Z 1000 mm; 499,808 triangles; textured; main colours brown 81%/);
    assert.match(facts, /faces -Y .* LEFT hand side is \+X and its RIGHT is -X/);
    const text = meshUserText({ facts, views: [{ id: "FRONT", caption: "FRONT view", image: "data:" }], pieces: null, extras: null, original_prompt: "a rocking chair" }, "  make the\nbackrest taller ");
    assert.equal(text.split("\n").at(-1), "Edit instruction: make the backrest taller");
    assert.match(text, /Original description: "a rocking chair"/);
    assert.equal(needsRefine({ ops: [{ op: "delete" }] }), false, "the second pass is off (MESH_REFINE_OPS is empty)");
});

// ============================================================ selection, welding, normals
section("selection, welding and normals");

await test("selection weights: no box = everything, inside 1, outside 0, feathered edge between, exclude removes, skipAxis ignores one axis", async () => {
    const Q = Float32Array.from([0, 0, 0, 100, 100, 100, 190, 0, 0, 200, 0, 0, 210, 0, 0, 300, 0, 0]);
    const all = selectionWeights(Q, { boxes: [], exclude: [], feather_mm: 20 });
    assert.deepEqual([...all], [1, 1, 1, 1, 1, 1]);
    const w = selectionWeights(Q, { boxes: [box(-10, -10, -10, 200, 110, 110)], exclude: [], feather_mm: 20 });
    assert.equal(w[0], 1);
    assert.equal(w[1], 1);
    assert.ok(w[2] === 1, "190 is inside the box (200) minus half the feather (10)");
    assert.ok(w[3] > 0.4 && w[3] < 0.6, `on the face: ${w[3]}`);
    assert.ok(w[4] === 0, `10 mm beyond the face is outside: ${w[4]}`);
    assert.equal(w[5], 0);
    const ex = selectionWeights(Q, { boxes: [box(-10, -10, -10, 400, 110, 110)], exclude: [box(150, -50, -50, 250, 50, 50)], feather_mm: 1 });
    assert.equal(ex[0], 1);
    assert.equal(ex[2], 0);
    assert.equal(ex[3], 0);
    assert.equal(ex[5], 1);
    // skipAxis: only the footprint counts
    const foot = selectionWeights(Float32Array.from([0, 0, 5000]), { boxes: [box(-10, -10, 0, 10, 10, 1)], exclude: [], feather_mm: 2 }, 2);
    assert.equal(foot[0], 1);
});

await test("weldIds: bit-identical points share an id (a texture seam), others do not; the same id is stable across calls", async () => {
    const Q = Float32Array.from([1, 2, 3, 1, 2, 3, 1.1, 2, 3, 9, 9, 9, 1, 2, 3]);
    const { ids, count } = weldIds(Q);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[0], ids[4]);
    assert.notEqual(ids[0], ids[2]);
    assert.equal(count, 3);
    const big = new Float32Array(300_000 * 3);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) % 997;
    const t0 = performance.now();
    weldIds(big);
    assert.ok(performance.now() - t0 < 500, "300k points weld in well under a second");
});

await test("normals: normals stay unit length after a stretch; vertices that did not move keep theirs exactly", async () => {
    const mesh = meshOf([boxGrid(0, 100, 0, 100, 0, 300, [1, 1, 6])]);
    const before = Float32Array.from(mesh.nor);
    const Q0 = Float32Array.from(mesh.Q);
    const { state } = runProgram(mesh, program([op({ op: "stretch", axis: "z", from_mm: 100, to_mm: 200, amount_mm: 60, feather_mm: 1, boxes: [box(-10, -10, 0, 110, 110, 400)] })]));
    let moved = 0;
    for (let v = 0; v < state.Q.length / 3; v++) {
        const len = Math.hypot(state.nor[v * 3], state.nor[v * 3 + 1], state.nor[v * 3 + 2]);
        assert.ok(near(len, 1, 1e-4));
        if (state.Q[v * 3 + 2] !== Q0[v * 3 + 2]) moved++;
        else for (let k = 0; k < 3; k++) assert.equal(state.nor[v * 3 + k], before[v * 3 + k], "a vertex that did not move keeps its normal");
    }
    assert.ok(moved > 0);
});

// ============================================================ the ops
section("the ops on a stool");

await test("stretch: posts stay continuous, everything above moves rigidly, below does not move, the surface stays closed", async () => {
    const mesh = meshOf(stoolParts());
    const Q0 = Float32Array.from(mesh.Q);
    const amount = 120, from = 600, to = 800;
    const { state } = runProgram(mesh, program([op({ op: "stretch", label: "back", axis: "z", from_mm: from, to_mm: to, amount_mm: amount, feather_mm: 20, boxes: [box(-300, 230, 420, 300, 300, 1100)] })]));
    assert.equal(state.Q.length, Q0.length, "no vertex added or removed");
    let above = 0, below = 0, between = 0;
    for (let v = 0; v < Q0.length / 3; v++) {
        const z0 = Q0[v * 3 + 2], z1 = state.Q[v * 3 + 2];
        const inBack = Q0[v * 3 + 1] > 240;
        if (!inBack) { assert.equal(z1, z0, "the front legs and the seat are not touched"); continue; }
        if (z0 <= from) { assert.ok(near(z0, z1, 1e-3)); below++; }
        else if (z0 >= to) { assert.ok(near(z1, z0 + amount, 1e-2), `${z0} -> ${z1}`); above++; }
        else { assert.ok(z1 > z0 && z1 < z0 + amount); between++; }
        assert.equal(state.Q[v * 3], Q0[v * 3], "x does not change");
    }
    assert.ok(above > 0 && below > 0 && between > 0, `${above} ${below} ${between}`);
    // continuity: no triangle edge grows by more than the stretch factor of the zone
    const factor = 1 + amount / (to - from);
    for (let t = 0; t < mesh.idx.length / 3; t++) {
        for (let k = 0; k < 3; k++) {
            const a = mesh.idx[t * 3 + k], b = mesh.idx[t * 3 + ((k + 1) % 3)];
            const before = Math.hypot(Q0[a * 3] - Q0[b * 3], Q0[a * 3 + 1] - Q0[b * 3 + 1], Q0[a * 3 + 2] - Q0[b * 3 + 2]);
            const after = Math.hypot(state.Q[a * 3] - state.Q[b * 3], state.Q[a * 3 + 1] - state.Q[b * 3 + 1], state.Q[a * 3 + 2] - state.Q[b * 3 + 2]);
            assert.ok(after <= before * factor + 1e-3, `edge ${before} -> ${after}`);
        }
    }
    assert.equal(openEdges(state.Q, state.idx), 0);
    assert.ok(signedVolume(state.Q, state.idx) > signedVolume(Q0, mesh.idx), "the stool got bigger");
});

await test("move, scale and rotate (right-hand rule: +90 degrees about z turns +x into +y)", async () => {
    const tri = { Q: Float32Array.from([100, 0, 0, 100, 10, 0, 100, 0, 10]), uv: new Float32Array(6), nor: new Float32Array(9), idx: Uint32Array.from([0, 1, 2]) };
    const rot = runProgram(tri, program([op({ op: "rotate", axis: "z", degrees: 90, pivot_mm: [0, 0, 0] })])).state;
    assert.ok(near(rot.Q[0], 0) && near(rot.Q[1], 100), `${[...rot.Q.slice(0, 3)]}`);
    assert.ok(near(rot.Q[3], -10) && near(rot.Q[4], 100));
    const rotY = runProgram(tri, program([op({ op: "rotate", axis: "y", degrees: 90, pivot_mm: [0, 0, 0] })])).state;
    assert.ok(near(rotY.Q[2], -100) && near(rotY.Q[0], 0), "+90 about y turns +x into -z");
    const mv = runProgram(tri, program([op({ op: "move", vector_mm: [5, -6, 7] })])).state;
    assert.deepEqual([...mv.Q.slice(0, 3)], [105, -6, 7]);
    const sc = runProgram(tri, program([op({ op: "scale", factors: [2, 1, 3], pivot_mm: [100, 0, 0] })])).state;
    assert.deepEqual([...sc.Q.slice(0, 3)], [100, 0, 0], "the pivot stays");
    assert.deepEqual([...sc.Q.slice(6, 9)], [100, 0, 30]);
    const half = runProgram(tri, program([op({ op: "move", vector_mm: [10, 0, 0], boxes: [box(90, -5, -5, 110, 5, 5)], feather_mm: 0.5 })])).state;
    assert.ok(near(half.Q[0], 110) && near(half.Q[3], 100), "only the selected vertices move");
});

await test("delete: the leg goes whole (no hole to cap); a cut through a bar caps its hole and the surface stays closed with outward winding", async () => {
    const stool = meshOf(stoolParts());
    const r1 = runProgram(stool, program([op({ op: "delete", label: "front left leg", boxes: [box(-300, -300, -5, -240, -240, 415)], feather_mm: 1 })]));
    const logged = r1.log.find((l) => l.op === "delete");
    assert.equal(logged.capped, 0);
    assert.equal(r1.state.idx.length / 3, stool.idx.length / 3 - boxGrid(0, 40, 0, 40, 0, 410, [1, 1, 8]).idx.length / 3, "exactly the leg's triangles are gone");
    assert.equal(openEdges(stool.Q, stool.idx), 0, "the stool itself is closed");
    assert.equal(openEdges(r1.state.Q, r1.state.idx), 0);
    assert.ok(bounds(r1.state.Q).min[2] === 0, "the other legs still reach the ground");

    const bar = meshOf([boxGrid(0, 600, 0, 40, 0, 40, [12, 1, 1])]);
    const vol0 = signedVolume(bar.Q, bar.idx);
    const r2 = runProgram(bar, program([op({ op: "delete", label: "right half", boxes: [box(300, -10, -10, 700, 50, 50)], feather_mm: 1 })]));
    assert.equal(r2.log.find((l) => l.op === "delete").capped, 1);
    assert.equal(openEdges(r2.state.Q, r2.state.idx), 0, "the cut is capped: closed and manifold");
    const vol = signedVolume(r2.state.Q, r2.state.idx);
    assert.ok(vol > 0, "outward winding");
    assert.ok(near(vol, vol0 / 2, vol0 * 0.02), `half the bar: ${vol} vs ${vol0 / 2}`);
    assert.ok(bounds(r2.state.Q).max[0] <= 300.001);
    for (let v = 0; v < r2.state.nor.length; v += 3) assert.ok(near(Math.hypot(r2.state.nor[v], r2.state.nor[v + 1], r2.state.nor[v + 2]), 1, 1e-4));
    // every vertex is used by a triangle (the vertices of the deleted triangles are gone)
    const used = new Uint8Array(r2.state.Q.length / 3);
    for (const i of r2.state.idx) used[i] = 1;
    assert.ok(used.every((u) => u === 1));
});

await test("mirror_copy: the copy is the selected piece reflected, with outward winding and flipped normals", async () => {
    const mesh = meshOf([boxGrid(100, 200, 0, 50, 0, 80, [2, 1, 1]), boxGrid(-500, -450, 0, 50, 0, 80, [1, 1, 1])]);
    const nt = mesh.idx.length / 3;
    const r = runProgram(mesh, program([op({ op: "mirror_copy", label: "arm", axis: "x", mirror_at_mm: 0, boxes: [box(90, -10, -10, 210, 60, 90)], feather_mm: 0.5 })]));
    const added = r.state.idx.length / 3 - nt;
    assert.ok(added > 0 && added < nt);
    assert.ok(signedVolume(r.state.Q, r.state.idx, nt) > 0, "the reflected copy is not inside out");
    assert.ok(near(signedVolume(r.state.Q, r.state.idx, nt), 100 * 50 * 80, 1));
    const b = bounds(r.state.Q.subarray(mesh.Q.length));
    assert.ok(near(b.min[0], -200) && near(b.max[0], -100));
    // normals of the copy point away from its centre
    const cx = -150, cy = 25, cz = 40;
    for (let v = mesh.Q.length / 3; v < r.state.Q.length / 3; v++) {
        const out = (r.state.Q[v * 3] - cx) * r.state.nor[v * 3] + (r.state.Q[v * 3 + 1] - cy) * r.state.nor[v * 3 + 1] + (r.state.Q[v * 3 + 2] - cz) * r.state.nor[v * 3 + 2];
        assert.ok(out > 0, "outward normal");
    }
    assert.equal(openEdges(r.state.Q, r.state.idx), 0);
});

await test("recolor records a paint (whole = null weights); a region with nothing in it fails; paint weights follow a later delete", async () => {
    const mesh = meshOf([boxGrid(0, 600, 0, 40, 0, 40, [12, 1, 1])]);
    const whole = runProgram(mesh, program([op({ op: "recolor", color: "#00ff00", strength: 1 })])).state;
    assert.equal(whole.paints.length, 1);
    assert.equal(whole.paints[0].weights, null);
    assert.throws(() => runProgram(mesh, program([op({ op: "recolor", label: "the hat", color: "#00ff00", strength: 1, boxes: [box(900, 900, 900, 910, 910, 910)] })])), (e) => e instanceof MeshEditError && e.code === "notfound" && e.message === "I couldn't find the the hat on this model.");
    const both = runProgram(mesh, program([
        op({ op: "recolor", color: "#ff0000", strength: 0.5, boxes: [box(0, -10, -10, 150, 50, 50)], feather_mm: 0.5 }),
        op({ op: "delete", label: "right half", boxes: [box(300, -10, -10, 700, 50, 50)], feather_mm: 1 }),
    ])).state;
    assert.equal(both.paints[0].weights.length, both.Q.length / 3, "weights follow the vertices");
    let painted = 0;
    for (let v = 0; v < both.Q.length / 3; v++) if (both.paints[0].weights[v] > 0.5) { painted++; assert.ok(both.Q[v * 3] <= 150.5); }
    assert.ok(painted > 0);
});

await test("add_parts collects parts with unique names; nothing else changes", async () => {
    const mesh = meshOf(stoolParts());
    const part = { name: "cup", shape: "cylinder", size: [90, 90, 70], position: [0, 0, 480], rotation: [0, 0, 0], color: "#112233" };
    const r = runProgram(mesh, program([op({ op: "add_parts", parts: [part, { ...part, position: [100, 0, 480] }] }), op({ op: "add_parts", parts: [part] })]));
    assert.deepEqual(r.state.parts.map((p) => p.name), ["cup", "cup 2", "cup 3"]);
    assert.deepEqual([...r.state.Q], [...mesh.Q]);
});

section("guards");

await test("an op that finds nothing says so with the part's name, for every kind of op", async () => {
    const mesh = meshOf(stoolParts());
    const far = [box(5000, 5000, 5000, 5100, 5100, 5100)];
    for (const kind of ["stretch", "move", "scale", "rotate", "delete", "mirror_copy"]) {
        const o = op({ op: kind, label: "left armrest", boxes: far, feather_mm: 1, from_mm: 0, to_mm: 10, amount_mm: 5, vector_mm: [1, 0, 0], factors: [2, 2, 2], degrees: 10, mirror_at_mm: 0 });
        assert.throws(() => runProgram(mesh, program([o])), (e) => e instanceof MeshEditError && e.code === "notfound" && e.message === "I couldn't find the left armrest on this model.", kind);
    }
});

await test("a delete of more than 60% of the triangles is refused", async () => {
    const mesh = meshOf(stoolParts());
    assert.throws(() => runProgram(mesh, program([op({ op: "delete", label: "everything", boxes: [box(-400, -400, -10, 400, 400, 1100)], feather_mm: 1 })])), (e) => e.code === "toomuch");
    // a delete of a few legs is fine
    const ok = runProgram(mesh, program([op({ op: "delete", label: "legs", boxes: [box(-300, -300, -5, 300, -240, 405)], feather_mm: 1 })]));
    assert.ok(ok.state.idx.length > 0);
});

await test("a result over MAX_EDIT_TRIANGLES is refused (a 700k-triangle sheet mirrored)", async () => {
    const n = 840; // n x n quads x 2 = 1.41M triangles is too much to build; use 590 x 590 x 2 = 696k
    const side = 590;
    const Q = new Float32Array((side + 1) * (side + 1) * 3), idx = new Uint32Array(side * side * 6);
    for (let j = 0, k = 0; j <= side; j++) for (let i = 0; i <= side; i++, k += 3) { Q[k] = i; Q[k + 1] = j; Q[k + 2] = 0; }
    for (let j = 0, k = 0; j < side; j++) for (let i = 0; i < side; i++) { const p = j * (side + 1) + i; idx.set([p, p + 1, p + side + 1, p + 1, p + side + 2, p + side + 1], k); k += 6; }
    assert.ok(idx.length / 3 > 600_000 && n > 0);
    const mesh = { Q, uv: new Float32Array((side + 1) * (side + 1) * 2), nor: new Float32Array(Q.length), idx };
    assert.throws(() => runProgram(mesh, program([op({ op: "mirror_copy", label: "sheet", axis: "x", mirror_at_mm: -5, boxes: [box(-10, -10, -10, 1000, 1000, 10)], feather_mm: 1 })])), (e) => e.code === "toobig");
});

await test("aborting stops the run between ops; a program with no ops is refused", async () => {
    const mesh = meshOf(stoolParts());
    const ac = new AbortController();
    ac.abort();
    assert.throws(() => runProgram(mesh, program([op({ op: "recolor", color: "#00ff00", strength: 1 })]), { signal: ac.signal }), (e) => e.code === "aborted");
    const second = new AbortController();
    assert.throws(
        () => runProgram(mesh, program([op({ op: "move", vector_mm: [1, 0, 0] }), op({ op: "move", vector_mm: [1, 0, 0] })]), { signal: second.signal, onProgress: (p) => { if (p.index === 2) second.abort(); } }),
        (e) => e.code === "aborted",
    );
    assert.throws(() => runProgram(mesh, { summary: "x", applied: false, ops: [] }), (e) => e.code === "failed");
});

await test("the input mesh is never changed by a run", async () => {
    const mesh = meshOf(stoolParts());
    const copy = { Q: Float32Array.from(mesh.Q), uv: Float32Array.from(mesh.uv), nor: Float32Array.from(mesh.nor), idx: Uint32Array.from(mesh.idx) };
    runProgram(mesh, program([op({ op: "delete", label: "x", boxes: [box(-300, -300, -5, -240, -240, 405)], feather_mm: 1 }), op({ op: "stretch", axis: "z", from_mm: 600, to_mm: 800, amount_mm: 50, boxes: [box(-300, 230, 420, 300, 300, 1100)] })]));
    assert.deepEqual(mesh.Q, copy.Q);
    assert.deepEqual(mesh.idx, copy.idx);
    assert.deepEqual(mesh.nor, copy.nor);
    assert.deepEqual(mesh.uv, copy.uv);
    assert.equal(typeof OPS.delete, "function");
    assert.equal(makeState(mesh).Q === mesh.Q, false);
});

// ============================================================ files: reader, frame, writer
section("the reader, the frame and the writer");

/** (x, y, z) in the edit frame's units (mm, Z up) -> glTF Y-up metres, the file's own axes. */
const toGltf = (Q) => { const out = new Float32Array(Q.length); for (let i = 0; i < Q.length; i += 3) { out[i] = Q[i] / 1000; out[i + 1] = Q[i + 2] / 1000; out[i + 2] = -Q[i + 1] / 1000; } return out; };
const applyM = (m, P) => { const out = new Float32Array(P.length); for (let i = 0; i < P.length; i += 3) for (let r = 0; r < 3; r++) out[i + r] = m[r] * P[i] + m[4 + r] * P[i + 1] + m[8 + r] * P[i + 2] + m[12 + r]; return out; };

async function pngBytes(w = 64, h = 64, rgb = [200, 120, 60]) {
    if (!sharp) return null;
    return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer());
}

/**
 * A model file made by an independent writer (@gltf-transform/core): the mesh (mm, Z up) under a parent and a child node with their own
 * transforms, one textured material, optionally more nodes. Returns the bytes and the world positions gltf-transform computes.
 */
async function sourceFile({ parts = stoolParts(), png = null, parent = { translation: [0.1, 0.2, -0.3], rotation: [0, 0.38268343, 0, 0.92387953], scale: [1, 1, 1] }, child = { translation: [0, 0.05, 0], rotation: [0.70710678, 0, 0, 0.70710678], scale: [0.8, 0.8, 0.8] }, textured = true, color = [0.8, 0.5, 0.3, 1], hasNormals = true } = {}) {
    const m = merge(parts);
    const n = m.pos.length / 3;
    const L = toGltf(m.pos);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { uv[i * 2] = ((m.pos[i * 3] + 400) % 800) / 800; uv[i * 2 + 1] = (m.pos[i * 3 + 2] % 1000) / 1000; }
    const doc = new Document();
    const buffer = doc.createBuffer();
    const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const material = doc.createMaterial("wood").setBaseColorFactor(color);
    if (textured && png) material.setBaseColorTexture(doc.createTexture("t").setImage(png).setMimeType("image/png"));
    const prim = doc.createPrimitive().setAttribute("POSITION", acc("VEC3", L)).setIndices(acc("SCALAR", m.idx)).setMaterial(material);
    if (hasNormals) {
        // glTF normals of the Z-up smooth normals
        const nor = new Float32Array(n * 3);
        const mesh = { Q: m.pos, nor: new Float32Array(n * 3), idx: m.idx };
        refreshNormals(mesh.Q, mesh.idx, mesh.nor, null);
        for (let i = 0; i < n; i++) { nor[i * 3] = mesh.nor[i * 3]; nor[i * 3 + 1] = mesh.nor[i * 3 + 2]; nor[i * 3 + 2] = -mesh.nor[i * 3 + 1]; }
        prim.setAttribute("NORMAL", acc("VEC3", nor));
    }
    if (textured) prim.setAttribute("TEXCOORD_0", acc("VEC2", uv));
    const meshNode = doc.createNode("Model").setMesh(doc.createMesh("m").addPrimitive(prim));
    const apply = (node, t) => { if (!t) return node; node.setTranslation(t.translation).setRotation(t.rotation).setScale(t.scale); return node; };
    apply(meshNode, child);
    const root = doc.createNode("Root");
    apply(root, parent).addChild(meshNode);
    doc.createScene("s").addChild(root);
    const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT));
    const bytes = new Uint8Array(await io.writeBinary(doc));
    return { bytes, world: applyM(meshNode.getWorldMatrix(), L), L, uv, indices: m.idx, n };
}

await test("the reader bakes a node hierarchy into world space (checked against gltf-transform's own matrices) and finds the picture", async () => {
    if (!sharp) return skip("reader with texture", "sharp is not installed");
    const png = await pngBytes();
    const f = await sourceFile({ png });
    const r = readMeshGlb(f.bytes);
    assert.ok(r.ok, r.reason);
    const s = r.source;
    assert.equal(s.positions.length, f.world.length);
    for (let i = 0; i < f.world.length; i++) assert.ok(near(s.positions[i], f.world[i], 1e-5), `at ${i}: ${s.positions[i]} vs ${f.world[i]}`);
    assert.deepEqual([...s.indices], [...f.indices]);
    assert.equal(s.uv.length, f.uv.length);
    assert.ok(s.texture && s.texture.mime === "image/png" && s.texture.bytes.length === png.length);
    assert.deepEqual([...s.texture.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(near(s.baseColor[0], 0.8, 1e-5));
    assert.equal(s.carried.length, 0);
    // normals follow the same transform: unit length and perpendicular to the world surface of every triangle
    let bad = 0;
    for (let t = 0; t < s.indices.length / 3; t += 7) {
        const a = s.indices[t * 3] * 3, b = s.indices[t * 3 + 1] * 3, c = s.indices[t * 3 + 2] * 3;
        const u = [0, 1, 2].map((k) => s.positions[b + k] - s.positions[a + k]), v = [0, 1, 2].map((k) => s.positions[c + k] - s.positions[a + k]);
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
        const len = Math.hypot(nx, ny, nz);
        if (len < 1e-12) continue;
        const dotN = (nx * s.normals[a] + ny * s.normals[a + 1] + nz * s.normals[a + 2]) / len;
        // smooth normals tilt at the edges; they must still face the same way as the face
        if (dotN < 0.3) bad++;
    }
    assert.equal(bad, 0);
});

await test("the frame: longest side 1000 mm, on the ground, centred; the stool comes back in mm; the winding is outward after a mirrored node", async () => {
    const f = await sourceFile({ textured: false, parent: { translation: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [-1, 1, 1] }, child: null });
    const r = readMeshGlb(f.bytes);
    assert.ok(r.ok, r.reason);
    const setup = buildEditSetup(r.source);
    assert.ok(near(Math.max(...setup.frame.sizeMm), 1000, 1e-3));
    const b = bounds(setup.mesh.Q);
    assert.ok(near(b.min[2], 0, 1e-3), "on the ground");
    assert.ok(near((b.min[0] + b.max[0]) / 2, 0, 1e-2) && near((b.min[1] + b.max[1]) / 2, 0, 1e-2), "centred");
    assert.ok(signedVolume(setup.mesh.Q, setup.mesh.idx) > 0, "outward winding although the node was mirrored");
    assert.equal(setup.hasUv, false);
    assert.equal(r.source.texture, null);
    // fromFrame(toFrame(p)) is p
    const zUp = new Float32Array([0.3, -0.2, 0.9, 1, 2, 3]);
    const back = fromFrame(toFrame(zUp, setup.frame), setup.frame);
    for (let i = 0; i < zUp.length; i++) assert.ok(near(back[i], zUp[i], 1e-5));
    assert.equal(makeFrame([]).scale, 1000);
});

await test("a model without normals gets smooth ones; the file's own triangles stay in the same order", async () => {
    const f = await sourceFile({ textured: false, hasNormals: false });
    const r = readMeshGlb(f.bytes);
    assert.ok(r.ok);
    assert.equal(r.source.normals, null);
    const setup = buildEditSetup(r.source);
    for (let v = 0; v < setup.mesh.nor.length; v += 3) assert.ok(near(Math.hypot(setup.mesh.nor[v], setup.mesh.nor[v + 1], setup.mesh.nor[v + 2]), 1, 1e-4));
    assert.deepEqual([...setup.mesh.idx], [...f.indices]);
});

const validate = async (glb) => {
    const v = await validator.validateBytes(glb, { maxIssues: 50 });
    return { errors: v.issues.numErrors, warnings: v.issues.numWarnings, infos: v.issues.numInfos, hints: v.issues.numHints, messages: v.issues.messages.map((m) => `${m.code} ${m.pointer}`) };
};
const expectClean = async (glb, what) => {
    const v = await validate(glb);
    assert.deepEqual([v.errors, v.warnings, v.hints], [0, 0, 0], `${what}: ${JSON.stringify(v.messages.slice(0, 5))}`);
};

await test("the writer: edited stool (stretch, delete, mirror, parts) validates 0/0/0, re-reads with gltf-transform at the right place, picture bytes untouched", async () => {
    if (!sharp) return skip("writer with texture", "sharp is not installed");
    const png = await pngBytes();
    const f = await sourceFile({ png, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    assert.ok(near(setup.frame.scale, 1000, 1e-6), "a 1 m model: the frame is the file's own mm");
    const cup = { name: "cup holder", shape: "cylinder", size: [80, 80, 60], position: [150, 0, 480], rotation: [0, 90, 0], color: "#336699" };
    const p = program([
        op({ op: "stretch", label: "back", axis: "z", from_mm: 600, to_mm: 800, amount_mm: 100, boxes: [box(-400, 230, 420, 400, 300, 1100)] }),
        op({ op: "delete", label: "front left leg", boxes: [box(-300, -300, -5, -240, -240, 415)], feather_mm: 1 }),
        op({ op: "mirror_copy", label: "right back post", axis: "x", mirror_at_mm: 400, boxes: [box(240, 240, 430, 300, 300, 1100)], feather_mm: 1 }),
        op({ op: "add_parts", label: "cup", parts: [cup, { ...cup, name: "ring", shape: "torus", size: [90, 90, 12], rotation: [0, 0, 0] }] }),
    ]);
    const run = runProgram(setup.mesh, p);
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: true, parts: run.state.parts, echo: { version: 1, target: "mesh", summary: "test" } });
    await expectClean(glb, "edited stool");
    const doc = await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(glb);
    const root = doc.getRoot();
    const nodes = root.listNodes();
    const main = nodes.find((n) => n.getName() === "Model");
    assert.ok(main);
    assert.deepEqual(main.getTranslation(), [0, 0, 0]);
    assert.deepEqual(main.getRotation(), [0, 0, 0, 1]);
    assert.deepEqual(main.getScale(), [1, 1, 1]);
    assert.equal(main.getParentNode(), null, "the mesh node is at the scene root, so no transform above it moves it again");
    const prim = main.getMesh().listPrimitives()[0];
    assert.equal(prim.getIndices().getCount(), run.state.idx.length);
    // the vertices are where the frame says (frame mm -> Z up -> glTF)
    const world = prim.getAttribute("POSITION").getArray();
    const zUp = fromFrame(run.state.Q, setup.frame);
    for (let i = 0; i < run.state.Q.length; i += 3) {
        assert.ok(near(world[i], zUp[i], 1e-5) && near(world[i + 1], zUp[i + 2], 1e-5) && near(world[i + 2], -zUp[i + 1], 1e-5));
    }
    const tex = prim.getMaterial().getBaseColorTexture();
    assert.deepEqual(Array.from(tex.getImage()), Array.from(png), "the original picture is copied byte for byte");
    assert.ok(prim.getAttribute("TEXCOORD_0"));
    // the added parts
    const parent = nodes.find((n) => n.getName() === "Edit parts");
    assert.ok(parent && parent.listChildren().length === 2);
    const cupNode = parent.listChildren().find((n) => n.getName() === "cup holder");
    const wm = cupNode.getWorldMatrix();
    const expectZUp = [150 / setup.frame.scale + setup.frame.origin[0], 0 / setup.frame.scale + setup.frame.origin[1], 480 / setup.frame.scale + setup.frame.origin[2]];
    assert.ok(near(wm[12], expectZUp[0], 1e-5) && near(wm[13], expectZUp[2], 1e-5) && near(wm[14], -expectZUp[1], 1e-5), `cup at ${[wm[12], wm[13], wm[14]]} vs ${expectZUp}`);
    assert.deepEqual(cupNode.listParents().length > 0, true);
    assert.ok(root.listMaterials().some((mt) => mt.getName() === "cup holder"));
    // the echo and the generator
    const extras = doc.getRoot().listScenes()[0].getExtras();
    assert.equal(extras["nevo:edit"].summary, "test");
    assert.match(parseGlb(glb).json.asset.generator, /Assembly Studio edit/);
});

await test("the writer: a part's rotation is the one the parts models use (same quaternion as buildPartsGlb)", async () => {
    const { buildPartsGlb } = await R("shared/partsGlb.ts");
    const part = { name: "tilted", shape: "box", size: [100, 40, 30], position: [10, 20, 30], rotation: [20, 35, 70], color: "#aabbcc" };
    const ref = await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(buildPartsGlb({ name: "d", parts: [part] }));
    const refNode = ref.getRoot().listNodes()[0];
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const run = runProgram(setup.mesh, program([op({ op: "add_parts", parts: [part] })]));
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: false, parts: run.state.parts, echo: {} });
    const out = await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(glb);
    const node = out.getRoot().listNodes().find((n) => n.getName() === "tilted");
    for (let i = 0; i < 4; i++) assert.ok(near(node.getRotation()[i], refNode.getRotation()[i], 1e-5));
    for (let i = 0; i < 3; i++) assert.ok(near(node.getScale()[i], refNode.getScale()[i], 1e-5));
    await expectClean(glb, "tilted part");
});

await test("a second edit of an edited file: the parts of the first edit are carried (and drawn), the frame covers them, more parts get a parent of their own", async () => {
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const cup = { name: "cup", shape: "cylinder", size: [80, 80, 60], position: [0, 0, 1200], rotation: [0, 0, 0], color: "#336699" };
    const first = runProgram(setup.mesh, program([op({ op: "add_parts", parts: [cup] })]));
    const glb1 = writeEditedGlb({ source: src, frame: setup.frame, mesh: first.state, hasUv: false, parts: first.state.parts, echo: {} });
    const r2 = readMeshGlb(glb1);
    assert.ok(r2.ok, r2.reason);
    assert.equal(r2.source.carried.length, 1);
    assert.equal(r2.source.carried[0].name, "cup");
    const setup2 = buildEditSetup(r2.source);
    assert.ok(setup2.frame.sizeMm[2] > 1000 * 0.99, "the cup that sticks out above the model is part of the frame");
    assert.equal(setup2.pieces.length, 1);
    assert.ok(near(Math.max(...setup2.frame.sizeMm), 1000, 1e-3));
    const second = runProgram(setup2.mesh, program([op({ op: "add_parts", parts: [{ ...cup, name: "ring", position: [200, 0, 300] }] })]));
    const glb2 = writeEditedGlb({ source: r2.source, frame: setup2.frame, mesh: second.state, hasUv: false, parts: second.state.parts, echo: {} });
    await expectClean(glb2, "second edit");
    const names = (await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(glb2)).getRoot().listNodes().map((n) => n.getName());
    assert.ok(names.includes("Edit parts") && names.includes("Edit parts 2") && names.includes("cup") && names.includes("ring"));
    const r3 = readMeshGlb(glb2);
    assert.ok(r3.ok);
    assert.equal(r3.source.carried.length, 2);
    // the first edit's part is where it was in the world
    const zWorld = (src2) => src2.carried.find((c) => c.name === "cup").positions;
    const a = zWorld(r2.source), b = zWorld(r3.source);
    for (let i = 0; i < a.length; i++) assert.ok(near(a[i], b[i], 1e-5), "carried parts did not move");
    // the pictures include them
    const colors = new Uint8Array(setup2.mesh.Q.length).fill(128);
    assert.ok(colors.length > 0);
});

await test("what cannot be edited says so: Draco, quantised, two textured pieces, outside files, not a GLB, too many triangles", async () => {
    if (!sharp) return skip("unsupported formats", "sharp is not installed");
    const png = await pngBytes();
    const f = await sourceFile({ png });
    const g = parseGlb(f.bytes);
    const rebuild = (mutate) => { const json = structuredClone(g.json); mutate(json); return assembleGlb(json, g.bin); };
    const bad = (bytes, re) => { const r = readMeshGlb(bytes); assert.equal(r.ok, false); assert.match(r.reason, re); assert.match(r.reason, /can't be edited here|too detailed/); };
    bad(rebuild((j) => { j.extensionsRequired = ["KHR_draco_mesh_compression"]; j.extensionsUsed = ["KHR_draco_mesh_compression"]; }), /Draco/);
    bad(rebuild((j) => { j.extensionsUsed = ["EXT_meshopt_compression"]; }), /meshopt/);
    bad(rebuild((j) => { j.extensionsUsed = ["KHR_mesh_quantization"]; }), /quantised/);
    bad(rebuild((j) => { j.accessors[0].componentType = 5122; }), /quantised/);
    bad(rebuild((j) => { j.buffers[0].uri = "data.bin"; }), /outside the file/);
    bad(rebuild((j) => { j.accessors[1].sparse = { count: 1 }; }), /sparse/);
    bad(rebuild((j) => { j.accessors[0].count = 1e9; }), /damaged accessor/);
    bad(rebuild((j) => { j.images[0].mimeType = "image/webp"; }), /unusual picture format/);
    bad(rebuild((j) => { j.meshes[0].primitives[0].mode = 1; }), /not triangles/);
    bad(rebuild((j) => { const second = structuredClone(j.meshes[0]); j.meshes.push(second); j.nodes.push({ name: "Other", mesh: 1 }); j.scenes[0].nodes.push(j.nodes.length - 1); }), /several textured pieces/);
    bad(new Uint8Array(40), /not a GLB/);
    bad(new Uint8Array([1, 2, 3]), /not a GLB/);
    bad(rebuild((j) => { j.asset.version = "1.0"; }), /glTF 2.0/);
});

await test("a model with more than MAX_EDIT_TRIANGLES triangles is refused as too detailed", async () => {
    const side = 790; // 790 x 790 quads x 2 = 1.25M triangles
    const P = new Float32Array((side + 1) * (side + 1) * 3), I = new Uint32Array(side * side * 6);
    for (let j = 0, k = 0; j <= side; j++) for (let i = 0; i <= side; i++, k += 3) { P[k] = i / 1000; P[k + 1] = 0; P[k + 2] = -j / 1000; }
    for (let j = 0, k = 0; j < side; j++) for (let i = 0; i < side; i++) { const p = j * (side + 1) + i; I.set([p, p + side + 1, p + 1, p + 1, p + side + 1, p + side + 2], k); k += 6; }
    const bin = new Uint8Array(P.byteLength + I.byteLength);
    bin.set(new Uint8Array(P.buffer), 0);
    bin.set(new Uint8Array(I.buffer), P.byteLength);
    const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: "VEC3" }, { bufferView: 1, componentType: 5125, count: I.length, type: "SCALAR" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }], buffers: [{ byteLength: bin.length }] };
    const r = readMeshGlb(assembleGlb(json, bin));
    assert.equal(r.ok, false);
    assert.match(r.reason, /too detailed/);
    // a file of 100 triangles with the same layout reads (a plain mesh with no normals, no texture and no material)
    const small = readMeshGlb(assembleGlb({ ...json, accessors: [{ ...json.accessors[0], count: 800 }, { ...json.accessors[1], count: 3 }] }, bin));
    assert.ok(small.ok, small.reason);
    assert.equal(small.source.texture, null);
    assert.deepEqual(small.source.baseColor, [1, 1, 1, 1]);
});

await test("a model without texture coordinates is edited and written without them; a recolor falls back to the material's colour (and says so)", async () => {
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const run = runProgram(setup.mesh, program([
        op({ op: "recolor", label: "all", color: "#00ff00", strength: 1 }),
        op({ op: "recolor", label: "seat", color: "#ff0000", strength: 1, boxes: [box(-300, -300, 400, 300, 300, 450)], feather_mm: 1 }),
    ]));
    const paint = await applyPaints(null, null, null, run.state.uv, run.state.idx, run.state.paints, src.baseColor);
    assert.ok(paint.baseColorFactor);
    assert.ok(paint.baseColorFactor[1] > paint.baseColorFactor[0], "tinted green");
    assert.ok(paint.notes.some((n) => /newer browser/.test(n)) && paint.notes.some((n) => /approximation/.test(n)));
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: false, parts: [], baseColorFactor: paint.baseColorFactor, echo: {} });
    await expectClean(glb, "untextured edit");
    const doc = await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(glb);
    assert.equal(doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("TEXCOORD_0"), null);
    assert.ok(near(doc.getRoot().listMaterials()[0].getBaseColorFactor()[1], paint.baseColorFactor[1], 1e-5));
});

await test("texture: tinting keeps the shading, a region mask paints only its place, the JPEG goes into the file and validates", async () => {
    if (!codec) return skip("texture recolor", "sharp is not installed");
    // a picture with a left half dark and a right half light
    const w = 64, h = 64, data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 32 ? 60 : 180; data.set([v, v, v], (y * w + x) * 3); }
    const img = { w, h, data };
    const uv = Float32Array.from([0, 0, 1, 0, 0, 1, 1, 1]);
    const idx = Uint32Array.from([0, 1, 2, 1, 3, 2]);
    const whole = { w, h, data: Uint8Array.from(data) };
    tintImage(whole, [{ color: "#00ff00", strength: 1, weights: null }], uv, idx, null);
    const dark = whole.data.subarray(0, 3), light = whole.data.subarray(34 * 3, 34 * 3 + 3);
    assert.ok(dark[1] > dark[0] + 20 && light[1] > light[0] + 20, "both halves turned green");
    assert.ok(light[1] > dark[1], "the light half is still lighter (the shading is kept)");
    const half = { w, h, data: Uint8Array.from(data) };
    const weights = Float32Array.from([1, 0, 1, 0]); // the left edge of the picture
    tintImage(half, [{ color: "#ff0000", strength: 1, weights }], uv, idx, null);
    assert.ok(half.data[0] > half.data[1] + 20, "left painted");
    assert.ok(Math.abs(half.data[60 * 3] - 180) < 20 && Math.abs(half.data[60 * 3 + 1] - 180) < 20, "the far right is (almost) untouched: the weight fades across the triangle");
    const mask = uvMask(uv, idx, weights, w, h);
    assert.ok(mask[10 * w + 2] > 200 && mask[10 * w + 60] < 40);
    const colors = sampleVertexColors(Float32Array.from([0.1, 0.5, 0.9, 0.5]), img, null);
    assert.deepEqual([...colors], [60, 60, 60, 180, 180, 180]);
    assert.deepEqual(imageUv(0.5, 0.25, { offset: [0.1, 0], rotation: 0, scale: [2, 1] }), [1.1, 0.25]);
    // end to end through the writer
    const png = await pngBytes(128, 128);
    const f = await sourceFile({ png });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const image = await codec.decode(src.texture.bytes, src.texture.mime, 2048);
    const run = runProgram(setup.mesh, program([op({ op: "recolor", label: "seat", color: "#2e7d32", strength: 1, boxes: [box(-300, -300, 400, 300, 300, 450)], feather_mm: 1 })]));
    const out = await applyPaints(codec, src.texture, image, run.state.uv, run.state.idx, run.state.paints, src.baseColor);
    assert.equal(out.image.mime, "image/jpeg");
    assert.deepEqual([...out.image.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: true, parts: [], image: out.image, echo: {} });
    await expectClean(glb, "recolored");
    const tex = (await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(glb)).getRoot().listTextures()[0];
    assert.equal(tex.getMimeType(), "image/jpeg");
    assert.deepEqual(Array.from(tex.getImage().subarray(0, 3)), [0xff, 0xd8, 0xff]);
});

await test("a material extension (KHR_materials_specular) is carried through the rewrite and the result still validates", async () => {
    if (!sharp) return skip("extension passthrough", "sharp is not installed");
    const f = await sourceFile({ png: await pngBytes() });
    const g = parseGlb(f.bytes);
    g.json.extensionsUsed = ["KHR_materials_specular"];
    g.json.materials[0].extensions = { KHR_materials_specular: { specularFactor: 0.5 } };
    const bytes = assembleGlb(g.json, g.bin);
    const src = readMeshGlb(bytes).source;
    const setup = buildEditSetup(src);
    const run = runProgram(setup.mesh, program([op({ op: "move", vector_mm: [10, 0, 0] })]));
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: true, parts: [], echo: {} });
    await expectClean(glb, "specular");
    const out = parseGlb(glb).json;
    assert.deepEqual(out.extensionsUsed, ["KHR_materials_specular"]);
    assert.equal(out.materials[0].extensions.KHR_materials_specular.specularFactor, 0.5);
});


// ============================================================ pictures
section("the pictures the model reads");

const colorsOf = (n, rgb) => { const c = new Uint8Array(n * 3); for (let i = 0; i < n; i++) c.set(rgb, i * 3); return c; };

await test("the three views: +X is on the right of FRONT, +Y on the right of SIDE and at the top of TOP; the grid and its labels are drawn", async () => {
    // a red block far to +X, +Y and a grey stool: where does the red land?
    const stool = meshOf(stoolParts());
    const red = meshOf([boxGrid(180, 260, 180, 260, 600, 700, [1, 1, 1])]);
    const layers = [{ Q: stool.Q, idx: stool.idx, colors: colorsOf(stool.Q.length / 3, [150, 150, 150]) }, { Q: red.Q, idx: red.idx, colors: colorsOf(red.Q.length / 3, [255, 0, 0]) }];
    const fit = { min: [-300, -300, 0], max: [300, 300, 1000] };
    const where = (pic) => { let sx = 0, sy = 0, n = 0; for (let i = 0; i < pic.W * pic.H; i++) if (pic.rgb[i * 3] > 150 && pic.rgb[i * 3 + 1] < 80 && pic.rgb[i * 3 + 2] < 80) { sx += i % pic.W; sy += Math.floor(i / pic.W); n++; } return { x: sx / n, y: sy / n, n }; };
    const front = rasterize(layers, VIEWS[0], { size: 256, fit }), side = rasterize(layers, VIEWS[1], { size: 256, fit }), top = rasterize(layers, VIEWS[2], { size: 256, fit });
    assert.ok(where(front).n > 50 && where(front).x > 150, "FRONT: +X is on the right");
    assert.ok(where(side).n > 50 && where(side).x > 150, "SIDE: +Y is on the right");
    assert.ok(where(top).n > 50 && where(top).x > 150 && where(top).y < 100, "TOP: +X right, +Y up the picture");
    assert.ok(where(front).y < 128, "the block sits above the middle (z 600..700 of 1000) in FRONT");
    // the projection of a point is where the pixels are
    const [px, py] = front.project([220, 220, 650]);
    assert.ok(Math.abs(px - where(front).x) < 8 && Math.abs(py - where(front).y) < 8);
    // the grid: a blue axis line at x = 0 and grey lines at the others; the label "x-300" ink is dark blue
    const pic = rasterize([], VIEWS[0], { size: 512, fit: { min: [-320, -300, 0], max: [320, 300, 1000] } });
    drawGrid(pic, VIEWS[0], { step: 100, major: 100, labelEvery: 100, fit: { min: [-320, -300, 0], max: [320, 300, 1000] } });
    const [x0] = pic.project([0, 0, 500]);
    const at = (x, y) => [...pic.rgb.subarray((y * 512 + Math.round(x)) * 3, (y * 512 + Math.round(x)) * 3 + 3)];
    const axis = at(x0, 300);
    assert.ok(axis[2] > axis[0] + 40, `the axis line at x=0 is blue: ${axis}`);
    const other = at(pic.project([100, 0, 500])[0], 300);
    assert.ok(other[0] < 255 && other[0] > 150, `the grid line at x=100 is a light grey-blue: ${other}`);
    let ink = 0;
    for (let y = 2; y < 12; y++) for (let x = 0; x < 512; x++) { const p = pic.rgb.subarray((y * 512 + x) * 3, (y * 512 + x) * 3 + 3); if (p[2] > 150 && p[0] < 80) ink++; }
    assert.ok(ink > 100, `the labels along the top are drawn (${ink} ink pixels)`);
    assert.equal(drawText({ rgb: new Uint8Array(30 * 30 * 3), W: 30, H: 30 }, 1, 1, "x-300"), 30);
});

await test("PNG: a valid file whose pixels are the picture (decoded by sharp when it is there); JPEG falls back to PNG when there is no canvas", async () => {
    const stool = meshOf(stoolParts());
    const pic = rasterize([{ Q: stool.Q, idx: stool.idx, colors: colorsOf(stool.Q.length / 3, [180, 120, 60]) }], VIEWS[1], { size: 200, fit: { min: [-300, -300, 0], max: [300, 300, 1000] } });
    const bytes = await encodePng(pic.rgb, pic.W, pic.H);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    if (sharp) {
        const out = await sharp(Buffer.from(bytes)).raw().toBuffer({ resolveWithObject: true });
        assert.equal(out.info.width, 200);
        assert.equal(out.info.channels, 3);
        assert.deepEqual([...out.data], [...pic.rgb], "lossless");
    } else skip("PNG decode", "sharp is not installed");
    const setup = (await sourceFile({ textured: false, parent: null, child: null })).bytes;
    const r = readMeshGlb(setup);
    const s = buildEditSetup(r.source);
    const pkg = await describeMesh({ setup: s, source: r.source, image: null, originalPrompt: null, format: "jpeg" });
    assert.match(pkg.views[0].image, /^data:image\/png;base64,/, "no OffscreenCanvas here: PNG");
    assert.equal(pkg.views.length, 3);
    assert.deepEqual(pkg.views.map((v) => v.id), ["FRONT", "SIDE", "TOP"]);
    assert.equal(pkg.original_prompt, null);
    assert.equal(pkg.frame.facing, "-Y");
    assert.match(pkg.facts, /untextured/);
});

await test("main colours are named in plain words", async () => {
    const brown = colorsOf(100, [140, 90, 50]);
    const mixed = new Uint8Array(300);
    mixed.set(colorsOf(60, [140, 90, 50]));
    mixed.set(colorsOf(40, [250, 250, 250]), 180);
    assert.deepEqual(mainColorNames(brown), ["brown 100%"]);
    assert.deepEqual(mainColorNames(mixed), ["brown 60%", "white 40%"]);
    assert.deepEqual(mainColorNames(colorsOf(10, [60, 60, 60])), ["dark grey 100%"]);
    assert.deepEqual(mainColorNames(colorsOf(10, [10, 10, 10])), ["black 100%"]);
    assert.deepEqual(mainColorNames(colorsOf(10, [200, 30, 30])), ["red 100%"]);
    assert.deepEqual(mainColorNames(colorsOf(10, [30, 120, 200])), ["blue 100%"]);
});

await test("the zoomed pictures (second pass): the region is the boxes plus 70 mm, the selection is red, the grid is every 20 mm", async () => {
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const prog = { ops: [op({ op: "delete", label: "leg", boxes: [box(-300, -300, 0, -240, -240, 415)], feather_mm: 1 })] };
    const zb = zoomBox(prog);
    assert.deepEqual(zb.min, [-370, -370, 0]);
    assert.deepEqual(zb.max, [-170, -170, 485]);
    assert.equal(zoomBox({ ops: [op({ op: "recolor", boxes: [] })] }), null);
    const views = await zoomViews({ setup, source: src, image: null, originalPrompt: null }, prog);
    assert.equal(views.length, 3);
    assert.match(views[0].caption, /FRONT zoom/);
    if (sharp) {
        const out = await sharp(Buffer.from(views[0].image.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
        assert.equal(out.info.width, 640);
        let red = 0;
        for (let i = 0; i < out.data.length; i += 3) if (out.data[i] > 180 && out.data[i + 1] < 120 && out.data[i + 2] < 120) red++;
        assert.ok(red > 500, `the selected leg is tinted red: ${red} px`);
    }
});

// ============================================================ session
section("the session (open, describe, run) and the upload's checks");

await test("a session end to end on the stool: describe, run a three-step program, validate, check the notes", async () => {
    if (!codec) return skip("session", "sharp is not installed");
    const f = await sourceFile({ png: await pngBytes(128, 128), parent: null, child: null });
    const session = await openSession(f.bytes, codec, "a small stool");
    assert.equal(session.info.textured, true);
    assert.equal(session.info.canRepaint, true);
    assert.ok(near(Math.max(...session.info.sizeMm), 1000, 1e-3));
    const pkg = await session.describe("png");
    assert.equal(pkg.original_prompt, "a small stool");
    assert.ok(JSON.stringify(pkg).length < EDIT_PACKAGE_LIMIT);
    const progress = [];
    const out = await session.run({
        program: program([
            op({ op: "recolor", label: "seat", color: "#2e7d32", strength: 1, boxes: [box(-300, -300, 400, 300, 300, 450)], feather_mm: 1 }),
            op({ op: "stretch", label: "back", axis: "z", from_mm: 600, to_mm: 800, amount_mm: 100, boxes: [box(-400, 230, 420, 400, 300, 1100)] }),
            op({ op: "add_parts", label: "cup", parts: [{ name: "cup", shape: "cylinder", size: [80, 80, 60], position: [0, 0, 480], rotation: [0, 0, 0], color: "#336699" }] }),
        ]),
        instruction: "make it green and taller", jobId: "00000000-0000-4000-8000-000000000001", onProgress: (p) => progress.push(p),
    });
    await expectClean(out.glb, "session output");
    assert.equal(out.parts, 1);
    assert.ok(out.triangles > 0 && out.ms >= 0);
    assert.deepEqual(progress.filter((p) => p.op).map((p) => `${p.index}/${p.total}`), ["1/3", "2/3", "3/3"]);
    assert.ok(progress.some((p) => p.stage === "texture") && progress.some((p) => p.stage === "writing"));
    const echo = parseGlb(out.glb).json.scenes[0].extras["nevo:edit"];
    assert.equal(echo.instruction, "make it green and taller");
    assert.equal(echo.job_id, "00000000-0000-4000-8000-000000000001");
    assert.deepEqual(echo.ops.map((o) => o.op), ["recolor", "stretch", "add_parts"]);
    // the second program on the same session starts again from the opened file (the source is never changed)
    const again = await session.run({ program: program([op({ op: "move", vector_mm: [10, 0, 0] })]), instruction: "x", jobId: null });
    await expectClean(again.glb, "second run on one session");
});

await test("a session refuses what cannot be edited, and a plan that is not clean is cleaned again before it runs", async () => {
    await assert.rejects(() => openSession(new Uint8Array(100), codec, null), (e) => e instanceof MeshEditError && e.code === "unsupported" && /can't be edited here/.test(e.message));
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const session = await openSession(f.bytes, null, null);
    assert.equal(session.info.canRepaint, true === (null !== null));
    // an op with absurd numbers is clamped, not trusted
    const out = await session.run({ program: { summary: "s", applied: true, ops: [{ op: "move", label: "all", boxes: [], exclude: [], feather_mm: 20, axis: "z", vector_mm: [1e9, 0, 0] }] }, instruction: "x", jobId: null });
    const before = readMeshGlb(f.bytes).source.positions, after = readMeshGlb(out.glb).source.positions;
    let shift = 0;
    for (let i = 0; i < before.length; i += 3) shift = Math.max(shift, after[i] - before[i]);
    assert.ok(near(shift, 1.5, 1e-4), `moved by the clamp (1500 mm = 1.5 m in this 1 m file), not by 1e9: ${shift}`);
    await assert.rejects(() => session.run({ program: { summary: "s", applied: true, ops: [{ op: "delete", label: "x", boxes: [] }] }, instruction: "x", jobId: null }), (e) => e.code === "failed");
    await assert.rejects(() => session.run({ program: { summary: "s", applied: false, ops: [] }, instruction: "x", jobId: null }), (e) => e.code === "failed");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => session.run({ program: program([op({ op: "move", vector_mm: [1, 0, 0] })]), instruction: "x", jobId: null, signal: ac.signal }), (e) => e.code === "aborted");
});

await test("a model whose picture alone would not fit the upload is saved with the picture as a JPEG; without a canvas it says it is too large", async () => {
    if (!codec) return skip("a huge picture", "sharp is not installed");
    // 4096 x 4096 of noise: a PNG of about 50 MB, more than EDITED_GLB_LIMIT (48 MiB) before anything is changed
    const noise = new Uint8Array(await sharp({ create: { width: 4096, height: 4096, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).png({ compressionLevel: 1 }).toBuffer());
    assert.ok(noise.length > EDITED_GLB_LIMIT - 1_000_000, `${noise.length}`);
    const f = await sourceFile({ png: noise, parent: null, child: null });
    assert.ok(f.bytes.length > EDITED_GLB_LIMIT - 500_000);
    const session = await openSession(f.bytes, codec, null);
    const out = await session.run({ program: program([op({ op: "move", vector_mm: [10, 0, 0] })]), instruction: "x", jobId: null });
    assert.ok(out.glb.length < EDITED_GLB_LIMIT, `${out.glb.length}`);
    assert.equal(parseGlb(out.glb).json.images[0].mimeType, "image/jpeg");
    await expectClean(out.glb, "re-encoded picture");
    facts.push(`a ${(f.bytes.length / 1e6).toFixed(0)} MB source became ${(out.glb.length / 1e6).toFixed(1)} MB with the picture as a JPEG`);
    if (f.bytes.length > EDITED_GLB_LIMIT) {
        const noCanvas = await openSession(f.bytes, null, null);
        await assert.rejects(() => noCanvas.run({ program: program([op({ op: "move", vector_mm: [10, 0, 0] })]), instruction: "x", jobId: null }), (e) => e.code === "toobig");
    }
});

/** The JSON of a good edited file and its BIN length (the pieces the upload reads back from R2). */
async function goodEditedJson() {
    const f = await sourceFile({ textured: false, parent: null, child: null });
    const src = readMeshGlb(f.bytes).source;
    const setup = buildEditSetup(src);
    const run = runProgram(setup.mesh, program([op({ op: "add_parts", parts: [{ name: "cup", shape: "cylinder", size: [80, 80, 60], position: [0, 0, 480], rotation: [0, 0, 0], color: "#336699" }] })]));
    const glb = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: false, parts: run.state.parts, echo: {} });
    const g = parseGlb(glb);
    return { glb, json: g.json, binLength: g.bin.length };
}

await test("upload checks (3.5): a good file passes; every item of the list is refused with its own message", async () => {
    const { glb, json, binLength } = await goodEditedJson();
    assert.equal(checkEditedGlbJson(json, binLength), null);
    const mutate = (fn, bin = binLength) => { const j = structuredClone(json); fn(j); return checkEditedGlbJson(j, bin); };
    const refused = (what, message, re) => { assert.ok(message, `${what} was accepted`); assert.match(message, re, what); };
    refused("not an object", checkEditedGlbJson([], 0), /not an object/);
    refused("glTF 1", mutate((j) => { j.asset.version = "1.0"; }), /glTF 2.0/);
    refused("extension in extensionsUsed", mutate((j) => { j.extensionsUsed = ["KHR_draco_mesh_compression"]; }), /extension that is not allowed/);
    refused("extension in extensionsRequired", mutate((j) => { j.extensionsRequired = ["EXT_meshopt_compression"]; }), /extension that is not allowed/);
    refused("extension used on a primitive", mutate((j) => { j.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} }; }), /extension that is not allowed/);
    refused("extension used on a material", mutate((j) => { j.materials[0].extensions = { KHR_materials_clearcoat: {} }; }), /extension that is not allowed/);
    assert.equal(mutate((j) => { j.extensionsUsed = ["KHR_materials_specular", "KHR_texture_transform", "KHR_materials_unlit"]; j.materials[0].extensions = { KHR_materials_specular: {} }; }), null, "the three allowed ones pass");
    refused("external buffer", mutate((j) => { j.buffers[0].uri = "https://evil.example/x.bin"; }), /outside itself/);
    refused("external image", mutate((j) => { j.images = [{ uri: "x.png" }]; }), /outside itself/);
    refused("relative uri", mutate((j) => { j.buffers[0].uri = "data.bin"; }), /outside itself/);
    assert.equal(mutate((j) => { j.buffers[0].uri = "data:application/octet-stream;base64,AAAA"; }), null, "a data: uri is allowed (the 256 KB chunk bounds it)");
    refused("two buffers", mutate((j) => { j.buffers.push({ byteLength: 4 }); }), /one buffer/);
    refused("bufferView past the BIN chunk", mutate((j) => { j.bufferViews[0].byteLength = binLength + 4; }), /outside its file/);
    refused("bufferView of another buffer", mutate((j) => { j.bufferViews[0].buffer = 1; }), /buffer views/);
    refused("accessor past its view", mutate((j) => { j.accessors[0].count = 5e6; }), /outside its file/);
    refused("sparse accessor", mutate((j) => { j.accessors[0].sparse = {}; }), /accessors/);
    refused("accessor without a view", mutate((j) => { delete j.accessors[0].bufferView; }), /accessors/);
    refused("too many nodes", mutate((j) => { for (let i = 0; i < 201; i++) j.nodes.push({}); }), /too many parts/);
    refused("a node with two parents", mutate((j) => { j.nodes[0].children = [1]; j.nodes[2] ??= {}; j.nodes[2].children = [1]; }), /not a tree/);
    refused("a cycle", mutate((j) => { j.nodes.push({ children: [j.nodes.length + 1] }, { children: [j.nodes.length] }); }), /not a tree/);
    refused("node mesh out of range", mutate((j) => { j.nodes[0].mesh = 99; }), /nodes are not valid/);
    refused("primitive accessor out of range", mutate((j) => { j.meshes[0].primitives[0].indices = 999; }), /meshes are not valid/);
    refused("no mesh", mutate((j) => { j.meshes = []; }), /no mesh/);
    refused("no nodes", mutate((j) => { j.nodes = []; }), /no nodes/);
    refused("no scene", mutate((j) => { j.scenes = []; }), /no scene/);
    refused("scene node out of range", mutate((j) => { j.scenes[0].nodes = [999]; }), /scenes are not valid/);
    refused("no triangles", mutate((j) => { for (const a of j.accessors) a.count = 0; }), /no triangles/);
    refused("webp picture", mutate((j) => { j.images = [{ bufferView: 0, mimeType: "image/webp" }]; }), /unsupported format/);
    // too many triangles: the same file claiming a 1.3M-triangle mesh in a BIN chunk big enough to hold it
    const huge = structuredClone(json);
    const prim = huge.meshes.find((m) => m.primitives[0].indices !== undefined).primitives[0];
    huge.accessors[prim.indices].count = 3_900_000;
    huge.bufferViews[huge.accessors[prim.indices].bufferView].byteLength = 3_900_000 * 4;
    refused("too many triangles", checkEditedGlbJson(huge, 3_900_000 * 4 + binLength + 1000), /too many triangles/);
    // the header
    const head = glb.subarray(0, 20);
    assert.equal(readEditedHeader(head, glb.length), parseGlb(glb) && new DataView(glb.buffer, glb.byteOffset).getUint32(12, true));
    const bad = (fn, re) => { const h = Uint8Array.from(head); fn(new DataView(h.buffer)); assert.throws(() => readEditedHeader(h, glb.length), (e) => re.test(e.message) && e.status === 400); };
    bad((v) => v.setUint32(0, 0x12345678, true), /not a GLB file/);
    bad((v) => v.setUint32(4, 1, true), /GLB 2.0/);
    bad((v) => v.setUint32(8, glb.length + 8, true), /length does not match/);
    bad((v) => v.setUint32(16, 0x004e4942, true), /malformed/);
    bad((v) => v.setUint32(12, 300 * 1024, true), /too large/);
    assert.throws(() => readEditedHeader(new Uint8Array(10), 10), (e) => e.status === 400);
    const jl = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
    const binHead = glb.subarray(20 + jl, 28 + jl);
    assert.equal(readEditedBinHeader(binHead, jl, glb.length), binLength + (4 - (binLength % 4)) % 4 === binLength ? binLength : new DataView(binHead.buffer, binHead.byteOffset).getUint32(0, true));
    assert.equal(readEditedBinHeader(new Uint8Array(0), jl, 20 + jl), 0, "a file with no BIN chunk");
    const wrong = Uint8Array.from(binHead);
    new DataView(wrong.buffer).setUint32(4, 0x4e4f534a, true);
    assert.throws(() => readEditedBinHeader(wrong, jl, glb.length), (e) => e.status === 400);
    const longer = Uint8Array.from(binHead);
    new DataView(longer.buffer).setUint32(0, glb.length, true);
    assert.throws(() => readEditedBinHeader(longer, jl, glb.length), (e) => /incomplete/.test(e.message));
});

await test("the checks cost about a millisecond: a 250 KB description with 4000 accessors is read and checked in well under 20 ms", async () => {
    const { json, binLength } = await goodEditedJson();
    const big = structuredClone(json);
    const acc = big.accessors[0];
    big.accessors = Array.from({ length: 4000 }, () => ({ ...acc, count: 3 }));
    big.nodes = Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, ...(i === 0 ? { mesh: 0 } : {}) }));
    big.scenes[0].nodes = [0];
    big.meshes[0].primitives[0] = { attributes: { POSITION: 0 }, indices: 1 };
    big.accessors[1] = { ...json.accessors[1] };
    const text = JSON.stringify(big);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) checkEditedGlbJson(JSON.parse(text), binLength);
    const per = (performance.now() - t0) / 20;
    assert.ok(per < 20, `${per.toFixed(2)} ms per check (${text.length} bytes)`);
    facts.push(`upload check on a ${Math.round(text.length / 1024)} KB description: ${per.toFixed(2)} ms warm`);
});

await test("the record of a mesh edit is built from the job: bounded, readable by every project read, labelled in the person's words", async () => {
    const meta = buildMeshEditMeta({
        instruction: "make the backrest much taller and add a cup holder on the right armrest please", depth: 1, stabilizedDepth: 0, jobId: "00000000-0000-4000-8000-000000000001",
        plan: { summary: "Stretched the backrest taller by 150 mm.", notes: Array.from({ length: 12 }, (_, i) => `note ${i} ${"x".repeat(300)}`), program: { summary: "s", applied: true, ops: [
            { op: "stretch", label: "backrest", boxes: [], exclude: [], feather_mm: 20, axis: "z" }, { op: "add_parts", label: "cup holder", boxes: [], exclude: [], feather_mm: 20, axis: "z", parts: [{}, {}] }, { op: "delete", label: "x".repeat(200), boxes: [], exclude: [], feather_mm: 1, axis: "z" } ] } },
        engine: "meta/muse-spark-1.3-contributor", createdAt: "2026-10-25T10:00:00.000Z",
    });
    assert.ok(readEditMeta(meta), "readEditMeta accepts it");
    assert.equal(meta.target, "mesh");
    assert.equal(meta.label.length <= 40, true);
    assert.match(meta.label, /^Make the backrest much taller/);
    assert.equal(meta.entries.length, 1);
    assert.deepEqual([meta.entries[0].added, meta.entries[0].removed, meta.entries[0].moved], [2, 1, 1]);
    assert.equal(meta.notes.length, 8);
    assert.ok(meta.notes.every((n) => n.length <= 160));
    assert.ok(meta.ops.every((o) => o.label.length <= 60));
    assert.ok(JSON.stringify(meta).length < 8 * 1024);
    assert.equal(editLabel("   "), "Edited");
    assert.equal(editLabel("add a shelf"), "Add a shelf");
    const empty = buildMeshEditMeta({ instruction: "x", depth: 3, stabilizedDepth: 0, jobId: "j", plan: null, engine: "e", createdAt: "2026-10-25T10:00:00.000Z" });
    assert.ok(readEditMeta(empty));
    assert.deepEqual(empty.ops, []);
});


// ============================================================ the real model
// ============================================================ fixes from the review
section("fixes from the review");

/** Face normals of a triangle list (unit vectors, 3 per triangle). */
function faceNormalsOf(Q, idx) {
    const out = new Float32Array(idx.length);
    for (let t = 0; t < idx.length / 3; t++) {
        const [a, b, c] = [idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3];
        const u = [Q[b] - Q[a], Q[b + 1] - Q[a + 1], Q[b + 2] - Q[a + 2]], v = [Q[c] - Q[a], Q[c + 1] - Q[a + 1], Q[c + 2] - Q[a + 2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(...n) || 1;
        out.set([n[0] / l, n[1] / l, n[2] / l], t * 3);
    }
    return out;
}
/** How many triangles face the other way after the run than before (the surface folded through itself). */
function flippedTriangles(before, after) {
    const n0 = faceNormalsOf(before.Q, before.idx), n1 = faceNormalsOf(after.Q, after.idx);
    let flipped = 0;
    for (let t = 0; t < n0.length / 3; t++) if (n0[t * 3] * n1[t * 3] + n0[t * 3 + 1] * n1[t * 3 + 1] + n0[t * 3 + 2] * n1[t * 3 + 2] < 0) flipped++;
    return flipped;
}

// F2: a negative stretch as large as its zone made the zone fold through itself (zone 500-600, amount -300 flipped 64 of 704 triangles).
await test("F2: a stretch that shortens by more than its zone is spread over a longer zone: no triangle turns inside out, the top still moves by the amount, and the card is told", async () => {
    const post = () => meshOf([boxGrid(-100, 100, -100, 100, 0, 1000, [4, 4, 20])]);
    const cases = [
        { from: 500, to: 600, amount: -50, widened: false },
        { from: 500, to: 600, amount: -85, widened: false },
        { from: 500, to: 600, amount: -95, widened: true },
        { from: 500, to: 600, amount: -100, widened: true },
        { from: 500, to: 600, amount: -300, widened: true },
        { from: 500, to: 550, amount: -150, widened: true },
        { from: 500, to: 900, amount: -300, widened: false },
        { from: 500, to: 600, amount: 400, widened: false },
    ];
    for (const c of cases) {
        const mesh = post();
        const run = runProgram(mesh, program([op({ op: "stretch", label: "legs", boxes: [box(-400, -400, -10, 400, 400, 1100)], from_mm: c.from, to_mm: c.to, amount_mm: c.amount })]));
        const tag = JSON.stringify(c);
        assert.equal(flippedTriangles(mesh, run.state), 0, `${tag}: nothing turned inside out`);
        assert.equal(openEdges(run.state.Q, run.state.idx), 0, tag);
        assert.ok(near(bounds(run.state.Q).max[2], 1000 + c.amount, 1e-2), `${tag}: the top moved by the amount, ${bounds(run.state.Q).max[2]}`);
        assert.ok(signedVolume(run.state.Q, run.state.idx) > 0, `${tag}: still outward`);
        // z stays in order along the post (the stretch is monotonic)
        const col = [];
        for (let v = 0; v < run.state.Q.length / 3; v++) if (Math.abs(mesh.Q[v * 3] + 100) < 1e-3 && Math.abs(mesh.Q[v * 3 + 1] + 100) < 1e-3) col.push([mesh.Q[v * 3 + 2], run.state.Q[v * 3 + 2]]);
        col.sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < col.length; i++) assert.ok(col[i][1] >= col[i - 1][1] - 1e-3, `${tag}: order kept`);
        if (c.widened) {
            assert.equal(run.notes.length, 1, tag);
            assert.match(run.notes[0], /^Taking \d+ mm off the legs needed more room than the stretch the plan picked, so the change was spread over a longer one\.$/);
            assert.equal(run.log.find((l) => l.op === "stretch").note, run.notes[0]);
        } else assert.deepEqual(run.notes, [], tag);
    }
    // a zone that was fine keeps exactly the shape it always had
    const a = runProgram(post(), program([op({ op: "stretch", label: "legs", boxes: [box(-400, -400, -10, 400, 400, 1100)], from_mm: 500, to_mm: 600, amount_mm: -50 })])).state.Q;
    const sane = post().Q.map((z, i) => (i % 3 === 2 ? z - 50 * Math.min(1, Math.max(0, (z - 500) / 100)) : z));
    for (let i = 0; i < a.length; i++) assert.ok(near(a[i], sane[i], 1e-3), `vertex ${i}`);
    // the note reaches the card: a session returns it with the others
    if (codec) {
        const f = await sourceFile({ png: await pngBytes(64, 64), parent: null, child: null });
        const session = await openSession(f.bytes, codec, null);
        const out = await session.run({ program: program([op({ op: "stretch", label: "back", axis: "z", from_mm: 600, to_mm: 650, amount_mm: -200, boxes: [box(-400, 230, 420, 400, 300, 1100)] })]), instruction: "x", jobId: null });
        assert.ok(out.notes.some((n) => /needed more room than the stretch the plan picked/.test(n)), JSON.stringify(out.notes));
    }
});

// F4: "make everything green except the top" has no boxes but an exclude; the whole-picture shortcut painted the excluded part too.
await test("F4: a recolor of the whole model with places to leave out is a region: the excluded places keep their colour", async () => {
    const mesh = meshOf([boxGrid(-100, 100, -100, 100, 0, 1000, [4, 4, 20])]);
    const except = op({ op: "recolor", label: "all but the top", color: "#00ff00", strength: 1, exclude: [box(-400, -400, 800, 400, 400, 1100)], feather_mm: 20 });
    const run = runProgram(mesh, program([except]));
    const paint = run.state.paints[0];
    assert.ok(paint.weights instanceof Float32Array, "a mask, not the whole picture");
    assert.equal(run.log.find((l) => l.op === "recolor").whole, false);
    let top = 0, bottom = 0;
    for (let v = 0; v < paint.weights.length; v++) {
        const z = run.state.Q[v * 3 + 2];
        if (z > 850) { top++; assert.equal(paint.weights[v], 0, `top vertex at ${z}`); }
        if (z < 750) { bottom++; assert.equal(paint.weights[v], 1, `body vertex at ${z}`); }
    }
    assert.ok(top > 0 && bottom > 0);
    // with neither boxes nor exclude it is still the whole picture, and a recolor that excludes everything finds nothing
    assert.equal(runProgram(mesh, program([op({ op: "recolor", color: "#00ff00", strength: 1 })])).state.paints[0].weights, null);
    assert.throws(() => runProgram(mesh, program([op({ op: "recolor", label: "nothing", color: "#00ff00", strength: 1, exclude: [box(-400, -400, -10, 400, 400, 1100)] })])), (e) => e instanceof MeshEditError && e.code === "notfound");
    // and it reaches the picture: texels under the top stay as they were
    const w = 64, h = 64, img = { w, h, data: new Uint8Array(w * h * 3).fill(150) };
    const planar = Float32Array.from({ length: (run.state.Q.length / 3) * 2 }, (_, i) => (i % 2 === 0 ? (run.state.Q[(i / 2) * 3] + 100) / 200 : run.state.Q[((i - 1) / 2) * 3 + 2] / 1000));
    tintImage(img, run.state.paints, planar, run.state.idx, null);
    const texel = (z) => { const o = (Math.min(h - 1, Math.floor((z / 1000) * h)) * w + 20) * 3; return [img.data[o], img.data[o + 1], img.data[o + 2]]; };
    assert.deepEqual(texel(950), [150, 150, 150], "the top is untouched");
    assert.ok(texel(300)[1] > texel(300)[0] + 40, "the body turned green");
});

// F7: a cut that crosses the picture's islands gave its cap the average of unrelated coordinates: streaky colours across the cut face.
await test("F7: a cap takes one texture coordinate, so the cut face is a flat patch of colour; the rest of the mesh keeps its own", async () => {
    const mesh = meshOf(stoolParts());
    // coordinates that jump between islands: every vertex of the back posts gets its own far-away spot
    for (let v = 0; v < mesh.Q.length / 3; v++) { mesh.uv[v * 2] = (v * 0.6180339) % 1; mesh.uv[v * 2 + 1] = (v * 0.7548776) % 1; }
    const nt0 = mesh.idx.length / 3;
    const run = runProgram(mesh, program([op({ op: "delete", label: "top of the posts", boxes: [box(-400, 200, 900, 400, 400, 1100)], feather_mm: 1 })]));
    const del = run.log.find((l) => l.op === "delete");
    assert.ok(del.capped >= 2, `${del.capped} cuts capped`);
    const caps = del.triangles - (nt0 - del.deleted);
    assert.ok(caps > 0);
    const S = run.state, nt = S.idx.length / 3;
    const uvOf = (v) => [S.uv[v * 2], S.uv[v * 2 + 1]];
    for (let t = nt - caps; t < nt; t++) {
        const [a, b, c] = [S.idx[t * 3], S.idx[t * 3 + 1], S.idx[t * 3 + 2]];
        assert.deepEqual(uvOf(a), uvOf(b), `cap triangle ${t}`);
        assert.deepEqual(uvOf(a), uvOf(c), `cap triangle ${t}`);
    }
    // every kept triangle still has coordinates the source had (the cap does not invent a new place in the picture)
    const sourceUv = new Set();
    for (let v = 0; v < mesh.Q.length / 3; v++) sourceUv.add(`${mesh.uv[v * 2]},${mesh.uv[v * 2 + 1]}`);
    for (let v = 0; v < S.Q.length / 3; v++) assert.ok(sourceUv.has(`${S.uv[v * 2]},${S.uv[v * 2 + 1]}`), `vertex ${v}`);
    // the surface is as closed as before and every cap picks the picture of the place it sits in
    assert.equal(openEdges(S.Q, S.idx), 0);
    assert.equal(S.page.length, S.Q.length / 3);
});

// F6: the triangles a mirror_copy makes shared the original's texture coordinates, so painting the copy painted the original (11,411 of 12,894
// vertices of the real chair's armrest turned blue with it). The copy now looks at a second picture of its own.
const armScene = () => [boxGrid(-300, 300, -300, 300, 0, 20, [2, 2, 1]), boxGrid(-10, 10, -10, 10, 20, 1000, [1, 1, 8]), boxGrid(100, 200, -50, 50, 20, 320, [3, 3, 6])];
const armProgram = (recolorBox = box(-250, -100, 25, -50, 100, 400)) => program([
    op({ op: "mirror_copy", label: "armrest", axis: "x", mirror_at_mm: 0, boxes: [box(50, -100, 25, 250, 100, 400)], feather_mm: 2 }),
    op({ op: "recolor", label: "new armrest", color: "#0000ff", strength: 1, boxes: [recolorBox], feather_mm: 2 }),
]);
await test("F6: painting a mirrored copy leaves the original armrest alone (the copy gets its own picture), and the file validates", async () => {
    if (!codec) return skip("copy picture", "sharp is not installed");
    const f = await sourceFile({ parts: armScene(), png: await pngBytes(128, 128, [200, 120, 60]), parent: null, child: null });
    const session = await openSession(f.bytes, codec, null);
    const out = await session.run({ program: armProgram(), instruction: "copy the armrest to the other side and paint the new one blue", jobId: null });
    await expectClean(out.glb, "a copy with a picture of its own");
    assert.ok(!out.notes.some((n) => /shares its colours/.test(n)), JSON.stringify(out.notes));
    const read = readMeshGlb(out.glb);
    assert.ok(read.ok, read.reason);
    const picture = await codec.decode(read.source.texture.bytes, read.source.texture.mime, 4096);
    assert.deepEqual([picture.w, picture.h], [128, 256], "the picture is stacked twice");
    // The colour under the middle of every triangle of the armrests (a vertex sits on the edge of its island, where a pixel may be either side).
    const tally = (source, image) => {
        const P = source.positions, I = source.indices; // glTF metres: x across, y up
        const t = { original: 0, originalBlue: 0, copy: 0, copyBlue: 0 };
        for (let k = 0; k < I.length; k += 3) {
            const v = [I[k], I[k + 1], I[k + 2]];
            if (v.some((i) => P[i * 3 + 1] < 0.0215)) continue; // touches the base plate
            // this test model's coordinates are planar (x, z): a face standing across that plane has no area in the picture, nothing to paint
            const du = [source.uv[v[1] * 2] - source.uv[v[0] * 2], source.uv[v[1] * 2 + 1] - source.uv[v[0] * 2 + 1]], dv = [source.uv[v[2] * 2] - source.uv[v[0] * 2], source.uv[v[2] * 2 + 1] - source.uv[v[0] * 2 + 1]];
            if (Math.abs(du[0] * dv[1] - du[1] * dv[0]) < 1e-5) continue;
            const x = (P[v[0] * 3] + P[v[1] * 3] + P[v[2] * 3]) / 3;
            const u = (source.uv[v[0] * 2] + source.uv[v[1] * 2] + source.uv[v[2] * 2]) / 3, w = (source.uv[v[0] * 2 + 1] + source.uv[v[1] * 2 + 1] + source.uv[v[2] * 2 + 1]) / 3;
            const c = sampleVertexColors(Float32Array.from([u, w]), image, null);
            const blue = c[2] > c[0] + 40;
            if (x > 0.05) { t.original++; if (blue) t.originalBlue++; } else if (x < -0.05) { t.copy++; if (blue) t.copyBlue++; }
        }
        return t;
    };
    const tallied = tally(read.source, picture);
    assert.ok(tallied.original > 20 && tallied.copy === tallied.original, JSON.stringify(tallied));
    assert.equal(tallied.originalBlue, 0, "the original armrest kept its colour");
    assert.equal(tallied.copyBlue, tallied.copy, "the copy is blue");
    // the coordinates stay inside the stacked picture
    for (const x of read.source.uv) assert.ok(x >= 0 && x <= 1);
    // a recolor of the original side leaves the copy alone just the same
    const other = await session.run({ program: armProgram(box(50, -100, 25, 250, 100, 400)), instruction: "x", jobId: null });
    const r2 = readMeshGlb(other.glb).source;
    const t2 = tally(r2, await codec.decode(r2.texture.bytes, r2.texture.mime, 4096));
    assert.equal(t2.copyBlue, 0, "painting the original does not paint the copy");
    assert.equal(t2.originalBlue, t2.original);
});
await test("F6: a copy that is only moved, or a whole-model recolor, needs no second picture; a picture that cannot be stacked says so instead", async () => {
    if (!codec) return skip("copy picture", "sharp is not installed");
    const f = await sourceFile({ parts: armScene(), png: await pngBytes(128, 128), parent: null, child: null });
    const session = await openSession(f.bytes, codec, null);
    const mirrorOnly = await session.run({ program: program([armProgram().ops[0]]), instruction: "x", jobId: null });
    assert.deepEqual(parseGlb(mirrorOnly.glb).json.images.length, 1);
    const whole = await session.run({ program: program([armProgram().ops[0], op({ op: "recolor", label: "all", color: "#0000ff", strength: 1 })]), instruction: "x", jobId: null });
    const wholePicture = readMeshGlb(whole.glb).source.texture;
    assert.deepEqual([(await codec.decode(wholePicture.bytes, wholePicture.mime, 4096)).h], [128], "the picture was not doubled");
    // stackCopyPicture itself: what it refuses
    const image = { w: 8, h: 8, data: new Uint8Array(8 * 8 * 3).fill(100) };
    const uv = Float32Array.from([0, 0, 1, 0, 0, 1, 0.5, 0.5]);
    const page = Uint8Array.from([0, 0, 1, 1]);
    const stacked = stackCopyPicture(image, uv, page, null);
    assert.deepEqual([stacked.image.w, stacked.image.h], [8, 16]);
    assert.deepEqual([...stacked.uv], [0, 0, 1, 0, 0, 1, 0.5, 0.75]);
    assert.match(stackCopyPicture(image, uv, page, { offset: [0, 0], rotation: 0, scale: [2, 2] }).reason, /offset or scaled/);
    assert.match(stackCopyPicture(image, Float32Array.from([0, 0, 1, 0, 0, 1.5, 0, 0]), page, null).reason, /tiled/);
    assert.match(stackCopyPicture({ w: 8, h: 2049, data: new Uint8Array(8 * 2049 * 3) }, uv, page, null).reason, /too tall/);
});
await test("F6: the page of a vertex follows later ops (a delete that renumbers vertices keeps each cut on the picture of the place it was cut from)", async () => {
    const mesh = meshOf(armScene());
    const run = runProgram(mesh, program([
        op({ op: "mirror_copy", label: "armrest", axis: "x", mirror_at_mm: 0, boxes: [box(50, -100, 25, 250, 100, 400)], feather_mm: 2 }),
        op({ op: "delete", label: "top of the new armrest", boxes: [box(-250, -100, 200, -50, 100, 400)], feather_mm: 1 }),
    ]));
    const S = run.state;
    assert.equal(S.page.length, S.Q.length / 3);
    let first = 0, second = 0;
    for (let v = 0; v < S.Q.length / 3; v++) {
        const x = S.Q[v * 3];
        if (x < -50 && S.Q[v * 3 + 2] > 25) { assert.equal(S.page[v], 1, `copy vertex ${v} at x ${x}`); second++; }
        else if (x > 50 && S.Q[v * 3 + 2] > 25) { assert.equal(S.page[v], 0, `original vertex ${v}`); first++; }
    }
    assert.ok(first > 0 && second > 0);
    // the cap of the cut belongs to the copy
    const caps = run.log.find((l) => l.op === "delete").capped;
    assert.ok(caps >= 1);
});

// F9: the reader accepted glTF extensions the upload refuses, so an edit ran to the end and then could never be saved.
await test("F9: a source that uses an extension the upload would refuse is turned away before any work; the lists agree with the server's", async () => {
    const { EDITED_EXTENSIONS, MAX_EDITED_NODES: NODES, firstDisallowedExtension } = await R("edit/uploadRules.ts");
    const server = await W("editUpload.ts");
    assert.deepEqual([...EDITED_EXTENSIONS], [...server.EDITED_EXTENSIONS], "the editor and the server allow the same extensions");
    assert.equal(NODES, server.MAX_EDITED_NODES);
    const base = await sourceFile({ textured: false, parent: null, child: null });
    const doc = parseGlb(base.bytes);
    const withExtension = (name, where = "material") => {
        const json = structuredClone(doc.json);
        json.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] }, ...(where === "material" ? { extensions: { [name]: {} } } : {}) }];
        json.meshes[0].primitives[0].material = 0;
        json.extensionsUsed = [name];
        if (where === "node") json.nodes[0].extensions = { [name]: {} };
        return assembleGlb(json, doc.bin);
    };
    for (const name of ["KHR_materials_emissive_strength", "KHR_materials_clearcoat", "KHR_lights_punctual"]) {
        const r = readMeshGlb(withExtension(name));
        assert.equal(r.ok, false, name);
        assert.match(r.reason, new RegExp(`can't be edited here \\(it uses a feature that cannot be saved after an edit: ${name}`));
        assert.equal(readMeshGlb(withExtension(name, "node")).ok, false, `${name} on a node`);
    }
    for (const name of EDITED_EXTENSIONS) assert.ok(readMeshGlb(withExtension(name)).ok, `${name} is kept and allowed`);
    assert.equal(firstDisallowedExtension({ extensionsRequired: ["KHR_draco_mesh_compression"] }), "KHR_draco_mesh_compression");
    assert.equal(firstDisallowedExtension({ nodes: [{ extras: { extensions: { x: 1 } } }] }), null, "extras are not looked into");
    assert.equal(firstDisallowedExtension("nope"), null);
    // whatever the reader lets through, the server's check on the written file agrees
    for (const name of EDITED_EXTENSIONS) {
        const read = readMeshGlb(withExtension(name));
        const setup = buildEditSetup(read.source);
        const run = runProgram(setup.mesh, program([op({ op: "move", vector_mm: [10, 0, 0] })]));
        const written = parseGlb(writeEditedGlb({ source: read.source, frame: setup.frame, mesh: run.state, hasUv: false, parts: [], echo: {} }));
        assert.equal(server.checkEditedGlbJson(written.json, written.bin.byteLength), null, name);
    }
    // the writer counts nodes before the file is sent: an edit that would leave more than MAX_EDITED_NODES is refused with a sentence
    const crowded = structuredClone(doc.json);
    for (let n = 0; n < NODES - 1; n++) crowded.nodes.push({ name: `empty carrier ${n}`, mesh: 0 });
    crowded.scenes[0].nodes = crowded.nodes.map((_, i) => i);
    const crowdedRead = readMeshGlb(assembleGlb(crowded, doc.bin));
    if (crowdedRead.ok) {
        const setup = buildEditSetup(crowdedRead.source);
        const run = runProgram(setup.mesh, program([op({ op: "move", vector_mm: [10, 0, 0] })]));
        assert.throws(() => writeEditedGlb({ source: crowdedRead.source, frame: setup.frame, mesh: run.state, hasUv: false, parts: [], echo: {} }), (e) => e instanceof MeshEditError && e.code === "toobig" && /too many parts/.test(e.message));
    } else assert.match(crowdedRead.reason, /can't be edited here/);
});

// A source with a picture the server would refuse used to be edited to the end and then fail at the upload, for ever (Retry cannot help).
await test("a source whose picture is bigger than the server takes is turned away before any work; the limits and the header reading agree with the server's", async () => {
    const { MAX_EDITED_IMAGE_SIDE, MAX_EDITED_IMAGE_PIXELS, declaredPictureSize, pictureTooBig } = await R("edit/uploadRules.ts");
    const server = await W("editUpload.ts");
    const util = await W("util.ts");
    assert.equal(MAX_EDITED_IMAGE_SIDE, server.MAX_EDITED_IMAGE_SIDE);
    assert.equal(MAX_EDITED_IMAGE_PIXELS, server.MAX_EDITED_IMAGE_PIXELS);
    const png = (w, h) => {
        const b = new Uint8Array(33);
        b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        const v = new DataView(b.buffer);
        v.setUint32(16, w);
        v.setUint32(20, h);
        b[24] = 8;
        return b;
    };
    const jpeg = (w, h, app = 20) => {
        const b = new Uint8Array(2 + 2 + app + 2 + 17 + 2);
        const v = new DataView(b.buffer);
        b.set([0xff, 0xd8, 0xff, 0xe1]);
        v.setUint16(4, app);
        const at = 4 + app;
        b.set([0xff, 0xc0], at);
        v.setUint16(at + 2, 17);
        b[at + 4] = 8;
        v.setUint16(at + 5, h);
        v.setUint16(at + 7, w);
        b[at + 9] = 3;
        return b;
    };
    for (const [bytes, mime, w, h] of [[png(4096, 4096), "image/png", 4096, 4096], [png(5000, 100), "image/png", 5000, 100], [jpeg(1024, 768), "image/jpeg", 1024, 768], [jpeg(8000, 6000, 300), "image/jpeg", 8000, 6000]]) {
        assert.deepEqual(declaredPictureSize(bytes, mime), { width: w, height: h });
        assert.deepEqual(util.imageSize(bytes, mime), { width: w, height: h }, "the same reading as the server's");
    }
    assert.equal(declaredPictureSize(new Uint8Array(10), "image/png"), null);
    assert.equal(declaredPictureSize(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), null);
    assert.equal(declaredPictureSize(png(10, 10), "image/webp"), null);
    // 4096 x 4096 is the biggest; one side over, or too many pixels, is refused
    assert.equal(pictureTooBig(png(4096, 4096), "image/png"), false);
    assert.equal(pictureTooBig(png(4097, 16), "image/png"), true);
    assert.equal(pictureTooBig(png(16, 4097), "image/png"), true);
    assert.equal(pictureTooBig(jpeg(5000, 5000), "image/jpeg"), true);
    assert.equal(pictureTooBig(new Uint8Array(5), "image/png"), false, "a header that cannot be read is the server's to judge");
    // the reader says so, in the sentence the card shows, for a file whose picture is too big; a picture at the limit is fine
    const big = readMeshGlb((await sourceFile({ png: png(8192, 8192) })).bytes);
    assert.equal(big.ok, false);
    assert.match(big.reason, /can't be edited here \(its picture is larger than 4096 pixels on a side\)/);
    const limit = readMeshGlb((await sourceFile({ png: png(4096, 4096) })).bytes);
    assert.ok(limit.ok, limit.reason);
    // and what the server's check says of a file the reader let through
    const setup = buildEditSetup(limit.source);
    const run = runProgram(setup.mesh, program([op({ op: "move", vector_mm: [10, 0, 0] })]));
    const written = parseGlb(writeEditedGlb({ source: limit.source, frame: setup.frame, mesh: run.state, hasUv: true, parts: [], echo: {} }));
    assert.equal(server.checkEditedGlbJson(written.json, written.bin.byteLength), null);
});

section("the real Hunyuan model (the 27.8 MB rocking chair)");

const SCRATCH = "/private/tmp/claude-501/-Users-josephmirzai-Documents-Nevo-website/f150fdea-65e6-490a-bbdb-a687fe25ab2f/scratchpad/design2-edit/";
const { readFileSync, existsSync } = await import("node:fs");
const storedProgram = (tag) => {
    const file = `${SCRATCH}out-mesh-${tag}.json`;
    if (!existsSync(file)) return null;
    const r = sanitizeProgram(JSON.parse(readFileSync(file, "utf8")));
    return r.ok ? r.program : null;
};
const time = async (label, fn) => { const t0 = performance.now(); const out = await fn(); facts.push(`${label}: ${Math.round(performance.now() - t0)} ms`); return out; };

if (!hasHunyuan()) {
    skip("the real Hunyuan model", `${HUNYUAN_GLB} is not there`);
} else {
    const bytes = readHunyuan();
    const read = await time("read the 27.8 MB GLB", () => readMeshGlb(bytes));
    const src = read.source;
    const setup = await time("frame and working arrays", () => buildEditSetup(src));

    await test("hunyuan: 499,808 triangles, 643 x 851 x 1000 mm in the frame, world positions equal gltf-transform's", async () => {
        assert.ok(read.ok, read.reason);
        assert.equal(setup.mesh.idx.length / 3, 499808);
        assert.equal(setup.mesh.Q.length / 3, 288423);
        assert.deepEqual(setup.frame.sizeMm.map(Math.round), [643, 851, 1000]);
        assert.equal(src.texture.mime, "image/png");
        assert.equal(src.carried.length, 0);
        const doc = await new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT)).readBinary(bytes);
        const node = doc.getRoot().listNodes()[0];
        const L = node.getMesh().listPrimitives()[0].getAttribute("POSITION").getArray();
        const world = applyM(node.getWorldMatrix(), L);
        let worst = 0;
        for (let i = 0; i < world.length; i += 9) worst = Math.max(worst, Math.abs(world[i] - src.positions[i]), Math.abs(world[i + 1] - src.positions[i + 1]), Math.abs(world[i + 2] - src.positions[i + 2]));
        assert.ok(worst < 1e-6, `worst difference ${worst}`);
        assert.ok(signedVolume(setup.mesh.Q, setup.mesh.idx) !== 0);
    });

    const stored = { stretch: storedProgram("backrest-taller"), del: storedProgram("rm-left-arm"), cup: storedProgram("green-cup"), mirror: storedProgram("hand-mirror-seat"), xform: storedProgram("hand-xform") };

    await test("hunyuan: the stored model answers run, write and validate 0/0/0 (stretch, delete, recolor + parts, delete + mirror + recolor, scale + rotate + move)", async () => {
        if (!codec) return skip("hunyuan programs", "sharp is not installed");
        const image = await time("decode the 4096 px picture to 2048", () => codec.decode(src.texture.bytes, src.texture.mime, 2048));
        for (const [name, p] of Object.entries(stored)) {
            if (!p) { skip(`hunyuan ${name}`, "the stored answer is not there"); continue; }
            const run = await time(`run ${name}`, () => runProgram(setup.mesh, p));
            const paint = await time(`paint ${name}`, () => applyPaints(codec, src.texture, image, run.state.uv, run.state.idx, run.state.paints, src.baseColor));
            const glb = await time(`write ${name}`, () => writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: true, parts: run.state.parts, image: paint.image, echo: { version: 1, target: "mesh" } }));
            await expectClean(glb, `hunyuan ${name}`);
            assert.ok(glb.length < EDITED_GLB_LIMIT);
            facts.push(`${name}: ${(glb.length / 1e6).toFixed(1)} MB, ${run.state.idx.length / 3} triangles, ${run.state.parts.length} parts${paint.image ? ", picture repainted (JPEG)" : ", original picture kept"}`);
            if (name === "stretch") {
                assert.ok(near(bounds(run.state.Q).max[2], 1150, 0.5), "the backrest grew by 150 mm");
                assert.ok(glb.length > 26_000_000, "the original PNG is kept");
            }
            if (name === "del") {
                assert.ok(run.log.find((l) => l.op === "delete").capped >= 4, "the arm's holes are capped");
                assert.ok(run.state.idx.length < setup.mesh.idx.length);
            }
            if (paint.image) assert.ok(glb.length < 20_000_000, "a repainted picture is a 2048 px JPEG");
            if (name === "cup") assert.equal(run.state.parts.length, 2);
        }
    });

    await test("hunyuan: a delete leaves the surface as closed as it was (every cut is capped)", async () => {
        if (!stored.del) return skip("hunyuan delete caps", "the stored answer is not there");
        const before = openEdges(setup.mesh.Q, setup.mesh.idx);
        const run = runProgram(setup.mesh, stored.del);
        const after = openEdges(run.state.Q, run.state.idx);
        facts.push(`open edges of the chair before / after the arm is deleted: ${before} / ${after}`);
        assert.equal(after, before, "no open or doubled edge was made");
        const used = new Uint8Array(run.state.Q.length / 3);
        for (const i of run.state.idx) used[i] = 1;
        assert.ok(used.every((u) => u === 1), "no unused vertex is left");
    });

    // The two findings of the review that were measured on this model: the cut faces smeared the picture across the cut (770 of 839 cap triangles
    // spanned more than 5% of it), and painting a copy of the armrest painted the armrest (11,411 of its 12,894 vertices).
    await test("hunyuan: the cut faces of a deleted armrest are flat patches (one coordinate per cap)", async () => {
        if (!stored.del) return skip("hunyuan cap coordinates", "the stored answer is not there");
        const nt0 = setup.mesh.idx.length / 3;
        const run = runProgram(setup.mesh, stored.del);
        const del = run.log.find((l) => l.op === "delete");
        const nt = run.state.idx.length / 3, caps = del.triangles - (nt0 - del.deleted);
        assert.ok(caps > 100, `${caps} cap triangles`);
        const S = run.state;
        let widest = 0;
        for (let t = nt - caps; t < nt; t++) {
            const v = [S.idx[t * 3], S.idx[t * 3 + 1], S.idx[t * 3 + 2]];
            for (const k of [1, 2]) widest = Math.max(widest, Math.abs(S.uv[v[0] * 2] - S.uv[v[k] * 2]), Math.abs(S.uv[v[0] * 2 + 1] - S.uv[v[k] * 2 + 1]));
        }
        facts.push(`widest picture span inside one cap triangle: ${widest}`);
        assert.equal(widest, 0, "the cap is one colour");
    });

    await test("hunyuan: a copy of the armrest painted blue leaves the armrest it was copied from alone; the file validates 0/0/0", async () => {
        if (!codec) return skip("hunyuan copy picture", "sharp is not installed");
        const flat = (o) => ({ boxes: [], exclude: [], feather_mm: 3, axis: "x", from_mm: 0, to_mm: 0, amount_mm: 0, vector_mm: [0, 0, 0], factors: [1, 1, 1], pivot_mm: [0, 0, 0], degrees: 0, mirror_at_mm: 0, color: "#000000", strength: 0, parts: [], ...o });
        const p = sanitizeProgram({ summary: "copy the armrest across and paint the copy", applied: true, ops: [
            flat({ op: "delete", label: "left armrest", boxes: [{ min: [200, -300, 440], max: [360, 170, 660] }] }),
            flat({ op: "mirror_copy", label: "right armrest", boxes: [{ min: [-360, -300, 440], max: [-200, 170, 660] }] }),
            flat({ op: "recolor", label: "new left armrest", boxes: [{ min: [200, -300, 440], max: [360, 170, 660] }], color: "#0000ff", strength: 1 }),
        ] });
        assert.ok(p.ok);
        const session = await openSession(bytes, codec, null);
        const out = await time("run + write (delete, copy, paint the copy)", () => session.run({ program: p.program, instruction: "x", jobId: null }));
        await expectClean(out.glb, "hunyuan copy with a picture of its own");
        assert.ok(out.glb.length < EDITED_GLB_LIMIT);
        facts.push(`copy painted: ${(out.glb.length / 1e6).toFixed(1)} MB`);
        const read = readMeshGlb(out.glb).source;
        const picture = await codec.decode(read.texture.bytes, read.texture.mime, 4096);
        assert.deepEqual([picture.w, picture.h], [2048, 4096]);
        let lo = Infinity, hi = -Infinity, minX = Infinity, maxX = -Infinity;
        for (let i = 1; i < read.positions.length; i += 3) { lo = Math.min(lo, read.positions[i]); hi = Math.max(hi, read.positions[i]); }
        for (let i = 0; i < read.positions.length; i += 3) { minX = Math.min(minX, read.positions[i]); maxX = Math.max(maxX, read.positions[i]); }
        const cx = (minX + maxX) / 2;
        const P = read.positions, I = read.indices, uv = read.uv;
        let source = 0, sourceBlue = 0, copy = 0, copyBlue = 0;
        for (let k = 0; k < I.length; k += 3) {
            const v = [I[k], I[k + 1], I[k + 2]];
            const z = ((P[v[0] * 3 + 1] + P[v[1] * 3 + 1] + P[v[2] * 3 + 1]) / 3 - lo) / (hi - lo) * 1000;
            const x = ((P[v[0] * 3] + P[v[1] * 3] + P[v[2] * 3]) / 3 - cx) / (hi - lo) * 1000;
            if (z < 440 || z > 660 || Math.abs(x) < 215 || Math.abs(x) > 345) continue;
            const c = sampleVertexColors(Float32Array.from([(uv[v[0] * 2] + uv[v[1] * 2] + uv[v[2] * 2]) / 3, (uv[v[0] * 2 + 1] + uv[v[1] * 2 + 1] + uv[v[2] * 2 + 1]) / 3]), picture, read.texture.transform);
            const blue = c[2] > c[0] + 40 && c[2] > c[1] + 20;
            if (x < 0) { source++; if (blue) sourceBlue++; } else { copy++; if (blue) copyBlue++; }
        }
        facts.push(`armrest triangles: ${source} original (${sourceBlue} blue), ${copy} copied (${copyBlue} blue)`);
        assert.ok(source > 1000 && copy > 1000);
        assert.equal(sourceBlue, 0, "the armrest that was copied kept its colour");
        assert.ok(copyBlue > copy * 0.6, `the copy is blue: ${copyBlue} of ${copy} triangles`);
    });

    await test("hunyuan: an edited file is edited again (the parts of the first edit are carried), and the second file validates", async () => {
        if (!stored.cup || !stored.stretch) return skip("hunyuan second edit", "the stored answers are not there");
        const run1 = runProgram(setup.mesh, { ...stored.cup, ops: stored.cup.ops.filter((o) => o.op === "add_parts") });
        const glb1 = writeEditedGlb({ source: src, frame: setup.frame, mesh: run1.state, hasUv: true, parts: run1.state.parts, echo: {} });
        const r2 = readMeshGlb(glb1);
        assert.ok(r2.ok, r2.reason);
        assert.equal(r2.source.carried.length, 2);
        assert.ok(r2.source.texture.bytes.length === src.texture.bytes.length, "the picture came along");
        const setup2 = buildEditSetup(r2.source);
        assert.equal(setup2.pieces.length, 2);
        const run2 = runProgram(setup2.mesh, stored.stretch);
        const glb2 = writeEditedGlb({ source: r2.source, frame: setup2.frame, mesh: run2.state, hasUv: true, parts: [], echo: {} });
        await expectClean(glb2, "hunyuan edited twice");
        assert.equal(readMeshGlb(glb2).source.carried.length, 2);
    });

    await test("hunyuan: the package for the model: three pictures, facts, under the 400 KB limit as PNG", async () => {
        if (!codec) return skip("hunyuan package", "sharp is not installed");
        const image = await codec.decode(src.texture.bytes, src.texture.mime, 2048);
        const pkg = await time("describe (three 512 px pictures)", () => describeMesh({ setup, source: src, image, originalPrompt: "a wooden rocking chair" }));
        const size = JSON.stringify(pkg).length;
        facts.push(`package JSON ${Math.round(size / 1024)} KB (limit ${EDIT_PACKAGE_LIMIT / 1024} KB), pictures ${pkg.views.map((v) => Math.round(v.image.length * 0.75 / 1024)).join(" + ")} KB`);
        assert.ok(size < EDIT_PACKAGE_LIMIT, `${size} bytes`);
        assert.match(pkg.facts, /size X 643 mm, Y 851 mm, Z 1000 mm; 499,808 triangles; textured; main colours brown/);
        assert.equal(pkg.original_prompt, "a wooden rocking chair");
        const jpeg = await sharpJpeg(rasterize([{ Q: setup.mesh.Q, idx: setup.mesh.idx, colors: new Uint8Array(setup.mesh.Q.length).fill(150) }], VIEWS[0], { size: 512, fit: { min: [-322, -426, 0], max: [322, 426, 1000] } }).rgb, 512, 512, 0.8);
        facts.push(`a 512 px picture as JPEG q80: ${Math.round(jpeg.length / 1024)} KB`);
    });

    await test("hunyuan: a session opens, describes and runs the stretch end to end; memory stays reasonable", async () => {
        if (!codec) return skip("hunyuan session", "sharp is not installed");
        const before = process.memoryUsage().rss;
        const session = await time("open the session (read + decode + frame)", () => openSession(bytes, codec, "a rocking chair"));
        const pkg = await session.describe("png");
        assert.equal(pkg.views.length, 3);
        const out = await time("run + write (stretch)", () => session.run({ program: stored.stretch ?? program([op({ op: "stretch", axis: "z", from_mm: 600, to_mm: 900, amount_mm: 150, boxes: [box(-320, 80, 350, 320, 360, 1020)], feather_mm: 40 })]), instruction: "make the backrest taller", jobId: null }));
        await expectClean(out.glb, "hunyuan session");
        facts.push(`resident memory grew by about ${Math.round((process.memoryUsage().rss - before) / 1e6)} MB over the session`);
    });
}

// ============================================================ FOOTER
for (const f of facts) console.log(`  info ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed${notes.length ? `, ${notes.length} skipped` : ""}`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
