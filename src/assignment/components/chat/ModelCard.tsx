import { ArrowLeftRight, Blocks, Check, ChevronRight, Download, Eye, Loader2 } from "lucide-react";

import { TONE, VERDICT_ICON, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { VerdictLine } from "@/assignment/components/analysis/VerdictBadge";
import { ModelThumb } from "@/assignment/components/chat/JobCard";
import { Button } from "@/assignment/components/ui/button";
import { addedBlocksLabel, formatBytes, modelFileName, modelTitle, partsLabel } from "@/assignment/components/workspace/format";
import { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
import { ModelPairLink } from "@/assignment/components/workspace/ModelPairLink";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { openCompare } from "@/assignment/store/models";
import { openAnalysisFor } from "@/assignment/store/analysis";

const small = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * A stabilized version's one line: "+14 blocks · Stable", or "+14 blocks · 1 problem · open analysis" when the
 * corrected version still has something to fix. Same look and same click as the verdict line of any other model.
 */
function StabilizedLine({ model }: { model: ModelAsset }) {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model.id);
    const tone = verdict ? TONE[VERDICT_TONE[verdict.kind]] : TONE.muted;
    const Icon = verdict ? VERDICT_ICON[verdict.kind] : analysing ? Loader2 : Blocks;
    // A stabilizer that found nothing to add leaves the same blocks: say so instead of "+0 blocks".
    const added = model.derived ? (model.derived.added_blocks === 0 ? "Same blocks as the original" : addedBlocksLabel(model.derived.added_blocks)) : null;
    const state = verdict ? (verdict.kind === "pass" ? verdict.short : `${verdict.short} · open analysis`) : analysing ? "Checking the structure…" : "Check the structure";
    const text = [added, state].filter(Boolean).join(" · ");
    return (
        <button
            type="button"
            onClick={() => openAnalysisFor(model.id)}
            data-testid="verdict-line"
            data-verdict={verdict?.kind ?? "none"}
            aria-label={`Stabilized version: ${text}. Open the analysis.`}
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

/** "Highest joint stress 198% → 21%": what the stabilizer did to the stress, when the log has both numbers. */
function stressChange(model: ModelAsset): string | null {
    const before = model.derived?.before?.max_utilisation;
    const after = model.derived?.after?.max_utilisation;
    if (typeof before !== "number" || typeof after !== "number" || Math.abs(before - after) < 0.005) return null;
    return `Highest joint stress ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`;
}

export interface ModelCardProps {
    model: ModelAsset;
    /** Every model of the project: how a card finds the other half of an original / stabilized pair. */
    models: readonly ModelAsset[];
    /** This model is the one in the viewer. */
    active: boolean;
    onView: (model: ModelAsset) => void;
}

/**
 * A model the assistant presents directly in the chat (an opened example's two models, a stabilized version): what it
 * is, its structural verdict, and the ways in: the 3D view, the analysis, the file. A stabilized version also offers the
 * before/after comparison, a model with a stabilized twin a jump to it.
 */
export function ModelCard({ model, models, active, onView }: ModelCardProps) {
    const stabilized = model.kind === "stabilized";
    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
    const change = stabilized ? stressChange(model) : null;
    return (
        <div
            data-testid="model-card"
            data-kind={model.kind}
            className={cn(
                "rounded-xl border bg-background/60 p-3 transition-colors",
                active ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
            )}
        >
            <div className="flex items-center gap-3">
                <ModelThumb model={model} className="h-14 w-14" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <ModelKindChip model={model} />
                    </div>
                    <p className="line-clamp-2 text-[13px] font-medium leading-snug text-foreground [overflow-wrap:anywhere]" title={modelTitle(model)}>
                        {modelTitle(model)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                        {[parts, change, formatBytes(model.size_bytes)].filter(Boolean).join(" · ")}
                    </p>
                </div>
            </div>
            <div className="mt-2.5">{stabilized ? <StabilizedLine model={model} /> : <VerdictLine model={model} />}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button
                    type="button"
                    size="sm"
                    variant={active ? "secondary" : "default"}
                    className={small}
                    aria-pressed={active}
                    onClick={() => onView(model)}
                >
                    {active ? <Check /> : <Eye />}
                    {active ? "Viewing" : "View in 3D"}
                </Button>
                <Button type="button" size="sm" variant="outline" className={small} onClick={() => openAnalysisFor(model.id)}>
                    <Blocks />
                    Open analysis
                </Button>
                <Button asChild size="sm" variant="outline" className={small}>
                    <a href={model.glb_url} download={modelFileName(model)}>
                        <Download />
                        Download GLB
                    </a>
                </Button>
                {stabilized ? (
                    // Nothing was added: there is nothing to tell the two halves apart by.
                    model.derived?.added_blocks === 0 ? null : (
                        <Button type="button" size="sm" variant="outline" className={small} onClick={() => openCompare(model)}>
                            <ArrowLeftRight />
                            Compare
                        </Button>
                    )
                ) : (
                    <ModelPairLink model={model} models={models} onView={onView} />
                )}
            </div>
        </div>
    );
}
