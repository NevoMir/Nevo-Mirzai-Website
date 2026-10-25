import { useId, useState } from "react";
import { ArrowLeftRight, Blocks, Check, Download, PencilLine, RotateCcw, Sparkles, Square, TriangleAlert, Undo2 } from "lucide-react";

import { ElapsedTime } from "@/assignment/components/chat/ElapsedTime";
import { RegenerateDialog } from "@/assignment/components/chat/RegenerateDialog";
import { StabilityLine } from "@/assignment/components/chat/StabilityLine";
import { Button } from "@/assignment/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { modelFileName } from "@/assignment/components/workspace/format";
import { GenerationProgressBar } from "@/assignment/components/workspace/GenerationProgressBar";
import { Markdown } from "@/assignment/components/chat/Markdown";
import { cn } from "@/assignment/lib/utils";
import type { EditChanges, Job, ModelAsset } from "@/assignment/shared/contract";
import { openAnalysisFor } from "@/assignment/store/analysis";
import { applyStoredPlan, downloadLocalResult, restoreEditWords, retrySave, stopEdit, undoEdit, useEditStore } from "@/assignment/store/edit";
import { cardStateOf, errorTitle, familyOf, generationProviderFor, offersRegenerate, offersTryAgain, regeneratePrompt, splitTechnical, undoBlockedText, verdictWorse, type CardState } from "@/assignment/store/editLogic";
import { requestAccessCode } from "@/assignment/store/access";
import { sendPrompt } from "@/assignment/store/generation";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const chip = "rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground";
const small = "h-7 gap-1.5 px-2.5 text-xs";

/** "Added a cup holder · Changed the back · Removed ..." from the part names of a design edit. */
function ChangeList({ changes }: { changes: EditChanges }) {
    const rows: Array<[string, string[]]> = [
        ["Added", changes.added],
        ["Changed", changes.changed],
        ["Removed", changes.removed],
    ];
    const shown = rows.filter(([, names]) => names.length > 0);
    if (shown.length === 0) return null;
    return (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="edit-changes">
            {shown.map(([label, names]) => (
                <li key={label} className="[overflow-wrap:anywhere]">
                    <span className="font-medium text-foreground">{label}:</span> {names.slice(0, 12).join(", ")}
                    {names.length > 12 ? ` and ${names.length - 12} more` : ""}
                </li>
            ))}
        </ul>
    );
}

function Notes({ notes }: { notes: readonly string[] }) {
    if (notes.length === 0) return null;
    return (
        <ul className="mt-1.5 list-disc pl-4 text-[11px] leading-snug text-muted-foreground" data-testid="edit-notes">
            {notes.map((n) => (
                <li key={n} className="[overflow-wrap:anywhere]">
                    {n}
                </li>
            ))}
        </ul>
    );
}

/** A failure's text: the plain sentence, with the file-format words (if the message has some) in a tooltip behind a small mark. */
function FailureText({ message }: { message: string }) {
    const { plain, detail } = splitTechnical(message);
    if (!detail) return <>{plain}</>;
    return (
        <TooltipProvider delayDuration={300}>
            {plain}{" "}
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className="rounded-sm border-b border-dotted border-current text-[11px] leading-none" data-testid="edit-technical" aria-label={`Technical detail: ${detail}`}>
                        Why?
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-64 text-xs">Technical detail: {detail}</TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}

interface BodyProps {
    state: CardState;
    jobId: string | null;
    runKey: string | null;
    instruction: string;
    target: "design" | "mesh";
    source: ModelAsset | null;
    regenPrompt: string;
    active: boolean;
    /** How many versions were made from the edited version (0 = Undo is safe). */
    later?: number;
}

function Body({ state, jobId, runKey, instruction, target, source, regenPrompt, active, later = 0 }: BodyProps) {
    const [regenerate, setRegenerate] = useState(false);
    const [busy, setBusy] = useState(false);
    const undoOffId = useId();
    const setActive = useWorkspaceStore((s) => s.setActiveModel);
    const id = jobId ?? runKey;
    const regenerateButton =
        target === "mesh" ? (
            <Button type="button" size="sm" variant="outline" className={small} onClick={() => setRegenerate(true)} data-testid="edit-regenerate">
                <Sparkles />
                Generate it again with Hunyuan (25 credits)
            </Button>
        ) : null;

    switch (state.kind) {
        case "working":
            return (
                <div className="mt-2" data-testid="edit-working">
                    <span className="text-[13px] font-medium text-shimmer" data-testid="edit-stage">
                        {state.words}
                    </span>
                    {state.startedAt !== null && <ElapsedTime startedAt={state.startedAt} className="ml-2 font-mono text-[11px] tabular-nums text-muted-foreground" />}
                    <GenerationProgressBar active stageCount={state.stageIndex} className="mt-2 w-full" />
                    {state.canStop && id && (
                        <Button type="button" size="sm" variant="outline" className={cn(small, "mt-2")} onClick={() => void stopEdit(id)} data-testid="edit-stop">
                            <Square />
                            Stop
                        </Button>
                    )}
                </div>
            );
        case "done": {
            const { model } = state;
            const worse = verdictWorse(state.source ?? undefined, model);
            return (
                <div className="mt-2" data-testid="edit-done">
                    <p className="flex items-start gap-1.5 text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                        <span>{state.summary || "Edited the model."}</span>
                    </p>
                    {model.edit?.changes && <ChangeList changes={model.edit.changes} />}
                    <Notes notes={state.notes} />
                    <div className="mt-2.5">
                        <StabilityLine model={model} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={small}
                            disabled={busy || later > 0}
                            aria-describedby={later > 0 ? undoOffId : undefined}
                            onClick={() => {
                                setBusy(true);
                                void undoEdit(model).finally(() => setBusy(false));
                            }}
                            data-testid="edit-undo"
                        >
                            <Undo2 />
                            Undo
                        </Button>
                        {state.source && (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className={small}
                                aria-pressed={active}
                                onClick={() => setActive(active ? (state.source as ModelAsset).id : model.id)}
                                data-testid="edit-compare"
                            >
                                <ArrowLeftRight />
                                {active ? "Show the version before" : "Show the edit"}
                            </Button>
                        )}
                        <Button asChild size="sm" variant="outline" className={small}>
                            <a href={model.glb_url} download={modelFileName(model)}>
                                <Download />
                                Download GLB
                            </a>
                        </Button>
                        {worse && (
                            <Button type="button" size="sm" variant="outline" className={small} onClick={() => openAnalysisFor(model.id)} data-testid="edit-stabilize">
                                <Blocks />
                                Stabilize…
                            </Button>
                        )}
                        {regenerateButton}
                    </div>
                    {later > 0 && (
                        <p id={undoOffId} className="mt-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="edit-undo-off">
                            {undoBlockedText(later)}
                        </p>
                    )}
                    <RegenerateDialog open={regenerate} onOpenChange={setRegenerate} initialPrompt={regenPrompt} />
                </div>
            );
        }
        case "undone":
            return (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="edit-undone">
                    Undone. The model is back as it was.
                </p>
            );
        case "gone":
            return (
                <p className="mt-2 text-xs text-muted-foreground" data-testid="edit-gone">
                    Version deleted.
                </p>
            );
        case "canceled":
            return <p className="mt-2 text-xs text-muted-foreground">Stopped.</p>;
        case "noop":
            return (
                <div className="mt-2" data-testid="edit-noop">
                    <Markdown className="text-[13px] text-foreground">{state.summary || "This could not be done."}</Markdown>
                    <Notes notes={state.notes} />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={small}
                            onClick={() => {
                                if (target === "mesh") setRegenerate(true);
                                else void sendPrompt({ prompt: instruction, providers: [generationProviderFor(source)], requestAccessCode });
                            }}
                            data-testid="edit-generate-new"
                        >
                            <Sparkles />
                            Generate it as a new model
                        </Button>
                    </div>
                    <RegenerateDialog open={regenerate} onOpenChange={setRegenerate} initialPrompt={regenPrompt} />
                </div>
            );
        case "plan-ready":
            return (
                <div className="mt-2" data-testid="edit-plan-ready">
                    <p className="text-[13px] leading-snug text-foreground [overflow-wrap:anywhere]">The edit is planned but was not applied yet: {state.summary}</p>
                    <Notes notes={state.notes} />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button type="button" size="sm" className={small} disabled={busy || !jobId} onClick={() => jobId && void applyStoredPlan(jobId)} data-testid="edit-apply">
                            <Check />
                            Apply it
                        </Button>
                    </div>
                </div>
            );
        case "error":
            return (
                <div className="mt-2 flex flex-col items-start gap-2" data-testid="edit-error" data-kind={state.errorKind}>
                    <p className="flex items-start gap-1.5 text-xs text-destructive [overflow-wrap:anywhere]">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span>
                            <span className="font-semibold">{errorTitle(state.errorKind, jobId !== null)}.</span> <FailureText message={state.message} />
                        </span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                        {state.errorKind === "save" && id && (
                            <>
                                <Button type="button" size="sm" variant="outline" className={small} onClick={() => void retrySave(id)} data-testid="edit-retry-save">
                                    <RotateCcw />
                                    Try saving again
                                </Button>
                                {state.hasLocalResult && (
                                    <Button type="button" size="sm" variant="outline" className={small} onClick={() => downloadLocalResult(id, "edited-model.glb")} data-testid="edit-download-local">
                                        <Download />
                                        Download GLB
                                    </Button>
                                )}
                            </>
                        )}
                        {state.errorKind === "apply" && jobId && (
                            <Button type="button" size="sm" variant="outline" className={small} onClick={() => void applyStoredPlan(jobId)} data-testid="edit-apply-again">
                                <RotateCcw />
                                Try again
                            </Button>
                        )}
                        {offersTryAgain(state.errorKind) && instruction && (
                            <Button type="button" size="sm" variant="outline" className={small} onClick={() => restoreEditWords(instruction, source?.id ?? null)} data-testid="edit-try-again">
                                <RotateCcw />
                                Try again
                            </Button>
                        )}
                        {offersRegenerate(state.errorKind) && regenerateButton}
                    </div>
                    <RegenerateDialog open={regenerate} onOpenChange={setRegenerate} initialPrompt={regenPrompt} />
                </div>
            );
    }
}

function Header({ target, instruction }: { target: "design" | "mesh"; instruction: string }) {
    return (
        <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <PencilLine className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <span className="text-xs font-semibold text-foreground">Edit</span>
                <span className={chip}>Muse Spark</span>
                <span className={chip}>{target === "design" ? "Changes the parts" : "Adjusts the model"}</span>
            </div>
            {instruction && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]" title={instruction} data-testid="edit-instruction">
                    “{instruction}”
                </p>
            )}
        </>
    );
}

/**
 * One edit in the chat (a design edit or a mesh edit), from the job the assistant's message points at. While it works: the stage in words,
 * the time, Stop. Done: what changed, and Undo / Compare / Download (a mesh edit also offers to generate the model again with Hunyuan, after a
 * confirm that says what it costs). It also covers what did not work: the model's explanation, "I couldn't find the <part>", a save to retry,
 * and a mesh plan that was never applied ("Plan ready, apply?").
 */
export function EditCard({ job }: { job: Job }) {
    const run = useEditStore((s) => s.runs[job.id]);
    const undone = useEditStore((s) => s.undone);
    const models = useWorkspaceStore((s) => s.models);
    const activeModelId = useWorkspaceStore((s) => s.activeModelId);
    const target = job.edit?.target ?? "design";
    const state = cardStateOf({ job, run, models, undone });
    const source = models.find((m) => m.id === job.edit?.source_model_id) ?? null;
    const instruction = run?.instruction ?? job.prompt;
    const regenPrompt = run?.regenPrompt ?? regeneratePrompt(source ?? { prompt: "" }, instruction, job.edit?.result ?? null);
    const editedId = state.kind === "done" ? state.model.id : null;
    const later = editedId === null ? 0 : familyOf(models, editedId).length - 1;
    return (
        <div data-testid="edit-card" data-state={state.kind} data-target={target} data-status={job.status} className="rounded-xl border border-border/70 bg-background/60 p-3">
            <Header target={target} instruction={instruction} />
            <Body state={state} jobId={job.id} runKey={run?.key ?? null} instruction={instruction} target={target} source={source} regenPrompt={regenPrompt} active={editedId !== null && editedId === activeModelId} later={later} />
        </div>
    );
}

/**
 * The mesh edits of the open project that have no job yet (the page is still looking at the model and making the pictures, a few seconds).
 * Mounted once under the chat's messages; each shows its stage and Stop.
 */
export function PendingEditCards({ projectId }: { projectId: string | null }) {
    const runs = useEditStore((s) => s.runs);
    const models = useWorkspaceStore((s) => s.models);
    const undone = useEditStore((s) => s.undone);
    // A failure before the job existed (the model's file could not be read, its format cannot be edited) has no job to carry the card, and the
    // card is where "generate it again" and "try again" are offered; it stays until the next edit starts or the project is left.
    const pending = Object.values(runs).filter((r) => r.jobId === null && r.projectId === projectId);
    if (pending.length === 0) return null;
    return (
        <>
            {pending.map((run) => {
                const state = cardStateOf({ job: null, run, models, undone });
                const source = models.find((m) => m.id === run.sourceModelId) ?? null;
                return (
                    <div key={run.key} data-testid="edit-card" data-state={state.kind} data-target={run.target} className="rounded-xl border border-border/70 bg-background/60 p-3">
                        <Header target={run.target} instruction={run.instruction} />
                        <Body
                            state={state}
                            jobId={null}
                            runKey={run.key}
                            instruction={run.instruction}
                            target={run.target}
                            source={source}
                            regenPrompt={run.regenPrompt ?? regeneratePrompt(source ?? { prompt: "" }, run.instruction, null)}
                            active={false}
                        />
                    </div>
                );
            })}
        </>
    );
}
