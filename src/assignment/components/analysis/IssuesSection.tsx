import { useEffect, useRef } from "react";
import { Eye, EyeOff, Info, ShieldCheck, TriangleAlert, X } from "lucide-react";

import { CountBadge, DirectionsHint, LayerRaisedNote, Section } from "@/assignment/components/analysis/atoms";
import { ISSUE_ICON, TONE } from "@/assignment/components/analysis/style";
import type { AnalysisResult, Issue } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { FILL_RANGE, mentionsAxes, passingSentence, plural, selectionRole } from "@/assignment/store/analysisLogic";

function PassingState({ result }: { result: AnalysisResult }) {
    return (
        <div
            data-testid="analysis-passing"
            className="flex flex-col items-center rounded-xl border border-success/35 bg-success/10 px-4 py-5 text-center"
        >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-success/20 text-success ring-8 ring-success/10">
                <ShieldCheck className="h-6 w-6" aria-hidden />
            </span>
            <p className="mt-3 text-sm font-semibold text-green-700 dark:text-green-400">No problems found</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{passingSentence(result)}</p>
        </div>
    );
}

function IssueCard({ issue }: { issue: Issue }) {
    // "only" = this card alone is shown; "member" = one of several shown at once (a failing check row picked them).
    const role = useAnalysisStore((s) => selectionRole(s.selection, issue.id));
    const selected = role !== "none";
    const only = role === "only";
    const hovered = useAnalysisStore((s) => s.hoverIssueId === issue.id);
    const toggleIssue = useAnalysisStore((s) => s.toggleIssue);
    const ref = useRef<HTMLLIElement>(null);

    // A block clicked in the viewer selects its issue; bring the card into view.
    useEffect(() => {
        if (!selected) return;
        const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        ref.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, [selected]);

    const tone = TONE[issue.severity === "error" ? "fail" : "warn"];
    const Icon = ISSUE_ICON[issue.kind];
    return (
        <li ref={ref} data-testid="issue-card" data-issue={issue.id} data-severity={issue.severity} data-selected={selected} data-role={role}>
            <button
                type="button"
                onClick={() => toggleIssue(issue.id)}
                aria-pressed={selected}
                aria-label={`${issue.severity === "error" ? "Error" : "Warning"}: ${issue.title}. ${issue.detail} ${
                    only
                        ? "Showing in the viewer. Press to clear."
                        : selected
                          ? "Showing in the viewer with other problems. Press to show only this one."
                          : "Press to show it in the viewer."
                }`}
                className={cn(
                    "group relative flex w-full gap-2.5 overflow-hidden rounded-xl border bg-card py-2.5 pl-4 pr-3 text-left transition-colors",
                    "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                        ? "border-primary bg-primary/5 ring-2 ring-primary/40"
                        : hovered
                          ? "border-foreground/40 bg-secondary/50"
                          : "border-border/70",
                )}
            >
                <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", tone.solid)} />
                <span
                    aria-hidden
                    className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg", tone.soft, tone.icon)}
                >
                    <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span
                            className={cn(
                                "rounded border px-1 text-[10px] font-semibold uppercase leading-4 tracking-wide",
                                tone.soft,
                                tone.border,
                                tone.text,
                            )}
                        >
                            {issue.severity === "error" ? "Error" : "Warning"}
                        </span>
                        <span className="text-xs font-semibold leading-snug text-foreground">{issue.title}</span>
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{issue.detail}</span>
                    <span className="mt-2 flex items-center gap-2">
                        <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                            {issue.blocks.length > 0
                                ? plural(issue.blocks.length, "block")
                                : issue.kind === "thin-features"
                                  ? "shows the original model"
                                  : "whole design"}
                        </span>
                        <span
                            className={cn(
                                "ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                                only
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-secondary-foreground group-hover:bg-primary/15",
                            )}
                        >
                            {only ? <EyeOff className="h-3 w-3" aria-hidden /> : <Eye className="h-3 w-3" aria-hidden />}
                            {only ? "Clear" : selected ? "Show only this" : "Show"}
                        </span>
                    </span>
                </span>
            </button>
        </li>
    );
}

/**
 * Under the problems when a part floats. A part counts as floating when the blocks do not join it to the ground,
 * and the fill threshold drops every block the model fills too little, so a thin joint can cut a model that is
 * one piece into several. The report cannot tell the two apart; this says so and offers the two ways to check.
 */
function FloatingHint({ result }: { result: AnalysisResult }) {
    const update = useAnalysisStore((s) => s.updateSettings);
    const showGhost = useAnalysisStore((s) => s.view.showGhost);
    const setShowGhost = useAnalysisStore((s) => s.setShowGhost);
    const fill = result.settings.fillThreshold;
    const lower = Math.max(FILL_RANGE.min, Math.round((fill - 0.1) * 100) / 100);
    const canLower = fill - FILL_RANGE.min > 1e-6;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const button =
        "rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    return (
        <div className="mt-2 rounded-xl border border-border/70 bg-muted/50 px-3 py-2.5" data-testid="floating-hint">
            <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                    {result.stability ? "A floating part is not joined to the ground by the blocks." : "Nothing reaches the ground: the lowest 100 mm layer has no block that is filled enough."}{" "}
                    The model itself may still be one piece: blocks the model fills less than {pct(fill)} are left out, so a thin joint can
                    split it. Compare with the original model, or lower the fill threshold.
                </span>
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-5">
                <button type="button" className={button} onClick={() => setShowGhost(!showGhost)} aria-pressed={showGhost}>
                    {showGhost ? "Hide original model" : "Show original model"}
                </button>
                {canLower && (
                    <button type="button" className={button} onClick={() => update({ fillThreshold: lower })}>
                        Lower fill threshold to {pct(lower)}
                    </button>
                )}
            </div>
        </div>
    );
}

/** The issues: where the design fails and why, each with a "Show" that highlights its blocks and flies there. */
export function IssuesSection({ result }: { result: AnalysisResult }) {
    const selected = useAnalysisStore((s) => s.selection !== null);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const { issues } = result;
    const errors = issues.filter((issue) => issue.severity === "error").length;
    const warnings = issues.length - errors;

    return (
        <Section
            title="Problems"
            icon={TriangleAlert}
            testId="analysis-issues"
            badge={
                issues.length > 0 ? (
                    <CountBadge
                        tone={errors > 0 ? "fail" : "warn"}
                        label={`${plural(errors, "error")}, ${plural(warnings, "warning")}`}
                    >
                        {issues.length}
                    </CountBadge>
                ) : (
                    <CountBadge tone="pass" label="No problems">
                        0
                    </CountBadge>
                )
            }
            action={
                selected ? (
                    <button
                        type="button"
                        onClick={clearSelection}
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="h-3 w-3" aria-hidden />
                        Clear highlight
                    </button>
                ) : undefined
            }
        >
            {issues.length === 0 ? (
                <PassingState result={result} />
            ) : (
                <>
                    <LayerRaisedNote className="mb-2" />
                    <ul className="space-y-2">
                        {issues.map((issue) => (
                            <IssueCard key={issue.id} issue={issue} />
                        ))}
                    </ul>
                    {/* An assembly is its blocks (nothing was left out by a fill threshold), so a floating part is floating. */}
                    {!result.assembly && issues.some((issue) => issue.kind === "floating") && <FloatingHint result={result} />}
                    {mentionsAxes(issues.map((issue) => `${issue.title} ${issue.detail}`)) && <DirectionsHint className="mt-2" />}
                </>
            )}
        </Section>
    );
}
