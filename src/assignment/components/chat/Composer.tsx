import { useId, type KeyboardEvent, type RefObject } from "react";
import { ArrowUp, Box, PencilLine, Square } from "lucide-react";

import { maxCharsFor } from "@/assignment/components/chat/composerLogic";
import { ProviderPicker } from "@/assignment/components/chat/ProviderPicker";
import { RouteChip } from "@/assignment/components/chat/RouteChip";
import { toast } from "@/assignment/components/ui/sonner";
import { cn } from "@/assignment/lib/utils";
import type { EditTarget, ProviderId, ProviderInfo } from "@/assignment/shared/contract";
import type { ComposerMode } from "@/assignment/store/useWorkspaceStore";

/** A prompt is capped by the Worker at this many characters. */
export const MAX_PROMPT_CHARS = 1000;

/** What the New | Edit toggle needs to know about the model on screen. */
export interface ComposerEdit {
    /** What an edit would act on, when it can be told. */
    target: EditTarget | null;
    /** A change can be sent as an edit now. */
    canEdit: boolean;
    /** Why not, in words (the Edit segment's tooltip). */
    reason: string | null;
    /** "v3 · Stabilized", "the original". */
    subject: string | null;
}

export interface ComposerProps {
    input: string;
    onInput: (value: string) => void;
    onSubmit: () => void;
    onStop: () => void;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
    onTextareaFocus: () => void;
    onTextareaBlur: () => void;
    placeholder: string;
    /** The textarea cannot be typed in. */
    locked: boolean;
    /** A run is going: the send button becomes the stop button (when something can be stopped). */
    generating: boolean;
    /** At least one running model can be canceled. Tencent's cannot, and a Stop that only hides the
     *  run while it is still paid for would be a lie, so the send button (which queues) stays. */
    stoppable: boolean;
    /** Send is enabled (text typed, a model picked or a change possible, nothing being sent). */
    canSend: boolean;
    /** What the typed words do: make a new model, or change the one on screen. */
    mode: ComposerMode;
    onModeChange: (mode: ComposerMode) => void;
    /** The model on screen, for the toggle; null while there is none (then there is nothing to choose). */
    edit: ComposerEdit | null;
    /** The route chip's second way for a mesh (generate it again with Hunyuan), when Hunyuan can be used. */
    onRegenerate: (() => void) | null;
    providers: readonly ProviderInfo[] | undefined;
    selected: readonly ProviderId[];
    onSelectedChange: (next: ProviderId[]) => void;
    usage: { used: number; limit: number } | null;
}

/**
 * The composer box. It is rendered once by ChatPanel and either sits at the bottom of the panel or,
 * before the first message, is portalled over the canvas; every ref and handler is the same in both
 * spots, only the wrapper around it differs.
 */
export function Composer(props: ComposerProps) {
    const { input, locked, generating, stoppable, usage } = props;

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter sends, Shift+Enter is a newline; an IME's Enter confirms its candidate instead
        // (Safari reports that Enter with isComposing already false but keyCode 229).
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
            e.preventDefault();
            props.onSubmit();
        } else if (e.key === "Escape" && input) {
            // Esc in the box clears it (and does nothing else, so it never stops a run).
            e.preventDefault();
            props.onInput("");
        }
    };

    const atLimit = usage !== null && usage.used >= usage.limit;
    const editing = props.mode === "edit";

    return (
        // @container: the controls below follow the width of THIS box, which is the same whether the
        // composer sits in the chat panel or is portalled over the canvas.
        <div className="@container p-3">
            <div
                data-testid="chat-composer-box"
                className="relative bg-secondary border border-border rounded-2xl overflow-hidden"
            >
                {props.edit && <ModeToggle mode={props.mode} edit={props.edit} onChange={props.onModeChange} disabled={locked} />}
                <textarea
                    ref={props.textareaRef}
                    value={input}
                    onChange={(e) => props.onInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={props.placeholder}
                    aria-label={editing ? "Describe a change" : "Prompt"}
                    // The page's chords (stop, hide the chat, new project) work from here in either mode (versionLogic.ts shortcutBlocked).
                    data-composer=""
                    disabled={locked}
                    rows={1}
                    maxLength={maxCharsFor(props.mode, MAX_PROMPT_CHARS)}
                    onFocus={props.onTextareaFocus}
                    onBlur={props.onTextareaBlur}
                    /* text-base (16px) on phones so iOS Safari doesn't auto-zoom the page on focus;
                       text-sm on the desktop side panel. */
                    className="w-full bg-transparent resize-none text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 px-4 pt-3 pb-1 max-h-[120px]"
                />

                {/* Bottom controls row: the model picker on the left, usage and send on the right. */}
                <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                    {editing && props.edit?.target ? (
                        <RouteChip target={props.edit.target} onRegenerate={props.onRegenerate} />
                    ) : (
                        <ProviderPicker
                            providers={props.providers}
                            selected={props.selected}
                            onChange={props.onSelectedChange}
                            disabled={locked}
                            usage={usage}
                        />
                    )}

                    <div className="flex-1" />

                    {usage && (
                        // Too narrow a box would squeeze the model name away: the count then lives in
                        // the model menu instead.
                        <span
                            data-testid="usage-hint"
                            title={editing ? "AI changes made today" : "Models generated today (each model counts once per prompt)"}
                            className={`hidden shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums @[17rem]:inline ${
                                atLimit ? "text-destructive" : "text-muted-foreground"
                            }`}
                        >
                            {usage.used}/{usage.limit} today
                        </span>
                    )}

                    {generating && stoppable ? (
                        <button
                            type="button"
                            onClick={props.onStop}
                            aria-label="Stop generation"
                            className="sweep-red flex items-center justify-center h-6 w-6 rounded-full text-destructive-foreground hover:opacity-90 transition-opacity shrink-0"
                            title="Stop generation"
                        >
                            <Square className="h-2.5 w-2.5 fill-current" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={props.onSubmit}
                            aria-label={generating ? (editing ? "Queue change" : "Queue prompt") : editing ? "Send change" : "Send"}
                            title={generating ? "Queue this prompt (Enter)" : editing ? "Make this change (Enter)" : "Send (Enter)"}
                            disabled={!props.canSend}
                            className="flex items-center justify-center h-6 w-6 rounded-full bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                            <ArrowUp className="h-3 w-3" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * `[ New model | ✎ Edit v3 · Stabilized ]`, above the words: what they do. The Edit half is off where a change by words cannot be made (an
 * example, a server without the AI editor). It is off with `aria-disabled`, not `disabled`, so it can still be reached: the reason is its
 * description for a screen reader, its tooltip with a mouse, and what a tap on it says (a phone has no hover). Icons only in a narrow box.
 */
function ModeToggle({ mode, edit, onChange, disabled }: { mode: ComposerMode; edit: ComposerEdit; onChange: (mode: ComposerMode) => void; disabled: boolean }) {
    const reasonId = useId();
    const reason = edit.reason ?? "This model cannot be changed by words";
    const half = (active: boolean) =>
        cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
            active ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/70" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
        );
    return (
        <div
            role="radiogroup"
            aria-label="What your words do"
            data-testid="composer-mode"
            className="flex items-center gap-0.5 px-2 pt-2"
            // The radio-group keys, like the report's other segmented controls: the arrows move the choice (to Edit only where it is on).
            onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                const next: ComposerMode = event.key === "ArrowRight" ? "edit" : "new";
                if (next === mode || disabled || (next === "edit" && !edit.canEdit)) return;
                event.preventDefault();
                onChange(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-testid="mode-${next}"]`)?.focus();
            }}
        >
            <button type="button" role="radio" aria-checked={mode === "new"} data-testid="mode-new" disabled={disabled} onClick={() => onChange("new")} className={half(mode === "new")} title="Describe a new object to build">
                <Box className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="hidden @[19rem]:inline">New model</span>
                <span className="sr-only @[19rem]:hidden">New model</span>
            </button>
            <button
                type="button"
                role="radio"
                aria-checked={mode === "edit"}
                aria-disabled={edit.canEdit ? undefined : true}
                aria-describedby={edit.canEdit ? undefined : reasonId}
                data-testid="mode-edit"
                disabled={disabled}
                onClick={() => (edit.canEdit ? onChange("edit") : toast.info("This model cannot be changed by words", { description: reason }))}
                className={cn(half(mode === "edit"), "max-w-[16rem]")}
                title={edit.canEdit ? `Describe a change to ${edit.subject ?? "this model"}` : reason}
            >
                <PencilLine className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="hidden truncate @[19rem]:inline">Edit{edit.subject ? ` ${edit.subject}` : ""}</span>
                <span className="sr-only @[19rem]:hidden">Edit {edit.subject}</span>
            </button>
            {!edit.canEdit && (
                <span id={reasonId} className="sr-only">
                    {reason}
                </span>
            )}
        </div>
    );
}
