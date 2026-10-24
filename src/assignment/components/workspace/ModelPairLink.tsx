import { ArrowLeftRight } from "lucide-react";

import { pairOf } from "@/assignment/components/workspace/modelGroups";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";

/**
 * "Original" on a stabilized version, "Stabilized" on the model it was made from: one click puts the other one in
 * the viewer. Nothing when there is no other one (a plain generated model, or a version whose source is gone).
 */
export function ModelPairLink({
    model,
    models,
    onView,
    className,
}: {
    model: ModelAsset;
    models: readonly ModelAsset[];
    onView: (model: ModelAsset) => void;
    className?: string;
}) {
    const pair = pairOf(model, models);
    if (!pair) return null;
    return (
        <button
            type="button"
            data-testid="model-pair-link"
            onClick={() => onView(pair.model)}
            title={`Show the ${pair.label.toLowerCase()} version in the viewer`}
            aria-label={`Show the ${pair.label.toLowerCase()} version`}
            className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors",
                "hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
        >
            <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden />
            {pair.label}
        </button>
    );
}
