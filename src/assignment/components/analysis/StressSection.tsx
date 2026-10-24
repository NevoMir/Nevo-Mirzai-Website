import { useMemo } from "react";
import { ChevronRight, Eye, Flame } from "lucide-react";

import { CountBadge, Metric, Section, ToggleRow } from "@/assignment/components/analysis/atoms";
import { MATERIAL_FACTS, STRESS_CAVEAT, STRESS_LOAD_CASE, materialLine, pointLine, solverLine } from "@/assignment/components/analysis/stressText";
import { TONE } from "@/assignment/components/analysis/style";
import { StressLegend } from "@/assignment/components/analysis/ViewSection";
import type { AnalysisResult, StressPoint } from "@/assignment/analysis/types";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/assignment/components/ui/collapsible";
import { useIsDark } from "@/assignment/hooks/useIsDark";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { fmtMm, fmtPct, plural } from "@/assignment/store/analysisLogic";
import { STRESS_FAIL_SHARE, STRESS_RAMP_MAX, STRESS_WARN_SHARE, percentText, stressColor } from "@/assignment/viewer/analysisGeometry";

const cellText = (c: readonly number[]): string => `(${c.join(", ")})`;

/** The tone of a share of the allowable: over the limit fails, over the warning level warns. */
function toneOf(u: number): "fail" | "warn" | "pass" {
    return u > STRESS_FAIL_SHARE ? "fail" : u > STRESS_WARN_SHARE ? "warn" : "pass";
}

/** One stress point: its rank, a bar, what governs, and a button that shows its blocks. */
function PointRow({ point, result }: { point: StressPoint; result: AnalysisResult }) {
    const label = `Stress point ${point.rank}: ${fmtPct(point.utilisation)}`;
    const selected = useAnalysisStore((s) => s.selection?.check === "stress" && s.selection.label === label);
    const selectBlocks = useAnalysisStore((s) => s.selectBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const hoverBlock = useAnalysisStore((s) => s.hoverBlock);
    const dark = useIsDark();
    const tone = TONE[toneOf(point.utilisation)];
    const width = Math.min(100, (point.utilisation / STRESS_RAMP_MAX) * 100);
    const toggle = () => {
        if (selected) clearSelection();
        else selectBlocks(point.blocks, { check: "stress", label });
    };
    const peak = result.blocks[point.blocks[0]];
    return (
        <li data-testid="stress-point" data-rank={point.rank}>
            <button
                type="button"
                onClick={toggle}
                onPointerEnter={() => hoverBlock(point.blocks[0])}
                onPointerLeave={() => hoverBlock(null)}
                onFocus={() => hoverBlock(point.blocks[0])}
                onBlur={() => hoverBlock(null)}
                aria-pressed={selected}
                aria-label={`${label} of the allowable. ${pointLine(point)}. ${plural(point.blocks.length, "block")}. ${selected ? "Showing in the viewer. Press to clear." : "Press to show it in the viewer."}`}
                className={cn(
                    "group flex w-full items-start gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left transition-colors",
                    "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary bg-primary/5 ring-2 ring-primary/40" : "border-border/70",
                )}
            >
                <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[10px] font-semibold text-secondary-foreground">
                    {point.rank}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                        <span className={cn("font-mono text-sm font-semibold tabular-nums", tone.text)}>{percentText(point.utilisation)}</span>
                        <span className="text-[11px] text-muted-foreground">of the allowable{peak ? ` · z ${fmtMm(peak.cell[2] * result.settings.blockSizeMm)}–${fmtMm((peak.cell[2] + 1) * result.settings.blockSizeMm)} mm` : ""}</span>
                    </span>
                    {/* The bar spans 0 to 150 %; the tick is the limit. */}
                    <span aria-hidden className="relative mt-1.5 block h-1.5 rounded-full bg-muted">
                        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${width}%`, background: stressColor(point.utilisation, dark ? "dark" : "light") }} />
                        <span className="absolute -inset-y-0.5 w-px bg-foreground/50" style={{ left: `${(STRESS_FAIL_SHARE / STRESS_RAMP_MAX) * 100}%` }} />
                    </span>
                    <span className="mt-1.5 block text-[11px] leading-snug text-muted-foreground">{pointLine(point)}</span>
                </span>
                <span
                    className={cn(
                        "mt-0.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                        selected ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground group-hover:bg-primary/15",
                    )}
                >
                    <Eye className="h-3 w-3" aria-hidden />
                    {selected ? "Clear" : "Show"}
                </span>
            </button>
        </li>
    );
}

/** The footer: how the numbers were made and what they are worth. */
function HowEstimated({ result }: { result: AnalysisResult }) {
    const stress = result.stress;
    if (!stress) return null;
    return (
        <Collapsible className="mt-3 rounded-lg border border-border/70 bg-muted/40" data-testid="stress-how">
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                How this is estimated
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1.5 px-2.5 pb-2.5 pl-[26px] text-[11px] leading-relaxed text-muted-foreground">
                <p>{STRESS_LOAD_CASE}</p>
                <p>
                    Material: {materialLine(stress.material)}. {solverLine(stress.solver)}
                </p>
                <p>{STRESS_CAVEAT}</p>
            </CollapsibleContent>
        </Collapsible>
    );
}

/**
 * Where the structure is stressed under its own weight: the peak, how many joints are close to or past their limit, and
 * the stress points, each with a button that shows its blocks. Between Problems and View.
 */
export function StressSection({ result }: { result: AnalysisResult }) {
    const stress = result.stress ?? null;
    const row = result.checks.find((c) => c.key === "stress");
    const stressShown = useAnalysisStore((s) => s.view.colorBy === "stress");
    const setColorBy = useAnalysisStore((s) => s.setColorBy);
    const dark = useIsDark();
    const worst = useMemo(() => (stress && stress.maxBlock !== null ? result.blocks[stress.maxBlock] : null), [stress, result.blocks]);

    // No estimate: nothing stands on the ground, or the solver could not run. Say so in one line instead of leaving a gap.
    if (!stress) {
        if (!row) return null;
        return (
            <Section title="Stress" icon={Flame} testId="analysis-stress" defaultOpen={false}>
                <p className="text-xs text-muted-foreground" data-testid="stress-none">
                    {row.value}. Stress is estimated for the blocks that stand on the ground.
                </p>
            </Section>
        );
    }

    const tone = toneOf(stress.maxUtilisation);
    const level = tone === "fail" ? "Over the limit" : tone === "warn" ? "Highly stressed" : "Within the limit";
    const blockMm = result.settings.blockSizeMm;
    return (
        <Section
            title="Stress"
            icon={Flame}
            testId="analysis-stress"
            badge={
                <CountBadge tone={tone} label={`Peak stress ${fmtPct(stress.maxUtilisation)} of the allowable, ${level.toLowerCase()}`}>
                    {percentText(stress.maxUtilisation)}
                </CountBadge>
            }
        >
            {/* The heat map is the stress estimate on the model itself; it is also under View, further down. */}
            <ToggleRow
                label="Colour blocks by stress"
                hint="A heat map on the model: cool where little is carried, hot toward the limit."
                checked={stressShown}
                onChange={(on) => setColorBy(on ? "stress" : "status")}
            />
            {stressShown && (
                <div className="mt-2.5">
                    <StressLegend result={result} theme={dark ? "dark" : "light"} />
                </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
                <Metric
                    className="col-span-2"
                    label="Peak stress"
                    value={percentText(stress.maxUtilisation)}
                    unit="of allowable"
                    tone={tone}
                    hint={
                        worst
                            ? `${level} · at block ${cellText(worst.cell)} · z ${fmtMm(worst.cell[2] * blockMm)}–${fmtMm((worst.cell[2] + 1) * blockMm)} mm`
                            : level
                    }
                    title="The highest share of the allowable joint stress that any block reaches under the structure's own weight"
                    testId="stress-peak"
                />
                <Metric
                    label={`Highly stressed (> ${percentText(STRESS_WARN_SHARE)})`}
                    value={stress.stressedBlocks}
                    unit={stress.stressedBlocks === 1 ? "block" : "blocks"}
                    tone={stress.stressedBlocks > 0 ? "warn" : "muted"}
                    title="Blocks whose most stressed joint is past the warning level"
                    testId="stress-high"
                />
                <Metric
                    label={`Overstressed (> ${percentText(STRESS_FAIL_SHARE)})`}
                    value={stress.overstressedBlocks}
                    unit={stress.overstressedBlocks === 1 ? "block" : "blocks"}
                    tone={stress.overstressedBlocks > 0 ? "fail" : "muted"}
                    title="Blocks whose joint would open or crush"
                    testId="stress-over"
                />
                {stress.unsupportedBlocks > 0 && (
                    <Metric
                        className="col-span-2"
                        label="No load path"
                        value={stress.unsupportedBlocks}
                        unit={stress.unsupportedBlocks === 1 ? "block" : "blocks"}
                        tone="fail"
                        hint="Part of a structure that never touches the ground: nothing carries its weight"
                        testId="stress-unsupported"
                    />
                )}
            </div>

            {stress.points.length > 0 && (
                <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-foreground">
                        Stress points
                        <span className="font-normal text-muted-foreground"> · {MATERIAL_FACTS[stress.material]?.label ?? stress.material}</span>
                    </p>
                    <ul className="space-y-1.5">
                        {stress.points.map((point) => (
                            <PointRow key={point.rank} point={point} result={result} />
                        ))}
                    </ul>
                </div>
            )}

            <HowEstimated result={result} />
        </Section>
    );
}
