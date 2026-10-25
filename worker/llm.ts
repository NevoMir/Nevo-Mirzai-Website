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
// Retries: transient failures (network, 5xx, an empty or unreadable answer) are tried once more; a 429 is retried with a delay up to
// the queue's own limit (max_retries 2); an answer cut off by max_tokens is tried once more with a request that asks for a smaller
// design. Everything else fails the task at once with a message fit for the user.

import { MUSE_SCHEMA, MUSE_SYSTEM_PROMPT, repairDesign, type PartsDesign } from "../src/assignment/shared/partsDesign.ts";
import { buildPartsGlb } from "../src/assignment/shared/partsGlb.ts";
import { llmKey, readRecord, type LlmRecord, type LlmUsage } from "./providers/openrouter.ts";
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
const REASONING_EFFORT = "low"; // measured: ~21 s and valid JSON; effort unset took ~58 s and ran out of tokens
/** Deliveries a message gets (wrangler.jsonc: max_retries 2). */
const MAX_DELIVERIES = 3;
/** A bad or empty design is tried once more; only a 429 uses the remaining deliveries. */
const MAX_DESIGN_DELIVERIES = 2;
const GLB_CONTENT_TYPE = "model/gltf-binary";
/** Added to the instructions of the second try after an answer was cut off at max_tokens: the same request would be cut off again. */
const SIMPLIFY_HINT = " Your previous answer was too long to finish. Keep this one short: at most 16 parts, simple shapes, short names.";
/** Appears in the reply to a request that kept running out of room (also the text a user reads). */
const RAN_OUT = "The model ran out of room before it finished the design. Try a simpler prompt.";

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

// ---------- the OpenRouter call ----------

type Outcome =
    | { kind: "ok"; design: PartsDesign; notes: string[]; dropped: number; usage: LlmUsage }
    /** `simplify`: the next try should ask for a smaller design (this one was cut off at max_tokens). */
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
 */
async function designOnce(key: string, job: LlmJob, attempt: number, simplify: boolean): Promise<Outcome> {
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
                messages: [
                    { role: "system", content: simplify ? MUSE_SYSTEM_PROMPT + SIMPLIFY_HINT : MUSE_SYSTEM_PROMPT },
                    { role: "user", content: job.prompt },
                ],
                response_format: { type: "json_schema", json_schema: MUSE_SCHEMA },
                reasoning: { effort: REASONING_EFFORT },
                max_tokens: MAX_TOKENS,
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
        const usage = usageOf(reply.body);
        if (status === 429) {
            return { kind: "retry", error: problem.message, delaySeconds: secondsFrom(reply.headers, 15 * attempt), rate: true, usage };
        }
        if (status === 408 || status >= 500) {
            return { kind: "retry", error: problem.message, delaySeconds: 5, rate: false, usage };
        }
        return { kind: "fail", error: problem.message, usage };
    }

    const usage = usageOf(reply.body);
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
        return { kind: "retry", error: RAN_OUT, delaySeconds: 2, rate: false, usage, simplify: true };
    }
    if (finish === "error") {
        return { kind: "retry", error: "The model's provider reported an error. Please try again.", delaySeconds: 5, rate: false, usage };
    }
    if (content.trim() === "") {
        return { kind: "retry", error: "The model returned an empty answer. Please try again.", delaySeconds: 2, rate: false, usage };
    }
    const raw = extractJson(content);
    if (raw === undefined) {
        return { kind: "retry", error: "The model returned a design the app could not read. Please try again.", delaySeconds: 2, rate: false, usage };
    }
    let repaired: ReturnType<typeof repairDesign>;
    try {
        repaired = repairDesign(raw);
    } catch (err) {
        // A bug or an answer nobody foresaw: asking again would only pay for the same surprise.
        console.error(`muse ${job.taskId.slice(0, 8)} repair failed: ${errorSummary(err)}`);
        return { kind: "fail", error: "The model returned a design the app could not process. Please try again or reword the prompt.", usage };
    }
    if (!repaired.design) {
        return { kind: "retry", error: "The model returned no usable parts. Try again or reword the prompt.", delaySeconds: 2, rate: false, usage };
    }
    return { kind: "ok", design: repaired.design, notes: repaired.notes, dropped: repaired.dropped, usage };
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
    await env.FILES.delete([llmKey(taskId, "json"), llmKey(taskId, "glb"), llmKey(taskId, "cancel")]).catch(() => {});
}

function parseJob(body: unknown): LlmJob | null {
    if (!isRecord(body)) return null;
    const { taskId, prompt, model } = body;
    if (typeof taskId !== "string" || typeof prompt !== "string" || typeof model !== "string") return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId) || prompt.trim() === "" || model === "") return null;
    return { taskId, prompt, model };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** One line per attempt in the Worker's log: no prompt, no key. */
function logAttempt(taskId: string, attempt: number, what: string, ms: number, usage: LlmUsage | null): void {
    const cost = usage?.cost_usd != null ? ` cost=$${usage.cost_usd}` : "";
    const tokens = usage?.completion_tokens != null ? ` out=${usage.completion_tokens}` : "";
    console.log(`muse ${taskId.slice(0, 8)} attempt=${attempt} ${what} ${ms}ms${tokens}${cost}`);
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
}

/** The design a previous delivery already paid for, from its "building" record; null when there is none to build from. */
function savedAnswer(previous: LlmRecord | null): Answer | null {
    if (previous?.status !== "building" || !previous.design) return null;
    const { design } = previous;
    if (!Array.isArray(design.parts) || design.parts.length === 0) return null;
    return { design, notes: previous.notes ?? [], dropped: previous.dropped ?? 0, usage: previous.usage ?? null };
}

async function processMessage(message: QueueMessage, env: Env, ledger: Ledger): Promise<void> {
    const job = parseJob(message.body);
    if (!job) {
        message.ack(); // malformed: retrying cannot fix it
        return;
    }
    const { taskId } = job;
    const attempt = message.attempts;

    if (await wasCanceled(env, taskId)) {
        await dropStaging(env, taskId);
        message.ack();
        return;
    }
    const previous = await readRecord(env, taskId).catch(() => null);
    if (previous?.status === "done" || previous?.status === "failed") {
        message.ack(); // the same task delivered again after it finished
        return;
    }
    const spentBefore = previous?.cost_usd ?? 0;
    ledger.cost = spentBefore;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    let answer = savedAnswer(previous);
    let spent = spentBefore;
    let elapsedBefore = 0;
    if (answer) {
        // An earlier delivery got the answer and then stopped (a bucket error, a crash while building): build it, do not pay again.
        ledger.saved = true;
        elapsedBefore = previous?.elapsed_ms ?? 0;
        logAttempt(taskId, attempt, "resumed", 0, null);
    } else {
        const key = env.OPENROUTER_API_KEY?.trim();
        if (!key) {
            await writeRecord(env, taskId, { status: "failed", error: "The designer is not configured on the server (OpenRouter key missing).", attempt, finished_at: startedAt });
            message.ack();
            return;
        }
        const simplify = previous?.simplify === true;
        await writeRecord(env, taskId, { status: "designing", attempt, model: job.model, started_at: startedAt, cost_usd: spentBefore, ...(simplify ? { simplify } : {}) });

        const outcome = await designOnce(key, job, attempt, simplify);
        spent = round6(spentBefore + (outcome.usage?.cost_usd ?? 0));
        ledger.cost = spent;
        const elapsed = Date.now() - t0;

        if (outcome.kind === "fail") {
            logAttempt(taskId, attempt, "failed", elapsed, outcome.usage);
            await writeRecord(env, taskId, { status: "failed", error: outcome.error, attempt, model: job.model, finished_at: new Date().toISOString(), elapsed_ms: elapsed, cost_usd: spent });
            message.ack();
            return;
        }

        if (outcome.kind === "retry") {
            // A cut-off answer that has not yet been asked for less always gets that try, even after a 429 used up a delivery.
            const retries = outcome.rate || (outcome.simplify === true && !simplify) ? MAX_DELIVERIES : MAX_DESIGN_DELIVERIES;
            const allowed = attempt < retries;
            logAttempt(taskId, attempt, allowed ? "retry" : "gave up", elapsed, outcome.usage);
            if (allowed) {
                const next = simplify || outcome.simplify === true;
                await writeRecord(env, taskId, { status: "designing", attempt, model: job.model, started_at: startedAt, cost_usd: spent, ...(next ? { simplify: next } : {}) });
                message.retry({ delaySeconds: outcome.delaySeconds });
            } else {
                await writeRecord(env, taskId, { status: "failed", error: outcome.error, attempt, model: job.model, finished_at: new Date().toISOString(), elapsed_ms: elapsed, cost_usd: spent });
                message.ack();
            }
            return;
        }
        answer = { design: outcome.design, notes: outcome.notes, dropped: outcome.dropped, usage: outcome.usage };
    }

    // The model answered: keep the answer, then build the file.
    if (await wasCanceled(env, taskId)) {
        logAttempt(taskId, attempt, "canceled", Date.now() - t0, answer.usage);
        await dropStaging(env, taskId);
        message.ack();
        return;
    }
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
        });
        ledger.saved = true;
    }
    let glb: Uint8Array;
    try {
        glb = buildPartsGlb(answer.design);
    } catch (err) {
        console.error(`muse ${taskId.slice(0, 8)} build failed: ${errorSummary(err)}`);
        await writeRecord(env, taskId, { status: "failed", error: "The designed parts could not be built into a model. Please try again.", attempt, model: job.model, finished_at: new Date().toISOString(), elapsed_ms: elapsedBefore + Date.now() - t0, cost_usd: spent });
        message.ack();
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
    });
    logAttempt(taskId, attempt, `done parts=${answer.design.parts.length} bytes=${glb.byteLength}`, elapsed, answer.usage);
    message.ack();
}

/** The Worker's queue() handler. A message is always answered (ack or retry); nothing escapes. */
export async function handleLlmBatch(batch: { readonly messages: readonly QueueMessage[] }, env: Env): Promise<void> {
    for (const message of batch.messages) {
        const ledger: Ledger = { cost: 0, saved: false };
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
                }).catch(() => {});
            }
            message.ack();
        }
    }
}
