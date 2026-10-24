import { Blocks, ChevronRight, Loader2 } from "lucide-react";

import { TONE, VERDICT_ICON, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { cn } from "@/assignment/lib/utils";
import { openAnalysisFor } from "@/assignment/store/analysis";
import { plural, type Verdict } from "@/assignment/store/analysisLogic";
import type { ModelAsset } from "@/assignment/shared/contract";

/** The verdict as a small chip: an icon and the words, so it does not rely on colour alone. */
export function VerdictChip({ verdict, className }: { verdict: Verdict; className?: string }) {
    const tone = TONE[VERDICT_TONE[verdict.kind]];
    const Icon = VERDICT_ICON[verdict.kind];
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4",
                tone.soft,
                tone.border,
                tone.text,
                className,
            )}
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {verdict.short}
            {verdict.custom && <span className="h-1 w-1 shrink-0 rounded-full bg-current opacity-70" aria-hidden />}
        </span>
    );
}

/**
 * A model's verdict in the Models list: the chip, or a quiet "Analyse" while nothing is known. Opens the
 * analysis of that model.
 */
export function ModelVerdictBadge({ model }: { model: Pick<ModelAsset, "id" | "analysis" | "prompt"> }) {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model.id);
    const label = verdict
        ? `Open the analysis of this model: ${verdict.short}${verdict.custom ? ` (custom settings: ${verdict.custom})` : ""}`
        : "Analyse this model's structure";
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
                    {analysing ? "Analysing" : "Analyse"}
                </span>
            )}
        </button>
    );
}

/**
 * The line under a finished model in the chat: "Stable · 237 blocks" or "2 problems · open analysis". A click
 * opens the Analysis tab for this model.
 */
export function VerdictLine({ model }: { model: Pick<ModelAsset, "id" | "analysis"> }) {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model.id);
    const tone = verdict ? TONE[VERDICT_TONE[verdict.kind]] : TONE.muted;
    const Icon = verdict ? VERDICT_ICON[verdict.kind] : analysing ? Loader2 : Blocks;
    // "limit 9" when it is not the assignment's 4: a verdict is only as good as the rule it was measured with.
    const rule = verdict?.custom ? ` · ${verdict.custom}` : "";
    const text = verdict
        ? verdict.kind === "pass"
            ? `${verdict.short} · ${plural(verdict.blocks, "block")}${rule}`
            : `${verdict.short}${rule} · open analysis`
        : analysing
          ? "Checking the structure…"
          : "Check the structure";
    return (
        <button
            type="button"
            onClick={() => openAnalysisFor(model.id)}
            data-testid="verdict-line"
            data-verdict={verdict?.kind ?? "none"}
            aria-label={verdict ? `Structure: ${text}. Open the analysis.` : "Check the structure of this model in the analysis tab"}
            className={cn(
                "group flex w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-left text-xs transition-colors",
                "hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                verdict ? [tone.soft, tone.border] : "border-dashed border-border",
            )}
        >
            <Icon className={cn("h-3.5 w-3.5 shrink-0", tone.icon, analysing && !verdict && "animate-spin")} aria-hidden />
            <span className={cn("min-w-0 flex-1 truncate font-medium", verdict ? tone.text : "text-muted-foreground")}>{text}</span>
            <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
            />
        </button>
    );
}
