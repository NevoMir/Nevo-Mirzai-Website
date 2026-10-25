// The client of POST /llm/voxel-edit: one instruction and the text description of the blocks in, the operations the AI editor chose out
// (worker/voxelEdit.ts). The Worker owns the prompt and the schema; this sends only what the person typed and the scene text, and the
// stored access code like generation does.

import { accessHeaders, apiRequest } from "@/assignment/lib/api";
import type { VoxelEditBody, VoxelEditResponse } from "@/assignment/shared/contract";

/** The Worker waits up to 45 s for the model (one retry): the page gives up a little after that. */
export const VOXEL_EDIT_REQUEST_TIMEOUT_MS = 100_000;

/** A signal that aborts when any of `signals` does (AbortSignal.any where it exists). */
function anySignal(signals: AbortSignal[]): AbortSignal {
    if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
    const controller = new AbortController();
    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

/**
 * Asks for the operations that carry out `body.instruction` on the blocks described by `body.scene`. Rejects with an ApiRequestError whose
 * message is fit for the person (no key, daily limit used up, the model's answer unreadable, ...), or an AbortError when `signal` aborts.
 */
export function requestVoxelEdit(body: VoxelEditBody, signal?: AbortSignal): Promise<VoxelEditResponse> {
    const limit = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(VOXEL_EDIT_REQUEST_TIMEOUT_MS) : undefined;
    const signals = [signal, limit].filter((s): s is AbortSignal => s !== undefined);
    return apiRequest<VoxelEditResponse>("POST", "/llm/voxel-edit", {
        json: body,
        headers: accessHeaders(),
        signal: signals.length > 1 ? anySignal(signals) : signals[0],
    });
}
