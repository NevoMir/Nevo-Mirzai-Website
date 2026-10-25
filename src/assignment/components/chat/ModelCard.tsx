import { Blocks, Check, Download, Eye } from "lucide-react";

import { ModelThumb } from "@/assignment/components/chat/JobCard";
import { StabilityLine } from "@/assignment/components/chat/StabilityLine";
import { Button } from "@/assignment/components/ui/button";
import { addedBlocksLabel, formatBytes, modelFileName, modelTitle, partsLabel } from "@/assignment/components/workspace/format";
import { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
import { ModelPairLink } from "@/assignment/components/workspace/ModelPairLink";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { openAnalysisFor } from "@/assignment/store/analysis";

const small = "h-7 gap-1.5 px-2.5 text-xs";

/** "Strength used 198% → 21%": what the stabilizer did to the load on the worst joint, when the log has both numbers. */
function stressChange(model: ModelAsset): string | null {
    const before = model.derived?.before?.max_utilisation;
    const after = model.derived?.after?.max_utilisation;
    if (typeof before !== "number" || typeof after !== "number" || Math.abs(before - after) < 0.005) return null;
    return `Strength used ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`;
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
 * is, its structural verdict, and the ways in: the 3D view, the stability check, the file. The other half of a pair is one link
 * away ("Original" on a stabilized version, "Stabilized" on the model it was made from): the same switch as the bar's. There is
 * no Compare button: with the version in the viewer, "Colour: Added blocks" on the stage shows what was added.
 */
export function ModelCard({ model, models, active, onView }: ModelCardProps) {
    const stabilized = model.kind === "stabilized";
    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
    const change = stabilized ? stressChange(model) : null;
    const lead = stabilized && model.derived ? (model.derived.added_blocks === 0 ? "Same blocks as the original" : addedBlocksLabel(model.derived.added_blocks)) : null;
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
            <div className="mt-2.5">
                {/* A stabilized version leads with what was added ("+14 blocks · Stable"); a stabilizer that found nothing to add leaves
                    the same blocks: say so instead of "+0 blocks". */}
                <StabilityLine model={model} lead={lead} />
            </div>
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
                    Stability check
                </Button>
                <Button asChild size="sm" variant="outline" className={small}>
                    <a href={model.glb_url} download={modelFileName(model)}>
                        <Download />
                        Download GLB
                    </a>
                </Button>
                {/* The way to the other half of the pair, on both: "Stabilized" from the original, "Original" from the version. */}
                <ModelPairLink model={model} models={models} onView={onView} />
            </div>
        </div>
    );
}
