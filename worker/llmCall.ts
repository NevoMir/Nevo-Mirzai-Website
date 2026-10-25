// One OpenRouter chat call that returns JSON, for the features that ask the Muse model a question in the request itself (not a
// design that takes a minute, which worker/llm.ts runs in a queue). Shared by the block editor (POST /llm/voxel-edit) and the
// optimizer's goal writer (POST /llm/optimize-spec). Also owns the daily counter of all AI calls (usage.llm): the direct calls
// reserve a slot here, and the queue lane (worker/edit.ts) reserves one when it starts an edit job.
//
// Why no queue here: these calls are small (2-3k tokens in, a few hundred out) and took 3.7-12.2 s (mean 7.8 s) in ten live runs.
// A Worker may wait on a subrequest for that long without using CPU (the Free plan's 10 ms is CPU, not wall time); what it spends
// is parsing the reply (a few KB). The existing queue stays for the 20-60 s designs.
//
// Never throws for anything the vendor can say; the caller maps the result to a status. The key is read from env and never logged.

import { failure, isRecord, asNumber, asString, type Env, type VendorInfo, type VendorReply } from "./providers/types.ts";
import { DEFAULT_MODEL, editModelOf } from "./providers/openrouter.ts";

const DEFAULT_DAILY_LLM = 400;
const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** AI calls allowed per UTC day (DAILY_LLM_LIMIT, default 400; about $0.2 a day at the measured $0.0005 a call). */
export function llmDailyLimit(env: Env): number {
    const n = Number(env.DAILY_LLM_LIMIT);
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_DAILY_LLM;
}

/** Takes one slot of today's AI-call cap with one atomic upsert; false when it is used up. */
export async function reserveLlmSlot(env: Env): Promise<boolean> {
    const row = await env.DB.prepare(
        `INSERT INTO usage (day, llm) VALUES (?1, 1)
         ON CONFLICT (day) DO UPDATE SET llm = llm + 1 WHERE llm < ?2
         RETURNING llm`,
    )
        .bind(utcDay(), llmDailyLimit(env))
        .first<{ llm: number }>();
    return row !== null;
}

/** Hands a slot back (the call failed before the model was paid for). Keep the slot when the model answered but the answer is unusable. */
export async function refundLlmSlot(env: Env): Promise<void> {
    await env.DB.prepare("UPDATE usage SET llm = MAX(0, llm - 1) WHERE day = ?1").bind(utcDay()).run().catch(() => {});
}


export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const REFERER = "https://nevomirzai.com/assignment_alex";
const TITLE = "Assembly Studio";

export const OPENROUTER: VendorInfo = {
    name: "OpenRouter",
    authScheme: "Bearer",
    billingUrl: "openrouter.ai/settings/credits",
    classify(reply: VendorReply) {
        // 403 is "your input was flagged by moderation"; the body names the reasons.
        if (reply.status !== 403) return null;
        const error = reply.body && isRecord(reply.body.error) ? reply.body.error : null;
        const meta = error && isRecord(error.metadata) ? error.metadata : null;
        const message = error ? (asString(error.message) ?? "") : "";
        return meta?.reasons !== undefined || /moderat|flagged/i.test(message) ? "content" : null;
    },
};

export interface LlmUsage {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    reasoning_tokens: number | null;
    cost_usd: number | null;
}

export interface JsonCall {
    system: string;
    user: string;
    /** OpenRouter response_format.json_schema (strict). */
    schema: { readonly name: string; readonly strict: boolean; readonly schema: object };
    maxTokens: number;
    effort: "minimal" | "low" | "medium" | "high";
    timeoutMs: number;
}

export type JsonCallResult =
    | { ok: true; content: string; usage: LlmUsage; model: string; ms: number }
    /** `status` is the HTTP status to answer with; `retryable` says another try may work (429 excluded: that is the vendor's limit). */
    | { ok: false; status: number; message: string; retryable: boolean; usage: LlmUsage | null };

const NO_USAGE: LlmUsage = { prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, cost_usd: null };

export function usageOf(body: Record<string, unknown> | null): LlmUsage {
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

/**
 * True when the vendor's own figures say the model was paid for this reply (a cost, or tokens it produced). One rule for every lane that
 * keeps or hands back a daily slot: a reply that was cut off (finish_reason length), refused, blocked by a filter or unreadable was still
 * charged, so its slot stays used. No figures at all (a call that never got an answer) reads as not charged here; the queue lane
 * (worker/llm.ts maybeCharged) is stricter and treats "no reply to tell" as maybe charged.
 */
export function wasCharged(usage: LlmUsage | null): boolean {
    return usage !== null && ((usage.cost_usd ?? 0) > 0 || (usage.completion_tokens ?? 0) > 0);
}

/** The JSON object out of the model's text: the whole text, or the outermost {...}. */
export function extractJson(text: string): unknown {
    const parse = (s: string): unknown => {
        try {
            return JSON.parse(s);
        } catch {
            return undefined;
        }
    };
    const whole = parse(text.trim());
    if (whole !== undefined || text.length > 200_000) return whole;
    const open = text.indexOf("{");
    const close = text.lastIndexOf("}");
    return open >= 0 && close > open ? parse(text.slice(open, close + 1)) : undefined;
}

export async function callOpenRouterJson(env: Env, call: JsonCall): Promise<JsonCallResult> {
    const key = env.OPENROUTER_API_KEY;
    if (!key) return { ok: false, status: 503, message: "The AI editor is not set up on the server.", retryable: false, usage: null };
    const model = editModelOf(env) || DEFAULT_MODEL;
    const started = Date.now();
    let reply: VendorReply;
    try {
        const res = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", "HTTP-Referer": REFERER, "X-Title": TITLE },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: call.system },
                    { role: "user", content: call.user },
                ],
                response_format: { type: "json_schema", json_schema: call.schema },
                reasoning: { effort: call.effort },
                max_tokens: call.maxTokens,
            }),
            signal: AbortSignal.timeout(call.timeoutMs),
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
        return { ok: false, status: 504, message: timedOut ? "The AI editor did not answer in time. Please try again." : "Could not reach the AI editor. Please try again.", retryable: true, usage: null };
    }

    // An error can also arrive inside a 200 ({"error": {"code": 502, ...}}).
    const inner = reply.body && isRecord(reply.body.error) ? reply.body.error : null;
    const status = reply.status >= 400 ? reply.status : inner ? (asNumber(inner.code) ?? 502) : reply.status;
    const usage = usageOf(reply.body);
    if (status >= 400) {
        const problem = failure(OPENROUTER, { ...reply, status }, "submit", key);
        return { ok: false, status: status === 429 ? 429 : 502, message: problem.message, retryable: status === 408 || status >= 500, usage };
    }
    const choice = reply.body && Array.isArray(reply.body.choices) && isRecord(reply.body.choices[0]) ? reply.body.choices[0] : null;
    const message = choice && isRecord(choice.message) ? choice.message : null;
    const refusal = message ? asString(message.refusal) : null;
    if (refusal) return { ok: false, status: 422, message: `The AI editor declined this request: ${refusal.replace(/\s+/g, " ").slice(0, 200)}`, retryable: false, usage };
    const finish = choice ? asString(choice.finish_reason) : null;
    if (finish === "content_filter") return { ok: false, status: 422, message: "The AI editor's safety filter blocked this request. Try rewording it.", retryable: false, usage };
    if (finish === "length") return { ok: false, status: 502, message: "The AI editor ran out of room before it finished. Try a simpler instruction.", retryable: false, usage };
    const content = message && typeof message.content === "string" ? message.content : "";
    if (finish === "error" || content.trim() === "") return { ok: false, status: 502, message: "The AI editor returned an empty answer. Please try again.", retryable: true, usage };
    return { ok: true, content, usage, model, ms: Date.now() - started };
}
