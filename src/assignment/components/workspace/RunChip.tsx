import { Loader2, Square } from "lucide-react";

import { ElapsedTime } from "@/assignment/components/chat/ElapsedTime";
import { useRunActivity } from "@/assignment/components/workspace/useRunActivity";
import { cn } from "@/assignment/lib/utils";
import { requestAccessCode } from "@/assignment/store/access";
import { stopEdit } from "@/assignment/store/edit";
import { stopGeneration } from "@/assignment/store/generation";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { currentWork } from "@/assignment/store/workGuard";

/**
 * "Muse is editing… 8 s [■]": the work in progress, next to the version control on every tab (and in focus mode, with the chat folded
 * away), so a run that is not on the tab you are looking at is never invisible. The Stop button stops it; nothing here starts anything.
 * `compact` (a phone's row) drops the words from sight.
 */
export function RunChip({ className, compact = false }: { className?: string; compact?: boolean }) {
    const activity = useRunActivity();
    if (!activity) return null;
    const stop = () => {
        if (activity.stopKey === "job") void stopGeneration(requestAccessCode);
        else if (activity.stopKey === "mesh" && activity.stopId) void stopEdit(activity.stopId);
        else if (activity.stopKey === "stabilize") useStabilizeStore.getState().cancel();
        else if (activity.stopKey === "hold") currentWork()?.stop?.();
    };
    return (
        <div
            role="status"
            data-testid="run-chip"
            className={cn(
                "pointer-events-auto flex h-7 shrink-0 items-center gap-1.5 rounded-xl border border-border/70 bg-background/80 pl-2 pr-1 text-xs text-foreground",
                className,
            )}
        >
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
            {/* A phone's row has room for the clock and Stop only: the words stay for a screen reader. */}
            <span className={cn("whitespace-nowrap font-medium", compact && "sr-only")} data-testid="run-chip-words">
                {activity.words}…
            </span>
            <ElapsedTime startedAt={activity.since} className="font-mono text-[11px] tabular-nums text-muted-foreground" />
            {activity.stopKey && (
                <button
                    type="button"
                    onClick={stop}
                    data-testid="run-chip-stop"
                    aria-label={`Stop: ${activity.words}`}
                    title="Stop"
                    className="grid h-5 w-5 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <Square className="h-2.5 w-2.5 fill-current" aria-hidden />
                </button>
            )}
        </div>
    );
}
