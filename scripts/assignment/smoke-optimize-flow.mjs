// The Optimization tab's save, end to end against `wrangler dev` (MOCK_PROVIDER=1): the real optimizer runs here on a bundled example, and the file it
// writes is uploaded the way the page's "Keep this version" does (POST /models/:id/derived), so the server's checks (worker/derived.ts with
// shared/optimizeMeta.ts) meet a real log, not a hand-made one.
//
//   npx wrangler dev --port 8740 --local          # migrations 0001 to 0006 applied first
//   BASE=http://127.0.0.1:8740 node scripts/assignment/smoke-optimize-flow.mjs
//
// Covers: a block version (the example's stabilized twin) optimized and kept (201, kind optimized, provider optimizer, the summary the page shows);
// the same result twice is the same model (200); the log is checked against the blocks and the source (a log made from another model, a bit flipped
// in a count, a log kept on the wrong kind of source are 400s); an optimization of an original mesh records no source hash and is kept on the mesh;
// a version made from the optimized one (chains); deleting a version takes its subtree with it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const L = await import("./optimize-lib.mjs");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8740").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const GLB = { "content-type": "model/gltf-binary" };
const SLUG = process.env.SLUG ?? "cantilever-house";

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
    if (ok) { passed++; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`); }
}
async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        if (typeof body === "string" || body instanceof Uint8Array) init.body = body;
        else { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    }
    const res = await fetch(`${API}${path}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

const solver = await L.getSolver();
const settings = L.settingsMod.normalizeSettings({});
const detail = (r) => `${r.status} ${r.text.slice(0, 160)}`;

console.log("\n== a project from an example");
const made = await call("POST", "/projects/from-example", { slug: SLUG });
check("201 with the original and its stabilized twin", made.status === 201 && made.json?.project?.models?.length === 2, detail(made));
const [orig, twin] = made.json.project.models;
const project = made.json.project;

console.log("\n== optimize the twin (a block version) and keep it");
const twinGlb = new Uint8Array(await (await fetch(`${BASE}${twin.glb_url}`)).arrayBuffer());
const read = L.glb.readAssemblyGlb(twinGlb);
check("the twin's file is readable", read.ok, read.error);
const ctx = L.OA.specContextOf(read.descriptor, settings, solver, {});
const spec = L.SL.presetSpec("lightest", ctx.start);
const input = (descriptor, over = {}) => ({ assembly: descriptor, settings, spec, goal: "Lightest", source: "blocks", parts: {}, stabilizedDepth: twin.derived?.depth ?? 1, ...over });
const run = await L.OA.optimizeAssembly(input(read.descriptor), { solver });
check("the optimizer made it lighter and feasible", run.meta.feasible && run.meta.after.blocks < run.meta.before.blocks, `${run.meta.before.blocks} -> ${run.meta.after.blocks}`);
check("the log's source is the twin's hash", run.meta.source_hash === twin.assembly_hash || twin.assembly_hash === undefined || run.meta.source_hash === (await L.asm.assemblyHash(read.descriptor)));
const up = await call("POST", `/models/${twin.id}/derived`, run.glb, GLB);
check("POST /models/:id/derived: 201 with a model", up.status === 201 && up.json?.model, detail(up));
const kept = up.json?.model;
check("kind optimized, made by the optimizer, from the twin", kept?.kind === "optimized" && kept.provider === "optimizer" && kept.source_model_id === twin.id && kept.project_id === project.id, JSON.stringify(kept)?.slice(0, 200));
check("the summary the page shows", kept?.optimization?.title === "Lightest stable" && kept.optimization.goal === "Lightest" && kept.optimization.removed === run.meta.removed.length && kept.optimization.after.blocks === run.meta.after.blocks && kept.optimization.shape_changed === false && kept.optimization.stabilized_depth === (twin.derived?.depth ?? 1), JSON.stringify(kept?.optimization)?.slice(0, 200));
check("the analysis is the log's own", kept?.analysis?.blocks === run.meta.after.blocks && kept.analysis.errors === 0);
check("its stabilization count is the source's (an optimization is not one)", kept?.derived === null && kept?.edit === null);
const stored = await fetch(`${API}/files/models/${kept.id}.glb`);
const storedBytes = new Uint8Array(await stored.arrayBuffer());
check("the stored file is the one uploaded", stored.status === 200 && Buffer.compare(Buffer.from(storedBytes), Buffer.from(run.glb)) === 0);
const reRead = L.glb.readAssemblyGlb(storedBytes);
check("and it still carries its log", reRead.ok && reRead.optimization?.assembly_hash === run.meta.assembly_hash && reRead.meta === null && reRead.edit === null);

console.log("\n== the same result twice is the same model");
const again = await call("POST", `/models/${twin.id}/derived`, run.glb, GLB);
check("200 with the same model", again.status === 200 && again.json?.model?.id === kept.id, detail(again));
const listed = await call("GET", `/projects/${project.id}`);
const rows = listed.json?.project?.models ?? [];
check("the project lists one optimized version", rows.filter((m) => m.kind === "optimized").length === 1 && rows.length === 3, `${rows.length} models`);

console.log("\n== the server checks the log against the blocks and the source");
const other = await call("POST", `/models/${orig.id}/derived`, run.glb, GLB);
check("a log made from blocks, kept on the original mesh: 400", other.status === 400, detail(other));
const wrongSource = await L.OA.optimizeAssembly(input(read.descriptor, { stabilizedDepth: 0 }), { solver });
const depth = await call("POST", `/models/${twin.id}/derived`, wrongSource.glb, GLB);
check("a log with another stabilization count than its source: 400", depth.status === 400, detail(depth));
// a flipped count: the writer refuses it, so the file is built by hand from the real one with the log text changed
const tampered = (() => {
    const bytes = new Uint8Array(run.glb);
    const text = new TextDecoder().decode(bytes);
    const at = text.indexOf(`"removed_at"`);
    if (at < 0) return null;
    // change "added":0 to "added":1 (same length): the counts no longer add up
    const edit = text.replace('"added":0', '"added":1');
    return edit === text ? null : new TextEncoder().encode(edit);
})();
if (tampered) {
    const t = await call("POST", `/models/${twin.id}/derived`, tampered, GLB);
    check("a log whose counts do not add up: 400", t.status === 400, detail(t));
} else console.log("  note this result added blocks; the counts test is skipped");
check("a body that is not a GLB: 400", (await call("POST", `/models/${twin.id}/derived`, new Uint8Array([1, 2, 3]), GLB)).status === 400);
check("the wrong content type: 400 or 415", [400, 415].includes((await call("POST", `/models/${twin.id}/derived`, run.glb, { "content-type": "application/json" })).status));

console.log("\n== a version of the optimized version, and of the original mesh");
const keptGlb = L.glb.readAssemblyGlb(storedBytes);
const ctx2 = L.OA.specContextOf(keptGlb.descriptor, settings, solver, {});
const second = await L.OA.optimizeAssembly(input(keptGlb.descriptor, { spec: L.SL.presetSpec("most-stable", ctx2.start), goal: "Best balanced", stabilizedDepth: kept.optimization.stabilized_depth }), { solver });
const chained = await call("POST", `/models/${kept.id}/derived`, second.glb, GLB);
check("an optimization of the optimized version is accepted", chained.status === 201 && chained.json?.model?.source_model_id === kept.id, detail(chained));
// the original mesh's own blocks (role original), optimized as a mesh source: no source hash. The pyramid's original stands by itself.
const pyramid = (await call("POST", "/projects/from-example", { slug: "step-pyramid" })).json?.project;
const pyrRead = L.loadStabilized("step-pyramid");
const plainCells = [];
for (let n = 0; n < pyrRead.descriptor.cells.length; n += 5) if (pyrRead.descriptor.cells[n + 3] === 0) plainCells.push({ cell: pyrRead.descriptor.cells.slice(n, n + 3) });
const plain = L.asm.descriptorFromBlocks(plainCells);
const meshRun = await L.OA.optimizeAssembly(input(plain, { source: "mesh", stabilizedDepth: 0, spec: L.SL.presetSpec("lightest", L.OA.specContextOf(plain, settings, solver, {}).start) }), { solver });
check("the original's own blocks are optimized as a mesh source", meshRun.meta.source_hash === null && meshRun.meta.stabilized_depth === 0 && meshRun.meta.feasible && meshRun.changed, `${meshRun.meta.stop} ${meshRun.meta.before.blocks} -> ${meshRun.meta.after.blocks}`);
{
    const m = await call("POST", `/models/${pyramid.models[0].id}/derived`, meshRun.glb, GLB);
    check("kept on the original mesh: 201, depth 0, no source hash", m.status === 201 && m.json?.model?.optimization?.stabilized_depth === 0 && m.json.model.source_model_id === pyramid.models[0].id, detail(m));
    const wrong = await call("POST", `/models/${twin.id}/derived`, meshRun.glb, GLB);
    check("a log with no source hash kept on a block version: 400", wrong.status === 400, detail(wrong));
}
await call("DELETE", `/projects/${pyramid.id}`);

console.log("\n== deleting a version takes the versions made from it");
const del = await call("DELETE", `/models/${kept.id}`);
check("DELETE: ok", del.status === 200 && del.json?.ok === true, detail(del));
const after = (await call("GET", `/projects/${project.id}`)).json?.project?.models ?? [];
check("it and the version made from it are gone, the rest stays", !after.some((m) => m.id === kept.id || m.id === chained.json?.model?.id) && after.some((m) => m.id === twin.id) && after.some((m) => m.id === orig.id), after.map((m) => m.kind).join());
check("its file is gone too", (await fetch(`${API}/files/models/${kept.id}.glb`)).status === 404);
check("the original cannot be deleted", (await call("DELETE", `/models/${orig.id}`)).status === 409);
await call("DELETE", `/projects/${project.id}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
