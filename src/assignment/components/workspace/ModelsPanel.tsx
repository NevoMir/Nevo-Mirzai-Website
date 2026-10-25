import { useId, useMemo, useState } from "react";
import { Check, Download, Eye, Layers, Loader2, Pencil, Trash2 } from "lucide-react";

import { ModelThumb } from "@/assignment/components/chat/JobCard";
import { Button } from "@/assignment/components/ui/button";
import { toast } from "@/assignment/components/ui/sonner";
import { DeleteVersionDialog } from "@/assignment/components/workspace/DeleteVersionDialog";
import { TreeConnector } from "@/assignment/components/workspace/KindIcon";
import { formatBytes, modelFileName, modelTitle, partsLabel, versionStory } from "@/assignment/components/workspace/format";
import { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
import { ModelStabilityBadge } from "@/assignment/components/workspace/ModelStabilityBadge";
import { cn } from "@/assignment/lib/utils";
import { relativeTime } from "@/assignment/lib/hub/hubClient";
import type { ModelAsset, ProviderInfo } from "@/assignment/shared/contract";
import { canDelete, editTargetFor, forestOf, ordinalMap } from "@/assignment/shared/versionTree";
import { providerInfo, providerLabel, viaLabel } from "@/assignment/store/providers";

const chip = "rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground";

interface RowProps {
    model: ModelAsset;
    models: readonly ModelAsset[];
    activeModelId: string | null;
    providers: readonly ProviderInfo[] | undefined;
    /** v1 for the original, then v2, v3 ... by creation time. */
    ordinal: number;
    deleting: boolean;
    onView: (model: ModelAsset) => void;
    onEdit?: (model: ModelAsset) => void;
    onDelete?: (model: ModelAsset) => void;
}

function ModelRow({ model, models, activeModelId, providers, ordinal, deleting, onView, onEdit, onDelete }: RowProps) {
    const info = providerInfo(providers, model.provider);
    // The kind chip already says "Example" / "Stabilized" / "Edited" / "Optimized": a provider name next to it would only repeat that.
    const makerShown = model.kind === "generated";
    const via = makerShown ? viaLabel(info?.via) : null;
    const active = model.id === activeModelId;
    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
    const title = modelTitle(model);
    const story = versionStory(model);
    const editChoice = editTargetFor(models, model, "models");
    const reasonId = useId();
    return (
        <div
            data-testid="model-row"
            data-kind={model.kind}
            data-active={active}
            className={cn(
                "flex min-w-0 flex-1 gap-3 rounded-xl border bg-card p-3",
                active ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
            )}
        >
            <ModelThumb model={model} className="h-20 w-20" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {makerShown && <span className="text-xs font-semibold text-foreground">{providerLabel(providers, model.provider)}</span>}
                    {via && <span className={chip}>{via}</span>}
                    <ModelKindChip model={model} />
                    <ModelStabilityBadge model={model} />
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground" data-testid="model-ordinal" title="Versions count from the original">
                        v{ordinal}
                    </span>
                </div>
                <p className="line-clamp-2 text-sm text-foreground [overflow-wrap:anywhere]" title={title}>
                    {title}
                </p>
                {story && (
                    <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" title={story} data-testid="model-story">
                        {story}
                    </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                    {[relativeTime(model.created_at), parts, formatBytes(model.size_bytes)].filter(Boolean).join(" · ")}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <Button
                        type="button"
                        size="sm"
                        variant={active ? "secondary" : "default"}
                        className="h-7 gap-1.5 px-2.5 text-xs"
                        aria-pressed={active}
                        onClick={() => onView(model)}
                    >
                        {active ? <Check /> : <Eye />}
                        {active ? "Viewing" : "View"}
                    </Button>
                    <Button asChild size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs">
                        <a href={model.glb_url} download={modelFileName(model)}>
                            <Download />
                            Download
                        </a>
                    </Button>
                    {onEdit && (
                        <>
                            {/* Off with aria-disabled, not disabled: a disabled button takes no focus and no tap, so on a phone (no hover) nobody would
                                learn why. Reached, it says why: to a screen reader as its description, on a tap as a message. */}
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1.5 px-2.5 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                                data-testid="model-edit"
                                aria-disabled={editChoice.target === null ? true : undefined}
                                aria-describedby={editChoice.target === null ? reasonId : undefined}
                                title={editChoice.reason ?? "Show it and describe a change in words"}
                                onClick={() => (editChoice.target === null ? toast.info("This model cannot be changed by words", { description: editChoice.reason ?? undefined }) : onEdit(model))}
                            >
                                <Pencil />
                                Edit…
                            </Button>
                            {editChoice.target === null && editChoice.reason && (
                                <span id={reasonId} className="sr-only">
                                    {editChoice.reason}
                                </span>
                            )}
                        </>
                    )}
                    {onDelete && canDelete(model) && (
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
                            aria-label="Delete this version"
                            title="Delete this version"
                            data-testid="model-delete"
                            disabled={deleting}
                            onClick={() => onDelete(model)}
                        >
                            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * The Models tab: every model the project holds as a tree. A version is listed under the model it was made from (stabilized, edited by
 * words, optimized), so the story of a model reads top to bottom; each row has a way to put it in the viewer, to describe a change to
 * it, and to take the file. Newest tree first.
 */
export function ModelsPanel({
    models,
    activeModelId,
    providers,
    onView,
    onEdit,
    onDelete,
}: {
    models: readonly ModelAsset[];
    activeModelId: string | null;
    providers: readonly ProviderInfo[] | undefined;
    onView: (model: ModelAsset) => void;
    /** Show the model and put the cursor in the composer, ready to describe a change. */
    onEdit?: (model: ModelAsset) => void;
    /** Delete a version (the server removes the versions made from it too). Resolves when it is done. */
    onDelete?: (model: ModelAsset) => Promise<unknown>;
}) {
    const forest = useMemo(() => forestOf(models), [models]);
    const ordinals = useMemo(() => ordinalMap(models), [models]);
    const [confirming, setConfirming] = useState<ModelAsset | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    if (models.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <Layers className="h-8 w-8 opacity-50" aria-hidden />
                <p className="text-sm font-medium text-foreground">No models yet</p>
                <p className="max-w-xs text-xs">Describe an object in the chat. Every model it generates is listed here.</p>
            </div>
        );
    }

    const confirmDelete = async (model: ModelAsset) => {
        setConfirming(null);
        if (!onDelete) return;
        setDeletingId(model.id);
        try {
            await onDelete(model);
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div className="h-full overflow-y-auto p-4" data-testid="models-panel">
            <div className="mb-3 flex items-baseline gap-2 px-1">
                <h2 className="text-sm font-semibold text-foreground">Models</h2>
                <span className="text-xs text-muted-foreground">
                    {models.length} {models.length === 1 ? "model" : "models"} in this project
                </span>
            </div>
            <ul className="grid items-start gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {forest.map(({ root, rows }) => (
                    <li key={root.id} data-testid="model-group" className="flex min-w-0 flex-col gap-2">
                        {rows.map((row) => (
                            <div key={row.model.id} className="flex items-stretch gap-1.5" data-depth={row.depth}>
                                <TreeConnector depth={row.depth} lines={row.lines} last={row.last} cell={20} />
                                <ModelRow
                                    model={row.model}
                                    models={models}
                                    activeModelId={activeModelId}
                                    providers={providers}
                                    ordinal={ordinals.get(row.model.id) ?? 1}
                                    deleting={deletingId === row.model.id}
                                    onView={onView}
                                    onEdit={onEdit}
                                    onDelete={onDelete ? setConfirming : undefined}
                                />
                            </div>
                        ))}
                    </li>
                ))}
            </ul>

            <DeleteVersionDialog model={confirming} models={models} onConfirm={(model) => void confirmDelete(model)} onCancel={() => setConfirming(null)} />
        </div>
    );
}
