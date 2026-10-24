import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    ArrowRight,
    ChevronDown,
    CircleCheck,
    Download,
    FileJson,
    GitCompareArrows,
    Info,
    Loader2,
    RotateCcw,
    SlidersHorizontal,
    Square,
    TriangleAlert,
    WandSparkles,
    X,
} from "lucide-react";

import { NumberField } from "@/assignment/components/analysis/SettingsSection";
import { StabilizeTimeline } from "@/assignment/components/analysis/StabilizeTimeline";
import { TONE, type Tone } from "@/assignment/components/analysis/style";
import { downloadBytes } from "@/assignment/components/analysis/download";
import { downloadReport } from "@/assignment/components/analysis/reportDownload";
import { useThrottled } from "@/assignment/components/analysis/useThrottled";
import type { AnalysisResult } from "@/assignment/analysis/types";
import { Button } from "@/assignment/components/ui/button";
import { Slider } from "@/assignment/components/ui/slider";
import { toast } from "@/assignment/components/ui/sonner";
import { modelFileName } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { plural, type Verdict } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import {
    TARGET_RANGE,
    clipText,
    nothingLine,
    outcomeOf,
    partialHeadline,
    progressLine,
    runChips,
    savedStepOffset,
    stabilizeOffer,
    stabilizedFileName,
    stabilizedLine,
    stepOffsetOf,
    stopReason,
    stressArrow,
} from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const pill = "rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground";

// ---------- the offer ----------

/**
 * Target stress and block budget, behind the Options button: closed until asked for. Inline rather than a floating popover:
 * the card also lives in the phone's report sheet, where a popover portalled to the page would sit outside the sheet's
 * focus trap and could not be typed into.
 */
function OptionsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    return (
        <Button
            type="button"
            variant="outline"
            size="icon"
            className={cn("h-8 w-8 shrink-0", open && "bg-secondary")}
            aria-label="Stabilize options"
            aria-expanded={open}
            aria-controls="stabilize-options-panel"
            title="Options: target stress and block budget"
            onClick={onToggle}
            data-testid="stabilize-options"
        >
            <SlidersHorizontal />
        </Button>
    );
}

function OptionsPanel() {
    const choices = useStabilizeStore((s) => s.choices);
    const setChoices = useStabilizeStore((s) => s.setChoices);
    const targetPct = Math.round(choices.target * 100);
    return (
        <div id="stabilize-options-panel" className="mt-3 space-y-4 rounded-lg bg-muted/60 p-3" data-testid="stabilize-options-panel">
            <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                    <label htmlFor="stabilize-target" className="text-xs font-medium text-foreground">
                        Target stress
                    </label>
                    <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{targetPct}%</span>
                </div>
                <Slider
                    id="stabilize-target"
                    min={Math.round(TARGET_RANGE.min * 100)}
                    max={Math.round(TARGET_RANGE.max * 100)}
                    step={Math.round(TARGET_RANGE.step * 100)}
                    value={[targetPct]}
                    onValueChange={([value]) => setChoices({ target: value / 100 })}
                    aria-valuetext={`${targetPct} percent of the allowable stress`}
                />
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                    It adds blocks until no joint carries more than this share of what it allows. Lower asks for more blocks; the report
                    warns from {Math.round(TARGET_RANGE.max * 100)}%, so that is the highest target.
                </p>
            </div>
            <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                    <label htmlFor="stabilize-budget" className="text-xs font-medium text-foreground">
                        Block budget
                    </label>
                    <p className="text-[11px] leading-snug text-muted-foreground">The most blocks the stabilized version may have, in all.</p>
                </div>
                <NumberField
                    id="stabilize-budget"
                    value={choices.maxBlocks}
                    min={1}
                    max={1000}
                    nullable
                    placeholder="No limit"
                    onCommit={(value) => setChoices({ maxBlocks: value })}
                />
            </div>
        </div>
    );
}

function openModel(id: string): void {
    useWorkspaceStore.getState().setActiveModel(id);
}

/** "Fix it automatically": what the stabilizer does, and the button that runs it. */
function OfferCard({ model, result, verdict, analysing }: { model: ModelAsset; result: AnalysisResult; verdict: Verdict; analysing: boolean }) {
    const models = useWorkspaceStore((s) => s.models);
    const start = useStabilizeStore((s) => s.start);
    const [optionsOpen, setOptionsOpen] = useState(false);
    const offer = stabilizeOffer({ model, models, result, verdict, analysing });
    if (!offer) return null;
    const { child, blocked } = offer;
    // A stabilized version exists (an opened example comes with one): the card then announces it instead of offering the fix.
    const childMeta = child ? (models.find((m) => m.id === child.id)?.derived ?? null) : null;
    const run = () => {
        if (!start(model, result)) toast.error("Could not start", { description: "Another run is going, or the model has no blocks." });
    };
    const compare = () => {
        if (!child) return;
        useAnalysisStore.getState().requestCompare(child.id, "overlay");
        openModel(child.id);
    };
    return (
        <div className="px-4 pb-3" data-testid="stabilize-card">
            <div className="rounded-xl border border-border/70 bg-card p-3">
                <div className="flex items-start gap-2.5">
                    <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                        <WandSparkles className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold leading-tight text-foreground">{child ? "Stabilized version ready" : "Fix it automatically"}</p>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {child ? (
                                <>
                                    {childMeta ? `${stabilizedLine(childMeta)}. ` : ""}Open it, or compare the two with the added blocks coloured by what they are for.
                                    Your blocks are never removed or moved.
                                </>
                            ) : (
                                "Adds supports where the analysis found problems: columns, footings, brackets, bridges and thicker joints. Your blocks are never removed or moved, and the original model is kept."
                            )}
                        </p>
                    </div>
                </div>
                {blocked ? (
                    <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="stabilize-blocked">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        {blocked}
                    </p>
                ) : (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        {child ? (
                            <Button type="button" size="sm" className="h-8 flex-1 gap-1.5 px-3 text-xs" onClick={() => openModel(child.id)} data-testid="stabilize-open">
                                <ArrowRight />
                                Open stabilized version
                            </Button>
                        ) : (
                            <Button type="button" size="sm" className="h-8 flex-1 gap-1.5 px-3 text-xs" onClick={run} data-testid="stabilize-start">
                                <WandSparkles />
                                {offer.label}
                            </Button>
                        )}
                        {child && (
                            <>
                                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3 text-xs" onClick={compare} data-testid="stabilize-compare-ready">
                                    <GitCompareArrows />
                                    Compare
                                </Button>
                                <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 px-3 text-xs" onClick={run} data-testid="stabilize-again">
                                    <RotateCcw />
                                    Run again
                                </Button>
                            </>
                        )}
                        <OptionsToggle open={optionsOpen} onToggle={() => setOptionsOpen((v) => !v)} />
                    </div>
                )}
                {optionsOpen && !blocked && <OptionsPanel />}
                <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">
                    The stabilized version is built from 100 mm blocks like this view; your mesh is untouched.
                </p>
            </div>
        </div>
    );
}

// ---------- while it runs ----------

function RunningBlock({ model }: { model: ModelAsset }) {
    const steps = useStabilizeStore((s) => s.steps);
    const progress = useStabilizeStore((s) => s.progress);
    const start = useStabilizeStore((s) => s.startMetrics);
    const cancel = useStabilizeStore((s) => s.cancel);
    const selectStep = useStabilizeStore((s) => s.selectStep);
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const sourcePrompt = useStabilizeStore((s) => s.sourcePrompt);
    const stepSelection = useAnalysisStore((s) => s.stepSelection);
    const source = useAnalysisStore((s) => s.result);
    // The line is what a screen reader hears: at most every 1.5 s (the numbers behind it change faster).
    const line = useThrottled(progressLine(progress, steps.length), 1500);
    const chips = start ? runChips(start, steps) : null;
    const other = sourceModelId !== model.id;
    const offset = stepOffsetOf(source);
    const selected = stepSelection === null ? null : stepSelection - offset;
    return (
        <div className="px-4 pb-3" data-testid="stabilize-running">
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3">
                <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
                    <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs font-medium text-foreground" data-testid="stabilize-line">
                        {other ? `Stabilizing “${sourcePrompt}”…` : line}
                    </p>
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" onClick={cancel} data-testid="stabilize-stop">
                        <Square className="h-3 w-3" />
                        Stop
                    </Button>
                </div>
                {chips && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="stabilize-chips">
                        <span className={pill}>+{plural(chips.added, "block")}</span>
                        <span className={pill}>
                            problems {chips.problems[0]} → {chips.problems[1]}
                        </span>
                        {chips.stress[0] !== null && <span className={pill}>peak stress {stressArrow(chips.stress[0], chips.stress[1])}</span>}
                    </div>
                )}
                {!other && steps.length > 0 && (
                    <StabilizeTimeline className="mt-3" steps={steps} running selected={selected} onSelect={selectStep} />
                )}
            </div>
        </div>
    );
}

// ---------- when it is over ----------

function Banner({
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
    /** When the run ended: a banner that appears right after it takes the keyboard focus, so the user lands on the result. */
    endedAt?: number | null;
}) {
    const t = TONE[tone];
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node || endedAt === null || Date.now() - endedAt >= 2000) return;
        // Only when the button that was pressed is gone and focus fell to the page or a container around the card (the
        // phone's sheet): someone who went on to type in the composer or another field keeps their place.
        const active = document.activeElement;
        if (!active || active === document.body || active.contains(node)) node.focus();
    }, [endedAt]);
    return (
        <div ref={ref} tabIndex={-1} className={cn("rounded-xl border p-3 focus:outline-none", t.soft, t.border)} data-testid={testId} role="status">
            <div className="flex items-start gap-2.5">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", t.icon, spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className={cn("text-xs font-semibold leading-snug", t.text)}>{title}</p>
                    {children && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{children}</div>}
                </div>
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                )}
            </div>
            {actions && <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>}
        </div>
    );
}

const actionButton = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * The end of a run: saved, waiting for a decision (partial, stopped), saving, or failed. A run belongs to the model it
 * started on, and the banner stays until it is dismissed whichever model is on screen by then: for another model it says
 * whose run it is, offers to go back there, and leaves the timeline out (its steps are blocks of that model).
 */
function OutcomeBanner({ model, result: current }: { model: ModelAsset; result: AnalysisResult }) {
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
    const selectStep = useStabilizeStore((s) => s.selectStep);
    const stepSelection = useAnalysisStore((s) => s.stepSelection);
    const source = useAnalysisStore((s) => s.result);
    const resultModelId = useAnalysisStore((s) => s.resultModelId);
    const models = useWorkspaceStore((s) => s.models);
    const activeModelId = useWorkspaceStore((s) => s.activeModelId);
    const [exporting, setExporting] = useState(false);
    const [showSteps, setShowSteps] = useState(false);

    const other = sourceModelId !== null && sourceModelId !== model.id && savedModelId !== model.id;
    const sourceModel = models.find((m) => m.id === sourceModelId);
    const sourceName = sourceModel ? modelFileName(sourceModel) : modelFileName({ prompt: sourcePrompt, provider: "stabilizer" });
    const downloadGlb = () => {
        if (result) downloadBytes(stabilizedFileName(sourceName), "model/gltf-binary", result.glb);
    };
    const lead = other ? <>For “{clipText(sourcePrompt)}”. </> : null;
    const openSource =
        other && sourceModel ? (
            <Button type="button" size="sm" variant="outline" className={actionButton} onClick={() => openModel(sourceModel.id)} data-testid="stabilize-open-source">
                <ArrowRight />
                Open that model
            </Button>
        ) : null;
    // While a run is going or just over, the stage and the report are about the model it started from: that is where its steps are.
    const offset = stepOffsetOf(source);
    const selected = stepSelection === null ? null : stepSelection - offset;
    const timeline = !other && steps.length > 0 && <StabilizeTimeline className="mt-3" steps={steps} running={false} selected={selected} onSelect={selectStep} />;
    const buttons = {
        discard: (
            <Button type="button" size="sm" variant="ghost" className={actionButton} onClick={discard} data-testid="stabilize-discard">
                Discard
            </Button>
        ),
        download: (
            <Button type="button" size="sm" variant="outline" className={actionButton} onClick={downloadGlb} disabled={!result} data-testid="stabilize-download">
                <Download />
                Download GLB
            </Button>
        ),
    };

    if (status === "saving") {
        return (
            <div className="px-4 pb-3">
                {/* The file stays in reach while it uploads: a connection that stalls ends in Retry, but this needs no server. */}
                <Banner key="saving" tone="info" icon={Loader2} spin title="Saving the stabilized version…" testId="stabilize-saving" actions={buttons.download}>
                    {lead}
                </Banner>
            </div>
        );
    }

    if (status === "saved" && result) {
        // The version was deleted since (the Models tab): there is nothing for the banner to open.
        const saved = models.find((m) => m.id === savedModelId);
        if (!saved) return null;
        const complete = result.complete;
        // Green only when the report has nothing left to say: the stabilizer's goal leaves a warning of its own kind possible.
        const clean = complete && result.after.errors === 0 && result.after.warnings === 0;
        const isActive = activeModelId === savedModelId;
        // The log of the version on screen, behind a button: the live list is gone from the card, and its place in the
        // report is further down.
        const logReady = !other && steps.length > 0 && resultModelId === savedModelId;
        const logSelected = stepSelection === null ? null : stepSelection - savedStepOffset(source, steps.length);
        return (
            <div className="px-4 pb-3">
                <Banner
                    key="saved"
                    endedAt={endedAt}
                    tone={clean ? "pass" : "warn"}
                    icon={clean ? CircleCheck : TriangleAlert}
                    title={complete ? `Stabilized: ${stabilizedLine(result.meta)}` : `Saved an improved version: ${stabilizedLine(result.meta)}`}
                    testId="stabilize-saved"
                    onDismiss={discard}
                    actions={
                        <>
                            {!isActive && (
                                <Button type="button" size="sm" className={actionButton} onClick={() => openModel(saved.id)} data-testid="stabilize-open-saved">
                                    <ArrowRight />
                                    Open
                                </Button>
                            )}
                            {buttons.download}
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className={actionButton}
                                disabled={!isActive || exporting}
                                title={isActive ? undefined : "Open the version to export its report"}
                                onClick={() => {
                                    setExporting(true);
                                    downloadReport("json", current, saved)
                                        .catch(() => toast.error("Could not create the file"))
                                        .finally(() => setExporting(false));
                                }}
                                data-testid="stabilize-report"
                            >
                                <FileJson />
                                Report (JSON)
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className={actionButton}
                                onClick={() => {
                                    useAnalysisStore.getState().requestCompare(saved.id, "overlay");
                                    if (!isActive) openModel(saved.id);
                                }}
                                data-testid="stabilize-compare"
                            >
                                <GitCompareArrows />
                                Compare
                            </Button>
                            {logReady && (
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className={actionButton}
                                    aria-expanded={showSteps}
                                    aria-controls="stabilize-saved-steps"
                                    onClick={() => setShowSteps((v) => !v)}
                                    data-testid="stabilize-steps-toggle"
                                >
                                    <ChevronDown className={cn("transition-transform", !showSteps && "-rotate-90")} />
                                    {showSteps ? "Hide" : "View"} {plural(steps.length, "step")}
                                </Button>
                            )}
                            {openSource}
                        </>
                    }
                >
                    {lead}
                </Banner>
                {logReady && showSteps && (
                    <div id="stabilize-saved-steps">
                        <StabilizeTimeline className="mt-3" steps={steps} running={false} selected={logSelected} onSelect={selectStep} />
                    </div>
                )}
            </div>
        );
    }

    if (status === "error") {
        const saving = errorKind === "save";
        return (
            <div className="px-4 pb-3">
                <Banner
                    key="error"
                    endedAt={endedAt}
                    tone="fail"
                    icon={TriangleAlert}
                    title={saving ? "Could not save to the project" : "Stabilizing failed"}
                    testId="stabilize-error"
                    actions={
                        saving ? (
                            <>
                                <Button type="button" size="sm" className={actionButton} onClick={() => void save()} data-testid="stabilize-retry">
                                    <RotateCcw />
                                    Retry
                                </Button>
                                <Button type="button" size="sm" variant="outline" className={actionButton} onClick={downloadGlb} disabled={!result} data-testid="stabilize-download-anyway">
                                    <Download />
                                    Download GLB anyway
                                </Button>
                                {buttons.discard}
                                {openSource}
                            </>
                        ) : (
                            <>
                                {buttons.discard}
                                {openSource}
                            </>
                        )
                    }
                >
                    {lead}
                    {error}
                </Banner>
                {saving && timeline}
            </div>
        );
    }

    if (status === "canceled") {
        const added = moves.reduce((sum, m) => sum + m.cells.length, 0);
        return (
            <div className="px-4 pb-3">
                <Banner
                    key="canceled"
                    endedAt={endedAt}
                    tone="muted"
                    icon={Square}
                    title={`Stopped after ${plural(steps.length, "step")}: +${plural(added, "block")} so far`}
                    testId="stabilize-canceled"
                    actions={
                        <>
                            <Button type="button" size="sm" className={actionButton} onClick={() => void save()} data-testid="stabilize-save">
                                Save partial
                            </Button>
                            {buttons.discard}
                            {openSource}
                        </>
                    }
                >
                    {lead}
                    {other ? "Nothing is saved yet." : "Nothing is saved yet. The blocks added so far are shown in the viewer."}
                </Banner>
                {timeline}
            </div>
        );
    }

    // finished
    if (!result) return null;
    const target = options?.targetUtilisation ?? result.meta.target_utilisation;
    const outcome = outcomeOf(result);
    if (outcome === "complete") {
        // It reached its goal and is being saved this instant: the same banner as the save itself, not a flash of "not fully stable".
        return (
            <div className="px-4 pb-3">
                <Banner key="saving" tone="info" icon={Loader2} spin title="Saving the stabilized version…" testId="stabilize-saving" actions={buttons.download}>
                    {lead}
                </Banner>
            </div>
        );
    }
    if (outcome === "nothing") {
        return (
            <div className="px-4 pb-3">
                <Banner
                    key="nothing"
                    endedAt={endedAt}
                    tone="info"
                    icon={Info}
                    title="Nothing to add"
                    testId="stabilize-nothing"
                    onDismiss={discard}
                    actions={openSource}
                >
                    {lead}
                    {nothingLine(result, options)}
                </Banner>
            </div>
        );
    }
    return (
        <div className="px-4 pb-3">
            <Banner
                key="partial"
                endedAt={endedAt}
                tone="warn"
                icon={TriangleAlert}
                title={partialHeadline(result.after, target, result.meta.cantilever_limit)}
                testId="stabilize-partial"
                actions={
                    <>
                        <Button type="button" size="sm" className={actionButton} onClick={() => void save()} data-testid="stabilize-save">
                            Save as new version
                        </Button>
                        {buttons.discard}
                        {openSource}
                    </>
                }
            >
                {lead}
                {stabilizedLine(result.meta)}. {stopReason(result.stop)}
            </Banner>
            {timeline}
        </div>
    );
}

// ---------- the card ----------

/**
 * Between the verdict and the constraints: the offer to stabilize the model, and what follows (the live run with its
 * timeline, then the outcome). Shown when something is wrong with the model or a joint is highly stressed; the outcome of a
 * run stays until it is dismissed, whichever model is on screen by then.
 */
export function StabilizeCard({ model, result, verdict, analysing }: { model: ModelAsset; result: AnalysisResult; verdict: Verdict; analysing: boolean }) {
    const status = useStabilizeStore((s) => s.status);
    if (status === "running") return <RunningBlock model={model} />;
    if (status !== "idle") {
        return (
            <>
                <OutcomeBanner model={model} result={result} />
                {status === "saved" && <OfferCard model={model} result={result} verdict={verdict} analysing={analysing} />}
            </>
        );
    }
    return <OfferCard model={model} result={result} verdict={verdict} analysing={analysing} />;
}
