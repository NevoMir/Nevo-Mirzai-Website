import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Blocks, Download, Info, Loader2, Pencil, Play, RotateCcw, Sparkles, SlidersHorizontal, Square, TriangleAlert } from "lucide-react";

import { Segmented, MarkGlyph, type SegmentedOption } from "@/assignment/components/analysis/atoms";
import { downloadBytes } from "@/assignment/components/analysis/download";
import { TERMS } from "@/assignment/components/analysis/vocabulary";
import { GoalField } from "@/assignment/components/optimize/GoalField";
import { ResultCard } from "@/assignment/components/optimize/ResultCard";
import { RunStrip } from "@/assignment/components/optimize/RunStrip";
import { SpecControls } from "@/assignment/components/optimize/SpecControls";
import { StatusStrip } from "@/assignment/components/optimize/Strips";
import { useOptimizeView, type OptimizeView } from "@/assignment/components/optimize/useOptimizeView";
import { Button } from "@/assignment/components/ui/button";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import { TooltipProvider } from "@/assignment/components/ui/tooltip";
import { modelFileName, modelTitle } from "@/assignment/components/workspace/format";
import { useMobileLayout } from "@/assignment/hooks/use-mobile";
import { cn } from "@/assignment/lib/utils";
import { versionTitle } from "@/assignment/shared/versionTree";
import { useOptimizeStore } from "@/assignment/store/optimize";
import { EFFORTS, STOP_WORDS, kgPerBlock, nowLine, plural, todayRows, type Effort } from "@/assignment/store/optimizeLogic";
import { useVoxelEditStore } from "@/assignment/store/voxelEdit";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { materialOf } from "@/assignment/analysis/materials";
import type { ModelAsset } from "@/assignment/shared/contract";

const small = "h-11 gap-1.5 px-3 text-xs md:h-8";
const quiet = "hover:bg-secondary hover:text-foreground";
const iconButton = "h-11 w-11 text-muted-foreground hover:bg-secondary hover:text-foreground md:h-7 md:w-7";

const EFFORT_OPTIONS: ReadonlyArray<SegmentedOption<Effort>> = (Object.keys(EFFORTS) as Effort[]).map((e) => ({ value: e, label: `${EFFORTS[e].label} ${EFFORTS[e].about}` }));

// ---------- the states before there is a plan ----------

function Waiting({ text }: { text: string }) {
    return (
        <div className="px-4 py-5" role="status" data-testid="optimize-waiting">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                {text}
            </p>
            <div className="mt-3 space-y-2" aria-hidden>
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-11 w-full rounded-xl" />
            </div>
        </div>
    );
}

function Empty({ icon: Icon = Blocks, title, children }: { icon?: typeof Blocks; title: string; children: string }) {
    return (
        <div className="px-4 py-6" data-testid="optimize-empty">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
                <Icon className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            </div>
            <p className="mt-3 text-center text-sm font-semibold text-foreground">{title}</p>
            <p className="mx-auto mt-1 max-w-[17rem] text-center text-xs leading-relaxed text-muted-foreground">{children}</p>
        </div>
    );
}

/** The model on screen cannot be the start of a run: why, and what to do about it. */
function Blocked({ view }: { view: OptimizeView }) {
    const e = view.eligibility;
    const toStability = () => useWorkspaceStore.getState().setWorkspaceTab("analysis");
    switch (e.kind) {
        case "none":
            return <Empty title="No model to optimize yet">Make a model, or open one, and its blocks can be made lighter or stronger here.</Empty>;
        case "waiting":
            return <Waiting text="Reading the model…" />;
        case "unavailable":
            return <Empty title="The 3D view cannot show this model">{e.message}</Empty>;
        case "empty":
            return <Empty title="There are no blocks to work on">This model made no blocks, so there is nothing to make lighter or stronger.</Empty>;
        case "errors":
            return (
                <div className="px-4 pb-4" data-testid="optimize-blocked-errors">
                    <StatusStrip
                        tone="warn"
                        icon={TriangleAlert}
                        title="Fix the problems first"
                        testId="optimize-blocked"
                        actions={
                            <Button type="button" size="sm" className={small} onClick={toStability} data-testid="optimize-go-stability">
                                <ArrowRight />
                                Go to Stability
                            </Button>
                        }
                    >
                        Optimization starts from a structure that stands. The Stability tab can fix what is wrong first.
                    </StatusStrip>
                </div>
            );
        case "draft":
            return (
                <div className="px-4 pb-4" data-testid="optimize-blocked-draft">
                    <StatusStrip
                        tone="warn"
                        icon={TriangleAlert}
                        title="Save your changes first"
                        testId="optimize-blocked"
                        actions={
                            <Button type="button" size="sm" className={small} onClick={() => void useVoxelEditStore.getState().save()} data-testid="optimize-save-draft">
                                Save version
                            </Button>
                        }
                    >
                        Optimization starts from a saved version, and you have changes to the blocks that are not saved.
                    </StatusStrip>
                </div>
            );
        case "limit":
            return (
                <div className="px-4 pb-4" data-testid="optimize-blocked-limit">
                    <StatusStrip tone="muted" icon={Info} title="No room for another version" testId="optimize-blocked">
                        {e.message}
                    </StatusStrip>
                </div>
            );
        case "ok":
            return null;
    }
}

// ---------- the idle panel ----------

/** What a saved optimized version is, with a way to see on the stage what it took out and put in (read from the log inside its file). */
function VersionNote({ model }: { model: ModelAsset }) {
    const on = useOptimizeStore((s) => s.changesOf === model.id);
    const note = useOptimizeStore((s) => s.changesNote);
    const toggle = useOptimizeStore((s) => s.toggleChanges);
    const summary = model.optimization;
    if (model.kind !== "optimized" || !summary) return null;
    const { before, after } = summary;
    return (
        <div className="px-4 pb-3" data-testid="optimize-version-note">
            <div className="rounded-xl border border-border/70 bg-card p-3">
                <p className="text-xs leading-snug text-foreground">
                    Made by optimizing for <span className="font-medium">“{summary.goal}”</span>: {before.blocks} → {plural(after.blocks, "block")}, {before.weight_kg} → {after.weight_kg} kg.
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{STOP_WORDS[summary.stop]}</p>
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet, "mt-2")} aria-pressed={on} onClick={() => void toggle(model)} data-testid="optimize-show-changes">
                    {on ? "Hide what changed" : "Show what changed"}
                </Button>
                {note && (
                    <p role="status" className="mt-1.5 text-xs text-amber-800 dark:text-amber-300">
                        {note}
                    </p>
                )}
            </div>
        </div>
    );
}

function Idle({ view }: { view: OptimizeView }) {
    const goalText = useOptimizeStore((s) => s.goalText);
    const setGoalText = useOptimizeStore((s) => s.setGoalText);
    const preparing = useOptimizeStore((s) => s.preparing);
    const notice = useOptimizeStore((s) => s.notice);
    const planGoal = useOptimizeStore((s) => s.planGoal);
    const chooseChip = useOptimizeStore((s) => s.chooseChip);
    const assist = useWorkspaceStore((s) => s.providers?.assist);
    const { model, snapshot } = view;
    if (view.eligibility.kind !== "ok" || !model || !snapshot.result) {
        return (
            <>
                {model && <VersionNote model={model} />}
                <Blocked view={view} />
            </>
        );
    }
    const result = snapshot.result;
    const museOff = assist !== undefined && assist.available === false;
    return (
        <div data-testid="optimize-idle">
            <VersionNote model={model} />
            <p className="px-4 pb-2.5 text-xs text-muted-foreground" data-testid="optimize-now">
                Now <span className="ml-1 font-medium tabular-nums text-foreground">{nowLine(result, kgPerBlock(materialOf(result.settings.material)))}</span>
            </p>
            <GoalField
                text={goalText}
                onText={setGoalText}
                onPlan={() => void planGoal(model, result)}
                onChip={(chip) => void chooseChip(model, result, chip)}
                museOff={museOff}
                busy={preparing}
                notice={notice}
            />
        </div>
    );
}

function Planning() {
    const goal = useOptimizeStore((s) => s.goalText);
    const cancel = useOptimizeStore((s) => s.cancel);
    return (
        <div className="px-4 pb-3" data-testid="optimize-planning">
            <StatusStrip
                tone="info"
                icon={Loader2}
                spin
                title="Reading your goal…"
                testId="optimize-planning-strip"
                actions={
                    <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={cancel} data-testid="optimize-stop-plan">
                        <Square />
                        Stop
                    </Button>
                }
            >
                Muse is turning “{goal}” into limits you can check. About 10 seconds.
            </StatusStrip>
        </div>
    );
}

// ---------- a plan to check ----------

function PlanReady({ view }: { view: OptimizeView }) {
    const spec = useOptimizeStore((s) => s.spec);
    const effective = useOptimizeStore((s) => s.effective);
    const brief = useOptimizeStore((s) => s.brief);
    const start = useOptimizeStore((s) => s.startMetrics);
    const warnings = useOptimizeStore((s) => s.warnings);
    const goal = useOptimizeStore((s) => s.goalLabel);
    const chip = useOptimizeStore((s) => s.chip);
    const changes = useOptimizeStore((s) => s.planChanges);
    const effort = useOptimizeStore((s) => s.effort);
    const notice = useOptimizeStore((s) => s.notice);
    const edit = useOptimizeStore((s) => s.editSpec);
    const peek = useOptimizeStore((s) => s.peekProtection);
    const reset = useOptimizeStore((s) => s.resetSpec);
    const setEffort = useOptimizeStore((s) => s.setEffort);
    const run = useOptimizeStore((s) => s.run);
    const discard = useOptimizeStore((s) => s.discard);
    // The button that was pressed to get here (a goal, "Try again") is gone: the keyboard lands on the plan instead of falling to the page.
    const top = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active.contains(top.current)) top.current?.focus({ preventScroll: true });
    }, []);
    if (!spec || !effective || !brief || !start) return <Waiting text="Reading the model…" />;
    const notes = [...spec.notes, ...changes];
    const rows = todayRows(start, effective);
    const nothing = !spec.actionable;
    return (
        <div ref={top} tabIndex={-1} className="focus:outline-none" data-testid="optimize-plan" data-actionable={spec.actionable}>
            <div className="px-4 pb-3">
                <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-foreground [overflow-wrap:anywhere]" data-testid="optimize-goal-quote">
                        “{goal}”
                    </p>
                    <button
                        type="button"
                        onClick={discard}
                        aria-label="Change the goal"
                        title="Change the goal"
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-7 md:w-7"
                        data-testid="optimize-edit-goal"
                    >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
                <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-muted-foreground" data-testid="optimize-summary">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    <span>{spec.summary}</span>
                </p>
                {notes.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-plan-notes">
                        {notes.map((note) => (
                            <li key={note} className="flex items-start gap-1.5">
                                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span>{note}</span>
                            </li>
                        ))}
                    </ul>
                )}
                {nothing && (
                    <p className="mt-2 rounded-lg border border-warning/45 bg-warning/10 p-2.5 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-not-actionable">
                        This goal is not about weight, strength, balance or sag, so there is nothing to run yet. Pick one of the four goals or change a control below.
                    </p>
                )}
            </div>

            <SpecControls spec={spec} effective={effective} brief={brief} startBlocks={start.blocks} edit={edit} onPeek={peek} />

            <div className="px-4 pb-3" data-testid="optimize-today">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Today</p>
                <ul className="space-y-0.5">
                    {rows.map((row) => (
                        <li key={row.key} className="flex items-center gap-1.5 text-xs" data-row={row.key} data-ok={row.ok}>
                            <MarkGlyph mark={row.ok ? "pass" : "warn"} className="h-3.5 w-3.5" label={row.ok ? "within the limit" : "outside the limit"} />
                            <span className="text-foreground">{row.label}</span>
                            <span className="ml-auto tabular-nums text-muted-foreground">{row.text}</span>
                        </li>
                    ))}
                </ul>
                {warnings.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-warnings">
                        {warnings.map((w) => (
                            <li key={w} className="flex items-start gap-1.5">
                                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                <span>{w}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="px-4 pb-4">
                <Segmented label="Effort" value={effort} options={EFFORT_OPTIONS} onChange={setEffort} />
                {notice && (
                    <p role="status" className="mt-2 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-notice">
                        {notice}
                    </p>
                )}
                <Button type="button" className="mt-2.5 h-11 w-full gap-1.5 text-sm md:h-10" onClick={run} disabled={nothing} data-testid="optimize-run">
                    <Play />
                    Optimize
                </Button>
                <div className="mt-1.5 flex items-center">
                    <Button type="button" variant="ghost" size="sm" className="h-11 gap-1 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 hover:text-primary md:h-8" onClick={reset} data-testid="optimize-reset">
                        <RotateCcw />
                        {chip ? "Reset the limits" : "Reset to Muse's suggestion"}
                    </Button>
                </div>
            </div>
            <span hidden data-view-model={view.model?.id ?? ""} />
        </div>
    );
}

// ---------- the end of a run, saved or not ----------

function SavedCard({ view }: { view: OptimizeView }) {
    const savedId = useOptimizeStore((s) => s.savedModelId);
    const endedAt = useOptimizeStore((s) => s.endedAt);
    const tryAgain = useOptimizeStore((s) => s.tryAgain);
    const saved = useWorkspaceStore((s) => s.models.find((m) => m.id === savedId));
    const here = view.model?.id === savedId;
    const summary = saved?.optimization;
    return (
        <div className="px-4 pb-3" data-testid="optimize-saved">
            <StatusStrip
                tone="pass"
                icon={Sparkles}
                title={here ? "This is the optimized version" : "Saved as a new version"}
                testId="optimize-saved-strip"
                endedAt={endedAt}
                actions={
                    <>
                        {!here && saved && (
                            <Button type="button" size="sm" className={small} onClick={() => useWorkspaceStore.getState().setActiveModel(saved.id)} data-testid="optimize-open-saved">
                                <ArrowRight />
                                Open it
                            </Button>
                        )}
                        <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={tryAgain} data-testid="optimize-again">
                            Optimize again…
                        </Button>
                    </>
                }
            >
                {summary ? `“${summary.title}”: ${summary.before.blocks} → ${plural(summary.after.blocks, "block")}, ${summary.before.weight_kg} → ${summary.after.weight_kg} kg.` : "It is in the Models tab."}
            </StatusStrip>
        </div>
    );
}

function Saving() {
    const wire = useOptimizeStore((s) => s.result);
    const modelId = useOptimizeStore((s) => s.modelId);
    const source = useWorkspaceStore((s) => s.models.find((m) => m.id === modelId));
    return (
        <div className="px-4 pb-3">
            <StatusStrip
                tone="info"
                icon={Loader2}
                spin
                title="Saving the optimized version…"
                testId="optimize-saving"
                actions={
                    wire && (
                        <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={() => downloadBytes(modelFileName({ prompt: source?.prompt ?? "model", provider: "optimizer", kind: "optimized" }), "model/gltf-binary", wire.glb)}>
                            <Download />
                            Download GLB
                        </Button>
                    )
                }
            />
        </div>
    );
}

function Failed() {
    const kind = useOptimizeStore((s) => s.errorKind);
    const error = useOptimizeStore((s) => s.error);
    const endedAt = useOptimizeStore((s) => s.endedAt);
    const wire = useOptimizeStore((s) => s.result);
    const modelId = useOptimizeStore((s) => s.modelId);
    const keep = useOptimizeStore((s) => s.keep);
    const discard = useOptimizeStore((s) => s.discard);
    const tryAgain = useOptimizeStore((s) => s.tryAgain);
    const source = useWorkspaceStore((s) => s.models.find((m) => m.id === modelId));
    const saving = kind === "save";
    return (
        <div className="px-4 pb-3">
            <StatusStrip
                tone="fail"
                icon={TriangleAlert}
                title={saving ? "Could not save to the project" : "The optimization failed"}
                testId="optimize-error"
                endedAt={endedAt}
                actions={
                    saving ? (
                        <>
                            <Button type="button" size="sm" className={small} onClick={() => void keep()} data-testid="optimize-retry">
                                <RotateCcw />
                                Retry
                            </Button>
                            {wire && (
                                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={() => downloadBytes(modelFileName({ prompt: source?.prompt ?? "model", provider: "optimizer", kind: "optimized" }), "model/gltf-binary", wire.glb)}>
                                    <Download />
                                    Download GLB anyway
                                </Button>
                            )}
                            <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={discard}>
                                Discard
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button type="button" size="sm" className={small} onClick={tryAgain} data-testid="optimize-retry">
                                <RotateCcw />
                                Back to the limits
                            </Button>
                            <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={discard}>
                                Dismiss
                            </Button>
                        </>
                    )
                }
            >
                {error}
            </StatusStrip>
        </div>
    );
}

/** A run, a result or an upload that belongs to another version than the one on screen. */
function Elsewhere() {
    const phase = useOptimizeStore((s) => s.phase);
    const modelId = useOptimizeStore((s) => s.modelId);
    const goal = useOptimizeStore((s) => s.goalLabel);
    const models = useWorkspaceStore((s) => s.models);
    const source = models.find((m) => m.id === modelId);
    const words = phase === "running" ? "Optimizing another version" : phase === "result" ? "A result is waiting on another version" : phase === "saving" ? "Saving another version" : "Something went wrong on another version";
    return (
        <div className="px-4 pb-3" data-testid="optimize-elsewhere">
            <StatusStrip
                tone="info"
                icon={phase === "running" || phase === "saving" ? Loader2 : Info}
                spin={phase === "running" || phase === "saving"}
                title={words}
                testId="optimize-elsewhere-strip"
                actions={
                    source && (
                        <Button type="button" size="sm" className={small} onClick={() => useWorkspaceStore.getState().setActiveModel(source.id)} data-testid="optimize-go-source">
                            <ArrowRight />
                            Go to that version
                        </Button>
                    )
                }
            >
                {goal ? `For “${goal}”${source ? ` on ${modelTitle(source)}` : ""}.` : null}
            </StatusStrip>
        </div>
    );
}

// ---------- how it works ----------

function AboutPage() {
    return (
        <div className="space-y-3 px-4 py-3 text-xs leading-relaxed text-muted-foreground" data-testid="optimize-about">
            <section>
                <h3 className="text-[13px] font-semibold text-foreground">What it does</h3>
                <p className="mt-1">
                    You say what you want: lighter, stronger, better balanced or stiffer. It takes blocks out of the model, or puts a few in, one round at a time, and after every round it checks that the
                    model still stands: balance, overhangs, floating parts and strength used.
                </p>
                <p className="mt-1">Words you type are read by Muse, which fills in the limits for you to check and change. The four buttons need no waiting.</p>
            </section>
            <section>
                <h3 className="text-[13px] font-semibold text-foreground">Nothing is saved until you say so</h3>
                <p className="mt-1">The result is a preview on the stage. Keep this version saves it as a new version next to the others, and you can go back to any of them.</p>
            </section>
            <section>
                <h3 className="text-[13px] font-semibold text-foreground">Words used here</h3>
                <dl className="mt-1 space-y-1.5">
                    {[TERMS.strengthUsed, TERMS.balance, TERMS.longestOverhang].map((term) => (
                        <div key={term.label}>
                            <dt className="font-medium text-foreground">{term.label}</dt>
                            <dd>{term.tip}</dd>
                        </div>
                    ))}
                </dl>
            </section>
            <section>
                <h3 className="text-[13px] font-semibold text-foreground">How far to trust it</h3>
                <p className="mt-1">
                    An estimate, not a certificate. It counts the model's own weight only, with joints that never open; there is no buckling, sliding or wind. Thin models such as a chair or a lamp have little
                    hidden inside, so Lightest may find nothing: allow any block to be taken out to thin them.
                </p>
            </section>
        </div>
    );
}

// ---------- the panel ----------

/**
 * The Optimization tab: say what the model should do better (in words, or with one of four buttons), check the limits it will keep to, watch it
 * work block by block, and keep the result as a new version or throw it away. It belongs under the tab's dock on a desktop (the shell gives it
 * its width) and at the foot of the stage on a phone (the shell gives it the frame); it reads the version on screen and the Stability tab's
 * analysis of it, and does nothing until a button is pressed.
 */
export default function OptimizePanel() {
    const mobile = useMobileLayout();
    const view = useOptimizeView();
    const phase = useOptimizeStore((s) => s.phase);
    const runModelId = useOptimizeStore((s) => s.modelId);
    const savedId = useOptimizeStore((s) => s.savedModelId);
    const models = useWorkspaceStore((s) => s.models);
    const [page, setPage] = useState<"main" | "about">("main");
    const { model } = view;
    const mine = model !== null && runModelId === model.id;
    const subtitle = model ? versionTitle(models, model) : null;

    let body;
    if (page === "about") body = <AboutPage />;
    else if ((phase === "running" || phase === "result" || phase === "saving" || phase === "error") && !mine) body = <Elsewhere />;
    else if (phase === "running") body = <RunStrip />;
    else if (phase === "result") body = <ResultCard />;
    else if (phase === "saving") body = <Saving />;
    else if (phase === "error") body = <Failed />;
    else if (phase === "saved" && (mine || model?.id === savedId)) body = <SavedCard view={view} />;
    else if (phase === "planning" && mine) body = <Planning />;
    else if (phase === "ready" && mine) body = <PlanReady view={view} />;
    else body = <Idle view={view} />;

    return (
        <TooltipProvider delayDuration={400}>
            <div
                data-testid="optimize-panel"
                data-phase={phase}
                data-eligibility={view.eligibility.kind}
                className={cn("flex min-h-0 flex-col", !mobile && "h-full overflow-hidden rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur")}
            >
                <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border/60 py-1 pl-4 pr-1.5" data-testid="optimize-header">
                    {page === "about" ? (
                        <>
                            <Button type="button" variant="ghost" size="icon" className={iconButton} onClick={() => setPage("main")} aria-label="Back to Optimization" title="Back" data-testid="optimize-back" autoFocus>
                                <ArrowLeft />
                            </Button>
                            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight text-foreground">How it works</h2>
                        </>
                    ) : (
                        <>
                            <SlidersHorizontal className="mr-1 h-4 w-4 shrink-0 text-accent" aria-hidden />
                            <div className="min-w-0 flex-1">
                                <h2 className="text-sm font-semibold leading-tight text-foreground">Optimization</h2>
                                {model && (
                                    <p className="truncate text-[11px] leading-tight text-muted-foreground" title={model.prompt} data-testid="optimize-subtitle">
                                        {subtitle ?? modelTitle(model)}
                                    </p>
                                )}
                            </div>
                            <Button type="button" variant="ghost" size="icon" className={iconButton} onClick={() => setPage("about")} aria-label="How does this work?" title="How does this work?" data-testid="optimize-about-button">
                                <Info />
                            </Button>
                        </>
                    )}
                </header>
                <div className={cn(!mobile && "min-h-0 flex-1 overflow-y-auto overscroll-contain", "pt-3")} data-testid="optimize-scroll">
                    {body}
                </div>
            </div>
        </TooltipProvider>
    );
}
