import { Blocks, Loader2, MonitorX, RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import { Progress } from "@/assignment/components/ui/progress";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import type { RunState } from "@/assignment/store/analysisLogic";
import { useIsGenerating } from "@/assignment/store/useWorkspaceStore";

/** No model in the viewer yet: what the check will do once there is one, or that one is on its way. */
export function NoModelState() {
    const generating = useIsGenerating();
    return (
        <div className="px-4 py-6" data-testid="analysis-empty" data-generating={generating}>
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                {generating ? <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" strokeWidth={1.5} aria-hidden /> : <Blocks className="h-6 w-6" strokeWidth={1.5} aria-hidden />}
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-foreground">{generating ? "Your model is being generated" : "No model to check yet"}</p>
            <p className="mx-auto mt-1 max-w-[17rem] text-center text-xs leading-relaxed text-muted-foreground" role={generating ? "status" : undefined}>
                {generating
                    ? "The check starts by itself."
                    : "It scales the model to 1 m, builds it from 100 mm blocks, then checks balance, overhangs, floating parts and strength."}
            </p>
        </div>
    );
}

/** The shape of the report's top while it is on its way: two lines of answer, four figures, one button. */
function SkeletonReport() {
    return (
        <div className="px-4 pb-4 pt-3.5" aria-hidden data-testid="analysis-skeleton">
            <div className="flex items-start gap-3">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2 pt-0.5">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 rounded-xl" />
                ))}
            </div>
            <Skeleton className="mt-4 h-10 rounded-md" />
        </div>
    );
}

/** The model is being fetched or the run is about to start. */
export function LoadingState() {
    return (
        <div data-testid="analysis-loading" role="status" aria-live="polite">
            <p className="flex items-center gap-2 px-4 pt-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                Loading the model…
            </p>
            <SkeletonReport />
        </div>
    );
}

/**
 * The 3D view cannot show this model (it failed to load, or the browser has no WebGL). The check reads the model from the
 * view, so it waits for it; the view's own card has the Try again.
 */
export function UnavailableState({ message }: { message: string }) {
    return (
        <div className="px-4 py-6" data-testid="analysis-unavailable" role="status">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <MonitorX className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-foreground">The 3D view cannot show this model</p>
            <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
            <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">The check starts once the view shows it. Use Try again in the view, or open another model.</p>
        </div>
    );
}

/** The first run for this model: the skeleton of the report with a progress bar and the stage the engine is at. */
export function RunningState({ run }: { run: RunState }) {
    const pct = Math.round(run.progress * 100);
    return (
        <div data-testid="analysis-running" role="status" aria-live="polite">
            <div className="px-4 pt-4">
                <p className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
                    Checking the model…
                    <span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{pct}%</span>
                </p>
                <Progress value={pct} className="mt-2 h-1.5" aria-label="Progress of the check" />
                <p className="mt-1.5 text-[11px] text-muted-foreground">{run.stage || "Starting"}</p>
            </div>
            <SkeletonReport />
        </div>
    );
}

/** The run failed: say why and offer to run it again. */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="px-4 py-5" data-testid="analysis-error" role="alert">
            <div className="flex items-start gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 p-3">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-red-700 dark:text-red-400">The check could not run</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
                </div>
            </div>
            <Button type="button" className="mt-3 h-11 w-full gap-1.5 text-sm md:h-10" onClick={onRetry} data-testid="analysis-retry">
                <RotateCcw />
                Try again
            </Button>
        </div>
    );
}
