// Acceptance check for the shipped examples, made only from the files on disk (never from the builder's memory):
//
//   node scripts/assignment/examples/verify.mjs [--dir public/assignment_alex/examples]
//
// 1. The Worker's own listExamples() (worker/examples.ts: parseExample, cover rules and all) is run against a stand-in
//    for env.ASSETS that serves the folder, and must return every example of the catalogue, in its order, unchanged.
// 2. Per example the four files are read back: sizes match the manifest, cover.png is a 512 x 384 PNG of at most 256 KB,
//    stabilized.glb passes readAssemblyGlb + checkDerivedMeta, detail.json holds the same log as the GLB, and the hash is
//    the hash of the blocks.
// 3. The numbers are measured again with the app's engine: the original (GLB -> voxels exactly as the browser does) and the
//    stabilized blocks must show what the manifest says; stabilized versions have no error or warning and a peak stress at
//    or under the target (75 %), originals keep their problems, controls get no block, no original block is removed.
// 4. Stabilizing again with the TypeScript solver picks the same blocks as Awatif's WASM (the example files do not depend on
//    which one a machine has), and stabilizing the stabilized model adds nothing.
// 5. The whole folder is under 3 MB.
// 6. What the examples say is honest: no peak stress is stated for a model that still has floating blocks unless it is at or over
//    the warning level (below it the figure covers only the grounded part: "0 % -> 52 %" would read as the fix making it worse),
//    and a blurb counts blocks, never "columns" or "brackets", which the log counts differently.
// Names starting with "." (.DS_Store) are ignored everywhere.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CATALOGUE } from "./catalogue.mjs";
import { REPO, analyseAssemblyFull, analyseSoup, assemblyHash, cellsOf, loadSoupLikeTheApp, normalizeSettings, readAssemblyGlb, getSolver } from "./lib/engine.mjs";
import { visibleNames } from "./lib/outdir.mjs";
import { DEFAULT_STABILIZE_OPTIONS, loadStabilizer, runStabilizer } from "./lib/stabilizer.mjs";

const load = (rel) => import(pathToFileURL(resolve(REPO, rel)).href);
const { checkDerivedMeta, readDerivedMeta } = await load("src/assignment/shared/derivedMeta.ts");
const { APP_BASE } = await load("src/assignment/shared/contract.ts");
const { listExamples } = await load("worker/examples.ts");
const { sniffImageType, imageSize } = await load("worker/util.ts");
const { solveFrameTs } = await load("src/assignment/analysis/fem/tsSolver.ts");
const { STRESS_WARN } = await load("src/assignment/analysis/materials.ts");

const args = process.argv.slice(2);
const dirIx = args.indexOf("--dir");
const DIR = resolve(REPO, dirIx >= 0 ? args[dirIx + 1] : "public/assignment_alex/examples");
const TARGET = DEFAULT_STABILIZE_OPTIONS.targetUtilisation;
const PEAK_LIMIT = Math.min(TARGET, STRESS_WARN);
const SETTINGS = normalizeSettings({});

let failures = 0;
let checks = 0;
const ok = (cond, what) => {
    checks++;
    if (!cond) {
        failures++;
        console.error(`FAIL  ${what}`);
    }
    return cond;
};
const read = async (rel) => new Uint8Array(await readFile(resolve(DIR, rel)));
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// ---- 1. the Worker's own parser, against the folder ----
const env = {
    ASSETS: {
        async fetch(request) {
            const path = new URL(request.url).pathname;
            const rel = path.replace(`${APP_BASE}/examples/`, "");
            try {
                const bytes = await read(rel);
                const type = rel.endsWith(".json") ? "application/json" : rel.endsWith(".png") ? "image/png" : "application/octet-stream";
                return new Response(bytes, { status: 200, headers: { "content-type": type } });
            } catch {
                return new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }); // the SPA fallback
            }
        },
    },
};
const listed = (await listExamples(env)).examples;
ok(listed.length === CATALOGUE.length, `listExamples returned ${listed.length} examples, the catalogue has ${CATALOGUE.length}`);
ok(listed.map((e) => e.slug).join() === CATALOGUE.map((e) => e.slug).join(), "listExamples keeps the catalogue order");
const raw = JSON.parse(new TextDecoder().decode(await read("manifest.json")));
ok(raw.examples.length === listed.length, `manifest has ${raw.examples.length} entries, ${listed.length} survive parseExample (none may be dropped)`);
for (const ex of listed) {
    const entry = raw.examples.find((e) => e.slug === ex.slug);
    ok(entry && canon(entry) === canon(ex), `${ex.slug}: parseExample keeps the manifest entry unchanged`);
}

// ---- 2 + 3 + 4 ----
const solver = await getSolver();
console.log(`solver backend: ${solver.backend}`);
const stabilize = await loadStabilizer();
const rows = [];
let total = 0;
for (const name of await visibleNames(DIR)) if (name !== "manifest.json") ok(CATALOGUE.some((e) => e.slug === name), `${name}: a folder that is not in the catalogue`);
total += (await read("manifest.json")).byteLength;

for (const entry of CATALOGUE) {
    const slug = entry.slug;
    const ex = listed.find((e) => e.slug === slug);
    if (!ok(ex, `${slug}: listed`)) continue;
    const files = await visibleNames(resolve(DIR, slug));
    ok(files.join() === "cover.png,detail.json,original.glb,stabilized.glb", `${slug}: files are [${files}]`);
    const [orig, stab, cover, detailBytes] = await Promise.all(["original.glb", "stabilized.glb", "cover.png", "detail.json"].map((f) => read(`${slug}/${f}`)));
    total += orig.byteLength + stab.byteLength + cover.byteLength + detailBytes.byteLength;

    // sizes + cover
    ok(ex.original.size_bytes === orig.byteLength, `${slug}: original size_bytes`);
    ok(ex.stabilized.size_bytes === stab.byteLength, `${slug}: stabilized size_bytes`);
    ok(orig.byteLength < 250 * 1024 && stab.byteLength < 1024 * 1024, `${slug}: file sizes in range`);
    ok(cover.byteLength <= 256 * 1024 && sniffImageType(cover) === "image/png", `${slug}: cover is a PNG of at most 256 KB`);
    const size = imageSize(cover, "image/png");
    ok(size && size.width === 512 && size.height === 384, `${slug}: cover is 512 x 384 (${size?.width} x ${size?.height})`);
    ok(ex.cover_url === `${APP_BASE}/examples/${slug}/cover.png`, `${slug}: cover_url`);

    // the stabilized GLB and the log
    const back = readAssemblyGlb(stab, null);
    if (!ok(back.ok && back.meta, `${slug}: readAssemblyGlb(stabilized.glb): ${back.ok ? "" : back.error}`)) continue;
    const meta = back.meta;
    const detail = JSON.parse(new TextDecoder().decode(detailBytes));
    const checked = checkDerivedMeta(detail.derived, null);
    ok(checked.ok, `${slug}: detail.json derived passes checkDerivedMeta${checked.ok ? "" : `: ${checked.error}`}`);
    ok(readDerivedMeta(detail.derived) !== null, `${slug}: detail.json is what POST /projects/from-example reads (readDerivedMeta)`);
    ok(canon(detail.derived) === canon(meta), `${slug}: detail.json derived equals the log inside stabilized.glb`);
    ok(meta.assembly_hash === (await assemblyHash(back.descriptor)), `${slug}: assembly_hash is the hash of the blocks`);
    ok(back.blocks === meta.after.blocks, `${slug}: ${back.blocks} blocks in the file, the log says ${meta.after.blocks}`);
    ok(ex.stabilized.added_blocks === meta.added_blocks && canon(ex.stabilized.after) === canon(meta.after) && canon(ex.stabilized.before) === canon(meta.before), `${slug}: manifest numbers equal the log`);
    ok(meta.duration_ms === 0 && meta.created_at.startsWith("2026-10-24T09:00:00"), `${slug}: log carries the fixed stamp`);

    // honest figures: a peak is stated only when the whole model carries load or the grounded part already shows trouble
    const unknownPeak = (m) => m.floating_blocks > 0 && m.max_utilisation !== null && m.max_utilisation < PEAK_LIMIT;
    const logged = [["before", meta.before], ["after", meta.after], ...meta.steps.flatMap((st) => [[`step ${st.n} before`, st.before], [`step ${st.n} after`, st.after]]), ["manifest before", ex.stabilized.before], ["manifest after", ex.stabilized.after]];
    const misleading = logged.filter(([, m]) => unknownPeak(m)).map(([where, m]) => `${where}: ${Math.round(m.max_utilisation * 100)} % with ${m.floating_blocks} blocks floating`);
    ok(misleading.length === 0, `${slug}: peak stress is stated for a model that still has floating blocks (${misleading.join("; ")})`);
    const added = meta.added_blocks;
    ok(added === 0 ? /nothing to stabilize/.test(ex.blurb) : ex.blurb.includes(`adds ${added} block${added === 1 ? "" : "s"}`), `${slug}: the blurb states the ${added} added blocks`);
    ok(!/\b\d+ (columns?|footings?|brackets?|bridges?)\b/.test(ex.blurb), `${slug}: the blurb counts blocks, not columns, footings, brackets or bridges ("${ex.blurb}")`);

    // originals, measured again
    const { soup, partNames } = await loadSoupLikeTheApp(orig);
    const result = await analyseSoup(soup, SETTINGS);
    const s = result.summary;
    ok(ex.original.part_count === partNames.length, `${slug}: part_count`);
    ok(s.blocks === ex.original.analysis.blocks && s.errors === ex.original.analysis.errors && s.warnings === ex.original.analysis.warnings, `${slug}: original analysis equals the manifest`);
    const peakOrig = result.stress?.maxUtilisation ?? null;
    ok(peakOrig === null ? ex.original.analysis.stress === null || ex.original.analysis.stress === undefined || ex.original.analysis.stress.max_utilisation === null : Math.abs(peakOrig - ex.original.analysis.stress.max_utilisation) < 1e-3, `${slug}: original stress equals the manifest`);
    const startPeak = unknownPeak({ floating_blocks: s.floating_blocks, max_utilisation: peakOrig }) ? null : peakOrig;
    ok(startPeak === null ? meta.before.max_utilisation === null : meta.before.max_utilisation !== null && Math.abs(meta.before.max_utilisation - startPeak) < 1e-3, `${slug}: the log's starting peak (${meta.before.max_utilisation}) is what a fresh analysis of the original finds (${startPeak})`);
    if (entry.control) ok(s.errors === 0 && s.warnings === 0 && meta.added_blocks === 0, `${slug}: control passes untouched (${s.errors} errors, ${s.warnings} warnings, +${meta.added_blocks})`);
    else ok(s.errors + s.warnings > 0 && meta.added_blocks > 0, `${slug}: original keeps its problems (${s.errors} errors, ${s.warnings} warnings) and the stabilizer adds blocks (+${meta.added_blocks})`);

    // the stabilized blocks, measured again from the file
    const fresh = await analyseAssemblyFull(back.descriptor, SETTINGS);
    const peak = fresh.stress?.maxUtilisation ?? null;
    ok(fresh.summary.errors === 0 && fresh.summary.warnings === 0, `${slug}: stabilized has ${fresh.summary.errors} errors and ${fresh.summary.warnings} warnings`);
    ok(peak === null || peak <= TARGET + 1e-9, `${slug}: stabilized peak stress ${peak === null ? "-" : `${(peak * 100).toFixed(1)} %`} (target ${TARGET * 100} %)`);
    ok(fresh.summary.floating_blocks === 0 && fresh.summary.over_limit === 0 && fresh.summary.cog_inside, `${slug}: nothing floating, nothing over the limit, centre of gravity inside`);
    ok(peak === null ? meta.after.max_utilisation === null : Math.abs(peak - (meta.after.max_utilisation ?? -1)) < 1e-3, `${slug}: a fresh analysis finds the peak the log states`);
    ok(ex.stabilized.analysis.errors === 0 && ex.stabilized.analysis.warnings === 0, `${slug}: manifest stabilized analysis is clean`);

    // additive: every analysed block is still there, as an original (role 0), at step 0
    const cells = cellsOf(result);
    const have = new Map();
    const d = back.descriptor.cells;
    for (let n = 0; n < d.length; n += 5) have.set(`${d[n]},${d[n + 1]},${d[n + 2]}`, [d[n + 3], d[n + 4]]);
    ok(cells.every((c) => { const h = have.get(c.join()); return h && h[0] === 0 && h[1] === 0; }), `${slug}: all ${cells.length} original blocks are kept, unchanged`);
    ok(have.size === cells.length + meta.added_blocks, `${slug}: ${have.size} blocks = ${cells.length} original + ${meta.added_blocks} added`);

    // determinism across solvers, and a fixed point
    const opts = { stamp: { createdAt: meta.created_at, durationMs: 0 } };
    const hashWith = async (handle) => (await runStabilizer(stabilize, { cells, settings: SETTINGS, solver: handle, sourceDepth: 0, options: opts })).meta.assembly_hash;
    const hTs = await hashWith({ solve: solveFrameTs, backend: "ts" });
    ok(hTs === meta.assembly_hash, `${slug}: the TypeScript solver picks the same blocks as the WASM one`);
    if (!entry.control) {
        const second = await runStabilizer(stabilize, { cells: cellsOf(fresh), settings: SETTINGS, solver, sourceDepth: 1, options: { ...opts }, assembly: back.descriptor });
        ok(second.meta.added_blocks === 0, `${slug}: stabilizing the stabilized model adds ${second.meta.added_blocks} blocks`);
    }

    rows.push({ slug, orig: `${s.blocks}b ${s.errors}E ${s.warnings}W ${startPeak === null ? "-" : `${Math.round(startPeak * 100)}%`}`, stab: `${fresh.blocks.length}b +${meta.added_blocks} ${fresh.summary.errors}E ${fresh.summary.warnings}W ${peak === null ? "-" : `${Math.round(peak * 100)}%`}` });
}
ok(total < 3 * 1024 * 1024, `folder is ${(total / 1024).toFixed(0)} KB (limit 3072 KB)`);

for (const r of rows) console.log(`${r.slug.padEnd(18)} original ${r.orig.padEnd(20)} stabilized ${r.stab}`);
console.log(`\n${checks - failures}/${checks} checks passed; ${(total / 1024).toFixed(0)} KB in ${CATALOGUE.length} examples`);
process.exit(failures === 0 ? 0 : 1);
