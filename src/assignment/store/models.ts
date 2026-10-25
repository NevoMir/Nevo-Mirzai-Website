// What the Models tab, the version control's tree and the chat's model cards do to the project's models: delete a version. Plain
// functions over the stores (not hooks), like store/generation.ts.

import { deleteModel } from "@/assignment/lib/api";
import { toast } from "@/assignment/components/ui/sonner";
import type { ModelAsset } from "@/assignment/shared/contract";
import { canDelete, subtreeIds } from "@/assignment/shared/versionTree";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const errorText = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

export type DeleteOutcome = { ok: true; removed: string[] } | { ok: false; error: string };

/**
 * Delete a version (stabilized, edited or optimized) and, as the server does, every version made from it. A root (a generated model or an
 * example) is never touched: a project can only lose versions. When the viewer was showing a deleted version it goes back to the model the
 * version was made from.
 */
export async function deleteVersion(model: ModelAsset): Promise<DeleteOutcome> {
    if (!canDelete(model)) return { ok: false, error: "Only versions can be deleted." };
    const store = useWorkspaceStore.getState();
    // Work out the family from the list the server just agreed with, before anything changes.
    const family = subtreeIds(store.models, model.id);
    try {
        await deleteModel(model.id);
    } catch (err) {
        toast.error("Could not delete the version", { description: errorText(err) });
        return { ok: false, error: errorText(err) };
    }
    const now = useWorkspaceStore.getState();
    // A different project may be open by the time the answer lands; its list has none of these ids.
    now.removeModels(family, model.source_model_id);
    toast(family.length > 1 ? `Deleted ${family.length} versions` : "Version deleted");
    return { ok: true, removed: family };
}

/**
 * The card's Undo: `deleteVersion` for a version nothing was made from. The question is asked again here, against the list as it is now,
 * because a card can be a screen behind the work (a stabilized or optimized version made from the edit since) and the delete takes the
 * whole subtree, for good. Where something was made from it, nothing is deleted and the person is told where the question gets asked.
 */
export async function undoVersion(model: ModelAsset): Promise<DeleteOutcome> {
    const later = subtreeIds(useWorkspaceStore.getState().models, model.id).length - 1;
    if (later > 0) {
        toast.info("Other versions were made from this one", { description: "Delete it in the Models tab to remove it together with them." });
        return { ok: false, error: "Other versions were made from this one." };
    }
    return deleteVersion(model);
}

/** The older name of `deleteVersion`, from when the stabilizer made the only kind of version. */
export const deleteStabilized = deleteVersion;
