// Builds the ready-made example projects offline, with no API key:
//
//   node scripts/assignment/make-examples.mjs                      everything: originals, covers, stabilized versions, manifest
//   node scripts/assignment/make-examples.mjs --originals-only     step 1 only (originals + covers + the analysis table)
//   node scripts/assignment/make-examples.mjs --check              rebuild in memory and fail if the committed files differ
//   options: --only slug,slug   --out dir (default public/assignment_alex/examples)   --sheet file.png (contact sheet of the covers)
//            --stabilizer path (module under the repo)   --allow-incomplete (ship a stabilized version that still has errors)
//            --force (write the files although an original does not show what the catalogue says: for tuning a model)
//            --force-clean (also delete what is in --out and is not an example's file; without it only earlier output is removed)
//
// Step 1  scripts/assignment/examples/models/*.mjs build procedural meshes (three.js geometry, no third-party assets) ->
//         <slug>/original.glb; a software renderer draws <slug>/cover.png (512 x 384, the viewer's light stage and ground grid).
// Step 2  per example, with the app's own engine: voxelise the original GLB exactly as the browser does (GLTFLoader + glbParts
//         + normalise), analyse it (structure + Awatif joint stress), run the stabilizer, write <slug>/stabilized.glb
//         (shared/assemblyGlb.ts: a block assembly with the stabilizer's log inside), <slug>/detail.json ({ derived }),
//         and the line in manifest.json (ExampleSummary per shared/contract.ts).
//
// Deterministic: no clock, no randomness (every timestamp is EXAMPLES_STAMP, the stabilizer's duration is recorded as 0), so
// --check is meaningful. Covers are compared by their pixels, not their compressed bytes (zlib may differ between Node builds).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Node < 22.18 only strips the types of the engine's .ts modules behind a flag: run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CATALOGUE, EXAMPLES_STAMP } from "./examples/catalogue.mjs";
import { buildDocument, glbBytes } from "./examples/lib/glb.mjs";
import { qa } from "./examples/lib/kit.mjs";
import { decodePng, encodePng, glbToTris, render } from "./examples/lib/raster.mjs";
import {
    REPO, analyseAssemblyFull, analyseSoup, assemblyHash, cellsOf, descriptorFromBlocks, getSolver, loadSoupLikeTheApp, normalizeSettings, readAssemblyGlb, writeAssemblyGlb,
} from "./examples/lib/engine.mjs";
import { hasManifest, planClean, unsafeOut, visibleNames } from "./examples/lib/outdir.mjs";
import { DEFAULT_STABILIZE_OPTIONS, loadStabilizer, runStabilizer } from "./examples/lib/stabilizer.mjs";

const { checkAnalysisSummary } = await import(pathToFileURL(resolve(REPO, "src/assignment/shared/analysisSummary.ts")).href);
const { checkDerivedMeta } = await import(pathToFileURL(resolve(REPO, "src/assignment/shared/derivedMeta.ts")).href);
const { APP_BASE, DERIVED_GLB_LIMIT } = await import(pathToFileURL(resolve(REPO, "src/assignment/shared/contract.ts")).href);
const { STRESS_WARN } = await import(pathToFileURL(resolve(REPO, "src/assignment/analysis/materials.ts")).href);

const EXAMPLES_URL = new URL("./examples/", import.meta.url);
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
if (has("--help") || has("-h")) {
    console.log(readFileHeader());
    process.exit(0);
}
const OUT = resolve(REPO, flag("--out", "public/assignment_alex/examples"));
const ONLY = (flag("--only", "") ?? "").split(",").filter(Boolean);
const ORIGINALS_ONLY = has("--originals-only");
const CHECK = has("--check");
const FORCE_CLEAN = has("--force-clean");
const SHEET = flag("--sheet");

/** A refusal is an answer, not a crash: one line on stderr, exit 1, nothing written. */
function refuse(message) {
    console.error(message);
    process.exit(1);
}
// Before anything is built: some folders are never an output folder (a typo such as --out . or --out ~).
const unsafe = CHECK ? null : unsafeOut(OUT, REPO);
if (unsafe) refuse(`Refusing to write the examples into ${OUT}: ${unsafe}. Check --out. Nothing was written.`);

// Limits the brief (and the Worker) set for the shipped files.
const MAX_ORIGINAL_BYTES = 250 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const COVER = { width: 512, height: 384 };

const SETTINGS = normalizeSettings({}); // the defaults a visitor starts with
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const round = (v, digits = 3) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function readFileHeader() {
    return "Usage: node scripts/assignment/make-examples.mjs [--originals-only] [--check] [--only slug,slug] [--out dir] [--sheet file.png] [--stabilizer path] [--allow-incomplete] [--force] [--force-clean]";
}

// ---------- step 1: the original and its cover ----------

async function originalBytes(entry) {
    if (entry.fixture) return new Uint8Array(await readFile(resolve(REPO, entry.fixture)));
    const mod = await import(new URL(entry.module, EXAMPLES_URL).href);
    const parts = mod.build();
    const open = qa(parts);
    if (open.length > 0) throw new Error(`${entry.slug}: not a closed, outward-wound shell (the voxeliser needs one):\n  ${open.join("\n  ")}`);
    return glbBytes(buildDocument({ name: entry.title, parts, extras: { example: entry.slug } }));
}

async function coverImage(entry, bytes) {
    const image = render(await glbToTris(bytes), { ...COVER, ...entry.view });
    return { image, png: encodePng(image) };
}

/** AnalysisSummary in its canonical form, with the fixed stamp. */
function summaryOf(result) {
    const checked = checkAnalysisSummary({ ...result.summary, analyzed_at: EXAMPLES_STAMP }, null);
    if (!checked.ok) throw new Error(`analysis summary rejected by the shared validator: ${checked.error}`);
    return checked.value;
}

const kindsOf = (result, severity) => [...new Set(result.issues.filter((i) => i.severity === severity).map((i) => i.kind))].sort();
const peakOf = (result) => result.stress?.maxUtilisation ?? null;

function measureRow(entry, bytes, result, partNames) {
    const s = result.summary;
    return {
        slug: entry.slug,
        kb: bytes.byteLength / 1024,
        parts: partNames.length,
        blocks: s.blocks,
        floating: s.floating_blocks,
        longest: s.longest_cantilever,
        over: s.over_limit,
        margin: s.cog_margin_mm,
        errors: s.errors,
        warnings: s.warnings,
        peak: shownPeak(s.floating_blocks, peakOf(result)),
        errorKinds: kindsOf(result, "error"),
        warningKinds: kindsOf(result, "warning"),
    };
}

/** What is wrong with an original that does not show what the catalogue says it must (empty when it is fine). */
function problemsWith(entry, row) {
    const problems = [];
    if (row.kb * 1024 >= MAX_ORIGINAL_BYTES) problems.push(`original.glb is ${row.kb.toFixed(0)} KB (limit ${MAX_ORIGINAL_BYTES / 1024} KB)`);
    if (entry.control) {
        if (row.errors > 0 || row.warnings > 0) problems.push(`control example has ${row.errors} errors and ${row.warnings} warnings (${[...row.errorKinds, ...row.warningKinds].join(", ")})`);
    } else {
        if (row.errors + row.warnings === 0) problems.push("has no problem for the stabilizer to fix");
        const want = entry.expect;
        if (want?.errors && JSON.stringify(want.errors) !== JSON.stringify([...row.errorKinds])) problems.push(`error kinds are [${row.errorKinds}], expected [${want.errors}]`);
        if (want?.warnings && JSON.stringify(want.warnings) !== JSON.stringify([...row.warningKinds])) problems.push(`warning kinds are [${row.warningKinds}], expected [${want.warnings}]`);
    }
    return problems.map((p) => `${entry.slug}: ${p}`);
}

// ---------- step 2: the stabilized version ----------

// The counts in meta.added_by_role are BLOCKS per role, not pieces: the log says "a 2-block column" or "2 columns (8 blocks)",
// so the blurb counts blocks too ("2 in columns") and never says how many columns, brackets... there are.
const ROLE_IN = { column: ["in a column", "in columns"], footing: ["in a footing", "in footings"], bracket: ["in a bracket", "in brackets"], bridge: ["in a bridge", "in bridges"], reinforcement: ["as reinforcement", "as reinforcement"] };
const ROLE_ORDER = ["column", "footing", "bracket", "bridge", "reinforcement"];

function fixSentence(entry, meta, complete) {
    if (meta.added_blocks === 0) return "It passes every check as it is, so there is nothing to stabilize.";
    const used = ROLE_ORDER.filter((r) => meta.added_by_role[r]);
    const where = (r, n) => ROLE_IN[r][n === 1 ? 0 : 1];
    const split = used.length === 1 ? `all ${where(used[0], meta.added_blocks)}` : used.map((r) => `${meta.added_by_role[r]} ${where(r, meta.added_by_role[r])}`).join(", ");
    return `Stabilizing adds ${plural(meta.added_blocks, "block")} (${split}) and ${complete ? "it then passes every check" : "improves it"}.`;
}

// A peak that only the grounded part of a model has is not the model's peak. Blocks with no load path to the ground are not
// solved, so the figure of a lamp with 26 of 44 blocks floating is 0 % and "0 % -> 52 %" would read as the fix making it
// worse. Below the warning level the peak is therefore unknown (null) while anything floats; above it, it is a true lower
// bound and stays. The stabilizer's own metrics do the same (stabilize/measure.ts); this keeps the shipped files right
// whichever version of it built them.
const PEAK_LIMIT = Math.min(DEFAULT_STABILIZE_OPTIONS.targetUtilisation, STRESS_WARN);
const shownPeak = (floatingBlocks, peak, limit = PEAK_LIMIT) => (peak !== null && floatingBlocks > 0 && peak < limit ? null : peak);
const knownPeak = (m, limit) => (m.max_utilisation !== shownPeak(m.floating_blocks, m.max_utilisation, limit) ? { ...m, max_utilisation: null } : m);
const withKnownPeaks = (meta) => {
    const limit = Math.min(meta.target_utilisation, STRESS_WARN);
    return {
        ...meta,
        before: knownPeak(meta.before, limit),
        after: knownPeak(meta.after, limit),
        steps: meta.steps.map((step) => ({ ...step, before: knownPeak(step.before, limit), after: knownPeak(step.after, limit) })),
    };
};

async function stabilizeExample(entry, original, stabilize, solver) {
    const cells = cellsOf(original.result);
    // `stamp` fixes the two clock values in the log, so the stabilizer's own GLB is reproducible too.
    const started = performance.now();
    const run = await runStabilizer(stabilize, { cells, settings: SETTINGS, solver, sourceDepth: 0, options: { stamp: { createdAt: EXAMPLES_STAMP, durationMs: 0 } } });
    const ms = performance.now() - started; // shown in the table only: the files carry duration_ms 0
    const { descriptor } = run;

    // The log, made reproducible whatever the stabilizer did: a fixed stamp and no wall-clock duration. The validator rebuilds it in its canonical form.
    const stamped = { ...run.meta, duration_ms: 0, created_at: EXAMPLES_STAMP, after_summary: { ...run.meta.after_summary, analyzed_at: EXAMPLES_STAMP } };
    const settled = withKnownPeaks(stamped);
    const checked = checkDerivedMeta(settled, null);
    if (!checked.ok) throw new Error(`${entry.slug}: the stabilizer's log is invalid: ${checked.error}`);
    const meta = checked.value;
    if (meta.assembly_hash !== (await assemblyHash(descriptor))) throw new Error(`${entry.slug}: the log's assembly_hash is not the hash of the blocks`);

    // Additive: every analysed block is still there, as an original.
    const have = new Map();
    for (let n = 0; n < descriptor.cells.length; n += 5) have.set(`${descriptor.cells[n]},${descriptor.cells[n + 1]},${descriptor.cells[n + 2]}`, descriptor.cells[n + 3]);
    for (const c of cells) if (have.get(c.join()) !== 0) throw new Error(`${entry.slug}: original block (${c}) was removed or re-labelled`);

    const glb = writeAssemblyGlb(descriptor, meta);
    // Only worth a note when nothing was settled here: the stamped log is what the stabilizer wrote, apart from the fixed stamp.
    if (run.glb && JSON.stringify(settled) === JSON.stringify(stamped) && sha(run.glb) !== sha(glb)) console.warn(`note: ${entry.slug}: the stabilizer's own GLB differs from the one written here (the one written here is used)`);
    if (glb.byteLength > DERIVED_GLB_LIMIT) throw new Error(`${entry.slug}: stabilized.glb is ${glb.byteLength} bytes (limit ${DERIVED_GLB_LIMIT})`);
    const back = readAssemblyGlb(glb, null);
    if (!back.ok || back.blocks !== descriptor.cells.length / 5) throw new Error(`${entry.slug}: stabilized.glb does not read back (${back.ok ? "block count" : back.error})`);

    // The log's "after" must be what a fresh analysis of the final blocks says.
    const fresh = await analyseAssemblyFull(descriptor, SETTINGS);
    const stated = meta.after;
    const freshPeak = shownPeak(fresh.summary.floating_blocks, fresh.stress?.maxUtilisation ?? null, Math.min(meta.target_utilisation, STRESS_WARN));
    const same = fresh.summary.errors === stated.errors && fresh.summary.warnings === stated.warnings && fresh.blocks.length === stated.blocks
        && (freshPeak === null ? stated.max_utilisation === null : Math.abs(freshPeak - (stated.max_utilisation ?? -1)) < 1e-3);
    if (!same) throw new Error(`${entry.slug}: the log says ${JSON.stringify(stated)} but a fresh analysis finds ${fresh.summary.errors} errors, ${fresh.summary.warnings} warnings, ${fresh.blocks.length} blocks, peak ${freshPeak}`);

    const complete = fresh.summary.errors === 0 && fresh.summary.warnings === 0;
    if (!has("--allow-incomplete")) {
        if (entry.control && meta.added_blocks !== 0) throw new Error(`${entry.slug}: a control example must need no blocks, the stabilizer added ${meta.added_blocks}`);
        if (!complete) throw new Error(`${entry.slug}: the stabilized version still has ${fresh.summary.errors} errors and ${fresh.summary.warnings} warnings (stop: ${meta.stop})`);
    }
    return { descriptor, meta, glb, fresh, complete, ms, afterSummary: summaryOf(fresh) };
}

// ---------- build ----------

async function buildExample(entry, stabilize, solver) {
    const files = new Map();
    const bytes = await originalBytes(entry);
    files.set(`${entry.slug}/original.glb`, bytes);
    const cover = await coverImage(entry, bytes);
    files.set(`${entry.slug}/cover.png`, cover.png);

    const { soup, partNames } = await loadSoupLikeTheApp(bytes);
    const result = await analyseSoup(soup, SETTINGS);
    const row = measureRow(entry, bytes, result, partNames);
    row.coverKb = cover.png.byteLength / 1024;
    const problems = problemsWith(entry, row);

    let manifestEntry = null;
    if (!ORIGINALS_ONLY) {
        const st = await stabilizeExample(entry, { result }, stabilize, solver);
        const detail = new TextEncoder().encode(`${JSON.stringify({ derived: st.meta })}\n`);
        files.set(`${entry.slug}/stabilized.glb`, st.glb);
        files.set(`${entry.slug}/detail.json`, detail);
        row.stabilized = { blocks: st.meta.after.blocks, added: st.meta.added_blocks, errors: st.meta.after.errors, warnings: st.meta.after.warnings, peak: st.meta.after.max_utilisation, steps: st.meta.steps.length, kb: st.glb.byteLength / 1024, stop: st.meta.stop, roles: st.meta.added_by_role, ms: st.ms };
        const blurb = `${entry.problem} ${fixSentence(entry, st.meta, st.complete)}`;
        if (blurb.length > 300) throw new Error(`${entry.slug}: blurb is ${blurb.length} characters (limit 300)`);
        if (entry.prompt.length > 200 || entry.title.length > 80) throw new Error(`${entry.slug}: title or prompt too long`);
        const version = createHash("sha256").update(bytes).update(st.glb).update(detail).update(cover.image.rgb).digest("hex").slice(0, 8);
        manifestEntry = {
            slug: entry.slug,
            title: entry.title,
            prompt: entry.prompt,
            blurb,
            tags: entry.tags,
            cover_url: `${APP_BASE}/examples/${entry.slug}/cover.png`,
            original: { size_bytes: bytes.byteLength, part_count: partNames.length, analysis: summaryOf(result) },
            stabilized: { size_bytes: st.glb.byteLength, analysis: st.afterSummary, added_blocks: st.meta.added_blocks, before: st.meta.before, after: st.meta.after },
            version,
        };
    }
    return { files, row, manifestEntry, cover: cover.image, problems };
}

// ---------- output: write, or compare with what is committed ----------

const isPng = (path) => path.endsWith(".png");

async function differences(outputs, builtSlugs, fullSet) {
    const diffs = [];
    for (const [rel, content] of outputs) {
        let disk;
        try { disk = new Uint8Array(await readFile(resolve(OUT, rel))); } catch { diffs.push(`${rel}: missing`); continue; }
        if (isPng(rel)) {
            const a = decodePng(disk), b = decodePng(content);
            if (!a || !b || a.width !== b.width || a.height !== b.height || sha(a.rgb) !== sha(b.rgb)) diffs.push(`${rel}: pixels differ`);
        } else if (sha(disk) !== sha(content)) diffs.push(`${rel}: bytes differ (${disk.byteLength} on disk, ${content.byteLength} rebuilt)`);
    }
    // Files that no longer belong: in a slug folder that was rebuilt, or (full set) a whole folder / manifest that is not in the catalogue.
    // Hidden names (.DS_Store, which Finder writes as soon as someone looks at the folder) are not part of the output.
    for (const slug of builtSlugs) {
        for (const name of await visibleNames(resolve(OUT, slug))) if (!outputs.has(`${slug}/${name}`) && !(ORIGINALS_ONLY && ["stabilized.glb", "detail.json"].includes(name))) diffs.push(`${slug}/${name}: not produced by the build`);
    }
    if (fullSet) {
        for (const name of await visibleNames(OUT)) if (name !== "manifest.json" && !builtSlugs.includes(name)) diffs.push(`${name}: not in the catalogue`);
    }
    return diffs;
}

async function writeOutputs(outputs, builtSlugs, fullSet) {
    // Only earlier output is ever removed: a typo in --out must not cost anyone a folder. Everything else is left where it is.
    const { prune, foreign } = await planClean(OUT, {
        slugs: builtSlugs,
        produced: new Set(outputs.keys()),
        fullSet,
        keep: (name) => ORIGINALS_ONLY && ["stabilized.glb", "detail.json"].includes(name), // --originals-only keeps the stabilized files of an earlier full run
    });
    // A full build writes manifest.json: into a folder that has none and holds other things, that is almost surely the wrong --out.
    if (fullSet && foreign.length > 0 && !FORCE_CLEAN && !(await hasManifest(OUT))) {
        refuse(`Refusing to write the examples into ${OUT}: it is not an examples folder (no manifest.json) and it holds ${foreign.slice(0, 6).join(", ")}${foreign.length > 6 ? ", ..." : ""}. Nothing was written and nothing was deleted. Check --out, or pass --force-clean to delete those entries.`);
    }
    if (foreign.length > 0 && !FORCE_CLEAN) console.warn(`left alone (not files of an example): ${foreign.join(", ")}\n  (--force-clean deletes them; --check reports them)`);
    const doomed = FORCE_CLEAN ? [...prune, ...foreign] : prune;
    if (doomed.length > 0) console.log(`removing from ${OUT}: ${doomed.join(", ")}`);
    await mkdir(OUT, { recursive: true });
    for (const rel of doomed) await rm(resolve(OUT, rel), { recursive: true, force: true });
    for (const [rel, content] of outputs) {
        await mkdir(dirname(resolve(OUT, rel)), { recursive: true });
        await writeFile(resolve(OUT, rel), content);
    }
}

// ---------- main ----------

const entries = CATALOGUE.filter((e) => ONLY.length === 0 || ONLY.includes(e.slug));
if (entries.length === 0) throw new Error(`--only matches nothing; the examples are: ${CATALOGUE.map((e) => e.slug).join(", ")}`);
const fullSet = ONLY.length === 0;

const solver = await getSolver();
if (solver.backend !== "wasm") console.warn("note: Awatif's WASM solver did not load here; the TypeScript solver (identical maths) is used.");
let stabilize = null;
if (!ORIGINALS_ONLY) stabilize = await loadStabilizer(flag("--stabilizer") ?? undefined);

const outputs = new Map();
const rows = [];
const manifestEntries = [];
const covers = [];
const problems = [];
const t0 = performance.now();
for (const entry of entries) {
    const built = await buildExample(entry, stabilize, solver);
    for (const [rel, content] of built.files) outputs.set(rel, content);
    rows.push(built.row);
    covers.push(built.cover);
    problems.push(...built.problems);
    if (built.manifestEntry) manifestEntries.push(built.manifestEntry);
}
if (!ORIGINALS_ONLY && fullSet) {
    if (manifestEntries.length > 24) throw new Error("the manifest holds at most 24 examples");
    outputs.set("manifest.json", new TextEncoder().encode(`${JSON.stringify({ examples: manifestEntries }, null, 2)}\n`));
}

// ---- the table ----
const pad = (v, n) => String(v).padStart(n);
console.log(`\n${"example".padEnd(18)} ${pad("KB", 4)} ${pad("parts", 5)} ${pad("blocks", 6)} ${pad("float", 5)} ${pad("reach", 5)} ${pad("over", 4)} ${pad("cog mm", 7)} ${pad("err", 3)} ${pad("warn", 4)} ${pad("peak", 5)}  issues`);
for (const r of rows) {
    console.log(`${r.slug.padEnd(18)} ${pad(r.kb.toFixed(0), 4)} ${pad(r.parts, 5)} ${pad(r.blocks, 6)} ${pad(r.floating, 5)} ${pad(r.longest, 5)} ${pad(r.over, 4)} ${pad(Math.round(r.margin), 7)} ${pad(r.errors, 3)} ${pad(r.warnings, 4)} ${pad(r.peak === null ? "-" : `${Math.round(r.peak * 100)}%`, 5)}  ${[...r.errorKinds.map((k) => `E:${k}`), ...r.warningKinds.map((k) => `W:${k}`)].join(" ") || "passes"}`);
}
if (!ORIGINALS_ONLY) {
    console.log(`\n${"stabilized".padEnd(18)} ${pad("KB", 4)} ${pad("blocks", 6)} ${pad("added", 5)} ${pad("steps", 5)} ${pad("err", 3)} ${pad("warn", 4)} ${pad("peak", 5)} ${pad("ms", 5)}  stop / roles`);
    for (const r of rows) {
        const s = r.stabilized;
        console.log(`${r.slug.padEnd(18)} ${pad(s.kb.toFixed(0), 4)} ${pad(s.blocks, 6)} ${pad(s.added, 5)} ${pad(s.steps, 5)} ${pad(s.errors, 3)} ${pad(s.warnings, 4)} ${pad(s.peak === null ? "-" : `${Math.round(s.peak * 100)}%`, 5)} ${pad(Math.round(s.ms), 5)}  ${s.stop} ${JSON.stringify(s.roles)}`);
    }
    console.log(`\n${"files (KB)".padEnd(18)} ${pad("orig", 5)} ${pad("stab", 5)} ${pad("cover", 5)} ${pad("detail", 6)} ${pad("total", 6)}`);
    for (const r of rows) {
        const detailKb = outputs.get(`${r.slug}/detail.json`).byteLength / 1024;
        console.log(`${r.slug.padEnd(18)} ${pad(r.kb.toFixed(0), 5)} ${pad(r.stabilized.kb.toFixed(0), 5)} ${pad(r.coverKb.toFixed(0), 5)} ${pad(detailKb.toFixed(1), 6)} ${pad((r.kb + r.stabilized.kb + r.coverKb + detailKb).toFixed(0), 6)}`);
    }
}
let total = 0;
const bySize = [];
for (const [rel, content] of outputs) { total += content.byteLength; bySize.push([rel, content.byteLength]); }
console.log(`\n${outputs.size} files, ${(total / 1024).toFixed(0)} KB in total${ORIGINALS_ONLY ? " (originals and covers only)" : ""}  [${((performance.now() - t0) / 1000).toFixed(1)} s]`);
if (fullSet && !ORIGINALS_ONLY && total > MAX_TOTAL_BYTES) throw new Error(`the examples add up to ${(total / 1024 / 1024).toFixed(2)} MB (limit ${MAX_TOTAL_BYTES / 1024 / 1024} MB)`);

if (SHEET) {
    const cols = Math.min(5, covers.length), rowsN = Math.ceil(covers.length / cols), { width, height } = COVER;
    const sheet = new Uint8Array(cols * width * rowsN * height * 3).fill(255);
    covers.forEach((c, n) => { const x0 = (n % cols) * width, y0 = Math.floor(n / cols) * height; for (let y = 0; y < height; y++) sheet.set(c.rgb.subarray(y * width * 3, (y + 1) * width * 3), ((y0 + y) * cols * width + x0) * 3); });
    await writeFile(resolve(SHEET), encodePng({ width: cols * width, height: rowsN * height, rgb: sheet }));
    console.log(`contact sheet: ${resolve(SHEET)}`);
}

const builtSlugs = entries.map((e) => e.slug);
if (problems.length > 0) {
    console.error(`\n${problems.length > 1 ? "Problems" : "Problem"} with the examples:\n  ${problems.join("\n  ")}`);
    if (!has("--force")) process.exit(1);
}
if (CHECK) {
    const diffs = await differences(outputs, builtSlugs, fullSet);
    if (diffs.length > 0) {
        console.error(`\n--check FAILED: ${plural(diffs.length, "file")} differ from a rebuild:\n  ${diffs.join("\n  ")}\nRun node scripts/assignment/make-examples.mjs to refresh them.`);
        process.exit(1);
    }
    console.log(`--check ok: ${outputs.size} files match a rebuild`);
} else {
    await writeOutputs(outputs, builtSlugs, fullSet);
    console.log(`written to ${OUT}`);
}
