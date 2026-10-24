// A project's name, renamed where it is written.
//
// Three things are contracts here rather than styling details:
//
//   * the name is KEPT and the caret goes to its END: `setSelectionRange(len, len)`,
//     never `select()`. A select-all is one keystroke away from losing the name the
//     user wanted to extend.
//   * tapping the name is not tapping what it sits in: its click, and, while it is a
//     field, the field's press and click, stop dead there.
//   * the name is only a target when the page handed over a rename at all. The hub
//     hands over none (a tap on a name there opens the project, and the "⋯" menu's
//     Rename opens this same field); the workspace header is where a tap renames.
//
// The field is UNCONTROLLED: the value the user is typing belongs to the input until
// they commit it, so a keystroke does not re-render the whole hub. Empty or unchanged
// is a CANCEL, not a write of the same string back.
import { useEffect, useRef } from "react";

import type { HubProject } from "@/assignment/lib/hub/hubClient";
import { isImeKey } from "@/assignment/lib/hub/ime";
import { cn } from "@/assignment/lib/utils";

/** The longest name the server accepts. */
export const PROJECT_NAME_MAX = 120;

/** What a row or a card needs to host the editor: one shape, because the page wires
 *  both the same way. */
export interface RenameInPlace {
    /** The project whose name is being edited right now, if any. */
    renamingId?: string | null;
    onCommitRename?: (project: HubProject, name: string) => void;
    onCancelRename?: () => void;
}

export interface InlineNameProps {
    value: string;
    editing: boolean;
    /** Absent = this name is not renamable, so it is not clickable either. */
    onStart?: () => void;
    onCommit: (name: string) => void;
    onCancel: () => void;
    className?: string;
    /** Which surface this field belongs to (the project id): the click-away guard
     *  answers only for that one. */
    settleKey?: string;
    /** Where keyboard focus goes when Enter or Escape ends the edit. The field leaves the
     *  tree, and without this the focus falls to <body>. Not used for a click-away, where
     *  the focus is wherever the user clicked. */
    returnFocusTo?: () => HTMLElement | null;
}

/**
 * When the last field settled. The click that blurs a field ("click away to finish")
 * reaches the row or the card AFTER the blur has already cleared the renaming state,
 * so a guard on that state alone lets the click open the project. The surfaces ask
 * this instead: a click landing within a beat of a settle is the one that ended the
 * edit, and does nothing else.
 */
let settledAt = -Infinity;
let settledKey: string | undefined;
const CLICK_AWAY_MS = 300;
// eslint-disable-next-line react-refresh/only-export-components
export function renameJustSettled(key?: string, now = performance.now()): boolean {
    const hit = key === settledKey && now - settledAt < CLICK_AWAY_MS;
    // One blur, one click: the answer is consumed so the next click opens.
    if (hit) settledKey = undefined;
    return hit;
}

export function InlineName({
    value,
    editing,
    onStart,
    onCommit,
    onCancel,
    className = "",
    settleKey,
    returnFocusTo,
}: InlineNameProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    /** Enter commits and then the field leaves the tree, which can fire a blur that
     *  would commit (or cancel) all over again. First answer wins. */
    const settled = useRef(false);

    useEffect(() => {
        if (!editing) {
            settled.current = false;
            return;
        }
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        // The caret lands AFTER the last character, with the name intact and nothing selected.
        const end = input.value.length;
        input.setSelectionRange(end, end);
        // ...and once more on the next frame. The click that opened this field is still
        // being delivered, and a real browser then drops the caret where the POINTER
        // landed ("Untitled v2 project").
        const frame = requestAnimationFrame(() => input.setSelectionRange(end, end));
        return () => cancelAnimationFrame(frame);
    }, [editing]);

    if (!editing) {
        if (!onStart) return <span className={className}>{value}</span>;
        return (
            <span
                data-testid="inline-name"
                // A target that LIGHTS UP rather than underlines. A wash of the FOREGROUND,
                // not `bg-accent`: accent is the brand orange, and an orange block behind
                // the name is a highlight, not a button.
                className={`${className} -mx-1 cursor-text rounded-md px-1 hover:bg-foreground/10`}
                title="Click to rename"
                onClick={(e) => {
                    // Not the click of whatever the name sits in.
                    e.stopPropagation();
                    e.preventDefault();
                    onStart();
                }}
            >
                {value}
            </span>
        );
    }

    const settle = (commit: boolean, viaBlur = false) => {
        if (settled.current) return;
        settled.current = true;
        // Only a BLUR has a click behind it; Enter and Escape end the edit alone.
        if (viaBlur) {
            settledAt = performance.now();
            settledKey = settleKey;
        }
        const next = (inputRef.current?.value ?? "").trim();
        // Nothing typed, or the same name back: there is nothing to write, and a write
        // would still cost a round trip and a re-sort of the list.
        if (commit && next && next !== value) onCommit(next);
        else onCancel();
    };

    return (
        <input
            ref={inputRef}
            data-testid="inline-name-input"
            aria-label={`Rename ${value}`}
            defaultValue={value}
            maxLength={PROJECT_NAME_MAX}
            // 16 px under 768 px (the Input component's rule): iOS Safari zooms the page in when
            // a field smaller than that takes focus, and does not zoom back out. cn() lets this
            // beat a `text-sm` the caller put in `className` for the label.
            className={cn(className, "w-full border-b border-border bg-transparent outline-none text-base md:text-sm")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                if (e.key === "Enter") {
                    // Enter that confirms an IME candidate is not "save the name".
                    if (isImeKey(e)) return;
                    e.preventDefault();
                    settle(true);
                    returnFocusTo?.()?.focus();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    settle(false);
                    returnFocusTo?.()?.focus();
                }
            }}
            onBlur={() => settle(true, true)}
        />
    );
}
