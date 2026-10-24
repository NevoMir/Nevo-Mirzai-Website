import { useEffect, useMemo, useRef } from "react";
import { Blocks, ChevronUp, Info, Loader2, PanelLeftOpen, Square, TriangleAlert, X, type LucideIcon } from "lucide-react";

import { ANALYSIS_PANEL_PX, AnalysisPanel } from "@/assignment/components/analysis/AnalysisPanel";
import { TONE, VERDICT_ICON, VERDICT_TONE, type ToneStyle } from "@/assignment/components/analysis/style";
import type { AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetTitle,
} from "@/assignment/components/ui/sheet";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { needsDecision, outcomeOf, runBadge, type RunBadge } from "@/assignment/store/stabilizeLogic";

/** What the one-line summary of the analysis says, with the symbol that goes with it. */
interface Chip {
    Icon: LucideIcon;
    text: string;
    tone: ToneStyle;
    spin: boolean;
    /** "limit 9, fill 60%" when the verdict is for other than the default settings. */
    custom?: string | null;
}

const RUN_ICON: Record<RunBadge["kind"], LucideIcon> = {
    running: Loader2,
    saving: Loader2,
    review: TriangleAlert,
    stopped: Square,
    nothing: Info,
    failed: TriangleAlert,
};
const RUN_TONE: Record<RunBadge["kind"], ToneStyle> = {
    running: TONE.muted,
    saving: TONE.muted,
    review: TONE.warn,
    stopped: TONE.warn,
    nothing: TONE.muted,
    failed: TONE.fail,
};

function summaryChip(snapshot: AnalysisSnapshot, run: RunBadge | null = null): Chip {
    const { phase, verdict } = snapshot;
    // A run in progress, or one that waits for a decision, is the news; the verdict is what it is changing.
    if (run) return { Icon: RUN_ICON[run.kind], text: run.text, tone: RUN_TONE[run.kind], spin: run.kind === "running" || run.kind === "saving" };
    if (phase === "running") return { Icon: Loader2, text: "Analysing…", tone: TONE.muted, spin: true };
    if (phase === "loading" && !verdict) return { Icon: Loader2, text: "Loading…", tone: TONE.muted, spin: true };
    if (phase === "unavailable") return { Icon: VERDICT_ICON.warn, text: "Model not shown", tone: TONE.warn, spin: false };
    if (phase === "error") return { Icon: VERDICT_ICON.fail, text: "Analysis failed", tone: TONE.fail, spin: false };
    if (verdict) {
        return { Icon: VERDICT_ICON[verdict.kind], text: verdict.short, tone: TONE[VERDICT_TONE[verdict.kind]], spin: false, custom: verdict.custom };
    }
    return { Icon: Blocks, text: "Structure check", tone: TONE.muted, spin: false };
}

/** The state of the Stabilize run for the pill, or null when there is no run to speak of (then the pill says the verdict). */
function useRunBadge(): RunBadge | null {
    const status = useStabilizeStore((s) => s.status);
    const steps = useStabilizeStore((s) => s.steps.length);
    const errorKind = useStabilizeStore((s) => s.errorKind);
    const outcome = useStabilizeStore((s) => (s.result ? outcomeOf(s.result) : null));
    return useMemo(() => runBadge({ status, steps, errorKind, outcome }), [status, steps, errorKind, outcome]);
}

/** Stop, beside the pill while a run goes: the report with its own Stop button may be folded away or under a sheet. */
function StopRun({ className }: { className?: string }) {
    const running = useStabilizeStore((s) => s.status === "running");
    const cancel = useStabilizeStore((s) => s.cancel);
    if (!running) return null;
    return (
        <button
            type="button"
            onClick={cancel}
            data-testid="analysis-stop"
            aria-label="Stop stabilizing and keep what was added so far"
            className={cn(
                "pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-2xl border border-border/70 bg-sidebar/95 px-2.5 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className,
            )}
        >
            <Square className="h-3 w-3" aria-hidden />
            Stop
        </button>
    );
}

/** A dot after the verdict: it was reached with settings other than the assignment's (the report says which). */
function CustomDot({ note }: { note: string | null | undefined }) {
    if (!note) return null;
    return <span role="img" aria-label={`Custom settings: ${note}`} title={`Custom settings: ${note}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />;
}

/**
 * Desktop: the report as a floating panel under the top bar, or folded into a pill. It sits in the layer
 * that lets pointer events through, so only the panel itself catches them.
 */
export function AnalysisDock({ model, snapshot }: { model: ModelAsset | null; snapshot: AnalysisSnapshot }) {
    const open = useAnalysisStore((s) => s.panelOpen);
    const setOpen = useAnalysisStore((s) => s.setPanelOpen);
    const chip = summaryChip(snapshot, useRunBadge());

    if (!open) {
        return (
            <div className="pointer-events-none flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    data-testid="analysis-pill"
                    aria-label={`Open the report panel. ${chip.text}${chip.custom ? `. Custom settings: ${chip.custom}` : ""}`}
                    className="pointer-events-auto flex h-[34px] items-center gap-2 rounded-2xl border border-border/70 bg-sidebar/95 px-3 text-xs font-medium shadow-lg backdrop-blur transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <chip.Icon className={cn("h-4 w-4", chip.tone.icon, chip.spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
                    <span className={chip.tone.text}>{chip.text}</span>
                    <CustomDot note={chip.custom} />
                    <PanelLeftOpen className="h-4 w-4 text-muted-foreground" aria-hidden />
                </button>
                <StopRun className="h-[34px]" />
            </div>
        );
    }
    return (
        <div className="pointer-events-auto h-full max-h-full" style={{ width: ANALYSIS_PANEL_PX }}>
            <AnalysisPanel model={model} snapshot={snapshot} variant="dock" onCollapse={() => setOpen(false)} />
        </div>
    );
}

/**
 * Phone: a pill under the top bar that opens the report sheet, plus the issue being shown (tap x to clear).
 * Its height is what the shell adds to the viewer's top inset.
 */
export const ANALYSIS_PEEK_PX = 40;

export function AnalysisPeek({ snapshot }: { snapshot: AnalysisSnapshot }) {
    const selection = useAnalysisStore((s) => s.selection);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const setSheetOpen = useAnalysisStore((s) => s.setSheetOpen);
    const chip = summaryChip(snapshot, useRunBadge());

    return (
        <div className="pointer-events-none flex items-center gap-2" style={{ height: ANALYSIS_PEEK_PX - 8 }}>
            <button
                type="button"
                onClick={() => setSheetOpen(true)}
                data-testid="analysis-peek"
                aria-label={`Open the report. ${chip.text}${chip.custom ? `. Custom settings: ${chip.custom}` : ""}`}
                className="pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-2xl border border-border/70 bg-sidebar/95 pl-2.5 pr-2 text-xs font-medium shadow-lg backdrop-blur focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <chip.Icon className={cn("h-4 w-4", chip.tone.icon, chip.spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
                <span className={chip.tone.text}>{chip.text}</span>
                <CustomDot note={chip.custom} />
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            </button>
            <StopRun />
            {selection && (
                <div className="pointer-events-auto flex h-8 min-w-0 items-center gap-1 rounded-2xl border border-primary/50 bg-sidebar/95 pl-2.5 pr-1 text-xs shadow-lg backdrop-blur">
                    <span className="min-w-0 truncate text-foreground" title={selection.label}>
                        {selection.label}
                    </span>
                    <button
                        type="button"
                        onClick={clearSelection}
                        aria-label="Clear the highlight"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
            )}
        </div>
    );
}

/** Phone: the report as a bottom sheet. It closes when an issue is shown, so the highlight is in view, and when a run starts. */
export function AnalysisSheet({ model, snapshot }: { model: ModelAsset | null; snapshot: AnalysisSnapshot }) {
    const open = useAnalysisStore((s) => s.sheetOpen);
    const setOpen = useAnalysisStore((s) => s.setSheetOpen);
    const selected = useAnalysisStore((s) => s.selection !== null);
    const serial = useAnalysisStore((s) => s.selectionSerial);

    // Only a pick made while the sheet is mounted closes it (opening the sheet over an older pick must not), and
    // only a pick: a re-run after a settings change keeps the selection but is not one, so the sheet stays open
    // for the next change.
    const seen = useRef(serial);
    useEffect(() => {
        if (selected && serial !== seen.current) setOpen(false);
        seen.current = serial;
    }, [selected, serial, setOpen]);

    // A run that ends with something to decide (Save or Discard, Retry) brings the sheet back: it was folded away so the
    // stage showed the run, and the pill alone is easy to miss with an unsaved preview on the stage.
    const waiting = useStabilizeStore((s) => needsDecision(s.status, s.result ? outcomeOf(s.result) : null));
    const wasWaiting = useRef(waiting);
    useEffect(() => {
        if (waiting && !wasWaiting.current) setOpen(true);
        wasWaiting.current = waiting;
    }, [waiting, setOpen]);

    return (
        <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
                side="bottom"
                className="h-[82dvh] max-h-[82dvh] gap-0 rounded-t-2xl border-border/70 bg-sidebar p-0 pb-[env(safe-area-inset-bottom)]"
            >
                <SheetTitle className="sr-only">Structure check</SheetTitle>
                <SheetDescription className="sr-only">
                    Whether the design stands, which constraints fail and where, and the settings of the analysis.
                </SheetDescription>
                <AnalysisPanel model={model} snapshot={snapshot} variant="sheet" />
            </SheetContent>
        </Sheet>
    );
}
