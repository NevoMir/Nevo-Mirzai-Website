// A result that appears right after a run ends takes the keyboard focus, so the user lands on it instead of being left on a
// button that is gone.

import { useEffect, useRef, type RefObject } from "react";

/** How fresh an end must be for the result to take the focus. */
const FRESH_MS = 2000;

/**
 * Returns a ref for the result's box (give it tabIndex -1). When `endedAt` is recent as the box appears, the box takes the
 * focus, but only if the button that was pressed is gone and focus fell to the page or to a container around the box (the
 * phone's sheet): someone who went on to type in the composer or another field keeps their place.
 */
export function useFocusOnEnd<T extends HTMLElement>(endedAt: number | null): RefObject<T | null> {
    const ref = useRef<T>(null);
    useEffect(() => {
        const node = ref.current;
        if (!node || endedAt === null || Date.now() - endedAt >= FRESH_MS) return;
        const active = document.activeElement;
        if (!active || active === document.body || active.contains(node)) node.focus();
    }, [endedAt]);
    return ref;
}
