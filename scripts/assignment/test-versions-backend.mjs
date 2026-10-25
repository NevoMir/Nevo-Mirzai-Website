// Tests for the platform side of the version tree: the upload dispatch (POST /models/:sourceId/derived: stabilized, block-edited and optimized
// versions), the caps and the chain rules, idempotence, the delete cascade, the project payload, and the helpers of shared/versionMeta.ts.
//   node scripts/assignment/test-versions-backend.mjs        # Node 22.5 or newer (node:sqlite)
//
// It runs the Worker's own code (worker/derived.ts, worker/versions.ts, worker/db.ts, worker/api.ts) in Node against SQLite (node:sqlite, with
// the real migrations 0001 to 0006) and an in-memory R2: scripts/assignment/fake-env.mjs. No wrangler, no network, no AI.
// The races between parallel requests are the smoke test's job (smoke-derived.mjs against wrangler dev); here a stale count stands in for one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
process.removeAllListeners("warning");

const worker = (n) => import(`../../worker/${n}.ts`);
const sh = (n) => import(`../../src/assignment/shared/${n}.ts`);
const { createEnv } = await import("./fake-env.mjs");
const F = await import("./versions-fixtures.mjs");
const { createDerivedModel, deleteVersion } = await worker("derived");
const { getProjectDetail, toModelAsset, MODEL_COLS } = await worker("db");
const { handleApi } = await worker("api");
const V = await worker("versions");
const { crossCheckDerived } = await worker("derivedChecks");
const { crossCheckVoxelEdit } = await worker("editChecks");
const { readEditMeta, readOptimizeSummary, stabilizationsOf, representationOf } = await sh("versionMeta");
const { crossCheckOptimized } = await sh("optimizeMeta");
const { checkVoxelEditLog, summarizeVoxelEdit } = await sh("voxelEdit/log");
const { checkOptimizeMeta, summarizeOptimize } = await sh("optimizeMeta");
const C = await sh("contract");
const { DERIVED_GLB_LIMIT, EDIT_META_LIMIT, OPTIMIZE_SUMMARY_LIMIT, MAX_VERSIONS_PER_SOURCE: SRC, MAX_VERSIONS_PER_PROJECT: PRJ, MAX_MESH_EDITS_PER_PROJECT: MESH, MAX_VERSION_DEPTH: DEPTH } = C;
const { descriptorFromBlocks } = F;

let passed = 0;
const failures = [];
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

const GLB = { "content-type": "model/gltf-binary" };
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

/** Runs a Worker call and answers {status, model} or {status, error}: HttpError is the Worker's own way of saying no. */
async function attempt(fn) {
    try {
        const out = await fn();
        return { status: out.status, model: out.model };
    } catch (err) {
        if (err?.name === "HttpError") return { status: err.status, error: err.message };
        throw err;
    }
}
const upload = (h, sourceId, bytes, headers = GLB) => attempt(() => createDerivedModel(h.env, new Request("http://worker.test/derived", { method: "POST", headers, body: bytes }), sourceId));

// ---- seeds
function addProject(h, deleted = false) {
    const id = uuid();
    h.sql("INSERT INTO projects (id, name, created_at, modified_at, deleted_at) VALUES (?, 'test', ?, ?, ?)", id, nowIso(), nowIso(), deleted ? nowIso() : null);
    return id;
}
let tick = 0;
/** A model row straight into the database (no file in R2 unless `file` is given). */
function addModel(h, { projectId, kind = "generated", source = null, hash = null, meta = null, analysis = null, key = null, provider = "mock", id = uuid(), file = null }) {
    const glbKey = key ?? `models/${id}.glb`;
    h.sql(
        `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, analysis, kind, source_model_id, assembly_hash, meta)
         VALUES (?, ?, 'job-1', ?, 'a wall shelf', ?, 1000, 2, ?, ?, ?, ?, ?, ?)`,
        id, projectId, provider, glbKey, new Date(Date.parse("2026-01-01T00:00:00Z") + ++tick * 1000).toISOString(), analysis ? JSON.stringify(analysis) : null, kind, source, hash, meta === null ? null : JSON.stringify(meta),
    );
    if (file) h.r2.objects.set(glbKey, { bytes: file, options: {} });
    return id;
}
const rowsOf = (h, projectId) => h.sql("SELECT id, kind, source_model_id, provider, assembly_hash FROM models WHERE project_id = ? ORDER BY rowid", projectId);
const countOf = (h, projectId) => h.sql("SELECT COUNT(*) AS n FROM models WHERE project_id = ?", projectId)[0].n;
const derivedToday = (h) => h.sql("SELECT derived FROM usage WHERE day = ?", nowIso().slice(0, 10))[0]?.derived ?? 0;

const slimEdit = (target, extra = {}) => ({
    version: 1, target, depth: 1, label: "Taller back", summary: "Made the back taller.", entries: [{ n: 1, instruction: "make the back taller", summary: "Made the back taller.", added: 0, removed: 0, moved: 0 }],
    engine: "meta/muse-spark-1.3-contributor", changes: target === "design" ? { added: [], changed: ["Back"], removed: [] } : null, ops: target === "mesh" ? [{ op: "stretch", label: "backrest" }] : null,
    notes: [], stabilized_depth: 0, base_steps: 0, job_id: null, created_at: nowIso(), ...extra,
});

/** A fresh world: a project with a generated model whose voxelisation is the shelf arm. */
function world(vars = {}) {
    const h = createEnv(vars);
    const projectId = addProject(h);
    const root = addModel(h, { projectId });
    return { h, projectId, root };
}

console.log("== the files the tests build");

await test("fixtures: a log of each kind round-trips through the shared writer and reader", async () => {
    const st = await F.stabilizedFixture();
    const ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(2) }] });
    const op = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash });
    for (const [name, bytes, field] of [["stabilization", st.glb, "meta"], ["edit", ed.glb, "edit"], ["optimization", op.glb, "optimization"]]) {
        const r = F.readAssemblyGlb(bytes, null);
        assert.ok(r.ok, `${name}: ${r.error}`);
        const logs = [r.meta, r.edit, r.optimization].filter(Boolean);
        assert.equal(logs.length, 1, name);
        assert.ok(r[field], name);
    }
});

console.log("== the three kinds are accepted (POST /models/:sourceId/derived)");

await test("stabilized: 201, kind stabilized, provider stabilizer, the log and the verdict come back", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const r = await upload(h, root, st.glb);
    assert.equal(r.status, 201, r.error);
    const m = r.model;
    assert.deepEqual([m.kind, m.provider, m.source_model_id, m.prompt, m.job_id], ["stabilized", "stabilizer", root, "a wall shelf", "job-1"]);
    assert.equal(m.derived.added_blocks, 5);
    assert.equal(m.edit, null);
    assert.equal(m.optimization, null);
    assert.equal(m.analysis.blocks, 26);
    assert.equal(m.part_count, 2);
    assert.equal(m.size_bytes, st.glb.byteLength);
    assert.equal(m.glb_url, `/api/assignment_alex/files/models/${m.id}.glb`);
    assert.deepEqual([...h.r2.objects.get(`models/${m.id}.glb`).bytes], [...st.glb]);
    assert.equal(h.r2.objects.get(`models/${m.id}.glb`).options.httpMetadata.contentType, "model/gltf-binary");
    assert.equal(countOf(h, projectId), 2);
});

await test("edited (blocks) from a mesh: 201, kind edited, provider editor, slim EditMeta with the Worker's own depth", async () => {
    const { h, root } = world();
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(3), instruction: "add a shelf under the seat", summary: "Added a shelf." }], baseSteps: 0, depth: 7 });
    const r = await upload(h, root, ed.glb);
    assert.equal(r.status, 201, r.error);
    const m = r.model;
    assert.deepEqual([m.kind, m.provider, m.source_model_id], ["edited", "editor", root]);
    assert.equal(m.derived, null);
    assert.equal(m.optimization, null);
    assert.equal(m.edit.target, "voxel");
    assert.equal(m.edit.depth, 1, "the depth is the Worker's count (a root has 1 model on its path), not the log's claim of 7");
    assert.equal(m.edit.label, "Add a shelf under the seat");
    assert.equal(m.edit.entries.length, 1);
    assert.deepEqual([m.edit.entries[0].added, m.edit.entries[0].removed, m.edit.stabilized_depth, m.edit.base_steps], [3, 0, 0, 0]);
    assert.equal(m.analysis.blocks, 24, "the stored verdict is the log's after_summary");
    assert.equal(m.part_count, 2, "original + user");
    assert.ok(JSON.stringify(m.edit).length <= EDIT_META_LIMIT);
    const stored = h.sql("SELECT meta, assembly_hash, analysis FROM models WHERE id = ?", m.id)[0];
    assert.equal(stored.assembly_hash, ed.hash);
    assert.ok(!stored.meta.includes('"ops"') || JSON.parse(stored.meta).ops === null, "the slim meta carries no operations");
    assert.ok(JSON.parse(stored.meta).entries.every((e) => e.ops === undefined));
});

await test("edited (blocks) from a stabilized version: base steps follow the source, depth counts the chain", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(2) }, { add: F.freshCells(1), remove: [[0, 0, 0]] }], stabilizedDepth: 1, depth: 2 });
    assert.equal(ed.log.base_steps, 1);
    const r = await upload(h, s.id, ed.glb);
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.edit.depth, 2);
    assert.equal(r.model.edit.stabilized_depth, 1);
    assert.equal(r.model.edit.base_steps, 1);
    assert.equal(r.model.edit.entries.length, 2);
    assert.equal(countOf(h, projectId), 3);
});

await test("optimized: from a stabilized version (source hash) and from a mesh (null), kind optimized, provider optimizer", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const op = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0], [1, 1, 5]], sourceHash: st.hash, stabilizedDepth: 1 });
    const r = await upload(h, s.id, op.glb);
    assert.equal(r.status, 201, r.error);
    const m = r.model;
    assert.deepEqual([m.kind, m.provider, m.source_model_id], ["optimized", "optimizer", s.id]);
    assert.equal(m.derived, null);
    assert.equal(m.edit, null);
    assert.equal(m.optimization.removed, 2);
    assert.equal(m.optimization.goal, "Lightest");
    assert.equal(m.optimization.before.blocks, 26);
    assert.equal(m.optimization.after.blocks, 24);
    assert.ok(JSON.stringify(m.optimization).length <= OPTIMIZE_SUMMARY_LIMIT);
    assert.equal(m.analysis.blocks, 24);
    // from the mesh itself: the source has no cell hash
    const plain = F.plainDescriptor();
    const op2 = await F.optimizedFixture({ source: plain, remove: [[2, 0, 0]], sourceHash: null });
    const r2 = await upload(h, root, op2.glb);
    assert.equal(r2.status, 201, r2.error);
    assert.equal(r2.model.optimization.stabilized_depth, 0);
});

await test("optimized that adds blocks: they are reinforcement with the next step", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const op = await F.optimizedFixture({ source: st.descriptor, add: F.freshCells(2), remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 });
    assert.equal(op.meta.step, 2);
    const r = await upload(h, s.id, op.glb);
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.optimization.added, 2);
});

console.log("== what is refused");

await test("a file with two logs, with none, or that is not an assembly: 400", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0 });
    const two = F.patchJson(st.glb, (d) => { d.scenes[0].extras["nevo:edit"] = ed.log; });
    let r = await upload(h, root, two);
    assert.equal(r.status, 400);
    assert.match(r.error, /more than one log/);
    const three = F.patchJson(ed.glb, (d) => { d.scenes[0].extras["nevo:stabilization"] = st.meta; d.scenes[0].extras["nevo:optimization"] = {}; });
    assert.equal((await upload(h, root, three)).status, 400);
    r = await upload(h, root, F.writeAssemblyGlb(st.descriptor));
    assert.equal(r.status, 400);
    assert.match(r.error, /does not carry a log/);
    assert.equal((await upload(h, root, new TextEncoder().encode("not a model at all, just text........."))).status, 400);
    assert.equal((await upload(h, root, new Uint8Array(0))).status, 400);
    assert.equal(countOf(h, h.sql("SELECT project_id FROM models LIMIT 1")[0].project_id), 1, "nothing was stored");
    assert.deepEqual(h.r2.puts, [], "no file was written");
});

await test("wrong content type 415, no content type 415, over 1 MiB 413 (declared and streamed), unknown source 404, malformed id 400, project in the bin 409", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    assert.equal((await upload(h, root, st.glb, { "content-type": "application/json" })).status, 415);
    assert.equal((await upload(h, root, st.glb, {})).status, 415);
    assert.equal((await upload(h, root, new Uint8Array(DERIVED_GLB_LIMIT + 1))).status, 413);
    assert.equal((await upload(h, root, st.glb, { ...GLB, "content-length": String(DERIVED_GLB_LIMIT + 5) })).status, 413);
    assert.equal((await upload(h, uuid(), st.glb)).status, 404);
    assert.equal((await upload(h, "nope", st.glb)).status, 400);
    const bin = addProject(h, true);
    const trashed = addModel(h, { projectId: bin });
    const r = await upload(h, trashed, st.glb);
    assert.equal(r.status, 409);
    assert.match(r.error, /bin/);
    // the content type is matched case-insensitively and its parameters are ignored
    assert.equal((await upload(h, root, st.glb, { "content-type": "Model/GLTF-Binary; charset=binary" })).status, 201);
});

await test("the hash must be the blocks': a stabilizer log, an edit log and an optimization log with another hash: 400", async () => {
    const { h, root } = world();
    const zero = "0".repeat(64);
    const st = await F.stabilizedFixture({ overrides: { assembly_hash: zero } });
    let r = await upload(h, root, st.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /blocks/);
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0, overrides: { assembly_hash: zero } });
    r = await upload(h, root, ed.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /does not match the blocks/);
    const op = await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], overrides: { assembly_hash: zero } });
    r = await upload(h, root, op.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /does not match the blocks/);
});

await test("the stabilization count must follow from the source (stabilized_depth of an edit and of an optimization, depth of a stabilization)", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    // an edit of a mesh that claims one stabilization above it
    let ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0, stabilizedDepth: 1 });
    let r = await upload(h, root, ed.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /stabilization count/);
    // an edit of a stabilized version that claims none
    ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(1) }], stabilizedDepth: 0 });
    r = await upload(h, s.id, ed.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /stabilization count/);
    // an optimization that claims 0 on a stabilized source, and 1 on a mesh
    let op = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 0 });
    r = await upload(h, s.id, op.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /stabilization count/);
    op = await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], sourceHash: null, stabilizedDepth: 1 });
    assert.equal((await upload(h, root, op.glb)).status, 400);
    // a stabilization of a stabilized version must say depth 2, of a mesh depth 1
    assert.equal((await upload(h, s.id, (await F.stabilizedFixture({ more: F.freshCells(1), depth: 1 })).glb)).status, 400);
    assert.equal((await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1), depth: 2 })).glb)).status, 400);
});

await test("the source hash of an optimization: wrong hash, null on a block version, a hash on a mesh: 400", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const mk = (sourceHash) => F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash, stabilizedDepth: 1 });
    for (const [name, hash] of [["another hash", "f".repeat(64)], ["null", null]]) {
        const r = await upload(h, s.id, (await mk(hash)).glb);
        assert.equal(r.status, 400, name);
        assert.match(r.error, /different model/, name);
    }
    const onMesh = await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], sourceHash: st.hash });
    assert.equal((await upload(h, root, onMesh.glb)).status, 400);
    // and a mesh-like source whose assembly_hash column holds a design's hash is still treated as a mesh: the hash is not a cell hash
    const design = addModel(h, { projectId: h.sql("SELECT project_id AS p FROM models LIMIT 1")[0].p, kind: "edited", source: root, hash: "d".repeat(64), meta: slimEdit("design") });
    const fromDesign = await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], sourceHash: null });
    assert.equal((await upload(h, design, fromDesign.glb)).status, 201);
});

await test("an edit of a mesh starts at step 0; steps and roles in the file must be what the log says", async () => {
    const { h, root } = world();
    const plain = F.plainDescriptor();
    // base_steps 3 on a mesh source
    let ed = await F.editedFixture({ source: plain, edits: [{ add: F.freshCells(1) }], baseSteps: 3 });
    let r = await upload(h, root, ed.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /does not match the model/);
    // counts that do not add up: the log says 5 added, the file has 3
    ed = await F.editedFixture({ source: plain, edits: [{ add: F.freshCells(3) }], baseSteps: 0 });
    const lied = structuredClone(ed.log);
    lied.edits[0].added = 5;
    r = await upload(h, root, F.writeAssemblyGlb(ed.descriptor, null, lied));
    assert.equal(r.status, 400);
    assert.match(r.error, /do not add up|made fewer/);
    // a block of the edit that is not a "user" block
    const st = await F.stabilizedFixture(); // has column blocks of step 1
    const log = (await F.editedFixture({ source: plain, edits: [{ add: [[8, 1, 0]] }], baseSteps: 0 })).log;
    const forged = { ...log, edits: [{ ...log.edits[0], added: 5 }], after: { ...log.after, blocks: 26 }, after_summary: { ...log.after_summary, blocks: 26 }, before: { ...log.before, blocks: 21 }, labels: ".".repeat(26), assembly_hash: st.hash };
    r = await upload(h, root, F.writeAssemblyGlb(st.descriptor, null, forged));
    assert.equal(r.status, 400);
    assert.match(r.error, /must have the role 'user'/);
    // a step above the log's last edit
    const high = descriptorFromBlocks([...F.ARM.map((cell) => ({ cell })), { cell: [5, 5, 5], role: "user", step: 4 }]);
    const highLog = { ...log, assembly_hash: await F.assemblyHash(high), after: { ...log.after, blocks: 22 }, after_summary: { ...log.after_summary, blocks: 22 }, before: { ...log.before, blocks: 21 }, labels: ".".repeat(22), edits: [{ ...log.edits[0], added: 1 }] };
    r = await upload(h, root, F.writeAssemblyGlb(high, null, highLog));
    assert.equal(r.status, 400);
    assert.match(r.error, /step 4/);
    // an edit that starts from a different block count than the one the browser stored for the source
    h.sql("UPDATE models SET analysis = ? WHERE id = ?", JSON.stringify(F.summaryFor(30, false)), root);
    ed = await F.editedFixture({ source: plain, edits: [{ add: F.freshCells(1) }], baseSteps: 0 });
    r = await upload(h, root, ed.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /different model/);
    h.sql("UPDATE models SET analysis = ? WHERE id = ?", JSON.stringify(F.summaryFor(21, false)), root);
    assert.equal((await upload(h, root, ed.glb)).status, 201, "the same file is fine when the stored verdict agrees");
});

await test("an optimization that does not match its blocks: counts, added blocks that are not reinforcement, a removed block that is in the file", async () => {
    const { h, root } = world();
    const plain = F.plainDescriptor();
    const good = await F.optimizedFixture({ source: plain, remove: [[2, 0, 0], [0, 2, 0]], sourceHash: null });
    // the file has 19 blocks; the log claims 20
    let m = structuredClone(good.meta);
    m.after.blocks = 20;
    m.before.blocks = 22;
    m.after_summary.blocks = 20;
    m.labels = ".".repeat(20);
    let r = await upload(h, root, F.writeAssemblyGlb(good.descriptor, null, null, m));
    assert.equal(r.status, 400);
    assert.match(r.error, /file has 19/);
    // a "removed" cell that is still there (counts kept consistent)
    m = structuredClone(good.meta);
    m.removed = [0, 2]; // cell (0,0,0) is in the file; (2,0,0) is not
    m.removed_at = [1, 1];
    r = await upload(h, root, F.writeAssemblyGlb(good.descriptor, null, null, m));
    assert.equal(r.status, 400);
    assert.match(r.error, /removed is in the file/);
    // blocks of the optimizer's step that are not reinforcement (a user block at step 2)
    const odd = descriptorFromBlocks([...F.ARM.map((cell) => ({ cell })), { cell: [5, 5, 5], role: "user", step: 1 }]);
    const oddMeta = { ...good.meta, assembly_hash: await F.assemblyHash(odd), step: 1, added: 1, added_at: [2], removed: [], removed_at: [], before: F.optMetricsFor(21), after: F.optMetricsFor(22), labels: ".".repeat(22), after_summary: F.summaryFor(22, false) };
    r = await upload(h, root, F.writeAssemblyGlb(odd, null, null, oddMeta));
    assert.equal(r.status, 400);
    assert.match(r.error, /not a reinforcement block/);
    // the same wrong count of added blocks
    const addedLied = await F.optimizedFixture({ source: plain, add: F.freshCells(2), sourceHash: null });
    m = structuredClone(addedLied.meta);
    m.added = 1;
    m.added_at = [2];
    m.before.blocks = 22;
    r = await upload(h, root, F.writeAssemblyGlb(addedLied.descriptor, null, null, m));
    assert.equal(r.status, 400);
    assert.match(r.error, /says 1 blocks were added, the file has 2/);
    // a result that is not feasible is never saved
    assert.throws(() => F.writeAssemblyGlb(good.descriptor, null, null, { ...good.meta, feasible: false }), /not feasible|feasible/);
});

await test("single bit flips in the cells, the roles, the geometry and the container are refused (the log's free text is the only thing that can change)", async () => {
    const { h, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const files = [
        ["stabilization", st.glb, root, "nevo:stabilization"],
        ["edit", (await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(2) }], baseSteps: 0 })).glb, root, "nevo:edit"],
        ["optimization", (await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 })).glb, s.id, "nevo:optimization"],
    ];
    let seed = 12345;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (const [name, glb, sourceId, key] of files) {
        const span = F.logSpan(glb, key);
        assert.ok(span, name);
        const bin = F.binStart(glb);
        let refused = 0;
        // outside the log: every flip must be refused (the JSON chunk is compared with the one the writer would emit; the geometry is checked per vertex)
        const positions = [];
        for (let n = 0; n < 150; n++) {
            let at = rand(glb.length);
            if (at >= span[0] && at < span[1]) at = bin + rand(glb.length - bin);
            positions.push(at);
        }
        positions.push(12, 16, 40, bin, bin + 40, glb.length - 3); // the container, a vertex, an index
        for (const at of positions) {
            const r = await upload(h, sourceId, F.flipBit(glb, at, rand(8)));
            if (r.status === 400) refused++;
            else assert.fail(`${name}: a flip at byte ${at} was not refused (${r.status} ${r.error ?? ""})`);
        }
        assert.equal(refused, positions.length, name);
    }
});

await test("flips inside the log: refused, or bounded (an accepted file is still a valid log that fits its blocks, and its stored meta stays within the limits)", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const cases = [
        [await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(2), instruction: "add a shelf under the seat", summary: "Added a shelf." }], baseSteps: 0 }), root, "nevo:edit"],
        [await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 }), s.id, "nevo:optimization"],
    ];
    let seed = 777;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    let accepted = 0;
    let refused = 0;
    for (const [fx, sourceId, key] of cases) {
        const span = F.logSpan(fx.glb, key);
        for (let n = 0; n < 250; n++) {
            const at = span[0] + rand(span[1] - span[0]);
            const r = await upload(h, sourceId, F.flipBit(fx.glb, at, rand(8)));
            assert.ok(r.status === 400 || r.status === 200 || r.status === 201, `byte ${at}: ${r.status} ${r.error ?? ""}`);
            if (r.status === 400) { refused++; continue; }
            accepted++;
            const m = r.model;
            assert.ok(m.edit || m.optimization, "an accepted flip is still a version of the same kind");
            // whatever the flip changed, the stored copy is what the Worker rebuilt, within its limits
            const stored = h.sql("SELECT meta, analysis, assembly_hash FROM models WHERE id = ?", m.id)[0];
            assert.ok(stored.meta.length <= (m.edit ? EDIT_META_LIMIT : OPTIMIZE_SUMMARY_LIMIT));
            assert.equal(stored.assembly_hash, fx.hash, "the hash column is the blocks', whatever the text says");
            // it is the first upload of that content that stores it, later ones (200) answer with it: delete it so the next flip is judged on its own
            if (r.status === 201) await deleteVersion(h.env, m.id);
        }
    }
    assert.ok(refused > 0 && accepted > 0, `refused ${refused}, accepted ${accepted}: both kinds of outcome are expected (numbers and structure refuse, free text passes)`);
    assert.equal(countOf(h, projectId), 2, "nothing is left over from the flips");
});

console.log("== caps and the chain");

await test("10 versions of one source: the 11th is refused 429 (any kind counts), an already stored result is still answered", async () => {
    const { h, root } = world();
    const plain = F.plainDescriptor();
    // 4 stabilized, 3 edited and 3 optimized = 10
    const files = [
        ...Array.from({ length: 4 }, () => () => F.stabilizedFixture({ more: F.freshCells(1) })),
        ...Array.from({ length: 3 }, () => () => F.editedFixture({ source: plain, edits: [{ add: F.freshCells(1) }], baseSteps: 0 })),
        ...[0, 1, 2].map((n) => () => F.optimizedFixture({ source: plain, remove: [F.ARM[n]], sourceHash: null })),
    ];
    let first = null;
    for (const make of files) {
        const fx = await make();
        const r = await upload(h, root, fx.glb);
        assert.equal(r.status, 201, r.error);
        first ??= { fx, id: r.model.id };
    }
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE source_model_id = ?", root)[0].n, SRC);
    const puts = h.r2.puts.length;
    const extra = await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb);
    assert.equal(extra.status, 429);
    assert.match(extra.error, new RegExp(`at most ${SRC}`));
    const again = await upload(h, root, first.fx.glb);
    assert.equal(again.status, 200, "a result that is stored already needs no room");
    assert.equal(again.model.id, first.id);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE source_model_id = ?", root)[0].n, SRC);
    assert.equal(h.r2.puts.length, puts, "the refused one wrote no file");
});

await test("40 versions in a project: the 41st is refused 429", async () => {
    const { h, projectId, root } = world();
    // 3 more roots with 10 versions each, and the first root with 10 = 40
    const roots = [root, ...Array.from({ length: 3 }, () => addModel(h, { projectId }))];
    for (const r of roots) for (let n = 0; n < SRC; n++) addModel(h, { projectId, kind: "stabilized", source: r, hash: uuid().replace(/-/g, "").repeat(2), meta: null });
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE kind = 'stabilized'")[0].n, PRJ);
    const fifth = addModel(h, { projectId });
    const r = await upload(h, fifth, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb);
    assert.equal(r.status, 429);
    assert.match(r.error, new RegExp(`at most ${PRJ}`));
    const e = await upload(h, fifth, (await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0 })).glb);
    assert.equal(e.status, 429, "edited and optimized versions count too");
    const o = await upload(h, fifth, (await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], sourceHash: null })).glb);
    assert.equal(o.status, 429);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE project_id = ? AND kind != 'generated'", projectId)[0].n, PRJ);
});

await test("the caps are decided inside the INSERT: a count read before it can be stale and the statement still refuses", async () => {
    const { h, projectId, root } = world();
    for (let n = 0; n < SRC; n++) addModel(h, { projectId, kind: "stabilized", source: root, hash: uuid().replace(/-/g, "").repeat(2) });
    const realPrepare = h.env.DB.prepare.bind(h.env.DB);
    // a request that read the counts before the others landed: the early check sees an empty source
    let stale = true;
    h.env.DB.prepare = (text) => {
        const s = realPrepare(text);
        if (stale && text.includes("AS per_source")) {
            stale = false; // only the early read; the Worker's own look at the counts after a refusal sees the truth
            return { bind: () => ({ first: async () => ({ per_source: 0, per_project: 0, mesh_edits: 0, source_exists: 1 }), all: async () => ({ results: [{ per_source: 0, per_project: 0, mesh_edits: 0, source_exists: 1 }] }) }) };
        }
        return s;
    };
    const before = derivedToday(h);
    const r = await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb);
    h.env.DB.prepare = realPrepare;
    assert.equal(r.status, 429, r.error);
    assert.match(r.error, new RegExp(`at most ${SRC}`));
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE source_model_id = ?", root)[0].n, SRC);
    assert.deepEqual(h.r2.puts.filter((k) => h.r2.objects.has(k)), [], "the file that was written for it was deleted again");
    assert.equal(derivedToday(h), before, "and the daily slot was given back");
});

await test("mesh edits: the 7th in a project is refused by the INSERT (versionInsert), a block edit is not counted against it, damaged meta cannot break the count", async () => {
    const { h, projectId, root } = world();
    const roots = [root, ...Array.from({ length: 3 }, () => addModel(h, { projectId }))];
    for (let n = 0; n < MESH; n++) addModel(h, { projectId, kind: "edited", source: roots[n % 4], hash: null, meta: slimEdit("mesh") });
    addModel(h, { projectId, kind: "edited", source: roots[0], hash: null, meta: slimEdit("design") });
    h.sql("INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, meta) VALUES (?, ?, 'j', 'mock', 'p', 'k', 1, ?, 'edited', ?, 'this is { not json')", uuid(), projectId, nowIso(), roots[1]);
    const counts = await V.readVersionCounts(h.env, roots[2], projectId);
    assert.equal(counts.mesh_edits, MESH);
    const fresh = (kind, meshEdit) => ({ id: uuid(), projectId, jobId: "j", provider: "mock", prompt: "p", glbKey: "models/x.glb", sizeBytes: 5, partCount: 1, createdAt: nowIso(), analysis: null, kind, sourceId: roots[2], assemblyHash: null, meta: JSON.stringify(slimEdit(meshEdit ? "mesh" : "design")), meshEdit });
    const seventh = await h.env.DB.batch([V.versionInsert(h.env, fresh("edited", true))]);
    assert.equal(seventh[0].results.length, 0, "no row for the 7th mesh edit");
    const err = V.versionCapError(await V.readVersionCounts(h.env, roots[2], projectId), true);
    assert.equal(err.status, 429);
    assert.match(err.message, new RegExp(`at most ${MESH}`));
    assert.equal(V.versionCapError(await V.readVersionCounts(h.env, roots[2], projectId), false), null, "a design edit or a block version is not a mesh edit");
    const design = await h.env.DB.batch([V.versionInsert(h.env, fresh("edited", false))]);
    assert.equal(design[0].results.length, 1, "a design edit still fits");
    // and a voxel edit through the upload path
    const e = await upload(h, roots[2], (await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0 })).glb);
    assert.equal(e.status, 201, e.error);
});

await test("a chain deeper than 12 is refused 409 before the body is read; the 12th level is fine", async () => {
    const { h, projectId, root } = world();
    let parent = root;
    const ids = [];
    for (let n = 1; n <= DEPTH; n++) {
        parent = addModel(h, { projectId, kind: "edited", source: parent, hash: uuid().replace(/-/g, "").repeat(2), meta: slimEdit("design", { depth: n }) });
        ids.push(parent);
    }
    // ids[10] is version 11: it has 11 models on its path, so a version made from it has 12 ancestors; ids[11] has 12 and one more would be the 13th
    const ok = await upload(h, ids[DEPTH - 2], (await F.stabilizedFixture({ more: F.freshCells(1) })).glb);
    assert.equal(ok.status, 201, ok.error);
    const tooDeep = await upload(h, ids[DEPTH - 1], new Uint8Array(100));
    assert.equal(tooDeep.status, 409, "refused on the depth alone: the body was not even looked at");
    assert.match(tooDeep.error, /12 deep/);
    // the chain walk is bounded even when the data is damaged (a loop)
    const a = addModel(h, { projectId, kind: "edited", source: null, meta: slimEdit("design") });
    const b = addModel(h, { projectId, kind: "edited", source: a, meta: slimEdit("design") });
    h.sql("UPDATE models SET source_model_id = ? WHERE id = ?", b, a);
    const loop = await upload(h, b, new Uint8Array(100));
    assert.equal(loop.status, 409);
});

await test("a model can be stabilized at most 3 times on one chain, edits and optimizations in between do not count", async () => {
    const { h, root } = world();
    let st = await F.stabilizedFixture();
    let cur = (await upload(h, root, st.glb)).model; // depth 1
    let desc = st.descriptor;
    // edit (stabilized_depth 1), stabilize (depth 2), optimize (stabilized_depth 2), stabilize (depth 3)
    const ed = await F.editedFixture({ source: desc, edits: [{ add: F.freshCells(1) }], stabilizedDepth: 1, depth: 2 });
    const e = await upload(h, cur.id, ed.glb);
    assert.equal(e.status, 201, e.error);
    desc = ed.descriptor;
    const s2 = await F.stabilizedFixture({ more: F.freshCells(1), depth: 2 }); // not built on the edit's blocks; the dispatch only looks at counts and steps here
    const second = await upload(h, e.model.id, s2.glb);
    assert.equal(second.status, 201, second.error);
    const op = await F.optimizedFixture({ source: s2.descriptor, remove: [[2, 0, 0]], sourceHash: s2.hash, stabilizedDepth: 2 });
    const o = await upload(h, second.model.id, op.glb);
    assert.equal(o.status, 201, o.error);
    const s3 = await F.stabilizedFixture({ more: F.freshCells(1), depth: 3 });
    const third = await upload(h, o.model.id, s3.glb);
    assert.equal(third.status, 201, third.error);
    assert.equal(stabilizationsOf(h.sql("SELECT kind, meta FROM models WHERE id = ?", third.model.id)[0]), 3);
    const fourth = await upload(h, third.model.id, (await F.stabilizedFixture({ more: F.freshCells(1), depth: 3 })).glb);
    assert.equal(fourth.status, 409);
    assert.match(fourth.error, /at most twice/);
    // an edit and an optimization are still allowed above the third
    const e2 = await F.editedFixture({ source: s3.descriptor, edits: [{ add: F.freshCells(1) }], stabilizedDepth: 3, depth: 6 });
    assert.equal((await upload(h, third.model.id, e2.glb)).status, 201);
});

await test("a daily limit (DAILY_DERIVED_LIMIT) covers all three kinds; a refused upload gives its slot back", async () => {
    const { h, root } = world({ DAILY_DERIVED_LIMIT: "3" });
    const plain = F.plainDescriptor();
    assert.equal((await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb)).status, 201);
    assert.equal((await upload(h, root, (await F.editedFixture({ source: plain, edits: [{ add: F.freshCells(1) }], baseSteps: 0 })).glb)).status, 201);
    assert.equal((await upload(h, root, (await F.optimizedFixture({ source: plain, remove: [[2, 0, 0]], sourceHash: null })).glb)).status, 201);
    assert.equal(derivedToday(h), 3);
    const r = await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb);
    assert.equal(r.status, 429);
    assert.match(r.error, /Today's limit/);
    assert.equal(derivedToday(h), 3);
    // an answer that needs no slot (the result is stored already) still works
    const again = await upload(h, root, (await F.optimizedFixture({ source: plain, remove: [[2, 0, 0]], sourceHash: null })).glb);
    assert.equal(again.status, 200);
});

console.log("== idempotence");

await test("the same blocks again: 200 and the model stored first, whatever the log says; no second row, file or slot", async () => {
    const { h, projectId, root } = world();
    const cells = F.freshCells(2);
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: cells, instruction: "first words" }], baseSteps: 0 });
    const first = await upload(h, root, ed.glb);
    assert.equal(first.status, 201);
    const slots = derivedToday(h);
    const puts = h.r2.puts.length;
    const second = await upload(h, root, ed.glb);
    assert.equal(second.status, 200);
    assert.equal(second.model.id, first.model.id);
    // other words for the same blocks
    const other = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: cells, instruction: "other words", summary: "Something else." }], baseSteps: 0 });
    assert.equal(other.hash, ed.hash);
    const third = await upload(h, root, other.glb);
    assert.equal(third.status, 200);
    assert.equal(third.model.id, first.model.id);
    assert.equal(third.model.edit.entries[0].instruction, "first words", "the model stored first keeps its own log");
    assert.equal(countOf(h, projectId), 2);
    assert.equal(derivedToday(h), slots);
    assert.equal(h.r2.puts.length, puts);
    // the same cells with another kind of log are the same result for that source
    const asOptimization = await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], sourceHash: null });
    const o1 = await upload(h, root, asOptimization.glb);
    assert.equal(o1.status, 201);
    assert.equal((await upload(h, root, asOptimization.glb)).status, 200);
    // the same blocks under another source are another result
    const otherSource = addModel(h, { projectId });
    assert.equal((await upload(h, otherSource, ed.glb)).status, 201);
});

console.log("== D14: when the stabilizer's steps are carried");

await test("stabilizing a block version keeps roles and steps (firstRun false); stabilizing a mesh or an edited mesh is a first run", async () => {
    const { h, projectId, root } = world();
    // (a) an edited block version (the arm + 2 user blocks of step 1) -> a stabilization that adds a step 2 on top
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(2) }], baseSteps: 0 });
    const e = (await upload(h, root, ed.glb)).model;
    const carried = descriptorFromBlocks([...F.blocksOf(ed.descriptor), { cell: [3, 3, 3], role: "reinforcement", step: 2 }, { cell: [3, 3, 4], role: "reinforcement", step: 2 }]);
    const meta = await F.metaFor(carried, 1, {}, 1);
    assert.equal(meta.steps.length, 1);
    assert.equal(crossCheckDerived(carried, meta, false), null);
    assert.match(crossCheckDerived(carried, meta, true), /added in 2 steps, the stabilizer's log has 1/, "the old rule (a non-stabilized source is a first run) would refuse it");
    const r = await upload(h, e.id, F.writeAssemblyGlb(carried, meta));
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.kind, "stabilized");
    assert.equal(r.model.derived.depth, 1, "an edit between does not use up a stabilization");
    // (b) an edited design is a mesh: stabilized from scratch, a first run
    const design = addModel(h, { projectId, kind: "edited", source: root, hash: "d".repeat(64), meta: slimEdit("design") });
    assert.equal(representationOf({ kind: "edited", meta: slimEdit("design") }), "mesh");
    assert.equal((await upload(h, design, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb)).status, 201);
    // (c) ...and a file that carries earlier steps (a log of 1 step on blocks that went through two) is refused on a mesh
    const mesh = addModel(h, { projectId, kind: "edited", source: root, hash: "e".repeat(64), meta: slimEdit("mesh") });
    const two = await F.stabilizedFixture({ more: F.freshCells(1), depth: 2 });
    const oneStepLog = await F.metaFor(two.descriptor, 1, {}, 1);
    const refused = await upload(h, mesh, F.writeAssemblyGlb(two.descriptor, oneStepLog));
    assert.equal(refused.status, 400);
    assert.match(refused.error, /added in 2 steps/);
    // ...which is fine for a block version
    assert.equal((await upload(h, e.id, F.writeAssemblyGlb(two.descriptor, oneStepLog))).status, 201);
});

console.log("== deleting a version");

await test("DELETE takes the whole subtree and its files; roots are refused; static example files never reach R2", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(2) }], stabilizedDepth: 1, depth: 2 });
    const e = (await upload(h, s.id, ed.glb)).model;
    const op = await F.optimizedFixture({ source: ed.descriptor, remove: [[2, 0, 0]], sourceHash: ed.hash, stabilizedDepth: 1 });
    const o = (await upload(h, e.id, op.glb)).model;
    // a sibling and a version under the deleted one whose file is shipped with the site
    const sibling = (await upload(h, root, (await F.stabilizedFixture({ more: F.freshCells(1) })).glb)).model;
    const shipped = addModel(h, { projectId, kind: "stabilized", source: o.id, hash: "5".repeat(64), key: "static:/assignment_alex/examples/desk-lamp/stabilized.glb" });
    assert.equal(countOf(h, projectId), 6);
    await deleteVersion(h.env, e.id);
    assert.deepEqual(rowsOf(h, projectId).map((r) => r.id).sort(), [root, s.id, sibling.id].sort(), "the edit and everything made from it are gone");
    assert.deepEqual([...h.r2.deleted].sort(), [`models/${e.id}.glb`, `models/${o.id}.glb`].sort());
    assert.ok(h.r2.deleted.every((k) => k.startsWith("models/")), "only our own keys");
    assert.ok(!h.r2.deleted.includes("static:/assignment_alex/examples/desk-lamp/stabilized.glb"));
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE id = ?", shipped)[0].n, 0);
    // the roots, unknown ids, malformed ids
    await assert.rejects(deleteVersion(h.env, root), (err) => err.status === 409);
    await assert.rejects(deleteVersion(h.env, uuid()), (err) => err.status === 404);
    await assert.rejects(deleteVersion(h.env, "nope"), (err) => err.status === 400);
    // an example twin (a stabilized version whose file is shipped with the site) can be deleted, and nothing is asked of R2 for it
    const twin = addModel(h, { projectId, kind: "stabilized", source: root, hash: "6".repeat(64), key: "static:/assignment_alex/examples/desk-lamp/stabilized.glb" });
    const before = h.r2.deleted.length;
    await deleteVersion(h.env, twin);
    assert.equal(h.r2.deleted.length, before, "no R2 call for a shipped file");
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE id = ?", twin)[0].n, 0);
    await deleteVersion(h.env, sibling.id);
    assert.deepEqual(h.r2.deleted.slice(before), [`models/${sibling.id}.glb`]);
    // a version of every kind can be deleted on its own
    const e3 = (await upload(h, s.id, (await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(1) }], stabilizedDepth: 1, depth: 2 })).glb)).model;
    await deleteVersion(h.env, e3.id);
    assert.equal(h.sql("SELECT COUNT(*) AS n FROM models WHERE id = ?", e3.id)[0].n, 0);
});

await test("deleting touches the project (modified_at moves) and frees the slot for the same result", async () => {
    const { h, projectId, root } = world();
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0 });
    const e = (await upload(h, root, ed.glb)).model;
    h.sql("UPDATE projects SET modified_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", projectId);
    await deleteVersion(h.env, e.id);
    assert.ok(h.sql("SELECT modified_at FROM projects WHERE id = ?", projectId)[0].modified_at > "2021");
    const again = await upload(h, root, ed.glb);
    assert.equal(again.status, 201);
    assert.notEqual(again.model.id, e.id);
});

console.log("== the project payload and the model mapping");

await test("a project with 5 versions of three kinds stays small, and each model carries only its own kind of meta", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const ed1 = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(2), instruction: "add a shelf under the seat and make the legs thicker, please", summary: "Added a shelf under the seat." }, { add: F.freshCells(1), instruction: "second change" }], baseSteps: 0 });
    const e1 = (await upload(h, root, ed1.glb)).model;
    const ed2 = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(2) }], stabilizedDepth: 1, depth: 2 });
    const e2 = (await upload(h, s.id, ed2.glb)).model;
    const op = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 });
    const o = (await upload(h, s.id, op.glb)).model;
    const design = addModel(h, { projectId, kind: "edited", source: root, hash: "d".repeat(64), meta: slimEdit("design") });
    const detail = await getProjectDetail(h.env, projectId);
    assert.equal(detail.models.length, 6);
    const text = JSON.stringify(detail);
    console.log(`       project payload with 5 versions: ${(text.length / 1024).toFixed(1)} KB`);
    assert.ok(text.length < 24 * 1024, `${text.length} bytes`);
    const byId = Object.fromEntries(detail.models.map((m) => [m.id, m]));
    assert.ok(byId[s.id].derived && !byId[s.id].edit && !byId[s.id].optimization);
    assert.ok(!byId[e1.id].derived && byId[e1.id].edit?.target === "voxel" && !byId[e1.id].optimization);
    assert.ok(!byId[o.id].derived && !byId[o.id].edit && byId[o.id].optimization?.title);
    assert.equal(byId[design].edit.target, "design");
    assert.equal(byId[root].edit, null);
    assert.equal(byId[e2.id].edit.depth, 2);
    assert.equal(byId[e1.id].edit.entries.length, 2);
});

await test("toModelAsset: a row whose meta is damaged or of another kind maps to nulls, never throws", async () => {
    const { h, projectId, root } = world();
    for (const kind of ["stabilized", "edited", "optimized"]) {
        for (const meta of [null, "not json", '{"version":2}', "[]", '{"version":1}', '{"version":1,"target":"voxel"}']) {
            const id = addModel(h, { projectId, kind, source: root, hash: uuid().replace(/-/g, "").repeat(2) });
            h.sql("UPDATE models SET meta = ? WHERE id = ?", meta, id);
            const row = h.sql(`SELECT ${MODEL_COLS} FROM models WHERE id = ?`, id)[0];
            const m = toModelAsset(row);
            assert.equal(m.kind, kind);
            assert.ok(m.derived === null && m.edit === null && m.optimization === null, `${kind} ${meta}`);
        }
    }
});

console.log("== helpers (shared/versionMeta.ts)");

await test("stabilizationsOf and representationOf, by kind", async () => {
    const st = await F.stabilizedFixture({ depth: 2 });
    const meta = JSON.stringify(st.meta);
    assert.equal(stabilizationsOf({ kind: "generated", meta: null }), 0);
    assert.equal(stabilizationsOf({ kind: "example", meta: null }), 0);
    assert.equal(stabilizationsOf({ kind: "stabilized", meta }), 2);
    assert.equal(stabilizationsOf({ kind: "stabilized", meta: st.meta }), 2, "an object works as well as its JSON");
    assert.equal(stabilizationsOf({ kind: "stabilized", meta: null }), C.MAX_DERIVED_DEPTH, "unreadable: the conservative answer");
    assert.equal(stabilizationsOf({ kind: "edited", meta: JSON.stringify(slimEdit("voxel", { stabilized_depth: 2 })) }), 2);
    assert.equal(stabilizationsOf({ kind: "edited", meta: "junk" }), C.MAX_DERIVED_DEPTH);
    const opt = summarizeOptimize((await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]], stabilizedDepth: 3 })).meta);
    assert.equal(stabilizationsOf({ kind: "optimized", meta: opt }), 3);
    assert.equal(representationOf({ kind: "generated", meta: null }), "mesh");
    assert.equal(representationOf({ kind: "example", meta: null }), "mesh");
    assert.equal(representationOf({ kind: "stabilized", meta }), "blocks");
    assert.equal(representationOf({ kind: "optimized", meta: opt }), "blocks");
    assert.equal(representationOf({ kind: "edited", meta: slimEdit("voxel") }), "blocks");
    assert.equal(representationOf({ kind: "edited", meta: slimEdit("design") }), "mesh");
    assert.equal(representationOf({ kind: "edited", meta: slimEdit("mesh") }), "mesh");
    assert.equal(representationOf({ kind: "edited", meta: "junk" }), "mesh");
});

await test("readEditMeta and readOptimizeSummary: round trip, and junk never throws and never passes", async () => {
    const edit = slimEdit("design");
    assert.deepEqual(readEditMeta(edit), edit);
    assert.deepEqual(readEditMeta(JSON.stringify(edit)), edit);
    const summary = summarizeOptimize((await F.optimizedFixture({ source: F.plainDescriptor(), remove: [[2, 0, 0]] })).meta);
    assert.deepEqual(readOptimizeSummary(summary), summary);
    assert.deepEqual(readOptimizeSummary(JSON.stringify(summary)), summary);
    const junk = [undefined, null, 0, 1, "", "x", "{", "[]", [], {}, { version: 1 }, true, () => 1, Symbol("s"), 12n, { version: 1, target: "x" }, { ...edit, entries: [] }, { ...edit, entries: [{}] }, { ...edit, depth: 99 }, { ...edit, notes: [1] }, { ...edit, label: 5 }, { ...edit, ops: [{ op: "evil", label: "x" }] }, { ...edit, changes: { added: [1], changed: [], removed: [] } }, { ...summary, objective: [] }, { ...summary, objective: ["nope"] }, { ...summary, stop: "x" }, { ...summary, before: null }, { ...summary, solver: "x" }];
    for (const j of junk) {
        let a, b;
        assert.doesNotThrow(() => { a = readEditMeta(j); b = readOptimizeSummary(j); });
        assert.equal(a, null, `edit: ${String(j)}`);
        assert.equal(b, null, `optimization: ${String(j)}`);
    }
    // display text that is too long is clipped, not a reason to lose the record (the Worker is the only writer of these rows)
    const clipped = readEditMeta({ ...edit, label: "L".repeat(200), notes: Array.from({ length: 12 }, () => "n".repeat(300)), ops: Array.from({ length: 20 }, () => ({ op: "recolor", label: "x".repeat(200) })) });
    assert.equal(clipped?.label.length, 80);
    assert.equal(clipped?.notes.length, 8);
    assert.ok(clipped?.notes.every((n) => n.length === 200));
    assert.equal(clipped?.ops?.length, 12);
    assert.equal(readOptimizeSummary({ ...summary, goal: "g".repeat(900), title: "t".repeat(300) })?.goal.length, 400);
    // random single-field damage to a valid object
    let seed = 99;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const values = [null, "x", -1, 1e9, [], {}, NaN, Infinity, true, "a".repeat(5000)];
    for (const base of [edit, summary]) {
        for (let n = 0; n < 400; n++) {
            const copy = structuredClone(base);
            const keys = Object.keys(copy);
            copy[keys[rand(keys.length)]] = values[rand(values.length)];
            assert.doesNotThrow(() => { readEditMeta(copy); readOptimizeSummary(copy); });
        }
    }
});

await test("the slim copies the Worker keeps are what the readers accept and stay under their limits, at the extremes", async () => {
    // 12 instructions of 500 characters each in one block version
    const edits = Array.from({ length: C.MAX_VOXEL_EDITS_PER_VERSION }, (_, i) => ({ add: i === 0 ? F.freshCells(1) : [], instruction: "a".repeat(C.EDIT_INSTRUCTION_MAX), summary: "s".repeat(200) }));
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits, baseSteps: 0 });
    const checked = checkVoxelEditLog(ed.log, null);
    assert.ok(checked.ok, checked.error);
    const slim = summarizeVoxelEdit(checked.value, { depth: 12 });
    assert.ok(JSON.stringify(slim).length <= EDIT_META_LIMIT, `${JSON.stringify(slim).length} bytes`);
    assert.deepEqual(readEditMeta(slim), slim);
    assert.ok(slim.entries.every((e) => e.instruction.length <= 160));
    const { h, root } = world();
    const r = await upload(h, root, ed.glb);
    assert.equal(r.status, 201, r.error);
    // an optimization with a long goal and a full history
    const op = await F.optimizedFixture({ source: F.plainDescriptor(), remove: F.ARM.slice(0, 6), goal: "g".repeat(300) });
    const m = checkOptimizeMeta(op.meta, null);
    assert.ok(m.ok, m.error);
    assert.ok(JSON.stringify(summarizeOptimize(m.value)).length <= OPTIMIZE_SUMMARY_LIMIT);
});

console.log("== the HTTP routes");

await test("POST /models/:id/derived and DELETE /models/:id through handleApi: status codes, JSON bodies, 405 with Allow", async () => {
    const { h, root } = world();
    const base = "http://worker.test/api/assignment_alex";
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const ed = await F.editedFixture({ source: F.plainDescriptor(), edits: [{ add: F.freshCells(1) }], baseSteps: 0 });
    let res = await handleApi(new Request(`${base}/models/${root}/derived`, { method: "POST", headers: GLB, body: ed.glb }), h.env, ctx);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.model.kind, "edited");
    res = await handleApi(new Request(`${base}/models/${root}/derived`, { method: "POST", headers: GLB, body: ed.glb }), h.env, ctx);
    assert.equal(res.status, 200);
    res = await handleApi(new Request(`${base}/models/${root}/derived`, { method: "GET" }), h.env, ctx);
    assert.equal(res.status, 405);
    assert.match(res.headers.get("allow"), /POST/);
    res = await handleApi(new Request(`${base}/models/${body.model.id}`, { method: "PUT", body: "{}" }), h.env, ctx);
    assert.equal(res.status, 405);
    assert.match(res.headers.get("allow"), /DELETE/);
    res = await handleApi(new Request(`${base}/models/${root}`, { method: "DELETE" }), h.env, ctx);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.length > 0, true);
    res = await handleApi(new Request(`${base}/models/${body.model.id}`, { method: "DELETE" }), h.env, ctx);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    res = await handleApi(new Request(`${base}/models/${body.model.id}`, { method: "DELETE" }), h.env, ctx);
    assert.equal(res.status, 404);
});

console.log("== editing and stabilizing with the real stabilizer (S_PROD t4, S_VOX smoke steps 5 and 7b)");

const stabilizerLib = await import("./examples/lib/stabilizer.mjs");
const engine = await import("./examples/lib/engine.mjs");

/** The blocks of a bundled example's stabilized GLB, as a descriptor. */
const exampleDescriptor = (slug, file) => {
    const r = engine.readAssemblyGlb(new Uint8Array(readFileSync(new URL(`../../public/assignment_alex/examples/${slug}/${file}`, import.meta.url))));
    assert.ok(r.ok, r.error);
    return r;
};

await test("edit a stabilized example, then stabilize the edit again: roles and steps are kept, the Worker accepts it as depth 2", async () => {
    const stabilize = await stabilizerLib.loadStabilizer();
    const solver = await engine.getSolver();
    const settings = engine.normalizeSettings({});
    const { h, projectId, root } = world();
    // the example twin: a stabilized version of the original (depth 1), as POST /projects/from-example makes it
    const twinRead = exampleDescriptor("pencil-leg-chair", "stabilized.glb");
    const twin = addModel(h, { projectId, kind: "stabilized", source: root, hash: twinRead.meta.assembly_hash, meta: twinRead.meta, analysis: twinRead.meta.after_summary, key: "static:/assignment_alex/examples/pencil-leg-chair/stabilized.glb", provider: "stabilizer" });
    const stepsBefore = F.highestStep(twinRead.descriptor);
    assert.ok(stepsBefore >= 1);
    // an edit that makes trouble: the front right leg loses its middle (2 blocks) and a 2-block ledge is added beside the seat (role user, step stepsBefore + 1)
    const ed = await F.editedFixture({ source: twinRead.descriptor, edits: [{ add: [[8, 4, 4], [8, 4, 5]], remove: [[7, 2, 2], [7, 2, 3]], instruction: "cut the front right leg and add a ledge", summary: "Cut a leg." }], stabilizedDepth: 1, depth: 2 });
    const edited = await upload(h, twin, ed.glb);
    assert.equal(edited.status, 201, edited.error);
    assert.equal(edited.model.edit.base_steps, stepsBefore);
    // stabilize the edited version with the app's own stabilizer (input.assembly = the edited descriptor: roles and steps carry over)
    const cells = F.blocksOf(ed.descriptor).map((b) => b.cell);
    const out = await stabilize({ cells, settings, options: { ...stabilizerLib.DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000 }, assembly: ed.descriptor }, 1, { solver });
    assert.equal(out.meta.depth, 2);
    console.log(`       stabilized the edited chair: ${F.blocksOf(ed.descriptor).length} -> ${F.blocksOf(out.descriptor).length} blocks (+${out.meta.added_blocks}, ${out.meta.steps.length} steps, stop ${out.meta.stop}), carried steps up to ${F.highestStep(ed.descriptor)}`);
    assert.ok(out.meta.added_blocks > 0, "the edit left the chair needing support");
    // every block of the edited version is in the result with the same role and step
    const kept = new Map(F.blocksOf(out.descriptor).map((b) => [F.codeOf(b.cell), b]));
    for (const b of F.blocksOf(ed.descriptor)) {
        const k = kept.get(F.codeOf(b.cell));
        assert.ok(k && k.role === b.role && k.step === b.step, `block ${b.cell} kept its role and step`);
    }
    assert.equal(crossCheckDerived(out.descriptor, out.meta, false), null, "firstRun=false: this run's steps are those after the carried ones");
    assert.notEqual(crossCheckDerived(out.descriptor, out.meta, true), null, "the old rule (firstRun for a non-stabilized source) would refuse it");
    const r = await upload(h, edited.model.id, out.glb);
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.kind, "stabilized");
    assert.equal(r.model.derived.depth, 2);
    assert.equal(r.model.source_model_id, edited.model.id);
    // The chair is edited again (another leg loses its middle), and that edit is stabilized: depth 3, the last one allowed. Roles and steps of
    // every block of the earlier results survive both runs.
    const present = new Set(F.blocksOf(out.descriptor).map((b) => F.codeOf(b.cell)));
    const cut = [[7, 6, 2], [7, 6, 3]].filter((c) => present.has(F.codeOf(c)));
    assert.equal(cut.length, 2, "the back right leg is there to cut");
    const ed3 = await F.editedFixture({ source: out.descriptor, edits: [{ remove: cut, instruction: "cut the back right leg", summary: "Cut a leg." }], stabilizedDepth: 2, depth: 4 });
    const edited3 = await upload(h, r.model.id, ed3.glb);
    assert.equal(edited3.status, 201, edited3.error);
    assert.equal(edited3.model.edit.stabilized_depth, 2);
    const again = await stabilize({ cells: F.blocksOf(ed3.descriptor).map((b) => b.cell), settings, options: { ...stabilizerLib.DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000 }, assembly: ed3.descriptor }, 2, { solver });
    console.log(`       stabilized the second edit: ${F.blocksOf(ed3.descriptor).length} -> ${F.blocksOf(again.descriptor).length} blocks (+${again.meta.added_blocks}), depth ${again.meta.depth}`);
    assert.equal(again.meta.depth, 3);
    assert.ok(again.meta.added_blocks > 0, "the cut leg needed support");
    const keptAgain = new Map(F.blocksOf(again.descriptor).map((b) => [F.codeOf(b.cell), b]));
    for (const b of F.blocksOf(ed3.descriptor)) {
        const k = keptAgain.get(F.codeOf(b.cell));
        assert.ok(k && k.role === b.role && k.step === b.step, `re-stabilizing kept the role and step of block ${b.cell}`);
    }
    assert.equal(crossCheckDerived(again.descriptor, again.meta, false), null);
    const third = await upload(h, edited3.model.id, again.glb);
    assert.equal(third.status, 201, third.error);
    assert.equal(third.model.derived.depth, 3);
    // a fourth would be refused
    const fourth = await upload(h, third.model.id, again.glb);
    assert.equal(fourth.status, 409);
});

await test("edit the unstable original (a mesh source), then stabilize that edit: a first-run-like log on an edited block version with steps from the edit", async () => {
    const stabilize = await stabilizerLib.loadStabilizer();
    const solver = await engine.getSolver();
    const settings = engine.normalizeSettings({});
    const bytes = new Uint8Array(readFileSync(new URL("../../public/assignment_alex/examples/long-neck-dino/original.glb", import.meta.url)));
    const { soup } = await engine.loadSoupLikeTheApp(bytes);
    const res = await engine.analyseSoup(soup, {});
    const originalCells = engine.cellsOf(res);
    const { h, projectId, root } = world();
    const original = F.descriptorFromBlocks(originalCells.map((cell) => ({ cell })));
    // an edit that adds a block on top of the head
    const top = originalCells.reduce((m, c) => (c[2] > m[2] ? c : m), originalCells[0]);
    const add = top[2] < 9 ? [[top[0], top[1], top[2] + 1]] : [];
    const ed = await F.editedFixture({ source: original, edits: [{ add, instruction: "add a block on the head" }, { add: [], remove: [originalCells[0]] }], baseSteps: 0 });
    const e = await upload(h, root, ed.glb);
    assert.equal(e.status, 201, e.error);
    assert.equal(e.model.edit.base_steps, 0);
    const out = await stabilize({ cells: F.blocksOf(ed.descriptor).map((b) => b.cell), settings, options: { ...stabilizerLib.DEFAULT_STABILIZE_OPTIONS, maxBlocks: 1000 }, assembly: ed.descriptor }, 0, { solver });
    assert.equal(out.meta.depth, 1, "no stabilization above it: this is the first");
    console.log(`       stabilized the edited dino: ${F.blocksOf(ed.descriptor).length} -> ${F.blocksOf(out.descriptor).length} blocks (+${out.meta.added_blocks})`);
    assert.equal(crossCheckDerived(out.descriptor, out.meta, false), null);
    const r = await upload(h, e.model.id, out.glb);
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.derived.depth, 1);
});

console.log("== shared/optimizeMeta.ts and editChecks.ts used directly");

await test("crossCheckOptimized and crossCheckVoxelEdit: the source rule and the step rule", async () => {
    const st = await F.stabilizedFixture();
    const op = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 });
    assert.equal(crossCheckOptimized(op.descriptor, op.meta, { kind: "stabilized", assembly_hash: st.hash }), null);
    assert.match(crossCheckOptimized(op.descriptor, op.meta, { kind: "generated", assembly_hash: null }), /different model/);
    assert.match(crossCheckOptimized(op.descriptor, op.meta, { kind: "stabilized", assembly_hash: "1".repeat(64) }), /different model/);
    const ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(2) }, { add: F.freshCells(1), remove: [[0, 0, 0]] }], stabilizedDepth: 1 });
    assert.equal(crossCheckVoxelEdit(ed.descriptor, ed.log), null);
    assert.match(crossCheckVoxelEdit(ed.descriptor, { ...ed.log, base_steps: 0 }), /role 'user'/);
    assert.match(crossCheckVoxelEdit(ed.descriptor, { ...ed.log, edits: [ed.log.edits[0]] }), /do not add up|up to/);
});

console.log("== the daily AI slot of the direct lanes (/llm/voxel-edit, /llm/optimize-spec)");

{
    const { handleVoxelEdit } = await worker("voxelEdit");
    const { handleOptimizeSpec } = await worker("optimizeSpec");
    const { wasCharged } = await worker("llmCall");
    const scene = `MODEL: test\n${"x".repeat(50)}`;
    const req = (path, body) => new Request(`http://worker.test/api/assignment_alex${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const brief = { blocks: 10, extent: { min: [0, 0, 0], max: [2, 2, 2] }, parts: [], current: {} };
    const slots = (h) => h.sql("SELECT llm FROM usage").map((r) => r.llm)[0] ?? 0;
    const reply = (finish, usage, message = { content: "" }) => ({ choices: [{ finish_reason: finish, message }], ...(usage ? { usage } : {}) });
    const ok = (usage) => reply("stop", usage, { content: JSON.stringify({ summary: "s", notes: "", clarification: "", ops: [] }) });

    /** Runs one lane against a stubbed OpenRouter: `replies` are answered in turn (a function throws like a dropped connection). */
    async function lane(name, replies) {
        const h = createEnv({ OPENROUTER_API_KEY: "sk-or-v1-testkey-0123456789", ALLOW_OPEN_GENERATION: "1" });
        const realFetch = globalThis.fetch;
        const realTimeout = globalThis.setTimeout;
        let calls = 0;
        globalThis.fetch = async () => {
            const next = replies[Math.min(calls++, replies.length - 1)];
            if (typeof next === "function") return next();
            return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
        };
        // The retry pause (1.5 s) is not what is under test.
        globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 1000 ? 0 : ms, ...rest);
        let status = 200;
        try {
            if (name === "voxel-edit") await handleVoxelEdit(h.env, req("/llm/voxel-edit", { instruction: "make it taller", scene }));
            else await handleOptimizeSpec(h.env, req("/llm/optimize-spec", { goal: "lighter", brief }));
        } catch (err) {
            if (err?.name !== "HttpError") throw err;
            status = err.status;
        } finally {
            globalThis.fetch = realFetch;
            globalThis.setTimeout = realTimeout;
        }
        return { status, calls, slots: slots(h) };
    }

    await test("wasCharged: the vendor's cost or the tokens the model produced; no figures is not charged", () => {
        assert.equal(wasCharged(null), false);
        assert.equal(wasCharged({ prompt_tokens: 2500, completion_tokens: null, reasoning_tokens: null, cost_usd: null }), false, "prompt tokens alone do not say the model answered");
        assert.equal(wasCharged({ prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, cost_usd: 0.0003 }), true);
        assert.equal(wasCharged({ prompt_tokens: null, completion_tokens: 4000, reasoning_tokens: null, cost_usd: null }), true, "tokens without a cost figure");
        assert.equal(wasCharged({ prompt_tokens: 1, completion_tokens: 0, reasoning_tokens: null, cost_usd: 0 }), false);
    });

    for (const name of ["voxel-edit", "optimize-spec"]) {
        await test(`${name}: a reply that was paid for keeps the slot (cut off at max_tokens, refused, blocked by a filter, unreadable), whatever the status`, async () => {
            const cases = [
                ["cut off at max_tokens", reply("length", { prompt_tokens: 2500, completion_tokens: 4000, cost: 0.0011 }, { content: '{"summ' }), 502],
                ["cut off, cost not reported", reply("length", { prompt_tokens: 2500, completion_tokens: 4000 }, { content: '{"summ' }), 502],
                ["refusal", reply("stop", { prompt_tokens: 2500, completion_tokens: 20, cost: 0.0003 }, { content: "", refusal: "no" }), 422],
                ["content filter", reply("content_filter", { prompt_tokens: 2500, completion_tokens: 300, cost: 0.0004 }), 422],
                ["unreadable JSON", reply("stop", { prompt_tokens: 2500, completion_tokens: 300, cost: 0.0004 }, { content: "not json at all" }), 502],
            ];
            for (const [what, body, status] of cases) {
                const r = await lane(name, [body]);
                assert.equal(r.status, status, `${what}: status`);
                assert.equal(r.slots, 1, `${what}: the slot stays used (the model was paid)`);
            }
        });

        await test(`${name}: a call that never reached the model gives the slot back (no reply, a vendor error, a reply that cost nothing)`, async () => {
            const down = () => { throw new TypeError("fetch failed"); };
            const vendorError = { error: { code: 401, message: "No auth" } };
            const free = reply("stop", { prompt_tokens: 100, completion_tokens: 0, cost: 0 }, { content: "" });
            for (const [what, replies, status] of [
                ["OpenRouter unreachable", [down, down], 504],
                ["the vendor rejected the key", [vendorError], 502],
                ["an empty answer that cost nothing, twice", [free, free], 502],
            ]) {
                const r = await lane(name, replies);
                assert.equal(r.status, status, `${what}: status`);
                assert.equal(r.slots, 0, `${what}: the slot is handed back`);
            }
        });

        await test(`${name}: a first try that was paid keeps the slot even when the retry then fails without a bill`, async () => {
            const down = () => { throw new TypeError("fetch failed"); };
            // an empty answer that was charged is retryable (one more try), and the retry cannot reach the vendor
            const paidEmpty = reply("stop", { prompt_tokens: 2500, completion_tokens: 600, cost: 0.0006 }, { content: "" });
            const r = await lane(name, [paidEmpty, down]);
            assert.equal(r.calls, 2, "it did retry");
            assert.equal(r.status, 504);
            assert.equal(r.slots, 1, "the first try was paid for");
        });
    }

    await test("the daily cap of AI calls bounds what the paid failures cost: with the cap at 3, the 4th call is 429 whatever the first three came back as", async () => {
        const h = createEnv({ OPENROUTER_API_KEY: "sk-or-v1-testkey-0123456789", ALLOW_OPEN_GENERATION: "1", DAILY_LLM_LIMIT: "3" });
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify(reply("length", { prompt_tokens: 2500, completion_tokens: 4000, cost: 0.0011 }, { content: "{" })), { status: 200, headers: { "content-type": "application/json" } });
        const statuses = [];
        try {
            for (let n = 0; n < 4; n++) {
                try {
                    await handleVoxelEdit(h.env, req("/llm/voxel-edit", { instruction: "make it taller", scene }));
                } catch (err) {
                    statuses.push(err.status);
                }
            }
        } finally {
            globalThis.fetch = realFetch;
        }
        assert.deepEqual(statuses, [502, 502, 502, 429]);
        assert.equal(slots(h), 3);
    });
}

console.log("== the mesh upload (POST /models/:id/edited): what a viewer would have to load");

{
    const { checkEditedGlbJson, checkEditedImages, handleUploadEdited, MAX_EDITED_VERTICES, MAX_EDITED_IMAGE_SIDE } = await worker("editUpload");
    const { smallEditedGlb } = await import("./edit-test-support.mjs");
    const { assembleGlb } = await import("../../src/assignment/edit/patchGlb.ts");
    const { parseGlb } = await import("../../src/assignment/edit/gltf.ts");
    const zlib = await import("node:zlib");

    // ---- pictures: a real tiny PNG, a header that only claims a size, a JPEG header
    const crc32 = (buf) => { let crc = 0xffffffff; for (const b of buf) { crc ^= b; for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); Buffer.from(data).copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    /** A PNG whose header says W x H. With `pixels` the data is real (gray, all zero); without, the file only has the header and an end chunk. */
    function png(W, H, pixels = false) {
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 0;
        const idat = pixels ? zlib.deflateSync(Buffer.alloc(H * (W + 1))) : Buffer.alloc(0);
        return new Uint8Array(Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), ...(pixels ? [chunk("IDAT", idat)] : []), chunk("IEND", Buffer.alloc(0))]));
    }
    /** A JPEG that is only its markers: SOI, `app` bytes of APP1 metadata in segments (as a camera writes them, before the frame header), SOF0 with the size. */
    function jpeg(W, H, app = 16) {
        const parts = [Buffer.from([0xff, 0xd8])];
        for (let left = app; left > 0; left -= 60_000) {
            const n = Math.min(left, 60_000);
            parts.push(Buffer.from([0xff, 0xe1, (n + 2) >> 8, (n + 2) & 255]), Buffer.alloc(n));
        }
        parts.push(Buffer.from([0xff, 0xc0, 0, 17, 8, H >> 8, H & 255, W >> 8, W & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.from([0xff, 0xd9]));
        return new Uint8Array(Buffer.concat(parts));
    }
    const webp = () => { const b = new Uint8Array(40); b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]); return b; };

    /** A one-triangle GLB with the pictures in its BIN chunk; `edit(json)` may change the description afterwards. */
    function texturedGlb(pictures, edit = () => {}) {
        const P = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), UV = new Float32Array([0, 0, 1, 0, 0, 1]), I = new Uint16Array([0, 1, 2]);
        const parts = [new Uint8Array(P.buffer), new Uint8Array(UV.buffer), new Uint8Array(I.buffer), ...pictures.map((p) => p.bytes)];
        const views = []; const chunks = []; let off = 0;
        for (const b of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b); off += b.length; const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; } }
        const bin = new Uint8Array(off); let at = 0; for (const c of chunks) { bin.set(c, at); at += c.length; }
        const json = {
            asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, ...(pictures.length ? { material: 0 } : {}) }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" }],
            bufferViews: views, buffers: [{ byteLength: bin.length }],
            ...(pictures.length ? {
                materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: pictures.map((_, n) => ({ source: n })),
                images: pictures.map((p, n) => ({ bufferView: 3 + n, mimeType: p.mime ?? "image/png" })),
            } : {}),
        };
        edit(json);
        return assembleGlb(json, bin);
    }
    const jsonOf = (glb) => { const g = parseGlb(glb); return { json: g.json, binLength: g.bin.length }; };
    const pic = (bytes, mime) => ({ bytes, mime });

    await test("checkEditedGlbJson: a stride must be 4 to 252 bytes and at least the size of its element (a few bytes cannot stand for millions of points)", async () => {
        const { glb } = await smallEditedGlb();
        const { json, binLength } = jsonOf(glb);
        assert.equal(checkEditedGlbJson(json, binLength), null, "the good file passes");
        const mutate = (fn) => { const j = structuredClone(json); fn(j); return checkEditedGlbJson(j, binLength); };
        const position = json.meshes[0].primitives[0].attributes.POSITION;
        const view = json.accessors[position].bufferView;
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 1; }), /buffer views are not valid/);
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 3; }), /buffer views are not valid/);
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 256; }), /buffer views are not valid/);
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 12.5; }), /buffer views are not valid/);
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = "12"; }), /buffer views are not valid/);
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 8; }), /accessors are not valid/, "a stride smaller than a 3-float element");
        assert.equal(mutate((j) => { j.bufferViews[view].byteStride = 12; }), null, "a stride equal to the element is the packed layout");
        assert.match(mutate((j) => { j.bufferViews[view].byteStride = 16; }), /outside its file/, "a wider stride needs the room");
        // the review's file: 9,999,000 VEC3 floats claimed over 10 MB of bytes on a stride of 1
        const bomb = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 9_999_000, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 10_000_000, byteStride: 1 }, { buffer: 0, byteOffset: 10_000_000, byteLength: 6 }], buffers: [{ byteLength: 10_000_020 }] };
        assert.match(checkEditedGlbJson(bomb, 10_000_020), /buffer views are not valid/);
    });

    await test("checkEditedGlbJson: points, accessor bytes and the kind of primitive are bounded like triangles are", async () => {
        const { glb } = await smallEditedGlb();
        const { json, binLength } = jsonOf(glb);
        const prim = json.meshes.find((m) => m.primitives[0].indices !== undefined).primitives[0];
        const posAcc = prim.attributes.POSITION;
        const tooManyPoints = structuredClone(json);
        const acc = tooManyPoints.accessors[posAcc];
        acc.count = MAX_EDITED_VERTICES + 1;
        tooManyPoints.bufferViews[acc.bufferView].byteLength = acc.count * 12;
        delete tooManyPoints.bufferViews[acc.bufferView].byteStride;
        assert.match(checkEditedGlbJson(tooManyPoints, acc.count * 12 + binLength), /too many points/, "3.6M points + 1 with a handful of triangles");
        acc.count = MAX_EDITED_VERTICES - 20_000; // (the added parts have points of their own)
        tooManyPoints.bufferViews[acc.bufferView].byteLength = acc.count * 12;
        assert.equal(checkEditedGlbJson(tooManyPoints, acc.count * 12 + binLength), null, "just under 3 points for each of the 1.2M triangles a mesh may have");
        // accessor bytes: the same 48 MB of positions named by 8 attributes of 3M VEC4 floats each (384 MB once held) is more than 4 times the file limit
        const wide = structuredClone(json);
        const w = wide.meshes.find((m) => m.primitives[0].indices !== undefined).primitives[0];
        const base = wide.accessors.length;
        for (let n = 0; n < 8; n++) {
            wide.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 48_000_000 });
            wide.accessors.push({ bufferView: wide.bufferViews.length - 1, componentType: 5126, count: 3_000_000, type: "VEC4" });
            w.attributes[`TEXCOORD_${n}`] = base + n;
        }
        assert.match(checkEditedGlbJson(wide, 200_000_000), /too many points/, "(a chunk that big, so the views fit; the bytes they name are what is too many)");
        // more attributes than any file has
        const many = structuredClone(json);
        const mp = many.meshes.find((m) => m.primitives[0].indices !== undefined).primitives[0];
        for (let n = 0; n < 17; n++) mp.attributes[`TEXCOORD_${n}`] = posAcc;
        assert.match(checkEditedGlbJson(many, binLength), /meshes are not valid/);
        // strips and fans draw triangles the triangle count does not see; points and lines are not what an edit makes
        for (const mode of [0, 1, 3, 5, 6]) {
            const m = structuredClone(json);
            m.meshes.find((x) => x.primitives[0].indices !== undefined).primitives[0].mode = mode;
            assert.match(checkEditedGlbJson(m, binLength), /made of triangles/, `mode ${mode}`);
        }
        const four = structuredClone(json);
        four.meshes.find((x) => x.primitives[0].indices !== undefined).primitives[0].mode = 4;
        assert.equal(checkEditedGlbJson(four, binLength), null, "mode 4 is the default, spelled out");
        // morph targets are attributes too: 8 targets of 3M VEC3 floats (36 MB each) are more than the geometry may be
        const morph = structuredClone(json);
        const mm = morph.meshes.find((x) => x.primitives[0].indices !== undefined).primitives[0];
        morph.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: 36_000_000 });
        morph.accessors.push({ bufferView: morph.bufferViews.length - 1, componentType: 5126, count: 3_000_000, type: "VEC3" });
        mm.targets = Array.from({ length: 8 }, () => ({ POSITION: morph.accessors.length - 1 }));
        assert.match(checkEditedGlbJson(morph, 36_000_000), /too many points/);
        mm.targets = Array.from({ length: 33 }, () => ({ POSITION: 0 }));
        assert.match(checkEditedGlbJson(morph, 36_000_000), /meshes are not valid/);
        // the same bytes named by many views: a loader copies each view it needs (2000 views of a 48 MB chunk = 96 GB)
        const overlap = structuredClone(json);
        for (let n = 0; n < 5; n++) overlap.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: binLength });
        assert.match(checkEditedGlbJson(overlap, binLength), /add up to more than its data/);
        const shared = structuredClone(json);
        shared.bufferViews.push({ buffer: 0, byteOffset: 0, byteLength: binLength });
        assert.equal(checkEditedGlbJson(shared, binLength), null, "a writer that shares the bytes of one view with another is within twice the chunk");
        // the editor refuses a model with a skeleton or an animation, so none comes back
        for (const key of ["skins", "animations"]) {
            const m = structuredClone(json);
            m[key] = [{}];
            assert.match(checkEditedGlbJson(m, binLength), /animation or a skeleton/, key);
            m[key] = [];
            assert.equal(checkEditedGlbJson(m, binLength), null, `an empty ${key} list is no ${key}`);
        }
    });

    await test("checkEditedGlbJson: pictures live in the BIN chunk (no data: uri, no empty entry); png and jpeg only", async () => {
        const glb = texturedGlb([pic(png(4, 4, true))]);
        const { json, binLength } = jsonOf(glb);
        assert.equal(checkEditedGlbJson(json, binLength), null);
        const mutate = (fn) => { const j = structuredClone(json); fn(j); return checkEditedGlbJson(j, binLength); };
        assert.match(mutate((j) => { j.images[0] = { uri: "data:image/png;base64,iVBORw0KGgo=" }; }), /stored in the model's data part/);
        assert.match(mutate((j) => { j.images[0] = { uri: "https://evil.example/t.png" }; }), /outside itself/);
        assert.match(mutate((j) => { j.images[0] = { mimeType: "image/png" }; }), /pictures are not valid/);
        assert.match(mutate((j) => { j.images[0].mimeType = "image/webp"; }), /unsupported format/);
    });

    await test("checkEditedImages: the size comes from the picture's own header; a 20000 x 20000 PNG, a side over 4096, a JPEG that lies about its type, an unreadable header are refused", async () => {
        const check = async (pictures) => {
            const glb = texturedGlb(pictures);
            const { json, binLength } = jsonOf(glb);
            assert.equal(checkEditedGlbJson(json, binLength), null, "(the description itself is fine: the size is in the picture)");
            const g = parseGlb(glb);
            const reads = [];
            const problem = await checkEditedImages(json, async (offset, length) => { reads.push(length); return g.bin.subarray(offset, offset + length); });
            return { problem, reads };
        };
        assert.equal((await check([pic(png(4, 4, true))])).problem, null, "a real tiny PNG");
        assert.equal((await check([pic(png(4096, 4096))])).problem, null, "the Hunyuan texture size (4096 x 4096) is the largest allowed");
        assert.equal((await check([pic(jpeg(2048, 2048), "image/jpeg")])).problem, null, "a JPEG re-encoded by the editor");
        assert.equal((await check([pic(jpeg(2048, 1024, 70_000), "image/jpeg")])).problem, null, "a JPEG with 70 KB of metadata before its frame header is still read");
        assert.match((await check([pic(png(20000, 20000))])).problem, /too large \(at most 4096 x 4096/, "the review's 20000 x 20000 PNG");
        assert.match((await check([pic(png(4097, 16))])).problem, /too large/);
        assert.match((await check([pic(png(16, 4097))])).problem, /too large/);
        assert.match((await check([pic(jpeg(8000, 8000), "image/jpeg")])).problem, /too large/);
        assert.match((await check([pic(png(0, 16))])).problem, /could not be read/);
        assert.match((await check([pic(png(4294967295, 4294967295))])).problem, /too large/, "32-bit sides");
        assert.match((await check([pic(jpeg(64, 64), "image/png")])).problem, /not the format it says/, "JPEG bytes declared as PNG");
        assert.match((await check([pic(png(64, 64), "image/jpeg")])).problem, /not the format it says/);
        assert.match((await check([pic(webp(), "image/png")])).problem, /unsupported format/, "WebP bytes");
        assert.match((await check([pic(new Uint8Array(200).fill(7))])).problem, /unsupported format/, "bytes that are no picture");
        assert.match((await check([pic(png(64, 64).subarray(0, 20))])).problem, /could not be read/, "a PNG cut off inside its header");
        assert.match((await check([pic(jpeg(64, 64, 200_000), "image/jpeg")])).problem, /could not be read/, "a JPEG whose frame header is past the 128 KB that are read");
        // together: 4 of the largest are the most, a fifth is not
        assert.equal((await check([1, 2, 3, 4].map(() => pic(png(4096, 4096))))).problem, null);
        assert.match((await check([1, 2, 3, 4, 5].map(() => pic(png(4096, 4096))))).problem, /too large together/);
        assert.match((await check(Array.from({ length: 20 }, () => pic(png(4096, 4096))))).problem, /too large together/, "twenty of them: 1.3 GB once decoded");
        // never more than the head of a picture
        const { reads } = await check([pic(png(4096, 4096)), pic(jpeg(4096, 4096), "image/jpeg")]);
        assert.ok(reads.length === 2 && reads.every((n) => n <= 128 * 1024), `reads: ${reads}`);
        assert.equal(await checkEditedImages({ asset: { version: "2.0" } }, async () => { throw new Error("no picture, no read"); }), null, "no pictures: nothing is read");
        assert.equal(MAX_EDITED_IMAGE_SIDE, 4096);
    });

    // ---- the handler in Node: R2 range reads and FixedLengthStream stand in for the Workers runtime
    globalThis.FixedLengthStream ??= class extends TransformStream { constructor() { super(); } };
    function uploadWorld(planOver = {}) {
        const w = world();
        w.h.r2.get = async (key, options) => {
            const o = w.h.r2.objects.get(key);
            if (!o) return null;
            const b = options?.range ? o.bytes.slice(options.range.offset, options.range.offset + options.range.length) : o.bytes;
            return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), size: o.bytes.byteLength };
        };
        const jobId = uuid();
        const plan = { target: "mesh", applied: true, summary: "Made it taller.", notes: [], program: { summary: "s", applied: true, ops: [{ op: "stretch", label: "top", boxes: [], exclude: [], feather_mm: 20, axis: "z" }] }, ...planOver };
        w.h.sql(
            `INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, created_at, updated_at, kind, source_model_id, edit_target, plan)
             VALUES (?, ?, 'muse', 'openrouter', 'make it taller', 'succeeded', 100, 'Done', ?, ?, 'edit', ?, 'mesh', ?)`,
            jobId, w.projectId, nowIso(), nowIso(), w.root, JSON.stringify(plan),
        );
        return { ...w, jobId };
    }
    const sendEdited = (w, bytes, jobId = w.jobId) => attempt(() => handleUploadEdited(w.h.env, new Request("http://worker.test/edited", { method: "POST", headers: { "content-type": "model/gltf-binary", "content-length": String(bytes.length) }, body: bytes }), w.root, jobId));
    const editedSlots = (h) => h.sql("SELECT edited FROM usage").map((r) => r.edited)[0] ?? 0;

    await test("POST /edited in Node: a good file with a picture is stored; a PNG bomb, a stride bomb and a data: picture are refused 400, the file leaves R2 and the daily slot is handed back", async () => {
        const w = uploadWorld();
        // the review's second file: 10 MB, an accessor of 9,999,000 VEC3 floats over a byteStride of 1
        const strideBomb = (() => {
            const bin = new Uint8Array(10_000_020);
            const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
                accessors: [{ bufferView: 0, componentType: 5126, count: 9_999_000, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
                bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 10_000_000, byteStride: 1 }, { buffer: 0, byteOffset: 10_000_000, byteLength: 6 }], buffers: [{ byteLength: bin.length }] };
            return assembleGlb(json, bin);
        })();
        const refusals = [
            ["a 20000 x 20000 picture (a few hundred bytes of file)", texturedGlb([pic(png(20000, 20000))]), /too large/],
            ["a picture that is not a picture", texturedGlb([pic(new Uint8Array(300).fill(1))]), /unsupported format/],
            ["a stride of 1 over 9,999,000 points", strideBomb, /buffer views are not valid/],
            ["a picture written as a data: uri", texturedGlb([pic(png(4, 4, true))], (j) => { j.images[0] = { uri: "data:image/png;base64,iVBORw0KGgo=" }; }), /stored in the model's data part/],
        ];
        for (const [what, bytes, re] of refusals) {
            const r = await sendEdited(w, bytes);
            assert.equal(r.status, 400, `${what}: ${r.status} ${r.error}`);
            assert.match(r.error, re, what);
        }
        assert.equal(editedSlots(w.h), 0, "every refusal handed its daily slot back");
        assert.equal([...w.h.r2.objects.keys()].filter((k) => k.startsWith("models/")).length, 0, "...and no file is left in R2");
        assert.equal(countOf(w.h, w.projectId), 1, "...and no row was stored");
        assert.equal(w.h.sql("SELECT model_id FROM jobs WHERE id = ?", w.jobId)[0].model_id, null);
        // the same job then takes a good file with a real picture
        const good = texturedGlb([pic(png(8, 8, true))]);
        const r = await sendEdited(w, good);
        assert.equal(r.status, 201, r.error);
        assert.equal(r.model.kind, "edited");
        assert.equal(editedSlots(w.h), 1);
        assert.equal(w.h.r2.objects.get(`models/${r.model.id}.glb`).bytes.length, good.length);
        assert.equal((await sendEdited(w, good)).status, 200, "a retry is answered with the model that is there");
        // a file without pictures, as the editor writes it for an untextured source
        const plain = uploadWorld();
        assert.equal((await sendEdited(plain, (await smallEditedGlb()).glb)).status, 201);
    });

    await test("POST /edited: a job whose plan did not change anything (applied false) or has no readable plan takes no upload", async () => {
        const { glb } = await smallEditedGlb();
        for (const [what, over] of [["applied false", { applied: false }], ["plan of a design edit", { target: "design" }]]) {
            const w = uploadWorld(over);
            const r = await sendEdited(w, glb);
            assert.equal(r.status, 409, what);
            assert.match(r.error, /no changes/, what);
            assert.equal(editedSlots(w.h), 0);
            assert.equal(w.h.r2.puts.length, 0, "refused before anything was written");
        }
        const noPlan = uploadWorld();
        noPlan.h.sql("UPDATE jobs SET plan = NULL WHERE id = ?", noPlan.jobId);
        assert.equal((await sendEdited(noPlan, glb)).status, 409);
        const junk = uploadWorld();
        junk.h.sql("UPDATE jobs SET plan = '{\"target\":\"mesh\"}' WHERE id = ?", junk.jobId);
        assert.equal((await sendEdited(junk, glb)).status, 409, "a plan without `applied` is not a plan that was applied");
        // the retry of an upload that got through is still answered first
        const w = uploadWorld();
        const first = await sendEdited(w, glb);
        assert.equal(first.status, 201, first.error);
        w.h.sql("UPDATE jobs SET plan = NULL WHERE id = ?", w.jobId);
        assert.equal((await sendEdited(w, glb)).status, 200);
    });
}

console.log("== deleting a version is one statement");

await test("a save under a version that is being deleted lands inside the subtree and goes with it, file included; a save after it is refused: no row is left with a parent that is gone", async () => {
    const { h, projectId, root } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const ed = await F.editedFixture({ source: st.descriptor, edits: [{ add: F.freshCells(1) }], stabilizedDepth: 1, depth: 2 });
    const orphans = () => h.sql("SELECT m.id FROM models m WHERE m.source_model_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM models p WHERE p.id = m.source_model_id)");
    // (a) the other tab's save is answered at the moment the delete statement is about to run (after everything deleteVersion read first)
    const realPrepare = h.env.DB.prepare.bind(h.env.DB);
    let saved = null;
    let injecting = false;
    const inject = async () => {
        if (saved !== null || injecting) return;
        injecting = true;
        saved = await upload(h, s.id, ed.glb);
        injecting = false;
    };
    h.env.DB.prepare = (text) => {
        const statement = realPrepare(text);
        if (!/^\s*DELETE FROM models/.test(text)) return statement;
        return { bind: (...values) => { const bound = statement.bind(...values); return { all: async () => { await inject(); return bound.all(); }, run: async () => { await inject(); return bound.run(); }, first: async () => { await inject(); return bound.first(); } }; } };
    };
    await deleteVersion(h.env, s.id);
    h.env.DB.prepare = realPrepare;
    assert.equal(saved?.status, 201, "the save got in before the delete statement");
    assert.deepEqual(rowsOf(h, projectId).map((r) => r.id), [root], "the version, and the save made from it, are gone");
    assert.deepEqual(orphans(), []);
    assert.deepEqual([...h.r2.deleted].sort(), [`models/${s.id}.glb`, `models/${saved.model.id}.glb`].sort(), "both files left R2");
    assert.equal([...h.r2.objects.keys()].filter((k) => k.startsWith("models/")).length, 0);
    // (b) a save that comes after the delete (a stale tab) is refused, and leaves no file behind
    const late = await upload(h, s.id, ed.glb);
    assert.equal(late.status, 404);
    assert.deepEqual(orphans(), []);
    assert.equal([...h.r2.objects.keys()].filter((k) => k.startsWith("models/")).length, 0, "the refused save's file was removed again");
    assert.equal(h.sql("SELECT derived FROM usage")[0].derived, 2, "the late save never took a daily slot");
    // (c) the source is deleted after the upload has read it and before its INSERT: the INSERT's own condition refuses, the file and the slot go back
    const w2 = world();
    const s2 = (await upload(w2.h, w2.root, st.glb)).model;
    const real2 = w2.h.env.DB.prepare.bind(w2.h.env.DB);
    let fired = false;
    w2.h.env.DB.prepare = (text) => {
        const statement = real2(text);
        if (fired || !/^\s*INSERT INTO usage/.test(text)) return statement;
        return { bind: (...values) => { const bound = statement.bind(...values); return { first: async () => { fired = true; await deleteVersion(w2.h.env, s2.id); return bound.first(); } }; } };
    };
    const lost = await upload(w2.h, s2.id, ed.glb);
    w2.h.env.DB.prepare = real2;
    assert.equal(fired, true);
    assert.equal(lost.status, 404);
    assert.deepEqual(w2.h.sql("SELECT id FROM models WHERE source_model_id IS NOT NULL"), []);
    assert.equal([...w2.h.r2.objects.keys()].filter((k) => k.startsWith("models/")).length, 0, "neither the deleted version's file nor the refused save's file is left");
    assert.equal(w2.h.sql("SELECT derived FROM usage")[0].derived, 1, "the refused save gave its daily slot back");
});

console.log("== an optimization is tied to the model it is saved on");

await test("the log's `before` is the source's block count: a no-op that claims 300 removed blocks is refused; a block version with no saved analysis takes no optimization; a mesh is compared once it has one", async () => {
    const { h, root, projectId } = world();
    const st = await F.stabilizedFixture();
    const s = (await upload(h, root, st.glb)).model;
    const honest = await F.optimizedFixture({ source: st.descriptor, remove: [[2, 0, 0]], sourceHash: st.hash, stabilizedDepth: 1 });
    // The review's forgery: the same blocks, with a log that says 300 more cells were removed (codes that are empty in the file), so "before" is 300 higher.
    const forged = (fixture, extra) => {
        const present = new Set(F.blocksOf(fixture.descriptor).map((b) => F.codeOf(b.cell)));
        const gone = new Set(fixture.meta.removed);
        const phantoms = [];
        for (let code = 0; code < 1000 && phantoms.length < extra; code++) if (!present.has(code) && !gone.has(code)) phantoms.push(code);
        const m = structuredClone(fixture.meta);
        m.removed = [...m.removed, ...phantoms].sort((a, b) => a - b);
        m.removed_at = m.removed.map(() => 1);
        m.before = F.optMetricsFor(m.after.blocks + m.removed.length - m.added);
        return F.writeAssemblyGlb(fixture.descriptor, null, null, m);
    };
    const lie = forged(honest, 299);
    assert.equal(F.readAssemblyGlb(lie, null).ok, true, "the forged file is well-formed: only the source can tell");
    let r = await upload(h, s.id, lie);
    assert.equal(r.status, 400, r.error);
    assert.match(r.error, /different model/);
    assert.equal(countOf(h, projectId), 2, "nothing was stored");
    r = await upload(h, s.id, honest.glb);
    assert.equal(r.status, 201, r.error);
    assert.equal(r.model.optimization.before.blocks, 26);
    assert.equal(r.model.optimization.removed, 1);
    // a block version always has its verdict (the Worker stored it); one that has lost it cannot be checked against, so it takes none
    const otherStab = await F.stabilizedFixture({ more: F.freshCells(1) });
    const other = (await upload(h, root, otherStab.glb)).model;
    h.sql("UPDATE models SET analysis = NULL WHERE id = ?", other.id);
    const noVerdict = await F.optimizedFixture({ source: otherStab.descriptor, remove: [[2, 0, 0]], sourceHash: otherStab.hash, stabilizedDepth: 1 });
    r = await upload(h, other.id, noVerdict.glb);
    assert.equal(r.status, 400);
    assert.match(r.error, /no saved analysis/);
    // a mesh has a verdict only once the browser has saved one: with none, nothing to compare (as before); with one, it must agree
    const plain = F.plainDescriptor();
    const fromMesh = await F.optimizedFixture({ source: plain, remove: [[2, 0, 0]], sourceHash: null });
    h.sql("UPDATE models SET analysis = ? WHERE id = ?", JSON.stringify(F.summaryFor(30, false)), root);
    r = await upload(h, root, forged(fromMesh, 40));
    assert.equal(r.status, 400, "a mesh whose saved analysis says 30 blocks, an optimization that says it started from 61");
    assert.match(r.error, /different model/);
    h.sql("UPDATE models SET analysis = ? WHERE id = ?", JSON.stringify(F.summaryFor(21, false)), root);
    r = await upload(h, root, fromMesh.glb);
    assert.equal(r.status, 201, r.error);
    const fresh = world();
    assert.equal((await upload(fresh.h, fresh.root, forged(fromMesh, 40))).status, 201, "no saved analysis on a mesh: the log's own counts are all there is to check (documented)");
});

await test("an edited mesh's part count is the file's (the nodes that draw a mesh), not the source's: the Stability tab reads it to tell one piece from an assembly", async () => {
    const { countMeshNodes } = await worker("editUpload");
    assert.equal(countMeshNodes({ nodes: [{ mesh: 0 }, { mesh: 1 }, { children: [0] }, { mesh: 2, name: "x" }] }), 3);
    assert.equal(countMeshNodes({ nodes: [{ mesh: 0 }] }), 1);
    assert.equal(countMeshNodes({ nodes: [{ mesh: "0" }, null, 4, { camera: 0 }] }), 0, "only a real mesh index counts");
    assert.equal(countMeshNodes({ nodes: "no" }), 0);
    assert.equal(countMeshNodes(null), 0);
    assert.equal(countMeshNodes({}), 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
