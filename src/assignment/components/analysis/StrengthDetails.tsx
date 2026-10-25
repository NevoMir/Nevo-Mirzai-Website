import { useState } from "react";
import { Eye } from "lucide-react";

import type { AnalysisResult, StressPoint } from "@/assignment/analysis/types";
import { MarkGlyph } from "@/assignment/components/analysis/atoms";
import { POINTS_SHOWN, pointWhere, stressPointLabel } from "@/assignment/components/analysis/panelLogic";
import { MATERIAL_FACTS } from "@/assignment/components/analysis/stressText";
import { MARK_TONE, TONE, type Mark } from "@/assignment/components/analysis/style";
import { STRESS_MODE_TECH, STRESS_MODE_WORDS } from "@/assignment/components/analysis/vocabulary";
import { useIsDark } from "@/assignment/hooks/useIsDark";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { fmtPct, plural } from "@/assignment/store/analysisLogic";
import { STRESS_FAIL_SHARE, STRESS_RAMP_MAX, STRESS_WARN_SHARE, percentText, stressBands, stressColor } from "@/assignment/viewer/analysisGeometry";

/** The tone of a share of what a joint takes: past the limit fails, past the warning level warns. */
const markOf = (u: number): Mark => (u > STRESS_FAIL_SHARE ? "fail" : u > STRESS_WARN_SHARE ? "warn" : "pass");

/** One loaded joint: its rank, how much of what it takes is used, where, what it is going through, and a button that shows its blocks. */
function PointRow({ point, result }: { point: StressPoint; result: AnalysisResult }) {
    const label = stressPointLabel(point);
    const selected = useAnalysisStore((s) => s.selection?.check === "stress" && s.selection.label === label);
    const selectBlocks = useAnalysisStore((s) => s.selectBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const hoverBlock = useAnalysisStore((s) => s.hoverBlock);
    const dark = useIsDark();
    const mark = markOf(point.utilisation);
    const width = Math.min(100, (point.utilisation / STRESS_RAMP_MAX) * 100);
    const toggle = () => {
        if (selected) clearSelection();
        else selectBlocks(point.blocks, { check: "stress", label });
    };
    const where = pointWhere(point, result);
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
                aria-label={`Joint ${point.rank}: ${fmtPct(point.utilisation)} of what it takes, ${STRESS_MODE_WORDS[point.mode]}, ${where}. ${plural(point.blocks.length, "block")}. ${selected ? "Showing in the viewer. Press to clear." : "Press to show it in the viewer."}`}
                className={cn(
                    "group flex min-h-11 w-full items-start gap-2.5 rounded-xl border bg-card px-2.5 py-2 text-left transition-colors md:min-h-0",
                    "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary bg-primary/5 ring-2 ring-primary/40" : "border-border/70",
                )}
            >
                <span aria-hidden className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[10px] font-semibold text-secondary-foreground">
                    {point.rank}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                        <span className={cn("font-mono text-sm font-semibold tabular-nums", TONE[MARK_TONE[mark]].text)}>{percentText(point.utilisation)}</span>
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={STRESS_MODE_TECH[point.mode]}>
                            {STRESS_MODE_WORDS[point.mode]}
                        </span>
                    </span>
                    {/* The bar spans 0 to 150 %; the tick is the limit. */}
                    <span aria-hidden className="relative mt-1.5 block h-1.5 rounded-full bg-muted">
                        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${width}%`, background: stressColor(point.utilisation, dark ? "dark" : "light") }} />
                        <span className="absolute -inset-y-0.5 w-px bg-foreground/50" style={{ left: `${(STRESS_FAIL_SHARE / STRESS_RAMP_MAX) * 100}%` }} />
                    </span>
                    <span className="mt-1.5 block text-[11px] leading-snug text-muted-foreground">{where}</span>
                </span>
                <span
                    className={cn(
                        "mt-0.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                        selected ? "bg-primary/15 text-primary" : "bg-secondary text-secondary-foreground group-hover:bg-primary/15",
                    )}
                >
                    <Eye className="h-3 w-3" aria-hidden />
                    {selected ? "Clear" : "Show"}
                </span>
            </button>
        </li>
    );
}

/** A count of blocks with its mark: a symbol and a word as well as a colour. */
function Count({ mark, value, label, testId }: { mark: Mark; value: number; label: string; testId: string }) {
    return (
        <div data-testid={testId} className="flex-1 rounded-lg border border-border/70 bg-card/60 px-2 py-1.5">
            <p className="flex items-center gap-1 font-mono text-sm font-semibold tabular-nums text-foreground">
                <MarkGlyph mark={mark} className="h-3 w-3" />
                {value}
            </p>
            <p className="text-[10px] leading-tight text-muted-foreground">{label}</p>
        </div>
    );
}

/**
 * "Strength": how much of what its joints take the structure uses under its own weight. One sentence for the scale, three counts
 * of blocks, and the most loaded joints, each with a button that shows its blocks (and paints the model by strength). The caveat
 * is one line, with the way to the full explanation. Without an estimate (nothing stands on the ground) it says why, in one line.
 */
export function StrengthDetails({ result, onAbout }: { result: AnalysisResult; onAbout: () => void }) {
    const stress = result.stress ?? null;
    const [all, setAll] = useState(false);
    if (!stress) {
        const row = result.checks.find((c) => c.key === "stress");
        return (
            <p className="text-xs text-muted-foreground" data-testid="stress-none">
                {row ? `${row.value}. ` : ""}The strength estimate is made for the blocks that stand on the ground.
            </p>
        );
    }
    // The same bands as the stage's legend prints (one word never carries two numbers).
    const { heavy, fine } = stressBands(stress);
    const points = stress.points;
    const listed = all ? points : points.slice(0, POINTS_SHOWN);
    return (
        <div data-testid="analysis-strength-body">
            <p className="text-xs leading-relaxed text-foreground">100% is where a joint would open or crush.</p>
            {/* The counts are blocks, not joints: a joint is the group of them around its worst one, so "12 heavily loaded" sits beside "1 joint" in the answer. */}
            <p className="mt-2 text-[11px] font-medium text-muted-foreground" aria-hidden>
                Blocks by load
            </p>
            <div className="mt-1 flex gap-1.5" role="group" aria-label={`Blocks by how much of what their joints take they use, ${MATERIAL_FACTS[stress.material]?.label ?? stress.material} blocks`}>
                <Count mark={stress.overstressedBlocks > 0 ? "fail" : "none"} value={stress.overstressedBlocks} label="overloaded" testId="stress-over" />
                <Count mark={heavy > 0 ? "warn" : "none"} value={heavy} label="heavily loaded" testId="stress-high" />
                <Count mark="pass" value={fine} label="fine" testId="stress-fine" />
            </div>
            {stress.unsupportedBlocks > 0 && (
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="stress-unsupported">
                    {plural(stress.unsupportedBlocks, "block")} not carrying weight: part of a piece that never touches the ground.
                </p>
            )}

            {points.length > 0 && (
                <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-foreground">Where it is loaded most</p>
                    <ul className="space-y-1.5">
                        {listed.map((point) => (
                            <PointRow key={point.rank} point={point} result={result} />
                        ))}
                    </ul>
                    {points.length > POINTS_SHOWN && (
                        <button
                            type="button"
                            onClick={() => setAll((v) => !v)}
                            aria-expanded={all}
                            data-testid="stress-show-all"
                            className="mt-1.5 flex min-h-11 items-center rounded-md px-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-7"
                        >
                            {all ? "Show fewer" : `Show all ${points.length}`}
                        </button>
                    )}
                </div>
            )}

            <p className="mt-3 text-[11px] leading-snug text-muted-foreground" data-testid="stress-how">
                An estimate for ranking designs, not a certificate.{" "}
                <button type="button" onClick={onAbout} className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    What it assumes
                </button>
            </p>
        </div>
    );
}
