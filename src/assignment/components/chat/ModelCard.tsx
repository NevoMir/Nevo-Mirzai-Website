import { Blocks, Check, Download, Eye, Undo2 } from "lucide-react";

import { ModelThumb } from "@/assignment/components/chat/JobCard";
import { StabilityLine } from "@/assignment/components/chat/StabilityLine";
import { Button } from "@/assignment/components/ui/button";
import { formatBytes, modelFileName, modelTitle, partsLabel, versionDetail } from "@/assignment/components/workspace/format";
import { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
import { ModelPairLink } from "@/assignment/components/workspace/ModelPairLink";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { canUndoVersion, isVersion } from "@/assignment/shared/versionTree";
import { openAnalysisFor } from "@/assignment/store/analysis";
import { undoVersion } from "@/assignment/store/models";

const small = "h-7 gap-1.5 px-2.5 text-xs";

/** "Strength used 198% → 21%": what the stabilizer or the optimizer did to the load on the worst joint, when the log has both numbers. */
function stressChange(model: ModelAsset): string | null {
    const before = (model.derived ?? model.optimization)?.before?.max_utilisation;
    const after = (model.derived ?? model.optimization)?.after?.max_utilisation;
    if (typeof before !== "number" || typeof after !== "number" || Math.abs(before - after) < 0.005) return null;
    return `Strength used ${Math.round(before * 100)}% → ${Math.round(after * 100)}%`;
}

export interface ModelCardProps {
    model: ModelAsset;
    /** Every model of the project: how a card finds the other half of an original / version pair. */
    models: readonly ModelAsset[];
    /** This model is the one in the viewer. */
    active: boolean;
    onView: (model: ModelAsset) => void;
}

/**
 * A model the assistant presents directly in the chat (an opened example's two models, a stabilized, edited or optimized version): what it
 * is, its structural verdict, and the ways in: the 3D view, the stability check, the file. The other half of a pair is one link
 * away ("Original" on a version, "Latest" on the model it was made from): the same switch as the bar's. A version nothing was made from
 * can be undone (deleted, back to the model it was made from). There is no Compare button: with the version in the viewer, "Colour: Added
 * blocks" on the stage shows what was added.
 */
export function ModelCard({ model, models, active, onView }: ModelCardProps) {
    const version = isVersion(model);
    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
    const change = version ? stressChange(model) : null;
    // A version leads with what it did ("+14 blocks · Stable"); a stabilizer that found nothing to add leaves the same blocks: say so instead of "+0 blocks".
    const lead = version ? (model.kind === "stabilized" && model.derived?.added_blocks === 0 ? "Same blocks as the original" : versionDetail(model)) : null;
    const undoable = canUndoVersion(models, model);
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
                {/* The way to the other half of the pair, on both: "Latest" from the original, "Original" from a version. */}
                <ModelPairLink model={model} models={models} onView={onView} />
                {undoable && (
                    <Button type="button" size="sm" variant="ghost" className={small} data-testid="model-undo" title="Delete this version and go back to the one it was made from" onClick={() => void undoVersion(model)}>
                        <Undo2 />
                        Undo
                    </Button>
                )}
            </div>
        </div>
    );
}
