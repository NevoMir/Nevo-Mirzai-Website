// Small display helpers shared by the chat's job cards and the Models list.

import { APP_BASE, type ModelAsset, type ModelKind } from "@/assignment/shared/contract";

/** What a name needs of a model. `kind` is optional so a row from an older server still gets a name. */
type Nameable = Pick<ModelAsset, "prompt" | "provider"> & { kind?: ModelKind };

/** What a title needs: the prompt, and for a version its kind and the little its meta says (`edit.label`, `optimization.title`). */
type Titled = Pick<ModelAsset, "prompt"> & {
    kind?: ModelKind;
    edit?: { label?: string } | null;
    optimization?: { title?: string } | null;
};

/** 2_411_000 -> "2.3 MB". */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / (1024 * 1024);
    return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** "3 parts" / "1 part", or null when the GLB's part count is not known. */
export function partsLabel(model: Pick<ModelAsset, "part_count">): string | null {
    const n = model.part_count;
    if (n === null || n < 1) return null;
    return `${n} ${n === 1 ? "part" : "parts"}`;
}

/**
 * The model's name in lists and cards: "Stabilized · {prompt}" for a corrected version, "Edited · {what was asked}" for a change made by
 * words, "Optimized · {goal}" for an optimized one, else the prompt itself.
 */
export function modelTitle(model: Titled): string {
    if (model.kind === "stabilized") return `Stabilized · ${model.prompt}`;
    if (model.kind === "edited") return `Edited · ${model.edit?.label?.trim() || model.prompt}`;
    if (model.kind === "optimized") return `Optimized · ${model.optimization?.title?.trim() || model.prompt}`;
    return model.prompt;
}

/** "+14 blocks" / "+1 block": what the stabilizer added. */
export function addedBlocksLabel(count: number): string {
    return `+${count} ${count === 1 ? "block" : "blocks"}`;
}

const MINUS = "−";

/** "+12 blocks", "−3 blocks", "+12 −3 blocks": what a block edit added and took away. */
function blockChangeLabel(added: number, removed: number, moved: number): string | null {
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`${MINUS}${removed}`);
    if (parts.length > 0) return `${parts.join(" ")} ${added + removed === 1 ? "block" : "blocks"}`;
    return moved > 0 ? `${moved} ${moved === 1 ? "block" : "blocks"} moved` : null;
}

/** "−23% weight" / "+5% weight": what an optimization did to the weight, or null when it stayed. */
function weightChangeLabel(before: number, after: number): string | null {
    if (!(before > 0) || !Number.isFinite(after)) return null;
    const pct = Math.round(((after - before) / before) * 100);
    return pct === 0 ? null : `${pct < 0 ? MINUS : "+"}${Math.abs(pct)}% weight`;
}

/**
 * The few words that say what a version did, after its name: "+16 blocks" for a stabilized one, what a change by words touched, "−23% weight"
 * for an optimized one. null when there is nothing to add (a root, or a version whose meta could not be read).
 */
export function versionDetail(model: Pick<ModelAsset, "kind"> & Partial<Pick<ModelAsset, "derived" | "edit" | "optimization">>): string | null {
    if (model.kind === "stabilized") {
        const derived = model.derived;
        return derived ? (derived.added_blocks === 0 ? "No blocks added" : addedBlocksLabel(derived.added_blocks)) : null;
    }
    if (model.kind === "edited" && model.edit) {
        const { target, entries, changes, ops } = model.edit;
        if (target === "voxel") {
            const sum = (key: "added" | "removed" | "moved") => entries.reduce((n, e) => n + e[key], 0);
            return blockChangeLabel(sum("added"), sum("removed"), sum("moved"));
        }
        if (target === "design") {
            const n = changes ? changes.added.length + changes.changed.length + changes.removed.length : entries.reduce((k, e) => k + e.added + e.removed + e.moved, 0);
            return n > 0 ? `${n} ${n === 1 ? "part" : "parts"} changed` : null;
        }
        return ops && ops.length > 0 ? `${ops.length} ${ops.length === 1 ? "change" : "changes"}` : null;
    }
    if (model.kind === "optimized" && model.optimization) {
        const { before, after } = model.optimization;
        return weightChangeLabel(before.weight_kg, after.weight_kg) ?? (after.blocks === before.blocks ? "Same weight" : null);
    }
    return null;
}

/**
 * Line 2 of a version's row: what it is, in the words the person used. A change by words quotes the request and says what became of it,
 * an optimized version quotes its goal and the weight it saved, a stabilized one says how many blocks it added. null for an original.
 */
export function versionStory(model: Pick<ModelAsset, "kind"> & Partial<Pick<ModelAsset, "derived" | "edit" | "optimization">>): string | null {
    if (model.kind === "edited" && model.edit) {
        const last = model.edit.entries[model.edit.entries.length - 1];
        const asked = last ? `“${last.instruction}”` : null;
        return [asked, model.edit.summary || null].filter(Boolean).join(" — ") || null;
    }
    if (model.kind === "optimized" && model.optimization) {
        return [`“${model.optimization.goal}”`, versionDetail(model)].filter(Boolean).join(" · ");
    }
    if (model.kind === "stabilized") return versionDetail(model);
    return null;
}

/** The cover of a bundled example (512 x 384), which is also the new project's card image. */
export function exampleCoverUrl(slug: string): string {
    return `${APP_BASE}/examples/${slug}/cover.png`;
}

/**
 * `a-wooden-rocking-chair-meshy.glb`: a readable name for the saved file. The last part says who made it: the
 * text-to-3D model, or "example" / "stabilized" / "edited" / "optimized" for the kinds that no provider produced.
 */
export function modelFileName(model: Nameable): string {
    const slug = model.prompt
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    const maker =
        model.kind === "stabilized" || model.kind === "example" || model.kind === "edited" || model.kind === "optimized" ? model.kind : model.provider;
    return `${slug || "model"}-${maker}.glb`;
}

/** The model's start time as epoch ms, or undefined when the stamp does not parse. */
export function epochOf(iso: string): number | undefined {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
}
