/**
 * What the block colours mean, on the stage beside the blocks: the four statuses with their counts, the reach
 * ramp against the cantilever limit, the layer ramp, the stress ramp (with its ticks, the blocks that carry no
 * load and how many joints are over the limits), or the roles of a stabilized model with their counts. The swatches
 * are drawn from the very functions the 3D view colours blocks with, so the two cannot drift apart.
 */
import { BLOCK_ROLES } from "@/assignment/shared/contract";
import type { AnalysisColorBy, AnalysisResult, BlockStatus } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";
import {
    MATERIAL_LABELS,
    ROLE_PLURALS,
    STATUS_LABELS,
    STRESS_FAIL_SHARE,
    STRESS_RAMP_MAX,
    STRESS_TICKS,
    STRESS_WARN_SHARE,
    countByRole,
    countByStatus,
    layerColor,
    percentText,
    reachColor,
    resolveColorBy,
    roleColor,
    statusColor,
    stressColor,
    stressGradientCss,
    topLayer,
} from "./analysisGeometry.ts";
import type { ViewTheme } from "./types.ts";

const STATUSES: BlockStatus[] = ["supported", "cantilever", "overreach", "floating"];

const Swatch = ({ color }: { color: string }) => <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/25" style={{ background: color }} />;

const Ramp = ({ colors }: { colors: string[] }) => <span aria-hidden className="inline-block h-2 w-16 rounded-sm ring-1 ring-black/20" style={{ background: `linear-gradient(to right, ${colors.join(", ")})` }} />;

export function AnalysisLegend({ analysis, colorBy: asked, theme, className }: { analysis: AnalysisResult; colorBy: AnalysisColorBy; theme: ViewTheme; className?: string }) {
    // A colouring the result cannot do (stress without a stress analysis, roles without an assembly) is drawn, and so explained, as status.
    const colorBy = resolveColorBy({ colorBy: asked }, analysis);
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

    if (colorBy === "stress" && analysis.stress) {
        const stress = analysis.stress;
        const material = MATERIAL_LABELS[stress.material] ?? stress.material;
        return (
            <div role="group" aria-label="Block colours: joint stress" className={box}>
                <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">% of allowable joint stress (self-weight, {material})</span>
                    {/* The bar with a tick and a label at 0, 25, 50, 75 and 100%+: the colours are not the only cue. */}
                    <span aria-hidden className="relative block h-[22px] w-40 shrink-0">
                        <span className="absolute inset-x-0 top-0 block h-2 rounded-sm ring-1 ring-black/20" style={{ background: stressGradientCss() }} />
                        {STRESS_TICKS.map((u, i) => (
                            <span key={u} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${(u / STRESS_RAMP_MAX) * 100}%` }}>
                                <span className="block h-2 w-px bg-black/45" />
                                <span className="text-[10px] leading-3 tabular-nums text-muted-foreground">{i === STRESS_TICKS.length - 1 ? `${Math.round(u * 100)}%+` : Math.round(u * 100)}</span>
                            </span>
                        ))}
                    </span>
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch color={stressColor(STRESS_WARN_SHARE)} />
                    Above {percentText(STRESS_WARN_SHARE)}
                    <span className={cn("tabular-nums", stress.stressedBlocks === 0 ? "text-muted-foreground" : "font-medium")}>{stress.stressedBlocks}</span>
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch color={stressColor(STRESS_FAIL_SHARE)} />
                    Above {percentText(STRESS_FAIL_SHARE)}
                    <span className={cn("tabular-nums", stress.overstressedBlocks === 0 ? "text-muted-foreground" : "font-medium")}>{stress.overstressedBlocks}</span>
                </span>
                {stress.unsupportedBlocks > 0 && (
                    <span className="flex items-center gap-1.5">
                        <Swatch color={stressColor(Number.NaN, theme)} />
                        No load path (floating)
                        <span className="tabular-nums text-muted-foreground">{stress.unsupportedBlocks}</span>
                    </span>
                )}
            </div>
        );
    }

    if (colorBy === "role" && analysis.assembly) {
        const byRole = countByRole(analysis.blocks);
        return (
            <ul role="group" aria-label="Block colours: role" className={box}>
                {BLOCK_ROLES.filter((role) => role === "original" || byRole[role] > 0).map((role) => (
                    <li key={role} className="flex items-center gap-1.5">
                        <Swatch color={roleColor(role, theme)} />
                        {ROLE_PLURALS[role]}
                        <span className="tabular-nums text-muted-foreground">{byRole[role]}</span>
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
