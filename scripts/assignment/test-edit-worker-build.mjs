// Checks a BUILT site's mesh-edit worker (not the sources): the worker bundle a Vite build emits must start in a bare worker scope, answer
// open / describe / run the way the page's runMeshEdit.ts asks, and write a GLB that Khronos' validator passes.
//   npx vite build --outDir <dir> --emptyOutDir && node scripts/assignment/test-edit-worker-build.mjs <dir>
//
// Like test-worker-build.mjs the bundle is run in a `vm` context that looks like a dedicated worker (no `process`, no `require`, `self`,
// `postMessage`, `Blob` and `CompressionStream` for the PNG pictures). There is no OffscreenCanvas there, as in an old browser: the editor
// must then fall back to PNG pictures and say that it cannot repaint. What this cannot prove is a real browser engine.
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
    console.error("usage: node scripts/assignment/test-edit-worker-build.mjs <vite build output directory>");
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
const { plainBoxGlb } = await import("./edit-test-support.mjs");
const validator = (await import("gltf-validator")).default;

const file = assets.find((f) => /^meshEdit\.worker-.*\.js$/.test(f));
await test("the build emits the mesh-edit worker as a classic script with no import.meta and no Node import, and the page loads the editor lazily", () => {
    assert.ok(file, "assets/meshEdit.worker-*.js");
    const code = readFileSync(join(dir, "assets", file), "utf8");
    assert.ok(!/\bimport\.meta\b/.test(code), "an import.meta is left in the classic worker script");
    assert.ok(!/from\s*["']node:/.test(code) && !/require\(["']node:/.test(code), "a Node import is left in the worker");
    // the Workspace page only names the editor through a dynamic import: its code is not in the page's own chunks
    const page = assets.find((f) => /^Workspace-.*\.js$/.test(f));
    const pageCode = readFileSync(join(dir, "assets", page), "utf8");
    assert.ok(!pageCode.includes("nevo:edit"), "the GLB writer is in the page's chunk instead of a lazy one");
    assert.ok(assets.some((f) => /^runMeshEdit-.*\.js$/.test(f)) && assets.some((f) => /^session-.*\.js$/.test(f)), "the page-side runner and the main-thread fallback are separate chunks");
});

function startWorker() {
    const posted = [];
    const sandbox = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        URL, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout, queueMicrotask, Response, AbortController, Blob, CompressionStream, btoa,
        location: { href: `http://localhost:4173/assets/${file}` },
        WorkerGlobalScope: class WorkerGlobalScope {},
        postMessage: (message) => posted.push(message),
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(join(dir, "assets", file ?? ""), "utf8"), sandbox, { filename: file });
    assert.equal(typeof sandbox.onmessage, "function", "the worker did not install onmessage");
    return {
        posted,
        async ask(request, until = (m) => m.kind !== "progress") {
            const from = posted.length;
            sandbox.onmessage({ data: request });
            for (let n = 0; n < 600; n++) {
                const done = posted.slice(from).find((m) => m.id === request.id && until(m));
                if (done) return { done, messages: posted.slice(from) };
                await new Promise((r) => setTimeout(r, 20));
            }
            throw new Error("the worker never answered");
        },
    };
}

const box = { min: [-400, -400, 300], max: [400, 400, 1100] };
const program = { summary: "Made it taller and added a knob.", applied: true, ops: [
    { op: "stretch", label: "top", boxes: [box], exclude: [], feather_mm: 20, axis: "z", from_mm: 500, to_mm: 900, amount_mm: 100 },
    { op: "add_parts", label: "knob", boxes: [], exclude: [], feather_mm: 20, axis: "z", parts: [{ name: "knob", shape: "sphere", size: [80, 80, 40], position: [0, 0, 1010], rotation: [0, 0, 0], color: "#336699" }] },
] };

await test("the built worker opens a model, describes it with three PNG pictures, runs a program and writes a GLB that validates", async () => {
    const worker = startWorker();
    const bytes = await plainBoxGlb();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const opened = (await worker.ask({ kind: "open", id: 1, bytes: buffer, originalPrompt: "a box" })).done;
    assert.equal(opened.kind, "opened", opened.message);
    assert.equal(opened.info.triangles, 432);
    assert.equal(opened.info.textured, false);
    assert.equal(opened.info.canRepaint, false, "no canvas in this scope: a recolor of the picture is not possible, and the page is told");
    const described = (await worker.ask({ kind: "describe", id: 2, format: "jpeg" })).done;
    assert.equal(described.kind, "described", described.message);
    assert.deepEqual(Array.from(described.pkg.views, (v) => v.id), ["FRONT", "SIDE", "TOP"]);
    assert.ok(described.pkg.views.every((v) => v.image.startsWith("data:image/png;base64,")), "JPEG was asked for, there is no canvas: PNG");
    assert.match(described.pkg.facts, /^Model facts: size X /);
    const small = (await worker.ask({ kind: "describe", id: 3, format: "png", size: 256 })).done;
    assert.ok(JSON.stringify(small.pkg).length < JSON.stringify(described.pkg).length, "a smaller size gives a smaller package");
    const ran = await worker.ask({ kind: "run", id: 4, program, instruction: "make it taller and add a knob", jobId: "00000000-0000-4000-8000-000000000001" }, (m) => m.kind === "ran" || m.kind === "error");
    assert.equal(ran.done.kind, "ran", ran.done.message);
    assert.ok(ran.messages.some((m) => m.kind === "progress" && m.progress.op === "stretch"), "progress messages came before the result");
    assert.equal(ran.done.parts, 1);
    const glb = new Uint8Array(ran.done.glb);
    const v = await validator.validateBytes(glb, { maxIssues: 20 });
    assert.deepEqual([v.issues.numErrors, v.issues.numWarnings, v.issues.numHints], [0, 0, 0], JSON.stringify(v.issues.messages.slice(0, 3)));
});

await test("the built worker answers a file it cannot edit with the reason and a code, and a request before any model is open with an error", async () => {
    const worker = startWorker();
    const bad = (await worker.ask({ kind: "open", id: 1, bytes: new ArrayBuffer(200), originalPrompt: null })).done;
    assert.equal(bad.kind, "error");
    assert.equal(bad.code, "unsupported");
    assert.match(bad.message, /can't be edited here/);
    const none = (await startWorker().ask({ kind: "describe", id: 2, format: "png" })).done;
    assert.equal(none.kind, "error");
    assert.equal(none.code, "failed");
    const missing = (await worker.ask({ kind: "run", id: 3, program: { summary: "s", applied: true, ops: [{ op: "delete", label: "x", boxes: [] }] }, instruction: "x", jobId: null })).done;
    assert.equal(missing.kind, "error");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
