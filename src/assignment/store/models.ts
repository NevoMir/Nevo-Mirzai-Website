// What the Models tab and the chat's model cards do to the project's models: delete a stabilized version. Plain functions
// over the stores (not hooks), like store/generation.ts.

import { deleteModel } from "@/assignment/lib/api";
import { toast } from "@/assignment/components/ui/sonner";
import { descendantsOf } from "@/assignment/components/workspace/modelGroups";
import type { ModelAsset } from "@/assignment/shared/contract";
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
