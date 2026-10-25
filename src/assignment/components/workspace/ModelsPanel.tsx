import { useMemo, useState } from "react";
import { Blocks, Check, CornerDownRight, Download, Eye, Layers, Loader2, Trash2 } from "lucide-react";

import { ModelThumb } from "@/assignment/components/chat/JobCard";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/assignment/components/ui/alert-dialog";
import { Button } from "@/assignment/components/ui/button";
import { formatBytes, modelFileName, modelTitle, partsLabel } from "@/assignment/components/workspace/format";
import { ModelKindChip } from "@/assignment/components/workspace/ModelKindChip";
import { ModelStabilityBadge } from "@/assignment/components/workspace/ModelStabilityBadge";
import { ModelPairLink } from "@/assignment/components/workspace/ModelPairLink";
import { descendantsOf, groupModels } from "@/assignment/components/workspace/modelGroups";
import { cn } from "@/assignment/lib/utils";
import { relativeTime } from "@/assignment/lib/hub/hubClient";
import type { ModelAsset, ProviderInfo } from "@/assignment/shared/contract";
import { providerInfo, providerLabel, viaLabel } from "@/assignment/store/providers";

const chip = "rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground";

interface RowProps {
    model: ModelAsset;
    models: readonly ModelAsset[];
    activeModelId: string | null;
    providers: readonly ProviderInfo[] | undefined;
    /** 0 for a source; a stabilized version is indented and marked with an arrow. */
    depth: number;
    deleting: boolean;
    onView: (model: ModelAsset) => void;
    onDelete?: (model: ModelAsset) => void;
}

function ModelRow({ model, models, activeModelId, providers, depth, deleting, onView, onDelete }: RowProps) {
    const info = providerInfo(providers, model.provider);
    // The kind chip already says "Example" / "Stabilized": a provider name next to it would only repeat that.
    const makerShown = model.kind === "generated";
    const via = makerShown ? viaLabel(info?.via) : null;
    const active = model.id === activeModelId;
    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
    const title = modelTitle(model);
    return (
        <div
            data-testid="model-row"
            data-kind={model.kind}
            data-depth={depth}
            className={cn(
                "flex min-w-0 flex-1 gap-3 rounded-xl border bg-card p-3",
                active ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
            )}
        >
            <ModelThumb model={model} className="h-20 w-20" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {makerShown && (
                        <span className="text-xs font-semibold text-foreground">{providerLabel(providers, model.provider)}</span>
                    )}
                    {via && <span className={chip}>{via}</span>}
                    <ModelKindChip model={model} />
                    <ModelStabilityBadge model={model} />
                </div>
                <p className="line-clamp-2 text-sm text-foreground [overflow-wrap:anywhere]" title={title}>
                    {title}
                </p>
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
                    <ModelPairLink model={model} models={models} onView={onView} />
                    {onDelete && model.kind === "stabilized" && (
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
                            aria-label="Delete this stabilized version"
                            title="Delete this stabilized version"
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
 * The Models tab: every model the project holds, newest first. A stabilized version is listed under the model it was
 * made from, so the pair reads as one story; each row has a way to put it in the viewer and a way to take the file.
 */
export function ModelsPanel({
    models,
    activeModelId,
    providers,
    onView,
    onDelete,
}: {
    models: readonly ModelAsset[];
    activeModelId: string | null;
    providers: readonly ProviderInfo[] | undefined;
    onView: (model: ModelAsset) => void;
    /** Delete a stabilized version (the server removes the versions made from it too). Resolves when it is done. */
    onDelete?: (model: ModelAsset) => Promise<unknown>;
}) {
    const groups = useMemo(() => groupModels(models), [models]);
    const [confirming, setConfirming] = useState<ModelAsset | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const alsoRemoved = confirming ? descendantsOf(models, confirming.id).length : 0;

    if (models.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <Layers className="h-8 w-8 opacity-50" aria-hidden />
                <p className="text-sm font-medium text-foreground">No models yet</p>
                <p className="max-w-xs text-xs">Describe an object in the chat. Every model it generates is listed here.</p>
            </div>
        );
    }

    const confirmDelete = async () => {
        const model = confirming;
        setConfirming(null);
        if (!model || !onDelete) return;
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
                {groups.map(({ source, versions }) => (
                    <li key={source.id} data-testid="model-group" className="flex min-w-0 flex-col gap-2">
                        <div className="flex">
                            <ModelRow
                                model={source}
                                models={models}
                                activeModelId={activeModelId}
                                providers={providers}
                                depth={0}
                                deleting={deletingId === source.id}
                                onView={onView}
                                onDelete={onDelete ? setConfirming : undefined}
                            />
                        </div>
                        {versions.map(({ model, depth }) => (
                            // 20 px per level, capped: the arrow says "made from the one above" and a chain is three deep at most.
                            <div key={model.id} className="flex items-start gap-1.5" style={{ paddingLeft: Math.min(depth, 3) * 20 - 20 }}>
                                <CornerDownRight className="mt-6 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                                <ModelRow
                                    model={model}
                                    models={models}
                                    activeModelId={activeModelId}
                                    providers={providers}
                                    depth={depth}
                                    deleting={deletingId === model.id}
                                    onView={onView}
                                    onDelete={onDelete ? setConfirming : undefined}
                                />
                            </div>
                        ))}
                    </li>
                ))}
            </ul>

            <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <Blocks className="h-4 w-4 text-accent" aria-hidden />
                            Delete this stabilized version?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {alsoRemoved > 0
                                ? `It is removed from the project, together with the ${alsoRemoved} ${alsoRemoved === 1 ? "version" : "versions"} made from it. `
                                : "It is removed from the project. "}
                            The model it was made from is kept, and you can stabilize it again. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => void confirmDelete()}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
