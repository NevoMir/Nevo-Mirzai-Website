import type { KeyboardEvent, RefObject } from "react";
import { ArrowUp, Square } from "lucide-react";

import { ProviderPicker } from "@/assignment/components/chat/ProviderPicker";
import type { ProviderId, ProviderInfo } from "@/assignment/shared/contract";

/** A prompt is capped by the Worker at this many characters. */
export const MAX_PROMPT_CHARS = 1000;

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
    /** Send is enabled (text typed, a model picked, nothing being sent). */
    canSend: boolean;
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

    return (
        // @container: the controls below follow the width of THIS box, which is the same whether the
        // composer sits in the chat panel or is portalled over the canvas.
        <div className="@container p-3">
            <div
                data-testid="chat-composer-box"
                className="relative bg-secondary border border-border rounded-2xl overflow-hidden"
            >
                <textarea
                    ref={props.textareaRef}
                    value={input}
                    onChange={(e) => props.onInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={props.placeholder}
                    aria-label="Prompt"
                    disabled={locked}
                    rows={1}
                    maxLength={MAX_PROMPT_CHARS}
                    onFocus={props.onTextareaFocus}
                    onBlur={props.onTextareaBlur}
                    /* text-base (16px) on phones so iOS Safari doesn't auto-zoom the page on focus;
                       text-sm on the desktop side panel. */
                    className="w-full bg-transparent resize-none text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50 px-4 pt-3 pb-1 max-h-[120px]"
                />

                {/* Bottom controls row: the model picker on the left, usage and send on the right. */}
                <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                    <ProviderPicker
                        providers={props.providers}
                        selected={props.selected}
                        onChange={props.onSelectedChange}
                        disabled={locked}
                        usage={usage}
                    />

                    <div className="flex-1" />

                    {usage && (
                        // Too narrow a box would squeeze the model name away: the count then lives in
                        // the model menu instead.
                        <span
                            data-testid="usage-hint"
                            title="Models generated today (each model counts once per prompt)"
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
                            aria-label={generating ? "Queue prompt" : "Send"}
                            title={generating ? "Queue this prompt (Enter)" : "Send (Enter)"}
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
