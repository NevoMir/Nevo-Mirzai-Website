import { useEffect, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";

import { Section } from "@/assignment/components/analysis/atoms";
import { Slider } from "@/assignment/components/ui/slider";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { DEFAULT_ANALYSIS_SETTINGS } from "@/assignment/analysis/types";
import { BUDGET_RANGE, FILL_RANGE, LIMIT_RANGE, sameSettings } from "@/assignment/store/analysisLogic";

// The native spinner arrows would sit on top of the digits in a box this narrow.
const fieldClass =
    "h-8 w-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none rounded-md border border-input bg-background px-2 text-right font-mono text-base tabular-nums md:text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A whole-number box that applies every valid value as it is typed and puts the stored value back on blur.
 * `null` (an empty box) is a value only when `nullable`.
 */
function NumberField({
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

/** The knobs of the analysis. A change re-runs it after a short pause and is remembered in this browser. */
export function SettingsSection() {
    const settings = useAnalysisStore((s) => s.settings);
    const update = useAnalysisStore((s) => s.updateSettings);
    const reset = useAnalysisStore((s) => s.resetSettings);
    const isDefault = sameSettings(settings, DEFAULT_ANALYSIS_SETTINGS);
    const fillPct = Math.round(settings.fillThreshold * 100);

    return (
        <Section title="Analysis settings" icon={SlidersHorizontal} defaultOpen={false} testId="analysis-settings">
            <div className="space-y-4">
                <div>
                    <div className="mb-1.5 flex items-baseline justify-between">
                        <label htmlFor="analysis-fill" className="text-xs font-medium text-foreground">
                            Fill threshold
                        </label>
                        <span className="font-mono text-xs font-semibold tabular-nums text-foreground">{fillPct}%</span>
                    </div>
                    <Slider
                        id="analysis-fill"
                        min={Math.round(FILL_RANGE.min * 100)}
                        max={Math.round(FILL_RANGE.max * 100)}
                        step={Math.round(FILL_RANGE.step * 100)}
                        value={[fillPct]}
                        onValueChange={([value]) => update({ fillThreshold: value / 100 })}
                        aria-valuetext={`${fillPct} percent`}
                    />
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                        A 100 mm cell becomes a block when the model fills at least {fillPct}% of it. Lower keeps thin parts but adds
                        blocks; higher drops them.
                    </p>
                </div>

                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <label htmlFor="analysis-limit" className="text-xs font-medium text-foreground">
                            Cantilever limit
                        </label>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                            How far a part may reach past its last support, in horizontal block steps along the structure (a
                            step across a corner counts as one).
                        </p>
                    </div>
                    <NumberField
                        id="analysis-limit"
                        value={settings.cantileverLimit}
                        min={LIMIT_RANGE.min}
                        max={LIMIT_RANGE.max}
                        onCommit={(value) => value !== null && update({ cantileverLimit: value })}
                    />
                </div>

                <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <label htmlFor="analysis-budget" className="text-xs font-medium text-foreground">
                            Component budget
                        </label>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                            The most blocks you can use. Leave empty for no limit.
                        </p>
                    </div>
                    <NumberField
                        id="analysis-budget"
                        value={settings.maxBlocks}
                        min={BUDGET_RANGE.min}
                        max={BUDGET_RANGE.max}
                        nullable
                        placeholder="No limit"
                        onCommit={(value) => update({ maxBlocks: value })}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        Target volume <span className="font-mono text-foreground">{settings.targetSizeMm} mm</span>
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        Block <span className="font-mono text-foreground">{settings.blockSizeMm} mm</span>
                    </span>
                    <button
                        type="button"
                        onClick={reset}
                        disabled={isDefault}
                        className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                    >
                        <RotateCcw className="h-3 w-3" aria-hidden />
                        Reset
                    </button>
                </div>
            </div>
        </Section>
    );
}
