// The labels that natural-language edits of the blocks refer to ("the backrest"): which part of a mesh each block belongs to. Checks, on the ten
// bundled examples, that the production code (analysis/partLabels.ts, voxelize's `placeBy`, the viewer scene's partSoups) gives the same labels as the
// prototype that was measured, and that the whole-model voxelisation has exactly the original blocks of the stabilized example.
//
//   node scripts/assignment/label-check.mjs
//
// Four routes to the same answer: the parts cut from the glTF in its own frame (the prototype's way), the parts the viewer's scene hands out through a
// soup it extracted (the way the app gets them: viewer/partSoups.ts, in the viewer's normalised frame), labelModel() of runAnalysis.ts (the page-side
// fallback of the analysis worker), and the "labels" message of the analysis worker itself (analysis.worker.ts, run here against a stand-in for its scope).
// Placement only depends on the bounds, so all four agree.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const NM = path.join(root, "node_modules");
const src = (p) => import(path.join(root, "src/assignment", p));
const THREE = await import(pathToFileURL(path.join(NM, "three/build/three.module.js")).href);
const { GLTFLoader } = await import(pathToFileURL(path.join(NM, "three/examples/jsm/loaders/GLTFLoader.js")).href);
const { MeshoptDecoder } = await import(pathToFileURL(path.join(NM, "three/examples/jsm/libs/meshopt_decoder.module.js")).href);
const { findPartRoots, nameParts, meshesOf } = await src("viewer/glbParts.ts");
const { buildGlbScene } = await src("viewer/glbScene.ts");
const { partSoupsOf } = await src("viewer/partSoups.ts");
const { labelParts } = await src("analysis/partLabels.ts");
const { labelModel, runAnalysis } = await src("analysis/runAnalysis.ts");
const { normalizeSettings } = await src("analysis/settings.ts");
const { readAssemblyGlb } = await src("shared/assemblyGlb.ts");
const { cellCode } = await src("shared/assembly.ts");

// The analysis worker, loaded the way a worker loads it: its scope is `self`.
const scope = { onmessage: null, postMessage: () => {} };
globalThis.self = scope;
await src("analysis/analysis.worker.ts");
const askWorker = (message) => new Promise((resolve) => { scope.postMessage = resolve; scope.onmessage({ data: message }); });

const EX = path.join(root, "public/assignment_alex/examples");
const cache = JSON.parse(readFileSync(path.join(here, "fixtures/voxel-edit/labels-cache.json"), "utf8"));
const settings = normalizeSettings({});

async function parse(file) {
    const b = readFileSync(file);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    return loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), "");
}

/** The prototype's way: one soup per part root, glTF Y-up into Z-up (x, -z, y), in the file's own frame. */
function rawParts(gltf) {
    const roots = findPartRoots(gltf.scene);
    const names = nameParts(roots);
    const v = new THREE.Vector3();
    return roots.map((root_, n) => {
        root_.updateMatrixWorld(true);
        const out = [];
        for (const mesh of meshesOf(root_)) {
            const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
            const get = (i) => { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); return [v.x, -v.z, v.y]; };
            const count = idx ? idx.count : pos.count;
            for (let t = 0; t < count; t += 3) out.push(...get(idx ? idx.getX(t) : t), ...get(idx ? idx.getX(t + 1) : t + 1), ...get(idx ? idx.getX(t + 2) : t + 2));
        }
        return { name: names[n], positions: new Float32Array(out) };
    });
}

/** Block code -> the NAME of its part (or undefined), for comparing labellings that number their parts differently. */
const byName = (labels, used) => new Map(used.map((c) => [c, labels.owner[c] >= 0 ? labels.names[labels.owner[c]] : undefined]));
const protoByName = (entry) => new Map(entry.owner.map(([c, p]) => [c, p >= 0 ? entry.names[p] : undefined]));

let same = 0;
let total = 0;
const failures = [];
for (const slug of Object.keys(cache)) {
    total++;
    try {
        const d = readAssemblyGlb(new Uint8Array(readFileSync(path.join(EX, slug, "stabilized.glb")))).descriptor;
        const used = [];
        for (let n = 0; n < d.cells.length; n += 5) if (d.cells[n + 3] === 0) used.push(cellCode(d.cells[n], d.cells[n + 1], d.cells[n + 2]));
        const gltf = await parse(path.join(EX, slug, "original.glb"));
        const reference = protoByName(cache[slug]);

        // route 1: the glTF's own frame
        const t0 = performance.now();
        const parts = rawParts(gltf);
        const raw = labelParts(parts, used, settings);
        const ms = performance.now() - t0;

        // route 2: the viewer's scene, through a soup it extracted
        const scene = buildGlbScene(gltf.scene);
        const soup = scene.extractTriangles();
        const viaScene = partSoupsOf(soup);
        assert.ok(viaScene, "the scene remembers how to cut the soup into parts");
        assert.equal(partSoupsOf(new Float32Array(9)), null, "a soup the scene did not hand out has no parts");
        assert.deepEqual(viaScene.map((p) => p.name), parts.map((p) => p.name), "the parts are named as the Parts list names them");
        const scened = labelParts(viaScene, used, settings);

        // route 3: the page-side entry point (no Worker in Node: the main thread)
        const paged = await labelModel(viaScene, used, settings);

        // route 4: the worker's own message
        const reply = await askWorker({ kind: "labels", id: 41, parts: viaScene, usedCells: used, settings });
        assert.equal(reply.kind, "labels");
        assert.equal(reply.id, 41);
        const worked = reply.labels;

        // the whole model's voxelisation is the original blocks of the stabilized example
        const whole = await runAnalysis(() => ({ positions: soup }), settings, { cacheKey: `label-check:${slug}` });
        const wholeCells = new Set(whole.blocks.map((b) => cellCode(b.cell[0], b.cell[1], b.cell[2])));
        assert.equal(wholeCells.size, used.length, "same number of blocks as the example's original blocks");
        for (const c of used) assert.ok(wholeCells.has(c), `block ${c} is in the whole-model voxelisation`);

        for (const [name, labels] of [["glTF frame", raw], ["viewer scene", scened], ["labelModel", paged], ["worker message", worked]]) {
            const got = byName(labels, used);
            const wrong = used.filter((c) => got.get(c) !== reference.get(c));
            assert.equal(wrong.length, 0, `${name}: ${wrong.length} blocks differ from the prototype's labels`);
        }
        scene.dispose();
        same++;
        console.log(`${slug.padEnd(20)} same labels as the prototype by all four routes; ${parts.length} parts -> ${raw.names.length} lettered, ${ms.toFixed(0)} ms`);
    } catch (e) {
        failures.push(slug);
        console.log(`${slug.padEnd(20)} DIFFERENT: ${String(e?.message ?? e).split("\n")[0]}`);
    }
}
// the worker does not die on a message it cannot use: it answers with an error the page can show
const bad = await askWorker({ kind: "labels", id: 42, parts: [{ name: "x", positions: "not triangles" }, { name: "y", positions: new Float32Array(9) }], usedCells: [1], settings });
if (bad.kind !== "labels" || bad.labels.names.length !== 0) failures.push("worker reply to junk");
console.log(`the worker answers a message with junk triangles with: ${bad.kind}, ${bad.labels?.names.length} parts`);
console.log(`${same}/${total} identical`);
process.exit(failures.length ? 1 : 0);
