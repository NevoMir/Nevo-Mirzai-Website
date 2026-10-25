import { Eye } from "lucide-react";

import type { AnalysisResult, CheckKey } from "@/assignment/analysis/types";
import { DirectionsHint, MarkGlyph } from "@/assignment/components/analysis/atoms";
import { checkMark, namesDirection } from "@/assignment/components/analysis/panelLogic";
import { MARK_TONE, MARK_WORD, TONE } from "@/assignment/components/analysis/style";
import { useCheckPicks } from "@/assignment/components/analysis/useCheckPicks";
import { cn } from "@/assignment/lib/utils";
import { checkLabel, checkValue } from "@/assignment/store/analysisBrief";
import { fmtMm, scaleLine } from "@/assignment/store/analysisLogic";

/** One quiet figure of "Other numbers". */
function Figure({ label, value, testId }: { label: string; value: string; testId: string }) {
    return (
        <div data-testid={testId} className="flex items-baseline justify-between gap-3 py-1">
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
            <dd className="text-right font-mono text-xs tabular-nums text-foreground">{value}</dd>
        </div>
    );
}

/**
 * "All checks and numbers": the rows of the constraints in plain words, a mark and a value each, and the ones with something to
 * show are buttons that light it up on the model. Under them the other numbers of the analysis, and what was analysed.
 */
export function ChecksDetails({ result }: { result: AnalysisResult }) {
    const picks = useCheckPicks(result);
    const { stats, stability } = result;
    const cog = stability?.cogMm ?? null;
    const values = result.checks.map((row) => checkValue(row, result));

    return (
        <div data-testid="analysis-checks-body">
            <ul className="-mx-1.5 space-y-0.5">
                {result.checks.map((row, i) => {
                    // The engine passes or fails a row; the mark adds a warning (a joint at 85%) and "not counted" (parts float).
                    const mark = checkMark(row, result);
                    const tone = TONE[MARK_TONE[mark]];
                    const label = checkLabel(row.key as CheckKey);
                    const target = picks.targetOf(row.key, label);
                    const actionable = target.ids.length > 0 || target.blocks.length > 0;
                    const shown = picks.shownCheck === row.key;
                    const body = (
                        <>
                            <MarkGlyph mark={mark} label={MARK_WORD[mark]} className="mt-0.5 h-4 w-4" />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium text-foreground">{label}</span>
                                <span className={cn("block text-[11px] leading-snug", mark === "fail" || mark === "warn" ? tone.text : "text-muted-foreground")}>{values[i]}</span>
                            </span>
                            {actionable && (
                                <span className={cn("mt-0.5 flex shrink-0 items-center gap-1 text-[11px]", shown ? "font-medium text-primary" : "text-muted-foreground group-hover:text-foreground")}>
                                    <Eye className="h-3 w-3" aria-hidden />
                                    {shown ? "Showing" : "Show"}
                                </span>
                            )}
                        </>
                    );
                    return (
                        <li key={row.key} data-testid="check-row" data-check={row.key} data-status={row.status}>
                            {actionable ? (
                                <button
                                    type="button"
                                    onClick={() => picks.toggle(target)}
                                    aria-pressed={shown}
                                    aria-label={`${label}: ${MARK_WORD[mark]}. ${values[i]}. ${shown ? "Showing in the viewer. Press to clear." : "Press to show the blocks in the viewer."}`}
                                    className={cn(
                                        "group flex min-h-11 w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors md:min-h-0",
                                        "hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        shown && "bg-primary/10 ring-1 ring-primary/40",
                                        !shown && row.status === "fail" && "bg-destructive/5",
                                    )}
                                >
                                    {body}
                                </button>
                            ) : (
                                <div className="flex w-full items-start gap-2 px-1.5 py-1.5">{body}</div>
                            )}
                        </li>
                    );
                })}
            </ul>

            <div className="mt-3 border-t border-border/60 pt-3">
                <h4 className="text-xs font-medium text-foreground">Other numbers</h4>
                <dl className="mt-1">
                    <Figure label="Layers high" value={String(stats.layers)} testId="figure-layers" />
                    <Figure label="Separate pieces" value={String(stats.bodyCount)} testId="figure-pieces" />
                    <Figure label="Weight centre (x, y, z)" value={cog ? `${fmtMm(cog[0])}, ${fmtMm(cog[1])}, ${fmtMm(cog[2])} mm` : "none"} testId="figure-weight-centre" />
                    <Figure label="Share of the model kept in blocks" value={`${Math.round(stats.coverage * 100)}%`} testId="figure-kept" />
                </dl>
            </div>

            <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="analysis-scale-line">
                {scaleLine(result)}
            </p>
            {namesDirection(values) && <DirectionsHint className="mt-1.5" />}
        </div>
    );
}
