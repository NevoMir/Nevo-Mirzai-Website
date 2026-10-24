// Checks a BUILT site (not the sources): the analysis worker a Vite build emits must reference the solver's WebAssembly
// file correctly, and must really load and run it when it is started like a browser starts a worker.
//   npx vite build --outDir <dir> --emptyOutDir && node scripts/assignment/test-worker-build.mjs <dir>
//
// The worker bundle is run in a bare `vm` context that looks like a dedicated worker scope: no `process`, no `require`,
// `self`/`location`/`fetch`/`WebAssembly`, and a `WorkerGlobalScope` so the emscripten loader takes its web-worker path
// (it fetches the .wasm through `fetch` + `instantiateStreaming`, exactly as in a browser). `fetch` serves the files of
// the build directory with the content types Cloudflare gives them. What this cannot prove is a real browser engine; it
// proves the emitted code, the asset URL and the loader's browser path.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(dir, "assets"))) {
    console.error("usage: node scripts/assignment/test-worker-build.mjs <vite build output directory>");
    process.exit(2);
}
const assets = readdirSync(join(dir, "assets"));
let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL ${name}\n${String(error?.stack ?? error).replace(/^/gm, "       ")}`);
    }
}

const workerFile = assets.find((f) => /^analysis\.worker-.*\.js$/.test(f));
const wasmFiles = assets.filter((f) => /^lSolver-.*\.wasm$/.test(f));

await test("the build emits the analysis worker and exactly one lSolver wasm, 252487 bytes (the patched binary)", () => {
    assert.ok(workerFile, "assets/analysis.worker-*.js");
    assert.equal(wasmFiles.length, 1, wasmFiles.join(","));
    assert.equal(readFileSync(join(dir, "assets", wasmFiles[0])).length, 252487);
});
const code = readFileSync(join(dir, "assets", workerFile ?? ""), "utf8");

await test("the worker names the emitted file (absolute asset path against the worker's own location)", () => {
    assert.ok(code.includes(`new URL("/assets/${wasmFiles[0]}",self.location.href)`), "no new URL(<asset>, self.location.href) in the worker");
    assert.ok(!/\bimport\.meta\b/.test(code), "an import.meta is left in the classic worker script");
    assert.ok(!/from\s*["']node:/.test(code) && !/require\(["']node:/.test(code), "a Node import is left in the worker");
});

/** A worker scope in a vm. `serve(path)` returns [status, bytes] or null. */
function startWorker(serve, { quiet = false } = {}) {
    const posted = [];
    const sandbox = {
        console: quiet ? { log() {}, warn() {}, error() {}, info() {}, debug() {} } : console,
        URL,
        TextDecoder,
        TextEncoder,
        performance,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        WebAssembly,
        Response,
        AbortController,
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
    return {
        posted,
        /** Sends a request (built inside the context, as a structured clone would) and waits for its result. */
        async run(request) {
            const from = posted.length;
            sandbox.onmessage({ data: vm.runInContext(`(${JSON.stringify(request)})`, sandbox) });
            for (let n = 0; n < 400; n++) {
                const done = posted.slice(from).find((m) => m.kind === "result" || m.kind === "error");
                if (done) return { done, messages: posted.slice(from) };
                await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error("the worker never answered");
        },
    };
}

const serveBuild = (path) => {
    const file = join(dir, path);
    return file.startsWith(dir) && existsSync(file) ? { bytes: readFileSync(file) } : null;
};

// A shelf with a 6-block arm on a column: the stress is the closed-form number (see test-stress-assembly.mjs).
const cells = [];
const add = (i, j, k) => cells.push([i, j, k]);
for (let k = 0; k < 6; k++) add(0, 0, k);
for (let i = 1; i <= 6; i++) add(i, 0, 5);
cells.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
const assembly = { version: 1, blockSizeMm: 100, grid: [10, 10, 10], inset: 0.96, cells: cells.flatMap(([i, j, k]) => [i, j, k, 0, 0]) };
const request = (id, extra = {}) => ({
    kind: "run",
    id,
    gridKey: null,
    positions: null,
    assembly,
    soupBounds: null,
    settings: { targetSizeMm: 1000, blockSizeMm: 100, fillThreshold: 0.1, cantileverLimit: 4, maxBlocks: null, material: "timber" },
    ...extra,
});

await test("the built worker loads the WebAssembly solver the way a browser does and solves with it", async () => {
    const worker = startWorker(serveBuild);
    const { done, messages } = await worker.run(request(1));
    assert.equal(done.kind, "result", done.message);
    const stress = done.result.stress;
    assert.ok(stress, "no stress in the result");
    assert.equal(stress.solver.backend, "wasm", "the TypeScript fallback answered: the WASM did not load in the worker scope");
    const tension = 126 * 500 * 9.80665 * 0.1; // arm root: 126 rho g a
    assert.ok(Math.abs(stress.points[0].tensionKPa * 1000 - tension) / tension < 2e-3, `${stress.points[0].tensionKPa} kPa`);
    assert.ok(messages.some((m) => m.kind === "progress" && m.step === "stress"), "no stress progress message");
    // The second request re-uses the module that is already loaded.
    const again = await worker.run(request(2, { settings: { ...request(0).settings, material: "concrete" } }));
    assert.equal(again.done.result.stress.solver.backend, "wasm");
    const concrete = 126 * 2400 * 9.80665 * 0.1 / 0.2e6; // 148 %: a 6-block concrete arm fails
    assert.ok(Math.abs(again.done.result.stress.maxUtilisation - concrete) < 0.005, String(again.done.result.stress.maxUtilisation));
});

await test("a wasm that cannot be fetched (404) falls back to the TypeScript solver with the same numbers", async () => {
    // The loader reports the failed fetch on the console (and an XHR retry that a Node vm does not have): that is expected.
    const worker = startWorker((path) => (path.endsWith(".wasm") ? null : serveBuild(path)), { quiet: true });
    const { done } = await worker.run(request(1));
    assert.equal(done.kind, "result", done.message);
    assert.equal(done.result.stress.solver.backend, "ts");
    const tension = 126 * 500 * 9.80665 * 0.1;
    assert.ok(Math.abs(done.result.stress.points[0].tensionKPa * 1000 - tension) / tension < 2e-3);
});

// ---------- the stabilizer's worker (the same page-less scope, the same way a browser starts it) ----------

const stabilizeFile = assets.find((f) => /^stabilize\.worker-.*\.js$/.test(f));

await test("the build emits the stabilizer worker, which names the same wasm file and has no import.meta or Node import", () => {
    assert.ok(stabilizeFile, "assets/stabilize.worker-*.js");
    const stabilizeCode = readFileSync(join(dir, "assets", stabilizeFile ?? ""), "utf8");
    assert.ok(stabilizeCode.includes(`new URL("/assets/${wasmFiles[0]}",self.location.href)`), "no new URL(<asset>, self.location.href) in the stabilizer worker");
    assert.ok(!/\bimport\.meta\b/.test(stabilizeCode), "an import.meta is left in the classic worker script");
    assert.ok(!/from\s*["']node:/.test(stabilizeCode) && !/require\(["']node:/.test(stabilizeCode), "a Node import is left in the stabilizer worker");
});

/** The stabilizer worker in its own scope: it answers a "stabilize" request with "event" messages and one "done" (or "error"). */
function startStabilizer(serve, { quiet = true } = {}) {
    const posted = [];
    const sandbox = {
        console: quiet ? { log() {}, warn() {}, error() {}, info() {}, debug() {} } : console,
        URL,
        TextDecoder,
        TextEncoder,
        performance,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        WebAssembly,
        Response,
        AbortController,
        crypto: globalThis.crypto, // every worker scope has it (the log's ids)
        location: { href: `http://localhost:4173/assets/${stabilizeFile}` },
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
    vm.runInContext(readFileSync(join(dir, "assets", stabilizeFile ?? ""), "utf8"), sandbox, { filename: stabilizeFile });
    assert.equal(typeof sandbox.onmessage, "function", "the stabilizer worker did not install onmessage");
    return {
        posted,
        async run(request) {
            const from = posted.length;
            sandbox.onmessage({ data: vm.runInContext(`(${JSON.stringify(request)})`, sandbox) });
            for (let n = 0; n < 1200; n++) {
                const done = posted.slice(from).find((m) => m.kind === "done" || m.kind === "error");
                if (done) return { done, messages: posted.slice(from) };
                await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error("the stabilizer worker never answered");
        },
    };
}

// The same arm, in concrete: 6 blocks of reach fail (148 %), so there is something to fix.
const stabilizeRequest = (id, wasmUrl) => ({
    kind: "stabilize",
    id,
    sourceDepth: 0,
    wasmUrl,
    input: {
        cells,
        settings: { targetSizeMm: 1000, blockSizeMm: 100, fillThreshold: 0.1, cantileverLimit: 4, maxBlocks: null, material: "concrete" },
        options: { targetUtilisation: 0.75, maxBlocks: 1000, maxSteps: 40, timeBudgetMs: 20000 },
        assembly: null,
    },
});

await test("the built stabilizer worker loads the WebAssembly solver, streams its steps and returns a version that passes", async () => {
    const worker = startStabilizer(serveBuild);
    const { done, messages } = await worker.run(stabilizeRequest(1, `/assets/${wasmFiles[0]}`));
    assert.equal(done.kind, "done", done.message);
    const { result } = done;
    assert.equal(result.meta.solver, "awatif-wasm", "the TypeScript fallback answered: the WASM did not load in the stabilizer's scope");
    assert.equal(result.complete, true);
    assert.ok(result.meta.added_blocks > 0 && result.meta.steps.length > 0);
    assert.equal(result.meta.after.errors, 0);
    assert.ok(result.meta.after.max_utilisation <= 0.75, String(result.meta.after.max_utilisation));
    assert.ok(messages.some((m) => m.kind === "event" && m.event.kind === "step"), "no step event streamed");
    assert.ok(result.glb.byteLength > 1000 && String.fromCharCode(...result.glb.slice(0, 4)) === "glTF", "no GLB in the result");
    assert.equal(done.id, 1);
});

await test("the stabilizer worker without a wasm (not fetchable, or no URL) uses the TypeScript solver and picks the same blocks", async () => {
    const withWasm = await startStabilizer(serveBuild).run(stabilizeRequest(1, `/assets/${wasmFiles[0]}`));
    const missing = await startStabilizer((path) => (path.endsWith(".wasm") ? null : serveBuild(path))).run(stabilizeRequest(1, `/assets/${wasmFiles[0]}`));
    const none = await startStabilizer(serveBuild).run(stabilizeRequest(1, undefined));
    for (const run of [missing, none]) {
        assert.equal(run.done.kind, "done", run.done.message);
        assert.equal(run.done.result.meta.solver, "awatif-ts");
        assert.equal(run.done.result.meta.assembly_hash, withWasm.done.result.meta.assembly_hash, "the two solvers chose different blocks");
    }
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
