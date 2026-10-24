// Offline demo provider (MOCK_PROVIDER=1, local dev only): fakes a ~12 s generation and "returns" the bundled
// desk-lamp assembly, so the whole app can be exercised without an API key or any cost.

import { DEMO_GLB_BASE64 } from "./mock-fixture.ts";
import { ProviderError, type AdapterState, type Env, type PollResult, type ProviderAdapter } from "./types.ts";

const RUN_MS = 12_000;
const FAIL_MS = 4_000;
const DEMO_ASSET_PATH = "/assignment_alex/fixtures/demo-assembly.glb";

/** The served fixture when the deployed assets have it (any build does); otherwise the copy embedded in the Worker. */
async function demoGlbUrl(env: Env): Promise<string> {
    try {
        const res = await env.ASSETS.fetch(new Request(new URL(DEMO_ASSET_PATH, "https://assets.local")));
        const isModel = res.ok && !(res.headers.get("content-type") ?? "").includes("text/html");
        await res.body?.cancel();
        if (isModel) return `asset:${DEMO_ASSET_PATH}`;
    } catch {
        // fall through to the embedded copy
    }
    return `data:model/gltf-binary;base64,${DEMO_GLB_BASE64}`;
}

export const mockAdapter: ProviderAdapter = {
    via: "mock",

    async submit(_env, prompt) {
        if (!prompt.trim()) throw new ProviderError("The demo provider needs a prompt.", 400);
        return { taskId: `mock-${crypto.randomUUID()}`, state: { started_at: Date.now(), prompt } };
    },

    async poll(env, _taskId, state: AdapterState): Promise<PollResult> {
        const startedAt = typeof state?.started_at === "number" ? state.started_at : 0;
        const prompt = typeof state?.prompt === "string" ? state.prompt : "";
        const elapsed = Date.now() - startedAt;

        // Lets the UI's failure path be exercised on demand: a prompt containing the word "fail".
        if (/\bfail\b/i.test(prompt)) {
            if (elapsed >= FAIL_MS) {
                return { status: "failed", error: 'The demo provider failed on purpose (prompt contains "fail").' };
            }
            return { status: "running", progress: Math.round((elapsed / FAIL_MS) * 80), stage: "Generating mesh" };
        }

        if (elapsed >= RUN_MS) return { status: "succeeded", glbUrl: await demoGlbUrl(env), thumbnailUrl: null };
        const progress = Math.min(99, Math.round((elapsed / RUN_MS) * 100));
        const stage = progress < 45 ? "Generating mesh" : progress < 85 ? "Splitting parts" : "Finishing";
        return { status: "running", progress, stage };
    },

    // Nothing runs anywhere, so Stop always works. Defining cancel() is also what tells the engine that a started job
    // of this adapter can be stopped (a vendor that cannot, like Tencent, has none).
    async cancel(): Promise<void> {},
};
