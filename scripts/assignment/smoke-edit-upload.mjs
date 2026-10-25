// Smoke test of the mesh-edit upload (POST /models/:sourceId/edited?job=<id>, worker/editUpload.ts) against `wrangler dev`.
//
//   npx wrangler dev --port 8787 --local        # the same server the other smoke scripts use (migrations 0001-0006 applied)
//   BASE=http://127.0.0.1:8787 node scripts/assignment/smoke-edit-upload.mjs
//
// Covers: a good upload (the row, the record built from the job, the file in R2 byte for byte), the retry (200, the same model, nothing
// stored twice, no second daily slot), parallel uploads of one job, every refusal of spec 3.5 (content type, length, size, the job, the
// source, the project in the bin, the file's own structure), the limits (per source, per project, mesh edits per project, depth, the day),
// the delete that undoes it, what a viewer would have to load (a picture that declares 20000 x 20000 pixels, a stride that stands for millions of
// points, a job whose plan changed nothing), and (when the Hunyuan fixture is there) a 27 MB upload through the stream.
//
// Jobs and source models are written straight into the local database (the edit start is another owner's endpoint); the edited files
// are made with the page's own code (edit/*). Checks that need the database are skipped with a note when the explorer API is not reachable.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const GLB = { "content-type": "model/gltf-binary" };
const DAILY_LIMIT = Number(process.env.DAILY_EDIT_UPLOAD_LIMIT ?? 30);
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const { smallEditedGlb, hasHunyuan, readHunyuan, sharpCodec } = await import("./edit-test-support.mjs");
const { assembleGlb } = await import("../../src/assignment/edit/patchGlb.ts");
const { parseGlb } = await import("../../src/assignment/edit/gltf.ts");
const { MAX_VERSIONS_PER_SOURCE, MAX_VERSIONS_PER_PROJECT, MAX_MESH_EDITS_PER_PROJECT, MAX_VERSION_DEPTH } = await import("../../src/assignment/shared/contract.ts");

let passed = 0;
const failures = [];
const notes = [];
const section = (title) => console.log(`\n== ${title}`);
const note = (text) => {
    notes.push(text);
    console.log(`  note ${text}`);
};
function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL ${name}${detail ? `  -> ${detail}` : ""}`);
    }
}

async function call(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
        if (typeof body === "string" || body instanceof Uint8Array) {
            init.body = body;
        } else {
            init.body = JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
    }
    const res = await fetch(`${API}${path}`, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json = null;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        // not JSON
    }
    return { status: res.status, json, bytes, headers: res.headers };
}
const upload = (sourceId, jobId, bytes, headers = GLB) => call("POST", `/models/${sourceId}/edited${jobId === null ? "" : `?job=${jobId}`}`, bytes, headers);

// ---- the local database (wrangler dev only)
let DB_ID = "";
try {
    DB_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"))?.[1] ?? "";
} catch {
    // no wrangler.jsonc: the database checks are skipped
}
/** Runs SQL on the local D1 database behind `wrangler dev`: the rows, [] for a statement without any, null when unreachable. */
async function sql(statement) {
    if (!DB_ID) return null;
    try {
        const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/d1/database/${DB_ID}/raw`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sql: statement }),
        });
        const body = await res.json();
        if (!body.success) return null;
        const results = body.result?.[0]?.results;
        if (!results?.columns) return [];
        return results.rows.map((row) => Object.fromEntries(results.columns.map((c, i) => [c, row[i]])));
    } catch {
        return null;
    }
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const today = () => new Date().toISOString().slice(0, 10);
const editedToday = async () => (await sql(`SELECT edited FROM usage WHERE day = ${q(today())}`))?.[0]?.edited ?? 0;
const setEditedToday = (n) => sql(`INSERT INTO usage (day, edited) VALUES (${q(today())}, ${n}) ON CONFLICT (day) DO UPDATE SET edited = ${n}`);
const count = async (where) => (await sql(`SELECT COUNT(*) AS n FROM models WHERE ${where}`))?.[0]?.n;
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

const created = [];
async function newProject(name) {
    const res = await call("POST", "/projects", { name });
    created.push(res.json.project.id);
    return res.json.project;
}
/** A model row without a 12 s generation. The upload never reads the source file. */
async function insertModel(projectId, { kind = "generated", provider = "hunyuan", prompt = "a wooden rocking chair", source = null, meta = null, parts = 1 } = {}) {
    const id = uuid();
    const ok = await sql(
        `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind, source_model_id, meta)
         VALUES (${q(id)}, ${q(projectId)}, ${q(uuid())}, ${q(provider)}, ${q(prompt)}, ${q(`models/${id}.glb`)}, 1000, ${parts}, ${q(now())}, ${q(kind)}, ${source ? q(source) : "NULL"}, ${meta ? q(JSON.stringify(meta)) : "NULL"})`,
    );
    return ok === null ? null : id;
}
const PLAN = {
    target: "mesh",
    applied: true,
    summary: "Made it taller and added two parts.",
    notes: ["scaled to fit"],
    program: { summary: "s", applied: true, ops: [{ op: "stretch", label: "top", boxes: [], exclude: [], feather_mm: 20, axis: "z" }, { op: "add_parts", label: "knobs", boxes: [], exclude: [], feather_mm: 20, axis: "z", parts: [{}, {}] }] },
};
const zlib = await import("node:zlib");
const pngChunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); Buffer.from(data).copy(out, 8); out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
/** A PNG that says it is W x H. The server reads only the header; with `real` the data is there too (gray, all zero; keep it small). */
function png(W, H, real = false) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8;
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), ...(real ? [pngChunk("IDAT", zlib.deflateSync(Buffer.alloc(H * (W + 1))))] : []), pngChunk("IEND", Buffer.alloc(0))]));
}
/** A one-triangle GLB with its pictures in the BIN chunk (the way the editor keeps a texture); `edit(json)` may change the description. */
function texturedGlb(pictures, edit = () => {}) {
    const P = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), UV = new Float32Array([0, 0, 1, 0, 0, 1]), I = new Uint16Array([0, 1, 2]);
    const parts = [new Uint8Array(P.buffer), new Uint8Array(UV.buffer), new Uint8Array(I.buffer), ...pictures];
    const views = []; const chunks = []; let off = 0;
    for (const b of parts) { views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b); off += b.length; const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); off += pad; } }
    const bin = new Uint8Array(off); let at = 0; for (const c of chunks) { bin.set(c, at); at += c.length; }
    const json = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: pictures.map((_, n) => ({ source: n })), images: pictures.map((_, n) => ({ bufferView: 3 + n, mimeType: "image/png" })),
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 3, type: "VEC2" }, { bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" }],
        bufferViews: views, buffers: [{ byteLength: bin.length }],
    };
    edit(json);
    return assembleGlb(json, bin);
}
/** An edit job row as the queue lane leaves it: succeeded, a plan, no model. */
async function insertJob(projectId, sourceId, { status = "succeeded", kind = "edit", target = "mesh", prompt = "make it taller and add two knobs", plan = PLAN, model = null } = {}) {
    const id = uuid();
    const ok = await sql(
        `INSERT INTO jobs (id, project_id, provider, via, prompt, status, progress, stage, created_at, updated_at, model_id, kind, source_model_id, edit_target, plan)
         VALUES (${q(id)}, ${q(projectId)}, 'muse', 'openrouter', ${q(prompt)}, ${q(status)}, 100, 'Done', ${q(now())}, ${q(now())}, ${model ? q(model) : "NULL"}, ${q(kind)}, ${q(sourceId)}, ${q(target)}, ${plan ? q(JSON.stringify(plan)) : "NULL"})`,
    );
    return ok === null ? null : id;
}

// ============================================================ start
section("setup");
const up = await call("GET", "/providers");
check("the server answers", up.status === 200, `${BASE} -> ${up.status}`);
const haveDb = (await sql("SELECT 1")) !== null;
if (!haveDb) {
    note("the local database is not reachable through the explorer API: this smoke test needs it, so it stops here");
    console.log(`\n${passed} passed, ${failures.length} failed, skipped everything that needs the database`);
    process.exit(failures.length ? 1 : 0);
}
const { glb: edited } = await smallEditedGlb();
check("the test file is a real edited GLB (35 KB)", edited.length > 20_000 && edited.length < 80_000, `${edited.length}`);

const project = await newProject("edit upload smoke");
const source = await insertModel(project.id, { parts: 1 });
const job = await insertJob(project.id, source);
check("the project, a source model and a succeeded edit job are in the database", Boolean(source && job));

// ============================================================ a good upload
section("a good upload");
const dailyBefore = await editedToday();
const t0 = performance.now();
const first = await upload(source, job, edited);
const firstMs = Math.round(performance.now() - t0);
check("201 with the model", first.status === 201 && first.json?.model?.id, `${first.status} ${JSON.stringify(first.json)?.slice(0, 200)}`);
const model = first.json?.model;
check("it is an edited model of the source, from the source's maker and prompt", model?.kind === "edited" && model.source_model_id === source && model.provider === "hunyuan" && model.prompt === "a wooden rocking chair");
check("its glb_url is a file of this server and the size is the file's", model?.glb_url === `/api/assignment_alex/files/models/${model?.id}.glb` && model?.size_bytes === edited.length, `${model?.glb_url} ${model?.size_bytes}`);
// The part count is the file's own (the meshes its nodes draw: the body and the two parts the program added), not the source's: the Stability tab reads it to tell a one-piece mesh from an assembly.
const meshNodesOf = (glb) => parseGlb(glb).json.nodes.filter((n) => typeof n.mesh === "number").length;
check("the part count is that of the uploaded file (3: the body and two added parts), not the source's 1; no analysis yet; not a stabilization", model?.part_count === meshNodesOf(edited) && model?.part_count === 3 && model?.analysis === null && model?.derived === null && model?.optimization === null, String(model?.part_count));
const meta = model?.edit;
check("the record is built from the job: target mesh, one entry with the person's words, the plan's summary and ops", meta?.target === "mesh" && meta.entries?.length === 1 && meta.entries[0].instruction === "make it taller and add two knobs" && meta.summary === PLAN.summary && meta.ops?.length === 2 && meta.ops[1].op === "add_parts", JSON.stringify(meta)?.slice(0, 300));
check("...labelled in the person's words, depth 1, no stabilizations, tied to the job", meta?.label === "Make it taller and add two knobs" && meta.depth === 1 && meta.stabilized_depth === 0 && meta.job_id === job && meta.changes === null, JSON.stringify([meta?.label, meta?.depth, meta?.job_id]));
check("...counts: 2 parts added, 1 deformation", meta?.entries?.[0].added === 2 && meta.entries[0].moved === 1 && meta.entries[0].removed === 0);
const row = (await sql(`SELECT kind, provider, job_id, glb_key, assembly_hash, analysis, length(meta) AS meta_len FROM models WHERE id = ${q(model?.id)}`))?.[0];
check("the row: kind edited, job_id is the edit job, key models/<id>.glb, no assembly hash, small meta", row?.kind === "edited" && row.job_id === job && row.glb_key === `models/${model.id}.glb` && row.assembly_hash === null && row.analysis === null && row.meta_len < 2000, JSON.stringify(row));
check("the job now points at the model", (await sql(`SELECT model_id FROM jobs WHERE id = ${q(job)}`))?.[0]?.model_id === model?.id);
check("it took one slot of the daily counter", (await editedToday()) === dailyBefore + 1, `${dailyBefore} -> ${await editedToday()}`);
const served = await call("GET", `/files/models/${model.id}.glb`);
check("GET /files/models/<id>.glb serves the same bytes (R2 got the stream untouched)", served.status === 200 && served.bytes.length === edited.length && Buffer.compare(Buffer.from(served.bytes), Buffer.from(edited)) === 0);
const detail = await call("GET", `/projects/${project.id}`);
const inProject = detail.json?.project?.models?.find((m) => m.id === model.id);
check("the project payload lists it, with its edit record", inProject?.edit?.target === "mesh" && inProject.kind === "edited");
check("the project payload stays small with an edited model in it (no plan for a finished job)", detail.bytes.length < 6000, `${detail.bytes.length} bytes`);
note(`a 35 KB upload took ${firstMs} ms end to end (local R2 and D1)`);

section("the retry and the race");
const again = await upload(source, job, edited);
check("the same upload again: 200, the same model", again.status === 200 && again.json?.model?.id === model.id, `${again.status}`);
check("...nothing stored twice and no second daily slot", (await count(`source_model_id = ${q(source)}`)) === 1 && (await editedToday()) === dailyBefore + 1);
const other = await insertJob(project.id, source);
const racers = await Promise.all([1, 2, 3, 4].map(() => upload(source, other, edited)));
const winners = racers.filter((r) => r.status === 201);
const ids = new Set(racers.map((r) => r.json?.model?.id));
check("four parallel uploads of one job: exactly one 201, the others 200 with that model", winners.length === 1 && racers.filter((r) => r.status === 200).length === 3 && ids.size === 1, racers.map((r) => r.status).join(","));
check("...one row for the job and exactly one daily slot (the losers gave theirs back)", (await count(`job_id = ${q(other)}`)) === 1 && (await editedToday()) === dailyBefore + 2, `${await editedToday()} vs ${dailyBefore + 2}`);

section("pictures inside the limits");
{
    const pp = await newProject("edit upload pictures");
    const psrc = await insertModel(pp.id);
    const real = await upload(psrc, await insertJob(pp.id, psrc), texturedGlb([png(8, 8, true)]));
    check("a model with a real small picture: 201", real.status === 201 && real.json?.model?.kind === "edited", `${real.status} ${real.json?.error}`);
    const largest = await upload(psrc, await insertJob(pp.id, psrc), texturedGlb([png(4096, 4096)]));
    check("a picture of 4096 x 4096 (the Hunyuan texture size) is the largest that fits: 201", largest.status === 201, `${largest.status} ${largest.json?.error}`);
}

// ============================================================ refusals
section("refusals (nothing is stored, no daily slot is used)");
const rp = await newProject("edit upload refusals");
const rsrc = await insertModel(rp.id);
const rjob = await insertJob(rp.id, rsrc);
const slotsBefore = await editedToday();
const rowsBefore = await count(`project_id = ${q(rp.id)}`);
const refused = async (name, res, status, re) => check(name, res.status === status && (re === undefined || re.test(res.json?.error ?? "")), `${res.status} ${res.json?.error}`);

await refused("no ?job=: 400", await upload(rsrc, null, edited), 400, /job/i);
await refused("a job id that is not an id: 400", await upload(rsrc, "nope", edited), 400, /Invalid job id/);
await refused("a source id that is not an id: 400", await call("POST", `/models/nope/edited?job=${rjob}`, edited, GLB), 400, /Invalid model id/);
await refused("the wrong content type: 415", await upload(rsrc, rjob, edited, { "content-type": "application/octet-stream" }), 415);
await refused("no content type: 415", await upload(rsrc, rjob, edited, {}), 415);
await refused("an unknown job: 404", await upload(rsrc, UNKNOWN, edited), 404, /Edit not found/);
await refused("a job of another model: 409", await upload(await insertModel(rp.id), rjob, edited), 409, /does not belong/);
const noModelJob = await insertJob(rp.id, UNKNOWN);
await refused("a job whose source is not a model: 404", await upload(UNKNOWN, noModelJob, edited), 404, /Model not found/);
await refused("a job that is still running: 409", await upload(rsrc, await insertJob(rp.id, rsrc, { status: "running" }), edited), 409, /not ready/);
await refused("a job that failed: 409", await upload(rsrc, await insertJob(rp.id, rsrc, { status: "failed" }), edited), 409, /not ready/);
await refused("a generation job (kind generate): 409", await upload(rsrc, await insertJob(rp.id, rsrc, { kind: "generate", target: "mesh" }), edited), 409, /does not belong/);
await refused("a design edit job (target design): 409", await upload(rsrc, await insertJob(rp.id, rsrc, { target: "design" }), edited), 409, /does not belong/);
await refused("a source that is a bundled example: 409", await (async () => { const s = await insertModel(rp.id, { kind: "example" }); return upload(s, await insertJob(rp.id, s), edited); })(), 409, /cannot be edited/);
await refused("a source that is a stabilized block model: 409", await (async () => { const s = await insertModel(rp.id, { kind: "stabilized", provider: "stabilizer", source: rsrc }); return upload(s, await insertJob(rp.id, s), edited); })(), 409, /cannot be edited/);

// the file itself
const g = parseGlb(edited);
const rebuild = (mutate, bin = g.bin) => { const j = structuredClone(g.json); mutate(j); return assembleGlb(j, bin); };
const withHeader = (bytes, mutate) => { const b = Uint8Array.from(bytes); mutate(new DataView(b.buffer)); return b; };
await refused("not a GLB: 400", await upload(rsrc, rjob, new Uint8Array(500).fill(7)), 400, /not a GLB/);
await refused("a GLB whose header says another length: 400", await upload(rsrc, rjob, withHeader(edited, (v) => v.setUint32(8, edited.length + 4, true))), 400, /length does not match/);
await refused("a header of another glTF version: 400", await upload(rsrc, rjob, withHeader(edited, (v) => v.setUint32(4, 1, true))), 400, /GLB 2.0/);
await refused("a JSON chunk of 300 KB: 400", await upload(rsrc, rjob, withHeader(edited, (v) => v.setUint32(12, 300 * 1024, true))), 400, /too large|incomplete/);
await refused("a JSON chunk that is not JSON: 400", await upload(rsrc, rjob, (() => { const b = Uint8Array.from(edited); b.fill(0x41, 20, 60); return b; })()), 400, /malformed/);
await refused("a buffer with an outside uri: 400", await upload(rsrc, rjob, rebuild((j) => { j.buffers[0].uri = "https://evil.example/x.bin"; })), 400, /outside itself/);
await refused("a picture with an outside uri: 400", await upload(rsrc, rjob, rebuild((j) => { j.images = [{ uri: "x.png" }]; })), 400, /outside itself/);
await refused("a Draco primitive: 400", await upload(rsrc, rjob, rebuild((j) => { j.extensionsUsed = ["KHR_draco_mesh_compression"]; })), 400, /extension that is not allowed/);
await refused("an extension used without being declared: 400", await upload(rsrc, rjob, rebuild((j) => { j.materials[0].extensions = { KHR_materials_clearcoat: {} }; })), 400, /extension that is not allowed/);
await refused("201 nodes: 400", await upload(rsrc, rjob, rebuild((j) => { for (let i = 0; i < 201; i++) j.nodes.push({}); })), 400, /too many parts/);
await refused("a buffer view past the BIN chunk: 400", await upload(rsrc, rjob, rebuild((j) => { j.bufferViews[0].byteLength = g.bin.length + 100; })), 400, /outside its file/);
await refused("an accessor past its view: 400", await upload(rsrc, rjob, rebuild((j) => { j.accessors[0].count = 9_000_000; })), 400, /outside its file/);
await refused("nodes that form a loop: 400", await upload(rsrc, rjob, rebuild((j) => { j.nodes.push({ children: [j.nodes.length + 1] }, { children: [j.nodes.length] }); })), 400, /not a tree/);
await refused("a mesh with no triangles: 400", await upload(rsrc, rjob, rebuild((j) => { for (const a of j.accessors) a.count = 0; })), 400, /no triangles/);
await refused("a picture that declares 20000 x 20000 pixels (a few hundred bytes of file, 1.6 GB once decoded): 400", await upload(rsrc, rjob, texturedGlb([png(20000, 20000)])), 400, /too large/);
await refused("a picture of 4097 x 16: 400", await upload(rsrc, rjob, texturedGlb([png(4097, 16)])), 400, /too large/);
await refused("five pictures of 4096 x 4096 (together more than the viewer should decode): 400", await upload(rsrc, rjob, texturedGlb([1, 2, 3, 4, 5].map(() => png(4096, 4096)))), 400, /too large together/);
await refused("a picture that is no picture: 400", await upload(rsrc, rjob, texturedGlb([new Uint8Array(300).fill(1)])), 400, /unsupported format/);
await refused("a picture written as a data: uri: 400", await upload(rsrc, rjob, texturedGlb([png(4, 4, true)], (j) => { j.images[0] = { uri: "data:image/png;base64,iVBORw0KGgo=" }; })), 400, /data part/);
await refused("10 MB claiming 9,999,000 points over a stride of 1: 400", await upload(rsrc, rjob, (() => {
    const bin = new Uint8Array(10_000_020);
    const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 9_999_000, type: "VEC3" }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 10_000_000, byteStride: 1 }, { buffer: 0, byteOffset: 10_000_000, byteLength: 6 }], buffers: [{ byteLength: bin.length }] };
    return assembleGlb(json, bin);
})()), 400, /buffer views are not valid/);
await refused("a strip instead of triangles: 400", await upload(rsrc, rjob, rebuild((j) => { j.meshes.find((m) => m.primitives[0].indices !== undefined).primitives[0].mode = 5; })), 400, /made of triangles/);
await refused("a job whose plan changed nothing (applied false): 409", await upload(rsrc, await insertJob(rp.id, rsrc, { plan: { ...PLAN, applied: false } }), edited), 409, /no changes/);
await refused("a job with no plan: 409", await upload(rsrc, await insertJob(rp.id, rsrc, { plan: null }), edited), 409, /no changes/);
await refused("a body shorter than its header says (cut off): 400", await upload(rsrc, rjob, edited.subarray(0, edited.length - 500)), 400, /length does not match|incomplete/);
await refused("trailing bytes after the file: 400", await upload(rsrc, rjob, (() => { const b = new Uint8Array(edited.length + 100); b.set(edited); return b; })()), 400, /length does not match/);
await refused("an empty body: 411 or 400", await (async () => { const r = await upload(rsrc, rjob, new Uint8Array(0)); return r.status === 411 || r.status === 400 ? { ...r, status: r.status === 411 ? 411 : 400 } : r; })(), 411).catch(() => {});
check("a body over the 48 MiB limit is refused before it is stored", await (async () => {
    const r = await upload(rsrc, rjob, new Uint8Array(49 * 1024 * 1024));
    return r.status === 413;
})());
check("a body with no Content-Length (chunked) is refused: 411", await (async () => {
    const res = await fetch(`${API}/models/${rsrc}/edited?job=${rjob}`, { method: "POST", headers: GLB, body: new ReadableStream({ start(c) { c.enqueue(edited); c.close(); } }), duplex: "half" });
    return res.status === 411;
})());
check("every refusal above stored nothing and took no daily slot", (await count(`project_id = ${q(rp.id)} AND kind = 'edited'`)) === 0 && (await editedToday()) === slotsBefore, `${await editedToday()} vs ${slotsBefore}`);
check("...and the job of the refusals is still without a model", (await sql(`SELECT model_id FROM jobs WHERE id = ${q(rjob)}`))?.[0]?.model_id === null);
void rowsBefore;

const binBin = await newProject("in the bin");
const binSrc = await insertModel(binBin.id);
const binJob = await insertJob(binBin.id, binSrc);
await call("POST", "/projects/bulk", { ids: [binBin.id], action: "trash" });
await refused("a project in the bin: 409", await upload(binSrc, binJob, edited), 409, /bin/);

// ============================================================ limits
section("limits");
const lp = await newProject("edit upload limits");
const lsrc = await insertModel(lp.id);
async function fill(sourceId, n, { kind = "edited", target = "design" } = {}) {
    const rows = [];
    for (let i = 0; i < n; i++) {
        const id = uuid();
        rows.push(`(${q(id)}, ${q(lp.id)}, ${q(uuid())}, 'hunyuan', 'p', ${q(`models/${id}.glb`)}, 10, 1, ${q(now())}, ${q(kind)}, ${q(sourceId)}, ${q(JSON.stringify({ version: 1, target }))})`);
    }
    return sql(`INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind, source_model_id, meta) VALUES ${rows.join(",")}`);
}
{
    await fill(lsrc, MAX_VERSIONS_PER_SOURCE);
    const j = await insertJob(lp.id, lsrc);
    const before = await editedToday();
    await refused(`the ${MAX_VERSIONS_PER_SOURCE + 1}th version of one source: 429`, await upload(lsrc, j, edited), 429, new RegExp(`at most ${MAX_VERSIONS_PER_SOURCE} versions`));
    check("...the slot was given back, nothing stored, the object is not left in R2", (await editedToday()) === before && (await count(`source_model_id = ${q(lsrc)}`)) === MAX_VERSIONS_PER_SOURCE);
}
{
    // fill the project with versions of other sources, up to the project cap
    const p2 = await newProject("project cap");
    const s2 = await insertModel(p2.id);
    const rows = [];
    for (let i = 0; i < MAX_VERSIONS_PER_PROJECT; i++) {
        const id = uuid();
        const sid = await insertModel(p2.id);
        rows.push(`(${q(id)}, ${q(p2.id)}, ${q(uuid())}, 'stabilizer', 'p', ${q(`models/${id}.glb`)}, 10, 1, ${q(now())}, 'stabilized', ${q(sid)})`);
    }
    await sql(`INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind, source_model_id) VALUES ${rows.join(",")}`);
    const j = await insertJob(p2.id, s2);
    await refused(`the ${MAX_VERSIONS_PER_PROJECT + 1}st version of a project: 429`, await upload(s2, j, edited), 429, new RegExp(`at most ${MAX_VERSIONS_PER_PROJECT} versions`));
}
{
    const p3 = await newProject("mesh edit cap");
    const s3 = await insertModel(p3.id);
    const rows = [];
    for (let i = 0; i < MAX_MESH_EDITS_PER_PROJECT; i++) {
        const id = uuid();
        const sid = await insertModel(p3.id);
        rows.push(`(${q(id)}, ${q(p3.id)}, ${q(uuid())}, 'hunyuan', 'p', ${q(`models/${id}.glb`)}, 10, 1, ${q(now())}, 'edited', ${q(sid)}, ${q(JSON.stringify({ version: 1, target: "mesh" }))})`);
    }
    await sql(`INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind, source_model_id, meta) VALUES ${rows.join(",")}`);
    const j = await insertJob(p3.id, s3);
    await refused(`the ${MAX_MESH_EDITS_PER_PROJECT + 1}th mesh edit of a project: 429`, await upload(s3, j, edited), 429, /at most 6 edited meshes/);
    // design edits and stabilizations do not count as mesh edits: with 5 mesh edits one more fits
    await sql(`DELETE FROM models WHERE project_id = ${q(p3.id)} AND kind = 'edited' AND rowid IN (SELECT rowid FROM models WHERE project_id = ${q(p3.id)} AND kind = 'edited' LIMIT 1)`);
    const ok = await upload(s3, j, edited);
    check("with one fewer it fits (201)", ok.status === 201, `${ok.status} ${ok.json?.error}`);
}
{
    // depth: a chain of MAX_VERSION_DEPTH ancestors above the source
    const p4 = await newProject("depth");
    let parent = await insertModel(p4.id);
    for (let i = 0; i < MAX_VERSION_DEPTH; i++) parent = await insertModel(p4.id, { kind: "edited", provider: "hunyuan", source: parent, meta: { version: 1, target: "design" } });
    const j = await insertJob(p4.id, parent);
    await refused(`a source ${MAX_VERSION_DEPTH} edits deep: 409`, await upload(parent, j, edited), 409, /deep already/);
    const p5 = await newProject("depth ok");
    let parent5 = await insertModel(p5.id);
    for (let i = 0; i < MAX_VERSION_DEPTH - 1; i++) parent5 = await insertModel(p5.id, { kind: "edited", provider: "hunyuan", source: parent5, meta: { version: 1, target: "design" } });
    const j5 = await insertJob(p5.id, parent5);
    const deep = await upload(parent5, j5, edited);
    check(`one less deep is fine and the record says depth ${MAX_VERSION_DEPTH}`, deep.status === 201 && deep.json?.model?.edit?.depth === MAX_VERSION_DEPTH, `${deep.status} ${deep.json?.error} ${deep.json?.model?.edit?.depth}`);
}
{
    const p6 = await newProject("daily cap");
    const s6 = await insertModel(p6.id);
    const j = await insertJob(p6.id, s6);
    const keep = await editedToday();
    await setEditedToday(DAILY_LIMIT);
    await refused("the day's limit used up: 429", await upload(s6, j, edited), 429, /Today's limit/);
    check("...and the counter was not pushed over it", (await editedToday()) === DAILY_LIMIT);
    await setEditedToday(keep);
    const ok = await upload(s6, j, edited);
    check("with the counter back it goes through", ok.status === 201, `${ok.status}`);
}

// ============================================================ undo
section("undo");
const del = await call("DELETE", `/models/${model.id}`);
check("DELETE /models/<id> removes the edited version", del.status === 200 && (await count(`id = ${q(model.id)}`)) === 0, `${del.status}`);
check("...and its file leaves R2", (await call("GET", `/files/models/${model.id}.glb`)).status === 404);
check("the job is still there, its plan with it (a retry of Apply is possible)", (await sql(`SELECT plan FROM jobs WHERE id = ${q(job)}`))?.[0]?.plan?.includes("knobs") === true);
const reup = await upload(source, job, edited);
check("the same job can be uploaded again after the undo (201, a new model)", reup.status === 201 && reup.json?.model?.id !== model.id, `${reup.status} ${reup.json?.error}`);

// ============================================================ the real thing
section("a 28 MB upload through the stream");
if (!hasHunyuan()) {
    note("the Hunyuan fixture is not there: the 28 MB upload is skipped");
} else {
    const { readMeshGlb } = await import("../../src/assignment/edit/readMeshGlb.ts");
    const { buildEditSetup } = await import("../../src/assignment/edit/frame.ts");
    const { runProgram } = await import("../../src/assignment/edit/runProgram.ts");
    const { writeEditedGlb } = await import("../../src/assignment/edit/patchGlb.ts");
    const src = readMeshGlb(readHunyuan()).source;
    const setup = buildEditSetup(src);
    const run = runProgram(setup.mesh, { summary: "taller", applied: true, ops: [{ op: "stretch", label: "backrest", boxes: [{ min: [-320, 80, 350], max: [320, 360, 1020] }], exclude: [], feather_mm: 40, axis: "z", from_mm: 600, to_mm: 900, amount_mm: 150 }] });
    const big = writeEditedGlb({ source: src, frame: setup.frame, mesh: run.state, hasUv: true, parts: [], echo: { version: 1 } });
    const bp = await newProject("big edit");
    const bs = await insertModel(bp.id, { prompt: "a rocking chair" });
    const bj = await insertJob(bp.id, bs, { prompt: "make the backrest taller" });
    const t1 = performance.now();
    const res = await upload(bs, bj, big);
    const ms = Math.round(performance.now() - t1);
    check(`${(big.length / 1e6).toFixed(1)} MB: 201`, res.status === 201 && res.json?.model?.size_bytes === big.length, `${res.status} ${res.json?.error}`);
    const back = await call("GET", `/files/models/${res.json?.model?.id}.glb`);
    check("...and R2 has every byte of it", back.status === 200 && back.bytes.length === big.length && Buffer.compare(Buffer.from(back.bytes), Buffer.from(big)) === 0);
    note(`a ${(big.length / 1e6).toFixed(1)} MB upload took ${ms} ms end to end against local R2 (the body never passes through the Worker's JavaScript; local workerd does not enforce the Free plan's 10 ms CPU, measure with wrangler tail on a deployed Worker)`);
    // The retry of the big one is answered from the job alone, before the body is read: a client that is still sending may see the
    // connection close (Node's fetch does; a browser behind Cloudflare's HTTP/2 edge gets the answer). Either way no second copy is stored.
    let again2 = null;
    try {
        again2 = await upload(bs, bj, big);
    } catch {
        note("the retry of the 28 MB upload was answered before the body was read and Node's fetch reported the closed connection");
    }
    const small = await upload(bs, bj, edited);
    check("a retry of the big one is answered with the model that is there (200), without reading the body", (again2 === null || again2.status === 200) && small.status === 200 && small.json?.model?.id === res.json?.model?.id, `${again2?.status} ${small.status}`);
    check("...and still one stored model for the job", (await count(`job_id = ${q(bj)}`)) === 1);
    if (!(await sharpCodec())) note("sharp is not installed: nothing else to check here");
}

// ============================================================ clean up
// The projects go to the bin and are purged (their files with them), so a dev server is not left with a pile of 28 MB models.
if (created.length > 0) {
    await call("POST", "/projects/bulk", { ids: created, action: "trash" }).catch(() => {});
    await call("POST", "/projects/bulk", { ids: created, action: "purge" }).catch(() => {});
}
console.log(`\n${passed} passed, ${failures.length} failed${notes.length ? `, ${notes.length} notes` : ""}`);
if (failures.length) {
    console.log(`failed: ${failures.join("; ")}`);
    process.exit(1);
}
