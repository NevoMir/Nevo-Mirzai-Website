import { useState } from "react";
import { ChevronDown, Info, RotateCcw, WandSparkles } from "lucide-react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { AimField } from "@/assignment/components/analysis/fields";
import { MarkGlyph } from "@/assignment/components/analysis/atoms";
import { confirmedLine, readyOutcome } from "@/assignment/components/analysis/panelLogic";
import { TONE } from "@/assignment/components/analysis/style";
import { useFocusOnEnd } from "@/assignment/components/analysis/useFocusOnEnd";
import { Button } from "@/assignment/components/ui/button";
import { toast } from "@/assignment/components/ui/sonner";
import { addedBlocksLabel } from "@/assignment/components/workspace/format";
import { stabilizedTarget } from "@/assignment/components/workspace/versionLogic";
import { cn } from "@/assignment/lib/utils";
import type { DerivedMeta, ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { hasAddedBlocks, type Verdict } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { partialHeadline, stabilizeOffer } from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { versionFamily } from "@/assignment/store/versions";

/** 44 px on a phone, 40 beside a mouse: the one button of the action. */
const primary = "h-11 w-full gap-2 text-sm font-medium md:h-10";
const small = "h-11 gap-1.5 px-3 text-xs hover:bg-secondary hover:text-foreground md:h-8";

/** The accent tag of what the stabilizer added, the look of the Models list's chip: "+16 blocks". */
function AddedTag({ count }: { count: number }) {
    if (count <= 0) return null;
    return (
        <span
            data-testid="added-tag"
            className="inline-flex shrink-0 items-center rounded-full border border-accent/50 bg-accent/10 px-1.5 text-[10px] font-medium leading-4 text-accent-hover dark:text-accent"
        >
            {addedBlocksLabel(count)}
        </span>
    );
}

// ---------- a stabilized version: what it did ----------

/**
 * The row of a stabilized version, where the button was: "Stabilized +16 blocks", what changed (problems fixed, where strength used
 * started), and a button that paints the added blocks. Green when the report has nothing left to say; amber with the way to go on
 * when something is. A version that added nothing (the model needed no change) says so instead of showing a before and after that
 * are the same. Takes the keyboard focus when it appears right after a run was saved.
 */
function ConfirmedRow({ meta, result, verdict, endedAt, compact }: { meta: DerivedMeta; result: AnalysisResult; verdict: Verdict; endedAt: number | null; compact: boolean }) {
    const ref = useFocusOnEnd<HTMLDivElement>(endedAt);
    const showingAdded = useAnalysisStore((s) => s.view.colorBy === "role");
    const setColorBy = useAnalysisStore((s) => s.setColorBy);
    // Green only when the report has nothing left to say: the stabilizer's goal leaves a warning of its own kind possible.
    const clean = verdict.kind === "pass" && meta.complete && meta.after.errors === 0 && meta.after.warnings === 0;
    const tone = TONE[clean ? "pass" : "warn"];
    const nothingAdded = meta.added_blocks === 0;
    const title = nothingAdded
        ? clean
            ? "Nothing needed adding"
            : `Nothing was added, ${verdict.short} left`
        : clean
          ? "Stabilized"
          : meta.complete
            ? `Stabilized, ${verdict.short} left`
            : partialHeadline(meta.after, meta.target_utilisation, meta.cantilever_limit);
    const canShow = !compact && meta.added_blocks > 0 && hasAddedBlocks(result);
    return (
        <div ref={ref} tabIndex={-1} role="status" className={cn("rounded-xl border p-3 focus:outline-none", tone.soft, tone.border)} data-testid="stabilize-saved" data-complete={clean}>
            <div className="flex items-start gap-2">
                <MarkGlyph mark={clean ? "pass" : "warn"} className="mt-0.5 h-4 w-4" label={clean ? "Stabilized" : "Not fully stable"} />
                <p className={cn("min-w-0 flex-1 text-[13px] font-semibold leading-snug", tone.text)}>{title}</p>
                <AddedTag count={meta.added_blocks} />
            </div>
            {/* The phone's card has room for one line: the figures are in the full panel. */}
            {!compact && (
                <p className="mt-0.5 pl-6 text-[11px] leading-snug text-muted-foreground" data-testid="stabilize-saved-line">
                    {nothingAdded ? "This version matches the original." : confirmedLine(meta)}
                </p>
            )}
            {canShow && (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={cn(small, "mt-2.5 w-full md:w-auto")}
                    aria-pressed={showingAdded}
                    onClick={() => setColorBy(showingAdded ? "status" : "role")}
                    data-testid="stabilize-show-added"
                >
                    {showingAdded ? "Showing what was added" : "Show what was added"}
                </Button>
            )}
        </div>
    );
}

// ---------- the offer ----------

/** "Options": how far down the load is pushed, behind a text toggle, closed until asked for. Inline: the panel also lives in the phone's sheet. */
function OptionsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls="stabilize-options-panel"
            data-testid="stabilize-options"
            className="-my-1 flex min-h-11 shrink-0 items-center gap-0.5 rounded-md px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-6"
        >
            Options
            <ChevronDown className={cn("h-3 w-3 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
        </button>
    );
}

/**
 * The newer version this model has, as a row: it is switched to at the top, not here. No figures: the version has its own (and the
 * first view is not to say them twice), only whether it is good. On a stabilized version it is "a newer version", not another
 * "stabilized version ready" under the row that says it already is one.
 */
function ReadyRow({ meta, compact, fromStabilized }: { meta: DerivedMeta | null; compact: boolean; fromStabilized: boolean }) {
    const outcome = compact ? "" : readyOutcome(meta);
    return (
        <div className={cn("rounded-xl border border-primary/30 bg-primary/5", compact ? "px-3 py-2.5" : "p-3")} data-testid="stabilize-ready">
            <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold leading-snug text-foreground">{fromStabilized ? "A newer version is ready" : "Stabilized version ready"}</p>
                    {/* The phone's card keeps to one line under the title. */}
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                        {outcome ? `${outcome}. ` : ""}Switch to it at the top.
                    </p>
                </div>
            </div>
        </div>
    );
}

export interface StabilizeActionProps {
    model: ModelAsset;
    result: AnalysisResult;
    verdict: Verdict;
    /** A re-run of the analysis is under way: its numbers are about to change. */
    analysing: boolean;
    /** The phone's peek card: the button and the row only, no helper line, Options or second button (they are in the full panel). */
    compact?: boolean;
}

/**
 * The one action under the answer, and only one filled button in it:
 *  - something to fix: Stabilize (Reduce stress when only heavily loaded joints are left), "Adds supports. Your blocks stay.", Options;
 *  - a newer version of this model exists: a row that says so (the bar's switch goes to it) and "Make another version";
 *  - this is a stabilized version: its row, and Stabilize again if the report still has something to say;
 *  - nothing to fix: nothing (a model whose only warning is thin parts left out counts: the stabilizer does not act on those).
 * While the analysis re-runs, or when no more versions may be made, the button is off and the helper line says why.
 */
export function StabilizeAction({ model, result, verdict, analysing, compact = false }: StabilizeActionProps) {
    const models = useWorkspaceStore((s) => s.models);
    const start = useStabilizeStore((s) => s.start);
    const status = useStabilizeStore((s) => s.status);
    const savedModelId = useStabilizeStore((s) => s.savedModelId);
    const endedAt = useStabilizeStore((s) => s.endedAt);
    const [optionsOpen, setOptionsOpen] = useState(false);
    // The version the bar's "Stabilized" half opens: the one seen last, else the newest of the family.
    const offer = stabilizeOffer({ model, models, result, verdict, analysing, opens: stabilizedTarget(versionFamily(models, model.id)) });
    const version = model.kind === "stabilized" && model.derived !== null ? model.derived : null;
    if (!offer && !version) return null;

    const run = () => {
        if (!start(model, result)) toast.error("Could not start", { description: "Another run is going, or the model has no blocks." });
    };
    // A run that was saved a moment ago, and this is its version: the row takes the focus.
    const justSaved = status === "saved" && savedModelId === model.id ? endedAt : null;
    const row = version && <ConfirmedRow meta={version} result={result} verdict={verdict} endedAt={justSaved} compact={compact} />;
    if (!offer) return <div className={compact ? "px-4" : "px-4 pb-3"}>{row}</div>;

    const { child, blocked, label } = offer;
    // A newer version exists (an opened example comes with one): the row announces it instead of offering the fix.
    const childMeta = child ? (models.find((m) => m.id === child.id)?.derived ?? null) : null;
    const buttonLabel = version && !child ? "Stabilize again" : label;
    return (
        <div className={compact ? "px-4" : "px-4 pb-3"} data-testid="stabilize-card">
            {/* data-flash: the bar's "Stabilize…" pill rings the card for a moment when it brings it into view (stabilizeFocus.ts). */}
            <div className={cn("space-y-2 rounded-xl transition-shadow data-[flash=true]:ring-2 data-[flash=true]:ring-primary/60", !compact && "-mx-1 p-1")}>
                {row}
                {child && <ReadyRow meta={childMeta} compact={compact} fromStabilized={version !== null} />}
                {child ? (
                    !compact && (
                        <Button type="button" size="sm" variant="outline" className={cn(small, "w-full md:w-auto")} onClick={run} disabled={blocked !== null} data-testid="stabilize-again">
                            <RotateCcw />
                            Make another version
                        </Button>
                    )
                ) : (
                    <Button type="button" className={primary} onClick={run} disabled={blocked !== null} data-testid="stabilize-start">
                        <WandSparkles />
                        {buttonLabel}
                    </Button>
                )}
                {(blocked || !compact) && (
                    <div className="flex items-start justify-between gap-2">
                        {blocked ? (
                            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="stabilize-blocked">
                                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                {blocked}
                            </p>
                        ) : (
                            <>
                                <p className="pt-0.5 text-[11px] leading-snug text-muted-foreground">Adds supports. Your blocks stay.</p>
                                <OptionsToggle open={optionsOpen} onToggle={() => setOptionsOpen((v) => !v)} />
                            </>
                        )}
                    </div>
                )}
                {!compact && optionsOpen && !blocked && (
                    <div id="stabilize-options-panel" className="rounded-lg bg-muted/60 p-3" data-testid="stabilize-options-panel">
                        <AimField id="stabilize-target" />
                    </div>
                )}
            </div>
        </div>
    );
}
