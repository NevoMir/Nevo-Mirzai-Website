import { useRef } from "react";
import { ChevronUp, RotateCcw } from "lucide-react";

import { KeyChips } from "@/assignment/components/analysis/KeyChips";
import { StabilizeCard } from "@/assignment/components/analysis/StabilizeCard";
import { summaryChip, useRunBadge } from "@/assignment/components/analysis/summary";
import type { AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { VerdictBlock } from "@/assignment/components/analysis/VerdictBlock";
import { Button } from "@/assignment/components/ui/button";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { answerIsBeforeRun, outcomeOf } from "@/assignment/store/stabilizeLogic";

/** What the card takes with the idle report in it: the sentence, four figures and the button (the shell reserves this much before it has measured the card). */
export const ANALYSIS_PEEK_CARD_PX = 190;

/**
 * Phone: the answer docked at the bottom of the stage, so the model stays in sight: the sentence, the four figures and the one
 * action, the same pieces as the panel in the same order. It is not a modal. Tapping the sentence, the handle or "Details" opens
 * the full panel as a sheet; the chips and the action work from here. While a run goes, its strip takes the action's place, with
 * Stop on it. The shell positions it (a PhonePeekDock) and adds its height to the viewer's bottom inset.
 */
export function AnalysisPeekCard({ model, snapshot }: { model: ModelAsset | null; snapshot: AnalysisSnapshot }) {
    const setSheetOpen = useAnalysisStore((s) => s.setSheetOpen);
    const retry = useAnalysisStore((s) => s.retry);
    const status = useStabilizeStore((s) => s.status);
    const runModelId = useStabilizeStore((s) => s.sourceModelId);
    const errorKind = useStabilizeStore((s) => s.errorKind);
    const outcome = useStabilizeStore((s) => (s.result ? outcomeOf(s.result) : null));
    const chip = summaryChip(snapshot, useRunBadge());
    const { phase, result, verdict, sentence } = snapshot;
    // A swipe up on the card opens the panel too (the grab bar says so).
    const swipeFrom = useRef<number | null>(null);
    if (phase === "no-model") return null;
    const open = () => setSheetOpen(true);
    // While the run holds blocks the answer is how the model was before them; a failed run, or one with nothing to add, leaves it as true as it was.
    const pending = model !== null && runModelId === model.id && answerIsBeforeRun(status, errorKind, outcome);
    const shell = "rounded-2xl border border-border/70 bg-sidebar/95 pb-3 shadow-lg backdrop-blur";

    let body;
    if (result && verdict && model) {
        body = (
            <>
                {/* Tapping the sentence opens the panel; the handle above and "Details" are the same for the keyboard. */}
                <div onClick={open} className="cursor-pointer">
                    <VerdictBlock result={result} verdict={verdict} sentence={sentence} before={pending} compact />
                </div>
                <div className="mt-2">
                    <KeyChips result={result} dimmed={pending} compact />
                </div>
                <div className="mt-2.5" data-testid="analysis-action">
                    <StabilizeCard model={model} result={result} verdict={verdict} analysing={phase === "running"} compact />
                </div>
            </>
        );
    } else if (phase === "error") {
        body = (
            <div className="px-4 pt-1" role="alert" data-testid="analysis-error">
                <p className="text-[13px] font-semibold text-red-700 dark:text-red-400">The check could not run</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{snapshot.run.error ?? "The check failed."}</p>
                <Button type="button" className="mt-2 h-11 w-full gap-1.5 text-sm" onClick={retry}>
                    <RotateCcw />
                    Try again
                </Button>
            </div>
        );
    } else if (phase === "unavailable") {
        body = (
            <p className="px-4 pt-1 text-xs text-muted-foreground" role="status" data-testid="analysis-unavailable">
                The 3D view cannot show this model, so there is nothing to check yet.
            </p>
        );
    } else {
        body = (
            <div className="px-4 pt-1" aria-hidden data-testid="analysis-skeleton">
                <div className="flex items-start gap-3">
                    <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2 pt-0.5">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                    </div>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-11 rounded-xl" />
                    ))}
                </div>
            </div>
        );
    }

    return (
        <section
            className={cn(shell, "pointer-events-auto")}
            data-testid="analysis-peek-card"
            data-phase={phase}
            aria-label="Stability"
            onPointerDown={(e) => {
                swipeFrom.current = e.clientY;
            }}
            onPointerUp={(e) => {
                if (swipeFrom.current !== null && swipeFrom.current - e.clientY > 28) open();
                swipeFrom.current = null;
            }}
            onPointerCancel={() => {
                swipeFrom.current = null;
            }}
        >
            <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                <span aria-hidden />
                <button
                    type="button"
                    onClick={open}
                    data-testid="analysis-peek"
                    aria-label={`Open the full stability panel. ${chip.text}${chip.custom ? `. Custom settings: ${chip.custom}` : ""}`}
                    // The grab bar is 4 px; the button reaches 44 px around it.
                    className="relative flex h-5 w-24 items-center justify-center before:absolute before:inset-x-0 before:-bottom-4 before:-top-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <span aria-hidden className="h-1 w-9 rounded-full bg-border" />
                </button>
                <button
                    type="button"
                    onClick={open}
                    data-testid="analysis-peek-details"
                    className="relative flex h-5 items-center justify-end gap-0.5 justify-self-end pr-3 text-[11px] font-medium text-muted-foreground before:absolute before:-inset-y-3 before:inset-x-0 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    Details
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                </button>
            </div>
            {body}
        </section>
    );
}
