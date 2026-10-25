// The input fields the panel shares: the settings page and the stabilizer's "aim for" box both use them.

import { useEffect, useState, type ReactNode } from "react";

import { Slider } from "@/assignment/components/ui/slider";
import { cn } from "@/assignment/lib/utils";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { TARGET_RANGE } from "@/assignment/store/stabilizeLogic";

// The native spinner arrows would sit on top of the digits in a box this narrow.
const fieldClass =
    "h-8 w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none rounded-md border border-input bg-background px-2 text-right font-mono text-base tabular-nums md:text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A whole-number box that applies every valid value as it is typed and puts the stored value back on blur.
 * `null` (an empty box) is a value only when `nullable`.
 */
export function NumberField({
    id,
    value,
    min,
    max,
    nullable = false,
    placeholder,
    onCommit,
}: {
    id: string;
    value: number | null;
    min: number;
    max: number;
    nullable?: boolean;
    placeholder?: string;
    onCommit: (value: number | null) => void;
}) {
    const show = (v: number | null) => (v === null ? "" : String(v));
    const [text, setText] = useState(show(value));
    // The stored value changed from elsewhere (Reset): follow it.
    useEffect(() => setText(show(value)), [value]);

    const invalid = text.trim() !== "" && !(Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max);
    return (
        <input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={text}
            placeholder={placeholder}
            aria-invalid={invalid}
            className={cn(fieldClass, invalid && "border-destructive")}
            onChange={(event) => {
                const next = event.target.value;
                setText(next);
                if (next.trim() === "") {
                    if (nullable) onCommit(null);
                    return;
                }
                const n = Number(next);
                if (Number.isInteger(n) && n >= min && n <= max) onCommit(n);
            }}
            onBlur={() => setText(show(value))}
        />
    );
}

/** A label, its one-line explanation and the control, side by side. */
export function FieldRow({ htmlFor, label, hint, children }: { htmlFor: string; label: string; hint: ReactNode; children: ReactNode }) {
    return (
        <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
                <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
                    {label}
                </label>
                <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
            </div>
            {children}
        </div>
    );
}

/**
 * "Aim for strength used below": how far down the stabilizer pushes the load on the joints. Held by the stabilizer's store,
 * so the Stabilize button and the settings page are one setting. The range stops at the warning level: a higher target would
 * let a run end "complete" while the report still warns.
 */
export function AimField({ id, className }: { id: string; className?: string }) {
    const target = useStabilizeStore((s) => s.choices.target);
    const setChoices = useStabilizeStore((s) => s.setChoices);
    const pct = Math.round(target * 100);
    return (
        <div className={className}>
            <div className="mb-1.5 flex items-baseline justify-between">
                <label htmlFor={id} className="text-xs font-medium text-foreground">
                    Aim for strength used below
                </label>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{pct}%</span>
            </div>
            <Slider
                id={id}
                min={Math.round(TARGET_RANGE.min * 100)}
                max={Math.round(TARGET_RANGE.max * 100)}
                step={Math.round(TARGET_RANGE.step * 100)}
                value={[pct]}
                onValueChange={([value]) => setChoices({ target: value / 100 })}
                aria-valuetext={`${pct} percent of what a joint takes`}
            />
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                It adds blocks until no joint carries more than this share of what it takes. Lower asks for more blocks. {Math.round(TARGET_RANGE.max * 100)}% is the
                highest aim, because the report warns above it.
            </p>
        </div>
    );
}
