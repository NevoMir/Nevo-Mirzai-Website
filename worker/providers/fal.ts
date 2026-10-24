// fal.ai queue adapters: one key (FAL_KEY) for Meshy 7.1, Rodin Gen-2.5, Hunyuan 3D 3.1 Pro and Tripo H3.1.
//
// Queue flow (https://fal.ai/docs/documentation/model-apis/inference/queue):
//   POST https://queue.fal.run/<endpoint_id>  -> { request_id, status_url, response_url, cancel_url, queue_position }
//   GET  status_url   -> { status: IN_QUEUE | IN_PROGRESS | COMPLETED, queue_position?, error?, error_type? }
//   GET  response_url -> the model's output JSON (only once COMPLETED without `error`)
//   PUT  cancel_url   -> 200 removed from the queue, 202 cancel signalled, 400 already completed
// Auth is `Authorization: Key <FAL_KEY>`. A failed request shows up as COMPLETED with `error`/`error_type`.
// The status/response/cancel URLs fal returns are used as given: they are built from owner/app only, which
// does not always match the endpoint id (e.g. "meshy/v7.1/text-to-3d").
//
// Endpoint ids and schemas checked 2026-10-23 against https://api.fal.ai/v1/models?endpoint_id=<id>&expand=openapi-3.0
// Fal bills per successful run (queue time and server errors are free).

import {
    ProviderError,
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
    type AdapterState,
    type Json,
    type PollResult,
    type ProviderAdapter,
    type SubmitResult,
    type VendorInfo,
} from "./types.ts";

const QUEUE = "https://queue.fal.run/";

const FAL: VendorInfo = {
    name: "fal.ai",
    authScheme: "Key",
    billingUrl: "fal.ai/dashboard/billing",
    classify(reply) {
        const body = reply.body;
        if (body) {
            const details = Array.isArray(body.detail) ? body.detail : [];
            const flagged = details.some((d) => isRecord(d) && d.type === "content_policy_violation");
            if (flagged || body.error_type === "content_policy_violation") return "content";
        }
        // A locked or empty account is rejected with a 403 whose text talks about the balance.
        if ((reply.status === 402 || reply.status === 403) && /balance|locked|exhausted|credit/i.test(reply.text)) {
            return "credits";
        }
        return null;
    },
};

interface FalOutput {
    glbUrl: string | null;
    thumbnailUrl: string | null;
}

interface FalModel {
    endpoint: string; // fal endpoint id, also the path under queue.fal.run
    promptLimit: number;
    input(prompt: string): Json;
    extract(output: Json): FalOutput;
}

interface FalState {
    request_id: string;
    status_url: string;
    response_url: string;
    cancel_url: string;
}

/** The https URL of a file field if it is a GLB. */
function glbOf(value: unknown): string | null {
    const url = fileUrl(value);
    return looksLikeGlb(url, isRecord(value) ? asString(value.file_name) : null) ? url : null;
}

function clip(text: string, max = 200): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Only ever send the key to fal's own queue host, whatever ended up in the stored state. */
function queueUrl(value: unknown, fallback: string): string {
    const url = asString(value);
    return url !== null && url.startsWith(QUEUE) ? url : fallback;
}

function readState(state: AdapterState, taskId: string, endpoint: string): FalState {
    const s = isRecord(state) ? state : {};
    // Owner/app only, like fal's own convenience URLs; the real URLs come from the submit response.
    const base = `${QUEUE}${endpoint.split("/").slice(0, 2).join("/")}/requests/${encodeURIComponent(taskId)}`;
    return {
        request_id: taskId,
        status_url: queueUrl(s.status_url, `${base}/status`),
        response_url: queueUrl(s.response_url, base),
        cancel_url: queueUrl(s.cancel_url, `${base}/cancel`),
    };
}

function runError(body: Json): string {
    const type = asString(body.error_type);
    if (type === "content_policy_violation") {
        return "fal.ai rejected the prompt (content policy). Try rewording it.";
    }
    if (type === "request_timeout" || type === "startup_timeout") {
        return "fal.ai timed out while generating the model. Try again.";
    }
    const message = asString(body.error);
    return `fal.ai could not generate this model${message ? `: ${clip(message)}` : ""}`;
}

function falQueueAdapter(model: FalModel): ProviderAdapter {
    return {
        via: "fal",

        async submit(env, rawPrompt): Promise<SubmitResult> {
            const key = requireKey(env.FAL_KEY, "FAL_KEY");
            const { prompt, trimmedTo } = preparePrompt(rawPrompt, model.promptLimit);
            const res = await vendorFetch(FAL, key, `${QUEUE}${model.endpoint}`, {
                method: "POST",
                json: model.input(prompt),
            });
            if (res.status >= 300) throw failure(FAL, res, "submit", key);
            const requestId = asString(res.body?.request_id);
            if (!requestId) throw new ProviderError("fal.ai accepted the request but returned no request id.");
            const urls = readState({ ...res.body }, requestId, model.endpoint);
            return {
                taskId: requestId,
                state: { ...urls, ...(trimmedTo !== null ? { prompt_trimmed_to: trimmedTo } : {}) },
            };
        },

        poll(env, taskId, state): Promise<PollResult> {
            return guardPoll(state, async () => {
                const key = requireKey(env.FAL_KEY, "FAL_KEY");
                const urls = readState(state, taskId, model.endpoint);
                const status = await vendorFetch(FAL, key, urls.status_url);
                if (status.status >= 300) throw failure(FAL, status, "poll", key);
                const body = status.body ?? {};

                if (body.status === "IN_QUEUE") {
                    const position = asNumber(body.queue_position);
                    const stage = position !== null && position > 0 ? `In queue (position ${position})` : "In queue";
                    return { status: "queued", stage: withPromptNote(stage, state) };
                }
                if (body.status !== "COMPLETED") {
                    // IN_PROGRESS, or a status fal adds later: the work is going on either way.
                    return { status: "running", stage: withPromptNote("Generating model", state) };
                }
                if (asString(body.error) !== null || asString(body.error_type) !== null) {
                    return { status: "failed", error: runError(body) };
                }

                const result = await vendorFetch(FAL, key, urls.response_url);
                if (result.status >= 300) throw failure(FAL, result, "poll", key);
                const { glbUrl, thumbnailUrl } = model.extract(result.body ?? {});
                if (glbUrl === null) {
                    return { status: "failed", error: "fal.ai finished, but the result contained no GLB file." };
                }
                return { status: "succeeded", glbUrl, thumbnailUrl };
            });
        },

        async cancel(env, taskId, state): Promise<void> {
            try {
                const key = requireKey(env.FAL_KEY, "FAL_KEY");
                await vendorFetch(FAL, key, readState(state, taskId, model.endpoint).cancel_url, { method: "PUT" });
            } catch {
                // best effort: the job is marked canceled either way
            }
        },
    };
}

// Meshy 7.1 through fal. mode "full" = untextured preview + texture pass in one run; fal's page lists
// $0.80 for the mesh and $1.20 in total with textures. Prompt limit is 600 characters here (800 on Meshy's own API).
export const falMeshy = falQueueAdapter({
    endpoint: "meshy/v7.1/text-to-3d",
    promptLimit: 600,
    input: (prompt) => ({
        prompt,
        mode: "full",
        enable_pbr: true,
        model_type: "standard",
        topology: "triangle",
        should_remesh: true,
        target_polycount: 30000, // keeps the GLB light enough for the browser viewer
    }),
    extract: (out) => {
        const urls = isRecord(out.model_urls) ? out.model_urls : {};
        return { glbUrl: glbOf(out.model_glb) ?? glbOf(urls.glb), thumbnailUrl: fileUrl(out.thumbnail) };
    },
});

// Hyper3D Rodin Gen-2.5 through fal: $0.40 per run (any tier but Extreme-High; HighPack would add $0.80).
// Medium tier at 150K triangles with PBR only: the default (Auto = 500K triangles, material "All" = two GLBs) gives
// 30+ MB files, which are slow to fetch, store and render. Output: model_mesh is the GLB, textures[] holds preview.webp.
export const falRodin = falQueueAdapter({
    endpoint: "fal-ai/hyper3d/rodin/v2.5/text-to-3d",
    promptLimit: 1024,
    input: (prompt) => ({
        prompt,
        tier: "Gen-2.5-Medium",
        quality_mesh_option: "150K Triangle",
        material: "PBR",
        geometry_file_format: "glb",
    }),
    extract: (out) => {
        const extra = Array.isArray(out.model_meshes) ? out.model_meshes : [];
        const textures = Array.isArray(out.textures) ? out.textures : [];
        const preview = textures.find((t) => isRecord(t) && /preview/i.test(asString(t.file_name) ?? ""));
        return {
            glbUrl: glbOf(out.model_mesh) ?? extra.map(glbOf).find((u) => u !== null) ?? null,
            thumbnailUrl: fileUrl(preview),
        };
    },
});

// Tencent Hunyuan 3D 3.1 Pro through fal: $0.375 per run for a textured model (enable_pbr would add $0.15, a custom
// face_count another $0.15). Default 500K faces, so expect a large GLB (the textures alone can be ~20 MB).
export const falHunyuan = falQueueAdapter({
    endpoint: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
    promptLimit: 1024,
    input: (prompt) => ({ prompt, generate_type: "Normal", enable_pbr: false }),
    extract: (out) => {
        const urls = isRecord(out.model_urls) ? out.model_urls : {};
        return { glbUrl: glbOf(out.model_glb) ?? glbOf(urls.glb), thumbnailUrl: fileUrl(out.thumbnail) };
    },
});

// Tripo H3.1 through fal (the fallback when only FAL_KEY is set): $0.20 per run with standard PBR textures
// ($0.10 untextured, $0.30 detailed textures). fal's wrapper has no generate_parts option, so the "Parts" model
// needs a direct Tripo key. quad stays off because Tripo returns FBX for quad meshes.
export const falTripo = falQueueAdapter({
    endpoint: "tripo3d/h3.1/text-to-3d",
    promptLimit: 1024,
    input: (prompt) => ({
        prompt,
        texture: true,
        pbr: true,
        texture_quality: "standard",
        geometry_quality: "standard",
    }),
    extract: (out) => {
        const urls = isRecord(out.model_urls) ? out.model_urls : {};
        return {
            glbUrl: glbOf(urls.pbr_model) ?? glbOf(urls.glb) ?? glbOf(out.model_mesh) ?? glbOf(urls.base_model),
            thumbnailUrl: fileUrl(out.rendered_image),
        };
    },
});
