// Checks the BUILT optimizer worker (not the sources): the worker a Vite build emits for analysis/optimize/optimize.worker.ts must be a classic script that
// names the solver's WebAssembly file, must really load it when it is started like a browser starts a worker, and must answer the page's messages:
// events in order, a result with the file inside, and a Stop that gives back the best state.
//   npx vite build --outDir <dir> --emptyOutDir && node scripts/assignment/test-optimize-worker-build.mjs <dir>
//
// The same bare `vm` scope as test-worker-build.mjs (no `process`, no `require`; `fetch` serves the build with Cloudflare's content types). What this cannot
// prove is a real browser engine; it proves the emitted code, the asset URL and the loader's browser path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(dir, "assets"))) {
    console.error("usage: node scripts/assignment/test-optimize-worker-build.mjs <vite build output directory>");
    process.exit(2);
}
const L = await import("./optimize-lib.mjs");
const assets = readdirSync(join(dir, "assets"));
let passed = 0;
const failures = [];
async function test(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (error) { failures.push(name); console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`); }
}

const workerFile = assets.find((f) => /^optimize\.worker-.*\.js$/.test(f));
const wasmFiles = assets.filter((f) => /^lSolver-.*\.wasm$/.test(f));
const lazyChunks = ["OptimizePanel", "runOptimize", "optimizeAssembly"].map((name) => assets.find((f) => f.startsWith(`${name}-`) && f.endsWith(".js")));

await test("the build emits the optimizer worker, one lSolver wasm, and the panel and the runner as chunks of their own", () => {
    assert.ok(workerFile, "assets/optimize.worker-*.js");
    assert.equal(wasmFiles.length, 1, wasmFiles.join(","));
    assert.ok(lazyChunks.every(Boolean), `chunks ${lazyChunks.join(", ")}`);
});
const code = readFileSync(join(dir, "assets", workerFile ?? ""), "utf8");

await test("the worker names the emitted wasm (absolute asset path against the worker's own location) and has no import.meta or Node import", () => {
    assert.ok(code.includes(`new URL("/assets/${wasmFiles[0]}",self.location.href)`), "no new URL(<asset>, self.location.href) in the worker");
    assert.ok(!/\bimport\.meta\b/.test(code), "an import.meta is left in the classic worker script");
    assert.ok(!/from\s*["']node:/.test(code) && !/require\(["']node:/.test(code), "a Node import is left in the worker");
});

await test("the main bundle does not carry the optimizer: the entry chunks stay free of the optimizer's engine", () => {
    const entry = assets.filter((f) => /^index-.*\.js$/.test(f)).map((f) => readFileSync(join(dir, "assets", f), "utf8"));
    for (const text of entry) assert.ok(!text.includes("BESO") && !text.includes("optimization_spec"), "optimizer code in an entry chunk");
});

/** A worker scope in a vm. */
function startWorker(serve) {
    const posted = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        URL, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout, queueMicrotask, WebAssembly, Response, AbortController,
        crypto: globalThis.crypto,
        location: { href: `http://localhost:4173/assets/${workerFile}` },
        WorkerGlobalScope: class WorkerGlobalScope {},
        postMessage: (message) => posted.push(message),
        fetch: async (url) => {
            const path = decodeURIComponent(new URL(String(url), "http://localhost:4173/").pathname);
            const served = serve(path);
            if (!served) return new Response("not found", { status: 404 });
            return new Response(served.bytes, { status: 200, headers: { "content-type": path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
        },
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: workerFile });
    assert.equal(typeof sandbox.onmessage, "function", "the worker did not install onmessage");
    const send = (message) => sandbox.onmessage({ data: vm.runInContext(`(${JSON.stringify(message)})`, sandbox) });
    return {
        posted,
        send,
        async until(cond, ms = 30000) {
            const t0 = Date.now();
            while (!cond()) {
                if (Date.now() - t0 > ms) throw new Error("the worker never answered");
                await new Promise((r) => setTimeout(r, 15));
            }
        },
    };
}
const serveBuild = (path) => {
    const file = join(dir, path);
    return file.startsWith(dir) && existsSync(file) ? { bytes: readFileSync(file) } : null;
};

const settings = L.settingsMod.normalizeSettings({});
const solver = await L.getSolver();
const house = L.loadStabilized("cantilever-house");
const ctx = L.OA.specContextOf(house.descriptor, settings, solver, {});
const input = { assembly: house.descriptor, settings, spec: L.SL.presetSpec("lightest", ctx.start), goal: "Lightest", source: "blocks", parts: {}, stabilizedDepth: 1 };
const wasmUrl = `/assets/${wasmFiles[0]}`;

await test("the built worker loads the WebAssembly solver the way a browser does and optimizes with it", async () => {
    const w = startWorker(serveBuild);
    w.send({ kind: "optimize", id: 1, input, wasmUrl });
    await w.until(() => w.posted.some((m) => m.kind === "done" || m.kind === "error"));
    const done = w.posted.find((m) => m.kind === "done");
    assert.ok(done, JSON.stringify(w.posted.find((m) => m.kind === "error")));
    assert.equal(w.posted[0].event.kind, "start", "the first message is the start");
    assert.equal(done.result.meta.solver, "awatif-wasm", "the TypeScript fallback answered: the WASM did not load in the worker scope");
    assert.equal(done.result.result.stop, "converged");
    assert.ok(done.result.meta.feasible && done.result.meta.after.blocks < done.result.meta.before.blocks && done.result.meta.after.errors === 0);
    assert.ok(Math.abs(done.result.meta.after.blocks - 119) <= 3, `${done.result.meta.after.blocks} blocks`);
    const iterations = w.posted.filter((m) => m.kind === "event" && m.event.kind === "iteration").map((m) => m.event.record.iteration);
    assert.ok(iterations.length > 3 && iterations.every((n, i) => i === 0 || n > iterations[i - 1]), "iterations in order");
    // the file inside is the one the server will accept
    const read = L.glb.readAssemblyGlb(new Uint8Array(done.result.glb));
    assert.ok(read.ok && read.optimization, "the result carries its log");
    assert.equal(L.MC.crossCheckOptimized(read.descriptor, read.optimization, { kind: "stabilized", assembly_hash: await L.asm.assemblyHash(house.descriptor) }), null);
});

await test("a wasm that cannot be fetched falls back to the TypeScript solver with the same blocks", async () => {
    const w = startWorker((path) => (path.endsWith(".wasm") ? null : serveBuild(path)));
    w.send({ kind: "optimize", id: 2, input, wasmUrl });
    await w.until(() => w.posted.some((m) => m.kind === "done" || m.kind === "error"));
    const done = w.posted.find((m) => m.kind === "done");
    assert.ok(done, JSON.stringify(w.posted.find((m) => m.kind === "error")));
    assert.equal(done.result.meta.solver, "awatif-ts");
    assert.ok(Math.abs(done.result.meta.after.blocks - 119) <= 3);
});

await test("Stop gives back the best state within half a second", async () => {
    const mushroom = L.loadStabilized("mushroom-pavilion");
    const big = { ...input, assembly: mushroom.descriptor, spec: L.SL.presetSpec("lightest", L.OA.specContextOf(mushroom.descriptor, settings, solver, {}).start), stabilizedDepth: 0 };
    const w = startWorker(serveBuild);
    w.send({ kind: "optimize", id: 3, input: big, wasmUrl });
    await w.until(() => w.posted.filter((m) => m.kind === "event" && m.event.kind === "iteration").length >= 3);
    const t0 = Date.now();
    w.send({ kind: "cancel", id: 3 });
    await w.until(() => w.posted.some((m) => m.kind === "done" || m.kind === "error"), 5000);
    const answeredAfter = Date.now() - t0;
    const done = w.posted.find((m) => m.kind === "done");
    assert.ok(done, JSON.stringify(w.posted.find((m) => m.kind === "error")));
    assert.equal(done.result.result.stop, "canceled");
    assert.ok(done.result.meta.feasible && done.result.meta.after.blocks < done.result.meta.before.blocks);
    assert.ok(answeredAfter < 500, `${answeredAfter} ms`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
