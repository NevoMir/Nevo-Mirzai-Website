// POST /api/assignment_alex/llm/optimize-spec: asks Muse Spark to turn a goal in words ("as light as possible, keep the seat") into an
// optimization spec (shared/optimizeSpec.ts) for the model the page describes in `brief`. The Worker owns the instructions and the JSON
// schema; the browser sends only the goal and the facts about its model, so the paid key cannot be used for anything else. The answer is
// cleaned here (repairSpec: every number bounded, unknown parts dropped) and again by the page after each edit of the controls.
//
// Cost control (the API is open): the same access code as generation when one is configured, a 6 KB body limit, the daily cap of AI calls
// it shares with the block editor and the edit jobs (DAILY_LLM_LIMIT, usage.llm), and the slot goes back when the call fails before the
// model was paid. The wait for OpenRouter (6 to 14 s in ten live runs) is not CPU time; what the Worker spends is parsing a few KB.
//
// MOCK_PROVIDER=1 (local development only; MOCK_LLM=0 turns the mock off) answers with the "lightest stable" preset and calls nobody, so the smoke
// tests run offline and cost nothing even when .dev.vars also holds a real key.

import type { OptimizeSpecResponse } from "../src/assignment/shared/contract.ts";
import { GOAL_MAX, SPEC_SCHEMA, SPEC_SYSTEM_PROMPT, cleanBrief, cleanGoal, presetSpec, repairContextOfBrief, repairSpec, specUserMessage } from "../src/assignment/shared/optimizeSpec.ts";
import { assistLocked, requireAccess } from "./jobs.ts";
import { callOpenRouterJson, extractJson, refundLlmSlot, reserveLlmSlot, wasCharged, type JsonCallResult } from "./llmCall.ts";
import { mockLlmEnabled } from "./providers/mock.ts";
import type { Env } from "./providers/types.ts";
import { HttpError, readJsonObject } from "./util.ts";

const BODY_LIMIT = 6 * 1024;
/** Measured: 3000 tokens leave room for the reasoning and the spec (0.4 to 3.2k output tokens); 40 s covers the slowest of ten runs (13.6 s) with room. */
const MAX_TOKENS = 3000;
const TIMEOUT_MS = 40_000;
const RETRY_PAUSE_MS = 1500;

export async function handleOptimizeSpec(env: Env, request: Request): Promise<OptimizeSpecResponse> {
    await requireAccess(env, request);
    // The same lock as generation and the queued edits: a real key with no access code and no explicit opt-out (ALLOW_OPEN_GENERATION) is closed.
    if (assistLocked(env)) throw new HttpError(503, "Editing is disabled: ACCESS_CODE is not configured on the server.");
    const body = await readJsonObject(request, BODY_LIMIT);
    const goal = cleanGoal(body.goal);
    if (goal === "") throw new HttpError(400, `goal must be 1 to ${GOAL_MAX} characters`);
    const brief = cleanBrief(body.brief);
    if (!brief) throw new HttpError(400, "brief must describe the model (blocks, extent, parts)");
    const mock = mockLlmEnabled(env);
    if (!mock && !env.OPENROUTER_API_KEY) throw new HttpError(503, "The AI editor is not set up on the server.");
    if (!(await reserveLlmSlot(env))) throw new HttpError(429, "Today's limit of AI requests is used up. Try again tomorrow.");

    if (mock) {
        return { spec: presetSpec("lightest", { blocks: brief.blocks }), changes: [], model: "mock", cost_usd: null, ms: 0 };
    }

    // One retry for a hiccup (5xx, a timeout, an empty or unreadable answer), never for the vendor's 429.
    const context = repairContextOfBrief(brief);
    let result: JsonCallResult = { ok: false, status: 502, message: "", retryable: true, usage: null };
    let raw: unknown;
    let paid = false;
    for (let attempt = 0; attempt < 2; attempt++) {
        result = await callOpenRouterJson(env, {
            system: SPEC_SYSTEM_PROMPT,
            user: specUserMessage(goal, brief),
            schema: SPEC_SCHEMA,
            maxTokens: MAX_TOKENS,
            effort: "low",
            timeoutMs: TIMEOUT_MS,
        });
        if (result.ok) {
            paid = true;
            raw = extractJson(result.content);
            if (raw !== undefined && typeof raw === "object" && raw !== null) break;
            result = { ok: false, status: 502, message: "The AI editor returned an answer the app could not read. Please try again.", retryable: true, usage: result.usage };
        } else if (wasCharged(result.usage)) paid = true; // cut off, refused or filtered: still billed
        if (!result.retryable) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
    if (!result.ok) {
        // The slot goes back unless the model was paid for (an unreadable answer still cost something).
        if (!paid) await refundLlmSlot(env);
        throw new HttpError(result.status, result.message);
    }
    const { spec, changes } = repairSpec(raw, context);
    return { spec, changes, model: result.model, cost_usd: result.usage.cost_usd, ms: result.ms };
}
