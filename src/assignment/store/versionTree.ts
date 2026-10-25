// The part of a model's versions that is plain data: which stabilized models descend from which. No React and no store, so
// store/versions.ts (the family the viewer and the bar use) and store/stabilizeLogic.ts (the Stabilize card's "Open stabilized
// version") read the tree the same way and scripts/assignment/test-*.mjs can import it as it is.

import type { ModelAsset } from "@/assignment/shared/contract";

/** What the tree needs of a model. */
export type TreeModel = Pick<ModelAsset, "id" | "kind" | "source_model_id" | "created_at">;

/** Time of a model for ordering; a missing or unreadable stamp sorts as the oldest. */
const timeOf = (model: Pick<ModelAsset, "created_at">): number => {
    const t = Date.parse(model.created_at);
    return Number.isFinite(t) ? t : 0;
};

/**
 * Every stabilized model made from `rootId`, directly or from another version of it, newest first. A version is below the root
 * when its source is. Models made in the same instant (an example's twin) go by their place in `models`, which is oldest first.
 */
export function descendantsOf<T extends TreeModel>(models: readonly T[], rootId: string): T[] {
    const below = new Set<string>([rootId]);
    const found: Array<{ model: T; at: number }> = [];
    let grew = true;
    while (grew) {
        grew = false;
        models.forEach((m, at) => {
            if (m.kind !== "stabilized" || below.has(m.id) || m.source_model_id === null || !below.has(m.source_model_id)) return;
            below.add(m.id);
            found.push({ model: m, at });
            grew = true;
        });
    }
    found.sort((a, b) => timeOf(b.model) - timeOf(a.model) || b.at - a.at);
    return found.map((f) => f.model);
}
