import { useEffect, useRef, useState } from "react";

import { DEFAULT_ANALYSIS_SETTINGS } from "@/assignment/analysis/types";
import { AboutPage } from "@/assignment/components/analysis/AboutPage";
import { ChecksDetails } from "@/assignment/components/analysis/ChecksDetails";
import { DetailSection } from "@/assignment/components/analysis/DetailSection";
import { EditBlocksCard } from "@/assignment/components/analysis/EditBlocksCard";
import { KeyChips } from "@/assignment/components/analysis/KeyChips";
import { ErrorState, LoadingState, NoModelState, RunningState, UnavailableState } from "@/assignment/components/analysis/PanelStates";
import { PanelHeader } from "@/assignment/components/analysis/PanelHeader";
import { bringsReportForward, checksSummary, strengthSummary, type PanelPage } from "@/assignment/components/analysis/panelLogic";
import { ProblemList } from "@/assignment/components/analysis/ProblemList";
import { SettingsPage } from "@/assignment/components/analysis/SettingsPage";
import { StabilizeCard } from "@/assignment/components/analysis/StabilizeCard";
import { StabilizerLog } from "@/assignment/components/analysis/StabilizerLog";
import { StrengthDetails } from "@/assignment/components/analysis/StrengthDetails";
import type { AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { useBlockDraft } from "@/assignment/components/analysis/useBlockDraft";
import { logSummary, useStabilizerLog } from "@/assignment/components/analysis/useStabilizerLog";
import { VerdictBlock } from "@/assignment/components/analysis/VerdictBlock";
import { TooltipProvider } from "@/assignment/components/ui/tooltip";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { sameSettings } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { answerIsBeforeRun, needsDecision, outcomeOf } from "@/assignment/store/stabilizeLogic";

/** Width of the report panel on the desktop, and the space it takes from the viewer (panel + its margins). */
export const ANALYSIS_PANEL_PX = 320;
export const ANALYSIS_DOCK_INSET_PX = ANALYSIS_PANEL_PX + 24;

export interface AnalysisPanelProps {
    model: ModelAsset | null;
    snapshot: AnalysisSnapshot;
    /** "dock" = the floating panel on the desktop, "sheet" = the body of the phone's bottom sheet. */
    variant: "dock" | "sheet";
    /** Dock only: fold the panel away. */
    onCollapse?: () => void;
}

type DetailId = "checks" | "strength" | "log";

/**
 * Stability, in the order a reader needs it: the answer in one sentence, the four figures behind it, the one action, what to
 * fix, and then the details, each closed until asked for. The gear (settings) and the info (how it is computed) open pages inside
 * the panel; the downloads are behind the "..." button. The panel never switches versions: that is the top bar's switch.
 */
export function AnalysisPanel({ model, snapshot, variant, onCollapse }: AnalysisPanelProps) {
    const { phase, result, verdict, sentence, run, unavailable } = snapshot;
    const retry = useAnalysisStore((s) => s.retry);
    const settings = useAnalysisStore((s) => s.settings);
    const openRequest = useAnalysisStore((s) => s.openRequest);
    const updating = phase === "running" && result !== null;
    const [page, setPage] = useState<PanelPage>("report");
    const [openDetail, setOpenDetail] = useState<DetailId | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // A stabilizer run in hand for this model: while it holds blocks the answer below is how the model was before them, and the run
    // strip has the floor. A run that failed, or found nothing to add, leaves the report as true as it was: it keeps its list.
    const status = useStabilizeStore((s) => s.status);
    const runModelId = useStabilizeStore((s) => s.sourceModelId);
    const errorKind = useStabilizeStore((s) => s.errorKind);
    const outcome = useStabilizeStore((s) => (s.result ? outcomeOf(s.result) : null));
    const mine = model !== null && runModelId === model.id;
    const pending = mine && answerIsBeforeRun(status, errorKind, outcome);
    const stabilizing = mine && status === "running";
    const log = useStabilizerLog(model);
    // Unsaved changes made by words (store/voxelEdit.ts): while there are some, the headline is theirs and the problem list waits.
    const block = useBlockDraft(model);

    // A run that ends and waits for a decision (Save or Discard, Retry, Dismiss) puts the report in front: the strip is there, not
    // on the Settings or About page that may be open. Only the moment it starts to wait: the user can still go and look at a page.
    const decision = useStabilizeStore((s) => needsDecision(s.status, s.result ? outcomeOf(s.result) : null));
    const waitedBefore = useRef(decision);
    // The strip takes the keyboard on its own (useFocusOnEnd): closing the page this way does not give it back to the gear.
    const keepFocus = useRef(false);
    useEffect(() => {
        if (bringsReportForward(waitedBefore.current, decision, page)) {
            keepFocus.current = true;
            setPage("report");
        }
        waitedBefore.current = decision;
    }, [decision, page]);

    // Something outside asked to see the report (the bar's "Stabilize…", a chat card): leave the page that was open.
    const seenRequest = useRef(openRequest);
    useEffect(() => {
        if (openRequest === seenRequest.current) return;
        seenRequest.current = openRequest;
        setPage("report");
    }, [openRequest]);

    // A page opens at its top, and closing it puts the keyboard back on the button that opened it.
    const lastPage = useRef<PanelPage>("report");
    useEffect(() => {
        scrollRef.current?.scrollTo?.({ top: 0 });
        const stay = keepFocus.current;
        keepFocus.current = false;
        if (lastPage.current !== "report" && page === "report" && !stay) {
            const opener = lastPage.current === "settings" ? "analysis-settings-button" : "analysis-about-button";
            rootRef.current?.querySelector<HTMLElement>(`[data-testid="${opener}"]`)?.focus();
        }
        lastPage.current = page;
    }, [page]);

    const toggleDetail = (id: DetailId) => (open: boolean) => setOpenDetail(open ? id : null);

    let body;
    if (page === "settings") {
        body = <SettingsPage result={result} verdict={verdict} sentence={sentence} updating={phase === "running"} />;
    } else if (page === "about") {
        body = <AboutPage model={model} result={result} />;
    } else if (phase === "no-model") {
        body = <NoModelState />;
    } else if (phase === "unavailable") {
        body = <UnavailableState message={unavailable ?? "The model could not be displayed."} />;
    } else if (phase === "error") {
        body = <ErrorState message={run.error ?? "The check failed."} onRetry={retry} />;
    } else if (result && verdict) {
        const waiting = "after the run";
        const drafting = block.drafting && block.result !== null && block.verdict !== null;
        body = (
            <div className={cn("transition-opacity", updating && "opacity-60")} aria-busy={updating}>
                <VerdictBlock result={drafting && block.result ? block.result : result} verdict={drafting && block.verdict ? block.verdict : verdict} sentence={drafting ? block.sentence : sentence} before={pending} />
                {drafting ? (
                    <p className="-mt-2 px-4 pb-2 pl-14 text-[11px] text-muted-foreground" data-testid="analysis-draft-label">
                        With your changes, not saved yet
                    </p>
                ) : (
                    <KeyChips result={result} dimmed={pending} />
                )}
                <div data-testid="analysis-action">{model && !block.editing && <StabilizeCard model={model} result={result} verdict={verdict} analysing={updating} />}</div>
                {model && <EditBlocksCard model={model} result={result} />}
                {!pending && !drafting && <ProblemList result={result} />}
                <div data-testid="analysis-details" hidden={drafting}>
                    <DetailSection
                        id="checks"
                        title="All checks and numbers"
                        summary={stabilizing ? waiting : checksSummary(result)}
                        open={openDetail === "checks"}
                        onOpenChange={toggleDetail("checks")}
                        disabled={stabilizing}
                        testId="analysis-checks"
                    >
                        <ChecksDetails result={result} />
                    </DetailSection>
                    <DetailSection
                        id="strength"
                        title="Strength"
                        summary={stabilizing ? waiting : strengthSummary(result)}
                        open={openDetail === "strength"}
                        onOpenChange={toggleDetail("strength")}
                        disabled={stabilizing}
                        testId="analysis-stress"
                    >
                        <StrengthDetails result={result} onAbout={() => setPage("about")} />
                    </DetailSection>
                    {log && (
                        <DetailSection
                            id="log"
                            title={log.title}
                            summary={logSummary(log)}
                            open={openDetail === "log"}
                            onOpenChange={toggleDetail("log")}
                            testId="analysis-stabilization"
                        >
                            <StabilizerLog log={log} result={result} />
                        </DetailSection>
                    )}
                </div>
            </div>
        );
    } else if (phase === "running") {
        body = <RunningState run={run} />;
    } else {
        body = <LoadingState />;
    }

    return (
        <TooltipProvider delayDuration={400}>
            <div
                ref={rootRef}
                data-testid="analysis-panel"
                data-phase={phase}
                data-page={page}
                className={cn(
                    "flex h-full min-h-0 flex-col overflow-hidden",
                    variant === "dock" && "rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur",
                )}
            >
                <PanelHeader
                    page={page}
                    model={model}
                    result={result}
                    updating={updating}
                    customSettings={!sameSettings(settings, DEFAULT_ANALYSIS_SETTINGS)}
                    variant={variant}
                    onPage={setPage}
                    onCollapse={onCollapse}
                />
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="analysis-scroll">
                    {body}
                </div>
            </div>
        </TooltipProvider>
    );
}
