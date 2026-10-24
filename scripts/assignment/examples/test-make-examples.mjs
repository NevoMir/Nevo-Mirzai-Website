// Regression tests for the example tooling and the files it ships:
//
//   node scripts/assignment/examples/test-make-examples.mjs        (about a minute: it runs the builder and verify.mjs on scratch copies)
//
//   - make-examples.mjs never deletes what it did not write (a wrong --out used to lose every entry of the folder), refuses
//     a folder that is not an examples folder, and a folder that is the repository or the home folder, even with --force-clean
//   - a .DS_Store (or any dotfile) in the examples folder does not fail --check or verify.mjs
//   - the shipped manifest/detail.json/GLB logs state no peak stress for a model that still has floating blocks (the desk lamp
//     said "stress 0% -> 52%"), and the blurbs count blocks the way the log does (not "8 columns" for "2 columns (8 blocks)")
//   - verify.mjs notices both of those when they come back
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const SHIPPED = join(REPO, "public/assignment_alex/examples");
const MAKE = join(REPO, "scripts/assignment/make-examples.mjs");
const VERIFY = join(HERE, "verify.mjs");
const { OUTPUT_FILES, hasManifest, looksLikeOutput, planClean, unsafeOut, visibleNames } = await import(pathToFileURL(join(HERE, "lib/outdir.mjs")).href);
const { STRESS_WARN } = await import(pathToFileURL(join(REPO, "src/assignment/analysis/materials.ts")).href);

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failures.push(name); console.log(`  FAIL ${name}\n${String(e?.stack ?? e).replace(/^/gm, "       ")}`); } }

const scratch = await mkdtemp(join(tmpdir(), "examples-test-"));
let counter = 0;
const fresh = async (name) => { const dir = join(scratch, `${name}-${++counter}`); await mkdir(dir, { recursive: true }); return dir; };
const put = async (dir, rel, text = "x") => { await mkdir(dirname(join(dir, rel)), { recursive: true }); await writeFile(join(dir, rel), text); };
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };
const run = (script, args, opts = {}) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], { cwd: REPO, encoding: "utf8", ...opts });
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const copyShipped = async (name) => { const dir = await fresh(name); await cp(SHIPPED, dir, { recursive: true }); return dir; };

try {
    console.log("outdir.mjs");
    await test("planClean prunes earlier output, keeps everything else, ignores dotfiles", async () => {
        const out = await fresh("plan");
        await put(out, "manifest.json");
        await put(out, "oak-tree/original.glb"); // rebuilt
        await put(out, "oak-tree/cover.webp"); // an older build's cover: ours
        await put(out, "oak-tree/notes.txt"); // not ours
        await put(out, "oak-tree/.DS_Store");
        await put(out, "retired/original.glb"); // an example that left the catalogue
        await put(out, "retired/cover.png");
        await put(out, "basis/transcoder.wasm"); // not an example folder
        await put(out, "favicon.svg");
        await put(out, ".DS_Store");
        const plan = await planClean(out, { slugs: ["oak-tree"], produced: new Set(["oak-tree/original.glb"]), fullSet: true });
        assert.deepEqual(plan.prune.sort(), ["oak-tree/cover.webp", "retired"]);
        assert.deepEqual(plan.foreign.sort(), ["basis", "favicon.svg", "oak-tree/notes.txt"]);
        const partial = await planClean(out, { slugs: ["oak-tree"], produced: new Set(["oak-tree/original.glb"]), fullSet: false });
        assert.deepEqual(partial.prune, ["oak-tree/cover.webp"], "a partial build never touches other folders");
    });
    await test("planClean: --originals-only keeps the stabilized files of an earlier run", async () => {
        const out = await fresh("keep");
        await put(out, "oak-tree/stabilized.glb");
        await put(out, "oak-tree/detail.json");
        const keep = (name) => ["stabilized.glb", "detail.json"].includes(name);
        const plan = await planClean(out, { slugs: ["oak-tree"], produced: new Set(), fullSet: true, keep });
        assert.deepEqual(plan, { prune: [], foreign: [] });
    });
    await test("looksLikeOutput / visibleNames / hasManifest", async () => {
        const out = await fresh("look");
        await put(out, "a/original.glb");
        await put(out, "a/.DS_Store");
        await put(out, "b/original.glb");
        await put(out, "b/readme.txt");
        await put(out, "c/sub/original.glb");
        await put(out, ".hidden");
        assert.equal(await looksLikeOutput(join(out, "a")), true);
        assert.equal(await looksLikeOutput(join(out, "b")), false);
        assert.equal(await looksLikeOutput(join(out, "c")), false, "a subfolder is not an example's file");
        assert.equal(await looksLikeOutput(join(out, "missing")), true, "nothing there, nothing to lose");
        assert.deepEqual(await visibleNames(out), ["a", "b", "c"]);
        assert.equal(await hasManifest(out), false);
        await put(out, "manifest.json");
        assert.equal(await hasManifest(out), true);
        assert.deepEqual([...OUTPUT_FILES].sort(), ["cover.png", "detail.json", "original.glb", "stabilized.glb"]);
    });
    await test("unsafeOut: the root, the home folder, the repository and what contains it", () => {
        assert.ok(unsafeOut("/", REPO));
        assert.ok(unsafeOut(process.env.HOME ?? "/Users", REPO));
        assert.ok(unsafeOut(REPO, REPO));
        assert.ok(unsafeOut(dirname(REPO), REPO));
        assert.equal(unsafeOut(join(REPO, "public/assignment_alex/examples"), REPO), null);
        assert.equal(unsafeOut(join(scratch, "x"), REPO), null);
    });

    console.log("make-examples.mjs --out");
    await test("a folder that is not an examples folder is refused: nothing written, nothing deleted", async () => {
        const out = await fresh("foreign");
        await put(out, "unrelated.txt");
        await put(out, "other-dir/file.txt");
        const r = run(MAKE, ["--originals-only", "--out", out]);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stderr, /not an examples folder/);
        assert.match(r.stderr, /unrelated\.txt/);
        assert.equal(await exists(join(out, "unrelated.txt")), true);
        assert.equal(await exists(join(out, "other-dir/file.txt")), true);
        assert.deepEqual(await visibleNames(out), ["other-dir", "unrelated.txt"], "no example folder was written either");
    });
    await test("an examples folder is tidied: earlier output goes, the rest stays and is reported", async () => {
        const out = await fresh("tidy");
        await put(out, "manifest.json", "{}");
        await put(out, "retired/original.glb");
        await put(out, "retired/cover.webp");
        await put(out, "unrelated.txt");
        await put(out, "other-dir/file.txt");
        await put(out, ".DS_Store");
        const r = run(MAKE, ["--originals-only", "--out", out]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(await exists(join(out, "retired")), false, "the retired example's folder is removed");
        assert.equal(await exists(join(out, "unrelated.txt")), true);
        assert.equal(await exists(join(out, "other-dir/file.txt")), true);
        assert.equal(await exists(join(out, ".DS_Store")), true);
        assert.match(r.stderr, /left alone/);
        assert.equal(await exists(join(out, "oak-tree/original.glb")), true);
    });
    await test("--force-clean deletes the rest, and says what first", async () => {
        const out = await fresh("clean");
        await put(out, "unrelated.txt");
        await put(out, "other-dir/file.txt");
        await put(out, ".DS_Store");
        const r = run(MAKE, ["--originals-only", "--force-clean", "--out", out]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /removing from .*unrelated\.txt/);
        assert.equal(await exists(join(out, "unrelated.txt")), false);
        assert.equal(await exists(join(out, "other-dir")), false);
        assert.equal(await exists(join(out, ".DS_Store")), true, "dotfiles are never touched");
    });
    await test("--out . and --out .. are refused, even with --force-clean", async () => {
        for (const target of [".", ".."]) {
            const r = run(MAKE, ["--originals-only", "--force-clean", "--out", target]);
            assert.equal(r.status, 1, `--out ${target}: ${r.stdout.slice(-200)}`);
            assert.match(r.stderr, /Refusing to write the examples/);
        }
        assert.equal(await exists(join(REPO, "src/assignment")), true);
        assert.equal(await exists(join(REPO, "oak-tree")), false);
    });

    console.log("dotfiles and the shipped files");
    const copy = await copyShipped("shipped");
    await put(copy, ".DS_Store", "finder");
    await put(copy, "oak-tree/.DS_Store", "finder");
    await test("--check ignores a .DS_Store at the top and inside an example", () => {
        const r = run(MAKE, ["--check", "--out", copy]);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /--check ok/);
    });
    await test("verify.mjs ignores a .DS_Store, and the shipped files pass it", () => {
        const r = run(VERIFY, ["--dir", copy]);
        assert.equal(r.status, 0, `${r.stderr}\n${r.stdout.slice(-400)}`);
        assert.match(r.stdout, /checks passed/);
    });
    await test("--check still reports a file that really does not belong", async () => {
        await put(copy, "oak-tree/notes.txt");
        const r = run(MAKE, ["--check", "--out", copy]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /oak-tree\/notes\.txt: not produced by the build/);
        await rm(join(copy, "oak-tree/notes.txt"));
    });

    console.log("what the shipped examples say");
    const manifest = await readJson(join(SHIPPED, "manifest.json"));
    const bySlug = (slug) => manifest.examples.find((e) => e.slug === slug);
    const limitOf = (derived) => Math.min(derived.target_utilisation, STRESS_WARN);
    await test("no figure states a peak stress for a model that still has floating blocks, unless it is at the warning level or above", async () => {
        for (const ex of manifest.examples) {
            const derived = (await readJson(join(SHIPPED, ex.slug, "detail.json"))).derived;
            const metrics = [derived.before, derived.after, ex.stabilized.before, ex.stabilized.after, ...derived.steps.flatMap((s) => [s.before, s.after])];
            for (const m of metrics) {
                assert.ok(!(m.floating_blocks > 0 && m.max_utilisation !== null && m.max_utilisation < limitOf(derived)), `${ex.slug}: ${m.max_utilisation} with ${m.floating_blocks} floating`);
            }
        }
    });
    await test("the desk lamp starts with an unknown peak (26 blocks float) and the crane keeps its real 137%", async () => {
        const lamp = bySlug("desk-lamp");
        assert.equal(lamp.original.analysis.floating_blocks, 26);
        assert.equal(lamp.stabilized.before.max_utilisation, null, "was 0, which read as 0% -> 52%");
        assert.equal((await readJson(join(SHIPPED, "desk-lamp/detail.json"))).derived.before.max_utilisation, null);
        const crane = bySlug("harbour-crane");
        assert.ok(crane.stabilized.before.floating_blocks > 0 && crane.stabilized.before.max_utilisation > 1.3, "a peak above the warning level is a true lower bound and stays");
    });
    await test("blurbs count blocks, as the log does", async () => {
        for (const ex of manifest.examples) {
            const added = ex.stabilized.added_blocks;
            assert.ok(!/\b\d+ (columns?|footings?|brackets?|bridges?)\b/.test(ex.blurb), `${ex.slug}: "${ex.blurb}"`);
            assert.ok(added === 0 ? /nothing to stabilize/.test(ex.blurb) : ex.blurb.includes(`adds ${added} block`), `${ex.slug}: "${ex.blurb}"`);
        }
        assert.match(bySlug("mushroom-pavilion").blurb, /adds 8 blocks \(all in columns\)/);
        assert.match(bySlug("cantilever-house").blurb, /adds 3 blocks \(2 in columns, 1 in a bracket\)/);
    });

    console.log("verify.mjs notices it when they come back");
    await test("a stated 0% peak with 26 floating blocks fails verify.mjs", async () => {
        const dir = await copyShipped("regress-peak");
        const file = join(dir, "manifest.json");
        const m = await readJson(file);
        m.examples.find((e) => e.slug === "desk-lamp").stabilized.before.max_utilisation = 0;
        await writeFile(file, `${JSON.stringify(m, null, 2)}\n`);
        const r = run(VERIFY, ["--dir", dir]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /peak stress is stated for a model that still has floating blocks/);
    });
    await test("a blurb that counts columns fails verify.mjs", async () => {
        const dir = await copyShipped("regress-blurb");
        const file = join(dir, "manifest.json");
        const m = await readJson(file);
        const ex = m.examples.find((e) => e.slug === "mushroom-pavilion");
        ex.blurb = ex.blurb.replace("(all in columns)", "(8 columns)");
        await writeFile(file, `${JSON.stringify(m, null, 2)}\n`);
        const r = run(VERIFY, ["--dir", dir]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /the blurb counts blocks/);
    });
} finally {
    await rm(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
