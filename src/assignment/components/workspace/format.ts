// Small display helpers shared by the chat's job cards and the Models list.

import type { ModelAsset } from "@/assignment/shared/contract";

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

/** `a-wooden-rocking-chair-meshy.glb`: a readable name for the saved file. */
export function modelFileName(model: Pick<ModelAsset, "prompt" | "provider">): string {
    const slug = model.prompt
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    return `${slug || "model"}-${model.provider}.glb`;
}

/** The model's start time as epoch ms, or undefined when the stamp does not parse. */
export function epochOf(iso: string): number | undefined {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : undefined;
}
