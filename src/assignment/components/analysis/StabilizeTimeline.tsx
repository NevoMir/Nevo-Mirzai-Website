import { useEffect, useRef } from "react";

import { useThrottled } from "@/assignment/components/analysis/useThrottled";
import { cn } from "@/assignment/lib/utils";
import { ROLE_HEX } from "@/assignment/shared/assembly";
import type { StabilizeStepLog } from "@/assignment/shared/contract";
import { stepChips } from "@/assignment/store/stabilizeLogic";
import { ROLE_PLURALS } from "@/assignment/viewer/analysisGeometry";

export interface StabilizeTimelineProps {
    steps: readonly StabilizeStepLog[];
    /** The run is still going: the newest step is "current" and the list follows it. */
    running: boolean;
    /** The step whose blocks are shown on the stage, else null. */
    selected: number | null;
    onSelect: (n: number | null) => void;
    className?: string;
}

/**
 * What the stabilizer did, one row per accepted move: a number, the role it added (a colour dot and the word), the sentence
 * with the numbers, and chips for what changed. A row is a button: it lights up the blocks it added and flies the camera
 * there. The sentence of the newest row is announced politely, at most every 1.5 s.
 */
export function StabilizeTimeline({ steps, running, selected, onSelect, className }: StabilizeTimelineProps) {
    const last = steps[steps.length - 1];
    const announcement = useThrottled(last ? `Step ${last.n}: ${last.text}` : "", 1500);
    const boxRef = useRef<HTMLDivElement>(null);
    // The list follows the run while the reader is at its end; one who scrolled up to read is left alone.
    const following = useRef(true);

    // While it runs the list is a box of its own: scrolling the report panel instead would carry the Stop button and the
    // progress line away after a few steps and pull the panel back down at every new one.
    useEffect(() => {
        const box = boxRef.current;
        if (!running || !box || steps.length === 0 || !following.current) return;
        // A jump, not an animation: the scroll events of an animation would look like the reader moving away from the end.
        box.scrollTop = box.scrollHeight;
    }, [running, steps.length]);

    if (steps.length === 0) return null;
    return (
        <div className={className} data-testid="stabilize-timeline">
            <p className="sr-only" role="status" aria-live="polite">
                {announcement}
            </p>
            <div
                ref={boxRef}
                onScroll={(e) => {
                    const box = e.currentTarget;
                    following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
                }}
                // A little padding keeps the focus ring of the first and last row inside the scrolling box.
                className={cn(running && "-mx-0.5 max-h-64 overflow-y-auto overscroll-contain px-0.5 py-0.5")}
                data-testid="stabilize-timeline-scroll"
            >
                <ol aria-label="What the stabilizer did, step by step" className="space-y-1.5">
                    {steps.map((step, i) => {
                        const on = selected === step.n;
                        const latest = running && i === steps.length - 1;
                        return (
                            <li key={step.n}>
                                <button
                                    type="button"
                                    onClick={() => onSelect(on ? null : step.n)}
                                    aria-pressed={on}
                                    aria-current={latest ? "step" : undefined}
                                    aria-label={`Step ${step.n}, ${ROLE_PLURALS[step.move].toLowerCase()}: ${step.text} ${on ? "Showing in the viewer. Press to clear." : "Press to show these blocks in the viewer."}`}
                                    data-testid="timeline-step"
                                    data-step={step.n}
                                    data-role={step.move}
                                    className={cn(
                                        "group flex w-full gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors",
                                        "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        on ? "border-primary bg-primary/5 ring-2 ring-primary/40" : latest ? "border-primary/50 bg-card" : "border-border/70 bg-card",
                                    )}
                                >
                                    <span
                                        aria-hidden
                                        className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[10px] font-semibold text-secondary-foreground"
                                    >
                                        {step.n}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                            <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px] ring-1 ring-black/15 dark:ring-white/20" style={{ background: ROLE_HEX[step.move] }} />
                                            {ROLE_PLURALS[step.move]}
                                        </span>
                                        <span className="mt-0.5 block text-xs leading-relaxed text-foreground">{step.text}</span>
                                        <span className="mt-1.5 flex flex-wrap gap-1">
                                            {stepChips(step).map((chip) => (
                                                <span key={chip} className="rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                                    {chip}
                                                </span>
                                            ))}
                                        </span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}
