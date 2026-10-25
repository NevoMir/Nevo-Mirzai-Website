import { ArrowLeftRight } from "lucide-react";

import { pairLinks } from "@/assignment/components/workspace/versionLogic";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { versionFamily } from "@/assignment/store/versions";

/**
 * The way to the other versions of a model, from its card in the chat: "Latest" on the model it was made from (the version the bar's
 * right half stands for), "Original" on a version (and "Previous" on a version made from another version). They resolve like the
 * bar's two halves (versionLogic pairLinks), so the same word never opens a different model. Nothing when there is no other one
 * (a plain generated model, or a version whose original is gone).
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
    const links = pairLinks(versionFamily(models, model.id), models);
    if (links.length === 0) return null;
    return (
        <>
            {links.map((link) => (
                <button
                    key={link.label}
                    type="button"
                    data-testid="model-pair-link"
                    data-label={link.label}
                    onClick={() => onView(link.model)}
                    title={`Show the ${link.label.toLowerCase()} version in the viewer`}
                    aria-label={`Show the ${link.label.toLowerCase()} version`}
                    className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors",
                        "hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        className,
                    )}
                >
                    <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden />
                    {link.label}
                </button>
            ))}
        </>
    );
}
