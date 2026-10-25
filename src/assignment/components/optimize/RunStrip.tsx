import { useEffect, useState } from "react";
import { Loader2, Square } from "lucide-react";

import { useThrottled } from "@/assignment/components/analysis/useThrottled";
import { ConvergenceChart } from "@/assignment/components/optimize/ConvergenceChart";
import { Button } from "@/assignment/components/ui/button";
import { useOptimizeStore } from "@/assignment/store/optimize";
import { counterLine, focusOf, runningTitle } from "@/assignment/store/optimizeLogic";

/** The clock in seconds while a run goes: the title says "12 s of ~30 s". */
function useElapsed(startedAt: number | null, running: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!running) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [running]);
    return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/**
 * While it runs: the title with the time, the convergence chart growing round by round, the counters, and the last few moves. The stage shows
 * the blocks as they stand, the ones taken out as faint red ghosts. Stop keeps the best state it had reached.
 */
export function RunStrip() {
    const startedAt = useOptimizeStore((s) => s.startedAt);
    const effort = useOptimizeStore((s) => s.effort);
    const history = useOptimizeStore((s) => s.history);
    const latest = useOptimizeStore((s) => s.latest);
    const recent = useOptimizeStore((s) => s.recent);
    const start = useOptimizeStore((s) => s.startMetrics);
    const effective = useOptimizeStore((s) => s.effective);
    const kgPer = useOptimizeStore((s) => s.kgPer);
    const goal = useOptimizeStore((s) => s.goalLabel);
    const objective = useOptimizeStore((s) => s.spec?.objective);
    const stopping = useOptimizeStore((s) => s.stopping);
    const cancel = useOptimizeStore((s) => s.cancel);
    const elapsed = useElapsed(startedAt, true);
    // What a screen reader hears: at most every 1.5 s (the numbers behind it change faster).
    const metrics = objective?.map((t) => t.metric) ?? [];
    const line = useThrottled(start ? counterLine(start, latest, kgPer, metrics) : "Starting…", 1500);
    return (
        <div className="px-4 pb-3" data-testid="optimize-running">
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
                    <p className="min-w-0 flex-1 text-[13px] font-semibold text-foreground" data-testid="optimize-running-title">
                        {runningTitle(elapsed, effort)}
                    </p>
                    <Button type="button" size="sm" variant="outline" className="h-11 gap-1.5 px-3 text-xs hover:bg-secondary md:h-8" onClick={cancel} disabled={stopping} data-testid="optimize-stop">
                        {stopping ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Square />}
                        {stopping ? "Stopping…" : "Stop"}
                    </Button>
                </div>
                {goal && (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={goal}>
                        For “{goal}”
                    </p>
                )}
                <ConvergenceChart className="mt-2.5" rows={history} kgPerBlock={kgPer} limit={effective ? effective.maxStressPct / 100 : null} focus={focusOf(metrics)} />
                <p role="status" aria-live="polite" className="mt-2 text-xs tabular-nums text-foreground" data-testid="optimize-counters">
                    {line}
                </p>
                {recent.length > 0 && (
                    <div className="mt-2" data-testid="optimize-recent">
                        <p className="text-[11px] font-medium text-muted-foreground">What it did</p>
                        <ul className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                            {recent.map((move) => (
                                <li key={move}>{move}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">The blocks on the stage are the run so far. Faint red cubes are blocks taken out.</p>
        </div>
    );
}
