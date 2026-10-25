// Small building blocks of the report panel.

import { type KeyboardEvent, type ReactNode } from "react";
import { type LucideIcon } from "lucide-react";

import { MARK_ICON, MARK_TONE, MARK_WORD, TONE, type Mark, type Tone } from "@/assignment/components/analysis/style";
import { cn } from "@/assignment/lib/utils";

/** A mark as a symbol (tick, cross, warning triangle, dot) in its tone, with its word for a screen reader. */
export function MarkGlyph({ mark, className, label }: { mark: Mark; className?: string; label?: string }) {
    const Icon = MARK_ICON[mark];
    return (
        <span role="img" aria-label={label ?? MARK_WORD[mark]} data-mark={mark} className={cn("inline-grid shrink-0 place-items-center", TONE[MARK_TONE[mark]].icon, className)}>
            <Icon className="h-full w-full" strokeWidth={mark === "none" ? 5 : 3} aria-hidden />
        </span>
    );
}

/** A count next to a section caption. */
export function CountBadge({ tone = "muted", children, label }: { tone?: Tone; children: ReactNode; label?: string }) {
    const t = TONE[tone];
    return (
        <span
            aria-label={label}
            className={cn(
                "rounded-full border px-1.5 text-[10px] font-medium normal-case leading-4 tracking-normal",
                t.soft,
                t.border,
                t.text,
            )}
        >
            {children}
        </span>
    );
}

/** One choice of a Segmented control. A disabled one stays focusable and says why in its tooltip. */
export interface SegmentedOption<T extends string> {
    value: T;
    label: string;
    icon?: LucideIcon;
    /** Cannot be picked (the title says why). */
    disabled?: boolean;
    title?: string;
}

/** A row of mutually exclusive options (radio semantics) in one rounded track; `columns` wraps a long list into rows. */
export function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
    columns,
    disabled = false,
}: {
    label: string;
    value: T;
    options: readonly SegmentedOption<T>[];
    onChange: (value: T) => void;
    /** Options per row (default: all in one row). */
    columns?: number;
    /** The whole control is off (the colour is forced by something else). */
    disabled?: boolean;
}) {
    // Radio-group keys: the arrows move the choice (and focus) to the neighbour that can be picked, the way a native group does.
    const move = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (step === 0 || disabled) return;
        event.preventDefault();
        let at = options.findIndex((option) => option.value === value);
        for (let tries = 0; tries < options.length; tries++) {
            at = (at + step + options.length) % options.length;
            if (!options[at].disabled) break;
        }
        const next = options[at];
        if (next.disabled) return;
        onChange(next.value);
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons[at]?.focus();
    };
    return (
        <div
            role="radiogroup"
            aria-label={label}
            aria-disabled={disabled || undefined}
            onKeyDown={move}
            className={cn("grid gap-0.5 rounded-lg bg-muted p-0.5", disabled && "opacity-70")}
            style={{ gridTemplateColumns: `repeat(${Math.min(columns ?? options.length, options.length)}, minmax(0, 1fr))` }}
        >
            {options.map((option) => {
                const on = option.value === value;
                const off = disabled || option.disabled === true;
                const Icon = option.icon;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-disabled={off || undefined}
                        title={option.title}
                        tabIndex={on ? 0 : -1}
                        onClick={() => {
                            if (!off) onChange(option.value);
                        }}
                        className={cn(
                            "flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            on
                                ? "bg-background font-medium text-foreground shadow-sm"
                                : off
                                  ? "cursor-not-allowed text-muted-foreground/50"
                                  : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {Icon && <Icon className="h-3 w-3" aria-hidden />}
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

/** Which way right, left, front and back are, for lines that name a direction. */
export function DirectionsHint({ className }: { className?: string }) {
    return (
        <p className={cn("text-[11px] leading-snug text-muted-foreground", className)} data-testid="directions-hint">
            Right, left, front and back are as the Front view shows them: the front is the side that faces you.
        </p>
    );
}
