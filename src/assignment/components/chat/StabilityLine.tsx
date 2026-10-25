import { Blocks, ChevronRight, Loader2 } from "lucide-react";

import { TONE, VERDICT_ICON, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { openAnalysisFor } from "@/assignment/store/analysis";
import { plural, type Verdict } from "@/assignment/store/analysisLogic";

/** What the line says about a model's stability, as words: "Stable · 237 blocks", "2 problems · open stability check", "Check stability". */
function stabilityLineText(verdict: Verdict | null, analysing: boolean, lead: string | null = null): string {
    // A version leads with what it did (the blocks the stabilizer added, the weight saved); its block count is not repeated.
    const state = verdict
        ? verdict.kind === "pass"
            ? lead
                ? verdict.short
                : `${verdict.short} · ${plural(verdict.blocks, "block")}${verdict.custom ? ` · ${verdict.custom}` : ""}`
            : `${verdict.short}${!lead && verdict.custom ? ` · ${verdict.custom}` : ""} · open stability check`
        : analysing
          ? "Checking stability…"
          : "Check stability";
    return [lead, state].filter(Boolean).join(" · ");
}

/**
 * The line under a finished model in the chat: "Stable · 237 blocks" or "2 problems · open stability check"; for a stabilized
 * version "+14 blocks · Stable" (`lead` is the first part). A click opens the Stability tab for this model. A symbol and words, so it
 * does not rely on colour alone.
 */
export function StabilityLine({ model, lead = null }: { model: Pick<ModelAsset, "id" | "analysis">; lead?: string | null }) {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model.id);
    const tone = verdict ? TONE[VERDICT_TONE[verdict.kind]] : TONE.muted;
    const Icon = verdict ? VERDICT_ICON[verdict.kind] : analysing ? Loader2 : Blocks;
    const text = stabilityLineText(verdict, analysing, lead);
    return (
        <button
            type="button"
            onClick={() => openAnalysisFor(model.id)}
            data-testid="verdict-line"
            data-verdict={verdict?.kind ?? "none"}
            aria-label={
                verdict ? `${lead ? "This version" : "Stability"}: ${text}. Open the stability check.` : "Check the stability of this model in the Stability tab"
            }
            className={cn(
                "group flex w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs transition-colors",
                "hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                verdict ? [tone.soft, tone.border] : "border-dashed border-border",
            )}
        >
            <Icon className={cn("h-3.5 w-3.5 shrink-0", tone.icon, analysing && !verdict && "animate-spin")} aria-hidden />
            <span className={cn("min-w-0 flex-1 truncate font-medium", verdict ? tone.text : "text-muted-foreground")}>{text}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </button>
    );
}
