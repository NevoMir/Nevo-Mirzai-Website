import { useMemo } from "react";
import { Palette } from "lucide-react";

import { LayerRaisedNote, Section, Segmented, ToggleRow, type SegmentedOption } from "@/assignment/components/analysis/atoms";
import { MATERIAL_FACTS } from "@/assignment/components/analysis/stressText";
import { Slider } from "@/assignment/components/ui/slider";
import type { AnalysisColorBy, AnalysisResult, BlockStatus } from "@/assignment/analysis/types";
import { BLOCK_ROLES, type BlockRole } from "@/assignment/shared/contract";
import { useIsDark } from "@/assignment/hooks/useIsDark";
import { cn } from "@/assignment/lib/utils";
import {
    ROLE_PLURALS,
    STATUS_LABELS,
    STRESS_FAIL_SHARE,
    STRESS_TICKS,
    STRESS_RAMP_MAX,
    STRESS_WARN_SHARE,
    countByStatus,
    layerColor,
    percentText,
    reachColor,
    roleColor,
    statusColor,
    stressColor,
    stressGradientCss,
    topLayer,
} from "@/assignment/viewer/analysisGeometry";
import type { ViewTheme } from "@/assignment/viewer/types";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { fmtMm, hasAddedBlocks } from "@/assignment/store/analysisLogic";

const COLOR_LABELS: Record<AnalysisColorBy, string> = { status: "Status", reach: "Reach", layer: "Layer", stress: "Stress", role: "Role" };

const COLOR_HELP: Record<AnalysisColorBy, string> = {
    status: "Each block by what holds it up.",
    reach: "Horizontal block steps along the structure from each block's last support; a step across a corner counts as one.",
    layer: "Height: one colour per 100 mm layer, bottom to top.",
    stress: "Each block by the share of the allowable joint stress that its most stressed joint reaches under the structure's own weight.",
    role: "Each block by what it is for: the blocks the model started with, and what the stabilizer added to hold it up.",
};

const STATUSES: BlockStatus[] = ["supported", "cantilever", "overreach", "floating"];
const STATUS_HINT: Record<BlockStatus, string> = {
    supported: "On the ground, or on a column of blocks that reaches it",
    cantilever: "Nothing underneath; held from the side, within the limit",
    overreach: "A cantilever further out than the limit",
    floating: "Part of a structure that never touches the ground",
};

/** A colour chip; the colours come from the functions the 3D view paints with, so the two always agree. */
const Swatch = ({ color }: { color: string }) => (
    <span aria-hidden className="h-3 w-3 shrink-0 rounded-[3px] ring-1 ring-black/15 dark:ring-white/20" style={{ background: color }} />
);

function StatusLegend({ result, theme }: { result: AnalysisResult; theme: ViewTheme }) {
    const counts = useMemo(() => countByStatus(result.blocks), [result.blocks]);
    return (
        <ul className="grid grid-cols-2 gap-1.5" aria-label="Legend">
            {STATUSES.map((status) => (
                <li
                    key={status}
                    title={STATUS_HINT[status]}
                    data-testid="legend-status"
                    data-status={status}
                    className={cn(
                        "flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-[11px]",
                        counts[status] === 0 && "opacity-50",
                    )}
                >
                    <Swatch color={statusColor(status, theme)} />
                    <span className="min-w-0 flex-1 truncate text-foreground">{STATUS_LABELS[status]}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{counts[status]}</span>
                </li>
            ))}
        </ul>
    );
}

/** A row of coloured steps with a caption under each: reach is a whole number of blocks, so the scale is steps. */
function Steps({ label, steps }: { label: string; steps: { color: string; caption: string; title?: string }[] }) {
    return (
        <div role="img" aria-label={label}>
            <div className="flex gap-0.5">
                {steps.map((step, i) => (
                    <span
                        key={i}
                        title={step.title}
                        className="h-3 flex-1 first:rounded-l-full last:rounded-r-full ring-1 ring-inset ring-black/10 dark:ring-white/15"
                        style={{ background: step.color }}
                    />
                ))}
            </div>
            <div className="mt-1 flex gap-0.5 font-mono text-[10px] text-muted-foreground">
                {steps.map((step, i) => (
                    <span key={i} className="flex-1 text-center">
                        {step.caption}
                    </span>
                ))}
            </div>
        </div>
    );
}

/** The stress ramp as a bar with ticks, then what the grey-purple and the counts mean. The bar is drawn from the very function the blocks are painted with. */
export function StressLegend({ result, theme }: { result: AnalysisResult; theme: ViewTheme }) {
    const stress = result.stress;
    if (!stress) return null;
    const material = MATERIAL_FACTS[stress.material]?.label ?? stress.material;
    const high = stress.stressedBlocks;
    const over = stress.overstressedBlocks;
    return (
        <div className="space-y-2" data-testid="stress-legend">
            <div role="img" aria-label={`Stress as a share of the allowable joint stress: blue is 0%, teal 35%, amber 70%, red 100%, dark red 150% and over`}>
                <div className="h-3 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/15" style={{ background: stressGradientCss() }} />
                <div className="relative mt-1 h-3.5 font-mono text-[10px] text-muted-foreground">
                    {STRESS_TICKS.map((u, i) => (
                        <span
                            key={u}
                            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
                            style={{ left: `${(u / STRESS_RAMP_MAX) * 100}%`, ...(i === 0 ? { transform: "none" } : {}) }}
                        >
                            {i === STRESS_TICKS.length - 1 ? `${Math.round(u * 100)}%+` : Math.round(u * 100)}
                        </span>
                    ))}
                </div>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
                % of allowable joint stress (self-weight, {material})
            </p>
            <ul className="grid grid-cols-2 gap-1.5" aria-label="Legend">
                <li className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-[11px]" title="Part of a structure that never touches the ground: nothing carries its weight down">
                    <Swatch color={stressColor(Number.NaN, theme)} />
                    <span className="min-w-0 flex-1 truncate text-foreground">No load path</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{stress.unsupportedBlocks}</span>
                </li>
                <li className={cn("flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-[11px]", high === 0 && "opacity-50")}>
                    <Swatch color={stressColor(STRESS_WARN_SHARE + 0.05, theme)} />
                    <span className="min-w-0 flex-1 truncate text-foreground">Over {percentText(STRESS_WARN_SHARE)}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{high}</span>
                </li>
                <li className={cn("col-span-2 flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-[11px]", over === 0 && "opacity-50")}>
                    <Swatch color={stressColor(STRESS_FAIL_SHARE + 0.05, theme)} />
                    <span className="min-w-0 flex-1 truncate text-foreground">Over {percentText(STRESS_FAIL_SHARE)}: the joint would open or crush</span>
                    <span className="font-mono tabular-nums text-muted-foreground">{over}</span>
                </li>
            </ul>
        </div>
    );
}

/** One chip per role the model has, with its count: what the Overlay and the Role colouring mean. */
function RoleLegend({ result, theme }: { result: AnalysisResult; theme: ViewTheme }) {
    const counts = result.assembly?.roleCounts ?? [];
    return (
        <ul className="grid grid-cols-2 gap-1.5" aria-label="Legend" data-testid="role-legend">
            {BLOCK_ROLES.map((role: BlockRole, i) =>
                (counts[i] ?? 0) > 0 ? (
                    <li key={role} data-role={role} className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1 text-[11px]">
                        <Swatch color={roleColor(role, theme)} />
                        <span className="min-w-0 flex-1 truncate text-foreground">{ROLE_PLURALS[role]}</span>
                        <span className="font-mono tabular-nums text-muted-foreground">{counts[i]}</span>
                    </li>
                ) : null,
            )}
        </ul>
    );
}

function Legend({ result, colorBy, theme }: { result: AnalysisResult; colorBy: AnalysisColorBy; theme: ViewTheme }) {
    const limit = result.settings.cantileverLimit;
    const layers = Math.max(1, topLayer(result.blocks) + 1);
    const floating = useMemo(() => countByStatus(result.blocks).floating, [result.blocks]);

    if (colorBy === "status") return <StatusLegend result={result} theme={theme} />;
    if (colorBy === "stress") return <StressLegend result={result} theme={theme} />;
    if (colorBy === "role") return <RoleLegend result={result} theme={theme} />;

    if (colorBy === "reach") {
        const steps = Array.from({ length: limit }, (_, i) => ({
            color: reachColor(i + 1, limit),
            caption: String(i + 1),
            title: `${i + 1} ${i === 0 ? "block" : "blocks"} from the last support`,
        }));
        steps.push({ color: reachColor(limit + 1, limit), caption: `>${limit}`, title: "Beyond the limit" });
        return (
            <div className="space-y-2">
                <Steps label={`Blocks from the last support: 1 to ${limit}, then over the limit`} steps={steps} />
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                        <Swatch color={statusColor("supported", theme)} />
                        On a support
                    </span>
                    {floating > 0 && (
                        <span className="flex items-center gap-1.5">
                            <Swatch color={statusColor("floating", theme)} />
                            Floating
                        </span>
                    )}
                </p>
            </div>
        );
    }

    const steps = Array.from({ length: layers }, (_, k) => ({
        color: layerColor(k, layers),
        caption: layers <= 10 || k === 0 || k === layers - 1 ? String(k + 1) : "",
        title: `Layer ${k + 1}: ${k * result.settings.blockSizeMm}-${(k + 1) * result.settings.blockSizeMm} mm`,
    }));
    return <Steps label={`Layers 1 (ground) to ${layers} (top)`} steps={steps} />;
}

/** How the blocks are drawn: colour mode, a layer cut, the original model and the centre of gravity. */
export function ViewSection({ result }: { result: AnalysisResult }) {
    const view = useAnalysisStore((s) => s.view);
    const setColorBy = useAnalysisStore((s) => s.setColorBy);
    const setLayerMax = useAnalysisStore((s) => s.setLayerMax);
    const setShowGhost = useAnalysisStore((s) => s.setShowGhost);
    const setShowCog = useAnalysisStore((s) => s.setShowCog);

    // The stabilizer's picture is on the stage while it works: it is painted by role whatever is chosen here.
    const previewing = useAnalysisStore((s) => s.preview !== null && s.preview.modelId === s.resultModelId);

    const theme: ViewTheme = useIsDark() ? "dark" : "light";
    const options = useMemo<SegmentedOption<AnalysisColorBy>[]>(() => {
        const base: AnalysisColorBy[] = ["status", "reach", "layer", "stress"];
        if (hasAddedBlocks(result)) base.push("role");
        return base.map((value) => ({
            value,
            label: COLOR_LABELS[value],
            disabled: value === "stress" && !result.stress,
            title:
                value === "stress" && !result.stress
                    ? (result.checks.find((c) => c.key === "stress")?.value ?? "There is no stress estimate for this model.")
                    : undefined,
        }));
    }, [result]);
    const layers = Math.max(1, result.stats.layers);
    const shown = Math.min(view.layerMax, layers - 1) + 1;
    const cutMm = shown * result.settings.blockSizeMm;

    return (
        <Section title="View" icon={Palette} testId="analysis-view">
            <div className="space-y-3.5">
                <div>
                    <p className="mb-1.5 text-xs font-medium text-foreground">Colour blocks by</p>
                    <Segmented
                        label="Colour blocks by"
                        value={view.colorBy}
                        options={options}
                        onChange={setColorBy}
                        columns={options.length > 4 ? 3 : undefined}
                        disabled={previewing}
                    />
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                        {previewing
                            ? "The stage shows the version being built: what was added is coloured by its role."
                            : view.compare === "overlay"
                              ? "Overlay: the stabilized model, what was added coloured by its role. Pick another colouring to leave it."
                              : COLOR_HELP[view.colorBy]}
                    </p>
                </div>

                <Legend result={result} colorBy={view.colorBy} theme={theme} />

                <div>
                    <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <label htmlFor="analysis-layers" className="text-xs font-medium text-foreground">
                            Show layers 1–{shown}
                            <span className="font-normal text-muted-foreground"> of {layers}</span>
                        </label>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">up to {fmtMm(cutMm)} mm</span>
                    </div>
                    <Slider
                        id="analysis-layers"
                        min={0}
                        max={layers - 1}
                        step={1}
                        value={[Math.min(view.layerMax, layers - 1)]}
                        disabled={layers <= 1}
                        onValueChange={([value]) => setLayerMax(value)}
                        aria-valuetext={`Layers 1 to ${shown}, up to ${fmtMm(cutMm)} millimetres`}
                    />
                    <LayerRaisedNote className="mt-2" />
                </div>

                <div className="space-y-2.5">
                    {/* A block assembly has no mesh behind it: its blocks are the model. */}
                    {!result.assembly && (
                        <ToggleRow
                            label="Show original model"
                            hint="The generated mesh, faint, inside the blocks."
                            checked={view.showGhost}
                            onChange={setShowGhost}
                        />
                    )}
                    <ToggleRow
                        label="Show centre of gravity"
                        hint="Marker, drop line and the base it must stay over."
                        checked={view.showCog}
                        onChange={setShowCog}
                    />
                </div>
            </div>
        </Section>
    );
}
