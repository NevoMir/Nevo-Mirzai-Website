// The stabilized model must sit exactly on the model it was made from.
//
// The 3D tab of a stabilized model shows the ORIGINAL mesh with the blocks the stabilizer added drawn over it, and the Analysis tab
// shows the whole stabilized assembly over the same mesh. That only works when the blocks of a stabilized model are in the frame of
// the source's own voxelisation: the stabilizer works in that grid, and voxelize.ts's transformForBounds(bounds of the source mesh)
// is what puts the lattice over the mesh. This script proves it on every bundled example, with the code the browser runs:
//
//   1. the source mesh is loaded the way the viewer loads it (GLTFLoader, glTF Y-up -> Z-up, world transforms baked, normalised),
//   2. voxelised with the settings the stabilized version records (DerivedMeta): the occupied cells must be EXACTLY the
//      "original" cells of the stabilized GLB's descriptor,
//   3. the stabilized descriptor is analysed with the source's transform (the viewer's "stabilized model over the source mesh"):
//      every block lands inside the 1000 mm cube, every original block overlaps the source mesh's scaled bounding box, the mesh's
//      own vertices fall in original blocks (or touch one), and the ground contact lines up,
//   4. the transform is a pure function of the bounds, so the viewer's normalised copy and a script's raw copy of a mesh place the
//      blocks alike.
// It also pins versionFamily (store/versions.ts) for chains: generated -> stabilized -> stabilized again, example -> stabilized and a
// deleted source, and the way a stabilized model's blocks are fetched and kept (loadAssembly).
//
//   node scripts/assignment/test-alignment.mjs
//
// The .ts modules are imported directly (Node 22 strips the types); store/versions.ts is bundled with esbuild (it uses the "@/" alias
// and zustand), with a stand-in for react because no hook is run here.
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = join(ROOT, "public/assignment_alex/examples");
const A = (name) => import(pathToFileURL(join(ROOT, "src/assignment", `${name}.ts`)).href);

const { loadSoupLikeTheApp, readAssemblyGlb, normalizeSettings, voxelize, analyzeGrid, analyzeAssembly } = await import("./examples/lib/engine.mjs");
const { transformForBounds, placementForBounds, finiteBounds } = await A("analysis/voxelize");
const { soupBoundsOf, gridFromAssembly, sourceTransformOf, sourcePlacementOf } = await A("analysis/assembly");
const { toAnalysisMm, toModelSpace } = await A("analysis/analyze");
const { CELL_STRIDE } = await A("shared/assembly");

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
const near = (a, b, eps, message) => assert.ok(Math.abs(a - b) <= eps, `${message}: ${a} vs ${b}`);
const bytesOf = (file) => new Uint8Array(readFileSync(file));
const key = (c) => `${c[0]},${c[1]},${c[2]}`;

/** The cells of a descriptor, with the role index and step, in its canonical order. */
function cellsOfDescriptor(desc) {
    const out = [];
    for (let n = 0; n < desc.cells.length; n += CELL_STRIDE) out.push({ cell: [desc.cells[n], desc.cells[n + 1], desc.cells[n + 2]], role: desc.cells[n + 3], step: desc.cells[n + 4] });
    return out;
}

// ================= every bundled example =================

const manifest = JSON.parse(readFileSync(join(EXAMPLES, "manifest.json"), "utf8"));
assert.ok(manifest.examples.length >= 6, "the manifest lists the examples");

for (const entry of manifest.examples) {
    const dir = join(EXAMPLES, entry.slug);
    const originalBytes = bytesOf(join(dir, "original.glb"));
    const stabilizedBytes = bytesOf(join(dir, "stabilized.glb"));
    const derived = JSON.parse(readFileSync(join(dir, "detail.json"), "utf8")).derived;
    const read = readAssemblyGlb(stabilizedBytes);
    assert.ok(read.ok, `${entry.slug}: stabilized.glb is a block assembly (${read.error})`);
    const desc = read.descriptor;
    // The settings the stabilized version was made with (DerivedMeta), over the defaults.
    const settings = normalizeSettings({ fillThreshold: derived.fill_threshold, cantileverLimit: derived.cantilever_limit, material: derived.material });
    const { soup } = await loadSoupLikeTheApp(originalBytes);
    const bounds = soupBoundsOf(soup.positions);
    const placed = cellsOfDescriptor(desc);
    const originals = placed.filter((c) => c.role === 0);
    const added = placed.filter((c) => c.role !== 0);

    await test(`${entry.slug}: voxelising the source gives exactly the stabilized model's original blocks`, () => {
        assert.ok(bounds, "the source has triangles");
        const grid = voxelize(soup, settings);
        const source = analyzeGrid(grid, settings);
        const voxelised = new Set(source.blocks.map((b) => key(b.cell)));
        const declared = new Set(originals.map((c) => key(c.cell)));
        assert.equal(voxelised.size, source.blocks.length, "no cell twice");
        assert.deepEqual([...voxelised].sort(), [...declared].sort(), "occupied cells = the descriptor's original-role cells");
        assert.equal(derived.before.blocks, voxelised.size, "and the log's 'before' counts them");
        assert.equal(originals.length + added.length, desc.cells.length / CELL_STRIDE);
        assert.equal(added.length, derived.added_blocks, "the log counts the added blocks");
        // The transform voxelize applied is the one the bounds give: the same function.
        assert.deepEqual(grid.transform, transformForBounds(bounds, settings), "voxelize and transformForBounds agree exactly");
        assert.deepEqual(grid.transform, sourceTransformOf(bounds, settings, desc), "so does the transform a stabilized model uses over this mesh");
    });

    await test(`${entry.slug}: the stabilized assembly over the source mesh lies in the cube, on the mesh and on the ground`, () => {
        const T = sourceTransformOf(bounds, settings, desc);
        const result = analyzeAssembly(desc, null, settings, desc, T);
        assert.deepEqual(result.transform, T, "the result carries the source's transform");
        assert.equal(result.blocks.length, desc.cells.length / CELL_STRIDE);
        const cube = settings.targetSizeMm;
        for (const b of result.blocks) {
            b.centerMm.forEach((v, a) => assert.ok(v > 0 && v < cube, `block ${key(b.cell)} centre axis ${a} = ${v} is inside the ${cube} mm cube`));
        }
        // The mesh's scaled box: from the placement, mm. Original blocks hold some of the mesh, so each overlaps the box (a fine cell of slack for the conservative surface cells).
        const { sizeMm } = placementForBounds(bounds, settings);
        const lo = [T.offsetMm[0], T.offsetMm[1], 0];
        const hi = [lo[0] + sizeMm[0], lo[1] + sizeMm[1], sizeMm[2]];
        const bs = settings.blockSizeMm;
        const slack = bs / 12;
        result.blocks.forEach((b, n) => {
            if (placed[n].role !== 0) return;
            for (let a = 0; a < 3; a++) {
                const from = b.cell[a] * bs;
                assert.ok(from < hi[a] + slack && from + bs > lo[a] - slack, `original block ${key(b.cell)} overlaps the mesh box on axis ${a} (${from}..${from + bs} vs ${lo[a]}..${hi[a]})`);
                assert.ok(b.centerMm[a] >= lo[a] - bs / 2 - 1e-6 && b.centerMm[a] <= hi[a] + bs / 2 + 1e-6, `original block ${key(b.cell)} centre is within half a block of the mesh box on axis ${a}`);
            }
        });
        // The ground: the mesh sits on z = 0 (its lowest vertex maps there), and nothing is added below the lattice.
        const p = soup.positions;
        let lowest = Infinity;
        for (let o = 2; o < p.length; o += 3) lowest = Math.min(lowest, toAnalysisMm([p[o - 2], p[o - 1], p[o]], T)[2]);
        near(lowest, 0, 1e-6, "the mesh's lowest vertex is on the ground");
        assert.ok(Math.min(...placed.map((c) => c.cell[2])) >= 0);
        // The mesh's own vertices, put into the lattice with the SAME transform, fall in (or beside) original blocks. A vertex on a block
        // boundary (a flat face at a block edge) belongs to the blocks on both sides, so the cells within 1 mm of it all count.
        const occupied = new Set(originals.map((c) => key(c.cell)));
        const around = (mm) => {
            const cells = [[]];
            for (let a = 0; a < 3; a++) {
                const lo = Math.min(9, Math.max(0, Math.floor((mm[a] - 1) / bs)));
                const hi = Math.min(9, Math.max(0, Math.floor((mm[a] + 1) / bs)));
                const next = [];
                for (const c of cells) for (let v = lo; v <= hi; v++) next.push([...c, v]);
                cells.splice(0, cells.length, ...next);
            }
            return cells;
        };
        const near26 = (i, j, k) => {
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) if (occupied.has(key([i + di, j + dj, k + dk]))) return true;
            return false;
        };
        // What the voxeliser saw before the fill threshold: a block holding any of the mesh. The vertices are surface points, so each is in one.
        const grid = voxelize(soup, settings);
        const g = grid.gridSize[0];
        const holdsMesh = (c) => grid.solid[(c[2] * g + c[1]) * g + c[0]] > 0;
        let inside = 0;
        let touching = 0;
        let total = 0;
        for (let o = 0; o + 2 < p.length; o += 3) {
            const mm = toAnalysisMm([p[o], p[o + 1], p[o + 2]], T);
            const cells = around(mm);
            total++;
            assert.ok(cells.some(holdsMesh), `vertex ${o / 3} at ${mm.map((v) => v.toFixed(1))} mm is in a block the voxeliser filled`);
            if (cells.some((c) => occupied.has(key(c)))) inside++;
            if (cells.some((c) => near26(c[0], c[1], c[2]))) touching++;
        }
        // Thin parts (pencil legs, a glass terrace) are blocks under the fill threshold and so are not original blocks: the shares are for the log.
        console.log(`       ${entry.slug}: ${(100 * inside / total).toFixed(1)} % of ${total} vertices in an original block, ${(100 * touching / total).toFixed(1)} % in or next to one; ${originals.length} original + ${added.length} added blocks`);
        assert.ok(touching / total > 0.9, `nearly every vertex is in or next to an original block (${touching}/${total})`);
        assert.ok(inside / total > 0.6, `most vertices are inside an original block (${inside}/${total})`);
        // Round trip through the viewer's frame: a block centre -> a point in the source's frame -> the same block centre.
        for (const b of result.blocks.slice(0, 40)) {
            const back = toAnalysisMm(toModelSpace(b.centerMm, T), T);
            back.forEach((v, a) => near(v, b.centerMm[a], 1e-6, `round trip axis ${a}`));
        }
    });

    await test(`${entry.slug}: over the source mesh the stabilized model is as big as the original on the same mesh (same size, same saved size)`, () => {
        const placement = sourcePlacementOf(bounds, settings, desc);
        const original = analyzeGrid(voxelize(soup, settings), settings);
        const stabilized = analyzeAssembly(desc, null, settings, desc, placement.transform, placement.sizeMm);
        assert.deepEqual(stabilized.transform, original.transform, "one frame");
        assert.deepEqual(stabilized.sizeMm, original.sizeMm, "one size");
        assert.deepEqual(stabilized.summary.size_mm, original.summary.size_mm, "so the saved summaries agree about how big the model is");
        // The lattice's own extent (the stabilizer's measure, and what the result said before it was told the mesh) is not the mesh's box.
        const lattice = analyzeAssembly(desc, null, settings, desc, placement.transform);
        assert.deepEqual(lattice.transform, placement.transform);
        assert.equal(lattice.blocks.length, stabilized.blocks.length);
        assert.deepEqual(stabilized.blocks, lattice.blocks, "the size changes nothing else");
    });

    await test(`${entry.slug}: the source's transform is the same for the viewer's normalised copy and a raw copy of the mesh`, () => {
        // A uniform scale and a shift of the mesh (what normalising does) change the transform but not what it maps to.
        const k = 7.5;
        const shift = [123.4, -56.7, 8.9];
        const raw = new Float32Array(soup.positions.length);
        for (let o = 0; o < raw.length; o += 3) for (let a = 0; a < 3; a++) raw[o + a] = soup.positions[o + a] * k + shift[a];
        const T = transformForBounds(soupBoundsOf(soup.positions), settings);
        const R = transformForBounds(soupBoundsOf(raw), settings);
        for (let o = 0; o + 2 < soup.positions.length; o += 3 * 97) {
            const a = toAnalysisMm([soup.positions[o], soup.positions[o + 1], soup.positions[o + 2]], T);
            const b = toAnalysisMm([raw[o], raw[o + 1], raw[o + 2]], R);
            a.forEach((v, axis) => near(v, b[axis], 2e-3, `vertex ${o / 3} axis ${axis}`));
        }
    });
}

// ================= transformForBounds =================

await test("transformForBounds is voxelize's own transform, including the empty and the single-point mesh", () => {
    const settings = normalizeSettings({});
    const cases = {
        slab: [0, 0, 0, 40, 0, 0, 0, 20, 0, 40, 20, 0, 0, 0, 7, 40, 0, 7, 0, 20, 7],
        tower: [5, 5, 5, 6, 5, 5, 5, 6, 50, 5, 5, 50, 6, 5, 50, 5, 6, 5],
        dot: [3, 4, 5, 3, 4, 5, 3, 4, 5],
        none: [],
        hasNaN: [0, 0, 0, 1, 0, 0, 0, 1, NaN, 0, 0, 0, 10, 0, 0, 0, 10, 0],
    };
    for (const [name, floats] of Object.entries(cases)) {
        const positions = Float32Array.from(floats.slice(0, Math.floor(floats.length / 9) * 9));
        const grid = voxelize({ positions }, settings);
        const b = finiteBounds(positions, positions.length / 9);
        assert.deepEqual(transformForBounds(b, settings), grid.transform, `${name}: the same transform`);
        assert.deepEqual(placementForBounds(b, settings).sizeMm, grid.sizeMm, `${name}: the same size`);
        const bounds = soupBoundsOf(positions);
        assert.equal(bounds === null, b.valid === 0, `${name}: soupBoundsOf is null exactly when voxelize has no triangle`);
        if (bounds) assert.deepEqual(transformForBounds(bounds, settings), grid.transform, `${name}: from soupBoundsOf`);
    }
    // The documented rule: the longest side becomes the target, X and Y are centred, the lowest point is on the ground.
    const t = transformForBounds({ min: [10, 20, 30], max: [30, 120, 50] }, settings);
    near(t.factor, 10, 1e-12, "factor");
    assert.deepEqual(t.modelMin, [10, 20, 30]);
    assert.deepEqual(t.offsetMm, [400, 0, 0]);
    // A non-box is an empty model, centred.
    assert.deepEqual(transformForBounds({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, settings), { factor: 1, modelMin: [0, 0, 0], offsetMm: [500, 500, 0] });
});

await test("a transform given to a stabilized model replaces the one derived from the GLB's triangles", () => {
    const entry = manifest.examples[0];
    const read = readAssemblyGlb(bytesOf(join(EXAMPLES, entry.slug, "stabilized.glb")));
    assert.ok(read.ok);
    const settings = normalizeSettings({});
    const frameBounds = { min: [0, 0, 0], max: [1, 1, 1] };
    const derivedFromGlb = gridFromAssembly(read.descriptor, frameBounds, settings);
    const given = { factor: 2.5, modelMin: [1, 2, 3], offsetMm: [4, 5, 6] };
    const placed = gridFromAssembly(read.descriptor, frameBounds, settings, read.descriptor, given);
    assert.deepEqual(placed.transform, given);
    assert.notDeepEqual(derivedFromGlb.transform, given);
    assert.notEqual(placed.transform, given, "a copy: the result owns its transform");
    assert.deepEqual(placed.solid, derivedFromGlb.solid, "the blocks are the same");
    assert.deepEqual(placed.sizeMm, derivedFromGlb.sizeMm);
    // The mesh's box replaces the lattice's extent only together with a transform: a size alone is not a placement.
    const box = [640, 480, 900];
    const sized = gridFromAssembly(read.descriptor, frameBounds, settings, read.descriptor, given, box);
    assert.deepEqual(sized.sizeMm, box);
    assert.notEqual(sized.sizeMm, box, "a copy");
    assert.deepEqual(sized.transform, given);
    assert.deepEqual(sized.solid, placed.solid);
    assert.deepEqual(gridFromAssembly(read.descriptor, frameBounds, settings, read.descriptor, null, box).sizeMm, derivedFromGlb.sizeMm);
});

// ================= the family of a model, and its blocks =================

const outDir = join(ROOT, "node_modules/.tmp/assignment-alignment-test");
mkdirSync(outDir, { recursive: true });
await build({
    stdin: {
        contents: 'export * from "@/assignment/store/versions";',
        resolveDir: ROOT,
        sourcefile: "entry.ts",
        loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(outDir, "versions.mjs"),
    tsconfig: join(ROOT, "tsconfig.app.json"),
    nodePaths: [join(ROOT, "node_modules")],
    logLevel: "error",
    plugins: [
        {
            name: "react-stand-in",
            setup(b) {
                b.onResolve({ filter: /^react$/ }, () => ({ path: "react-stand-in", namespace: "shim" }));
                b.onLoad({ filter: /^react-stand-in$/, namespace: "shim" }, () => ({
                    contents: `export const useEffect = () => {}; export const useMemo = (f) => f(); export const useSyncExternalStore = (_s, get) => get();
                               export default { useEffect, useMemo, useSyncExternalStore };`,
                    loader: "js",
                }));
            },
        },
    ],
});
const V = await import(pathToFileURL(join(outDir, "versions.mjs")).href);

let clock = Date.parse("2026-10-24T09:00:00Z");
const tick = () => new Date((clock += 60_000)).toISOString();
let ids = 0;
const model = (kind, over = {}) => ({
    id: `m${++ids}`,
    project_id: "p",
    job_id: "",
    provider: kind === "stabilized" ? "stabilizer" : "hunyuan",
    prompt: "a lamp",
    glb_url: `/glb/m${ids}.glb`,
    thumbnail_url: null,
    size_bytes: 1,
    part_count: 1,
    created_at: tick(),
    analysis: null,
    kind,
    source_model_id: null,
    example_slug: null,
    derived: null,
    ...over,
});
const ofIds = (list) => list.map((m) => m.id);

await test("versionFamily: a generated model on its own is its own family and displays itself", () => {
    const g = model("generated");
    const f = V.versionFamily([g], g.id);
    assert.equal(f.root, g);
    assert.deepEqual(f.versions, []);
    assert.equal(f.active, g);
    assert.equal(f.display, g);
    assert.equal(f.isVersion, false);
    assert.equal(V.versionFamily([g], null), null);
    assert.equal(V.versionFamily([g], "nope"), null);
    assert.equal(V.versionFamily([], g.id), null);
});

await test("versionFamily: generated -> stabilized -> stabilized again is one family whose display is the generated model", () => {
    const g = model("generated");
    const s1 = model("stabilized", { source_model_id: g.id });
    const s2 = model("stabilized", { source_model_id: s1.id });
    const models = [g, s1, s2];
    for (const active of models) {
        const f = V.versionFamily(models, active.id);
        assert.equal(f.root, g, `root from ${active.id}`);
        assert.deepEqual(ofIds(f.versions), [s1.id, s2.id], "oldest first (v2, v3)");
        assert.equal(f.active, active);
        assert.equal(f.display, g, "the viewer loads the original mesh");
        assert.equal(f.isVersion, active !== g);
        assert.equal(f.onSource, active !== g, "a version is drawn over the original's mesh");
    }
    // A second version made straight from the root joins the family and is the newest.
    const s3 = model("stabilized", { source_model_id: g.id });
    const f = V.versionFamily([g, s1, s2, s3], s1.id);
    assert.deepEqual(ofIds(f.versions), [s1.id, s2.id, s3.id]);
    assert.equal(f.display, g);
    // Another project's family is not part of it.
    const other = model("generated");
    const otherVersion = model("stabilized", { source_model_id: other.id });
    const both = V.versionFamily([g, s1, other, otherVersion], s1.id);
    assert.deepEqual(ofIds(both.versions), [s1.id]);
    assert.equal(V.versionFamily([g, s1, other, otherVersion], otherVersion.id).root, other);
});

await test("versionFamily: an example and its stabilized twin (same instant) are ordered by their place in the list", () => {
    const stamp = "2026-10-24T09:00:00.000Z";
    const ex = model("example", { created_at: stamp, example_slug: "desk-lamp" });
    const twin = model("stabilized", { created_at: stamp, example_slug: "desk-lamp", source_model_id: ex.id });
    const again = model("stabilized", { created_at: stamp, example_slug: "desk-lamp", source_model_id: twin.id });
    const f = V.versionFamily([ex, twin, again], twin.id);
    assert.equal(f.root, ex);
    assert.deepEqual(ofIds(f.versions), [twin.id, again.id], "later in the list is newer when the stamps agree");
    assert.equal(f.head, twin, "the right half of the bar is the version on screen");
    assert.equal(V.versionFamily([ex, twin, again], ex.id).head, again, "and from the original, the newest");
    assert.equal(f.display, ex);
    assert.equal(V.displayModelOf([ex, twin, again], again.id), ex);
    assert.equal(V.displayModelOf([ex, twin, again], ex.id), ex);
    assert.equal(V.displayModelOf([ex, twin, again], "nope"), null);
});

await test("versionFamily: a deleted source falls back to showing the stabilized model itself", () => {
    const g = model("generated");
    const s1 = model("stabilized", { source_model_id: g.id });
    const s2 = model("stabilized", { source_model_id: s1.id });
    // The original is gone: both versions are left without a root.
    const f = V.versionFamily([s1, s2], s2.id);
    assert.equal(f.root, null);
    assert.deepEqual(f.versions, []);
    assert.equal(f.active, s2);
    assert.equal(f.display, s2, "the stabilized GLB is what the viewer loads");
    assert.equal(f.isVersion, true);
    assert.equal(f.head, null, "no original, no pair to flip between");
    // A middle link missing: s2's chain ends before a root.
    const broken = V.versionFamily([g, s2], s2.id);
    assert.equal(broken.root, null);
    assert.equal(broken.display, s2);
    // A source id that is null, or a version that names itself or loops, is a stabilized model without a root, never a crash.
    const orphan = model("stabilized", { source_model_id: null });
    assert.equal(V.versionFamily([orphan], orphan.id).display, orphan);
    const selfish = model("stabilized");
    selfish.source_model_id = selfish.id;
    assert.equal(V.versionFamily([selfish], selfish.id).display, selfish);
    const a = model("stabilized");
    const b = model("stabilized", { source_model_id: a.id });
    a.source_model_id = b.id;
    assert.equal(V.versionFamily([a, b], a.id).root, null);
    // The original comes back in the list: the family is whole again.
    assert.equal(V.versionFamily([g, s1, s2], s2.id).display, g);
    // A server from before the stabilizer sends no kind: it reads as a mesh.
    const legacy = { ...model("generated"), kind: undefined };
    assert.equal(V.versionFamily([legacy], legacy.id).display, legacy);
});

await test("versionFamily: a source mesh that failed to load is not displayed (the stabilized model shows its own blocks) until the failure is cleared", () => {
    const g = model("generated");
    const s1 = model("stabilized", { source_model_id: g.id });
    const s2 = model("stabilized", { source_model_id: s1.id });
    const models = [g, s1, s2];
    assert.equal(V.versionFamily(models, s2.id).display, g);
    // Passed in: the function stays pure, and the family (root, versions) is untouched.
    const failed = V.versionFamily(models, s2.id, new Set([g.id]));
    assert.equal(failed.display, s2);
    assert.equal(failed.root, g);
    assert.deepEqual(failed.versions.map((m) => m.id), [s1.id, s2.id]);
    assert.equal(failed.isVersion, true);
    assert.equal(failed.onSource, false, "its own blocks: nothing drawn over another model's mesh");
    // The original itself always shows its own file, failed or not; another family is not affected.
    assert.equal(V.versionFamily(models, g.id, new Set([g.id])).display, g);
    assert.equal(V.versionFamily(models, s1.id, new Set(["other"])).display, g);
    // The shared record the viewer, the runner and the analysis store read.
    assert.equal(V.displayModelOf(models, s2.id), g);
    V.markMeshFailed(g.id);
    try {
        assert.equal(V.meshFailures().has(g.id), true);
        assert.equal(V.displayModelOf(models, s2.id), s2, "stage, analysis and buttons all follow the stabilized file");
        assert.equal(V.displayModelOf(models, s1.id), s1);
        assert.equal(V.displayModelOf(models, g.id), g);
        const before = V.meshFailures();
        V.markMeshFailed(g.id);
        assert.equal(V.meshFailures(), before, "marking it twice changes nothing (a hook would not rerender)");
    } finally {
        V.clearMeshFailures();
    }
    assert.equal(V.meshFailures().size, 0);
    assert.equal(V.displayModelOf(models, s2.id), g, "cleared: the source is tried again");
    const empty = V.meshFailures();
    V.clearMeshFailures();
    assert.equal(V.meshFailures(), empty, "clearing nothing changes nothing");
});

await test("loadAssembly: a stabilized model's blocks are fetched once, kept, and a failure is not", async () => {
    V.forgetAssemblies();
    const entry = manifest.examples.find((e) => e.slug === "cantilever-house") ?? manifest.examples[0];
    const bytes = bytesOf(join(EXAMPLES, entry.slug, "stabilized.glb"));
    const expected = readAssemblyGlb(bytes);
    assert.ok(expected.ok);
    const original = globalThis.fetch;
    const log = [];
    let mode = "ok";
    globalThis.fetch = async (url, init) => {
        log.push({ url: String(url), credentials: init?.credentials });
        if (mode === "down") throw new TypeError("network down");
        if (mode === "404") return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        if (mode === "junk") return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("<html>not a glb</html>").buffer };
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    try {
        const m = { id: "stab-1", glb_url: "/api/assignment_alex/files/models/stab-1.glb" };
        assert.deepEqual(V.peekAssembly(m), { status: "idle", descriptor: null, error: null });
        const first = V.loadAssembly(m);
        assert.equal(V.peekAssembly(m).status, "loading");
        const d = await first;
        assert.deepEqual(d, expected.descriptor);
        assert.equal(V.peekAssembly(m).status, "ready");
        assert.equal(V.peekAssembly(m).descriptor, d);
        assert.equal(V.loadAssembly(m), first, "the same promise");
        assert.deepEqual(await V.loadAssembly(m), d);
        assert.equal(log.length, 1, "fetched once");
        assert.equal(log[0].credentials, "same-origin");
        // Each failure says what happened; none is remembered.
        for (const [fail, pattern] of [["down", /could not be downloaded/], ["404", /not found/], ["junk", /could not be read/]]) {
            mode = fail;
            const bad = { id: `stab-${fail}`, glb_url: `/${fail}.glb` };
            await assert.rejects(V.loadAssembly(bad), pattern);
            assert.equal(V.peekAssembly(bad).status, "error");
            assert.match(V.peekAssembly(bad).error, pattern);
            mode = "ok";
            assert.deepEqual(await V.loadAssembly(bad), d, `${fail}: asking again tries again`);
            assert.equal(V.peekAssembly(bad).status, "ready");
        }
        // The same model id at another url is another file.
        const moved = { id: "stab-1", glb_url: "/elsewhere.glb" };
        assert.equal(V.peekAssembly(moved).status, "idle");
    } finally {
        globalThis.fetch = original;
        V.forgetAssemblies();
    }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
}
process.exit(0);
