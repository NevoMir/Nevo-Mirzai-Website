import { Gauge } from "lucide-react";

import { Metric, Section } from "@/assignment/components/analysis/atoms";
import type { AnalysisResult } from "@/assignment/analysis/types";
import { fmtMm, fmtSignedMm, plural } from "@/assignment/store/analysisLogic";

/** The numbers behind the verdict. */
export function MetricsSection({ result }: { result: AnalysisResult }) {
    const { stats, stability, settings } = result;
    const limit = settings.cantileverLimit;
    const budget = settings.maxBlocks;
    const overBudget = budget !== null && stats.blockCount > budget;
    const cog = stability?.cogMm ?? null;

    return (
        <Section title="Metrics" icon={Gauge} testId="analysis-metrics">
            <div className="grid grid-cols-2 gap-2">
                <Metric
                    label="Blocks used"
                    value={stats.blockCount}
                    unit={budget !== null ? `/ ${budget}` : undefined}
                    tone={overBudget ? "fail" : "muted"}
                    hint={budget !== null ? (overBudget ? "Over the budget" : "Within the budget") : `${plural(stats.layers, "layer")} high`}
                    title="Components needed to build the design: one per 100 mm block"
                    testId="metric-blocks"
                />
                <Metric
                    label="Structures"
                    value={stats.bodyCount}
                    hint={stats.floatingCount > 0 ? `${plural(stats.floatingCount, "block")} floating` : "All connected to the ground"}
                    tone={stats.floatingCount > 0 ? "fail" : "muted"}
                    title="Groups of blocks that touch face to face"
                    testId="metric-bodies"
                />
                <Metric
                    label="Cantilevered blocks"
                    value={stats.cantileveredCount}
                    hint={stats.cantileveredCount > 0 ? "Nothing underneath" : "None"}
                    title="Blocks with nothing underneath, held from the side"
                    testId="metric-cantilevered"
                />
                <Metric
                    label="Longest cantilever"
                    value={stats.longestCantilever}
                    unit={`/ ${limit}`}
                    tone={stats.longestCantilever > limit ? "fail" : "muted"}
                    hint={stats.longestCantilever > limit ? `${plural(stats.overLimitCount, "block")} too far` : "blocks from a support"}
                    title="How far a block hangs out sideways from its last support, against the limit"
                    testId="metric-longest"
                />
                <Metric
                    className="col-span-2"
                    label="Centre of gravity"
                    value={
                        cog ? (
                            <span className="flex flex-wrap gap-x-3">
                                <span>
                                    <span className="mr-1 text-[11px] font-normal text-muted-foreground">x</span>
                                    {fmtMm(cog[0])}
                                </span>
                                <span>
                                    <span className="mr-1 text-[11px] font-normal text-muted-foreground">y</span>
                                    {fmtMm(cog[1])}
                                </span>
                                <span>
                                    <span className="mr-1 text-[11px] font-normal text-muted-foreground">z</span>
                                    {fmtMm(cog[2])}
                                </span>
                                <span className="text-[11px] font-normal text-muted-foreground">mm</span>
                            </span>
                        ) : (
                            "—"
                        )
                    }
                    hint={cog ? "Of the blocks that stand on the ground, all weighing the same" : "Nothing touches the ground"}
                    title="Where the weight is centred, measured from the corner of the 1000 mm cube"
                    testId="metric-cog"
                />
                <Metric
                    label="Stability margin"
                    value={stability ? fmtSignedMm(stability.marginMm) : "—"}
                    unit={stability ? "mm" : undefined}
                    tone={stability ? (stability.inside ? "pass" : "fail") : "muted"}
                    hint={stability ? (stability.inside ? "Inside the base" : "Outside the base: it tips") : "No base to stand on"}
                    title="Distance from the centre of gravity (on the floor) to the edge of the base. Plus = inside, minus = outside."
                    testId="metric-margin"
                />
                <Metric
                    label="Coverage"
                    value={Math.round(stats.coverage * 100)}
                    unit="%"
                    hint="Of the model's volume is in blocks"
                    title="Share of the model's solid volume that ended up inside blocks"
                    testId="metric-coverage"
                />
            </div>
        </Section>
    );
}
