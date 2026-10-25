import { useEffect, useRef, type ReactNode } from "react";

/**
 * Phone: the bottom edge of the stage, where the Stability tab's peek card sits (the verdict, four figures and the one action;
 * a tap opens the full report as a sheet). It lets touches through everywhere but the card, and reports how much room it
 * takes so the shell can add that to the viewer's bottom inset: the stage's toolbar then sits above the card, not under it. The
 * card is `touch-none`, so a swipe up on it reaches the card as a drag instead of being taken for a page pan.
 */
export function PhonePeekDock({ onHeight, children }: { onHeight: (px: number) => void; children: ReactNode }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const dock = ref.current;
        if (!dock || typeof ResizeObserver === "undefined") return;
        const report = () => onHeight(Math.ceil(dock.getBoundingClientRect().height));
        const observer = new ResizeObserver(report);
        observer.observe(dock);
        report();
        return () => observer.disconnect();
    }, [onHeight]);
    return (
        <div
            ref={ref}
            data-testid="analysis-peek-dock"
            // 12 px from the edge, more where the home indicator is.
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        >
            {/* No panning from a touch that starts on the card: its "swipe up for the full panel" is a drag, and the browser would claim a
                vertical one for a pan and cancel the pointer (no pointerup, so no panel). The effective touch-action of what is inside is the
                intersection with this one, up to the nearest scroller; the card has none, and taps are not affected. */}
            <div className="pointer-events-auto touch-none">{children}</div>
        </div>
    );
}
