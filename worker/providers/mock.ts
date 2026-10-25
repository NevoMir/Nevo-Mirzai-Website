// Offline demo provider (MOCK_PROVIDER=1, local dev only): fakes a ~12 s generation and "returns" the bundled
// desk-lamp assembly, so the whole app can be exercised without an API key or any cost.

import type { PartsDesign } from "../../src/assignment/shared/partsDesign.ts";
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

// ---------- canned edit answers (MOCK_PROVIDER=1) ----------
//
// With MOCK_PROVIDER=1 (local development only: production never sets it) the edit tasks of the Muse designer are answered without calling OpenRouter,
// so the smoke tests run offline and cost nothing, even when .dev.vars also holds a real key. MOCK_LLM=0 turns that off to try the real model locally.
// The answers have the shape of the model's strict JSON, so they go through the same cleaning as a real one.

/** True when the edit tasks should return canned answers. */
export function mockLlmEnabled(env: Env): boolean {
    return env.MOCK_PROVIDER === "1" && env.MOCK_LLM !== "0";
}

const MOCK_COLORS = ["#d9534f", "#5cb85c"] as const;

/** A design edit: every part written out again in one colour (the other colour when the first part has it already, so two edits in a row differ). */
export function mockDesignPatch(design: PartsDesign): unknown {
    const color = design.parts[0]?.color.toLowerCase() === MOCK_COLORS[0] ? MOCK_COLORS[1] : MOCK_COLORS[0];
    return {
        summary: "Repainted every part (demo).",
        applied: true,
        remove: [],
        recolor: [],
        parts: design.parts.map((p) => ({ name: p.name, shape: p.shape, size: p.size, position: p.position, rotation: p.rotation, color })),
    };
}

/** A mesh plan: one whole-model recolor (the flat form the strict schema forces; every unused field carries its neutral value). */
export function mockMeshProgram(): unknown {
    return {
        summary: "Tinted the whole model red (demo).",
        applied: true,
        regen_prompt: "",
        ops: [
            {
                op: "recolor",
                label: "whole model",
                boxes: [],
                exclude: [],
                feather_mm: 20,
                axis: "x",
                from_mm: 0,
                to_mm: 0,
                amount_mm: 0,
                vector_mm: [0, 0, 0],
                factors: [1, 1, 1],
                pivot_mm: [0, 0, 0],
                degrees: 0,
                mirror_at_mm: 0,
                color: MOCK_COLORS[0],
                strength: 0.6,
                parts: [],
            },
        ],
    };
}
