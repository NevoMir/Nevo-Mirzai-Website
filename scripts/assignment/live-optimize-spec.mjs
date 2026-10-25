// A LIVE check of POST /llm/optimize-spec against OpenRouter (Muse Spark): a few real goals through the Worker's own handler (worker/optimizeSpec.ts),
// with the key read from .dev.vars (never printed) and a fake counter in place of D1. Costs about $0.0005 a call; the design allows 4.
//   node scripts/assignment/live-optimize-spec.mjs [goal number ...]        (default: all the goals; goal 5 needs HUNYUAN)
//   BASE=http://127.0.0.1:8761   sends the requests to a running `wrangler dev` that has the key (the real route, guards and counter) instead of
//                                calling the handler in this process
//   HUNYUAN=<path to a Hunyuan GLB>  adds goal 5: a model with no named parts (a single text-to-3D mesh), asked to keep parts it does not have
// Checks what the design left untested: the `actionable` field (a goal that is not about weight, strength, balance or sag must come back false with
// notes; a lightening goal true), a model with no named parts, and that the model's own sentences use the panel's words.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const L = await import("./optimize-lib.mjs");
const { handleOptimizeSpec } = await import("../../worker/optimizeSpec.ts");

const dev = readFileSync(`${L.ROOT}/.dev.vars`, "utf8");
const key = /^OPENROUTER_API_KEY=(.*)$/m.exec(dev)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!key && !process.env.BASE) throw new Error("no OPENROUTER_API_KEY in .dev.vars");
const BASE = process.env.BASE?.replace(/\/$/, "");
const usage = { llm: 0 };
const env = {
    OPENROUTER_API_KEY: key,
    ALLOW_OPEN_GENERATION: "1", // as wrangler.jsonc sets it: a real key with no access code and no opt-out is closed
    DB: {
        prepare: (sql) => ({
            bind: (...a) => ({
                first: async () => (/INSERT INTO usage/.test(sql) ? (usage.llm < a[1] ? { llm: ++usage.llm } : null) : null),
                run: async () => { usage.llm = Math.max(0, usage.llm - 1); return {}; },
            }),
        }),
    },
};

const GOALS = [
    { id: 1, slug: "pencil-leg-chair", parts: true, goal: "Paint it red and make it look like a sports car." },
    { id: 2, slug: "pencil-leg-chair", parts: true, goal: "Make it as light as possible but keep the seat and the backrest untouched." },
    { id: 3, slug: "mushroom-pavilion", parts: false, goal: "Make it 30% lighter but keep it symmetric." },
    { id: 4, slug: "cantilever-house", parts: false, goal: "As stable as possible, I can spare 20 extra blocks." },
];
if (process.env.HUNYUAN) GOALS.push({ id: 5, slug: null, parts: false, goal: "Make it as light as possible but keep the seat and the backrest untouched." });

/** The context of a single text-to-3D mesh (no named parts): voxelised as the app does, the blocks as they come (the original, not stabilized). */
async function ctxForMesh(file) {
    const { NodeIO } = await import("@gltf-transform/core");
    const { runAnalysis } = await import("../../src/assignment/analysis/runAnalysis.ts");
    const doc = await new NodeIO().read(file);
    const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const node = doc.getRoot().listNodes()[0];
    const [x, y, z, w] = node.getRotation();
    const s = node.getScale(), t = node.getTranslation();
    const R = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    const pos = prim.getAttribute("POSITION").getArray();
    const idx = prim.getIndices().getArray();
    const P = new Float32Array(pos.length);
    for (let i = 0; i < pos.length / 3; i++) {
        const px = pos[i * 3] * s[0], py = pos[i * 3 + 1] * s[1], pz = pos[i * 3 + 2] * s[2];
        const gx = R[0] * px + R[1] * py + R[2] * pz + t[0], gy = R[3] * px + R[4] * py + R[5] * pz + t[1], gz = R[6] * px + R[7] * py + R[8] * pz + t[2];
        P[i * 3] = gx; P[i * 3 + 1] = -gz; P[i * 3 + 2] = gy; // glTF Y-up -> Z-up
    }
    const soup = new Float32Array(idx.length * 3);
    for (let n = 0; n < idx.length; n++) soup.set(P.subarray(idx[n] * 3, idx[n] * 3 + 3), n * 3);
    const settings = L.settingsMod.normalizeSettings({});
    const result = await runAnalysis(() => ({ positions: soup }), settings, { cacheKey: "live:optimize-single-mesh" });
    const occ = new Uint8Array(1000), role = new Uint8Array(1000);
    for (const b of result.blocks) occ[(b.cell[2] * 10 + b.cell[1]) * 10 + b.cell[0]] = 1;
    const solver = await L.getSolver();
    const ev = L.EVAL.createEvaluator({ solve: solver.solve, blockSizeMm: 100, material: L.mats.materialOf(settings.material).fem, cantileverLimit: settings.cantileverLimit });
    const start = L.EVAL.metricsOf(ev.geometry(occ), ev.field(occ));
    return { ctx: { occ, role, parts: {}, cantileverLimit: settings.cantileverLimit, start } };
}

const want = process.argv.slice(2).map(Number);
let total = 0;
for (const g of GOALS) {
    if (want.length && !want.includes(g.id)) continue;
    const { ctx } = g.slug ? await L.ctxFor(g.slug, g.parts) : await ctxForMesh(process.env.HUNYUAN);
    const brief = L.SPEC.briefOf(ctx);
    const t0 = performance.now();
    try {
        const body = JSON.stringify({ goal: g.goal, brief });
        let res;
        if (BASE) {
            const r = await fetch(`${BASE}/api/assignment_alex/llm/optimize-spec`, { method: "POST", headers: { "content-type": "application/json" }, body });
            res = await r.json().catch(() => null);
            if (r.status !== 200) throw Object.assign(new Error(JSON.stringify(res)?.slice(0, 200)), { status: r.status });
        } else {
            res = await handleOptimizeSpec(env, new Request("https://x.test/llm/optimize-spec", { method: "POST", headers: { "content-type": "application/json" }, body }));
        }
        total += res.cost_usd ?? 0;
        const s = res.spec;
        console.log(`\n#${g.id} ${g.slug ?? "single mesh"} (${brief.parts.length} parts, ${brief.blocks} blocks) "${g.goal}"  ${((performance.now() - t0) / 1000).toFixed(1)} s, $${res.cost_usd}, ${res.model}`);
        console.log(`  actionable=${s.actionable} title="${s.title}" summary="${s.summary}"`);
        console.log(`  aim=${s.objective.map((t) => `${t.metric}:${t.weight}`).join(",")} moves=${s.moves.allow}/${s.moves.removable} protected=${JSON.stringify(s.protected)} stop=${s.stop.reduce_blocks_by_pct} sym=${s.constraints.symmetry} added<=${s.constraints.max_added_blocks}`);
        console.log(`  notes=${JSON.stringify(s.notes)} changes=${JSON.stringify(res.changes)}`);
    } catch (e) {
        console.log(`\n#${g.id} FAILED ${e.status ?? ""} ${e.message}`);
    }
}
console.log(`\ntotal cost $${total.toFixed(5)}`);
