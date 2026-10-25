import { useId, useState } from "react";

import { cn } from "@/assignment/lib/utils";
import { CHART_HEIGHT, CHART_WIDTH, PAD, chartPaths, chartSummary, sampleRows } from "@/assignment/components/optimize/chartLogic";
import { kgText, pctText, sagShare, type Focus, type LiveRow } from "@/assignment/store/optimizeLogic";

export interface ConvergenceChartProps {
    rows: readonly LiveRow[];
    kgPerBlock: number;
    /** The strength limit as a share of what a joint takes (0.75), or null. */
    limit: number | null;
    /** The figure the second line follows: the strength used (the default), or the balance or sag when the goal is about that. */
    focus?: Focus;
    className?: string;
}

const FOCUS_WORDS: Record<Focus, { legend: string; column: string }> = {
    strength: { legend: "strength used", column: "Strength used" },
    balance: { legend: "weight inside the base", column: "Weight inside the base" },
    sag: { legend: "sag, against before", column: "Sag" },
};

/**
 * How the run went: the weight falling round by round (with the blocks as the grey area under it) and the strength used rising to its limit. A
 * picture for the eye; "Show numbers" has the same figures as a table.
 */
export function ConvergenceChart({ rows, kgPerBlock, limit, focus = "strength", className }: ConvergenceChartProps) {
    const [table, setTable] = useState(false);
    const id = useId();
    const paths = chartPaths(rows, kgPerBlock, limit, undefined, undefined, undefined, focus);
    const summary = chartSummary(rows, kgPerBlock, limit, focus);
    const floor = CHART_HEIGHT - PAD.bottom;
    const sample = sampleRows(rows, 12);
    return (
        <figure className={cn("m-0", className)} data-testid="optimize-chart">
            <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="block h-auto w-full text-foreground" role="img" aria-label={summary}>
                <title>{summary}</title>
                {/* the weight axis: three marks and their faint lines */}
                {paths.ticks.map((t, n) => (
                    <g key={n}>
                        <line x1={PAD.left} x2={CHART_WIDTH - PAD.right} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={0.5} />
                        <text x={PAD.left - 4} y={t.y + 3} textAnchor="end" className="fill-muted-foreground" fontSize={9}>
                            {t.text}
                        </text>
                    </g>
                ))}
                <text x={2} y={9} className="fill-muted-foreground" fontSize={8}>
                    kg
                </text>
                <text x={CHART_WIDTH - 2} y={9} textAnchor="end" className="fill-muted-foreground" fontSize={8}>
                    {paths.rightTitle}
                </text>
                {[1, 0.5, 0].map((u, n) => (
                    <text key={u} x={CHART_WIDTH - PAD.right + 4} y={PAD.top + (CHART_HEIGHT - PAD.top - PAD.bottom) * (1 - u) + 3} className="fill-muted-foreground" fontSize={9}>
                        {paths.rightTicks[n]}
                    </text>
                ))}
                <line x1={PAD.left} x2={CHART_WIDTH - PAD.right} y1={floor} y2={floor} className="stroke-muted-foreground/50" strokeWidth={0.75} />
                {rows.length > 0 && (
                    <>
                        <path d={paths.area} className="fill-muted-foreground/20" data-series="blocks" />
                        <path d={paths.weight} fill="none" className="stroke-foreground" strokeWidth={1.5} strokeLinejoin="round" data-series="weight" />
                        {paths.limitY !== null && <line x1={PAD.left} x2={CHART_WIDTH - PAD.right} y1={paths.limitY} y2={paths.limitY} className="stroke-primary" strokeWidth={1} strokeDasharray="3 3" opacity={0.7} data-series="limit" />}
                        {paths.strength && <path d={paths.strength} fill="none" className="stroke-primary" strokeWidth={1.5} strokeLinejoin="round" data-series="strength" />}
                        {paths.end && <circle cx={paths.end.x} cy={paths.end.y} r={2.5} className="fill-foreground" />}
                    </>
                )}
                <text x={PAD.left} y={CHART_HEIGHT - 3} className="fill-muted-foreground" fontSize={9}>
                    round
                </text>
            </svg>
            <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                    <span aria-hidden className="inline-block h-0.5 w-3 bg-foreground" />
                    weight
                </span>
                <span className="flex items-center gap-1">
                    <span aria-hidden className="inline-block h-0.5 w-3 bg-primary" />
                    {FOCUS_WORDS[focus].legend}
                </span>
                {limit !== null && focus === "strength" && (
                    <span className="flex items-center gap-1">
                        <span aria-hidden className="inline-block w-3 border-t border-dashed border-primary" />
                        limit {pctText(limit)}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setTable((v) => !v)}
                    aria-expanded={table}
                    aria-controls={id}
                    className="ml-auto rounded-sm px-1 text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="optimize-chart-numbers"
                >
                    {table ? "Hide numbers" : "Show numbers"}
                </button>
            </figcaption>
            <div id={id} hidden={!table}>
                {table && (
                    <table className="mt-1.5 w-full text-left text-[11px] tabular-nums" data-testid="optimize-chart-table">
                        <thead className="text-muted-foreground">
                            <tr>
                                <th className="py-0.5 pr-2 font-medium">Round</th>
                                <th className="py-0.5 pr-2 font-medium">Blocks</th>
                                <th className="py-0.5 pr-2 font-medium">Weight</th>
                                <th className="py-0.5 font-medium">{FOCUS_WORDS[focus].column}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sample.map((r) => (
                                <tr key={r.iteration}>
                                    <td className="py-0.5 pr-2">{r.iteration}</td>
                                    <td className="py-0.5 pr-2">{r.blocks}</td>
                                    <td className="py-0.5 pr-2">{kgText(r.blocks * kgPerBlock)}</td>
                                    <td className="py-0.5">{focus === "strength" ? pctText(r.util) : focus === "balance" ? (r.margin === null ? "n/a" : `${Math.round(r.margin)} mm`) : pctText(sagShare(r.deflection, rows[0]?.deflection))}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </figure>
    );
}
