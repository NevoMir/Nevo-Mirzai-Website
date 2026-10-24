import { useRef } from "react";

/**
 * Run something (open a dialog, start a rename) only AFTER a dropdown menu has finished
 * closing.
 *
 * A modal Radix menu puts `pointer-events: none` on <body> while it is open and puts back
 * whatever it found there when it closes. A dialog opened from one of its items, in the same
 * tick, finds that `none`, "restores" it when the dialog closes, and leaves the whole page
 * dead to the mouse. Waiting for the menu's own `onCloseAutoFocus` (which Radix fires once
 * the menu is gone and the body is back to normal) removes the race, and also lets the next
 * thing take the focus instead of the "⋯" button.
 *
 * Use `defer(fn)` in an item's onClick and spread `onCloseAutoFocus` on the menu content.
 */
export function useAfterMenuClose() {
    const pending = useRef<(() => void) | null>(null);
    return {
        defer: (fn: () => void) => {
            pending.current = fn;
        },
        onCloseAutoFocus: (event: Event) => {
            const fn = pending.current;
            pending.current = null;
            if (!fn) return;
            // The deferred action owns the focus now (a dialog, a name field).
            event.preventDefault();
            fn();
        },
    };
}
