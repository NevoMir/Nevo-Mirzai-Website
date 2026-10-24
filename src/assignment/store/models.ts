// What the Models tab and the chat's model cards do to the project's models: delete a stabilized version, open the
// before/after comparison. Plain functions over the stores (not hooks), like store/generation.ts.

import { deleteModel } from "@/assignment/lib/api";
import { toast } from "@/assignment/components/ui/sonner";
import { descendantsOf } from "@/assignment/components/workspace/modelGroups";
import type { ModelAsset } from "@/assignment/shared/contract";
import { openAnalysisFor, useAnalysisStore } from "@/assignment/store/analysis";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const errorText = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

export type DeleteOutcome = { ok: true; removed: string[] } | { ok: false; error: string };

/**
 * Delete a stabilized version (and, as the server does, every version made from it). The original is never touched:
 * a project can only lose models that the stabilizer added. When the viewer was showing a deleted version it goes
 * back to the model the version was made from.
 */
export async function deleteStabilized(model: ModelAsset): Promise<DeleteOutcome> {
    if (model.kind !== "stabilized") return { ok: false, error: "Only stabilized versions can be deleted." };
    const store = useWorkspaceStore.getState();
    // Work out the family from the list the server just agreed with, before anything changes.
    const family = [model, ...descendantsOf(store.models, model.id)].map((m) => m.id);
    try {
        await deleteModel(model.id);
    } catch (err) {
        toast.error("Could not delete the stabilized version", { description: errorText(err) });
        return { ok: false, error: errorText(err) };
    }
    const now = useWorkspaceStore.getState();
    // A different project may be open by the time the answer lands; its list has none of these ids.
    now.removeModels(family, model.source_model_id);
    toast(family.length > 1 ? `Deleted ${family.length} stabilized versions` : "Stabilized version deleted");
    return { ok: true, removed: family };
}

/** How long Compare waits for the analysis of the model it opened (a big model, a slow phone). */
const COMPARE_WAIT_MS = 60_000;

/**
 * Open the stabilized version in the Analysis tab with the before/after overlay: the original blocks in slate and
 * what the stabilizer added in the colour of its role. The analysis store only accepts a comparison for the result it
 * holds, and starts every model on its own view, so the switch waits until this model's analysis has landed. Choosing
 * another model first, or the analysis taking too long, cancels it.
 */
export function openCompare(model: ModelAsset): void {
    openAnalysisFor(model.id);
    const ready = (s: ReturnType<typeof useAnalysisStore.getState>): boolean => s.resultModelId === model.id && Boolean(s.result?.assembly);
    if (ready(useAnalysisStore.getState())) {
        useAnalysisStore.getState().setCompare("overlay");
        return;
    }
    const stop = useAnalysisStore.subscribe((state) => {
        if (useWorkspaceStore.getState().activeModelId !== model.id) return done();
        if (!ready(state)) return;
        done();
        // Outside the store's own update: setCompare sets state again.
        queueMicrotask(() => useAnalysisStore.getState().setCompare("overlay"));
    });
    // Neither the callback above nor this timer can run before both exist.
    const timer = setTimeout(() => done(), COMPARE_WAIT_MS);
    function done(): void {
        stop();
        clearTimeout(timer);
    }
}
