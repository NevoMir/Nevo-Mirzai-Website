import { useMemo } from "react";
import { Check, Minus, RotateCcw, X } from "lucide-react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { customSettingsLine } from "@/assignment/components/analysis/panelLogic";
import { TONE, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import type { Verdict } from "@/assignment/store/analysisLogic";
import { verdictSentence, type VerdictSentence } from "@/assignment/store/analysisBrief";

export interface VerdictBlockProps {
    result: AnalysisResult;
    verdict: Verdict;
    /** The sentence the snapshot already holds for this result (useAnalysisSnapshot); worked out here when the caller has none. */
    sentence?: VerdictSentence | null;
    /** The stabilizer has a run in hand: this is how the model was before it, so the answer is dimmed and says so. */
    before?: boolean;
    /** A smaller block, for the phone's peek card. */
    compact?: boolean;
    className?: string;
}

/**
 * The answer, first thing in the panel: one plain sentence ("Will tip over and 2 arms are too long.") with a symbol and a colour,
 * two lines at most. A polite status region, so a re-run that changes the answer is announced; picking something to show is not.
 * Under it, once, when the settings are not the assignment's: which they are, and the way back.
 */
export function VerdictBlock({ result, verdict, sentence: given = null, before = false, compact = false, className }: VerdictBlockProps) {
    const resetSettings = useAnalysisStore((s) => s.resetSettings);
    const sentence = useMemo(() => given ?? verdictSentence(result), [given, result]);
    // In the words of the Settings page ("longest overhang 6"), from the settings this result was reached with.
    const custom = useMemo(() => customSettingsLine(result.settings), [result.settings]);
    const tone = TONE[VERDICT_TONE[verdict.kind]];
    const Glyph = verdict.kind === "pass" ? Check : verdict.kind === "fail" ? X : Minus;

    return (
        <div className={cn(compact ? "px-4 pt-1" : "px-4 pb-3 pt-3", className)} data-testid="analysis-verdict" data-verdict={verdict.kind}>
            <div className={cn("flex items-start gap-3 transition-opacity", before && "opacity-60")}>
                <span
                    aria-hidden
                    className={cn(
                        "mt-px grid h-7 w-7 shrink-0 place-items-center rounded-full",
                        tone.solid,
                        verdict.kind === "warn" ? "text-amber-950" : "text-white",
                    )}
                >
                    <Glyph className="h-4 w-4" strokeWidth={3} />
                </span>
                <div className="min-w-0 flex-1">
                    <div role="status">
                        <p className={cn("text-[15px] font-semibold leading-snug", tone.text)} data-testid="analysis-sentence">
                            {sentence.text}
                        </p>
                        {/* The phone's card has no room for the second line: "Will stand." says it. */}
                        {sentence.sub && !compact && <p className="mt-0.5 text-xs text-muted-foreground">{sentence.sub}</p>}
                    </div>
                    {/* Outside the status region: the label coming and going is not the answer changing, so it is not announced as one. */}
                    {before && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="analysis-before">
                            Before stabilizing
                        </p>
                    )}
                </div>
            </div>
            {/* The settings are remembered in this browser and decide the answer, so a non-default one is said here, once. */}
            {custom && !compact && (
                <p className="mt-2 flex flex-wrap items-center gap-x-1.5 pl-10 text-[11px] text-muted-foreground" data-testid="analysis-custom-settings">
                    <span>Custom settings: {custom}</span>
                    <span aria-hidden>·</span>
                    <button
                        type="button"
                        onClick={resetSettings}
                        className="flex items-center gap-1 rounded-md px-1 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <RotateCcw className="h-3 w-3" aria-hidden />
                        Reset
                    </button>
                </p>
            )}
        </div>
    );
}
