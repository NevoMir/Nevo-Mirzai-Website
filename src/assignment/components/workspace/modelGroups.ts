// How the Models tab files a project's models: a stabilized version sits under the model it was made from.
// Pure functions over the model list (oldest first, as the server and the store keep it), so they run in Node tests.

import type { ModelAsset } from "@/assignment/shared/contract";

/** A version made from the model above it: `depth` 1 is made from the source, 2 from a version of it, and so on. */
export interface ModelVersion {
    model: ModelAsset;
    depth: number;
}

/** A model nobody made from another one (a generated model, an example) with the stabilized versions hanging off it. */
export interface ModelGroup {
    source: ModelAsset;
    /** Depth first, each level oldest first, so a chain reads in the order it was made. */
    versions: ModelVersion[];
}

const isStabilized = (model: ModelAsset): boolean => model.kind === "stabilized";

/** The models made directly from `id`, in list order. */
function childrenOf(models: readonly ModelAsset[], id: string): ModelAsset[] {
    return models.filter((m) => isStabilized(m) && m.source_model_id === id && m.id !== id);
}

/**
 * The groups of a model list, newest source first. A stabilized model whose source is not in the list (deleted, or
 * not loaded) stands as a source itself, and so does anything in a cycle (the server never writes one): no model is
 * ever hidden by the grouping.
 */
export function groupModels(models: readonly ModelAsset[]): ModelGroup[] {
    const ids = new Set(models.map((m) => m.id));
    const placed = new Set<string>();
    const walk = (parent: ModelAsset, depth: number, out: ModelVersion[]): void => {
        for (const child of childrenOf(models, parent.id)) {
            if (placed.has(child.id)) continue;
            placed.add(child.id);
            out.push({ model: child, depth });
            walk(child, depth + 1, out);
        }
    };
    const groups: ModelGroup[] = [];
    // Sources first, so a version is never mistaken for one while it is still waiting to be placed.
    for (const model of models) {
        const isVersion = isStabilized(model) && model.source_model_id !== null && model.source_model_id !== model.id && ids.has(model.source_model_id);
        if (isVersion) continue;
        placed.add(model.id);
        const versions: ModelVersion[] = [];
        walk(model, 1, versions);
        groups.push({ source: model, versions });
    }
    // What is left sits in a cycle of versions: show each as a source rather than lose it.
    for (const model of models) {
        if (placed.has(model.id)) continue;
        placed.add(model.id);
        const versions: ModelVersion[] = [];
        walk(model, 1, versions);
        groups.push({ source: model, versions });
    }
    return groups.reverse();
}

/** Every version made from `id`, directly or through another version: what DELETE /models/:id takes with it. */
export function descendantsOf(models: readonly ModelAsset[], id: string): ModelAsset[] {
    const out: ModelAsset[] = [];
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length > 0) {
        const parent = queue.shift() as string;
        for (const child of childrenOf(models, parent)) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            out.push(child);
            queue.push(child.id);
        }
    }
    return out;
}

/** The model a stabilized version was made from, if it is still in the list. */
export function sourceOf(model: ModelAsset, models: readonly ModelAsset[]): ModelAsset | null {
    if (!isStabilized(model) || model.source_model_id === null) return null;
    return models.find((m) => m.id === model.source_model_id) ?? null;
}

/** The newest version made directly from `model`, if any. */
export function newestVersionOf(model: ModelAsset, models: readonly ModelAsset[]): ModelAsset | null {
    const children = childrenOf(models, model.id);
    return children.length > 0 ? children[children.length - 1] : null;
}

/** What the other half of a pair is called on the link: "Previous" when a stabilized version was made from another one. */
export type PairLabel = "Original" | "Stabilized" | "Previous";

/**
 * The model to flip to from this one: a stabilized version's source ("Original", or "Previous" when that is itself a
 * stabilized version), or the newest stabilized version of an original. The label says which way the link points.
 */
export function pairOf(model: ModelAsset, models: readonly ModelAsset[]): { model: ModelAsset; label: PairLabel } | null {
    if (isStabilized(model)) {
        const source = sourceOf(model, models);
        return source ? { model: source, label: isStabilized(source) ? "Previous" : "Original" } : null;
    }
    const version = newestVersionOf(model, models);
    return version ? { model: version, label: "Stabilized" } : null;
}
