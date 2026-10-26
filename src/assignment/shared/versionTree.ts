// The version tree of a project, as plain data. One tree per project: a root (a generated model or an example) and the versions made from it
// by the stabilizer, by words (edited: parts, mesh or blocks) and by the optimizer (optimized). Every version has one parent
// (`source_model_id`), so the whole tree is read from the model list.
//
// The tree decides, for any model: what the stage draws and what is drawn over it (`stageOf`), what an edit by words would act on
// (`editTargetFor`), which two versions the top bar flips between (`headOf`, `stepTarget`), how a version is named (`versionName`,
// `versionTitle`), and which rows the Models tab shows (`treeRows`, `forestOf`). No React and no stores, and no imports besides types, so the bar, the
// Models tab, the chat cards, the stores and the Node tests all read the tree through these functions.

import type { DerivedMeta, EditMeta, EditTarget, ModelKind, ModelProvider, OptimizeSummary } from "./contract.ts";

/** The tabs of the top bar (the store's WorkspaceTab is this same union). */
export type WorkTab = "3d" | "analysis" | "optimize" | "models";

/** What the tree needs of a model. A ModelAsset satisfies it; test fixtures may leave out what a kind does not use. */
export interface TreeModel {
    id: string;
    kind: ModelKind;
    source_model_id: string | null;
    created_at: string;
    provider?: ModelProvider;
    derived?: Pick<DerivedMeta, "depth"> | null;
    edit?: Pick<EditMeta, "target"> & Partial<Pick<EditMeta, "label" | "stabilized_depth">> | null;
    optimization?: Pick<OptimizeSummary, "shape_changed"> & Partial<Pick<OptimizeSummary, "title" | "stabilized_depth">> | null;
}

const VERSION_KINDS: readonly ModelKind[] = ["stabilized", "edited", "optimized"];

/** A version is any model made from another one (stabilized, edited, optimized); a root (generated, example) is not. */
export const isVersion = (m: Pick<TreeModel, "kind">): boolean => VERSION_KINDS.includes(m.kind);

const timeOf = (m: Pick<TreeModel, "created_at">): number => {
    const t = Date.parse(m.created_at);
    return Number.isFinite(t) ? t : 0;
};

// ---------- shape ----------

/** The model `m` was made from, when `m` is a version and the project has it. */
export function parentOf<T extends TreeModel>(models: readonly T[], m: T): T | null {
    return isVersion(m) && m.source_model_id ? (models.find((x) => x.id === m.source_model_id) ?? null) : null;
}

/** The model nobody made from another one that `m` descends from; null when a link is missing or the chain loops. */
export function rootOf<T extends TreeModel>(models: readonly T[], m: T): T | null {
    const seen = new Set<string>();
    let cur: T | null = m;
    while (cur && isVersion(cur)) {
        if (seen.has(cur.id)) return null;
        seen.add(cur.id);
        cur = parentOf(models, cur);
    }
    return cur;
}

/** The versions made directly from `id`, in list order. */
export function childrenOf<T extends TreeModel>(models: readonly T[], id: string): T[] {
    return models.filter((m) => isVersion(m) && m.source_model_id === id && m.id !== id);
}

/** Every version below `rootId`, oldest first (creation order is the ordinal order: v2, v3, ...). Models made in one instant go by list order. */
export function versionsBelow<T extends TreeModel>(models: readonly T[], rootId: string): T[] {
    const below = new Set<string>([rootId]);
    const out: Array<{ m: T; at: number }> = [];
    let grew = true;
    while (grew) {
        grew = false;
        models.forEach((m, at) => {
            if (!isVersion(m) || below.has(m.id) || m.source_model_id === null || !below.has(m.source_model_id)) return;
            below.add(m.id);
            out.push({ m, at });
            grew = true;
        });
    }
    return out.sort((a, b) => timeOf(a.m) - timeOf(b.m) || a.at - b.at).map((x) => x.m);
}

/** The same versions, newest first (what the older stabilized-only helpers returned). */
export function descendantsOf<T extends TreeModel>(models: readonly T[], rootId: string): T[] {
    return versionsBelow(models, rootId).reverse();
}

/** v1 is the root; the versions below it count from v2 by creation time. A model with no root (an orphan) counts as 1. */
export function ordinalOf<T extends TreeModel>(models: readonly T[], m: T): number {
    const root = rootOf(models, m);
    if (!root || root.id === m.id) return 1;
    return versionsBelow(models, root.id).findIndex((x) => x.id === m.id) + 2;
}

/** The ordinal of every model of the list at once (what the Models tab needs; `ordinalOf` per row would walk the list again each time). */
export function ordinalMap<T extends TreeModel>(models: readonly T[]): Map<string, number> {
    const out = new Map<string, number>();
    const ids = new Set(models.map((m) => m.id));
    for (const m of models) {
        const isRoot = !isVersion(m) || m.source_model_id === null || m.source_model_id === m.id || !ids.has(m.source_model_id);
        if (!isRoot) continue;
        out.set(m.id, 1);
        versionsBelow(models, m.id).forEach((v, n) => {
            if (!out.has(v.id)) out.set(v.id, n + 2);
        });
    }
    for (const m of models) if (!out.has(m.id)) out.set(m.id, 1);
    return out;
}

export interface TreeRow<T> {
    model: T;
    /** 0 = root. */
    depth: number;
    /** For drawing the connectors: for each ancestor level below the root, whether that ancestor has later siblings (draw a vertical line). */
    lines: boolean[];
    /** The last child of its parent. */
    last: boolean;
}

/** The tree below `root` as rows, depth first, siblings oldest first. `placed` (optional) is shared between trees so no model is listed twice. */
export function treeRows<T extends TreeModel>(models: readonly T[], root: T, placed?: Set<string>): TreeRow<T>[] {
    const rows: TreeRow<T>[] = [];
    const seen = placed ?? new Set<string>();
    seen.add(root.id);
    const walk = (m: T, depth: number, lines: boolean[], last: boolean) => {
        rows.push({ model: m, depth, lines, last });
        const kids = childrenOf(models, m.id)
            .filter((k) => !seen.has(k.id))
            .sort((a, b) => timeOf(a) - timeOf(b));
        kids.forEach((k) => seen.add(k.id));
        kids.forEach((k, n) => walk(k, depth + 1, depth === 0 ? [] : [...lines, !last], n === kids.length - 1));
    };
    walk(root, 0, [], true);
    return rows;
}

/**
 * Every tree of the project, newest root first. A version whose parent is not in the list (deleted, not loaded) stands as a root itself,
 * and so does anything in a cycle (the server never writes one): no model is ever hidden by the layout.
 */
export function forestOf<T extends TreeModel>(models: readonly T[]): Array<{ root: T; rows: TreeRow<T>[] }> {
    const ids = new Set(models.map((m) => m.id));
    const placed = new Set<string>();
    const out: Array<{ root: T; rows: TreeRow<T>[] }> = [];
    const grow = (root: T) => out.push({ root, rows: treeRows(models, root, placed) });
    // Roots first, so a version is never mistaken for one while it is still waiting to be placed.
    for (const m of models) {
        const waiting = isVersion(m) && m.source_model_id !== null && m.source_model_id !== m.id && ids.has(m.source_model_id);
        if (!waiting) grow(m);
    }
    // What is left sits in a cycle of versions: show each as a root rather than lose it.
    for (const m of models) if (!placed.has(m.id)) grow(m);
    return out.reverse();
}

/** Deleting a version takes its whole subtree (the server does the same). The first id is `id` itself. */
export function subtreeIds<T extends TreeModel>(models: readonly T[], id: string): string[] {
    const out = [id];
    for (let n = 0; n < out.length; n++) for (const k of childrenOf(models, out[n])) if (!out.includes(k.id)) out.push(k.id);
    return out;
}

/** Only versions can be deleted; the roots of a project stay. */
export const canDelete = (m: Pick<TreeModel, "kind">): boolean => isVersion(m);

/**
 * "Undo" on a card is a delete without a question, so it is offered only where it takes nothing else with it: an edited or optimized version
 * that no other version was made from. (Where something was, the Models tab's delete asks first and lists what goes.)
 */
export function canUndoVersion<T extends TreeModel>(models: readonly T[], m: T): boolean {
    return (m.kind === "edited" || m.kind === "optimized") && childrenOf(models, m.id).length === 0;
}

// ---------- what a version IS ----------

/** "mesh": a 3D model the viewer draws as it is (generated, example, an edit of a parts design or of a mesh). "blocks": a block assembly. */
export type Representation = "mesh" | "blocks";

export function representation(m: TreeModel): Representation {
    if (m.kind === "stabilized" || m.kind === "optimized") return "blocks";
    if (m.kind === "edited") return m.edit?.target === "voxel" ? "blocks" : "mesh";
    return "mesh";
}

/** A block assembly that was made from another model (stabilized, optimized, edited blocks). */
export const isBlockVersion = (m: TreeModel): boolean => isVersion(m) && representation(m) === "blocks";

/**
 * The mesh model whose picture the stage shows behind a block version, or null when the version shows its own blocks.
 * A stabilized version is its source's blocks plus supports, so it sits on its source's mesh. A block edit changed the blocks themselves, and
 * an optimization that took away a visible block did too: from there on the mesh no longer describes the blocks, so the version (and every
 * version made from it) shows its own blocks. A version whose chain is broken (a missing link, a loop) shows its own blocks as well.
 */
export function meshBaseOf<T extends TreeModel>(models: readonly T[], m: T): T | null {
    const seen = new Set<string>();
    let cur: T | null = m;
    while (cur) {
        if (seen.has(cur.id)) return null;
        seen.add(cur.id);
        if (representation(cur) === "mesh") return cur;
        // Only the person's own block edit changes what the 3D tab shows: an optimization (like a stabilization) keeps the original mesh there.
        const breaks = cur.kind === "edited" && cur.edit?.target === "voxel";
        if (breaks) return null;
        cur = parentOf(models, cur);
    }
    return null;
}

/**
 * What the viewer loads for `m`: `display.glb_url`, with the blocks of `m` drawn over it unless `own`. `own` is true when the stage shows the
 * version's own file (a mesh version, a block edit made with words or a version made from one, an orphan).
 */
export function stageOf<T extends TreeModel>(models: readonly T[], m: T): { display: T; own: boolean } {
    if (representation(m) === "mesh") return { display: m, own: true };
    const base = meshBaseOf(models, m);
    return base && base.id !== m.id ? { display: base, own: false } : { display: m, own: true };
}

/**
 * Stabilizations on the path from the root to `m` (the stabilizer allows MAX_DERIVED_DEPTH of them). A version whose meta is unreadable
 * counts as `unknown` (the caller's conservative number).
 */
export function stabilizationsOfModel(m: TreeModel, unknown = 0): number {
    if (m.kind === "stabilized") return m.derived?.depth ?? unknown;
    if (m.kind === "edited") return m.edit?.stabilized_depth ?? unknown;
    if (m.kind === "optimized") return m.optimization?.stabilized_depth ?? unknown;
    return 0;
}

/** Versions above `m` (parents of any kind), at most `limit` hops; a broken link or a loop ends the count. */
export function chainDepth<T extends TreeModel>(models: readonly T[], m: T, limit = 64): number {
    const seen = new Set<string>([m.id]);
    let depth = 0;
    let cur: T | null = parentOf(models, m);
    while (cur && !seen.has(cur.id) && depth < limit) {
        seen.add(cur.id);
        depth++;
        cur = parentOf(models, cur);
    }
    return depth;
}

// ---------- the words of the person's edits ----------

export interface EditTargetChoice {
    /** What an edit by words would act on: the parts of a design, the mesh, or the blocks. null: none, `reason` says why. */
    target: EditTarget | null;
    reason: string | null;
}

export const NOT_EDITABLE_EXAMPLE = "Edits work on models you generate. Use Change the blocks on the Stability tab.";
export const NOT_EDITABLE_DEMO = "Edits work on models you generate.";
export const NOTHING_TO_EDIT = "There is no model to change yet.";

/**
 * Which kind of edit the composer routes a typed change to. The Stability and Optimization tabs are about the blocks, so a change typed there
 * is a block edit for any version (a mesh is turned into blocks: that is the "unstable" block version). On the 3D tab and the Models tab it follows what
 * the model is: a block version -> blocks; a Muse design (or an edit of its parts) -> its parts; any other generated mesh (Hunyuan, ...) ->
 * the mesh; an example or the offline demo -> none.
 */
export function editTargetFor<T extends TreeModel>(_models: readonly T[], active: T | null, tab: WorkTab): EditTargetChoice {
    if (!active) return { target: null, reason: NOTHING_TO_EDIT };
    if (tab === "analysis" || tab === "optimize") return { target: "voxel", reason: null };
    if (representation(active) === "blocks") return { target: "voxel", reason: null };
    if (active.kind === "edited") {
        // The parts engine again for a design edit, the mesh program again for a mesh edit.
        return active.edit?.target === "design" ? { target: "design", reason: null } : { target: "mesh", reason: null };
    }
    if (active.kind === "example") return { target: null, reason: NOT_EDITABLE_EXAMPLE };
    if (active.provider === "muse") return { target: "design", reason: null };
    if (active.provider === "mock" || active.provider === "example") return { target: null, reason: NOT_EDITABLE_DEMO };
    return { target: "mesh", reason: null };
}

// ---------- names and the pair the bar flips between ----------

/** The kind written as a word, for chips and tooltips. */
export const KIND_WORD: Record<ModelKind, string> = { generated: "Original", example: "Original", stabilized: "Stabilized", edited: "Edited", optimized: "Optimized" };

/** "Taller back", "Stabilized", "Lightest": the version's own name; "Original" for a root. */
export function versionName(m: TreeModel): string {
    if (!isVersion(m)) return KIND_WORD[m.kind];
    if (m.kind === "edited") return m.edit?.label?.trim() || KIND_WORD.edited;
    if (m.kind === "optimized") return m.optimization?.title?.trim() || KIND_WORD.optimized;
    return KIND_WORD.stabilized;
}

/** "v3 · Stabilized": the control's text (a model with no root has no number). */
export function versionTitle<T extends TreeModel>(models: readonly T[], m: T): string {
    if (isVersion(m) && rootOf(models, m) === null) return versionName(m);
    return `v${ordinalOf(models, m)} · ${versionName(m)}`;
}

/** Which version of a family was on screen last, so going back and forth returns to it. */
const lastHead = new Map<string, string>();

/** Note the version on screen (call it whenever a family is shown or left). A root is not a head. */
export function rememberHead<T extends TreeModel>(models: readonly T[], active: T): void {
    const root = rootOf(models, active);
    if (root && isVersion(active)) lastHead.set(root.id, active.id);
}

/** Forget what was remembered (tests; a project that was left). */
export function forgetHeads(): void {
    lastHead.clear();
}

/**
 * The version the bar's right segment stands for ("the one I am working on"): the one on screen, else the one seen last in this family, else
 * the newest. The left segment is always the root ("Original"). Null when the family has no version (or no root).
 */
export function headOf<T extends TreeModel>(models: readonly T[], active: T): T | null {
    const root = rootOf(models, active);
    if (!root) return null;
    if (isVersion(active)) return active;
    const all = versionsBelow(models, root.id);
    if (all.length === 0) return null;
    return all.find((m) => m.id === lastHead.get(root.id)) ?? all[all.length - 1];
}

/**
 * The two models of the Stability tab's switch. Around a stabilization it is the model that was stabilized and its stabilized version (the
 * original, or a version edited with words), so "back" is exactly what the person stabilized; elsewhere the original and the head, as the
 * bar's control. Null when the family has no version (or no root).
 */
export function stabilityPair<T extends TreeModel>(models: readonly T[], active: T): { before: T; after: T } | null {
    const root = rootOf(models, active);
    if (!root) return null;
    if (active.kind === "stabilized") {
        const parent = parentOf(models, active);
        if (parent) return { before: parent, after: active };
    }
    // Back on the model that was stabilized: forward is the stabilized version seen last, when it was made from this one.
    const seen = headOf(models, root);
    if (seen && seen.kind === "stabilized" && seen.source_model_id === active.id) return { before: active, after: seen };
    const head = headOf(models, active);
    return head && head.id !== root.id ? { before: root, after: head } : null;
}

/** `[` goes to the parent, `]` to the newest child. */
export function stepTarget<T extends TreeModel>(models: readonly T[], active: T, dir: "parent" | "child"): T | null {
    if (dir === "parent") return parentOf(models, active);
    // The newest by time; models made in one instant go by their place in the list (later is newer).
    const kids = childrenOf(models, active.id).map((m) => ({ m, at: models.indexOf(m) }));
    kids.sort((a, b) => timeOf(b.m) - timeOf(a.m) || b.at - a.at);
    return kids[0]?.m ?? null;
}

// ---------- caps (the server checks the same numbers inside its INSERT) ----------

/** Versions made directly from `id`. */
export const versionsOfSource = (models: readonly TreeModel[], id: string): number => childrenOf(models, id).length;

/** Versions of every kind in the project. */
export const versionCount = (models: readonly TreeModel[]): number => models.filter(isVersion).length;

/** Mesh edits in the project (15 to 28 MB each; the server caps them). */
export const meshEditCount = (models: readonly TreeModel[]): number => models.filter((m) => m.kind === "edited" && m.edit?.target === "mesh").length;
