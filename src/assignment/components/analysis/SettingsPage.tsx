import { useMemo, type ReactNode } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisResult } from "@/assignment/analysis/types";
import { Segmented } from "@/assignment/components/analysis/atoms";
import { AimField, FieldRow, NumberField } from "@/assignment/components/analysis/fields";
import { MATERIAL_FACTS } from "@/assignment/components/analysis/stressText";
import { TONE, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { Button } from "@/assignment/components/ui/button";
import { Slider } from "@/assignment/components/ui/slider";
import { cn } from "@/assignment/lib/utils";
import { MATERIAL_IDS, type MaterialId } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { verdictSentence, type VerdictSentence } from "@/assignment/store/analysisBrief";
import { BUDGET_RANGE, FILL_RANGE, LIMIT_RANGE, sameSettings, type Verdict } from "@/assignment/store/analysisLogic";

const MATERIAL_OPTIONS = MATERIAL_IDS.map((id) => ({ value: id, label: MATERIAL_FACTS[id].label }));

function Group({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-4">
            <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
            {children}
        </section>
    );
}

/**
 * The knobs, on a page of their own: the analysis's (a change re-runs it after a short pause and is remembered in this browser) and
 * the stabilizer's aim. The one-line answer at the top moves as the knobs do, so the effect of a change is seen where it is made.
 * The block budget is one setting: the answer and the stabilizer both read it.
 */
export function SettingsPage({
    result,
    verdict,
    sentence: given = null,
    updating,
}: {
    result: AnalysisResult | null;
    verdict: Verdict | null;
    /** The snapshot's sentence for this result; worked out here when the caller has none. */
    sentence?: VerdictSentence | null;
    updating: boolean;
}) {
    const settings = useAnalysisStore((s) => s.settings);
    const update = useAnalysisStore((s) => s.updateSettings);
    const reset = useAnalysisStore((s) => s.resetSettings);
    const isDefault = sameSettings(settings, DEFAULT_ANALYSIS_SETTINGS);
    const fillPct = Math.round(settings.fillThreshold * 100);
    const sentence = useMemo(() => given ?? (result ? verdictSentence(result) : null), [given, result]);
    const tone = TONE[verdict ? VERDICT_TONE[verdict.kind] : "muted"];

    return (
        <div className="space-y-5 px-4 py-4" data-testid="analysis-settings">
            {/* The answer as it stands with these settings. */}
            <p
                role="status"
                className={cn("flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[13px] font-medium leading-snug", verdict ? [tone.soft, tone.border, tone.text] : "border-border/70 bg-card text-muted-foreground")}
                data-testid="settings-verdict"
            >
                {updating && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
                <span>{updating ? "Updating…" : (sentence?.text ?? "The answer shows here once the model has been checked.")}</span>
            </p>

            <Group title="Analysis">
                <FieldRow htmlFor="analysis-limit" label="Longest allowed overhang" hint="How far a part may stick out past its last support, counted in blocks along the structure.">
                    <NumberField
                        id="analysis-limit"
                        value={settings.cantileverLimit}
                        min={LIMIT_RANGE.min}
                        max={LIMIT_RANGE.max}
                        onCommit={(value) => value !== null && update({ cantileverLimit: value })}
                    />
                </FieldRow>

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
                        How full a {settings.blockSizeMm} mm cell must be to become a block. Lower keeps thin parts but adds blocks; higher drops them.
                    </p>
                </div>

                <FieldRow htmlFor="analysis-budget" label="Block budget" hint="The most blocks you can use, in all. The stabilizer keeps to it too. Leave empty for no limit.">
                    <NumberField
                        id="analysis-budget"
                        value={settings.maxBlocks}
                        min={BUDGET_RANGE.min}
                        max={BUDGET_RANGE.max}
                        nullable
                        placeholder="No limit"
                        onCommit={(value) => update({ maxBlocks: value })}
                    />
                </FieldRow>

                <div>
                    <p className="mb-1.5 text-xs font-medium text-foreground">Material</p>
                    <Segmented<MaterialId> label="Material" value={settings.material} options={MATERIAL_OPTIONS} onChange={(material) => update({ material })} />
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="material-detail">
                        {MATERIAL_FACTS[settings.material].detail}. What the blocks are made of decides how much a joint takes; it changes the strength estimate, not which
                        blocks there are.
                    </p>
                </div>
            </Group>

            <Group title="When stabilizing">
                <AimField id="settings-target" />
            </Group>

            <div className="flex items-center gap-2 border-t border-border/60 pt-3">
                <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground" data-testid="settings-fixed">
                    Model scaled to {settings.targetSizeMm} mm, blocks {settings.blockSizeMm} mm (set by the assignment).
                </p>
                <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={isDefault} className="h-11 shrink-0 gap-1 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 hover:text-primary md:h-8" data-testid="settings-reset">
                    <RotateCcw />
                    Reset
                </Button>
            </div>
        </div>
    );
}
