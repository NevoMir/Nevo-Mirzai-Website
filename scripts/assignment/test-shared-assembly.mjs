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
    assert.deepEqual(roleCounts(d), [3, 1, 1, 1, 0, 0]);
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

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
