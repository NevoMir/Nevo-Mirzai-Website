import { useEffect, useRef } from "react";
import { PanelLeftOpen, Square } from "lucide-react";

import { ANALYSIS_PANEL_PX, AnalysisPanel } from "@/assignment/components/analysis/AnalysisPanel";
import { summaryChip, useRunBadge } from "@/assignment/components/analysis/summary";
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
import { needsDecision, outcomeOf } from "@/assignment/store/stabilizeLogic";

/** Stop, beside the pill while a run goes: the report with its own Stop button may be folded away or under a sheet. */
export function StopRun({ className }: { className?: string }) {
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
export function CustomDot({ note }: { note: string | null | undefined }) {
    if (!note) return null;
    return <span role="img" aria-label={`Custom settings: ${note}`} title={`Custom settings: ${note}`} className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />;
}

/**
 * Desktop: the stability panel as a floating panel under the top bar, or folded into a pill. It sits in the layer
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
                    aria-label={`Open the stability panel. ${chip.text}${chip.custom ? `. Custom settings: ${chip.custom}` : ""}`}
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

/** Phone: the full panel as a bottom sheet. It closes when a problem is shown, so the highlight is in view, and when a run starts. */
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
                <SheetTitle className="sr-only">Stability</SheetTitle>
                <SheetDescription className="sr-only">
                    Whether the design will stand, what to fix and where, and the settings of the check.
                </SheetDescription>
                <AnalysisPanel model={model} snapshot={snapshot} variant="sheet" />
            </SheetContent>
        </Sheet>
    );
}
