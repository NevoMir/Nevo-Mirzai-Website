// Meshy direct API, checked 2026-10-23 against https://docs.meshy.ai (llms-full.txt and openapi.yaml).
//
//   POST   https://api.meshy.ai/openapi/v2/text-to-3d       202 { result: "<task id>" }
//   GET    https://api.meshy.ai/openapi/v2/text-to-3d/{id}  -> task { status, progress, model_urls, thumbnail_url, task_error }
//   DELETE https://api.meshy.ai/openapi/v2/text-to-3d/{id}  200 (PENDING only; 409 once IN_PROGRESS)
// Auth is `Authorization: Bearer msy_...` (paid Meshy plans only: the Free plan gets 402 on task creation).
// Text-to-3D is two tasks on the same endpoint: mode "preview" builds an untextured mesh, then mode "refine" with
// preview_task_id textures it. This adapter runs both as one job: the hand-off lives in the adapter state
// ({phase, preview_task_id, refine_task_id}) and the progress bar maps preview to 0-50 and refine to 50-100. If the
// texture pass cannot be started (balance, plan, a timeout that leaves it unknown) the paid preview mesh is kept as
// the result, untextured, rather than failing the job.
//
// Statuses: PENDING, IN_PROGRESS, SUCCEEDED, FAILED (credits refunded), CANCELED (Creative Lab only).
// Credits: preview 20 + refine 10 = 30 per textured meshy-7.1 model (2K textures). Typical time: preview ~75 s,
// refine ~80 s. Result URLs are signed and expire after 3 days, so the engine copies the GLB into R2 right away.

import {
    ProviderError,
    asNumber,
    asString,
    failure,
    fileUrl,
    guardPoll,
    isRecord,
    preparePrompt,
    requireKey,
    vendorFetch,
    withPromptNote,
    type AdapterState,
    type Env,
    type Json,
    type PollResult,
    type ProviderAdapter,
    type SubmitResult,
    type VendorInfo,
    type VendorReply,
} from "./types.ts";

const ENDPOINT = "https://api.meshy.ai/openapi/v2/text-to-3d";
const PROMPT_LIMIT = 800;
// "latest" resolves to the same model; the explicit id keeps the label honest if Meshy ships a newer one.
const AI_MODEL = "meshy-7.1";

const MESHY: VendorInfo = {
    name: "Meshy",
    authScheme: "Bearer",
    billingUrl: "meshy.ai/settings/subscription",
    classify(reply) {
        const message = asString(reply.body?.message) ?? "";
        // Both 429 flavours without Retry-After: too many of the account's tasks pending/running at once.
        if (reply.status === 429 && /^NoMore(Pending|Concurrent)Tasks/.test(message)) return "busy";
        if (reply.status === 402 && /paid plan/i.test(message)) return "plan";
        return null;
    },
};

interface MeshyState {
    phase: "preview" | "refine";
    preview_task_id: string;
    refine_task_id: string | null;
}

function readState(state: AdapterState, taskId: string): MeshyState {
    const s = isRecord(state) ? state : {};
    return {
        phase: s.phase === "refine" ? "refine" : "preview",
        preview_task_id: asString(s.preview_task_id) ?? taskId,
        refine_task_id: asString(s.refine_task_id),
    };
}

/** The id of the task currently being polled. */
function activeTaskId(s: MeshyState): string {
    return s.phase === "refine" && s.refine_task_id ? s.refine_task_id : s.preview_task_id;
}

/** `state` carries the transient-error counter and the prompt note between polls; keep both across the hand-off. */
function nextState(state: AdapterState, next: MeshyState): Json {
    const base = isRecord(state) ? state : {};
    return { ...base, ...next };
}

async function createTask(key: string, json: Json, phase: "submit" | "poll"): Promise<string> {
    const res = await vendorFetch(MESHY, key, ENDPOINT, { method: "POST", json });
    if (res.status >= 300) throw failure(MESHY, res, phase, key);
    const id = asString(res.body?.result);
    if (!id) throw new ProviderError("Meshy accepted the request but returned no task id.");
    return id;
}

/**
 * Starts the texture pass on a finished preview. A reply that says no (balance, plan, 4xx) throws the usual
 * non-retryable error, and a 429/5xx reply a retryable one: nothing was created, so the next poll may try again.
 * A timeout or dropped connection is different: the task may exist, and posting again could start (and bill) a
 * second one, so it becomes a non-retryable error that says so.
 */
async function startTexturing(key: string, previewTaskId: string): Promise<string> {
    let res: VendorReply;
    try {
        res = await vendorFetch(MESHY, key, ENDPOINT, {
            method: "POST",
            json: { mode: "refine", preview_task_id: previewTaskId, enable_pbr: true, target_formats: ["glb"] },
        });
    } catch (err) {
        if (err instanceof ProviderError && err.retryable) {
            throw new ProviderError(
                "Meshy did not confirm the texturing request, so it may have started. Check your Meshy dashboard before running it again.",
                504,
            );
        }
        throw err;
    }
    if (res.status >= 300) throw failure(MESHY, res, "poll", key);
    const id = asString(res.body?.result);
    if (!id) throw new ProviderError("Meshy accepted the request but returned no task id.");
    return id;
}

function taskFailure(task: Json): string {
    const error = isRecord(task.task_error) ? task.task_error : {};
    const message = asString(error.message);
    return `Meshy could not generate this model${message ? `: ${message}` : "."}`;
}

export const meshyDirect: ProviderAdapter = {
    via: "meshy",

    async submit(env: Env, rawPrompt: string): Promise<SubmitResult> {
        const key = requireKey(env.MESHY_API_KEY, "MESHY_API_KEY");
        const { prompt, trimmedTo } = preparePrompt(rawPrompt, PROMPT_LIMIT);
        const id = await createTask(
            key,
            {
                mode: "preview",
                prompt,
                ai_model: AI_MODEL,
                should_remesh: true,
                topology: "triangle",
                target_polycount: 30000, // keeps the GLB light enough for the browser viewer
                target_formats: ["glb"], // skips FBX/OBJ/USDZ generation, which shortens the task
            },
            "submit",
        );
        const state: MeshyState = { phase: "preview", preview_task_id: id, refine_task_id: null };
        return { taskId: id, state: { ...state, ...(trimmedTo !== null ? { prompt_trimmed_to: trimmedTo } : {}) } };
    },

    poll(env, taskId, state): Promise<PollResult> {
        return guardPoll(state, async () => {
            const key = requireKey(env.MESHY_API_KEY, "MESHY_API_KEY");
            const s = readState(state, taskId);
            const res = await vendorFetch(MESHY, key, `${ENDPOINT}/${encodeURIComponent(activeTaskId(s))}`);
            if (res.status >= 300) throw failure(MESHY, res, "poll", key);
            const task = res.body ?? {};
            const progress = Math.min(100, Math.max(0, Math.round(asNumber(task.progress) ?? 0)));
            const refining = s.phase === "refine";

            switch (task.status) {
                case "PENDING": {
                    const ahead = asNumber(task.preceding_tasks);
                    const queue = ahead !== null && ahead > 0 ? `In queue (${ahead} ahead)` : "In queue";
                    // Once texturing has been handed off the job is already "running"; do not flip it back to queued.
                    return refining
                        ? { status: "running", progress: 50, stage: withPromptNote("Texturing", state) }
                        : { status: "queued", progress: 0, stage: withPromptNote(queue, state) };
                }
                case "IN_PROGRESS":
                    return refining
                        ? { status: "running", progress: 50 + Math.round(progress / 2), stage: withPromptNote("Texturing", state) }
                        : { status: "running", progress: Math.round(progress / 2), stage: withPromptNote("Generating mesh", state) };
                case "SUCCEEDED": {
                    const urls = isRecord(task.model_urls) ? task.model_urls : {};
                    const glbUrl = fileUrl(urls.glb);
                    if (!refining) {
                        // The mesh is done: start the texture pass on it and keep polling under the new task id.
                        let refineId: string;
                        try {
                            refineId = await startTexturing(key, s.preview_task_id);
                        } catch (err) {
                            if (!(err instanceof ProviderError) || err.retryable) throw err;
                            // The 20 paid credits already bought a mesh (target_formats has glb): keep it rather than
                            // fail the job. It comes back without textures, which is the lesser loss.
                            if (glbUrl) {
                                console.error(`meshy: texturing did not start, keeping the untextured mesh: ${err.message}`);
                                return { status: "succeeded", glbUrl, thumbnailUrl: fileUrl(task.thumbnail_url) };
                            }
                            throw new ProviderError(`The mesh is ready, but Meshy could not start texturing. ${err.message}`, err.status);
                        }
                        return {
                            status: "running",
                            progress: 50,
                            stage: withPromptNote("Texturing", state),
                            state: nextState(state, { phase: "refine", preview_task_id: s.preview_task_id, refine_task_id: refineId }),
                        };
                    }
                    if (!glbUrl) return { status: "failed", error: "Meshy finished, but the result contained no GLB file." };
                    return { status: "succeeded", glbUrl, thumbnailUrl: fileUrl(task.thumbnail_url) };
                }
                case "FAILED":
                    return { status: "failed", error: taskFailure(task) };
                case "CANCELED":
                    return { status: "canceled" };
                default:
                    return { status: "running", stage: withPromptNote(refining ? "Texturing" : "Generating mesh", state) };
            }
        });
    },

    async cancel(env, taskId, state): Promise<void> {
        try {
            const key = requireKey(env.MESHY_API_KEY, "MESHY_API_KEY");
            // Only a PENDING task can be deleted (and refunded); a running one answers 409 and finishes on its own.
            await vendorFetch(MESHY, key, `${ENDPOINT}/${encodeURIComponent(activeTaskId(readState(state, taskId)))}`, {
                method: "DELETE",
            });
        } catch {
            // best effort: the job is marked canceled either way
        }
    },
};
