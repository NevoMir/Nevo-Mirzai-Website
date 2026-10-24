/**
 * What the block colours mean, on the stage beside the blocks: the four statuses with their counts, the reach
 * ramp against the cantilever limit, or the layer ramp. The swatches are drawn from the very functions the 3D
 * view colours blocks with, so the two cannot drift apart.
 */
import type { AnalysisColorBy, AnalysisResult, BlockStatus } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";
import { STATUS_LABELS, countByStatus, layerColor, reachColor, statusColor, topLayer } from "./analysisGeometry.ts";
import type { ViewTheme } from "./types.ts";

const STATUSES: BlockStatus[] = ["supported", "cantilever", "overreach", "floating"];

const Swatch = ({ color }: { color: string }) => <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/25" style={{ background: color }} />;

const Ramp = ({ colors }: { colors: string[] }) => <span aria-hidden className="inline-block h-2 w-16 rounded-sm ring-1 ring-black/20" style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }} />;

export function AnalysisLegend({ analysis, colorBy, theme, className }: { analysis: AnalysisResult; colorBy: AnalysisColorBy; theme: ViewTheme; className?: string }) {
    const limit = analysis.settings.cantileverLimit;
    const counts = countByStatus(analysis.blocks);
    const layers = Math.max(1, topLayer(analysis.blocks) + 1);
    const box = cn("flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-background/85 px-2 py-1 text-[11px] text-foreground shadow-sm backdrop-blur", className);

    if (colorBy === "status") {
        return (
            <ul role="group" aria-label="Block colours: status" className={box}>
                {STATUSES.map((status) => (
                    <li key={status} className={cn("flex items-center gap-1.5", counts[status] === 0 && status !== "supported" && "text-muted-foreground")}>
                        <Swatch color={statusColor(status, theme)} />
                        {STATUS_LABELS[status]}
                        <span className="tabular-nums text-muted-foreground">{counts[status]}</span>
                    </li>
                ))}
            </ul>
        );
    }

    if (colorBy === "reach") {
        const steps = Array.from({ length: limit }, (_, i) => reachColor(i + 1, limit));
        return (
            <div role="group" aria-label="Block colours: blocks from support" className={box}>
                <span className="flex items-center gap-1.5">
                    <Swatch color={statusColor("supported", theme)} />
                    On a support
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="tabular-nums text-muted-foreground">1</span>
                    <Ramp colors={steps.length > 1 ? steps : [steps[0], steps[0]]} />
                    <span className="tabular-nums text-muted-foreground">{limit} blocks out</span>
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch color={reachColor(limit + 1, limit)} />
                    Over the limit
                </span>
                {counts.floating > 0 && (
                    <span className="flex items-center gap-1.5">
                        <Swatch color={statusColor("floating", theme)} />
                        Floating
                    </span>
                )}
            </div>
        );
    }

    const stops = Array.from({ length: Math.min(layers, 12) }, (_, i) => layerColor(Math.round((i / Math.max(1, Math.min(layers, 12) - 1)) * (layers - 1)), layers));
    return (
        <div role="group" aria-label="Block colours: layer" className={box}>
            <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Layer</span>
                <span className="tabular-nums">1</span>
                <Ramp colors={stops.length > 1 ? stops : [stops[0], stops[0]]} />
                <span className="tabular-nums">{layers}</span>
            </span>
            <span className="text-muted-foreground">{layers} × {analysis.settings.blockSizeMm} mm</span>
        </div>
    );
}
