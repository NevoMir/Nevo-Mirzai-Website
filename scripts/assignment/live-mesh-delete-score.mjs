// Scores the live delete cases of the mesh editor against hand-drawn reference regions, so the second-pass decision rule (spec 8.3: turn on
// MESH_REFINE_OPS = ["delete", "mirror_copy"] only if at least 4 of 5 delete cases improve) rests on numbers and not on a look at one picture.
//
//   node scripts/assignment/live-mesh-delete-score.mjs oracle <case> [--out <dir>]     zoomed pictures of the reference selection (to check it by eye)
//   node scripts/assignment/live-mesh-delete-score.mjs score [--out <dir>]            every case: first pass vs zoom pass (needs live-<case>.json / live-<case>-zoom.json
//                                                                                     written by live-edit-mesh.mjs into <dir>)
//
// The model is the local 27.8 MB Hunyuan rocking chair (HUNYUAN_GLB). A case has a CORE (the part the person named: it must go), an OPTIONAL
// region (parts that hang on it and may go with it: the spindles under an armrest) and a KEEP region (what must stay: the seat, the posts, the
// runners, the other armrest). The program's delete ops are replayed with the executor's own rule (a triangle goes when the mean selection weight
// of its vertices is at least 0.5); areas are in mm2 of the original triangles.
//   recall     share of the core area that is gone                (1 = nothing of the part is left)
//   collateral area removed from the keep region / core area     (0 = nothing else was hurt)
//   extra      area removed outside core, optional and keep / core area
//   score      recall - collateral - extra / 2                    (1 is perfect; more than the core taken out is penalised)
// A zoom pass "improves" a case when its score is higher than the first pass's by more than 0.03.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const mode = args[0];
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const OUT = resolve(option("--out") ?? "/private/tmp/claude-501/-Users-josephmirzai-Documents-Nevo-website/f150fdea-65e6-490a-bbdb-a687fe25ab2f/scratchpad/live/mesh");
mkdirSync(OUT, { recursive: true });

const { readMeshGlb } = await import("../../src/assignment/edit/readMeshGlb.ts");
const { buildEditSetup } = await import("../../src/assignment/edit/frame.ts");
const { selectionWeights } = await import("../../src/assignment/edit/selection.ts");
const { toExecutorOp } = await import("../../src/assignment/shared/meshProgram.ts");
const { openSession } = await import("../../src/assignment/edit/session.ts");
const { sharpCodec, readHunyuan, hasHunyuan, HUNYUAN_GLB } = await import("./edit-test-support.mjs");
if (!hasHunyuan()) {
    console.error(`no model at ${HUNYUAN_GLB}`);
    process.exit(2);
}

const box = (min, max) => ({ min, max });
/**
 * The reference regions of the five delete cases on the rocking chair, in the edit frame (mm, Z up, the chair faces -Y, so its LEFT is +X and
 * its back is +Y). Read off the three pictures with their 100 mm grid and checked with `oracle <case>` (the selection drawn red on zoomed views).
 */
export const CASES = {
    "left-arm": {
        text: "remove the left armrest",
        core: [box([195, -245, 515], [350, 135, 605])],
        optional: [box([205, -200, 420], [335, 20, 515])],
        keep: [box([-400, -450, 0], [400, 450, 112]), box([-400, -450, 112], [190, 450, 1100]), box([-400, 140, 112], [400, 450, 1100]), box([190, -450, 112], [400, 450, 420])],
    },
    "right-arm": {
        text: "remove the right armrest",
        core: [box([-350, -245, 515], [-195, 135, 605])],
        optional: [box([-335, -200, 420], [-205, 20, 515])],
        keep: [box([-400, -450, 0], [400, 450, 112]), box([-190, -450, 112], [400, 450, 1100]), box([-400, 140, 112], [400, 450, 1100]), box([-400, -450, 112], [-190, 450, 420])],
    },
    "left-rocker": {
        text: "remove the left rocker, the curved runner on the left side under the legs",
        core: [box([170, -450, -5], [330, 450, 100])],
        optional: [],
        keep: [box([-400, -450, 135], [400, 450, 1100]), box([-330, -450, -5], [-170, 450, 100])],
    },
    "finials": {
        text: "remove the two round knobs on top of the back posts",
        core: [box([-292, 255, 948], [-222, 345, 1100]), box([222, 255, 948], [292, 345, 1100])],
        optional: [],
        keep: [box([-400, -450, 0], [400, 450, 940])],
    },
    "middle-slat": {
        text: "remove the middle slat of the backrest",
        core: [box([-25, 150, 442], [28, 300, 858])],
        optional: [],
        keep: [box([-400, -450, 0], [-34, 450, 1100]), box([37, -450, 0], [400, 450, 1100]), box([-34, -450, 0], [37, 450, 432]), box([-34, -450, 862], [37, 450, 1100])],
    },
};

const read = readMeshGlb(readHunyuan());
if (!read.ok) throw new Error(read.reason);
const { mesh } = buildEditSetup(read.source);
const nt = mesh.idx.length / 3;
const centroid = new Float32Array(nt * 3);
const area = new Float64Array(nt);
for (let t = 0; t < nt; t++) {
    const a = mesh.idx[t * 3] * 3, b = mesh.idx[t * 3 + 1] * 3, c = mesh.idx[t * 3 + 2] * 3;
    for (let q = 0; q < 3; q++) centroid[t * 3 + q] = (mesh.Q[a + q] + mesh.Q[b + q] + mesh.Q[c + q]) / 3;
    const ux = mesh.Q[b] - mesh.Q[a], uy = mesh.Q[b + 1] - mesh.Q[a + 1], uz = mesh.Q[b + 2] - mesh.Q[a + 2];
    const vx = mesh.Q[c] - mesh.Q[a], vy = mesh.Q[c + 1] - mesh.Q[a + 1], vz = mesh.Q[c + 2] - mesh.Q[a + 2];
    area[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
const inAny = (t, boxes) => boxes.some((b) => [0, 1, 2].every((q) => centroid[t * 3 + q] >= b.min[q] && centroid[t * 3 + q] <= b.max[q]));

/** Triangles the delete ops of a (cleaned) program take away, by the executor's rule, on the original mesh. */
function removedBy(program) {
    const dead = new Uint8Array(nt);
    for (const raw of program.ops) {
        if (raw.op !== "delete") continue;
        const op = toExecutorOp(raw);
        const w = selectionWeights(mesh.Q, op.where);
        for (let t = 0; t < nt; t++) if ((w[mesh.idx[t * 3]] + w[mesh.idx[t * 3 + 1]] + w[mesh.idx[t * 3 + 2]]) / 3 >= 0.5) dead[t] = 1;
    }
    return dead;
}
function metrics(dead, c) {
    let core = 0, coreGone = 0, keepHit = 0, extra = 0, optionalGone = 0, all = 0;
    for (let t = 0; t < nt; t++) {
        const inCore = inAny(t, c.core), inKeep = !inCore && inAny(t, c.keep), inOpt = !inCore && !inKeep && inAny(t, c.optional);
        if (inCore) core += area[t];
        if (!dead[t]) continue;
        all += area[t];
        if (inCore) coreGone += area[t];
        else if (inKeep) keepHit += area[t];
        else if (inOpt) optionalGone += area[t];
        else extra += area[t];
    }
    const recall = core > 0 ? coreGone / core : 0, collateral = keepHit / core, ex = extra / core;
    return { core_mm2: Math.round(core), recall, collateral, extra: ex, optional: core > 0 ? optionalGone / core : 0, removed_mm2: Math.round(all), score: recall - collateral - ex / 2 };
}
const fmt = (m) => `recall ${(m.recall * 100).toFixed(0).padStart(3)}%  collateral ${(m.collateral * 100).toFixed(0).padStart(3)}%  extra ${(m.extra * 100).toFixed(0).padStart(3)}%  (optional ${(m.optional * 100).toFixed(0)}%)  score ${m.score.toFixed(2)}`;

if (mode === "oracle") {
    const name = args[1];
    const c = CASES[name];
    if (!c) throw new Error(`cases: ${Object.keys(CASES).join(", ")}`);
    const session = await openSession(readHunyuan(), await sharpCodec(), "a wooden rocking chair");
    const program = { applied: true, summary: "oracle", ops: [{ op: "delete", label: name, boxes: c.core, exclude: [], feather_mm: 1, axis: "x" }] };
    const views = await session.zoom(program, "png");
    for (const v of views) {
        writeFileSync(resolve(OUT, `oracle-${name}-${v.id}.png`), Buffer.from(v.image.split(",")[1], "base64"));
        console.log(`wrote oracle-${name}-${v.id}.png  ${v.caption}`);
    }
    console.log(fmt(metrics(removedBy(program), c)), "(the oracle against itself)");
} else if (mode === "score") {
    const rows = [];
    for (const [name, c] of Object.entries(CASES)) {
        const load = (file) => (existsSync(resolve(OUT, file)) ? JSON.parse(readFileSync(resolve(OUT, file), "utf8")) : null);
        const first = load(`live-${name}.json`), zoom = load(`live-${name}-zoom.json`);
        if (!first) continue;
        const m1 = first.program?.ops?.length ? metrics(removedBy(first.program), c) : null;
        const m2 = zoom?.program?.ops?.length ? metrics(removedBy(zoom.program), c) : null;
        const verdict = !m1 || !m2 ? "n/a" : m2.score - m1.score > 0.03 ? "improved" : m1.score - m2.score > 0.03 ? "worse" : "same";
        rows.push({ name, first: m1, zoom: m2, verdict, first_cost: first.record?.cost, zoom_cost: zoom?.record?.cost });
        console.log(`\n${name}  "${c.text}"`);
        console.log(`  first ${m1 ? fmt(m1) : `no program (${first.cleaned?.error ?? first.answer?.summary ?? "?"})`}`);
        console.log(`  zoom  ${m2 ? fmt(m2) : zoom ? `no program (${zoom.cleaned?.error ?? zoom.answer?.summary ?? "?"})` : "not run"}`);
        console.log(`  -> ${verdict}`);
    }
    const improved = rows.filter((r) => r.verdict === "improved").length;
    console.log(`\n${improved} of ${rows.length} improved, ${rows.filter((r) => r.verdict === "same").length} same, ${rows.filter((r) => r.verdict === "worse").length} worse`);
    writeFileSync(resolve(OUT, "delete-scores.json"), JSON.stringify(rows, null, 1));
} else {
    console.error("usage: live-mesh-delete-score.mjs oracle <case> | score  [--out <dir>]");
    process.exit(2);
}
