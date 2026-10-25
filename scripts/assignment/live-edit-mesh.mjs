// A live check of the mesh editor against OpenRouter (Muse Spark): the REAL pictures and package of the editor (edit/describeMesh.ts), the
// real prompt, schema and cleaner (shared/meshProgram.ts), one call, then the answer is run on the model and written (edit/session.ts).
// Costs about $0.0005 to $0.001 a call. Reads OPENROUTER_API_KEY from .dev.vars and never prints it. Never calls Tencent.
//
//   node scripts/assignment/live-edit-mesh.mjs <case> "<instruction>" [--jpeg] [--out <dir>]
//   node scripts/assignment/live-edit-mesh.mjs <case>-zoom "<instruction>" --refine-of <first case> [--jpeg] [--out <dir>]
//
// The model is HUNYUAN_GLB (the local 27.8 MB rocking chair). Results go to <dir>/live-<case>.json (the answer, the cleaned program, the
// usage, the timings) and the edited file to <dir>/live-<case>.glb; a line per call is appended to <dir>/live-calls.jsonl.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.features.typescript && !process.execArgv.includes("--experimental-strip-types")) {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(run.status ?? 1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["--out", "--refine-of"].includes(args[i - 1])));
const [caseName, instruction] = positional;
if (!caseName || !instruction) {
    console.error('usage: node scripts/assignment/live-edit-mesh.mjs <case> "<instruction>" [--jpeg] [--refine-of <case>] [--out <dir>]');
    process.exit(2);
}
const OUT = resolve(option("--out") ?? "/private/tmp/claude-501/-Users-josephmirzai-Documents-Nevo-website/f150fdea-65e6-490a-bbdb-a687fe25ab2f/scratchpad/b2/live");
mkdirSync(OUT, { recursive: true });

const { openSession } = await import("../../src/assignment/edit/session.ts");
const { sanitizeProgram, meshUserText, MESH_SYSTEM_PROMPT, MESH_PROGRAM_SCHEMA, REFINE_USER_TEXT } = await import("../../src/assignment/shared/meshProgram.ts");
const { sharpCodec, readHunyuan, hasHunyuan, HUNYUAN_GLB } = await import("./edit-test-support.mjs");
if (!hasHunyuan()) {
    console.error(`no model at ${HUNYUAN_GLB}`);
    process.exit(2);
}

// The browser's canvas for the JPEG pictures (the editor encodes them with OffscreenCanvas): sharp stands in, the editor's own code path runs.
if (flag("--jpeg")) {
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
}

const vars = readFileSync(resolve(ROOT, ".dev.vars"), "utf8");
const KEY = /^OPENROUTER_API_KEY=(.*)$/m.exec(vars)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!KEY) {
    console.error("no OPENROUTER_API_KEY in .dev.vars");
    process.exit(2);
}
const MODEL = /^OPENROUTER_EDIT_MODEL=(.*)$/m.exec(vars)?.[1]?.trim().replace(/^["']|["']$/g, "") || "meta/muse-spark-1.3-contributor";

const t0 = performance.now();
const session = await openSession(readHunyuan(), await sharpCodec(), "a wooden rocking chair");
const format = flag("--jpeg") ? "jpeg" : "png";
const pkg = await session.describe(format);
const imageUrl = (view) => ({ type: "image_url", image_url: { url: view.image } });
const prepMs = Math.round(performance.now() - t0);

let messages;
let first = null;
if (option("--refine-of")) {
    const prior = JSON.parse(readFileSync(resolve(OUT, `live-${option("--refine-of")}.json`), "utf8"));
    first = prior;
    const views = await session.zoom(prior.program, format);
    const user1 = `${pkg.facts}\n(pictures omitted in this history; they were the plain FRONT, SIDE and TOP views)\n\nEdit instruction: ${instruction}`;
    messages = [
        { role: "system", content: MESH_SYSTEM_PROMPT },
        { role: "user", content: user1 },
        { role: "assistant", content: JSON.stringify(prior.answer) },
        { role: "user", content: [{ type: "text", text: `${REFINE_USER_TEXT}\n${views.map((v) => v.caption).join("\n")}` }, ...views.map(imageUrl)] },
    ];
} else {
    messages = [{ role: "system", content: MESH_SYSTEM_PROMPT }, { role: "user", content: [{ type: "text", text: meshUserText(pkg, instruction) }, ...pkg.views.map(imageUrl)] }];
}
if (process.env.DRY) {
    // Everything but the call: what would be sent.
    console.log(`DRY: ${messages.length} messages, ${messages.at(-1).content.length ?? 1} parts in the last, pictures ${pkg.views.map((v) => `${v.id} ${Math.round((v.image.length * 0.75) / 1024)} KB ${/^data:([^;]+)/.exec(v.image)?.[1]}`).join(", ")}, package ${Math.round(JSON.stringify(pkg).length / 1024)} KB, prepared in ${prepMs} ms`);
    console.log(typeof messages.at(-1).content === "string" ? messages.at(-1).content.slice(0, 600) : messages.at(-1).content[0].text.slice(0, 700));
    process.exit(0);
}
const body = { model: MODEL, messages, response_format: { type: "json_schema", json_schema: MESH_PROGRAM_SCHEMA }, reasoning: { effort: "low" }, max_tokens: 8000 };
const bodyBytes = JSON.stringify(body).length;

const started = Date.now();
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://nevomirzai.com/assignment_alex", "X-Title": "Assembly Studio (mesh edit check)" },
    body: JSON.stringify(body),
});
const j = await res.json().catch(() => ({}));
const ms = Date.now() - started;
const u = j.usage ?? {};
const record = { label: caseName, status: res.status, ms, model: MODEL, format, finish: j.choices?.[0]?.finish_reason, prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens, cost: u.cost, request_kb: Math.round(bodyBytes / 1024), error: j.error ? String(j.error.message ?? j.error.code ?? "error").slice(0, 200) : undefined };
appendFileSync(resolve(OUT, "live-calls.jsonl"), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify(record));
const content = j.choices?.[0]?.message?.content;
if (res.status !== 200 || typeof content !== "string") {
    console.error("no usable answer");
    process.exit(1);
}
let answer;
try {
    answer = JSON.parse(content);
} catch {
    console.error("the answer is not JSON:", content.slice(0, 300));
    process.exit(1);
}
const cleaned = sanitizeProgram(answer);
console.log("summary:", answer.summary, "| applied:", answer.applied, "| regen_prompt:", JSON.stringify(answer.regen_prompt));
for (const o of answer.ops ?? []) {
    console.log(" op", o.op, JSON.stringify({ label: o.label, boxes: o.boxes, exclude: o.exclude, feather: o.feather_mm, axis: o.axis, from: o.from_mm, to: o.to_mm, amount: o.amount_mm, deg: o.degrees, color: o.color, strength: o.strength, parts: o.parts?.length }));
}
if (!cleaned.ok) {
    console.log("cleaner:", cleaned.error);
    writeFileSync(resolve(OUT, `live-${caseName}.json`), JSON.stringify({ record, answer, cleaned }, null, 1));
    process.exit(0);
}
console.log("cleaner notes:", JSON.stringify(cleaned.notes));
let output = null;
let runError = null;
if (cleaned.program.applied && cleaned.program.ops.length > 0) {
    try {
        output = await session.run({ program: cleaned.program, instruction, jobId: null });
        writeFileSync(resolve(OUT, `live-${caseName}.glb`), output.glb);
        console.log(`ran: ${output.ms} ms, ${(output.glb.length / 1e6).toFixed(1)} MB, ${output.triangles} triangles, ${output.parts} parts, notes ${JSON.stringify(output.notes)}`);
        console.log("log:", JSON.stringify(output.log.map((l) => ({ op: l.op, ...Object.fromEntries(Object.entries(l).filter(([k, v]) => ["deleted", "capped", "moved", "copied", "added", "touched"].includes(k) && v !== undefined)) }))));
    } catch (e) {
        runError = `${e.code ?? ""} ${e.message}`.trim();
        console.log("run failed:", runError);
    }
}
writeFileSync(resolve(OUT, `live-${caseName}.json`), JSON.stringify({ record, prepMs, package: { facts: pkg.facts, kb: Math.round(JSON.stringify(pkg).length / 1024), views: pkg.views.map((v) => ({ id: v.id, kb: Math.round((v.image.length * 0.75) / 1024), mime: /^data:([^;]+)/.exec(v.image)?.[1] })) }, answer, program: cleaned.program, notes: cleaned.notes, regen_prompt: cleaned.regen_prompt, refinedFrom: first?.record?.label ?? null, runError, ran: output ? { ms: output.ms, bytes: output.glb.length, triangles: output.triangles, parts: output.parts, notes: output.notes } : null }, null, 1));
console.log(existsSync(resolve(OUT, `live-${caseName}.glb`)) ? `wrote live-${caseName}.json and .glb in ${OUT}` : `wrote live-${caseName}.json in ${OUT}`);
