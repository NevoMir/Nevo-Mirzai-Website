import { Blocks, BookOpen, PencilLine, SlidersHorizontal } from "lucide-react";

import { versionDetail } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";

const base = "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4";

/**
 * Where a model came from, when it was not simply generated: "Example" for a ready-made one, "Stabilized +14 blocks" for a corrected
 * version, "Edited" for a change made by words, "Optimized −23% weight" for an optimized one. An icon and words, so it does not rely on
 * colour. Nothing for a generated model.
 */
export function ModelKindChip({ model, className }: { model: Pick<ModelAsset, "kind"> & Partial<Pick<ModelAsset, "derived" | "edit" | "optimization">>; className?: string }) {
    if (model.kind === "example") {
        return (
            <span
                data-testid="model-kind"
                data-kind="example"
                title="A ready-made example, shared by every project made from it"
                className={cn(base, "border-primary/30 bg-primary/10 text-primary", className)}
            >
                <BookOpen className="h-3 w-3 shrink-0" aria-hidden />
                Example
            </span>
        );
    }
    if (model.kind === "stabilized") {
        const added = model.derived?.added_blocks;
        return (
            <span
                data-testid="model-kind"
                data-kind="stabilized"
                title="The corrected version: supports added, nothing removed or moved"
                className={cn(base, "border-accent/50 bg-accent/10 text-accent-hover dark:text-accent", className)}
            >
                <Blocks className="h-3 w-3 shrink-0" aria-hidden />
                Stabilized
                {typeof added === "number" && added > 0 && <span>{versionDetail(model)}</span>}
            </span>
        );
    }
    if (model.kind === "edited") {
        const detail = versionDetail(model);
        return (
            <span
                data-testid="model-kind"
                data-kind="edited"
                title="A change you asked for in words, made from the model above it"
                className={cn(base, "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300", className)}
            >
                <PencilLine className="h-3 w-3 shrink-0" aria-hidden />
                Edited
                {detail && <span>{detail}</span>}
            </span>
        );
    }
    if (model.kind === "optimized") {
        const detail = versionDetail(model);
        return (
            <span
                data-testid="model-kind"
                data-kind="optimized"
                title="Made lighter or stronger by the optimizer, from the version above it"
                className={cn(base, "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", className)}
            >
                <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden />
                Optimized
                {detail && <span>{detail}</span>}
            </span>
        );
    }
    return null;
}
