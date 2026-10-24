import { Check, Download, Eye, Layers } from "lucide-react";

import { ModelVerdictBadge } from "@/assignment/components/analysis/VerdictBadge";
import { ModelThumb } from "@/assignment/components/chat/JobCard";
import { Button } from "@/assignment/components/ui/button";
import { formatBytes, modelFileName, partsLabel } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import { relativeTime } from "@/assignment/lib/hub/hubClient";
import type { ModelAsset, ProviderInfo } from "@/assignment/shared/contract";
import { providerInfo, providerLabel, viaLabel } from "@/assignment/store/providers";

const chip = "rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground";

/**
 * The Models tab: every model the project has generated, newest first, each with a way to put it
 * in the viewer and a way to take the file.
 */
export function ModelsPanel({
    models,
    activeModelId,
    providers,
    onView,
}: {
    models: readonly ModelAsset[];
    activeModelId: string | null;
    providers: readonly ProviderInfo[] | undefined;
    onView: (model: ModelAsset) => void;
}) {
    const newestFirst = [...models].reverse();

    if (models.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted-foreground">
                <Layers className="h-8 w-8 opacity-50" aria-hidden />
                <p className="text-sm font-medium text-foreground">No models yet</p>
                <p className="max-w-xs text-xs">Describe an object in the chat. Every model it generates is listed here.</p>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto p-4" data-testid="models-panel">
            <div className="mb-3 flex items-baseline gap-2 px-1">
                <h2 className="text-sm font-semibold text-foreground">Models</h2>
                <span className="text-xs text-muted-foreground">
                    {models.length} {models.length === 1 ? "model" : "models"} in this project
                </span>
            </div>
            <ul className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {newestFirst.map((model) => {
                    const info = providerInfo(providers, model.provider);
                    const via = viaLabel(info?.via);
                    const active = model.id === activeModelId;
                    const parts = model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;
                    return (
                        <li
                            key={model.id}
                            data-testid="model-row"
                            className={cn(
                                "flex gap-3 rounded-xl border bg-card p-3",
                                active ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
                            )}
                        >
                            <ModelThumb model={model} className="h-20 w-20" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className="text-xs font-semibold text-foreground">
                                        {providerLabel(providers, model.provider)}
                                    </span>
                                    {via && <span className={chip}>{via}</span>}
                                    <ModelVerdictBadge model={model} />
                                </div>
                                <p className="line-clamp-2 text-sm text-foreground [overflow-wrap:anywhere]" title={model.prompt}>
                                    {model.prompt}
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                    {[relativeTime(model.created_at), parts, formatBytes(model.size_bytes)]
                                        .filter(Boolean)
                                        .join(" · ")}
                                </p>
                                <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
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
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
