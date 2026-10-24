import { Eye, ListChecks } from "lucide-react";

import { CountBadge, DirectionsHint, LayerRaisedNote, Section } from "@/assignment/components/analysis/atoms";
import { CHECK_ICON, CHECK_TONE, TONE } from "@/assignment/components/analysis/style";
import type { AnalysisResult, CheckRow } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { cantileveredBlocks, issuesForCheck, issuesForCheckRow, mentionsAxes, plural } from "@/assignment/store/analysisLogic";

const STATUS_WORD = { pass: "Passes", fail: "Fails", info: "Info" } as const;

/**
 * One row per required constraint: a symbol (tick, cross, info), the constraint and its value. A row with
 * offending blocks is a button that highlights them in the viewer.
 */
export function ChecksSection({ result }: { result: AnalysisResult }) {
    const selection = useAnalysisStore((s) => s.selection);
    const selectIssues = useAnalysisStore((s) => s.selectIssues);
    const selectBlocks = useAnalysisStore((s) => s.selectBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);

    const required = result.checks.filter((check) => check.status !== "info");
    const passing = required.filter((check) => check.status === "pass").length;
    const allPass = passing === required.length;

    const choose = (row: CheckRow, ids: string[], blocks: number[], label?: string) => {
        if (selection?.check === row.key) {
            clearSelection();
            return;
        }
        // The cantilevered-blocks row has no issue of its own: it shows the blocks themselves.
        if (ids.length === 0) {
            selectBlocks(blocks, { check: row.key, label: `${row.label}: ${plural(blocks.length, "block")}` });
            return;
        }
        selectIssues(ids, { check: row.key, label: ids.length > 1 ? (label ?? `${row.label}: ${ids.length} places`) : undefined });
    };

    return (
        <Section
            title="Constraints"
            icon={ListChecks}
            testId="analysis-checks"
            badge={
                required.length > 0 ? (
                    <CountBadge tone={allPass ? "pass" : "fail"} label={`${passing} of ${required.length} checks pass`}>
                        {passing}/{required.length}
                    </CountBadge>
                ) : undefined
            }
        >
            <ul className="-mx-1.5 space-y-0.5">
                {result.checks.map((row) => {
                    const Icon = CHECK_ICON[row.status];
                    const tone = TONE[CHECK_TONE[row.status]];
                    const ids = issuesForCheckRow(result, row).map((issue) => issue.id);
                    // A centre-of-gravity row that fails with nothing on the ground shows the floating parts instead.
                    const viaFloating = row.key === "cog" && ids.length > 0 && issuesForCheck(result.issues, "cog").length === 0;
                    const blocks = row.key === "cantilevered" ? cantileveredBlocks(result.blocks) : [];
                    const actionable = ids.length > 0 || blocks.length > 0;
                    const selected = selection?.check === row.key;
                    const body = (
                        <>
                            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} aria-hidden />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs font-medium text-foreground">
                                    <span className="sr-only">{STATUS_WORD[row.status]}: </span>
                                    {row.label}
                                </span>
                                <span
                                    className={cn(
                                        "block text-[11px] leading-snug",
                                        row.status === "fail" ? tone.text : "text-muted-foreground",
                                    )}
                                >
                                    {row.value}
                                </span>
                            </span>
                            {actionable && (
                                <span
                                    className={cn(
                                        "mt-0.5 flex shrink-0 items-center gap-1 text-[11px]",
                                        selected ? "font-medium text-primary" : "text-muted-foreground group-hover:text-foreground",
                                    )}
                                >
                                    <Eye className="h-3 w-3" aria-hidden />
                                    {selected ? "Showing" : "Show"}
                                </span>
                            )}
                        </>
                    );
                    return (
                        <li key={row.key} data-testid="check-row" data-check={row.key} data-status={row.status}>
                            {actionable ? (
                                <button
                                    type="button"
                                    onClick={() => choose(row, ids, blocks, viaFloating ? `Floating parts: ${ids.length} places` : undefined)}
                                    aria-pressed={selected}
                                    aria-label={`${row.label}: ${STATUS_WORD[row.status]}. ${row.value}. ${
                                        selected ? "Showing in the viewer. Press to clear." : "Press to show the blocks in the viewer."
                                    }`}
                                    className={cn(
                                        "group flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors",
                                        "hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        selected && "bg-primary/10 ring-1 ring-primary/40",
                                        !selected && row.status === "fail" && "bg-destructive/5",
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
            <LayerRaisedNote className="mt-2" />
            {mentionsAxes(result.checks.map((row) => row.value)) && <DirectionsHint className="mt-2" />}
        </Section>
    );
}
