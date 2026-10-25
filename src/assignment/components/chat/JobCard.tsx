import { useState } from "react";
import { Blocks, Box, Check, Download, Eye, RotateCcw } from "lucide-react";

import { Markdown } from "@/assignment/components/chat/Markdown";
import { ElapsedTime } from "@/assignment/components/chat/ElapsedTime";
import { StabilityLine } from "@/assignment/components/chat/StabilityLine";
import { GenerationProgressBar } from "@/assignment/components/workspace/GenerationProgressBar";
import { useShownProgress } from "@/assignment/components/workspace/useShownProgress";
import { Button } from "@/assignment/components/ui/button";
import { epochOf, exampleCoverUrl, formatBytes, modelFileName, partsLabel } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { Job, ModelAsset, ProviderInfo } from "@/assignment/shared/contract";
import { designerNote, providerInfo, providerLabel, stageText, viaLabel } from "@/assignment/store/providers";

const chip = "rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground";
const small = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * The model's picture: the provider's still, or for a bundled example its cover. A stabilized version has no image
 * of its own (it is made in the browser), so it gets a Blocks glyph on a tile tinted like its chip; the Box icon
 * stands in for everything else (and for an image that fails to load).
 */
export function ModelThumb({ model, className }: { model: ModelAsset; className?: string }) {
    const [failed, setFailed] = useState(false);
    const src = model.thumbnail_url ?? (model.kind === "example" && model.example_slug ? exampleCoverUrl(model.example_slug) : null);
    const derived = model.kind === "stabilized";
    return (
        <div
            className={cn(
                "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted text-muted-foreground",
                derived && !src ? "border-accent/40 bg-accent/10 text-accent-hover dark:text-accent" : "border-border/70",
                className,
            )}
        >
            {src && !failed ? (
                <img
                    src={src}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onError={() => setFailed(true)}
                    className="h-full w-full object-cover"
                />
            ) : derived ? (
                <Blocks className="h-1/2 w-1/2" strokeWidth={1.5} aria-hidden />
            ) : (
                <Box className="h-1/2 w-1/2" strokeWidth={1.5} aria-hidden />
            )}
        </div>
    );
}

/** The three pulsing dots of Cably's "thinking" state. */
function ThinkingDots() {
    return (
        <span className="ml-1.5 inline-flex items-center gap-1 align-middle" aria-hidden>
            <span className="thinking-dot h-1 w-1 rounded-full bg-muted-foreground" />
            <span className="thinking-dot h-1 w-1 rounded-full bg-muted-foreground" />
            <span className="thinking-dot h-1 w-1 rounded-full bg-muted-foreground" />
        </span>
    );
}

export interface JobCardProps {
    job: Job;
    providers: readonly ProviderInfo[] | undefined;
    /** This job's model is the one in the viewer. */
    active: boolean;
    /** Retry is offered unless the same model has already been run again on this prompt. */
    canRetry: boolean;
    /**
     * Quote the prompt under the name. For a job no chat message points at (a project made through the API, a run begun in another
     * tab): there is no bubble above the card to say what was asked, and a failed one would show only its error and Retry.
     */
    showPrompt?: boolean;
    onView: (model: ModelAsset) => void;
    onRetry: (job: Job) => void;
}

/** One model's result for a prompt: progress while it runs, then the model or the reason it failed. */
export function JobCard({ job, providers, active, canRetry, showPrompt = false, onView, onRetry }: JobCardProps) {
    const info = providerInfo(providers, job.provider);
    const label = providerLabel(providers, job.provider);
    const via = viaLabel(info?.via);
    const designer = designerNote({ id: job.provider });
    const running = job.status === "queued" || job.status === "running" || job.status === "finalizing";
    const startedAt = epochOf(job.created_at);
    const shown = useShownProgress({
        active: running,
        value: job.progress,
        startedAt,
        estimateSeconds: info?.approx_seconds,
    });
    const model = job.status === "succeeded" ? job.model : null;
    // "1 part" says nothing a single mesh does not: only an assembly gets the count.
    const parts = model && model.part_count !== null && model.part_count > 1 ? partsLabel(model) : null;

    return (
        <div
            data-testid="job-card"
            data-status={job.status}
            className={cn(
                "rounded-xl border bg-background/60 p-3 transition-colors",
                active ? "border-primary/60 ring-1 ring-primary/30" : "border-border/70",
                job.status === "canceled" && "opacity-70",
            )}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs font-semibold text-foreground">{label}</span>
                {via && <span className={chip}>{via}</span>}
                {info?.parts && <span className={cn(chip, "border-accent/50 text-accent-hover dark:text-accent")}>Parts</span>}
            </div>

            {showPrompt && Boolean(job.prompt?.trim()) && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" title={job.prompt} data-testid="job-prompt">
                    “{job.prompt}”
                </p>
            )}

            {running && (
                <div className="mt-2">
                    {/* An AI designer takes a while and shows no mesh until the end: say what it is doing. */}
                    {designer && (
                        <p className="mb-1 text-[11px] leading-snug text-muted-foreground" data-testid="job-designer-note">
                            {designer}
                        </p>
                    )}
                    {/* The dots below are the ellipsis: a stage that ends in one ("Designing the parts…") must not show both. */}
                    <span className="text-[13px] font-medium text-shimmer" data-testid="job-stage">{stageText(job.stage)}</span>
                    {startedAt !== undefined && (
                        <ElapsedTime
                            startedAt={startedAt}
                            className="ml-2 font-mono text-[11px] tabular-nums text-muted-foreground"
                        />
                    )}
                    <ThinkingDots />
                    <GenerationProgressBar active value={shown} className="mt-2 w-full" />
                </div>
            )}

            {model && (
                <div className="mt-2">
                    <div className="flex items-center gap-3">
                        <ModelThumb model={model} className="h-14 w-14" />
                        <p className="min-w-0 text-xs text-muted-foreground">
                            {[parts, formatBytes(model.size_bytes)].filter(Boolean).join(" · ")}
                        </p>
                    </div>
                    {/* The structural verdict: one line, and a way into the Stability tab for this model. */}
                    <div className="mt-2.5">
                        <StabilityLine model={model} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
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
                        <Button asChild size="sm" variant="outline" className={small}>
                            <a href={model.glb_url} download={modelFileName(model)}>
                                <Download />
                                Download GLB
                            </a>
                        </Button>
                    </div>
                </div>
            )}

            {job.status === "succeeded" && !model && (
                <p className="mt-2 text-xs text-muted-foreground">Finished, but the model file is not available.</p>
            )}

            {job.status === "failed" && (
                <div className="mt-2 flex flex-col items-start gap-2">
                    <Markdown className="text-xs text-destructive">{job.error || "The model could not be generated."}</Markdown>
                    {canRetry && (
                        <Button type="button" size="sm" variant="outline" className={small} onClick={() => onRetry(job)}>
                            <RotateCcw />
                            Retry
                        </Button>
                    )}
                </div>
            )}

            {job.status === "canceled" && (
                <div className="mt-2 flex flex-col items-start gap-2">
                    <p className="text-xs text-muted-foreground">Canceled.</p>
                    {canRetry && (
                        <Button type="button" size="sm" variant="outline" className={small} onClick={() => onRetry(job)}>
                            <RotateCcw />
                            Run again
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}
