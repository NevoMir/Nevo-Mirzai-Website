import { useId, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, Download, Info, Loader2, RotateCcw, Square, TriangleAlert, X } from "lucide-react";

import { StabilizeTimeline } from "@/assignment/components/analysis/StabilizeTimeline";
import { TONE, type Tone } from "@/assignment/components/analysis/style";
import { useFocusOnEnd } from "@/assignment/components/analysis/useFocusOnEnd";
import { useThrottled } from "@/assignment/components/analysis/useThrottled";
import { useUnsavedGlb } from "@/assignment/components/analysis/useUnsavedGlb";
import { addedSoFar, runLine } from "@/assignment/components/analysis/panelLogic";
import { Button } from "@/assignment/components/ui/button";
import { openVersion } from "@/assignment/components/workspace/versionActions";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { plural } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import {
    clipText,
    nothingLine,
    outcomeOf,
    partialHeadline,
    progressLine,
    runChips,
    stepOffsetOf,
    stopReason,
    stressArrow,
} from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const pill = "rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground";
/** 44 px on a phone, 32 px beside a mouse. */
const small = "h-11 gap-1.5 px-3 text-xs md:h-8";
/** Outline and ghost buttons answer the pointer in grey: the brand orange is for the header icon and the added-blocks tag only. */
const quiet = "hover:bg-secondary hover:text-foreground";

// ---------- the steps, behind a disclosure ----------

/**
 * "Steps (3)", while the run goes: what the stabilizer has done so far, one row per accepted move, closed until asked for. It is a
 * box of its own that follows the newest step; a row shows its blocks on the stage. Once the run is over the steps are in the
 * details below ("What the stabilizer did"), not here twice.
 */
function StepsDisclosure() {
    const steps = useStabilizeStore((s) => s.steps);
    const selectStep = useStabilizeStore((s) => s.selectStep);
    const stepSelection = useAnalysisStore((s) => s.stepSelection);
    const source = useAnalysisStore((s) => s.result);
    const [open, setOpen] = useState(false);
    const id = useId();
    if (steps.length === 0) return null;
    // While a run is going or just over, the stage and the report are about the model it started from: that is where its steps are.
    const selected = stepSelection === null ? null : stepSelection - stepOffsetOf(source);
    return (
        <div className="mt-2">
            <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen((v) => !v)}
                data-testid="stabilize-steps-toggle"
                className="flex min-h-11 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-7"
            >
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden />
                Steps ({steps.length})
            </button>
            <div id={id} hidden={!open}>
                {open && <StabilizeTimeline className="mt-1.5" steps={steps} running selected={selected} onSelect={selectStep} />}
            </div>
        </div>
    );
}

// ---------- while it runs ----------

function Running({ model, compact }: { model: ModelAsset; compact: boolean }) {
    const pad = compact ? "px-4" : "px-4 pb-3";
    const steps = useStabilizeStore((s) => s.steps);
    const progress = useStabilizeStore((s) => s.progress);
    const start = useStabilizeStore((s) => s.startMetrics);
    const cancel = useStabilizeStore((s) => s.cancel);
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const sourcePrompt = useStabilizeStore((s) => s.sourcePrompt);
    // The line is what a screen reader hears: at most every 1.5 s (the numbers behind it change faster).
    const line = useThrottled(progressLine(progress, steps.length), 1500);
    const chips = start ? runChips(start, steps) : null;
    const other = sourceModelId !== model.id;
    return (
        <div className={pad} data-testid="stabilize-running">
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3 transition-shadow data-[flash=true]:ring-2 data-[flash=true]:ring-primary/60">
                <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
                    <p className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">Stabilizing</p>
                    <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={cancel} data-testid="stabilize-stop">
                        <Square />
                        Stop
                    </Button>
                </div>
                <p role="status" aria-live="polite" className="mt-1 text-xs text-muted-foreground" data-testid="stabilize-line">
                    {other ? `For “${clipText(sourcePrompt)}”.` : line}
                </p>
                {other && <GoToSource />}
                {chips && !other && (
                    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="stabilize-chips">
                        <span className={pill}>+{plural(chips.added, "block")}</span>
                        <span className={pill}>
                            problems {chips.problems[0]} → {chips.problems[1]}
                        </span>
                        {chips.stress[0] !== null && <span className={pill}>strength used {stressArrow(chips.stress[0], chips.stress[1])}</span>}
                    </div>
                )}
                {!other && !compact && <StepsDisclosure />}
            </div>
        </div>
    );
}

/** A run belongs to the model it started on: the one navigation left in the panel, between models (not versions). */
function GoToSource() {
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const sourceModel = useWorkspaceStore((s) => s.models.find((m) => m.id === sourceModelId));
    if (!sourceModel) return null;
    return (
        <Button type="button" size="sm" variant="ghost" className={cn(small, "-ml-2 mt-1 text-primary hover:bg-primary/10 hover:text-primary")} onClick={() => openVersion(sourceModel)} data-testid="stabilize-open-source">
            <ArrowRight />
            Go to that model
        </Button>
    );
}

// ---------- when it is over ----------

function Strip({
    tone,
    icon: Icon,
    title,
    children,
    actions,
    onDismiss,
    testId,
    spin = false,
    endedAt = null,
}: {
    tone: Tone;
    icon: typeof Info;
    title: string;
    children?: ReactNode;
    actions?: ReactNode;
    onDismiss?: () => void;
    testId: string;
    spin?: boolean;
    /** When the run ended: a strip that appears right after it takes the keyboard focus, so the user lands on the result. */
    endedAt?: number | null;
}) {
    const t = TONE[tone];
    const ref = useFocusOnEnd<HTMLDivElement>(endedAt);
    return (
        <div ref={ref} tabIndex={-1} className={cn("rounded-xl border p-3 transition-shadow focus:outline-none data-[flash=true]:ring-2 data-[flash=true]:ring-primary/60", t.soft, t.border)} data-testid={testId} role="status">
            <div className="flex items-start gap-2.5">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", t.icon, spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className={cn("text-[13px] font-semibold leading-snug", t.text)}>{title}</p>
                    {children && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{children}</div>}
                </div>
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="-m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:-m-0.5 md:h-6 md:w-6"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                )}
            </div>
            {actions && <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>}
        </div>
    );
}

/**
 * The end of a run, in the action's place: saving, waiting for a decision (partial, stopped), nothing to add, or failed. A run
 * belongs to the model it started on, and the strip stays until it is dismissed whichever model is on screen by then: for another
 * model it says whose run it is, offers to go there, and leaves the steps out (they are blocks of that model).
 */
function Ended({ model, compact }: { model: ModelAsset; compact: boolean }) {
    const pad = compact ? "px-4" : "px-4 pb-3";
    const status = useStabilizeStore((s) => s.status);
    const result = useStabilizeStore((s) => s.result);
    const steps = useStabilizeStore((s) => s.steps);
    const moves = useStabilizeStore((s) => s.moves);
    const error = useStabilizeStore((s) => s.error);
    const errorKind = useStabilizeStore((s) => s.errorKind);
    const options = useStabilizeStore((s) => s.options);
    const savedModelId = useStabilizeStore((s) => s.savedModelId);
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const sourcePrompt = useStabilizeStore((s) => s.sourcePrompt);
    const endedAt = useStabilizeStore((s) => s.endedAt);
    const save = useStabilizeStore((s) => s.save);
    const discard = useStabilizeStore((s) => s.discard);
    const glb = useUnsavedGlb();

    const other = sourceModelId !== null && sourceModelId !== model.id && savedModelId !== model.id;
    const lead = other ? <>For “{clipText(sourcePrompt)}”. </> : null;
    const openSource = other ? <GoToSource /> : null;
    const discardButton = (label = "Discard") => (
        <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={discard} data-testid="stabilize-discard">
            {label}
        </Button>
    );
    const downloadButton = (label: string, testId: string, variant: "ghost" | "outline" = "outline") => (
        <Button type="button" size="sm" variant={variant} className={cn(small, quiet)} onClick={glb?.download} disabled={!glb} data-testid={testId}>
            <Download />
            {label}
        </Button>
    );

    if (status === "saving") {
        // The file stays in reach while it uploads: a connection that stalls ends in Retry, but this needs no server.
        return (
            <div className={pad}>
                <Strip key="saving" tone="info" icon={Loader2} spin title="Saving the stabilized version…" testId="stabilize-saving" actions={downloadButton("Download GLB", "stabilize-download", "ghost")}>
                    {lead}
                </Strip>
            </div>
        );
    }

    if (status === "error") {
        const saving = errorKind === "save";
        return (
            <div className={pad}>
                <Strip
                    key="error"
                    endedAt={endedAt}
                    tone="fail"
                    icon={TriangleAlert}
                    title={saving ? "Could not save to the project" : "Stabilizing failed"}
                    testId="stabilize-error"
                    actions={
                        saving ? (
                            <>
                                <Button type="button" size="sm" className={small} onClick={() => void save()} data-testid="stabilize-retry">
                                    <RotateCcw />
                                    Retry
                                </Button>
                                {downloadButton("Download GLB anyway", "stabilize-download-anyway")}
                                {discardButton()}
                            </>
                        ) : (
                            discardButton("Dismiss")
                        )
                    }
                >
                    {lead}
                    {error}
                </Strip>
                {openSource}
            </div>
        );
    }

    if (status === "canceled") {
        return (
            <div className={pad}>
                <Strip
                    key="canceled"
                    endedAt={endedAt}
                    tone="muted"
                    icon={Square}
                    title={`Stopped after ${plural(steps.length, "step")} · +${plural(addedSoFar(moves), "block")}`}
                    testId="stabilize-canceled"
                    actions={
                        <>
                            <Button type="button" size="sm" className={small} onClick={() => void save()} data-testid="stabilize-save">
                                Save partial
                            </Button>
                            {discardButton()}
                        </>
                    }
                >
                    {lead}
                    {other ? "Nothing is saved yet." : "Nothing is saved yet. The blocks added so far are shown in the viewer."}
                </Strip>
                {openSource}
            </div>
        );
    }

    // finished
    if (!result) return null;
    const target = options?.targetUtilisation ?? result.meta.target_utilisation;
    const outcome = outcomeOf(result);
    if (outcome === "complete") {
        // It reached its goal and is being saved this instant: the same strip as the save itself, not a flash of "not fully stable".
        return (
            <div className={pad}>
                <Strip key="saving" tone="info" icon={Loader2} spin title="Saving the stabilized version…" testId="stabilize-saving" actions={downloadButton("Download GLB", "stabilize-download", "ghost")}>
                    {lead}
                </Strip>
            </div>
        );
    }
    if (outcome === "nothing") {
        return (
            <div className={pad}>
                <Strip key="nothing" endedAt={endedAt} tone="info" icon={Info} title="Nothing to add" testId="stabilize-nothing" onDismiss={discard}>
                    {lead}
                    {nothingLine(result, options)}
                </Strip>
                {openSource}
            </div>
        );
    }
    return (
        <div className={pad}>
            <Strip
                key="partial"
                endedAt={endedAt}
                tone="warn"
                icon={TriangleAlert}
                title={partialHeadline(result.after, target, result.meta.cantilever_limit)}
                testId="stabilize-partial"
                actions={
                    <>
                        <Button type="button" size="sm" className={small} onClick={() => void save()} data-testid="stabilize-save">
                            Save as new version
                        </Button>
                        {discardButton()}
                    </>
                }
            >
                {lead}
                {runLine(result.meta)}. {stopReason(result.stop)}
            </Strip>
            {openSource}
        </div>
    );
}

/**
 * Where the Stabilize button was, while a run has something to say: the live run with its figures and steps, then the end of it.
 * A saved run is not here: its result is the stabilized version itself, which the action shows as a row of its own.
 */
export function RunStrip({ model, compact = false }: { model: ModelAsset; compact?: boolean }) {
    const status = useStabilizeStore((s) => s.status);
    if (status === "running") return <Running model={model} compact={compact} />;
    if (status === "idle" || status === "saved") return null;
    return <Ended model={model} compact={compact} />;
}
