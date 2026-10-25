import { Blocks, Loader2 } from "lucide-react";

import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { VerdictChip } from "@/assignment/components/analysis/VerdictBadge";
import type { ModelAsset } from "@/assignment/shared/contract";
import { openAnalysisFor } from "@/assignment/store/analysis";

/**
 * A model's verdict in the Models list: the chip ("4 problems", "Stable"), or a quiet "Check" while nothing is known. A click
 * opens that model on the Stability tab.
 */
export function ModelStabilityBadge({ model }: { model: Pick<ModelAsset, "id" | "analysis"> }) {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model.id);
    const label = verdict
        ? `Open the stability check of this model: ${verdict.short}${verdict.custom ? ` (custom settings: ${verdict.custom})` : ""}`
        : "Check this model's stability";
    return (
        <button
            type="button"
            onClick={() => openAnalysisFor(model.id)}
            aria-label={label}
            title={label}
            data-testid="model-verdict"
            data-verdict={verdict?.kind ?? "none"}
            className="rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {verdict ? (
                <VerdictChip verdict={verdict} />
            ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-1.5 text-[10px] leading-4 text-muted-foreground">
                    {analysing ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Blocks className="h-3 w-3" aria-hidden />}
                    {analysing ? "Checking" : "Check"}
                </span>
            )}
        </button>
    );
}
