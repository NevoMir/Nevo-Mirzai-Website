import { useMemo, type ReactNode } from "react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { MarkGlyph } from "@/assignment/components/analysis/atoms";
import { compactFigure, longestOverhang, panelFigures, strengthIsPartial, stressPointLabel } from "@/assignment/components/analysis/panelLogic";
import { MARK_TONE, MARK_WORD, TONE } from "@/assignment/components/analysis/style";
import { useCheckPicks } from "@/assignment/components/analysis/useCheckPicks";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import type { KeyFigure } from "@/assignment/store/analysisBrief";
import { plural } from "@/assignment/store/analysisLogic";

/** The label of the pick a passing Balance chip makes (the stage's callout reads it). */
const BALANCE_POINT = "Where the weight balances";

/** What pressing a chip does, else null (the figure is only a figure). */
interface ChipAction {
    run: () => void;
    /** Its pick is on the stage now. */
    pressed: boolean;
    /** The end of the accessible name: what a press does. */
    hint: string;
}

export interface KeyChipsProps {
    result: AnalysisResult;
    /** Before stabilizing: the figures of the model as it was, dimmed while the run goes. */
    dimmed?: boolean;
    /** Four across, label over value: the phone's peek card. */
    compact?: boolean;
    className?: string;
}

/**
 * The four figures that carry the answer: balance, the longest overhang, strength used and blocks used. Each has a mark that
 * is a symbol as well as a colour. A chip is a button that shows what the figure is about on the model (the problem when it
 * fails, the place it is measured when it passes); one with nothing to show is only a figure. The technical term is in the tooltip.
 */
export function KeyChips({ result, dimmed = false, compact = false, className }: KeyChipsProps) {
    const figures = useMemo(() => panelFigures(result), [result]);
    const picks = useCheckPicks(result);
    const selectBlocks = useAnalysisStore((s) => s.selectBlocks);
    const focusPoint = useAnalysisStore((s) => s.focusPoint);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    // A passing Balance chip flies to the point the weight balances on, a pick with no blocks of its own: it is on while that label is.
    const onBalancePoint = useAnalysisStore((s) => s.selection?.check === null && s.selection.ids.length === 0 && s.selection.label === BALANCE_POINT);

    const actionFor = (figure: KeyFigure): ChipAction | null => {
        switch (figure.key) {
            case "balance": {
                const target = picks.targetOf("cog", "Balance");
                if (target.ids.length > 0) return { run: () => picks.toggle(target), pressed: picks.shownCheck === "cog", hint: "show the problem on the model" };
                const { stability } = result;
                // It passes: look at the point the weight balances on.
                if (stability) {
                    return {
                        run: () => (onBalancePoint ? clearSelection() : focusPoint(stability.cogMm, BALANCE_POINT)),
                        pressed: onBalancePoint,
                        hint: "look at where the weight balances",
                    };
                }
                return null;
            }
            case "overhang": {
                const target = picks.targetOf("long-cantilevers", "Longest overhang");
                if (target.ids.length > 0) return { run: () => picks.toggle(target), pressed: picks.shownCheck === "long-cantilevers", hint: "show the problem on the model" };
                const longest = longestOverhang(result);
                if (!longest) return null;
                return {
                    run: () => (picks.shownCheck === "long-cantilevers" ? clearSelection() : selectBlocks(longest.blocks, { check: "long-cantilevers", label: `Longest overhang: ${plural(longest.reach, "block")}` })),
                    pressed: picks.shownCheck === "long-cantilevers",
                    hint: "show the longest overhang on the model",
                };
            }
            case "strength": {
                const target = picks.targetOf("stress", "Strength used");
                if (target.ids.length > 0) return { run: () => picks.toggle(target), pressed: picks.shownCheck === "stress", hint: "show the problem on the model" };
                // Parts float and the figure has no reading: there is no worst joint to point at.
                const point = strengthIsPartial(result) ? undefined : result.stress?.points[0];
                if (!point) return null;
                return {
                    run: () => (picks.shownCheck === "stress" ? clearSelection() : selectBlocks(point.blocks, { check: "stress", label: stressPointLabel(point) })),
                    pressed: picks.shownCheck === "stress",
                    hint: "show the most loaded joint on the model",
                };
            }
            case "blocks": {
                // A figure, unless a budget is set and passed: then it is a problem, like the others.
                const target = picks.targetOf("components", "Blocks used");
                if (target.ids.length > 0) return { run: () => picks.toggle(target), pressed: picks.shownCheck === "components", hint: "show the problem on the model" };
                return null;
            }
        }
    };

    return (
        <TooltipProvider delayDuration={400}>
            <ul
                data-testid="analysis-chips"
                className={cn(compact ? "grid grid-cols-4 gap-1.5 px-4" : "grid grid-cols-2 gap-2 px-4 pb-3", dimmed && "opacity-60", className)}
            >
                {figures.map((figure) => {
                    const action = actionFor(figure);
                    const tone = TONE[MARK_TONE[figure.mark]];
                    // The phone's mini chip has no unit and no tooltip, so its value keeps the qualifier ("92 out", "7 / 4", "85% used").
                    const mini = compact ? compactFigure(figure) : null;
                    const label = mini ? mini.label : figure.label;
                    const name = `${figure.summary}${action ? ` ${action.pressed ? "Showing on the model. Press to clear." : `Press to ${action.hint}.`}` : ""}`;
                    const body: ReactNode = (
                        <>
                            <span className="flex items-center justify-between gap-1">
                                <span className={cn("font-medium text-muted-foreground", compact ? "text-[10px]" : "text-[11px]")}>{label}</span>
                                <MarkGlyph mark={figure.mark} label={MARK_WORD[figure.mark]} className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
                            </span>
                            <span className="mt-0.5 block leading-tight">
                                <span className={cn("font-semibold tabular-nums", compact ? "text-[13px]" : "text-[15px]", figure.mark === "fail" || figure.mark === "warn" ? tone.text : "text-foreground")}>
                                    {mini ? mini.value : figure.value}
                                </span>
                                {!compact && figure.unit && <span className="ml-1 text-[11px] text-muted-foreground">{figure.unit}</span>}
                            </span>
                        </>
                    );
                    const box = cn(
                        "block h-full w-full rounded-xl border bg-card text-left",
                        compact ? "min-h-11 px-2 py-1.5" : "px-2.5 py-1.5",
                        action?.pressed ? "border-primary bg-primary/5 ring-2 ring-primary/40" : "border-border/70",
                    );
                    return (
                        <li key={figure.key} data-testid="key-chip" data-figure={figure.key} data-mark={figure.mark} className="min-w-0">
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    {action ? (
                                        <button
                                            type="button"
                                            onClick={action.run}
                                            aria-pressed={action.pressed}
                                            aria-label={name}
                                            className={cn(box, "transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
                                        >
                                            {body}
                                        </button>
                                    ) : (
                                        <div role="group" aria-label={name} tabIndex={0} className={cn(box, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
                                            {body}
                                        </div>
                                    )}
                                </TooltipTrigger>
                                {figure.tip && (
                                    <TooltipContent side="top" className="max-w-56 text-xs">
                                        {figure.tip}
                                    </TooltipContent>
                                )}
                            </Tooltip>
                        </li>
                    );
                })}
            </ul>
        </TooltipProvider>
    );
}
