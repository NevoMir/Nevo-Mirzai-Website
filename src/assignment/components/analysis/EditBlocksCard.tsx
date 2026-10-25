import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight, CornerDownLeft, Info, Loader2, PencilLine, Redo2, Square, TriangleAlert, Undo2, X } from "lucide-react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { MarkGlyph } from "@/assignment/components/analysis/atoms";
import { panelFigures } from "@/assignment/components/analysis/panelLogic";
import { MARK_WORD, TONE, type Tone } from "@/assignment/components/analysis/style";
import { useFocusOnEnd } from "@/assignment/components/analysis/useFocusOnEnd";
import { ElapsedTime } from "@/assignment/components/chat/ElapsedTime";
import { Button } from "@/assignment/components/ui/button";
import { Checkbox } from "@/assignment/components/ui/checkbox";
import { Input } from "@/assignment/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { cn } from "@/assignment/lib/utils";
import { EDIT_INSTRUCTION_MAX, type ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { plural } from "@/assignment/store/analysisLogic";
import { submitEdit } from "@/assignment/store/editRouter";
import { useVoxelEditStore, type DraftView, type Notice, type Proposal } from "@/assignment/store/voxelEdit";
import { countsLine, draftLine, EDIT_CHIPS, EDIT_PLACEHOLDER, type ChangeTone } from "@/assignment/store/voxelEditLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { useCurrentWork } from "@/assignment/store/workGuard";

/** 44 px on a phone, 32 px beside a mouse. */
const small = "h-11 gap-1.5 px-3 text-xs md:h-8";
const quiet = "hover:bg-secondary hover:text-foreground";

const CHANGE_TONE: Record<ChangeTone, Tone> = { same: "muted", better: "pass", worse: "warn" };

/** The tooltip over the title: what the field does, with the name of the AI that does it. */
const FIELD_TIP = "Say what to change in your own words. Muse Spark turns it into block changes that you can check before you keep them.";

// ---------- pieces ----------

/** The verdict change of a proposal or a draft: a mark and a sentence, and the problems it caused or fixed. */
function ChangeLine({ text, tone, broke, fixed, testId }: { text: string; tone: ChangeTone; broke: string[]; fixed: string[]; testId: string }) {
    const t = TONE[CHANGE_TONE[tone]];
    const mark = tone === "worse" ? "warn" : tone === "better" ? "pass" : "none";
    return (
        <div data-testid={testId} data-tone={tone}>
            <p className={cn("flex items-center gap-1.5 text-xs font-medium", t.text)}>
                <MarkGlyph mark={mark} label={tone === "worse" ? "Gets worse" : tone === "better" ? "Gets better" : MARK_WORD.none} className="h-3.5 w-3.5" />
                {text}
            </p>
            {broke.length > 0 && <p className="mt-0.5 pl-5 text-[11px] leading-snug text-muted-foreground">New: {broke.join("; ")}.</p>}
            {fixed.length > 0 && <p className="mt-0.5 pl-5 text-[11px] leading-snug text-muted-foreground">Fixed: {fixed.join("; ")}.</p>}
        </div>
    );
}

/** The four figures of the draft (the same ones as the chips above the problem list), as plain readings. */
function DraftFigures({ result }: { result: AnalysisResult }) {
    const figures = panelFigures(result);
    return (
        <ul className="grid grid-cols-2 gap-1.5" data-testid="blockedit-figures">
            {figures.map((f) => (
                <li key={f.key} className="min-w-0 rounded-lg border border-border/70 bg-card px-2 py-1" data-figure={f.key} data-mark={f.mark}>
                    <span className="flex items-center justify-between gap-1">
                        <span className="text-[10px] font-medium text-muted-foreground">{f.label}</span>
                        <MarkGlyph mark={f.mark} label={MARK_WORD[f.mark]} className="h-3 w-3" />
                    </span>
                    <span className="block text-[13px] font-semibold leading-tight tabular-nums">
                        {f.value}
                        {f.unit && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{f.unit}</span>}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** The proposal: what the editor wants to do, what it does to the verdict, and the two ways out. */
function ProposalBox({ proposal }: { proposal: Proposal }) {
    const apply = useVoxelEditStore((s) => s.apply);
    const discard = useVoxelEditStore((s) => s.discardProposal);
    // The proposal takes the keyboard when it appears (the field it came from is gone), once.
    const [shownAt] = useState(() => Date.now());
    const ref = useFocusOnEnd<HTMLDivElement>(shownAt);
    const tone = proposal.large ? TONE.warn : TONE.info;
    return (
        <div ref={ref} tabIndex={-1} className={cn("rounded-xl border p-3 focus:outline-none", tone.soft, tone.border)} data-testid="blockedit-proposal" role="group" aria-label="Proposed change">
            <p className="text-[13px] font-semibold leading-snug text-foreground" data-testid="blockedit-summary">
                {proposal.summary}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="blockedit-counts">
                {countsLine(proposal)}
            </p>
            {proposal.notes && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="blockedit-notes">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    {proposal.notes}
                </p>
            )}
            {proposal.large && (
                <p className="mt-1.5 flex items-start gap-1.5 text-[11px] font-medium leading-snug text-amber-700 dark:text-amber-400" data-testid="blockedit-large">
                    <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    This is a big change: {proposal.removed >= proposal.added ? `${plural(proposal.removed, "block")} would go` : `${plural(proposal.added, "block")} would be added`}. Check it on the model first.
                </p>
            )}
            {proposal.warnings.map((w, n) => (
                    <p key={n} className="mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400" data-testid="blockedit-warning">
                        <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                        {w}
                    </p>
                ))}
            {proposal.protectedKept > 0 && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground" data-testid="blockedit-protected">
                    Kept {plural(proposal.protectedKept, "block")} that the stabilizer added.
                </p>
            )}
            <div className="mt-2">
                <ChangeLine text={proposal.change.text} tone={proposal.change.tone} broke={proposal.change.broke} fixed={proposal.change.fixed} testId="blockedit-change" />
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
                <Button type="button" size="sm" className={cn(small, "min-w-24")} onClick={apply} data-testid="blockedit-apply">
                    Apply
                </Button>
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={discard} data-testid="blockedit-discard-proposal">
                    Discard
                </Button>
            </div>
        </div>
    );
}

/** The unsaved changes: how many, what they did to the verdict, and Save / Undo / Redo / Stabilize. */
function DraftBox({ draft, result, model, busy, compact }: { draft: DraftView; result: AnalysisResult | null; model: ModelAsset; busy: boolean; compact: boolean }) {
    const save = useVoxelEditStore((s) => s.save);
    const saveAndStabilize = useVoxelEditStore((s) => s.saveAndStabilize);
    const undo = useVoxelEditStore((s) => s.undo);
    const redo = useVoxelEditStore((s) => s.redo);
    const discard = useVoxelEditStore((s) => s.discard);
    const stabilizeAfter = useVoxelEditStore((s) => s.stabilizeAfter);
    const setStabilizeAfter = useVoxelEditStore((s) => s.setStabilizeAfter);
    const saving = useVoxelEditStore((s) => s.status === "saving");
    const checkId = useId();
    const fixable = draft.verdict.fix !== "none" && draft.verdict.kind !== "pass";
    const tone = TONE[CHANGE_TONE[draft.change.tone]];
    return (
        <div className={cn("rounded-xl border p-3", draft.change.tone === "worse" ? tone.soft : "bg-muted/40", draft.change.tone === "worse" ? tone.border : "border-border")} data-testid="blockedit-draft" data-count={draft.count} aria-label={`Your changes to ${model.prompt.slice(0, 40)}`} role="group">
            <div className="flex items-start gap-2">
                <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold leading-snug" data-testid="blockedit-draft-line">
                        {draft.count > 0 ? `Draft: ${draftLine(draft.count)}` : "Your changes are undone"}
                    </p>
                    {draft.last && !compact && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{draft.last}</p>}
                </div>
            </div>
            {draft.count > 0 && (
                <div className="mt-2 space-y-2">
                    <ChangeLine text={draft.change.text} tone={draft.change.tone} broke={draft.change.broke} fixed={draft.change.fixed} testId="blockedit-draft-change" />
                    {!compact && result && <DraftFigures result={result} />}
                    <p className="text-[11px] text-muted-foreground" data-testid="blockedit-draft-blocks">
                        {plural(draft.baseBlocks, "block")} → {plural(draft.blocks, "block")}
                    </p>
                </div>
            )}
            {draft.full && draft.count > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400" data-testid="blockedit-full">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    That is the most one version holds. Save it, then go on.
                </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {draft.count > 0 && (
                    <Button type="button" size="sm" className={cn(small, "min-w-28")} onClick={() => void save()} disabled={busy || saving} data-testid="blockedit-save">
                        {saving ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
                        {saving ? "Saving" : "Save version"}
                    </Button>
                )}
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={undo} disabled={busy || saving || draft.count === 0} data-testid="blockedit-undo">
                    <Undo2 />
                    Undo
                </Button>
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={redo} disabled={busy || saving || draft.redo === 0} data-testid="blockedit-redo">
                    <Redo2 />
                    Redo
                </Button>
                {fixable && draft.count > 0 && !compact && (
                    <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={() => void saveAndStabilize()} disabled={busy || saving} data-testid="blockedit-stabilize">
                        Stabilize
                    </Button>
                )}
                <Button type="button" size="sm" variant="ghost" className={cn(small, quiet, "text-muted-foreground")} onClick={discard} disabled={saving} data-testid="blockedit-discard">
                    Discard
                </Button>
            </div>
            {draft.count > 0 && !compact && (
                <label htmlFor={checkId} className="mt-2 flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground md:min-h-6">
                    <Checkbox id={checkId} checked={stabilizeAfter} onCheckedChange={setStabilizeAfter} disabled={saving} data-testid="blockedit-stabilize-after" />
                    Stabilize after saving
                </label>
            )}
        </div>
    );
}

/** The editor is thinking (or a kept draft is being put back): the clock and the way out. */
function PlanningStrip({ startedAt, resuming }: { startedAt: number | null; resuming: boolean }) {
    const cancel = useVoxelEditStore((s) => s.cancel);
    return (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-3" data-testid="blockedit-planning" role="status" aria-live="polite">
            <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
                <p className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">
                    {resuming ? "Putting your changes back" : "Muse is reading the blocks"}
                    {startedAt !== null && !resuming && <ElapsedTime startedAt={startedAt} className="ml-2 font-normal tabular-nums text-muted-foreground" />}
                </p>
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={cancel} data-testid="blockedit-stop">
                    <Square />
                    Stop
                </Button>
            </div>
        </div>
    );
}

/** A question from the editor, a refusal, or "nothing would change". */
function NoticeBox({ notice }: { notice: Notice }) {
    const dismiss = useVoxelEditStore((s) => s.dismissNotice);
    const t = TONE[notice.kind === "ask" ? "info" : "warn"];
    return (
        <div className={cn("rounded-xl border p-3", t.soft, t.border)} data-testid="blockedit-notice" data-kind={notice.kind} role="status">
            <div className="flex items-start gap-2">
                <Info className={cn("mt-0.5 h-4 w-4 shrink-0", t.icon)} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-foreground">{notice.text}</p>
                    {notice.warnings.map((w, n) => (
                        <p key={n} className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                            {w}
                        </p>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={dismiss}
                    aria-label="Dismiss"
                    className="-m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:-m-0.5 md:h-6 md:w-6"
                >
                    <X className="h-3.5 w-3.5" aria-hidden />
                </button>
            </div>
        </div>
    );
}

/** The field and its chips. */
function Field({ disabled, reason, compact }: { disabled: boolean; reason: string | null; compact: boolean }) {
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const inputId = useId();
    const input = useRef<HTMLInputElement>(null);

    const submit = async (event?: FormEvent) => {
        event?.preventDefault();
        const words = text.trim();
        if (!words || disabled || sending) return;
        setSending(true);
        try {
            // The router checks that the editor is set up, takes the work guard, writes the words into the chat and asks (store/editRouter.ts).
            const outcome = await submitEdit(words);
            // The words are done with once they got an answer (a proposal or a notice); a Stop leaves them in the field to be changed.
            const { proposal, notice } = useVoxelEditStore.getState();
            if (outcome.ok && (proposal !== null || notice !== null)) setText("");
        } finally {
            setSending(false);
        }
    };

    return (
        <form onSubmit={(e) => void submit(e)} data-testid="blockedit-form">
            <div className="flex items-center gap-1.5">
                <label htmlFor={inputId} className="sr-only">
                    Describe a change to the blocks
                </label>
                <Input
                    id={inputId}
                    ref={input}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={EDIT_PLACEHOLDER}
                    maxLength={EDIT_INSTRUCTION_MAX}
                    disabled={disabled}
                    autoComplete="off"
                    enterKeyHint="send"
                    title={reason ?? undefined}
                    data-testid="blockedit-input"
                    className="h-11 text-sm md:h-9"
                />
                <Button type="submit" variant="ghost" size="icon" className="h-11 w-11 shrink-0 md:h-9 md:w-9" disabled={disabled || sending || text.trim() === ""} aria-label="Send" data-testid="blockedit-send">
                    {sending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <CornerDownLeft />}
                </Button>
            </div>
            {reason && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground" data-testid="blockedit-reason">
                    {reason}
                </p>
            )}
            {!compact && !disabled && (
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="blockedit-chips">
                    {EDIT_CHIPS.map((chip) => (
                        <button
                            key={chip}
                            type="button"
                            onClick={() => {
                                setText(chip);
                                input.current?.focus();
                            }}
                            className="min-h-8 rounded-full border border-border bg-background px-2.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            {chip}
                        </button>
                    ))}
                </div>
            )}
        </form>
    );
}

// ---------- the card ----------

export interface EditBlocksCardProps {
    model: ModelAsset;
    /** The model's own analysis (the card shows only when it is ready). */
    result: AnalysisResult;
    /** The phone's peek card: the state in one line and the decisions; the field is in the full panel. */
    compact?: boolean;
}

/**
 * Change the blocks by words. A ghost field under the answer (never a second filled button): the person writes what they want, the AI editor
 * proposes block changes, and the card shows what they would do to the verdict before anything happens. Apply puts a proposal in a draft
 * (undo and redo, up to 12 changes); Save version keeps the whole draft as one new version. The draft is also what the Stability panel's
 * headline shows while it exists (AnalysisPanel). Mounted for a block version or an original with an analysis; the state is store/voxelEdit.ts.
 */
export function EditBlocksCard({ model, result, compact = false }: EditBlocksCardProps) {
    const status = useVoxelEditStore((s) => s.status);
    const sourceId = useVoxelEditStore((s) => s.sourceModelId);
    const proposal = useVoxelEditStore((s) => s.proposal);
    const draft = useVoxelEditStore((s) => s.draft);
    const draftResult = useVoxelEditStore((s) => s.draftResult);
    const notice = useVoxelEditStore((s) => s.notice);
    const error = useVoxelEditStore((s) => s.error);
    const startedAt = useVoxelEditStore((s) => s.startedAt);
    const resuming = useVoxelEditStore((s) => s.resuming);
    const resumable = useVoxelEditStore((s) => s.resumable);
    const findResumable = useVoxelEditStore((s) => s.findResumable);
    const resume = useVoxelEditStore((s) => s.resume);
    const discard = useVoxelEditStore((s) => s.discard);
    const save = useVoxelEditStore((s) => s.save);
    const assist = useWorkspaceStore((s) => s.providers?.assist);
    const work = useCurrentWork();
    const setSheetOpen = useAnalysisStore((s) => s.setSheetOpen);
    const goToSource = useVoxelEditStore((s) => s.goToSource);

    // A draft kept before a reload for this model: offer it back.
    useEffect(() => {
        findResumable(model.id);
    }, [findResumable, model.id]);

    const mine = sourceId === model.id;
    const planning = mine && status === "planning";
    const saving = mine && status === "saving";
    const elsewhere = sourceId !== null && !mine && (draft !== null || proposal !== null || status === "planning");
    const otherWork = work !== null && work.kind !== "blocks" ? `Finish or discard the ${work.kind === "stabilize" ? "stabilizing" : "optimization"} first.` : null;
    const unavailable = assist && assist.available === false ? "The AI editor is not set up on the server." : result.stats.blockCount === 0 ? "There are no blocks to change." : null;
    const disabled = planning || saving || elsewhere || unavailable !== null || otherWork !== null || (mine && draft?.full === true);
    const reason = unavailable ?? otherWork ?? (mine && draft?.full ? "Save this version before you make more changes." : null);

    let body;
    if (planning) body = <PlanningStrip startedAt={startedAt} resuming={resuming} />;
    else if (mine && proposal) body = <ProposalBox proposal={proposal} />;
    else if (mine && draft) body = <DraftBox draft={draft} result={draftResult} model={model} busy={status === "planning"} compact={compact} />;
    else if (elsewhere)
        body = (
            <div className="rounded-xl border border-border bg-muted/40 p-3" data-testid="blockedit-elsewhere">
                <p className="text-xs text-muted-foreground">You have unsaved changes to another version.</p>
                <Button type="button" size="sm" variant="ghost" className={cn(small, "-ml-2 mt-1 text-primary hover:bg-primary/10 hover:text-primary")} onClick={goToSource} data-testid="blockedit-go">
                    <ArrowRight />
                    Go there
                </Button>
            </div>
        );
    else if (resumable && resumable.modelId === model.id && !mine)
        body = (
            <div className="rounded-xl border border-border bg-muted/40 p-3" data-testid="blockedit-resume">
                <p className="text-xs text-foreground">{`You have ${draftLine(resumable.count)} on this version.`}</p>
                <div className="mt-2 flex gap-2">
                    <Button type="button" size="sm" className={small} onClick={() => void resume()} data-testid="blockedit-continue">
                        Continue
                    </Button>
                    <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={discard} data-testid="blockedit-forget">
                        Discard
                    </Button>
                </div>
            </div>
        );
    else body = null;

    // The phone's card does not hold the field: a pencil row opens the full panel.
    if (compact && !body && !notice) {
        return (
            <div className="px-4" data-testid="blockedit-card" data-state="idle">
                <Button type="button" variant="ghost" size="sm" className={cn(small, quiet, "w-full justify-start text-muted-foreground")} onClick={() => setSheetOpen(true)} disabled={unavailable !== null} data-testid="blockedit-open">
                    <PencilLine />
                    Change the blocks…
                </Button>
            </div>
        );
    }

    return (
        <TooltipProvider delayDuration={400}>
            <section
                className={compact ? "px-4" : "px-4 pb-3"}
                data-testid="blockedit-card"
                data-state={planning ? "planning" : saving ? "saving" : mine && proposal ? "proposal" : mine && draft ? "draft" : "idle"}
                aria-label="Change the blocks"
            >
                <div className="space-y-2">
                    {!compact && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <h3 className="flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground" tabIndex={0}>
                                    <PencilLine className="h-3.5 w-3.5" aria-hidden />
                                    Change the blocks
                                </h3>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-60 text-xs">
                                {FIELD_TIP}
                            </TooltipContent>
                        </Tooltip>
                    )}
                    {notice && !planning && <NoticeBox notice={notice} />}
                    {body}
                    {mine && status === "error" && error && (
                        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3" role="alert" data-testid="blockedit-error">
                            <p className="text-[13px] font-semibold text-red-700 dark:text-red-400">Could not save the version</p>
                            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{error}</p>
                            <Button type="button" size="sm" className={cn(small, "mt-2")} onClick={() => void save()} data-testid="blockedit-retry">
                                Try again
                            </Button>
                        </div>
                    )}
                    {!compact && !(mine && proposal) && !saving && !elsewhere && <Field disabled={disabled} reason={reason} compact={compact} />}
                    {/* Keep it: nothing below the field once there is a model to look at. */}
                    {compact && !(mine && proposal) && !planning && !saving && !elsewhere && (
                        <Button type="button" variant="ghost" size="sm" className={cn(small, quiet, "w-full justify-start text-muted-foreground")} onClick={() => setSheetOpen(true)} data-testid="blockedit-open">
                            <PencilLine />
                            Change the blocks…
                        </Button>
                    )}
                </div>
            </section>
        </TooltipProvider>
    );
}
