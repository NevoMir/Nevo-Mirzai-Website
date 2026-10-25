// Tests for the shared assembly modules: descriptor, GLB writer/reader, DerivedMeta, summary validator.
//   node scripts/assignment/test-shared-assembly.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const sh = (n) => import(`../../src/assignment/shared/${n}.ts`);
const { descriptorFromBlocks, parseAssemblyDescriptor, assemblyHash, roleCounts, blockCount } = await sh("assembly");
const { writeAssemblyGlb, readAssemblyGlb } = await sh("assemblyGlb");
const { checkDerivedMeta } = await sh("derivedMeta");
const { checkAnalysisSummary } = await sh("analysisSummary");
const { BLOCK_ROLES } = await sh("contract");

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); } }

const summary = (blocks) => ({ version: 1, blocks, bodies: 1, floating_blocks: 0, cantilevered: 0, longest_cantilever: 0, over_limit: 0, cantilever_limit: 4, cog_mm: [150, 150, 100], cog_inside: true, cog_margin_mm: 50, size_mm: [300, 300, 300], coverage: 1, fill_threshold: 0.1, errors: 0, warnings: 0, stress: { material: "concrete", max_utilisation: 0.21, max_at: [1, 1, 0], stressed_blocks: 0, overstressed_blocks: 0, analysed_blocks: blocks, unsupported_blocks: 0 }, analyzed_at: "2026-10-24T10:00:00.000Z" });
const metrics = (blocks, over) => ({ blocks, errors: over ? 1 : 0, warnings: 0, floating_blocks: 0, over_limit: over ? 3 : 0, longest_cantilever: over ? 7 : 3, cog_margin_mm: 17, max_utilisation: over ? 1.98 : 0.21, overstressed_blocks: over ? 3 : 0 });
const stepMetrics = (m) => ({ blocks: m.blocks, errors: m.errors, floating_blocks: m.floating_blocks, over_limit: m.over_limit, longest_cantilever: m.longest_cantilever, cog_margin_mm: m.cog_margin_mm, max_utilisation: m.max_utilisation });
async function sample(extra = 2) {
    // a 3-block arm + `extra` column blocks
    const blocks = [{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1] }];
    for (let q = 0; q < extra; q++) blocks.push({ cell: [1, 0, 0 - q + 0 === 0 ? 0 : 0], role: "column", step: 1 });
    return blocks;
}
async function sampleDescriptor() {
    const blocks = [{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1] }, { cell: [1, 0, 0], role: "column", step: 1 }, { cell: [2, 0, 1], role: "bracket", step: 2 }, { cell: [2, 0, 0], role: "footing", step: 2 }];
    return descriptorFromBlocks(blocks);
}
async function sampleMeta(descriptor) {
    const before = metrics(3, true), after = metrics(6, false);
    return { version: 1, depth: 1, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.6, cantilever_limit: 4, fill_threshold: 0.1, complete: true, stop: "stable", added_blocks: 3, added_by_role: { column: 1, bracket: 1, footing: 1 }, before, after,
        steps: [{ n: 1, move: "column", reason: "cantilever", added: 1, text: "Added a 1-block column under the arm tip at x = 150 mm.", at_mm: [150, 50, 50], before: stepMetrics(before), after: stepMetrics(metrics(4, true)) }, { n: 2, move: "bracket", reason: "stress", added: 2, text: "Added a bracket and footing.", at_mm: [250, 50, 50], before: stepMetrics(metrics(4, true)), after: stepMetrics(after) }],
        duration_ms: 42, assembly_hash: await assemblyHash(descriptor), after_summary: summary(6), created_at: "2026-10-24T10:00:01.000Z" };
}

await test("descriptor: canonical order, roles and steps agree, parser round-trips", async () => {
    const d = await sampleDescriptor();
    assert.equal(blockCount(d), 6);
    assert.deepEqual(d.cells.slice(0, 5), [0, 0, 0, 0, 0]); // k, j, i ascending: (0,0,0) first
    assert.deepEqual(parseAssemblyDescriptor(JSON.parse(JSON.stringify(d))), d);
    assert.deepEqual(roleCounts(d), [3, 1, 1, 1, 0, 0, 0]);
});

await test("descriptor: the parser refuses what is not canonical or not valid", async () => {
    const d = await sampleDescriptor();
    const mut = (f) => { const c = structuredClone(d); f(c); return parseAssemblyDescriptor(c); };
    assert.equal(mut((c) => { c.version = 2; }), null);
    assert.equal(mut((c) => { c.blockSizeMm = 50; }), null);
    assert.equal(mut((c) => { c.grid = [10, 10, 11]; }), null);
    assert.equal(mut((c) => { c.inset = 0.5; }), null);
    assert.equal(mut((c) => { c.cells.push(1); }), null); // not a multiple of 5
    assert.equal(mut((c) => { c.cells = []; }), null);
    assert.equal(mut((c) => { c.cells[0] = 10; }), null); // outside the grid
    assert.equal(mut((c) => { c.cells[0] = 1.5; }), null);
    assert.equal(mut((c) => { c.cells[3] = 9; }), null); // role index
    assert.equal(mut((c) => { c.cells[4] = 3; }), null); // original with a step
    assert.equal(mut((c) => { c.cells[9] = 0; }), null); // added block (role column) with step 0
    assert.equal(mut((c) => { const a = c.cells.splice(0, 5); c.cells.push(...a); }), null); // not ascending
    assert.equal(mut((c) => { c.cells.push(...c.cells.slice(0, 5)); }), null); // duplicate
    assert.throws(() => descriptorFromBlocks([{ cell: [0, 0, 0] }, { cell: [0, 0, 0] }]), /twice/);
    assert.throws(() => descriptorFromBlocks([{ cell: [10, 0, 0] }]), /outside/);
});

await test("GLB: deterministic, small, and read back identically (with and without the log)", async () => {
    const d = await sampleDescriptor();
    const meta = await sampleMeta(d);
    const a = writeAssemblyGlb(d, meta), b = writeAssemblyGlb(d, meta);
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
    const r = readAssemblyGlb(a, null);
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.descriptor, d);
    assert.deepEqual(r.meta, checkDerivedMeta(meta, null).value);
    assert.throws(() => writeAssemblyGlb(d, { ...meta, added_blocks: 99 }), /log is invalid/);
    assert.throws(() => writeAssemblyGlb({ ...d, cells: d.cells.slice(5) .concat(d.cells.slice(0, 5)) }), /canonical/);
    const plain = readAssemblyGlb(writeAssemblyGlb(d), null);
    assert.ok(plain.ok && plain.meta === null);
});

await test("GLB: every single-byte change is refused (3-block and 6-block files, all bytes)", async () => {
    const d = await sampleDescriptor();
    const meta = await sampleMeta(d);
    for (const glb of [writeAssemblyGlb(d), writeAssemblyGlb(d, meta)]) {
        let accepted = 0;
        for (let at = 0; at < glb.length; at++) {
            const copy = glb.slice(); copy[at] ^= 0xff;
            if (readAssemblyGlb(copy, null).ok) { accepted++; console.log("       accepted flip at", at); }
        }
        assert.equal(accepted, 0);
    }
});

await test("GLB: truncated, extended, wrong magic, empty, oversize are refused", async () => {
    const d = await sampleDescriptor();
    const glb = writeAssemblyGlb(d);
    assert.equal(readAssemblyGlb(glb.subarray(0, glb.length - 4)).ok, false);
    const longer = new Uint8Array(glb.length + 4); longer.set(glb);
    assert.equal(readAssemblyGlb(longer).ok, false);
    assert.equal(readAssemblyGlb(new Uint8Array(0)).ok, false);
    assert.equal(readAssemblyGlb(new Uint8Array(2 * 1024 * 1024)).ok, false);
    const noMagic = glb.slice(); noMagic[0] = 0; assert.equal(readAssemblyGlb(noMagic).ok, false);
});

await test("GLB: a view into a larger buffer (unaligned) reads the same", async () => {
    const d = await sampleDescriptor(); const glb = writeAssemblyGlb(d);
    const host = new Uint8Array(glb.length + 7); host.set(glb, 3);
    assert.ok(readAssemblyGlb(host.subarray(3, 3 + glb.length), null).ok);
});

await test("1000 blocks: file under 700 KB, written in well under 50 ms, read in under 25 ms", async () => {
    const blocks = [];
    for (let k = 0; k < 10; k++) for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) blocks.push({ cell: [i, j, k], role: k === 9 ? "reinforcement" : k === 0 ? "original" : k % 2 ? "column" : "bridge", step: k === 0 ? 0 : 1 + (k % 5) });
    // roles other than "original" need step >= 1, original step 0: the builder above follows that.
    const d = descriptorFromBlocks(blocks);
    let t0 = performance.now(); const glb = writeAssemblyGlb(d); const w = performance.now() - t0;
    t0 = performance.now(); const r = readAssemblyGlb(glb, null); const rd = performance.now() - t0;
    console.log(`       ${blockCount(d)} blocks: ${(glb.length / 1024).toFixed(0)} KB, write ${w.toFixed(1)} ms, read ${rd.toFixed(1)} ms`);
    assert.ok(r.ok, r.error);
    assert.ok(glb.length < 700 * 1024);
    assert.ok(w < 50 && rd < 25);
    assert.equal((await assemblyHash(d)).length, 64);
});

await test("assemblyHash ignores step numbers but not roles or cells", async () => {
    const d = await sampleDescriptor();
    const other = structuredClone(d); other.cells[19] += 5; // a step number
    assert.equal(await assemblyHash(other), await assemblyHash(d));
    const moved = structuredClone(d); moved.cells[3 * 5 + 3] = 2; // role of one block
    assert.notEqual(await assemblyHash(moved), await assemblyHash(d));
});

await test("DerivedMeta: valid passes; sums, ordering, enums, sizes and control characters are checked", async () => {
    const d = await sampleDescriptor(); const meta = await sampleMeta(d);
    assert.ok(checkDerivedMeta(meta, null).ok);
    const bad = (f) => { const c = structuredClone(meta); f(c); return checkDerivedMeta(c, null).ok; };
    assert.equal(bad((c) => { c.added_blocks = 4; }), false);
    assert.equal(bad((c) => { c.after.blocks = 7; }), false);
    assert.equal(bad((c) => { c.steps[1].n = 5; }), false);
    assert.equal(bad((c) => { c.steps[0].move = "original"; }), false);
    assert.equal(bad((c) => { c.steps[0].text = "x\u0000y"; }), false);
    assert.equal(bad((c) => { c.steps[0].text = "x".repeat(301); }), false);
    assert.equal(bad((c) => { c.material = "gold"; }), false);
    assert.equal(bad((c) => { c.assembly_hash = "abc"; }), false);
    assert.equal(bad((c) => { c.depth = 4; }), false);
    assert.equal(bad((c) => { c.after_summary.errors = -1; }), false);
    assert.equal(bad((c) => { c.after_summary.stress.material = "gold"; }), false);
    assert.equal(bad((c) => { c.steps = Array.from({ length: 61 }, (_, i) => ({ ...c.steps[0], n: i + 1 })); }), false);
    const extra = structuredClone(meta); extra.surprise = "x"; assert.equal("surprise" in checkDerivedMeta(extra, null).value, false);
});

await test("AnalysisSummary: stress block is optional, validated and rebuilt", async () => {
    const s = summary(10);
    assert.ok(checkAnalysisSummary(s, null).ok);
    const without = structuredClone(s); delete without.stress; assert.ok(checkAnalysisSummary(without, null).ok);
    const nulled = structuredClone(s); nulled.stress = null; assert.equal(checkAnalysisSummary(nulled, null).value.stress, null);
    for (const f of [(c) => { c.stress.max_utilisation = -1; }, (c) => { c.stress.max_utilisation = 99; }, (c) => { c.stress.max_at = [1.5, 0, 0]; }, (c) => { c.stress.max_at = [10, 0, 0]; }, (c) => { c.stress.analysed_blocks = 1001; }, (c) => { c.stress = 5; }]) {
        const c = structuredClone(s); f(c); assert.equal(checkAnalysisSummary(c, null).ok, false);
    }
    const extra = structuredClone(s); extra.stress.junk = 1; assert.equal("junk" in checkAnalysisSummary(extra, null).value.stress, false);
});

// ---------- M0: the role "user" and the three logs a version's GLB can carry (stabilization, edit, optimization) ----------

const { readEditMeta, readOptimizeSummary, stabilizationsOf, representationOf } = await sh("versionMeta");
const { summarizeVoxelEdit, checkVoxelEditLog, labelOfInstruction } = await sh("voxelEdit/log");
const { checkOptimizeMeta, crossCheckOptimized, summarizeOptimize } = await sh("optimizeMeta");
const { presetSpec, repairSpec } = await sh("optimizeSpec");
const { ROLE_HEX, ROLE_NODE_NAMES, EDIT_EXTRAS_KEY, OPTIMIZATION_EXTRAS_KEY, STABILIZATION_EXTRAS_KEY, cellCode } = await sh("assembly");

const optMetrics = (blocks) => ({ blocks, weight_kg: blocks * 2.4, errors: 0, warnings: 0, floating_blocks: 0, over_limit: 0, longest_cantilever: 3, cog_margin_mm: 40, max_utilisation: 0.3, max_deflection_um: 12 });
// A block version made by words: a 3-block arm that two instructions-worth of `user` blocks (step 1) lengthen.
async function editFixture() {
    const base = [{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1] }];
    const d = descriptorFromBlocks([...base, { cell: [2, 0, 1], role: "user", step: 1 }, { cell: [2, 0, 0], role: "user", step: 1 }]);
    const log = {
        version: 1, depth: 1, stabilized_depth: 0, base_steps: 0,
        edits: [{ n: 1, instruction: "make the arm longer and add a leg", summary: "Added two blocks.", notes: "", ops: [{ op: "add", box: [2, 0, 0, 2, 0, 1] }], added: 2, removed: 0, moved: 0, skipped_protected: 0, model: "meta/muse-spark-1.3-contributor", cost_usd: 0.0004 }],
        parts: [], labels: ".....", before: metrics(3, true), after: metrics(5, false), assembly_hash: await assemblyHash(d), after_summary: summary(5), created_at: "2026-10-25T10:00:00.000Z",
    };
    return { d, log };
}
// An optimized version: the stabilized sample (6 blocks) with its footing block taken out.
async function optimizeFixture() {
    const source = await sampleDescriptor();
    const kept = [];
    for (let n = 0; n < source.cells.length; n += 5) if (!(source.cells[n] === 2 && source.cells[n + 1] === 0 && source.cells[n + 2] === 0)) kept.push({ cell: [source.cells[n], source.cells[n + 1], source.cells[n + 2]], role: BLOCK_ROLES[source.cells[n + 3]], step: source.cells[n + 4] });
    const d = descriptorFromBlocks(kept);
    const meta = {
        version: 1, optimizer: "1.0.0", solver: "awatif-ts", material: "concrete", spec: presetSpec("lightest", { blocks: 6 }), source_hash: await assemblyHash(source),
        stabilized_depth: 1, goal: "Lightest", shape_changed: false, parts: [], labels: ".....", step: 0, removed: [cellCode(2, 0, 0)], removed_at: [1], added: 0, added_at: [],
        stop: "converged", feasible: true, before: optMetrics(6), after: optMetrics(5), history: [[1, 5, 0.3, 40, 12, 0.8, 1, 0, 3]], solves: 3, duration_ms: 12,
        assembly_hash: await assemblyHash(d), after_summary: summary(5), created_at: "2026-10-25T10:00:02.000Z",
    };
    return { source, d, meta };
}
/** Rebuilds a GLB with its JSON chunk changed by `f` (padded with spaces to a multiple of 4): a hand-made file for the reader to refuse. */
function withJson(glb, f) {
    const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const doc = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
    f(doc);
    const raw = new TextEncoder().encode(JSON.stringify(doc));
    const padded = raw.length + ((4 - (raw.length % 4)) % 4);
    const rest = glb.subarray(20 + jsonLength);
    const out = new Uint8Array(20 + padded + rest.length);
    out.set(glb.subarray(0, 20)); out.set(raw, 20); out.fill(0x20, 20 + raw.length, 20 + padded); out.set(rest, 20 + padded);
    const v = new DataView(out.buffer);
    v.setUint32(8, out.length, true); v.setUint32(12, padded, true);
    return out;
}

await test("role 'user': index 6 after the stabilizer's roles, its own name and sky-blue hue, step 1 or more like every added role", async () => {
    assert.equal(BLOCK_ROLES.length, 7);
    assert.equal(BLOCK_ROLES[6], "user");
    assert.equal(ROLE_HEX.user, "#0ea5e9");
    assert.equal(ROLE_NODE_NAMES.user, "Your edits");
    const d = descriptorFromBlocks([{ cell: [0, 0, 0] }, { cell: [0, 0, 1], role: "user", step: 2 }]);
    assert.deepEqual(d.cells.slice(8, 10), [6, 2]);
    assert.deepEqual(roleCounts(d), [1, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseAssemblyDescriptor(JSON.parse(JSON.stringify(d))), d);
    assert.equal(parseAssemblyDescriptor({ ...d, cells: [0, 0, 0, 6, 0, 0, 0, 1, 0, 1] }), null, "a user block with step 0 is an original in disguise");
    const glb = readAssemblyGlb(writeAssemblyGlb(d), null);
    assert.ok(glb.ok && glb.edit === null && glb.optimization === null && glb.meta === null, glb.error);
});

await test("GLB logs: an edit log and an optimization log round-trip, each alone, deterministically", async () => {
    const { d, log } = await editFixture();
    const a = writeAssemblyGlb(d, null, log), b = writeAssemblyGlb(d, null, log);
    assert.deepEqual(Buffer.from(a), Buffer.from(b));
    const r = readAssemblyGlb(a, null);
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.descriptor, d);
    assert.deepEqual(r.edit, checkVoxelEditLog(log, null).value);
    assert.equal(r.meta, null); assert.equal(r.optimization, null);
    const o = await optimizeFixture();
    const w = writeAssemblyGlb(o.d, null, null, o.meta);
    const ro = readAssemblyGlb(w, null);
    assert.ok(ro.ok, ro.error);
    assert.deepEqual(ro.optimization, checkOptimizeMeta(o.meta, null).value);
    assert.equal(ro.meta, null); assert.equal(ro.edit, null);
    const stab = await sampleDescriptor();
    const rs = readAssemblyGlb(writeAssemblyGlb(stab, await sampleMeta(stab)), null);
    assert.ok(rs.ok && rs.meta && rs.edit === null && rs.optimization === null, "a stabilization still reads as before");
});

await test("GLB logs: the writer takes at most one log, the reader refuses a file with two or with a log it would not write", async () => {
    const { d, log } = await editFixture();
    const meta = await sampleMeta(d);
    const opt = (await optimizeFixture()).meta;
    assert.throws(() => writeAssemblyGlb(d, meta, log), /one log/);
    assert.throws(() => writeAssemblyGlb(d, null, log, opt), /one log/);
    assert.throws(() => writeAssemblyGlb(d, null, { ...log, assembly_hash: "abc" }), /edit log is invalid/);
    assert.throws(() => writeAssemblyGlb(d, null, null, { ...opt, feasible: false }), /optimization log is invalid/);
    const one = writeAssemblyGlb(d, null, log);
    const two = withJson(one, (doc) => { doc.scenes[0].extras[STABILIZATION_EXTRAS_KEY] = meta; });
    const r = readAssemblyGlb(two, null);
    assert.ok(!r.ok && /more than one log/.test(r.error), r.error);
    const twoOther = withJson(one, (doc) => { doc.scenes[0].extras[OPTIMIZATION_EXTRAS_KEY] = doc.scenes[0].extras[EDIT_EXTRAS_KEY]; });
    assert.ok(!readAssemblyGlb(twoOther, null).ok);
    // The log the key names must be the kind of log the key stands for.
    const swapped = withJson(one, (doc) => { const e = doc.scenes[0].extras; e[OPTIMIZATION_EXTRAS_KEY] = e[EDIT_EXTRAS_KEY]; delete e[EDIT_EXTRAS_KEY]; });
    assert.ok(!readAssemblyGlb(swapped, null).ok);
});

await test("GLB logs: every single-byte change of an edit file and of an optimization file is refused", async () => {
    const { d, log } = await editFixture();
    const o = await optimizeFixture();
    for (const glb of [writeAssemblyGlb(d, null, log), writeAssemblyGlb(o.d, null, null, o.meta)]) {
        let accepted = 0;
        for (let at = 0; at < glb.length; at++) {
            const copy = glb.slice(); copy[at] ^= 0xff;
            if (readAssemblyGlb(copy, null).ok) { accepted++; console.log("       accepted flip at", at); }
        }
        assert.equal(accepted, 0);
    }
});

await test("VoxelEditLog: valid passes, bounds are enforced, the slim EditMeta is built from it", async () => {
    const { log } = await editFixture();
    assert.ok(checkVoxelEditLog(log, null).ok);
    const bad = (f) => { const c = structuredClone(log); f(c); return checkVoxelEditLog(c, null).ok; };
    assert.equal(bad((c) => { c.edits[0].instruction = "x".repeat(501); }), false, "EDIT_INSTRUCTION_MAX is 500");
    assert.equal(bad((c) => { c.edits[0].instruction = "x".repeat(500); }), true);
    assert.equal(bad((c) => { c.edits[0].ops = Array.from({ length: 9 }, () => ({ op: "add", box: [0, 0, 0, 0, 0, 0] })); }), false, "MAX_VOXEL_OPS is 8");
    assert.equal(bad((c) => { c.edits = Array.from({ length: 13 }, (_, i) => ({ ...c.edits[0], n: i + 1 })); }), false, "MAX_VOXEL_EDITS_PER_VERSION is 12");
    assert.equal(bad((c) => { c.depth = 13; }), false);
    assert.equal(bad((c) => { c.stabilized_depth = 4; }), false);
    assert.equal(bad((c) => { c.labels = "....."; c.parts = ["Seat"]; c.labels = ".A..."; }), true);
    assert.equal(bad((c) => { c.labels = ".B..."; }), false, "a label for a part that is not listed");
    assert.equal(bad((c) => { c.labels = "...."; }), false, "one label per block");
    assert.equal(bad((c) => { c.edits[0].ops[0].op = "explode"; }), false);
    assert.equal(bad((c) => { c.edits[0].ops[0].region = "rm -rf"; }), false);
    const slim = summarizeVoxelEdit(checkVoxelEditLog(log, null).value, { depth: 2 });
    assert.equal(slim.target, "voxel"); assert.equal(slim.depth, 2, "the server's own count, not the browser's"); assert.equal(slim.entries.length, 1);
    assert.equal(slim.label, "Make the arm longer and add a leg"); assert.equal(slim.engine, "meta/muse-spark-1.3-contributor");
    assert.equal(slim.changes, null); assert.equal(slim.ops, null); assert.equal(slim.job_id, null);
    assert.deepEqual(readEditMeta(JSON.stringify(slim)), slim, "what the server stores reads back as it was");
    assert.ok(JSON.stringify(slim).length < 8 * 1024);
    assert.equal(labelOfInstruction("  make it TALLER!! "), "Make it TALLER");
    assert.ok(labelOfInstruction("x".repeat(100)).length <= 40);
});

await test("OptimizeMeta: valid passes, the cross-check ties it to the blocks, the slim OptimizeSummary reads back", async () => {
    const o = await optimizeFixture();
    assert.ok(checkOptimizeMeta(o.meta, null).ok);
    const meta = checkOptimizeMeta(o.meta, null).value;
    const stabilizedSource = { kind: "stabilized", assembly_hash: o.meta.source_hash };
    assert.equal(crossCheckOptimized(o.d, meta, stabilizedSource), null);
    const mutated = (f) => { const c = structuredClone(meta); f(c); return c; };
    assert.match(crossCheckOptimized(o.d, meta, { kind: "stabilized", assembly_hash: "f".repeat(64) }), /different model/);
    assert.match(crossCheckOptimized(o.d, meta, { kind: "generated", assembly_hash: null }), /different model/, "a mesh source has no block hash, the log must not claim one");
    assert.equal(crossCheckOptimized(o.d, mutated((c) => { c.source_hash = null; }), { kind: "generated", assembly_hash: null }), null);
    assert.match(crossCheckOptimized(o.d, mutated((c) => { c.removed = [cellCode(0, 0, 0)]; }), stabilizedSource), /removed is in the file/);
    assert.match(crossCheckOptimized(o.source, meta, stabilizedSource), /counts 5 blocks, the file has 6/, "the source's own blocks are not the result");
    assert.equal(checkOptimizeMeta({ ...o.meta, feasible: false }, null).ok, false, "a result that breaks a limit is never saved");
    assert.equal(checkOptimizeMeta({ ...o.meta, goal: "" }, null).ok, false);
    assert.equal(checkOptimizeMeta({ ...o.meta, stabilized_depth: 4 }, null).ok, false);
    assert.equal(checkOptimizeMeta({ ...o.meta, labels: "...." }, null).ok, false);
    assert.equal(checkOptimizeMeta({ ...o.meta, after: optMetrics(7) }, null).ok, false, "before - removed + added is the block count");
    assert.equal(checkOptimizeMeta({ ...o.meta, shape_changed: "no" }, null).ok, false);
    // Added blocks: step and role are tied to the log.
    const added = descriptorFromBlocks([{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1], role: "reinforcement", step: 2 }]);
    const withAdd = { ...o.meta, step: 2, added: 1, added_at: [1], removed: [], removed_at: [], before: optMetrics(2), after: optMetrics(3), labels: "...", source_hash: null, after_summary: summary(3), assembly_hash: await assemblyHash(added) };
    const addMeta = checkOptimizeMeta(withAdd, null);
    assert.ok(addMeta.ok, addMeta.error);
    assert.equal(crossCheckOptimized(added, addMeta.value, { kind: "generated", assembly_hash: null }), null);
    const wrongRole = descriptorFromBlocks([{ cell: [0, 0, 0] }, { cell: [0, 0, 1] }, { cell: [1, 0, 1], role: "column", step: 2 }]);
    assert.match(crossCheckOptimized(wrongRole, addMeta.value, { kind: "generated", assembly_hash: null }), /not a reinforcement/);
    const slim = summarizeOptimize(meta);
    assert.equal(slim.title, "Lightest stable"); assert.equal(slim.goal, "Lightest"); assert.deepEqual(slim.objective, ["blocks"]);
    assert.equal(slim.removed, 1); assert.equal(slim.added, 0); assert.equal(slim.shape_changed, false); assert.equal(slim.stabilized_depth, 1); assert.equal(slim.iterations, 1);
    assert.deepEqual(readOptimizeSummary(JSON.stringify(slim)), slim);
    assert.ok(JSON.stringify(slim).length < 4 * 1024);
    // Whatever spec a hand-made file carries is rebuilt by the same cleaner the page uses.
    const junkSpec = checkOptimizeMeta({ ...o.meta, spec: { objective: [{ metric: "fun", weight: 3 }], moves: { allow: "everything" }, constraints: { max_stress_pct: 5000 } } }, null);
    assert.ok(junkSpec.ok && junkSpec.value.spec.constraints.max_stress_pct === 100 && junkSpec.value.spec.objective[0].metric === "blocks", "junk is clamped, not trusted");
    assert.deepEqual(repairSpec(meta.spec, { partNames: [], blocks: 5 }).spec, meta.spec, "a clean spec is a fixed point of the cleaner");
});

await test("versionMeta: stabilizations on the path and mesh-or-blocks, by kind", async () => {
    const stab = await sampleDescriptor();
    const derived = await sampleMeta(stab);
    assert.equal(stabilizationsOf({ kind: "generated", meta: null }), 0);
    assert.equal(stabilizationsOf({ kind: "example", meta: null }), 0);
    assert.equal(stabilizationsOf({ kind: "stabilized", meta: JSON.stringify({ ...derived, depth: 2 }) }), 2);
    assert.equal(stabilizationsOf({ kind: "stabilized", meta: "not json" }), 3, "unreadable counts as the maximum: it cannot be stabilized again");
    const { log } = await editFixture();
    const editSlim = summarizeVoxelEdit(checkVoxelEditLog({ ...log, stabilized_depth: 2 }, null).value, { depth: 1 });
    assert.equal(stabilizationsOf({ kind: "edited", meta: JSON.stringify(editSlim) }), 2);
    const o = await optimizeFixture();
    const optSlim = summarizeOptimize(checkOptimizeMeta(o.meta, null).value);
    assert.equal(stabilizationsOf({ kind: "optimized", meta: JSON.stringify(optSlim) }), 1);
    assert.equal(representationOf({ kind: "generated", meta: null }), "mesh");
    assert.equal(representationOf({ kind: "example", meta: null }), "mesh");
    assert.equal(representationOf({ kind: "stabilized", meta: null }), "blocks");
    assert.equal(representationOf({ kind: "optimized", meta: null }), "blocks");
    assert.equal(representationOf({ kind: "edited", meta: JSON.stringify(editSlim) }), "blocks");
    for (const target of ["design", "mesh"]) assert.equal(representationOf({ kind: "edited", meta: JSON.stringify({ ...editSlim, target }) }), "mesh", target);
    assert.equal(readEditMeta(JSON.stringify({ ...editSlim, target: "sculpt" })), null);
    assert.equal(readEditMeta(JSON.stringify({ ...editSlim, entries: [] })), null);
    assert.equal(readEditMeta(null), null); assert.equal(readEditMeta(42), null); assert.equal(readEditMeta("{"), null);
    assert.equal(readOptimizeSummary(JSON.stringify({ ...optSlim, stop: "bored" })), null);
    assert.equal(readOptimizeSummary(undefined), null);
    // A mesh edit and a design edit are written by the server; the shapes they use read back too.
    const meshMeta = { ...editSlim, target: "mesh", base_steps: 0, entries: [{ n: 1, instruction: "taller backrest", summary: "Stretched the backrest.", added: 0, removed: 0, moved: 1 }], ops: [{ op: "stretch", label: "backrest" }], notes: ["scaled to 98% to fit the 1000 mm cube"], job_id: "00000000-0000-4000-8000-000000000001" };
    assert.deepEqual(readEditMeta(meshMeta), meshMeta);
    const designMeta = { ...meshMeta, target: "design", ops: null, changes: { added: ["Cup holder"], changed: ["Backrest"], removed: [] } };
    assert.deepEqual(readEditMeta(designMeta), designMeta);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
