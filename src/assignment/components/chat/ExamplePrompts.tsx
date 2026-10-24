import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { Armchair, Bike, Bot, Coffee, Fan, LampDesk, type LucideProps } from "lucide-react";

/** Gap between cards, in px. Also the unit the card width is derived from. */
const GAP_PX = 16;
/** Cards per view in the hero: three whole ones plus 35% of a fourth. */
const HERO_CARDS_PER_VIEW = 3.35;

interface Example {
    prompt: string;
    /** The card's title; the prompt itself is what lands in the composer. */
    title: string;
    icon: ComponentType<LucideProps>;
    /** Tint of the cover, an HSL triplet so it reads in both themes. */
    hue: number;
}

const EXAMPLES: readonly Example[] = [
    { prompt: "An articulated desk lamp", title: "Articulated desk lamp", icon: LampDesk, hue: 38 },
    { prompt: "A wooden rocking chair", title: "Wooden rocking chair", icon: Armchair, hue: 24 },
    { prompt: "A quadcopter drone with four propellers", title: "Quadcopter drone", icon: Fan, hue: 205 },
    { prompt: "A retro tin robot toy", title: "Retro tin robot", icon: Bot, hue: 350 },
    { prompt: "A road bicycle", title: "Road bicycle", icon: Bike, hue: 150 },
    { prompt: "A hand-crank coffee grinder", title: "Coffee grinder", icon: Coffee, hue: 28 },
];

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

/**
 * The new-chat example row, modelled on Cably's template carousel: cards in one horizontally
 * scrollable strip, three and a bit per view, the last visible one blurred toward the edge. A card
 * does not open anything: it puts its prompt in the composer, ready to edit or send.
 */
export function ExamplePrompts({ onPick, className = "" }: { onPick: (prompt: string) => void; className?: string }) {
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

    // ArrowLeft/ArrowRight walk the cards; focusing one scrolls it into view.
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const el = trackRef.current;
        if (!el) return;
        const cards = Array.from(el.querySelectorAll<HTMLButtonElement>("button[data-example-card]"));
        const index = cards.findIndex((c) => c === document.activeElement);
        if (index === -1) return;
        const next = cards[index + (e.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        e.preventDefault();
        next.focus();
    };

    const cardWidth = cardWidthFor(cardsPerView);
    return (
        <div className={`relative w-full max-w-[880px] ${className}`} data-testid="example-prompts">
            <div
                ref={trackRef}
                role="list"
                aria-label="Example prompts"
                onScroll={measure}
                onKeyDown={onKeyDown}
                // px/py-1 keeps the cards' focus ring inside the scroll box, where overflow-x:auto
                // would otherwise clip it.
                className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain scroll-px-1 px-1 py-1 motion-safe:scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                style={{ gap: GAP_PX }}
            >
                {EXAMPLES.map((example) => {
                    const Icon = example.icon;
                    return (
                        <div key={example.prompt} role="listitem" className="shrink-0 snap-start" style={{ width: cardWidth }}>
                            <button
                                type="button"
                                data-example-card={example.title}
                                aria-label={`Use the prompt: ${example.prompt}`}
                                onClick={() => onPick(example.prompt)}
                                className="block w-full overflow-hidden rounded-2xl border border-border/70 bg-sidebar text-left shadow-sm transition hover:-translate-y-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                {/* A 16:10 cover, so the row's height is known from its width alone. */}
                                <div
                                    className="flex aspect-[16/10] items-center justify-center border-b border-border/70"
                                    style={{
                                        background: `linear-gradient(135deg, hsl(${example.hue} 70% 60% / 0.22), hsl(${example.hue} 70% 50% / 0.06))`,
                                    }}
                                >
                                    <Icon
                                        className="h-1/3 w-1/3 max-h-12 max-w-12 text-foreground/70"
                                        strokeWidth={1.25}
                                        aria-hidden
                                    />
                                </div>
                                <div className="truncate px-3 py-2 text-[13px] font-medium text-foreground">{example.title}</div>
                            </button>
                        </div>
                    );
                })}
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
