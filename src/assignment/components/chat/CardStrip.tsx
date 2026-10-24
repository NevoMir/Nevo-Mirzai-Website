import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** Gap between cards, in px. Also the unit the card width is derived from. */
const GAP_PX = 16;
/** Cards per view in the hero: three whole ones plus 35% of a fourth. */
const HERO_CARDS_PER_VIEW = 3.35;

/**
 * Whole cards per view by track width. The hero is wide enough for three-up; the panel's inline
 * empty state (~300px) and a phone (~340px) get two or one, always plus the 35% sliver that says
 * "this scrolls". 0 (a first paint before layout) keeps the hero rule.
 */
function cardsPerViewFor(trackWidth: number): number {
    if (trackWidth === 0 || trackWidth >= 600) return HERO_CARDS_PER_VIEW;
    return trackWidth >= 380 ? 2.35 : 1.35;
}

/** Card width = (100% - <whole cards> gaps) / <cards per view>, written out flat for calc(). */
function cardWidthFor(cardsPerView: number): string {
    const gaps = Math.floor(cardsPerView);
    return `calc(${(100 / cardsPerView).toFixed(4)}% - ${((gaps * GAP_PX) / cardsPerView).toFixed(4)}px)`;
}

export interface CardStripProps {
    /** Names the list for assistive tech ("Example prompts"). */
    label: string;
    testId: string;
    /** One entry per card. The focusable control of a card carries `data-strip-card`, which the arrow keys walk. */
    items: readonly { key: string; node: ReactNode }[];
    className?: string;
}

/**
 * Cards in one horizontally scrollable strip, three and a bit per view, the last visible one blurred toward the
 * edge (Cably's template carousel). Shared by the example prompts and the example projects of the new-chat hero.
 */
export function CardStrip({ label, testId, items, className = "" }: CardStripProps) {
    const trackRef = useRef<HTMLDivElement>(null);
    // Start with the hint visible: the first paint has more cards to the right by construction.
    const [atEnd, setAtEnd] = useState(false);
    const [cardsPerView, setCardsPerView] = useState(HERO_CARDS_PER_VIEW);

    const measure = useCallback(() => {
        const el = trackRef.current;
        if (!el) return;
        // 1px slack: fractional scroll positions never land exactly on the end.
        setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
        setCardsPerView(cardsPerViewFor(el.clientWidth));
    }, []);

    useEffect(() => {
        measure();
        const el = trackRef.current;
        if (!el) return;
        // A panel drag or a window resize can move the end without a scroll event.
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [measure]);

    // Cards that arrive after the first paint (the examples list loads) can move the end too.
    useEffect(() => {
        measure();
    }, [items.length, measure]);

    // ArrowLeft/ArrowRight walk the cards; focusing one scrolls it into view.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const el = trackRef.current;
        if (!el) return;
        const cards = Array.from(el.querySelectorAll<HTMLElement>("[data-strip-card]"));
        const index = cards.findIndex((c) => c === document.activeElement);
        if (index === -1) return;
        const next = cards[index + (e.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        e.preventDefault();
        next.focus();
    };

    const cardWidth = cardWidthFor(cardsPerView);
    return (
        <div className={`relative w-full max-w-[880px] ${className}`} data-testid={testId}>
            <div
                ref={trackRef}
                role="list"
                aria-label={label}
                onScroll={measure}
                onKeyDown={onKeyDown}
                // px/py-1 keeps the cards' focus ring inside the scroll box, where overflow-x:auto
                // would otherwise clip it.
                className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-px-1 px-1 py-1 motion-safe:scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ gap: GAP_PX }}
            >
                {items.map((item) => (
                    <div key={item.key} role="listitem" className="shrink-0 snap-start" style={{ width: cardWidth }}>
                        {item.node}
                    </div>
                ))}
            </div>
            {!atEnd && (
                // Progressive blur plus a tint toward the canvas colour, both ramping from nothing at
                // the strip's left edge to full at the right, so the fourth card fades out.
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 right-0 w-[24%] backdrop-blur-[5px] [mask-image:linear-gradient(to_right,transparent,black_70%)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_70%)]"
                    style={{ background: "linear-gradient(to right, transparent, hsl(var(--canvas) / 0.85))" }}
                />
            )}
        </div>
    );
}
