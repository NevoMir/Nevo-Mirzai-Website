import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Eye, EyeOff, X } from "lucide-react";

import type { AnalysisResult, Issue } from "@/assignment/analysis/types";
import { CountBadge, DirectionsHint, MarkGlyph } from "@/assignment/components/analysis/atoms";
import { PROBLEM_CAP, explainsDirection, issueCanShow, namesDirection, visibleProblems } from "@/assignment/components/analysis/panelLogic";
import { Button } from "@/assignment/components/ui/button";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { issueBrief, sortIssuesForList } from "@/assignment/store/analysisBrief";
import { FILL_RANGE, plural, selectionRole } from "@/assignment/store/analysisLogic";

/** 44 px on a phone, 24 px beside a mouse. */
const rowButton = "inline-flex h-11 items-center gap-1 rounded-md px-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6";

/**
 * Under a floating part's "Why": a part counts as floating when the blocks do not join it to the ground, and the fill threshold
 * drops every block the model fills too little, so a thin joint can cut a model that is one piece into several. The report cannot
 * tell the two apart; this says so and offers the two ways to check.
 */
function FloatingActions({ result }: { result: AnalysisResult }) {
    const update = useAnalysisStore((s) => s.updateSettings);
    const showGhost = useAnalysisStore((s) => s.view.showGhost);
    const setShowGhost = useAnalysisStore((s) => s.setShowGhost);
    const fill = result.settings.fillThreshold;
    const lower = Math.max(FILL_RANGE.min, Math.round((fill - 0.1) * 100) / 100);
    const canLower = fill - FILL_RANGE.min > 1e-6;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const button =
        "rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-h-11 md:min-h-0";
    return (
        <div className="mt-2" data-testid="floating-hint">
            <p>
                {result.stability ? "A floating part is not joined to the ground by the blocks. " : "Nothing reaches the ground: the lowest layer has no block that is filled enough. "}
                The model itself may still be one piece: parts the model fills less than {pct(fill)} are left out of the blocks, so a thin joint can split it.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
                <button type="button" className={button} onClick={() => setShowGhost(!showGhost)} aria-pressed={showGhost}>
                    {showGhost ? "Hide original model" : "Show original model"}
                </button>
                {canLower && (
                    <button type="button" className={button} onClick={() => update({ fillThreshold: lower })}>
                        Lower the fill threshold to {pct(lower)}
                    </button>
                )}
            </div>
        </div>
    );
}

/** One problem: what it is, where, a "Why" that opens the explanation, and a "Show" that lights it up on the model. */
function ProblemRow({ issue, result }: { issue: Issue; result: AnalysisResult }) {
    // "only" = this row alone is shown; "member" = one of several shown at once (a failing check or chip picked them).
    const role = useAnalysisStore((s) => selectionRole(s.selection, issue.id));
    const selected = role !== "none";
    const only = role === "only";
    const hovered = useAnalysisStore((s) => s.hoverIssueId === issue.id);
    const toggleIssue = useAnalysisStore((s) => s.toggleIssue);
    const brief = useMemo(() => issueBrief(issue, result), [issue, result]);
    const [why, setWhy] = useState(false);
    const whyId = useId();
    const ref = useRef<HTMLLIElement>(null);

    // A block clicked in the viewer selects its problem; bring the row into view.
    useEffect(() => {
        if (!selected) return;
        const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        ref.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, [selected]);

    const explanation = brief.why || issue.detail;
    const canShow = issueCanShow(issue);
    const mark = issue.severity === "error" ? "fail" : "warn";
    const Eyes = only ? EyeOff : Eye;
    return (
        <li
            ref={ref}
            data-testid="issue-card"
            data-issue={issue.id}
            data-severity={issue.severity}
            data-selected={selected}
            data-role={role}
            className={cn(
                "rounded-xl border bg-card px-3 py-1.5 transition-colors",
                selected ? "border-primary bg-primary/5 ring-2 ring-primary/40" : hovered ? "border-foreground/40 bg-secondary/50" : "border-border/70",
            )}
        >
            <div className="flex items-start gap-2">
                <MarkGlyph mark={mark} className="mt-0.5 h-4 w-4" label={issue.severity === "error" ? "Problem" : "Warning"} />
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-foreground">{brief.what}</p>
                    <div className="mt-0.5 flex items-center gap-1">
                        <p className="min-w-0 flex-1 text-[11px] leading-[14px] text-muted-foreground">{brief.where}</p>
                        <button
                            type="button"
                            onClick={() => setWhy((v) => !v)}
                            aria-expanded={why}
                            aria-controls={whyId}
                            className={cn(rowButton, "text-muted-foreground hover:bg-secondary hover:text-foreground")}
                            data-testid="issue-why"
                        >
                            Why
                            <ChevronDown className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", why && "rotate-180")} aria-hidden />
                        </button>
                        {canShow && (
                            <button
                                type="button"
                                onClick={() => toggleIssue(issue.id)}
                                aria-pressed={selected}
                                aria-label={`${only ? "Clear" : selected ? "Show only" : "Show"}: ${brief.what}${only ? ". Showing in the viewer." : ""}`}
                                className={cn(
                                    rowButton,
                                    "shrink-0",
                                    selected ? "bg-primary/15 text-primary hover:bg-primary/20" : "bg-secondary text-secondary-foreground hover:bg-primary/15",
                                )}
                                data-testid="issue-show"
                            >
                                <Eyes className="h-3 w-3" aria-hidden />
                                {only ? "Clear" : selected ? "Show only this" : "Show"}
                            </button>
                        )}
                    </div>
                </div>
            </div>
            <div id={whyId} hidden={!why}>
                {why && (
                    <div className="mt-2 rounded-lg bg-muted/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground" data-testid="issue-why-text">
                        <p>{explanation}</p>
                        {/* An assembly is its blocks (nothing was left out by a fill threshold), so a floating part is floating. */}
                        {issue.kind === "floating" && !result.assembly && <FloatingActions result={result} />}
                        {(namesDirection([brief.where]) || explainsDirection([explanation])) && <DirectionsHint className="mt-2" />}
                    </div>
                )}
            </div>
        </li>
    );
}

/**
 * "What to fix": the problems, the worst first, three of them and a "N more" for the rest. A problem that is picked on the stage
 * and hidden by the cap opens the list. "Show" lights the problem up on the model and flies there; "Clear" lets go.
 */
export function ProblemList({ result }: { result: AnalysisResult }) {
    const selection = useAnalysisStore((s) => s.selection);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const issues = useMemo(() => sortIssuesForList(result.issues), [result.issues]);
    const [expanded, setExpanded] = useState(false);
    const listId = useId();
    const selectedIds = selection?.ids ?? [];
    const { shown, hidden, locked, auto } = visibleProblems(issues, expanded, selectedIds);

    // Opened by a pick on the stage: it stays open when the pick is let go, so the list does not jump under the pointer.
    useEffect(() => {
        if (auto) setExpanded(true);
    }, [auto]);

    if (issues.length === 0) return null;
    // An empty model: the answer already says "no blocks", so a row of it with a Show that shows nothing would say it twice. What
    // is left to say is the way out, once, as text.
    if (issues.length === 1 && issues[0].kind === "empty") {
        return (
            <section className="px-4 pb-3" data-testid="analysis-issues" data-variant="advice" aria-labelledby={`${listId}-title`}>
                <h3 id={`${listId}-title`} className="mb-1.5 text-[13px] font-medium text-foreground">
                    What to try
                </h3>
                <p className="rounded-xl border border-border/70 bg-card px-3 py-2 text-xs leading-relaxed text-muted-foreground" data-testid="issue-advice">
                    {issues[0].detail}
                </p>
            </section>
        );
    }
    const errors = issues.filter((issue) => issue.severity === "error").length;
    return (
        <section className="px-4 pb-3" data-testid="analysis-issues" aria-labelledby={`${listId}-title`}>
            <div className="mb-1.5 flex min-h-7 items-center gap-2">
                <h3 id={`${listId}-title`} className="text-[13px] font-medium text-foreground">
                    What to fix
                </h3>
                <CountBadge tone={errors > 0 ? "fail" : "warn"} label={`${plural(errors, "problem")}, ${plural(issues.length - errors, "warning")}`}>
                    {issues.length}
                </CountBadge>
                {selection && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={clearSelection}
                        className="-mr-2 ml-auto h-11 gap-1 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 hover:text-primary md:h-7"
                        data-testid="issues-clear"
                    >
                        <X className="h-3 w-3" aria-hidden />
                        Clear
                    </Button>
                )}
            </div>
            <ul id={listId} className="space-y-1.5">
                {shown.map((issue) => (
                    <ProblemRow key={issue.id} issue={issue} result={result} />
                ))}
            </ul>
            {issues.length > PROBLEM_CAP && (
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    disabled={locked}
                    aria-expanded={hidden === 0}
                    aria-controls={listId}
                    aria-label={hidden > 0 ? `Show ${plural(hidden, "more problem")}` : "Show fewer problems"}
                    data-testid="issues-more"
                    className="mt-1 flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 md:min-h-7"
                >
                    {hidden > 0 ? "More problems" : "Show fewer"}
                    <ChevronDown className={cn("h-3.5 w-3.5 transition-transform motion-reduce:transition-none", hidden === 0 && "rotate-180")} aria-hidden />
                </button>
            )}
        </section>
    );
}
