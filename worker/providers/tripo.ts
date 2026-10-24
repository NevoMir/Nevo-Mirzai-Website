// Tripo direct API (v3), checked 2026-10-23 against https://developers.tripo3d.com/en/docs (and its .md pages).
//
//   POST https://openapi.tripo3d.com/v3/generation/text-to-model   -> { code: 0, data: { task_id } }
//   GET  https://openapi.tripo3d.com/v3/tasks/{task_id}            -> { code: 0, data: { status, progress, output } }
// Auth is `Authorization: Bearer <TRIPO_API_KEY>`. Errors are { code, message, suggestion, request_id } with an
// HTTP 4xx/5xx. Task statuses: queued, running, success, failed, banned (content policy), expired, cancelled.
// v3 has no cancel endpoint, so there is no cancel() here: the engine just stops polling.
//
// Credits are frozen at creation and returned when a task fails or is cancelled. 1 credit = $0.01.

import {
    asNumber,
    asString,
    failure,
    fileUrl,
    guardPoll,
    isRecord,
    looksLikeGlb,
    preparePrompt,
    requireKey,
    vendorFetch,
    withPromptNote,
    ProviderError,
    type FailureKind,
    type PollResult,
    type ProviderAdapter,
    type SubmitResult,
    type VendorInfo,
    type VendorReply,
} from "./types.ts";

const BASE = "https://openapi.tripo3d.com/v3";
const MODEL = "v3.1-20260211"; // H3.1, the flagship; generate_parts needs v3.0-20250812 or newer
const PROMPT_LIMIT = 1024;

const TRIPO: VendorInfo = {
    name: "Tripo",
    authScheme: "Bearer",
    billingUrl: "platform.tripo3d.ai",
    classify(reply) {
        // Tripo's own error codes: https://developers.tripo3d.com/en/docs/error-handling
        const code = asNumber(reply.body?.code);
        const kinds: Record<number, FailureKind> = {
            1000: "auth", // invalid API key
            1001: "auth", // no Authorization header
            1007: "rate", // requests per window
            2000: "busy", // concurrent generations
            2008: "content", // content policy
            2010: "credits", // insufficient credits
        };
        return code === null ? null : (kinds[code] ?? null);
    },
};

/** Throws for a non-2xx reply, and for a 200 whose envelope says `code != 0`. */
function assertOk(reply: VendorReply, phase: "submit" | "poll", key: string): void {
    const code = asNumber(reply.body?.code);
    if (reply.status < 300 && (code === null || code === 0)) return;
    throw failure(TRIPO, reply.status < 300 ? { ...reply, status: 400 } : reply, phase, key);
}

interface TripoVariant {
    parts: boolean;
}

function tripoAdapter({ parts }: TripoVariant): ProviderAdapter {
    return {
        via: "tripo",

        async submit(env, rawPrompt): Promise<SubmitResult> {
            const key = requireKey(env.TRIPO_API_KEY, "TRIPO_API_KEY");
            const { prompt, trimmedTo } = preparePrompt(rawPrompt, PROMPT_LIMIT);
            const body = parts
                ? // generate_parts is rejected (code 1004) unless texture and pbr are both explicitly off.
                  { prompt, model: MODEL, texture: false, pbr: false, generate_parts: true }
                : { prompt, model: MODEL, texture: true, pbr: true, texture_quality: "standard" };
            const res = await vendorFetch(TRIPO, key, `${BASE}/generation/text-to-model`, { method: "POST", json: body });
            assertOk(res, "submit", key);
            const data = isRecord(res.body?.data) ? res.body.data : null;
            const taskId = data ? asString(data.task_id) : null;
            if (!taskId) throw new ProviderError("Tripo accepted the request but returned no task id.");
            return { taskId, state: trimmedTo !== null ? { prompt_trimmed_to: trimmedTo } : null };
        },

        poll(env, taskId, state): Promise<PollResult> {
            return guardPoll(state, async () => {
                const key = requireKey(env.TRIPO_API_KEY, "TRIPO_API_KEY");
                const res = await vendorFetch(TRIPO, key, `${BASE}/tasks/${encodeURIComponent(taskId)}`);
                assertOk(res, "poll", key);
                const task = isRecord(res.body?.data) ? res.body.data : {};
                const progress = Math.min(99, Math.max(0, Math.round(asNumber(task.progress) ?? 0)));

                switch (task.status) {
                    case "queued":
                        return { status: "queued", progress: 0, stage: withPromptNote("In queue", state) };
                    case "running":
                        return {
                            status: "running",
                            progress,
                            stage: withPromptNote(parts ? "Generating parts" : "Generating textured model", state),
                        };
                    case "success": {
                        const output = isRecord(task.output) ? task.output : {};
                        // v3 names it model_url; pbr_model / model are the v2 spellings, kept as a fallback.
                        const glbUrl = [output.model_url, output.pbr_model, output.model]
                            .map(fileUrl)
                            .find((u) => u !== null && looksLikeGlb(u));
                        if (!glbUrl) {
                            return { status: "failed", error: "Tripo finished, but the result contained no GLB file." };
                        }
                        return {
                            status: "succeeded",
                            glbUrl,
                            thumbnailUrl: fileUrl(output.rendered_image_url) ?? fileUrl(output.rendered_image),
                        };
                    }
                    case "failed": {
                        const message = asString(task.error_message);
                        return { status: "failed", error: `Tripo could not generate this model${message ? `: ${message}` : "."}` };
                    }
                    case "banned":
                        return { status: "failed", error: "Tripo rejected the prompt (content policy). Try rewording it." };
                    case "expired":
                        return { status: "failed", error: "The Tripo result expired before it could be saved." };
                    case "cancelled":
                        return { status: "canceled" };
                    default:
                        return { status: "running", stage: withPromptNote("Generating model", state) };
                }
            });
        },
    };
}

// Tripo H3.1 with generate_parts: separate, editable parts, so the GLB is a real assembly. Untextured by design (the
// API rejects parts together with texture/pbr). 10 credits for the mesh + 20 for parts = 30 credits = $0.30; ~40 s plus
// the part split. quad and smart_low_poly would disable parts and are not sent.
export const tripoParts = tripoAdapter({ parts: true });

// Tripo H3.1 with standard PBR textures: 20 credits = $0.20, about 120 s per Tripo's model page.
export const tripoTextured = tripoAdapter({ parts: false });
