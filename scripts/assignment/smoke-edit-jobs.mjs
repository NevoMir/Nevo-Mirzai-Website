// Smoke test of the edit jobs (design edits and mesh plans) against `wrangler dev` with MOCK_PROVIDER=1, the real queue and the real D1 and R2 of the dev server.
//
//   npx wrangler dev --port 8710 --local          # .dev.vars has MOCK_PROVIDER=1: the edit tasks are answered with canned results, nothing is sent to OpenRouter
//   node scripts/assignment/smoke-edit-jobs.mjs   # BASE=http://127.0.0.1:8710 by default
//
// Covers POST /models/:id/edits (validation, who may be edited, one running edit per project, the day's cap and its 429), the job as it runs through
// the queue consumer (worker/llm.ts) and the poll (worker/jobs.ts) up to the new "edited" version, the file that version serves (the new design is
// embedded), the project payload, undo (DELETE /models/:id), the chain of a second edit, a mesh plan (no model, the program in the job, no staging file
// left behind) and GET /providers `assist`. The source models are inserted through wrangler dev's explorer API (local D1 SQL and R2 PUT): a Muse
// generation would call OpenRouter, and a Hunyuan one is not available here. When that API is not reachable those checks are skipped with a note.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Node < 22.18 only strips types behind a flag; run again with it if this one cannot.
if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8710").replace(/\/$/, "");
const API = `${BASE}/api/assignment_alex`;
const EXPLORER = `${BASE}/cdn-cgi/local/explorer/api`;
const BUCKET = "assignment-alex-models";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const shared = (name) => import(`../../src/assignment/shared/${name}.ts`);
const { buildPartsGlb } = await shared("partsGlb");
const { designFromGlb } = await shared("partsEdit");
const { MAX_VERSIONS_PER_SOURCE } = await shared("contract");

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
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers["content-type"] = "application/json";
    }
    const res = await fetch(`${API}${path}`, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json = null;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        // not JSON
    }
    return { status: res.status, json, bytes };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the local database and bucket (wrangler dev only)
let DB_ID = "";
try {
    DB_ID = /"database_id":\s*"([^"]+)"/.exec(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"))?.[1] ?? "";
} catch {
    // no wrangler.jsonc: the seeded checks are skipped
}
async function sql(statement) {
    if (!DB_ID) return null;
    try {
        const res = await fetch(`${EXPLORER}/d1/database/${DB_ID}/raw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: statement }) });
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

async function putObject(key, bytes) {
    try {
        const res = await fetch(`${EXPLORER}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes });
        return res.ok;
    } catch {
        return false;
    }
}
async function listObjects(prefix) {
    try {
        const res = await fetch(`${EXPLORER}/r2/buckets/${BUCKET}/objects?prefix=${encodeURIComponent(prefix)}&limit=1000`);
        const body = await res.json();
        const items = body.result?.objects ?? body.result ?? body.objects ?? [];
        return items.map((o) => o.key ?? o.name);
    } catch {
        return null;
    }
}

// ---- fixtures
const BENCH = {
    name: "Wooden Garden Bench",
    parts: [
        ["rear leg left", [60, 60, 900], [-400, -190, 450], "#6e4a2a"],
        ["rear leg right", [60, 60, 900], [400, -190, 450], "#6e4a2a"],
        ["front leg left", [60, 60, 450], [-400, 190, 225], "#6e4a2a"],
        ["front leg right", [60, 60, 450], [400, 190, 225], "#6e4a2a"],
        ["seat", [900, 460, 40], [0, 0, 460], "#8f6238"],
        ["backrest", [900, 25, 300], [0, -232.5, 650], "#8f6238"],
    ].map(([name, size, position, color]) => ({ name, shape: "box", size, position, rotation: [0, 0, 0], color })),
};
const PICTURE = `data:image/jpeg;base64,${Buffer.from("not really a jpeg").toString("base64")}`;
const PACKAGE = {
    version: 1,
    frame: { size_mm: [643, 851, 1000], facing: "-Y" },
    facts: "Model facts: size X 643 mm, Y 851 mm, Z 1000 mm; 499,808 triangles; textured.",
    views: ["FRONT", "SIDE", "TOP"].map((id) => ({ id, caption: `${id} view`, image: PICTURE })),
    pieces: null,
    extras: null,
    original_prompt: "a rocking chair",
};

async function seedModel(projectId, { provider = "muse", glb = buildPartsGlb(BENCH), prompt = "a wooden garden bench" } = {}) {
    const id = crypto.randomUUID();
    const key = `models/${id}.glb`;
    if (!(await putObject(key, glb))) return null;
    const row = await sql(
        `INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, part_count, created_at, kind)
         VALUES (${q(id)}, ${q(projectId)}, ${q(crypto.randomUUID())}, ${q(provider)}, ${q(prompt)}, ${q(key)}, ${glb.byteLength}, 6, ${q(new Date().toISOString())}, 'generated')`,
    );
    return row === null ? null : id;
}
const createdProjects = [];
const newProject = async () => {
    const id = (await call("POST", "/projects", { name: "edit smoke" })).json.project.id;
    createdProjects.push(id);
    return id;
};

async function untilDone(jobId, maxMs = 30_000) {
    const started = Date.now();
    let job = null;
    while (Date.now() - started < maxMs) {
        job = (await call("GET", `/jobs/${jobId}`)).json?.job;
        if (job && ["succeeded", "failed", "canceled"].includes(job.status)) return job;
        await sleep(700);
    }
    return job;
}
const edit = (sourceId, body, headers) => call("POST", `/models/${sourceId}/edits`, body, headers);

// ================================================================ checks
const providers = (await call("GET", "/providers")).json;
section("GET /providers: assist");
check("assist is reported", providers?.assist && typeof providers.assist.available === "boolean");
check("the editor is available in the offline demo (MOCK_PROVIDER=1)", providers?.assist?.available === true && providers?.assist?.queued === true, JSON.stringify(providers?.assist));
check("assist names the model and the day's cap", providers?.assist?.model?.includes("muse") && providers?.assist?.daily_limit >= 1);

const project = await newProject();
const seeded = await seedModel(project);
if (!seeded) {
    note("the local explorer API (D1 SQL, R2 PUT) is not reachable: the edit checks are skipped");
} else {
    section("validation");
    check("an empty instruction is a 400", (await edit(seeded, { instruction: "", target: "design" })).status === 400);
    check("a too long instruction is a 400", (await edit(seeded, { instruction: "x".repeat(501), target: "design" })).status === 400);
    check("an unknown target is a 400", (await edit(seeded, { instruction: "paint it", target: "voxel" })).status === 400);
    check("a body that is not JSON is a 400", (await edit(seeded, "nope")).status === 400);
    check("an unknown model is a 404", (await edit(UNKNOWN_ID, { instruction: "paint it", target: "design" })).status === 404);
    check("a malformed id is a 400", (await edit("not-an-id", { instruction: "paint it", target: "design" })).status === 400);
    check("GET is a 405", (await call("GET", `/models/${seeded}/edits`)).status === 405);
    check("a mesh edit of a parts model is refused (409)", (await edit(seeded, { instruction: "paint it", target: "mesh", mesh: PACKAGE })).status === 409);
    check("a mesh edit without pictures is a 400", (await edit(seeded, { instruction: "paint it", target: "mesh" })).status === 400);
    const lamp = await seedModel(project, { glb: new Uint8Array(readFileSync(resolve(ROOT, "public/assignment_alex/fixtures/demo-assembly.glb"))) });
    check("a Muse-labelled model whose file has no part extras cannot be edited by its parts (422)", lamp !== null && (await edit(lamp, { instruction: "paint it", target: "design" })).status === 422);
    const demo = await seedModel(project, { provider: "mock" });
    check("a model of another provider is refused for a design edit (409)", demo !== null && (await edit(demo, { instruction: "paint it", target: "design" })).status === 409);
    const used0 = (await call("GET", "/providers")).json.assist.used_today;
    check("refusals took no slot of the day's cap", used0 === (await call("GET", "/providers")).json.assist.used_today);

    section("a design edit through the queue");
    const started = await edit(seeded, { instruction: "  paint\nthe bench red ", target: "design" });
    check("201 with the running job", started.status === 201 && started.json?.job?.kind === "edit" && started.json.job.status === "running", JSON.stringify(started.json));
    const job = started.json?.job;
    check("the job points at its source and target", job?.edit?.source_model_id === seeded && job?.edit?.target === "design" && job?.provider === "muse");
    check("the instruction is cleaned", job?.prompt === "paint the bench red");
    const second = await edit(seeded, { instruction: "and again", target: "design" });
    check("a second edit while one runs is a 409", second.status === 409, `${second.status} ${JSON.stringify(second.json)}`);
    check("that took no slot", (await call("GET", "/providers")).json.assist.used_today === used0 + 1);
    const done = await untilDone(job.id);
    check("the job succeeds", done?.status === "succeeded", JSON.stringify(done));
    const model = done?.model;
    check("it carries the new version", model?.kind === "edited" && model.source_model_id === seeded && model.provider === "muse");
    check("with a readable EditMeta", model?.edit?.target === "design" && model.edit.depth === 1 && model.edit.job_id === job.id && model.edit.changes?.changed?.length === 6, JSON.stringify(model?.edit));
    check("the label is the person's words", model?.edit?.label === "Paint the bench red");
    const file = model ? await call("GET", `/files/models/${model.id}.glb`) : null;
    const design = file?.status === 200 ? designFromGlb(file.bytes) : null;
    check("the version's file serves the new design", design?.parts?.length === 6 && design.parts.every((p) => p.color === "#d9534f"), JSON.stringify(design?.parts?.map((p) => p.color)));
    check("an untouched shape stays", design?.parts?.[0]?.name === "rear leg left" && design.parts[0].size[2] === 900);
    const payload = (await call("GET", `/projects/${project}`)).json?.project;
    check("the project payload lists the new model and the job", payload?.models?.some((m) => m.id === model?.id && m.edit) && payload?.jobs?.some((j) => j.id === job.id && j.model?.id === model?.id));
    const leftover = await listObjects("llm/");
    const staging = (await sql(`SELECT provider_task_id AS t FROM jobs WHERE id = ${q(job.id)}`))?.[0]?.t;
    if (leftover && staging) check("the task's staging files are gone", !leftover.some((k) => k.includes(staging)), leftover.join(","));

    section("a second edit of the new version, then undo");
    const again = await edit(model.id, { instruction: "paint it again", target: "design" });
    check("an edit of an edited version starts", again.status === 201, JSON.stringify(again.json));
    const done2 = await untilDone(again.json.job.id);
    check("it finishes as a deeper version", done2?.status === "succeeded" && done2.model?.edit?.depth === 2 && done2.model.source_model_id === model.id, JSON.stringify(done2?.model?.edit));
    const file2 = done2?.model ? await call("GET", `/files/models/${done2.model.id}.glb`) : null;
    check("the mock gives the other colour the second time", designFromGlb(file2?.bytes ?? new Uint8Array())?.parts?.every((p) => p.color === "#5cb85c"));
    const undo = await call("DELETE", `/models/${model.id}`);
    check("undo (DELETE) removes the version and the one made from it", undo.status === 200 && (await call("GET", `/files/models/${model.id}.glb`)).status === 404 && (await call("GET", `/files/models/${done2?.model?.id}.glb`)).status === 404);
    const after = (await call("GET", `/projects/${project}`)).json?.project;
    check("the source stays and the project has no edited model", after?.models?.some((m) => m.id === seeded) && !after.models.some((m) => m.kind === "edited"));
    check("a root cannot be deleted", (await call("DELETE", `/models/${seeded}`)).status === 409);

    section("a mesh plan");
    const hunyuan = await seedModel(project, { provider: "hunyuan", prompt: "a rocking chair" });
    const plan = await edit(hunyuan, { instruction: "make the backrest taller", target: "mesh", mesh: PACKAGE });
    check("201 with the running job", plan.status === 201 && plan.json?.job?.edit?.target === "mesh", JSON.stringify(plan.json));
    const doneP = await untilDone(plan.json.job.id);
    check("the job succeeds without a model", doneP?.status === "succeeded" && doneP.model === null, JSON.stringify(doneP));
    check("the plan is in the job", doneP?.edit?.result?.target === "mesh" && doneP.edit.result.applied === true && doneP.edit.result.program?.ops?.[0]?.op === "recolor", JSON.stringify(doneP?.edit?.result));
    const payloadP = (await call("GET", `/projects/${project}`)).json?.project;
    check("a reload still has it (\"plan ready\")", payloadP?.jobs?.find((j) => j.id === plan.json.job.id)?.edit?.result?.program?.ops?.length === 1);
    const stagedP = await listObjects("llm/");
    const taskP = (await sql(`SELECT provider_task_id AS t FROM jobs WHERE id = ${q(plan.json.job.id)}`))?.[0]?.t;
    if (stagedP && taskP) check("the pictures and the record are gone", !stagedP.some((k) => k.includes(taskP)), stagedP.join(","));
    check("a pictures package with a web address is refused (400)", (await edit(hunyuan, { instruction: "x", target: "mesh", mesh: { ...PACKAGE, views: [{ ...PACKAGE.views[0], image: "https://evil.example/a.png" }] } })).status === 400);
    check("a design edit of a Hunyuan model is refused (409)", (await edit(hunyuan, { instruction: "x", target: "design" })).status === 409);

    section("the caps");
    const capProject = await newProject();
    const capSource = await seedModel(capProject);
    for (let i = 0; i < MAX_VERSIONS_PER_SOURCE; i++) {
        await sql(`INSERT INTO models (id, project_id, job_id, provider, prompt, glb_key, size_bytes, created_at, kind, source_model_id, assembly_hash) VALUES (${q(crypto.randomUUID())}, ${q(capProject)}, 'j', 'stabilizer', 'p', 'models/x.glb', 1, ${q(new Date().toISOString())}, 'stabilized', ${q(capSource)}, ${q(`h${i}`)})`);
    }
    check("the 11th version of a model is refused (429)", (await edit(capSource, { instruction: "paint it", target: "design" })).status === 429);
    const before = (await sql(`SELECT llm FROM usage WHERE day = ${q(today())}`))?.[0]?.llm ?? 0;
    await sql(`INSERT INTO usage (day, llm) VALUES (${q(today())}, 400) ON CONFLICT (day) DO UPDATE SET llm = 400`);
    const capped = await edit(await seedModel(await newProject()), { instruction: "paint it", target: "design" });
    check("the day's cap of AI calls is a 429 with a plain message", capped.status === 429 && /limit of AI edits/.test(capped.json?.error ?? ""), JSON.stringify(capped.json));
    await sql(`UPDATE usage SET llm = ${before} WHERE day = ${q(today())}`);
}

// The projects go to the bin and are purged (their files with them).
if (createdProjects.length > 0) {
    await call("POST", "/projects/bulk", { ids: createdProjects, action: "trash" }).catch(() => {});
    await call("POST", "/projects/bulk", { ids: createdProjects, action: "purge" }).catch(() => {});
}

console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ""}${notes.length ? ` (${notes.length} note${notes.length === 1 ? "" : "s"})` : ""}`);
if (failures.length) {
    for (const name of failures) console.log(`  FAILED: ${name}`);
    process.exit(1);
}
