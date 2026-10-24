import type { ComponentType } from "react";
import { Armchair, Bike, Bot, Coffee, Fan, LampDesk, type LucideProps } from "lucide-react";

import { CardStrip } from "@/assignment/components/chat/CardStrip";

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
 * The new-chat example row, modelled on Cably's template carousel: cards in one horizontally
 * scrollable strip (CardStrip). A card does not open anything: it puts its prompt in the composer,
 * ready to edit or send.
 */
export function ExamplePrompts({ onPick, className = "" }: { onPick: (prompt: string) => void; className?: string }) {
    return (
        <CardStrip
            label="Example prompts"
            testId="example-prompts"
            className={className}
            items={EXAMPLES.map((example) => {
                const Icon = example.icon;
                return {
                    key: example.prompt,
                    node: (
                        <button
                            type="button"
                            data-example-card={example.title}
                            data-strip-card
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
                    ),
                };
            })}
        />
    );
}
