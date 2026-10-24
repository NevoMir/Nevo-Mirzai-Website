// Small display helpers shared by the chat's job cards and the Models list.

import { APP_BASE, type ModelAsset, type ModelKind } from "@/assignment/shared/contract";

/** What a name needs of a model. `kind` is optional so a row from an older server still gets a name. */
type Nameable = Pick<ModelAsset, "prompt" | "provider"> & { kind?: ModelKind };

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

/** The model's name in lists and cards: "Stabilized · {prompt}" for a corrected version, else the prompt itself. */
export function modelTitle(model: Pick<ModelAsset, "prompt"> & { kind?: ModelKind }): string {
    return model.kind === "stabilized" ? `Stabilized · ${model.prompt}` : model.prompt;
}

/** "+14 blocks" / "+1 block": what the stabilizer added. */
export function addedBlocksLabel(count: number): string {
    return `+${count} ${count === 1 ? "block" : "blocks"}`;
}

/** The cover of a bundled example (512 x 384), which is also the new project's card image. */
export function exampleCoverUrl(slug: string): string {
    return `${APP_BASE}/examples/${slug}/cover.png`;
}

/**
 * `a-wooden-rocking-chair-meshy.glb`: a readable name for the saved file. The last part says who made it: the
 * text-to-3D model, or "example" / "stabilized" for the two kinds that no provider produced.
 */
export function modelFileName(model: Nameable): string {
    const slug = model.prompt
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    const maker = model.kind === "stabilized" ? "stabilized" : model.kind === "example" ? "example" : model.provider;
    return `${slug || "model"}-${maker}.glb`;
}

/** The model's start time as epoch ms, or undefined when the stamp does not parse. */
export function epochOf(iso: string): number | undefined {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
}
