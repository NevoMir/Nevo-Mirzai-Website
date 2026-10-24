import { useEffect, useState, type RefObject } from "react";

export interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

const sameInsets = (a: Insets, b: Insets) =>
    a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

/**
 * How much of the window the floating UI covers, so the viewer can frame the model in what is
 * left. The page lays the chat panel beside a transparent spacer (#canvas-viewport-area); the
 * spacer's rect IS the free middle column, so the chat's width is the window minus that rect. The
 * top bar floats over the viewer, so its bottom edge is the free area's top.
 *
 * The spacer exists only in the desktop layout (the phone renders none, and the shell stays
 * mounted across a live breakpoint flip), so it is re-queried on every update instead of captured
 * once: a captured node goes stale, and a spacer that appears later would be missed.
 */
export function useViewerInsets(barRef: RefObject<HTMLElement | null>): { insets: Insets; side: { left: number; right: number }; width: number } {
    const [insets, setInsets] = useState<Insets>({ top: 0, right: 0, bottom: 0, left: 0 });
    const [width, setWidth] = useState(() => window.innerWidth);

    useEffect(() => {
        let observed: HTMLElement | null = null;
        const observer = new ResizeObserver(() => update());

        function update() {
            const spacer = document.getElementById("canvas-viewport-area");
            if (spacer !== observed) {
                observer.disconnect();
                observed = spacer;
                if (spacer) observer.observe(spacer);
                if (barRef.current) observer.observe(barRef.current);
            }
            const left = spacer ? Math.max(0, Math.round(spacer.getBoundingClientRect().left)) : 0;
            const right = spacer ? Math.max(0, Math.round(window.innerWidth - spacer.getBoundingClientRect().right)) : 0;
            const bar = barRef.current?.getBoundingClientRect();
            // 8px of air between the bar and the model's frame.
            const top = bar ? Math.max(0, Math.round(bar.bottom) + 8) : 0;
            const next = { top, right, bottom: 0, left };
            setInsets((previous) => (sameInsets(previous, next) ? previous : next));
            setWidth(window.innerWidth);
        }

        if (barRef.current) observer.observe(barRef.current);
        update();
        // One more frame: a spacer that lands in a LATER commit than this effect would otherwise be
        // missed until the next window resize.
        const frame = requestAnimationFrame(update);
        window.addEventListener("resize", update);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener("resize", update);
        };
    }, [barRef]);

    return { insets, side: { left: insets.left, right: insets.right }, width };
}
