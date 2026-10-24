/**
 * Which version of a stabilized model the stage shows: the model as it is, only the blocks it started from, or both
 * with what was added in its role colours. One segmented control and the counts ("Original 21 · Added 5"), in the
 * chip stack of the block view. It only says what was asked: the workspace swaps the result the viewer is given.
 *
 * The original half is analysed on first use, so for a moment after a click on Original the stage still draws the
 * stabilized model: `pending` marks that moment (the caller keeps `value` at what is on stage and the Original button
 * shows a spinner), so the label never promises numbers the stage does not have.
 */
import { Loader2 } from "lucide-react";
import type { CompareMode } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";

export interface CompareChipProps {
    /** The version on stage; null when none of the three is (the stabilizer's preview is). */
    value: CompareMode | null;
    onChange(mode: CompareMode): void;
    /** Blocks of the model the stabilizer started from. */
    originalCount: number;
    /** Blocks the stabilizer added. */
    addedCount: number;
    /** False when the source blocks cannot be shown on their own (an assembly with none). */
    originalAvailable?: boolean;
    /** The original blocks were asked for and are being analysed: Original shows a spinner and cannot be pressed again. */
    pending?: boolean;
    /** Why the control cannot be used right now (the stabilizer is previewing a run): every button is off and this takes the place of the counts. */
    disabled?: string;
    className?: string;
}

const OPTIONS: ReadonlyArray<{ value: CompareMode; label: string; hint: string }> = [
    { value: "original", label: "Original", hint: "Only the blocks the model started with, analysed on their own" },
    { value: "stabilized", label: "Stabilized", hint: "The stabilized model as it is" },
    { value: "overlay", label: "Overlay", hint: "The stabilized model with what was added in its role colours" },
];

const count = (n: number) => n.toLocaleString("en-US");

export function CompareChip({ value, onChange, originalCount, addedCount, originalAvailable = true, pending = false, disabled: reasonOff, className }: CompareChipProps) {
    const disabled = reasonOff || undefined; // an empty reason is no reason
    return (
        <div
            role="group"
            aria-label="Compare the original and the stabilized model"
            aria-busy={pending || undefined}
            className={cn("pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-background/85 p-0.5 pr-2 text-[11px] text-foreground shadow-sm backdrop-blur", className)}
        >
            <div className="flex rounded bg-muted/70 p-0.5">
                {OPTIONS.map((option) => {
                    const off = option.value === "original" && !originalAvailable;
                    const wait = option.value === "original" && pending;
                    const on = option.value === value;
                    return (
                        <button
                            key={option.value}
                            type="button"
                            aria-pressed={on}
                            disabled={off || wait || !!disabled}
                            title={disabled ?? (off ? "The model has no original blocks to show on their own" : wait ? "Analysing the original blocks…" : option.hint)}
                            className={cn(
                                "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                                on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                                wait && "disabled:opacity-100",
                            )}
                            onClick={() => {
                                if (!on) onChange(option.value);
                            }}
                        >
                            {wait && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                            {option.label}
                        </button>
                    );
                })}
            </div>
            <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                {disabled ?? `Original ${count(originalCount)} · Added ${count(addedCount)}`}
            </span>
            {pending && (
                <span role="status" className="sr-only">
                    Analysing the original blocks
                </span>
            )}
        </div>
    );
}
