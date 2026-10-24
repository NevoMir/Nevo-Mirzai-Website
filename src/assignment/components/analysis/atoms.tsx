// Small building blocks of the report panel.

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Layers, type LucideIcon } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/assignment/components/ui/collapsible";
import { TONE, type Tone } from "@/assignment/components/analysis/style";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";

/** A foldable block of the panel: an uppercase caption with an optional badge, and a chevron. */
export function Section({
    title,
    icon: Icon,
    badge,
    action,
    defaultOpen = true,
    children,
    testId,
}: {
    title: string;
    icon: LucideIcon;
    badge?: ReactNode;
    /** Right-aligned control that must not toggle the section (e.g. "Clear"). */
    action?: ReactNode;
    defaultOpen?: boolean;
    children: ReactNode;
    testId?: string;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/60" data-testid={testId}>
            <div className="flex items-center gap-2 pr-3">
                <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-4 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground">
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{title}</span>
                    {badge}
                    <ChevronDown
                        className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=closed]:-rotate-90"
                        aria-hidden
                    />
                </CollapsibleTrigger>
                {action}
            </div>
            <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
        </Collapsible>
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

/** A compact on/off switch with a label and a one-line explanation; the whole text is the click target. */
export function ToggleRow({
    label,
    hint,
    checked,
    onChange,
}: {
    label: string;
    hint: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}) {
    const id = useId();
    return (
        <div className="flex items-center gap-3">
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-xs font-medium text-foreground">{label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>
            </label>
            <button
                id={id}
                type="button"
                role="switch"
                aria-checked={checked}
                onClick={() => onChange(!checked)}
                className={cn(
                    "relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    checked ? "bg-primary" : "bg-input",
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        "absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform",
                        checked && "translate-x-3.5",
                    )}
                />
            </button>
        </div>
    );
}

/** A row of mutually exclusive options (radio semantics) in one rounded track. */
export function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: readonly { value: T; label: string; icon?: LucideIcon }[];
    onChange: (value: T) => void;
}) {
    // Radio-group keys: the arrows move the choice (and focus) to the neighbour, the way a native group does.
    const move = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const index = options.findIndex((option) => option.value === value);
        const next = options[(index + step + options.length) % options.length];
        onChange(next.value);
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
        buttons[options.indexOf(next)]?.focus();
    };
    return (
        <div
            role="radiogroup"
            aria-label={label}
            onKeyDown={move}
            className="grid gap-0.5 rounded-lg bg-muted p-0.5"
            style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
            {options.map((option) => {
                const on = option.value === value;
                const Icon = option.icon;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        tabIndex={on ? 0 : -1}
                        onClick={() => onChange(option.value)}
                        className={cn(
                            "flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            on
                                ? "bg-background font-medium text-foreground shadow-sm"
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

/** A number in the metrics grid: caption, value in the mono face, one line of context. */
export function Metric({
    label,
    value,
    unit,
    hint,
    tone = "muted",
    className,
    title,
    testId,
}: {
    label: string;
    value: ReactNode;
    unit?: string;
    hint?: string;
    tone?: Tone;
    className?: string;
    title?: string;
    testId?: string;
}) {
    const valueClass = tone === "muted" ? "text-foreground" : TONE[tone].text;
    return (
        <div
            title={title}
            data-testid={testId}
            className={cn("rounded-lg border border-border/70 bg-card/60 px-2.5 py-2", className)}
        >
            <p className="text-[11px] text-muted-foreground">{label}</p>
            <p className={cn("mt-0.5 font-mono text-sm font-semibold tabular-nums", valueClass)}>
                {value}
                {unit && <span className="ml-0.5 text-[11px] font-normal text-muted-foreground">{unit}</span>}
            </p>
            {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
        </div>
    );
}

/**
 * The last pick would have been hidden by the layer cut, so the cut was raised to show it. Said where the pick is
 * made, so the slider's new position is no surprise.
 */
export function LayerRaisedNote({ className }: { className?: string }) {
    const raised = useAnalysisStore((s) => s.layerRaised);
    const layerMax = useAnalysisStore((s) => s.view.layerMax);
    if (!raised) return null;
    return (
        <p
            role="status"
            data-testid="layer-raised-note"
            className={cn("flex items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-[11px] text-muted-foreground", className)}
        >
            <Layers className="h-3 w-3 shrink-0" aria-hidden />
            Layer cut raised to layer {layerMax + 1} to show this.
        </p>
    );
}

/** Which way +X, -Y and +Z point, for report lines that name a direction. */
export function DirectionsHint({ className }: { className?: string }) {
    return (
        <p className={cn("text-[11px] leading-snug text-muted-foreground", className)} data-testid="directions-hint">
            Directions: <span className="font-mono text-foreground">+X</span> is right and <span className="font-mono text-foreground">−Y</span> is
            towards you in the Front view; <span className="font-mono text-foreground">+Z</span> is up.
        </p>
    );
}
