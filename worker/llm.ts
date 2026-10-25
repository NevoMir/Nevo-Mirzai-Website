// The queue consumer of the Muse assembly designer (see providers/openrouter.ts for the other half and the R2 protocol).
//
// One message = one object to design. The consumer asks OpenRouter for a JSON list of named primitive parts (strict json_schema,
// reasoning effort "low", ~20 s and ~$0.001), repairs and normalises it (shared/partsDesign.ts), builds the GLB
// (shared/partsGlb.ts) and leaves llm/<taskId>.glb plus a status record in the bucket for the job engine to pick up.
//
// Why a queue: the waiting (20-60 s) does not fit a Free-plan request (10 ms CPU, 30 s waitUntil). Cloudflare documents no CPU
// exemption for Free-plan consumers (only the wall clock is generous), so treat the 10 ms as binding here too. What the consumer
// spends CPU on (parse, repair, GLB writing) measured about 4-5 ms in a cold Node process for 60 parts (0.5 ms warm); confirm on
// the deployed Worker with `wrangler tail` or Workers Logs (cpuTime, outcome exceededCpu).
//
// Money: the paid answer is saved before anything else is done with it. The repaired design goes into the "building" record, and a
// delivery that finds such a record builds from it instead of calling OpenRouter again. So a crash, a CPU kill or an R2 hiccup after
// the answer costs another build, never another call.
//
// The same consumer also runs the edit tasks of spec 3.3: a DESIGN edit (read the source GLB, ask for a patch, apply it, build the new GLB) and the
// PLAN of a MESH edit (read the pictures from llm/<taskId>.in.json, ask for an edit program, clean it, leave it in the status record: no file). A
// task is a `Prepared` (the request and what to make of the answer); everything around the call (retries, 429, cut-off answers, "save the paid answer
// first", Stop) is shared. An edit also holds one slot of the day's AI-call cap (usage.llm, taken when the job started); the consumer hands it back
// when the task ends without the model having been charged (a refusal, a moderation block, a rejected key, Stop before the call).
//
// Retries: transient failures (network, 5xx, an empty or unreadable answer) are tried once more; a 429 is retried with a delay up to
// the queue's own limit (max_retries 2); an answer cut off by max_tokens is tried once more with a request that asks for a smaller
// design. Everything else fails the task at once with a message fit for the user.

import type { EditResult, MeshPackage, MeshView } from "../src/assignment/shared/contract.ts";
import { MESH_PROGRAM_SCHEMA, MESH_SYSTEM_PROMPT, REFINE_USER_TEXT, flatAnswerOf, meshUserText, sanitizeProgram } from "../src/assignment/shared/meshProgram.ts";
import { MUSE_SCHEMA, MUSE_SYSTEM_PROMPT, repairDesign, type PartsDesign } from "../src/assignment/shared/partsDesign.ts";
import { EDIT_PATCH_SCHEMA, EDIT_SYSTEM_PROMPT, boundNotes, designFromGlb, designHash, editDesign, editUserMessage } from "../src/assignment/shared/partsEdit.ts";
import { buildPartsGlb } from "../src/assignment/shared/partsGlb.ts";
import { refundLlmSlot, wasCharged } from "./llmCall.ts";
import { mockDesignPatch, mockLlmEnabled, mockMeshProgram } from "./providers/mock.ts";
import { PLAN_LIMIT, llmKey, readRecord, type EditRecord, type LlmRecord, type LlmUsage } from "./providers/openrouter.ts";
import {
    asNumber,
    asString,
    failure,
    isRecord,
    type Env,
    type FailureKind,
    type LlmJob,
    type VendorInfo,
    type VendorReply,
} from "./providers/types.ts";
import { errorSummary } from "./util.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFERER = "https://nevomirzai.com/assignment_alex";
const TITLE = "Assembly Studio";
const REQUEST_TIMEOUT_MS = 150_000;
const MAX_TOKENS = 16_000;
/** An edit answer is a patch or a short program: 8000 tokens leave room for the reasoning (measured 400 to 3200 tokens at effort "low"). */
const EDIT_MAX_TOKENS = 8_000;
const REASONING_EFFORT = "low"; // measured: ~21 s and valid JSON; effort unset took ~58 s and ran out of tokens
/** Deliveries a message gets (wrangler.jsonc: max_retries 2). */
const MAX_DELIVERIES = 3;
/** A bad or empty design is tried once more; only a 429 uses the remaining deliveries. */
const MAX_DESIGN_DELIVERIES = 2;
const GLB_CONTENT_TYPE = "model/gltf-binary";
/** Added to the instructions of the second try after an answer was cut off at max_tokens: the same request would be cut off again. */
const SIMPLIFY_HINT = " Your previous answer was too long to finish. Keep this one short: at most 16 parts, simple shapes, short names.";
const SIMPLIFY_EDIT_HINT = " Your previous answer was too long to finish. Keep this one short: change as few parts as you can and do only what the instruction asks.";
const SIMPLIFY_MESH_HINT = " Your previous answer was too long to finish. Keep this one short: as few operations as you can, and a short summary.";
/** Appears in the reply to a request that kept running out of room (also the text a user reads). */
const RAN_OUT = "The model ran out of room before it finished the design. Try a simpler prompt.";
const RAN_OUT_EDIT = "The model ran out of room before it finished the edit. Try a simpler instruction.";
/** The source GLB of a design edit is 10 to 40 KB; a file much bigger is not a parts design. */
const MAX_SOURCE_BYTES = 1024 * 1024;
const MODEL_KEY = /^models\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.glb$/;

const OPENROUTER: VendorInfo = {
    name: "OpenRouter",
    authScheme: "Bearer",
    billingUrl: "openrouter.ai/settings/credits",
    classify(reply: VendorReply): FailureKind | null {
        // 403 is "your input was flagged by moderation"; the body names the reasons.
        if (reply.status !== 403) return null;
        const error = reply.body && isRecord(reply.body.error) ? reply.body.error : null;
        const meta = error && isRecord(error.metadata) ? error.metadata : null;
        const message = error ? (asString(error.message) ?? "") : "";
        return meta?.reasons !== undefined || /moderat|flagged/i.test(message) ? "content" : null;
    },
};

// ---------- what a task is ----------

/** The strict JSON schema OpenRouter is asked to follow (response_format.json_schema). */
interface JsonSchema {
    readonly name: string;
    readonly strict: boolean;
    readonly schema: object;
}

/** A call to the model: the system prompt, the turns after it (already in OpenRouter's message format) and the schema. */
interface ModelRequest {
    system: string;
    messages: unknown[];
    schema: JsonSchema;
    maxTokens: number;
    /** What the person reads when the model's answer is unusable or cut off. */
    words: { unreadable: string; ranOut: string };
}

/** What a task makes of an answer: a design to build into a GLB, or a result that needs no file (a mesh plan, an edit that changed nothing). */
type Made =
    | { type: "design"; design: PartsDesign; notes: string[]; dropped: number; edit?: EditRecord }
    | { type: "plan"; plan: EditResult };

type Digest = { ok: true; made: Made } | { ok: false; error: string; retry: boolean };

/** One task, ready to run: the request, how to read the answer, and the canned answer of the offline demo. */
interface Prepared {
    request: ModelRequest;
    finish(raw: unknown): Promise<Digest>;
    mock(): unknown;
}

// ---------- the OpenRouter call ----------

type Outcome =
    | { kind: "ok"; made: Made; usage: LlmUsage }
    /** `simplify`: the next try should ask for less (this one was cut off at max_tokens). */
    | { kind: "retry"; error: string; delaySeconds: number; rate: boolean; usage: LlmUsage | null; simplify?: boolean }
    | { kind: "fail"; error: string; usage: LlmUsage | null };

const NO_USAGE: LlmUsage = { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, cost_usd: null };

function usageOf(body: Record<string, unknown> | null): LlmUsage {
    const usage = body && isRecord(body.usage) ? body.usage : null;
    if (!usage) return NO_USAGE;
    const details = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null;
    const cost = asNumber(usage.cost);
    return {
        prompt_tokens: asNumber(usage.prompt_tokens),
        completion_tokens: asNumber(usage.completion_tokens),
        reasoning_tokens: details ? asNumber(details.reasoning_tokens) : null,
        cost_usd: cost !== null && cost >= 0 ? cost : null,
    };
}

/** True when the model may have been charged for this reply: it said so (the rule of llmCall.ts wasCharged), or there is no reply to tell (a dropped connection). */
function maybeCharged(usage: LlmUsage | null): boolean {
    return usage === null || wasCharged(usage);
}

/** Longer answers are only tried as a whole: max_tokens keeps a real design far below this, and the fallbacks below scan the text. */
const MAX_SCANNED_CHARS = 200_000;

function tryParse(candidate: string): unknown {
    try {
        return JSON.parse(candidate);
    } catch {
        return undefined;
    }
}

/**
 * The design JSON out of the model's text: the whole text, a ```json block, or the outermost {...}. Each way is tried only when
 * the one before failed. The fence pattern has no whitespace matcher of its own (the trim after it does that job), so it cannot
 * backtrack on a long run of blanks; an answer that ends in one costs a linear scan, not a quadratic one.
 */
export function extractJson(text: string): unknown {
    const whole = tryParse(text.trim());
    if (whole !== undefined || text.length > MAX_SCANNED_CHARS) return whole;
    const fenced = /```(?:json)?([\s\S]*?)```/i.exec(text);
    if (fenced) {
        const inside = tryParse(fenced[1].trim());
        if (inside !== undefined) return inside;
    }
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    return open >= 0 && close > open ? tryParse(text.slice(open, close + 1)) : undefined;
}

function secondsFrom(headers: Headers, fallback: number): number {
    const wait = Number(headers.get("retry-after"));
    return Math.min(60, Math.max(5, Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : fallback));
}

/**
 * One OpenRouter call -> what to do next. Never throws for anything the vendor can say, nor for anything it says that the
 * repair cannot digest: a deterministic failure after the answer must end the task, not be paid for a second time.
 * With the offline demo (MOCK_PROVIDER=1) an edit task is answered from `task.mock()` and nothing is sent.
 */
async function askOnce(env: Env, key: string, job: LlmJob, attempt: number, task: Prepared): Promise<Outcome> {
    const { request } = task;
    let raw: unknown;
    let usage: LlmUsage;
    if (job.edit && mockLlmEnabled(env)) {
        raw = task.mock();
        usage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
    } else {
        let reply: VendorReply;
        try {
            const res = await fetch(OPENROUTER_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${key}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "HTTP-Referer": REFERER,
                    "X-Title": TITLE,
                },
                body: JSON.stringify({
                    model: job.model,
                    messages: [{ role: "system", content: request.system }, ...request.messages],
                    response_format: { type: "json_schema", json_schema: request.schema },
                    reasoning: { effort: REASONING_EFFORT },
                    max_tokens: request.maxTokens,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const text = await res.text();
            let body: Record<string, unknown> | null = null;
            try {
                const parsed: unknown = JSON.parse(text);
                body = isRecord(parsed) ? parsed : null;
            } catch {
                // not JSON (a proxy's error page, an empty reply): body stays null
            }
            reply = { status: res.status, headers: res.headers, body, text };
        } catch (err) {
            const timedOut = typeof err === "object" && err !== null && "name" in err && err.name === "TimeoutError";
            return {
                kind: "retry",
                error: timedOut ? "OpenRouter did not answer in time. Please try again." : "Could not reach OpenRouter. Please try again.",
                delaySeconds: 5,
                rate: false,
                usage: null,
            };
        }

        // An error can also arrive inside a 200 ({"error": {"code": 502, ...}}): treat its code as the status.
        const inner = reply.body && isRecord(reply.body.error) ? reply.body.error : null;
        const status = reply.status >= 400 ? reply.status : inner ? (asNumber(inner.code) ?? 502) : reply.status;
        if (status >= 400) {
            const problem = failure(OPENROUTER, { ...reply, status }, "submit", key);
            const spent = usageOf(reply.body);
            if (status === 429) {
                return { kind: "retry", error: problem.message, delaySeconds: secondsFrom(reply.headers, 15 * attempt), rate: true, usage: spent };
            }
            if (status === 408 || status >= 500) {
                return { kind: "retry", error: problem.message, delaySeconds: 5, rate: false, usage: spent };
            }
            return { kind: "fail", error: problem.message, usage: spent };
        }

        usage = usageOf(reply.body);
        const choice = reply.body && Array.isArray(reply.body.choices) && isRecord(reply.body.choices[0]) ? reply.body.choices[0] : null;
        const message = choice && isRecord(choice.message) ? choice.message : null;
        const refusal = message ? asString(message.refusal) : null;
        if (refusal) {
            return { kind: "fail", error: `The model declined this request: ${refusal.replace(/\s+/g, " ").slice(0, 200)}`, usage };
        }
        const finish = choice ? asString(choice.finish_reason) : null;
        if (finish === "content_filter") {
            return { kind: "fail", error: "The model's safety filter blocked this prompt. Try rewording it.", usage };
        }
        const content = message && typeof message.content === "string" ? message.content : "";
        // Why an answer is missing says what to do about it: a cut-off is asked again for less, a provider error is plain bad luck.
        if (finish === "length") {
            return { kind: "retry", error: request.words.ranOut, delaySeconds: 2, rate: false, usage, simplify: true };
        }
        if (finish === "error") {
            return { kind: "retry", error: "The model's provider reported an error. Please try again.", delaySeconds: 5, rate: false, usage };
        }
        if (content.trim() === "") {
            return { kind: "retry", error: "The model returned an empty answer. Please try again.", delaySeconds: 2, rate: false, usage };
        }
        raw = extractJson(content);
        if (raw === undefined) {
            return { kind: "retry", error: request.words.unreadable, delaySeconds: 2, rate: false, usage };
        }
    }

    let digest: Digest;
    try {
        digest = await task.finish(raw);
    } catch (err) {
        // A bug or an answer nobody foresaw: asking again would only pay for the same surprise.
        console.error(`muse ${job.taskId.slice(0, 8)} repair failed: ${errorSummary(err)}`);
        const what = job.edit ? "an edit" : "a design";
        return { kind: "fail", error: `The model returned ${what} the app could not process. Please try again or reword the request.`, usage };
    }
    if (!digest.ok) {
        return digest.retry
            ? { kind: "retry", error: digest.error, delaySeconds: 2, rate: false, usage }
            : { kind: "fail", error: digest.error, usage };
    }
    return { kind: "ok", made: digest.made, usage };
}

// ---------- the tasks ----------

/** A new object from a prompt (the original job of this queue). */
function prepareGenerate(job: LlmJob, simplify: boolean): Prepared {
    return {
        request: {
            system: simplify ? MUSE_SYSTEM_PROMPT + SIMPLIFY_HINT : MUSE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: job.prompt }],
            schema: MUSE_SCHEMA,
            maxTokens: MAX_TOKENS,
            words: { unreadable: "The model returned a design the app could not read. Please try again.", ranOut: RAN_OUT },
        },
        async finish(raw) {
            const repaired = repairDesign(raw);
            if (!repaired.design) return { ok: false, error: "The model returned no usable parts. Try again or reword the prompt.", retry: true };
            return { ok: true, made: { type: "design", design: repaired.design, notes: repaired.notes, dropped: repaired.dropped } };
        },
        mock: () => undefined,
    };
}

type Failure = { error: string };
const isFailure = (value: Prepared | Failure): value is Failure => "error" in value;

/** A change to a Muse parts design: read the source GLB, ask for a patch, apply it. */
async function prepareDesignEdit(job: LlmJob, env: Env, simplify: boolean): Promise<Prepared | Failure> {
    const edit = job.edit;
    if (edit?.target !== "design") return { error: "This edit task is not one the server knows." };
    const object = await env.FILES.get(edit.source_glb_key); // a bucket error throws: the message is delivered again
    if (!object) return { error: "The model you wanted to change is no longer available." };
    if (object.size > MAX_SOURCE_BYTES) return { error: "This model's parts can't be read, so it can't be edited here." };
    const design = designFromGlb(new Uint8Array(await object.arrayBuffer()));
    if (!design) return { error: "This model's parts can't be read, so it can't be edited here." };
    return {
        request: {
            system: simplify ? EDIT_SYSTEM_PROMPT + SIMPLIFY_EDIT_HINT : EDIT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: editUserMessage(design, job.prompt, edit.original_prompt) }],
            schema: EDIT_PATCH_SCHEMA,
            maxTokens: EDIT_MAX_TOKENS,
            words: { unreadable: "The model returned an edit the app could not read. Please try again.", ranOut: RAN_OUT_EDIT },
        },
        async finish(raw) {
            const result = editDesign(design, raw);
            if (!result.ok) return { ok: false, error: result.error, retry: true };
            if (!result.applied) {
                return { ok: true, made: { type: "plan", plan: { target: "design", applied: false, summary: result.summary, notes: result.notes, changes: result.changes } } };
            }
            const hash = await designHash(result.design);
            return {
                ok: true,
                made: {
                    type: "design",
                    design: result.design,
                    notes: result.notes,
                    dropped: 0,
                    edit: { summary: result.summary, changes: result.changes, notes: result.notes, hash },
                },
            };
        },
        mock: () => mockDesignPatch(design),
    };
}

/** What the browser stored for a mesh plan (worker/edit.ts has validated it; this reads it again defensively). */
interface MeshInput {
    pkg: Pick<MeshPackage, "facts" | "views" | "pieces" | "extras" | "original_prompt">;
    refine: { program: unknown; views: MeshView[] } | null;
}

const IMAGE_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/;

function viewsOf(value: unknown): MeshView[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > 6) return null;
    const views: MeshView[] = [];
    for (const view of value) {
        if (!isRecord(view) || typeof view.id !== "string" || typeof view.caption !== "string" || typeof view.image !== "string" || !IMAGE_URL.test(view.image)) return null;
        views.push({ id: view.id, caption: view.caption, image: view.image });
    }
    return views;
}

function readMeshInput(text: string): MeshInput | null {
    const parsed = tryParse(text);
    if (!isRecord(parsed) || !isRecord(parsed.package)) return null;
    const pkg = parsed.package;
    const views = viewsOf(pkg.views);
    if (typeof pkg.facts !== "string" || !views) return null;
    let refine: MeshInput["refine"] = null;
    if (parsed.refine !== null && parsed.refine !== undefined) {
        const zoom = isRecord(parsed.refine) ? viewsOf(parsed.refine.views) : null;
        if (!isRecord(parsed.refine) || !zoom) return null;
        refine = { program: parsed.refine.program, views: zoom };
    }
    const optional = (value: unknown): string | null => (typeof value === "string" ? value : null);
    return {
        pkg: { facts: pkg.facts, views, pieces: optional(pkg.pieces), extras: optional(pkg.extras), original_prompt: optional(pkg.original_prompt) },
        refine,
    };
}

/** The plan of an edit of a fused mesh: three labelled pictures and the facts go to the model, a cleaned program comes back. No file is made. */
async function prepareMeshPlan(job: LlmJob, env: Env, simplify: boolean): Promise<Prepared | Failure> {
    const edit = job.edit;
    if (edit?.target !== "mesh") return { error: "This edit task is not one the server knows." };
    const object = await env.FILES.get(edit.package_key);
    if (!object) return { error: "The pictures of the model are no longer available. Please try again." };
    const input = readMeshInput(await object.text());
    if (!input) return { error: "The pictures of the model could not be read. Please try again." };

    const picture = (view: MeshView) => ({ type: "image_url", image_url: { url: view.image } });
    let messages: unknown[];
    if (edit.refine && input.refine) {
        // The first program as the model itself answers (the flat strict shape, cleaned), not the editor's internal form of it.
        const first = sanitizeProgram(input.refine.program);
        const firstAnswer = first.ok ? flatAnswerOf(first.program, first.regen_prompt) : input.refine.program;
        messages = [
            { role: "user", content: `${input.pkg.facts}\n(pictures omitted in this history; they were the plain FRONT, SIDE and TOP views)\n\nEdit instruction: ${JSON.stringify(job.prompt)}` },
            { role: "assistant", content: JSON.stringify(firstAnswer) },
            { role: "user", content: [{ type: "text", text: `${REFINE_USER_TEXT}\n${input.refine.views.map((v) => v.caption).join("\n")}` }, ...input.refine.views.map(picture)] },
        ];
    } else {
        messages = [{ role: "user", content: [{ type: "text", text: meshUserText(input.pkg, job.prompt) }, ...input.pkg.views.map(picture)] }];
    }
    return {
        request: {
            system: simplify ? MESH_SYSTEM_PROMPT + SIMPLIFY_MESH_HINT : MESH_SYSTEM_PROMPT,
            messages,
            schema: MESH_PROGRAM_SCHEMA,
            maxTokens: EDIT_MAX_TOKENS,
            words: { unreadable: "The model returned a plan the app could not read. Please try again.", ranOut: RAN_OUT_EDIT },
        },
        async finish(raw) {
            const cleaned = sanitizeProgram(raw);
            if (!cleaned.ok) return { ok: false, error: "The model's plan had nothing the app could run. Try again or reword the request.", retry: true };
            const { program } = cleaned;
            const plan: EditResult = {
                target: "mesh",
                applied: program.applied,
                summary: program.summary,
                notes: boundNotes(cleaned.notes),
                program,
                ...(cleaned.regen_prompt ? { regen_prompt: cleaned.regen_prompt } : {}),
            };
            if (JSON.stringify(plan).length > PLAN_LIMIT) return { ok: false, error: "The model's plan was too long to keep. Try a simpler request.", retry: false };
            return { ok: true, made: { type: "plan", plan } };
        },
        mock: () => mockMeshProgram(),
    };
}

/** The task a queue message asks for, or why it cannot be run. */
function prepare(job: LlmJob, env: Env, simplify: boolean): Promise<Prepared | Failure> {
    if (job.edit?.target === "design") return prepareDesignEdit(job, env, simplify);
    if (job.edit?.target === "mesh") return prepareMeshPlan(job, env, simplify);
    return Promise.resolve(prepareGenerate(job, simplify));
}

// ---------- the bucket side ----------

async function writeRecord(env: Env, taskId: string, record: LlmRecord): Promise<void> {
    await env.FILES.put(llmKey(taskId, "json"), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
}

async function wasCanceled(env: Env, taskId: string): Promise<boolean> {
    return (await env.FILES.head(llmKey(taskId, "cancel")).catch(() => null)) !== null;
}

/** Removes the staging files of a task nobody wants any more (and the marker that said so). */
async function dropStaging(env: Env, taskId: string): Promise<void> {
    await env.FILES.delete([llmKey(taskId, "json"), llmKey(taskId, "glb"), llmKey(taskId, "cancel"), llmKey(taskId, "in")]).catch(() => {});
}

function parseJob(body: unknown): LlmJob | null {
    if (!isRecord(body)) return null;
    const { taskId, prompt, model } = body;
    if (typeof taskId !== "string" || typeof prompt !== "string" || typeof model !== "string") return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId) || prompt.trim() === "" || model === "") return null;
    const job: LlmJob = { taskId, prompt, model };
    const edit = body.edit;
    if (edit === undefined) return job;
    if (!isRecord(edit)) return null;
    if (edit.target === "design" && typeof edit.source_glb_key === "string" && MODEL_KEY.test(edit.source_glb_key)) {
        job.edit = { target: "design", source_glb_key: edit.source_glb_key };
        if (typeof edit.original_prompt === "string" && edit.original_prompt !== "") job.edit.original_prompt = edit.original_prompt.slice(0, 300);
        return job;
    }
    // The pictures are always the task's own file: a message cannot point the consumer at another object of the bucket.
    if (edit.target === "mesh" && edit.package_key === llmKey(taskId, "in")) {
        job.edit = { target: "mesh", package_key: edit.package_key, ...(edit.refine === true ? { refine: true } : {}) };
        return job;
    }
    return null;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** One line per attempt in the Worker's log: no prompt, no key. */
function logAttempt(taskId: string, attempt: number, what: string, ms: number, usage: LlmUsage | null, edit?: string): void {
    const cost = usage?.cost_usd != null ? ` cost=$${usage.cost_usd}` : "";
    const tokens = usage?.completion_tokens != null ? ` out=${usage.completion_tokens}` : "";
    console.log(`muse ${taskId.slice(0, 8)}${edit ? ` ${edit}-edit` : ""} attempt=${attempt} ${what} ${ms}ms${tokens}${cost}`);
}

interface QueueMessage {
    readonly body: unknown;
    readonly attempts: number;
    ack(): void;
    retry(options?: { delaySeconds?: number }): void;
}

/** A design OpenRouter has been paid for: what is built into the GLB and kept in the status record. */
interface Answer {
    design: PartsDesign;
    notes: string[];
    dropped: number;
    usage: LlmUsage | null;
    edit?: EditRecord;
}

/**
 * What a delivery knows about the money and the paid answer. It lives outside processMessage so the caller can still use it when
 * an exception escapes: the failure it reports should carry the cost, and a saved answer makes another delivery cheap.
 */
interface Ledger {
    /** USD spent on the task so far (previous deliveries and this one). */
    cost: number;
    /** The paid design is in the bucket (or was found there): another delivery builds it instead of asking OpenRouter again. */
    saved: boolean;
    /** The model may have been charged by some attempt (see maybeCharged): an edit's daily slot is kept then. */
    charged: boolean;
}

/** The design a previous delivery already paid for, from its "building" record; null when there is none to build from. */
function savedAnswer(previous: LlmRecord | null): Answer | null {
    if (previous?.status !== "building" || !previous.design) return null;
    const { design } = previous;
    if (!Array.isArray(design.parts) || design.parts.length === 0) return null;
    return { design, notes: previous.notes ?? [], dropped: previous.dropped ?? 0, usage: previous.usage ?? null, ...(previous.edit ? { edit: previous.edit } : {}) };
}

/** An edit holds one slot of the day's AI-call cap from the moment it starts; it goes back when the model was never charged for it. */
async function releaseSlot(env: Env, job: LlmJob, ledger: Ledger): Promise<void> {
    if (job.edit && !ledger.charged) await refundLlmSlot(env);
}

async function processMessage(message: QueueMessage, env: Env, ledger: Ledger): Promise<void> {
    const job = parseJob(message.body);
    if (!job) {
        message.ack(); // malformed: retrying cannot fix it
        return;
    }
    const { taskId } = job;
    const attempt = message.attempts;
    const editKind = job.edit?.target;
    const mock = job.edit !== undefined && mockLlmEnabled(env);

    const previous = await readRecord(env, taskId).catch(() => null);
    ledger.charged = job.edit !== undefined && (previous?.charged === true || (previous?.cost_usd ?? 0) > 0);
    if (await wasCanceled(env, taskId)) {
        await releaseSlot(env, job, ledger);
        await dropStaging(env, taskId);
        message.ack();
        return;
    }
    if (previous?.status === "done" || previous?.status === "failed") {
        message.ack(); // the same task delivered again after it finished
        return;
    }
    const spentBefore = previous?.cost_usd ?? 0;
    ledger.cost = spentBefore;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    /** Ends the task with a message for the person; the slot goes back when the model was not charged. The record goes first: a crash after it never refunds twice. */
    const fail = async (error: string, spent: number, elapsed: number | undefined): Promise<void> => {
        await writeRecord(env, taskId, {
            status: "failed",
            error,
            attempt,
            model: job.model,
            finished_at: new Date().toISOString(),
            ...(elapsed !== undefined ? { elapsed_ms: elapsed } : {}),
            ...(spent > 0 ? { cost_usd: spent } : {}),
            ...(ledger.charged ? { charged: true } : {}),
        });
        await releaseSlot(env, job, ledger);
        message.ack();
    };

    let answer = savedAnswer(previous);
    let spent = spentBefore;
    let elapsedBefore = 0;
    let done: Made | null = null; // a result that needs no file
    let usage: LlmUsage | null = null;
    if (answer) {
        // An earlier delivery got the answer and then stopped (a bucket error, a crash while building): build it, do not pay again.
        ledger.saved = true;
        elapsedBefore = previous?.elapsed_ms ?? 0;
        logAttempt(taskId, attempt, "resumed", 0, null, editKind);
    } else {
        const key = env.OPENROUTER_API_KEY?.trim() ?? "";
        if (!key && !mock) {
            await fail(job.edit ? "The AI editor is not configured on the server (OpenRouter key missing)." : "The designer is not configured on the server (OpenRouter key missing).", 0, undefined);
            return;
        }
        const simplify = previous?.simplify === true;
        const charged = () => (ledger.charged ? { charged: true } : {});
        await writeRecord(env, taskId, { status: "designing", attempt, model: job.model, started_at: startedAt, cost_usd: spentBefore, ...(simplify ? { simplify } : {}), ...charged() });

        const task = await prepare(job, env, simplify);
        if (isFailure(task)) {
            logAttempt(taskId, attempt, "failed (no input)", Date.now() - t0, null, editKind);
            await fail(task.error, spentBefore, Date.now() - t0);
            return;
        }
        const outcome = await askOnce(env, key, job, attempt, task);
        spent = round6(spentBefore + (outcome.usage?.cost_usd ?? 0));
        ledger.cost = spent;
        if (job.edit && !mock && maybeCharged(outcome.usage)) ledger.charged = true; // only an edit has a daily slot to keep or hand back
        const elapsed = Date.now() - t0;

        if (outcome.kind === "fail") {
            logAttempt(taskId, attempt, "failed", elapsed, outcome.usage, editKind);
            await fail(outcome.error, spent, elapsed);
            return;
        }

        if (outcome.kind === "retry") {
            // A cut-off answer that has not yet been asked for less always gets that try, even after a 429 used up a delivery.
            const retries = outcome.rate || (outcome.simplify === true && !simplify) ? MAX_DELIVERIES : MAX_DESIGN_DELIVERIES;
            const allowed = attempt < retries;
            logAttempt(taskId, attempt, allowed ? "retry" : "gave up", elapsed, outcome.usage, editKind);
            if (allowed) {
                const next = simplify || outcome.simplify === true;
                await writeRecord(env, taskId, { status: "designing", attempt, model: job.model, started_at: startedAt, cost_usd: spent, ...(next ? { simplify: next } : {}), ...charged() });
                message.retry({ delaySeconds: outcome.delaySeconds });
            } else {
                await fail(outcome.error, spent, elapsed);
            }
            return;
        }
        usage = outcome.usage;
        if (outcome.made.type === "design") {
            answer = { design: outcome.made.design, notes: outcome.made.notes, dropped: outcome.made.dropped, usage: outcome.usage, ...(outcome.made.edit ? { edit: outcome.made.edit } : {}) };
        } else {
            done = outcome.made;
        }
    }

    // The model answered: keep the answer, then build the file.
    if (await wasCanceled(env, taskId)) {
        logAttempt(taskId, attempt, "canceled", Date.now() - t0, usage ?? answer?.usage ?? null, editKind);
        await dropStaging(env, taskId);
        message.ack();
        return;
    }
    const charged = ledger.charged ? { charged: true } : {};
    if (done?.type === "plan") {
        // Nothing to build (a mesh plan, or an edit that changed nothing): the result is the record, and the job engine copies it into the job.
        const elapsed = Date.now() - t0;
        await writeRecord(env, taskId, {
            status: "done",
            attempt,
            model: job.model,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            elapsed_ms: elapsed,
            plan: done.plan,
            usage: usage ?? undefined,
            cost_usd: spent,
            ...charged,
        });
        logAttempt(taskId, attempt, `done plan applied=${done.plan.applied}`, elapsed, usage, editKind);
        message.ack();
        return;
    }
    if (!answer) throw new Error("no answer to build");
    if (!ledger.saved) {
        await writeRecord(env, taskId, {
            status: "building",
            attempt,
            model: job.model,
            started_at: startedAt,
            elapsed_ms: Date.now() - t0,
            design: answer.design,
            notes: answer.notes,
            dropped: answer.dropped,
            usage: answer.usage ?? undefined,
            cost_usd: spent,
            ...(answer.edit ? { edit: answer.edit } : {}),
            ...charged,
        });
        ledger.saved = true;
    }
    let glb: Uint8Array;
    try {
        glb = buildPartsGlb(answer.design);
    } catch (err) {
        console.error(`muse ${taskId.slice(0, 8)} build failed: ${errorSummary(err)}`);
        await fail("The designed parts could not be built into a model. Please try again.", spent, elapsedBefore + Date.now() - t0);
        return;
    }
    await env.FILES.put(llmKey(taskId, "glb"), glb, { httpMetadata: { contentType: GLB_CONTENT_TYPE } });
    const elapsed = elapsedBefore + Date.now() - t0;
    // The record goes last: the job engine only looks at the file once it says "done".
    await writeRecord(env, taskId, {
        status: "done",
        attempt,
        model: job.model,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        elapsed_ms: elapsed,
        design: answer.design,
        notes: answer.notes,
        dropped: answer.dropped,
        size_bytes: glb.byteLength,
        usage: answer.usage ?? undefined,
        cost_usd: spent,
        ...(answer.edit ? { edit: answer.edit } : {}),
        ...charged,
    });
    logAttempt(taskId, attempt, `done parts=${answer.design.parts.length} bytes=${glb.byteLength}`, elapsed, answer.usage, editKind);
    message.ack();
}

/** The Worker's queue() handler. A message is always answered (ack or retry); nothing escapes. */
export async function handleLlmBatch(batch: { readonly messages: readonly QueueMessage[] }, env: Env): Promise<void> {
    for (const message of batch.messages) {
        const ledger: Ledger = { cost: 0, saved: false, charged: false };
        try {
            await processMessage(message, env, ledger);
        } catch (err) {
            // Unexpected (a bucket error, a bug): give the message another delivery, then report the failure. With the paid
            // answer in the bucket another delivery costs only a build, so it may use all the deliveries the queue offers.
            console.error(`muse queue error (attempt ${message.attempts}): ${errorSummary(err)}`);
            if (message.attempts < (ledger.saved ? MAX_DELIVERIES : MAX_DESIGN_DELIVERIES)) {
                message.retry({ delaySeconds: 5 });
                continue;
            }
            const job = parseJob(message.body);
            if (job) {
                await writeRecord(env, job.taskId, {
                    status: "failed",
                    error: "Something went wrong while designing the model. Please try again.",
                    attempt: message.attempts,
                    finished_at: new Date().toISOString(),
                    ...(ledger.cost > 0 ? { cost_usd: ledger.cost } : {}),
                    ...(ledger.charged ? { charged: true } : {}),
                }).catch(() => {});
                // After the record: a crash between the two never refunds twice. A failed refund leaves the slot used, the safe side.
                await releaseSlot(env, job, ledger).catch(() => {});
            }
            message.ack();
        }
    }
}
