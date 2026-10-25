// POST /api/assignment_alex/llm/voxel-edit: asks Muse Spark for the operations that carry out one natural-language instruction on the
// block assembly described in `scene` (shared/voxelEdit/). The Worker adds the instructions and the JSON schema; the browser supplies only
// the instruction and the scene text, so the paid key cannot be used for anything else. The reply is the model's JSON as it is (trimmed to
// the fields of the schema); the browser cleans it (voxelEdit/ops.ts cleanAnswer) and applies it.
//
// Cost control (the API is open): the same access code as generation when one is configured, a 16 KB body limit, the daily cap of AI calls
// (DAILY_LLM_LIMIT, default 400, about $0.2 at the measured $0.0005 a call; usage.llm, shared with the edit jobs and the optimization goals),
// and the slot is handed back when the call fails before the model was paid. A model that was paid keeps its slot, whatever came back: an
// answer cut off at max_tokens, a refusal, a filter block, something unreadable (wasCharged: the vendor's cost or tokens, over both tries).
// CPU on the Free plan is parsing a few KB; the wait for OpenRouter (4 to 12 s) is not CPU time.
//
// MOCK_PROVIDER=1 (local development only; MOCK_LLM=0 turns the mock off) answers with one canned operation and calls nobody, so the smoke
// tests run offline and cost nothing even when .dev.vars also holds a real key.

import { EDIT_INSTRUCTION_MAX, type VoxelEditResponse } from "../src/assignment/shared/contract.ts";
import { VOXEL_EDIT_EFFORT, VOXEL_EDIT_MAX_TOKENS, VOXEL_EDIT_SCHEMA, VOXEL_EDIT_SYSTEM_PROMPT, VOXEL_EDIT_TIMEOUT_MS, checkVoxelEditRequest, voxelEditUserMessage } from "../src/assignment/shared/voxelEdit/prompt.ts";
import { assistLocked, requireAccess } from "./jobs.ts";
import { callOpenRouterJson, extractJson, refundLlmSlot, reserveLlmSlot, wasCharged, type JsonCallResult } from "./llmCall.ts";
import { mockLlmEnabled } from "./providers/mock.ts";
import type { Env } from "./providers/types.ts";
import { HttpError, isRecord, readJsonObject } from "./util.ts";

const BODY_LIMIT = 16 * 1024;
const RETRY_PAUSE_MS = 1500;

/** Keeps only the fields of the schema, bounded: whatever else the model said is dropped. */
function trimAnswer(raw: unknown): VoxelEditResponse["answer"] | null {
    if (!isRecord(raw) || !Array.isArray(raw.ops)) return null;
    const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
    return { summary: text(raw.summary, 300), notes: text(raw.notes, 300), clarification: text(raw.clarification, 400), ops: raw.ops.slice(0, 64).filter(isRecord) };
}

/** What the offline demo answers: one layer on top of the whole model, in the exact shape of the model's strict JSON. */
function mockAnswer(): VoxelEditResponse["answer"] {
    return {
        summary: "Added one layer of blocks on top of the model (demo answer).",
        notes: "",
        clarification: "",
        ops: [{ op: "extrude", region: "all", box: null, dirs: ["+k"], amount: 1, axis: null, at: null, plane: null, offset: null, wall: null, include_added: false }],
    };
}

export async function handleVoxelEdit(env: Env, request: Request): Promise<VoxelEditResponse> {
    await requireAccess(env, request);
    // The same lock as generation and the queued edits: a real key with no access code and no explicit opt-out (ALLOW_OPEN_GENERATION) is closed.
    if (assistLocked(env)) throw new HttpError(503, "Editing is disabled: ACCESS_CODE is not configured on the server.");
    const body = await readJsonObject(request, BODY_LIMIT);
    const bad = checkVoxelEditRequest(body.instruction, body.scene);
    if (bad) throw new HttpError(400, bad);
    // eslint-disable-next-line no-control-regex
    const instruction = (body.instruction as string).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, EDIT_INSTRUCTION_MAX);
    const mock = mockLlmEnabled(env);
    if (!mock && !env.OPENROUTER_API_KEY) throw new HttpError(503, "The AI editor is not set up on the server.");
    if (!(await reserveLlmSlot(env))) throw new HttpError(429, "Today's limit of AI requests is used up. Try again tomorrow.");
    if (mock) return { answer: mockAnswer(), model: "mock", cost_usd: null, prompt_tokens: null, completion_tokens: null, ms: 0 };

    // One retry for a hiccup (5xx, a timeout, an empty answer), never for the vendor's 429.
    let result: JsonCallResult = { ok: false, status: 502, message: "", retryable: true, usage: null };
    let paid = false;
    for (let attempt = 0; attempt < 2; attempt++) {
        result = await callOpenRouterJson(env, {
            system: VOXEL_EDIT_SYSTEM_PROMPT,
            user: voxelEditUserMessage(body.scene as string, instruction),
            schema: VOXEL_EDIT_SCHEMA,
            maxTokens: VOXEL_EDIT_MAX_TOKENS,
            effort: VOXEL_EDIT_EFFORT,
            timeoutMs: VOXEL_EDIT_TIMEOUT_MS,
        });
        // Any try that was charged keeps the slot, even when the retry then fails without a bill.
        if (result.ok || wasCharged(result.usage)) paid = true;
        if (result.ok || !result.retryable) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
    if (!result.ok) {
        if (!paid) await refundLlmSlot(env);
        throw new HttpError(result.status, result.message);
    }
    const answer = trimAnswer(extractJson(result.content));
    if (!answer) {
        // The model was paid for but its answer is unusable: the slot stays used.
        throw new HttpError(502, "The AI editor returned an answer the app could not read. Please try again.");
    }
    return { answer, model: result.model, cost_usd: result.usage.cost_usd, prompt_tokens: result.usage.prompt_tokens, completion_tokens: result.usage.completion_tokens, ms: result.ms };
}
