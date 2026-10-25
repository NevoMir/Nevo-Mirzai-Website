// The client of the optimizer's one endpoint: a goal in words and the facts about the model in, an optimization spec out
// (POST /llm/optimize-spec, worker/optimizeSpec.ts). Saving an optimized version is the ordinary createDerivedModel of lib/api.ts.

import { accessHeaders, apiRequest } from "@/assignment/lib/api";
import type { OptimizeSpecBody, OptimizeSpecResponse } from "@/assignment/shared/contract";

/** The Worker waits up to 40 s for the model and may try twice; the page gives up a little after that. */
export const OPTIMIZE_SPEC_TIMEOUT_MS = 95_000;

/** A signal that fires when either the caller's does or the time is up (older browsers without AbortSignal.any get the caller's alone plus a timer). */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal | undefined {
    if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return signal;
    const timeout = AbortSignal.timeout(ms);
    if (!signal) return timeout;
    return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

/** Asks Muse Spark for the spec of `goal`. Rejects with an ApiRequestError (429 daily limit, 503 not set up, 502/504 the model did not answer) or an AbortError. */
export function requestOptimizeSpec(body: OptimizeSpecBody, signal?: AbortSignal): Promise<OptimizeSpecResponse> {
    return apiRequest<OptimizeSpecResponse>("POST", "/llm/optimize-spec", { json: body, headers: accessHeaders(), signal: withTimeout(signal, OPTIMIZE_SPEC_TIMEOUT_MS) });
}
