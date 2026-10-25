/**
 * What the block colours mean, on the stage right under the Colour chip (the only legend there is): the four statuses
 * with their counts, the overhang ramp against the longest allowed overhang, the layer ramp, the strength ramp (with
 * its ticks, the blocks that carry no weight, how many are heavily loaded (75-100%) or overloaded (above 100%), and that it counts
 * the model's own weight only), or the added blocks of a stabilized model with their counts. The swatches are drawn from the very
 * functions the 3D view colours blocks with, so the two cannot drift apart.
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
    stressBands,
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
        // The same three bands the report's Strength section prints (the estimate's own count of "stressed" blocks includes the overloaded ones).
        const { over, heavy } = stressBands(stress);
        return (
            <div role="group" aria-label="Block colours: strength used" className={box}>
                <span className="flex items-center gap-2">
                    <span className="text-muted-foreground">Strength used (% of what the joints take)</span>
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
                    Heavily loaded ({Math.round(STRESS_WARN_SHARE * 100)}–{percentText(STRESS_FAIL_SHARE)})
                    <span className={cn("tabular-nums", heavy === 0 ? "text-muted-foreground" : "font-medium")}>{heavy}</span>
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch color={stressColor(STRESS_FAIL_SHARE)} />
                    Overloaded (above {percentText(STRESS_FAIL_SHARE)})
                    <span className={cn("tabular-nums", over === 0 ? "text-muted-foreground" : "font-medium")}>{over}</span>
                </span>
                {stress.unsupportedBlocks > 0 && (
                    <span className="flex items-center gap-1.5">
                        <Swatch color={stressColor(Number.NaN, theme)} />
                        Not carrying weight (floating)
                        <span className="tabular-nums text-muted-foreground">{stress.unsupportedBlocks}</span>
                    </span>
                )}
                {/* In words on the stage, not in a tooltip: the chip stack does not take the pointer, and a touch screen has no hover. */}
                <span className="text-muted-foreground">From its own weight only ({material})</span>
            </div>
        );
    }

    if (colorBy === "role" && analysis.assembly) {
        const byRole = countByRole(analysis.blocks);
        return (
            <ul role="group" aria-label="Block colours: added blocks" className={box}>
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
            <div role="group" aria-label="Block colours: overhang" className={box}>
                <span className="flex items-center gap-1.5">
                    <Swatch color={statusColor("supported", theme)} />
                    {STATUS_LABELS.supported}
                </span>
                <span className="flex items-center gap-1.5">
                    <span className="tabular-nums text-muted-foreground">1</span>
                    <Ramp colors={steps.length > 1 ? steps : [steps[0], steps[0]]} />
                    <span className="tabular-nums text-muted-foreground">{limit} blocks from support</span>
                </span>
                <span className="flex items-center gap-1.5">
                    <Swatch color={reachColor(limit + 1, limit)} />
                    {STATUS_LABELS.overreach}
                </span>
                {counts.floating > 0 && (
                    <span className="flex items-center gap-1.5">
                        <Swatch color={statusColor("floating", theme)} />
                        {STATUS_LABELS.floating}
                    </span>
                )}
            </div>
        );
    }

    const stops = Array.from({ length: Math.min(layers, 12) }, (_, i) => layerColor(Math.round((i / Math.max(1, Math.min(layers, 12) - 1)) * (layers - 1)), layers));
    return (
        <div role="group" aria-label="Block colours: layers" className={box}>
            <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Layers</span>
                <span className="tabular-nums">1</span>
                <Ramp colors={stops.length > 1 ? stops : [stops[0], stops[0]]} />
                <span className="tabular-nums">{layers}</span>
            </span>
            <span className="text-muted-foreground">{layers} × {analysis.settings.blockSizeMm} mm</span>
        </div>
    );
}
