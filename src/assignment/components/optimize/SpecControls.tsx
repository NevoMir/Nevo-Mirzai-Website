import { useId, useState, type ReactNode } from "react";
import { Plus, Shield, X } from "lucide-react";

import type { Effective } from "@/assignment/analysis/optimize/spec";
import { Segmented, type SegmentedOption } from "@/assignment/components/analysis/atoms";
import { NumberField } from "@/assignment/components/analysis/fields";
import { Button } from "@/assignment/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import { Slider } from "@/assignment/components/ui/slider";
import { Switch } from "@/assignment/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { cn } from "@/assignment/lib/utils";
import { SPEC_LIMITS, type Brief, type MetricKey, type OptimizationSpec, type Symmetry } from "@/assignment/shared/optimizeSpec";
import {
    AIM_LABEL,
    METRICS_IN_ORDER,
    METRIC_WORDS,
    SYMMETRY_WORDS,
    aimOf,
    blocksModeOf,
    layerBox,
    protectLabel,
    protectTip,
    sharesOf,
    symmetryChoices,
    withAim,
    withBlocks,
    withConstraint,
    withMay,
    withMetricAdded,
    withMetricRemoved,
    withProtection,
    withoutProtection,
    withShare,
    type Aim,
    type BlocksMode,
} from "@/assignment/store/optimizeLogic";

export interface SpecControlsProps {
    spec: OptimizationSpec;
    /** The values the run will use for everything the spec leaves open. */
    effective: Effective;
    brief: Brief;
    /** Blocks the model has now (the first value offered for a block limit). */
    startBlocks: number;
    edit: (change: (spec: OptimizationSpec) => OptimizationSpec) => void;
    /** The pointer (or the keyboard) is on a "kept as they are" chip: light up its blocks on the stage; null: off. */
    onPeek?: (index: number | null) => void;
}

const groupTitle = "mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

/** A group of controls with its small title. */
function Group({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
    return (
        <fieldset className="min-w-0 border-0 p-0" data-testid={testId}>
            <legend className={groupTitle}>{title}</legend>
            <div className="space-y-3">{children}</div>
        </fieldset>
    );
}

/** A label with its tooltip, the value on the right and a slider under it. */
function LimitSlider({
    label,
    tip,
    value,
    valueText,
    min,
    max,
    step,
    onChange,
    testId,
}: {
    label: string;
    tip: string;
    value: number;
    valueText: string;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
    testId: string;
}) {
    const id = useId();
    return (
        <div data-testid={testId}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <label htmlFor={id} className="cursor-help text-xs font-medium text-foreground">
                            {label}
                        </label>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-xs">
                        {tip}
                    </TooltipContent>
                </Tooltip>
                <span className="font-mono text-xs font-semibold tabular-nums text-foreground" data-testid={`${testId}-value`}>
                    {valueText}
                </span>
            </div>
            <Slider id={id} min={min} max={max} step={step} value={[Math.min(max, Math.max(min, value))]} onValueChange={([v]) => onChange(v)} aria-valuetext={valueText} />
        </div>
    );
}

const radio = "h-4 w-4 shrink-0 accent-primary";

function RadioRow({ name, value, checked, onSelect, children, testId }: { name: string; value: string; checked: boolean; onSelect: () => void; children: ReactNode; testId?: string }) {
    return (
        <label className={cn("flex min-h-9 cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-xs leading-snug hover:bg-secondary/50 md:min-h-0", checked && "bg-secondary/40")}>
            <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className={cn(radio, "mt-0.5")} data-testid={testId} />
            <span className="min-w-0 flex-1 text-foreground">{children}</span>
        </label>
    );
}

// ---------- the aim ----------

const AIM_OPTIONS: ReadonlyArray<SegmentedOption<Aim>> = (["lightest", "strongest", "balanced", "stiffest", "mix"] as const).map((a) => ({ value: a, label: AIM_LABEL[a] }));

function AimControl({ spec, edit }: Pick<SpecControlsProps, "spec" | "edit">) {
    const aim = aimOf(spec);
    const shares = sharesOf(spec);
    const addable = METRICS_IN_ORDER.filter((m) => !spec.objective.some((t) => t.metric === m));
    return (
        <div data-testid="optimize-aim">
            <Segmented label="Aim" value={aim} options={AIM_OPTIONS} columns={3} onChange={(next) => edit((s) => withAim(s, next))} />
            {aim === "mix" && (
                <div className="mt-2.5 space-y-2.5" data-testid="optimize-mix">
                    {shares.map(({ metric, share }) => (
                        <MixRow key={metric} metric={metric} share={share} canRemove={shares.length > 1} edit={edit} />
                    ))}
                    {addable.length > 0 && shares.length < SPEC_LIMITS.terms && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="sm" className="h-9 gap-1 px-2 text-xs text-primary hover:bg-primary/10 hover:text-primary md:h-7" data-testid="optimize-add-aim">
                                    <Plus />
                                    Add another aim
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {addable.map((m) => (
                                    <DropdownMenuItem key={m} onSelect={() => edit((s) => withMetricAdded(s, m))} title={METRIC_WORDS[m].tip}>
                                        {METRIC_WORDS[m].label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            )}
        </div>
    );
}

function MixRow({ metric, share, canRemove, edit }: { metric: MetricKey; share: number; canRemove: boolean; edit: SpecControlsProps["edit"] }) {
    const id = useId();
    return (
        <div data-testid={`optimize-mix-${metric}`}>
            <div className="mb-1 flex items-center gap-1.5">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <label htmlFor={id} className="cursor-help text-xs font-medium text-foreground">
                            {METRIC_WORDS[metric].label}
                        </label>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-xs">
                        {METRIC_WORDS[metric].tip}
                    </TooltipContent>
                </Tooltip>
                <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{share}%</span>
                {canRemove && (
                    <button
                        type="button"
                        onClick={() => edit((s) => withMetricRemoved(s, metric))}
                        aria-label={`Remove: ${METRIC_WORDS[metric].label}`}
                        className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-6 md:w-6"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                )}
            </div>
            <Slider id={id} min={1} max={99} step={1} value={[share]} onValueChange={([v]) => edit((s) => withShare(s, metric, v))} aria-valuetext={`${share} percent of the priority`} />
        </div>
    );
}

// ---------- blocks ----------

function BlocksControl({ spec, startBlocks, edit }: Pick<SpecControlsProps, "spec" | "startBlocks" | "edit">) {
    const { mode, value } = blocksModeOf(spec);
    const name = useId();
    const pick = (next: BlocksMode) => edit((s) => withBlocks(s, next, next === mode ? value : null, startBlocks));
    return (
        <div role="radiogroup" aria-label="Blocks" data-testid="optimize-blocks">
            <p className="mb-0.5 text-xs font-medium text-foreground">Blocks</p>
            <RadioRow name={name} value="none" checked={mode === "none"} onSelect={() => pick("none")} testId="optimize-blocks-none">
                No limit
            </RadioRow>
            <RadioRow name={name} value="most" checked={mode === "most"} onSelect={() => pick("most")} testId="optimize-blocks-most">
                <span className="flex items-center gap-2">
                    At most
                    <NumberField id={`${name}-most`} value={mode === "most" ? value : null} min={SPEC_LIMITS.blocks[0]} max={SPEC_LIMITS.blocks[1]} placeholder={String(startBlocks)} onCommit={(v) => v !== null && edit((s) => withBlocks(s, "most", v, startBlocks))} />
                    blocks
                </span>
            </RadioRow>
            <RadioRow name={name} value="extra" checked={mode === "extra"} onSelect={() => pick("extra")} testId="optimize-blocks-extra">
                <span className="flex items-center gap-2">
                    At most +
                    <NumberField id={`${name}-extra`} value={mode === "extra" ? value : null} min={SPEC_LIMITS.addedBlocks[0]} max={SPEC_LIMITS.addedBlocks[1]} placeholder="10" onCommit={(v) => v !== null && edit((s) => withBlocks(s, "extra", v, startBlocks))} />
                    more
                </span>
            </RadioRow>
        </div>
    );
}

// ---------- what may not change ----------

function ProtectControl({ spec, brief, edit, onPeek }: Pick<SpecControlsProps, "spec" | "brief" | "edit" | "onPeek">) {
    const [boxOpen, setBoxOpen] = useState(false);
    const full = spec.protected.length >= SPEC_LIMITS.regions;
    const taken = new Set(spec.protected.map((r) => r.part).filter((p): p is string => p !== null));
    const parts = brief.parts.filter((p) => !taken.has(p.name));
    return (
        <div data-testid="optimize-protect">
            {spec.protected.length === 0 ? (
                <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">Nothing is held back. Mark a part to keep it exactly as it is.</p>
            ) : (
                <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Kept as they are">
                    {spec.protected.map((region, n) => {
                        const label = protectLabel(region, brief);
                        return (
                            <li key={`${n}-${label}`}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <span
                                            className="inline-flex min-h-8 items-center gap-1 rounded-full border border-primary/35 bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs text-foreground"
                                            data-testid="optimize-protected"
                                            onMouseEnter={() => onPeek?.(n)}
                                            onMouseLeave={() => onPeek?.(null)}
                                            onFocus={() => onPeek?.(n)}
                                            onBlur={() => onPeek?.(null)}
                                        >
                                            <Shield className="h-3 w-3 text-primary" aria-hidden />
                                            {label}
                                            <button
                                                type="button"
                                                onClick={() => edit((s) => withoutProtection(s, n))}
                                                aria-label={`Stop keeping ${label}`}
                                                className="grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-5 md:w-5"
                                            >
                                                <X className="h-3 w-3" aria-hidden />
                                            </button>
                                        </span>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-56 text-xs">
                                        {protectTip(region)}
                                    </TooltipContent>
                                </Tooltip>
                            </li>
                        );
                    })}
                </ul>
            )}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm" disabled={full} className="h-9 gap-1 px-2.5 text-xs md:h-8" data-testid="optimize-protect-menu">
                        <Plus />
                        Protect
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
                    {parts.length > 0 && <DropdownMenuLabel className="text-[11px] font-semibold text-muted-foreground">Parts</DropdownMenuLabel>}
                    {parts.map((p) => (
                        <DropdownMenuItem key={p.name} onSelect={() => edit((s) => withProtection(s, { mode: "keep", part: p.name, box: null }))} data-testid="optimize-protect-part">
                            {p.name}
                            <span className="ml-2 text-[11px] text-muted-foreground">{p.blocks} blocks</span>
                        </DropdownMenuItem>
                    ))}
                    {parts.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem onSelect={() => edit((s) => withProtection(s, { mode: "keep", part: null, box: layerBox("top", 2, brief) }))}>Top 2 layers</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => edit((s) => withProtection(s, { mode: "keep", part: null, box: layerBox("bottom", 2, brief) }))}>Bottom 2 layers</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setBoxOpen(true)}>A box…</DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {boxOpen && (
                <BoxForm
                    onCancel={() => setBoxOpen(false)}
                    onAdd={(box) => {
                        edit((s) => withProtection(s, { mode: "keep", part: null, box }));
                        setBoxOpen(false);
                    }}
                />
            )}
        </div>
    );
}

/** A box of the lattice in the person's counting: 1 to 10 from the left, from the front, from the ground. */
function BoxForm({ onAdd, onCancel }: { onAdd: (box: { min: [number, number, number]; max: [number, number, number] }) => void; onCancel: () => void }) {
    const id = useId();
    const [v, setV] = useState({ x0: 1, x1: 10, y0: 1, y1: 10, z0: 1, z1: 2 });
    const field = (key: keyof typeof v, label: string) => (
        <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-${key}`} className="w-9 shrink-0 text-[11px] text-muted-foreground">
                {label}
            </label>
            <NumberField id={`${id}-${key}`} value={v[key]} min={1} max={10} onCommit={(n) => n !== null && setV((p) => ({ ...p, [key]: n }))} />
        </div>
    );
    return (
        <div className="mt-2 rounded-xl border border-border/70 bg-card p-2.5" data-testid="optimize-box-form">
            <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">Blocks counted from 1: from the left, from the front, from the ground.</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {field("x0", "Left")}
                {field("x1", "to")}
                {field("y0", "Front")}
                {field("y1", "to")}
                {field("z0", "Layer")}
                {field("z1", "to")}
            </div>
            <div className="mt-2 flex gap-1.5">
                <Button
                    type="button"
                    size="sm"
                    className="h-9 px-3 text-xs md:h-8"
                    onClick={() =>
                        onAdd({
                            min: [Math.min(v.x0, v.x1) - 1, Math.min(v.y0, v.y1) - 1, Math.min(v.z0, v.z1) - 1],
                            max: [Math.max(v.x0, v.x1) - 1, Math.max(v.y0, v.y1) - 1, Math.max(v.z0, v.z1) - 1],
                        })
                    }
                    data-testid="optimize-box-add"
                >
                    Keep this box
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-9 px-3 text-xs hover:bg-secondary md:h-8" onClick={onCancel}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

// ---------- all of it ----------

const REMOVABLE_WORDS: ReadonlyArray<{ value: OptimizationSpec["moves"]["removable"]; text: ReactNode }> = [
    { value: "added", text: "Only the support I added" },
    { value: "inner", text: <>Support and hidden inside blocks <span className="text-muted-foreground">(the outside stays the same)</span></> },
    { value: "any", text: <>Any block <span className="text-muted-foreground">(the shape may change)</span></> },
];

/**
 * The spec as controls, one for one: what it aims for, the limits it keeps to, what it may change and what it must leave alone. Every control
 * edits the spec and the page cleans it again (store/optimize.ts editSpec), so what the controls show is what a run uses.
 */
export function SpecControls({ spec, effective, brief, startBlocks, edit, onPeek }: SpecControlsProps) {
    const name = useId();
    const may = spec.moves.allow;
    const symmetries = symmetryChoices(brief);
    const lighter = spec.objective.some((t) => t.metric === "blocks");
    return (
        <div className="space-y-4 px-4 pb-3" data-testid="optimize-controls">
            <Group title="Aim" testId="optimize-group-aim">
                <AimControl spec={spec} edit={edit} />
            </Group>

            <Group title="Limits" testId="optimize-group-limits">
                <LimitSlider
                    label="Strength used at most"
                    tip="How much of a joint's strength the model's own weight may use. Technical term: peak joint utilisation."
                    value={effective.maxStressPct}
                    valueText={`${Math.round(effective.maxStressPct)}%`}
                    min={SPEC_LIMITS.stressPct[0]}
                    max={SPEC_LIMITS.stressPct[1]}
                    step={5}
                    onChange={(v) => edit((s) => withConstraint(s, "max_stress_pct", v))}
                    testId="optimize-limit-strength"
                />
                <LimitSlider
                    label="Weight inside the base by"
                    tip="How far inside the edge of its base the model's weight must stay, so it does not tip. Technical term: centre-of-gravity margin."
                    value={effective.minCogMarginMm}
                    valueText={`${Math.round(effective.minCogMarginMm)} mm`}
                    min={SPEC_LIMITS.cogMarginMm[0]}
                    max={SPEC_LIMITS.cogMarginMm[1]}
                    step={10}
                    onChange={(v) => edit((s) => withConstraint(s, "min_cog_margin_mm", v))}
                    testId="optimize-limit-balance"
                />
                <LimitSlider
                    label="Longest overhang"
                    tip="How many blocks a part may stick out with nothing under it. Technical term: cantilever."
                    value={effective.cantileverBlocks}
                    valueText={`${effective.cantileverBlocks} ${effective.cantileverBlocks === 1 ? "block" : "blocks"}`}
                    min={SPEC_LIMITS.cantileverBlocks[0]}
                    max={SPEC_LIMITS.cantileverBlocks[1]}
                    step={1}
                    onChange={(v) => edit((s) => withConstraint(s, "max_cantilever_blocks", v))}
                    testId="optimize-limit-overhang"
                />
                <BlocksControl spec={spec} startBlocks={startBlocks} edit={edit} />
                <div className="flex items-center gap-2" data-testid="optimize-limit-sag">
                    <Switch
                        checked={spec.constraints.max_deflection_pct !== null}
                        onCheckedChange={(on) => edit((s) => withConstraint(s, "max_deflection_pct", on ? 100 : null))}
                        aria-label="Limit how much it sags"
                        className="h-5 w-9"
                    />
                    <span className="min-w-0 flex-1 text-xs text-foreground">It may not sag more than now</span>
                    {spec.constraints.max_deflection_pct !== null && (
                        <span className="flex items-center gap-1 text-xs">
                            <NumberField id={`${name}-sag`} value={Math.round(spec.constraints.max_deflection_pct)} min={SPEC_LIMITS.deflectionPct[0]} max={SPEC_LIMITS.deflectionPct[1]} onCommit={(v) => v !== null && edit((s) => withConstraint(s, "max_deflection_pct", v))} />
                            %
                        </span>
                    )}
                </div>
            </Group>

            <Group title="May change" testId="optimize-group-change">
                <div role="radiogroup" aria-label="Which blocks may be taken out" data-testid="optimize-removable">
                    {REMOVABLE_WORDS.map((option) => (
                        <RadioRow key={option.value} name={`${name}-removable`} value={option.value} checked={spec.moves.removable === option.value} onSelect={() => edit((s) => ({ ...s, moves: { ...s.moves, removable: option.value } }))} testId={`optimize-removable-${option.value}`}>
                            {option.text}
                        </RadioRow>
                    ))}
                </div>
                {spec.moves.removable === "any" && (
                    <div className="flex items-center gap-2 pl-1.5 text-xs text-foreground" data-testid="optimize-keep-pct">
                        Keep at least
                        <NumberField id={`${name}-keep`} value={Math.round(effective.minBlocks > 0 ? (effective.minBlocks / startBlocks) * 100 : 50)} min={SPEC_LIMITS.minBlocksPct[0]} max={SPEC_LIMITS.minBlocksPct[1]} onCommit={(v) => v !== null && edit((s) => withConstraint(s, "min_blocks_pct", v))} />
                        % of the blocks
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pl-1.5" data-testid="optimize-may">
                    <span className="text-xs font-medium text-foreground">It may</span>
                    <label className="flex min-h-9 items-center gap-1.5 text-xs md:min-h-0">
                        <input type="checkbox" className={radio} checked={may !== "add"} onChange={(e) => edit((s) => withMay(s, "remove", e.target.checked))} data-testid="optimize-may-remove" />
                        take blocks away
                    </label>
                    <label className="flex min-h-9 items-center gap-1.5 text-xs md:min-h-0">
                        <input type="checkbox" className={radio} checked={may !== "remove"} onChange={(e) => edit((s) => withMay(s, "add", e.target.checked))} data-testid="optimize-may-add" />
                        put blocks in
                    </label>
                </div>
            </Group>

            <Group title="Keep as they are" testId="optimize-group-keep">
                <ProtectControl spec={spec} brief={brief} edit={edit} onPeek={onPeek} />
            </Group>

            <Group title="Also" testId="optimize-group-also">
                <div className="flex items-center gap-2">
                    <Switch checked={spec.constraints.keep_one_piece} onCheckedChange={(on) => edit((s) => withConstraint(s, "keep_one_piece", on))} aria-label="Keep it in one piece" className="h-5 w-9" data-testid="optimize-one-piece" />
                    <span className="text-xs text-foreground">Keep it in one piece</span>
                </div>
                {symmetries.length > 1 && (
                    <div data-testid="optimize-symmetry">
                        <p className="mb-1 text-xs font-medium text-foreground">Keep it the same on both sides</p>
                        <Segmented
                            label="Symmetry"
                            value={effective.symmetry}
                            options={symmetries.map((s): SegmentedOption<Symmetry> => ({ value: s, label: SYMMETRY_WORDS[s] }))}
                            columns={symmetries.length > 2 ? 2 : symmetries.length}
                            onChange={(next) => edit((s) => withConstraint(s, "symmetry", next))}
                        />
                    </div>
                )}
                {lighter && (
                    <div className="flex items-center gap-2 text-xs text-foreground" data-testid="optimize-stop">
                        <Switch
                            checked={spec.stop.reduce_blocks_by_pct !== null}
                            onCheckedChange={(on) => edit((s) => ({ ...s, stop: { reduce_blocks_by_pct: on ? 20 : null } }))}
                            aria-label="Stop when it is lighter by a share"
                            className="h-5 w-9"
                        />
                        <span className="min-w-0 flex-1">Stop when it is lighter by</span>
                        {spec.stop.reduce_blocks_by_pct !== null && (
                            <span className="flex items-center gap-1">
                                <NumberField id={`${name}-stop`} value={Math.round(spec.stop.reduce_blocks_by_pct)} min={SPEC_LIMITS.reducePct[0]} max={SPEC_LIMITS.reducePct[1]} onCommit={(v) => v !== null && edit((s) => ({ ...s, stop: { reduce_blocks_by_pct: v } }))} />
                                %
                            </span>
                        )}
                    </div>
                )}
            </Group>
        </div>
    );
}
