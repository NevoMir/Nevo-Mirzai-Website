// "Muse Spark 1.3": an AI assembly designer. A text-only LLM (Meta Muse Spark 1.3 Contributor, through OpenRouter) returns a JSON
// list of named primitive parts for the prompt; the app repairs it and builds a multi-part GLB (shared/partsDesign.ts,
// shared/partsGlb.ts). There is no 3D model API behind this: the "vendor task" is a message in a Cloudflare Queue.
//
// Why a queue: the call takes 20-60 s, and a Free-plan request may use only 10 ms of CPU and a waitUntil 30 s. A queue consumer
// (worker/llm.ts) has no such wall-clock limit. The two halves talk through small objects in the bucket (env.FILES):
//
//   llm/<taskId>.json    status record written by the consumer: designing | building | done | failed (+ the cleaned design, cost)
//   llm/<taskId>.glb     the finished model; the job engine copies it into models/ through the "r2:" source (worker/glb.ts)
//   llm/<taskId>.cancel  a marker the adapter writes on Stop (or after the time-out): the consumer skips the message
//
// The adapter is the producer and the poller; it never calls OpenRouter itself.
//
// Clean-up: the engine calls cleanup() when a job is over, and purgeProjects deletes the files of purged projects. Nothing runs
// when nobody polls (a closed tab) or a message is lost, so the bucket should also expire the whole llm/ prefix after a day (an R2
// lifecycle rule, see worker/README.md). The cancel marker is the one file that must outlive cleanup() while the consumer might
// still hold the message, because it is what stops a paid call.

import type { PartsDesign } from "../../src/assignment/shared/partsDesign.ts";
import {
    ProviderError,
    asNumber,
    asString,
    guardPoll,
    isRecord,
    preparePrompt,
    requireKey,
    type AdapterState,
    type Env,
    type LlmJob,
    type PollResult,
    type ProviderAdapter,
    type SubmitResult,
} from "./types.ts";

export const DEFAULT_MODEL = "meta/muse-spark-1.3-contributor";
/**
 * A design that is not finished this long after it was queued is given up on. A run takes ~20-60 s; the longest path of the
 * consumer (two calls of 150 s, or a 429 wait between them) is about 6 minutes, and the time spent waiting in the queue counts.
 */
export const DESIGN_TIMEOUT_MS = 10 * 60 * 1000;
const PROMPT_LIMIT = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type LlmFile = "json" | "glb" | "cancel";
const LLM_FILES: readonly LlmFile[] = ["json", "glb", "cancel"];

/** The R2 key of one staging file of a task. Throws for anything that is not a task id. */
export function llmKey(taskId: string, file: LlmFile): string {
    if (!UUID.test(taskId)) throw new Error("not a task id");
    return `llm/${taskId}.${file}`;
}

/** Every staging key of a task (none for anything that is not a task id). */
export function stagingKeys(taskId: string): string[] {
    return UUID.test(taskId) ? LLM_FILES.map((file) => llmKey(taskId, file)) : [];
}

/** The model to ask: OPENROUTER_MODEL when it looks like a model id, else the Muse default. */
export function modelOf(env: Env): string {
    const wanted = env.OPENROUTER_MODEL?.trim();
    return wanted && /^[\w.~:/-]{3,100}$/.test(wanted) ? wanted : DEFAULT_MODEL;
}

export interface LlmUsage {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    reasoning_tokens: number | null;
    cost_usd: number | null;
}

/** What the consumer leaves in llm/<taskId>.json. */
export interface LlmRecord {
    status: "designing" | "building" | "done" | "failed";
    /** failed: a message that is safe to show the user. */
    error?: string;
    /** designing: the next try asks for a smaller design (the last answer was cut off at max_tokens). */
    simplify?: boolean;
    attempt?: number;
    model?: string;
    started_at?: string;
    finished_at?: string;
    elapsed_ms?: number;
    /** building and done: the cleaned design the GLB is built from. A delivery that finds it in a building record builds from it. */
    design?: PartsDesign;
    /** building and done: what the repair changed. */
    notes?: string[];
    dropped?: number;
    size_bytes?: number;
    usage?: LlmUsage;
    /** Money spent on this task so far, across attempts (USD). */
    cost_usd?: number;
}

const STATUSES: readonly LlmRecord["status"][] = ["designing", "building", "done", "failed"];

/** Reads and checks the status record; null when there is none (yet) or it is not one of ours. */
export async function readRecord(env: Env, taskId: string): Promise<LlmRecord | null> {
    let text: string | null;
    try {
        const object = await env.FILES.get(llmKey(taskId, "json"));
        text = object ? await object.text() : null;
    } catch {
        // The bucket hiccupped: the caller decides whether that is worth failing for.
        throw new ProviderError("Waiting for the designer…", 502, true);
    }
    if (text === null) return null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed) || !STATUSES.includes(parsed.status as LlmRecord["status"])) return null;
        return parsed as unknown as LlmRecord;
    } catch {
        return null;
    }
}

async function deleteQuietly(env: Env, keys: string[]): Promise<void> {
    try {
        await env.FILES.delete(keys);
    } catch {
        // best effort
    }
}

/** What a finished record says to the job engine; null while the consumer is still at work (or has not started). */
function verdictOf(record: LlmRecord | null, taskId: string): PollResult | null {
    if (record?.status === "done") return { status: "succeeded", glbUrl: `r2:${llmKey(taskId, "glb")}`, thumbnailUrl: null };
    if (record?.status === "failed") return { status: "failed", error: asString(record.error) ?? "The designer could not make this model." };
    return null;
}

export const openRouterDesigner: ProviderAdapter = {
    via: "openrouter",

    async submit(env, rawPrompt): Promise<SubmitResult> {
        requireKey(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY");
        const queue = env.LLM_QUEUE;
        if (!queue) throw new ProviderError("The design queue is not set up on the server.", 503);
        const { prompt, trimmedTo } = preparePrompt(rawPrompt, PROMPT_LIMIT);
        const taskId = crypto.randomUUID();
        const model = modelOf(env);
        const job: LlmJob = { taskId, prompt, model };
        try {
            await queue.send(job);
        } catch {
            // Definitely not queued: no money was spent, and the engine hands the daily slot back.
            throw new ProviderError("Could not start the designer. Please try again.", 502);
        }
        return { taskId, state: { queued_at: Date.now(), model, ...(trimmedTo !== null ? { prompt_trimmed_to: trimmedTo } : {}) } };
    },

    poll(env, taskId, state: AdapterState): Promise<PollResult> {
        return guardPoll(state, async () => {
            const record = await readRecord(env, taskId);
            const verdict = verdictOf(record, taskId);
            if (verdict) return verdict;
            const queuedAt = isRecord(state) ? (asNumber(state.queued_at) ?? Date.now()) : Date.now();
            if (Date.now() - queuedAt > DESIGN_TIMEOUT_MS) {
                // Look once more right before stopping the consumer: it may have finished a moment ago.
                const latest = await readRecord(env, taskId).catch(() => null);
                const final = verdictOf(latest, taskId);
                if (final) return final;
                // Stop the consumer from spending money on a result nobody will collect.
                await env.FILES.put(llmKey(taskId, "cancel"), "timeout").catch(() => {});
                const minutes = Math.round(DESIGN_TIMEOUT_MS / 60_000);
                return { status: "failed", error: `The designer took too long (over ${minutes} minutes) and was stopped. Please try again.` };
            }
            return { status: "running", stage: record?.status === "building" ? "Building the 3D model" : "Designing the parts…" };
        });
    },

    async cancel(env, taskId): Promise<void> {
        try {
            const record = await readRecord(env, taskId).catch(() => null);
            // Over already (done or failed): nothing runs any more, so no marker; just drop what was staged.
            if (record?.status === "done" || record?.status === "failed") {
                await deleteQuietly(env, [llmKey(taskId, "json"), llmKey(taskId, "glb")]);
                return;
            }
            await env.FILES.put(llmKey(taskId, "cancel"), "canceled");
        } catch {
            // Stop is best effort: the job is marked canceled either way.
        }
    },

    async cleanup(env, taskId): Promise<void> {
        try {
            // The consumer is finished with the message once its record says done or failed, so the marker has nothing left to
            // stop. Before that (a time-out, a Stop) it may still come for the message and must find the marker.
            const record = await readRecord(env, taskId).catch(() => null);
            const finished = record?.status === "done" || record?.status === "failed";
            await deleteQuietly(env, [llmKey(taskId, "json"), llmKey(taskId, "glb"), ...(finished ? [llmKey(taskId, "cancel")] : [])]);
        } catch {
            // best effort
        }
    },
};
