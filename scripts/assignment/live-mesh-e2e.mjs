// The live check of the whole mesh-edit path through a real `wrangler dev` with the key, one paid call: the local Hunyuan chair is put in the
// local bucket as a "generated" model, the browser's editor makes its three JPEG pictures, POST /models/:id/edits queues the plan, the queue
// consumer (worker/llm.ts) asks Muse Spark through OpenRouter, the plan comes back on the job, the editor runs it on the file and uploads the
// edited file (POST /models/:id/edited?job=), and the new version is read back and undone. Never calls Tencent: the model row is inserted, not generated.
//
//   LIVE=1 BASE=http://127.0.0.1:8761 node scripts/assignment/live-mesh-e2e.mjs ["instruction"]
//   (the server: a `wrangler dev` whose .dev.vars has OPENROUTER_API_KEY and no MOCK_PROVIDER, or MOCK_LLM=0 together with MOCK_PROVIDER=1;
//    migrations 0001-0006 applied; the local explorer API must be reachable to seed the model)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}
if (process.env.LIVE !== "1") {
    console.log("This sends one real request to a paid model (about $0.0006). Run it with LIVE=1 and BASE=<a server that has the key>.");
    process.exit(0);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8761").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const EXPLORER = `${BASE}/cdn-cgi/local/explorer/api`;
const instruction = process.argv[2] ?? "make the backrest 150 mm taller";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
const bad = [];
const check = (name, cond, detail = "") => {
    if (cond) { ok++; console.log(`  ok   ${name}`); } else { bad.push(name); console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`); }
};

const { openSession } = await import("../../src/assignment/edit/session.ts");
const { readMeshGlb } = await import("../../src/assignment/edit/readMeshGlb.ts");
const { sharpCodec, readHunyuan, hasHunyuan, HUNYUAN_GLB } = await import("./edit-test-support.mjs");
if (!hasHunyuan()) {
    console.error(`no model at ${HUNYUAN_GLB}`);
    process.exit(2);
}
// The browser's canvas for the JPEG pictures: sharp stands in, the editor's own code path runs.
const sharp = (await import("sharp")).default;
globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() { const self = this; return { putImageData(d) { self.d = d; } }; }
    async convertToBlob({ type, quality }) {
        const { data } = this.d;
        const rgb = Buffer.alloc(this.w * this.h * 3);
        for (let i = 0; i < this.w * this.h; i++) { rgb[i * 3] = data[i * 4]; rgb[i * 3 + 1] = data[i * 4 + 1]; rgb[i * 3 + 2] = data[i * 4 + 2]; }
        return new Blob([await sharp(rgb, { raw: { width: this.w, height: this.h, channels: 3 } }).jpeg({ quality: Math.round(quality * 100) }).toBuffer()], { type });
    }
};

async function call(method, path, body, headers = {}, raw = false) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        init.body = raw || typeof body === "string" ? body : JSON.stringify(body);
        if (!raw) init.headers["content-type"] = "application/json";
    }
    const res = await fetch(`${API}${path}`, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* a file */ }
    return { status: res.status, json, bytes };
}
const DB_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"))?.[1];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = async (statement) => (await (await fetch(`${EXPLORER}/d1/database/${DB_ID}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: statement }) })).json()).success;

const project = (await call("POST", "/projects", { name: "live mesh e2e" })).json.project.id;
const bytes = readHunyuan();
const sourceId = crypto.randomUUID();
const key = `models/${sourceId}.glb`;
const put = await fetch(`${EXPLORER}/r2/buckets/assignment-alex-models/objects/${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
check("the chair is in the local bucket", put.ok, String(put.status));
check("and in the database as a Hunyuan model", await sql(`INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind) VALUES (${q(sourceId)}, ${q(project)}, ${q(crypto.randomUUID())}, 'hunyuan', 'a wooden rocking chair', ${q(key)}, ${bytes.byteLength}, 1, ${q(new Date().toISOString())}, 'generated')`));

const t0 = Date.now();
const session = await openSession(bytes, await sharpCodec(), "a wooden rocking chair");
const pkg = await session.describe("jpeg");
const mime = /^data:([^;]+)/.exec(pkg.views[0].image)?.[1];
console.log(`pictures: ${pkg.views.map((v) => `${v.id} ${Math.round((v.image.length * 0.75) / 1024)} KB`).join(", ")} (${mime}), package ${Math.round(JSON.stringify(pkg).length / 1024)} KB, ${Date.now() - t0} ms`);
check("the pictures are JPEG", mime === "image/jpeg");

const started = Date.now();
const res = await call("POST", `/models/${sourceId}/edits`, { instruction, target: "mesh", mesh: pkg });
check("the plan is queued (201)", res.status === 201, `${res.status} ${JSON.stringify(res.json)}`);
let job = res.json?.job;
while (job && !["succeeded", "failed", "canceled"].includes(job.status) && Date.now() - started < 120_000) {
    await sleep(1000);
    job = (await call("GET", `/jobs/${job.id}`)).json?.job;
}
const planMs = Date.now() - started;
check("the job succeeds", job?.status === "succeeded", JSON.stringify(job)?.slice(0, 300));
const plan = job?.edit?.result;
check("the plan is on the job (no model yet)", job?.model === null && plan?.target === "mesh" && plan.applied === true && plan.program?.ops?.length >= 1, JSON.stringify(plan)?.slice(0, 300));
console.log(`plan in ${(planMs / 1000).toFixed(1)} s: "${plan?.program?.summary}" ops ${plan?.program?.ops?.map((o) => `${o.op}(${o.label})`).join(", ")}`);
if (plan?.program) {
    const out = await session.run({ program: plan.program, instruction, jobId: job.id });
    console.log(`ran in ${out.ms} ms: ${(out.glb.byteLength / 1e6).toFixed(1)} MB, ${out.triangles} triangles`);
    const up0 = Date.now();
    const up = await call("POST", `/models/${sourceId}/edited?job=${job.id}`, out.glb, { "content-type": "model/gltf-binary" }, true);
    check("the edited file is stored (201)", up.status === 201 && up.json?.model?.kind === "edited", `${up.status} ${JSON.stringify(up.json)?.slice(0, 300)}`);
    console.log(`uploaded ${(out.glb.byteLength / 1e6).toFixed(1)} MB in ${Date.now() - up0} ms`);
    const model = up.json?.model;
    check("the version records the person's words and the plan", model?.edit?.target === "mesh" && model.edit.job_id === job.id && model.edit.ops?.length === plan.program.ops.length, JSON.stringify(model?.edit)?.slice(0, 300));
    const file = model ? await call("GET", `/files/models/${model.id}.glb`) : null;
    check("the file serves and reads as a model again", file?.status === 200 && readMeshGlb(file.bytes).ok === true);
    const after = (await call("GET", `/projects/${project}`)).json?.project;
    check("the job points at the version and the plan is no longer carried", after?.jobs?.find((j) => j.id === job.id)?.model?.id === model?.id && after.jobs.find((j) => j.id === job.id).edit.result === null);
    const undo = model ? await call("DELETE", `/models/${model.id}`) : null;
    check("undo removes the version", undo?.status === 200 && (await call("GET", `/files/models/${model.id}.glb`)).status === 404);
}
await call("POST", "/projects/bulk", { ids: [project], action: "trash" }).catch(() => {});
await call("POST", "/projects/bulk", { ids: [project], action: "purge" }).catch(() => {});
console.log(`\n${ok} checks passed${bad.length ? `, ${bad.length} FAILED: ${bad.join("; ")}` : ""}`);
process.exit(bad.length ? 1 : 0);
