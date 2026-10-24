import { Blocks, Box, Boxes, Loader2, MonitorX, RotateCcw, Scale, TriangleAlert, Unplug } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import { Progress } from "@/assignment/components/ui/progress";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import type { RunState } from "@/assignment/store/analysisLogic";

const STEPS = [
    { icon: Box, title: "Scales it to 1000 mm", text: "The longest side of the model fits a 1000 mm cube." },
    { icon: Boxes, title: "Builds it from 100 mm blocks", text: "Every block is one component you would need to make." },
    { icon: Scale, title: "Checks it stands", text: "Centre of gravity over the base, and no part too far out on a limb." },
    { icon: Unplug, title: "Shows where and why it fails", text: "Problems are listed and lit up on the model." },
];

/** No model in the viewer yet: what the analysis will do once there is one. */
export function NoModelState() {
    return (
        <div className="px-4 py-6" data-testid="analysis-empty">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Blocks className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-foreground">No model to analyse yet</p>
            <p className="mt-1 text-center text-xs text-muted-foreground">
                Describe an object in the chat. When its model is ready, this panel checks it automatically.
            </p>
            <ol className="mt-5 space-y-3">
                {STEPS.map(({ icon: Icon, title, text }, i) => (
                    <li key={title} className="flex items-start gap-2.5">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[11px] text-secondary-foreground">
                            {i + 1}
                        </span>
                        <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                                {title}
                            </span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{text}</span>
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function SkeletonReport() {
    return (
        <div className="space-y-4 px-4 pb-4 pt-3.5" aria-hidden>
            <Skeleton className="h-[88px] rounded-xl" />
            <div className="space-y-2">
                <Skeleton className="h-3 w-24" />
                {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center gap-2">
                        <Skeleton className="h-4 w-4 rounded-full" />
                        <Skeleton className="h-8 flex-1" />
                    </div>
                ))}
            </div>
            <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-20 rounded-xl" />
            </div>
            <div className="grid grid-cols-2 gap-2">
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 rounded-lg" />
                ))}
            </div>
        </div>
    );
}

/** The model is being fetched or the run is about to start. */
export function LoadingState() {
    return (
        <div data-testid="analysis-loading" role="status" aria-live="polite">
            <p className="flex items-center gap-2 px-4 pt-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Loading the model…
            </p>
            <SkeletonReport />
        </div>
    );
}

/**
 * The 3D view cannot show this model (it failed to load, or the browser has no WebGL). The analysis reads the
 * model from the view, so it waits for it; the view's own card has the Try again.
 */
export function UnavailableState({ message }: { message: string }) {
    return (
        <div className="px-4 py-6" data-testid="analysis-unavailable" role="status">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <MonitorX className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-foreground">The 3D view cannot show this model</p>
            <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
            <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
                The structure check reads the model from the 3D view, so it starts once the view shows it. Use Try again in the
                view, or open another model.
            </p>
        </div>
    );
}

/** The first run for this model: skeleton report with the stage and a progress bar. */
export function RunningState({ run }: { run: RunState }) {
    const pct = Math.round(run.progress * 100);
    return (
        <div data-testid="analysis-running" role="status" aria-live="polite">
            <div className="px-4 pt-4">
                <p className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                    Analysing…
                    <span className="ml-auto font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{pct}%</span>
                </p>
                <Progress value={pct} className="mt-2 h-1.5" aria-label="Analysis progress" />
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
                    <p className="text-xs font-semibold text-red-700 dark:text-red-400">The analysis could not run</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
                </div>
            </div>
            <Button type="button" size="sm" variant="outline" className="mt-3 h-8 gap-1.5 text-xs" onClick={onRetry}>
                <RotateCcw />
                Try again
            </Button>
        </div>
    );
}
