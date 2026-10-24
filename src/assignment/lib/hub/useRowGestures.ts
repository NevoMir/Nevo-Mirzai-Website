import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import { withRange } from "@/assignment/lib/hub/rowSelection";

/** How far a press on a row may wander and still be a press (a click, or a long
 *  press: no finger is perfectly still). Past it, it is a scroll, or (a mouse,
 *  while selecting) a sweep over several rows. */
const PRESS_SLOP_PX = 8;
/** How long a press is held before it selects the row: the platforms' own long-press time. */
export const LONG_PRESS_MS = 500;

export interface RowGestureOptions {
    /** False when nothing may be selected here. */
    enabled: boolean;
    /** The ids a range may cover, in the order the rows are drawn. */
    orderedIds: string[];
    /** What is selected right now. */
    selected: Set<string>;
    /** A long press landed on this row: tick it. */
    onTick: (id: string) => void;
    /** A mouse sweep changed the selection: the new set and the row it started on. */
    onSweep: (selected: Set<string>, anchorId: string) => void;
}

interface Press {
    id: string;
    row: HTMLElement;
    /** Where the row was when the press went down: one that moved under a still
     *  pointer (the list scrolled) was not held. */
    top: number;
    x: number;
    y: number;
    pointerId: number;
    mouse: boolean;
    /** The long-press timer; null once it has landed or the press travelled. */
    hold: number | null;
    /** A mouse press while selecting may sweep: the selection as it was when it went
     *  down, so sweeping back up unselects again. Null for any other. */
    sweepBase: Set<string> | null;
    sweeping: boolean;
}

/**
 * The pointer gestures of the project list. A press is a CLICK (it opens the project)
 * unless it is held still for LONG_PRESS_MS (it ticks the row), a finger or a mouse
 * alike. One that travels past PRESS_SLOP_PX is neither: a scroll, which is the
 * browser's, or, for a mouse while something is already selected, a sweep over the
 * rows. Never a sweep by finger: that would fight scrolling.
 *
 * Spread `handlers` on the element that holds the rows; each row carries
 * `data-project-row` and `data-project-id`.
 */
export function useRowGestures(options: RowGestureOptions) {
    // The handlers outlive a render (a timer, a captured pointer), so they read the
    // latest options through a ref rather than the ones they were created with.
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const listRef = useRef<HTMLDivElement | null>(null);
    const press = useRef<Press | null>(null);
    /** A long press or a sweep ends in a click; that click is the gesture's, not the
     *  user asking for anything. */
    const suppressClick = useRef(false);
    const [dragging, setDragging] = useState(false);

    const rowIdAt = (x: number, y: number) =>
        (document.elementFromPoint(x, y)?.closest("[data-project-row]") as HTMLElement | null)?.dataset.projectId ??
        null;

    const endPress = () => {
        const state = press.current;
        press.current = null;
        if (!state) return;
        clearTimeout(state.hold ?? undefined);
        if (!state.sweeping) return;
        suppressClick.current = true;
        setDragging(false);
        try {
            listRef.current?.releasePointerCapture(state.pointerId);
        } catch {
            // Never captured.
        }
    };

    // A page that unmounts mid-press must not tick a row that is gone.
    useEffect(() => () => clearTimeout(press.current?.hold ?? undefined), []);

    /** The hold landed: the row is ticked, the click it ends in is swallowed, and a
     *  phone pulses once under the finger (once the page has been tapped at all:
     *  before that Chrome refuses the pulse with a console error). */
    const held = () => {
        const state = press.current;
        if (!state || state.hold === null) return;
        clearTimeout(state.hold);
        state.hold = null;
        if (state.row.getBoundingClientRect().top !== state.top) return;
        suppressClick.current = true;
        if (!state.mouse && navigator.userActivation?.hasBeenActive) navigator.vibrate?.(10);
        optionsRef.current.onTick(state.id);
    };

    const onPointerDown = (e: PointerEvent) => {
        // A press left over from a gesture that ended out of our sight, and a flag left
        // over from one that ended on nothing, would both act on this one.
        endPress();
        suppressClick.current = false;
        const { enabled, orderedIds, selected } = optionsRef.current;
        if (!enabled || e.button !== 0) return;
        const target = e.target as Element | null;
        if (!target || target.closest('button,a,input,[role="menu"],[role="menuitem"]')) return;
        const row = target.closest("[data-project-row]") as HTMLElement | null;
        const id = row?.dataset.projectId;
        if (!row || !id || !orderedIds.includes(id)) return;
        const mouse = e.pointerType === "mouse";
        press.current = {
            id,
            row,
            top: row.getBoundingClientRect().top,
            x: e.clientX,
            y: e.clientY,
            pointerId: e.pointerId,
            mouse,
            hold: window.setTimeout(held, LONG_PRESS_MS),
            sweepBase: mouse && selected.size > 0 ? new Set(selected) : null,
            sweeping: false,
        };
    };

    const onPointerMove = (e: PointerEvent) => {
        const state = press.current;
        if (!state) return;
        // The button is no longer down: its release never reached the list (a window
        // that lost focus mid-press), and a button-less move is no sweep.
        if (!(e.buttons & 1)) {
            endPress();
            return;
        }
        if (!state.sweeping) {
            if (Math.hypot(e.clientX - state.x, e.clientY - state.y) < PRESS_SLOP_PX) return;
            // Travelled: neither a hold nor a click. A finger's is a scroll, which is the
            // browser's; only a mouse's, while selecting, is a sweep.
            if (!state.sweepBase) {
                endPress();
                return;
            }
            clearTimeout(state.hold ?? undefined);
            state.hold = null;
            state.sweeping = true;
            setDragging(true);
            // Captured on the LIST, so a sweep that leaves the rows keeps reporting; which
            // row the pointer is over is then answered by the point, not by the target.
            try {
                listRef.current?.setPointerCapture(state.pointerId);
            } catch {
                // No capture in this browser: the sweep still works over the list.
            }
        }
        e.preventDefault();
        const over = rowIdAt(e.clientX, e.clientY);
        if (!over || !state.sweepBase) return;
        optionsRef.current.onSweep(withRange(state.sweepBase, optionsRef.current.orderedIds, state.id, over), state.id);
    };

    /** Android answers a held finger with a long-press menu of its own at about the
     *  moment the hold lands. On a row that menu IS the hold. A mouse's (a right-click,
     *  a Mac's Ctrl-click) is the browser's: the press ends, and the menu shows. */
    const onContextMenu = (e: MouseEvent) => {
        const state = press.current;
        if (!state) return;
        if (state.mouse) {
            endPress();
            return;
        }
        e.preventDefault();
        held();
    };

    /** The click a long press or a sweep ends in is aimed at whatever is under the
     *  pointer when it lifts, and the gesture has just redrawn the row (the checkbox
     *  now sits where a thumb on the picture rests). So it is swallowed before ANY of
     *  the list sees it: on the box it would untick what the hold just ticked.
     *  Once: pointerdown clears a flag nothing consumed. */
    const onClickCapture = (e: MouseEvent) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
    };

    return {
        listRef,
        dragging,
        handlers: {
            onPointerDown,
            onPointerMove,
            onPointerUp: endPress,
            onPointerCancel: endPress,
            // A mouse is not captured by what it pressed: slid off the list, its release
            // lands where the list never hears of it, and the hold would tick the row
            // after the button came up. So leaving ends the press. (A finger's pointer,
            // and a sweep's, is captured: neither leaves before it lifts.)
            onPointerLeave: endPress,
            onContextMenu,
            onClickCapture,
        },
    };
}
