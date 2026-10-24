import { Blocks, BookOpen } from "lucide-react";

import { addedBlocksLabel } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";

const base = "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4";

/**
 * Where a model came from, when it was not simply generated: "Example" for a ready-made one, "Stabilized +14 blocks"
 * for a corrected version. An icon and words, so it does not rely on colour. Nothing for a generated model.
 */
export function ModelKindChip({ model, className }: { model: Pick<ModelAsset, "kind" | "derived">; className?: string }) {
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
                {typeof added === "number" && added > 0 && <span>{addedBlocksLabel(added)}</span>}
            </span>
        );
    }
    return null;
}
