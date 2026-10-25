// Pure logic behind the Optimization tab: what the person may start from, how the controls edit a spec, and what the live run and the result
// say in words. No React and no store, so store/optimize.ts, the components and scripts/assignment/test-optimize-ui.mjs share one copy.
//
// The words follow the panel's rule (design-edit-optimize.md 6.6): blocks, weight, strength used, balance, overhang. The technical terms
// (peak joint utilisation, centre-of-gravity margin, cantilever, compliance) live in the tooltips only.

import type { Effective } from "@/assignment/analysis/optimize/spec";
import type { IterationRecord } from "@/assignment/analysis/optimize/types";
import type { AnalysisResult, AnalysisSettings } from "@/assignment/analysis/types";
import { ASSEMBLY_BLOCK_MM, ASSEMBLY_GRID, descriptorFromBlocks, type AssemblyDescriptor } from "@/assignment/shared/assembly";
import {
    MAX_DERIVED_DEPTH,
    MAX_VERSIONS_PER_PROJECT,
    MAX_VERSIONS_PER_SOURCE,
    MAX_VERSION_DEPTH,
    type ModelAsset,
    type OptimizeSummary,
} from "@/assignment/shared/contract";
import type { OptimizeMetrics, StopReason } from "@/assignment/shared/optimizeMeta";
import {
    GOAL_MAX,
    SPEC_LIMITS,
    type Brief,
    type CellBox,
    type MetricKey,
    type OptimizationSpec,
    type PresetKind,
    type ProtectedRegion,
    type Symmetry,
} from "@/assignment/shared/optimizeSpec";
import { chainDepth, representation, stabilizationsOfModel, versionCount, versionsOfSource } from "@/assignment/shared/versionTree";

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const MINUS = "−";
const signed = (n: number): string => `${n < 0 ? MINUS : "+"}${Math.abs(n)}`;
const round = (n: number, d = 0): number => Math.round(n * 10 ** d) / 10 ** d;

// ---------- the four buttons, the effort ----------

export interface Chip {
    id: PresetKind;
    /** What the button says, and what is recorded as the goal when it is pressed. */
    label: string;
    /** One line under the label in a wide layout. */
    hint: string;
    /** The tooltip: what it does, then the technical term. */
    tip: string;
}

export const CHIPS: readonly Chip[] = [
    {
        id: "lightest",
        label: "Lightest",
        hint: "Fewest blocks that still stand",
        tip: "Takes out as many blocks as it can without changing the outside shape or breaking a check. Technical term: minimise mass.",
    },
    {
        id: "strongest",
        label: "Strongest",
        hint: "Least strength used",
        tip: "Brings down the share of strength the busiest joint uses, with a few extra blocks where they help most. Technical term: minimise peak joint utilisation.",
    },
    {
        id: "most-stable",
        label: "Best balanced",
        hint: "Hardest to tip, less loaded",
        tip: "Widens the base and takes load off the weakest joints, with a few extra blocks. Technical term: maximise the centre-of-gravity margin to the support base, and minimise peak joint utilisation.",
    },
    {
        id: "stiffest",
        label: "Stiffest",
        hint: "Least sag and sway",
        tip: "Makes the model sag and sway as little as possible under its own weight. Technical term: minimise compliance (peak deflection).",
    },
];

export const chipOf = (id: PresetKind): Chip => CHIPS.find((c) => c.id === id) ?? CHIPS[0];

export type Effort = "quick" | "thorough";

export const EFFORTS: Record<Effort, { label: string; about: string; timeBudgetMs: number }> = {
    quick: { label: "Quick", about: "about 10 s", timeBudgetMs: 10_000 },
    thorough: { label: "Thorough", about: "about 30 s", timeBudgetMs: 30_000 },
};

export const GOAL_EXAMPLE = "as light as possible, keep the seat";
export { GOAL_MAX };

// ---------- may it start? ----------

/** What the tab shows instead of the goal field when the model on screen cannot be the start. */
export type Eligibility =
    | { kind: "ok" }
    | { kind: "none" }
    | { kind: "waiting" }
    | { kind: "unavailable"; message: string }
    | { kind: "empty" }
    | { kind: "errors"; message: string }
    | { kind: "draft"; message: string }
    | { kind: "limit"; message: string };

export const ERRORS_MESSAGE = "Fix the problems first. Optimization starts from a structure that stands.";
export const DRAFT_MESSAGE = "Save your changes first. Optimization starts from a saved version.";

/** What `eligibilityOf` needs of the Stability snapshot (components/analysis/useAnalysis.ts AnalysisSnapshot). */
export interface SnapshotLike {
    phase: "no-model" | "unavailable" | "loading" | "running" | "error" | "done";
    result: Pick<AnalysisResult, "summary" | "stats" | "assembly"> | null;
    unavailable?: string | null;
}

export function eligibilityOf(input: {
    model: Pick<ModelAsset, "id" | "kind" | "derived" | "edit" | "optimization" | "source_model_id" | "created_at"> | null;
    models: ReadonlyArray<Pick<ModelAsset, "id" | "kind" | "derived" | "edit" | "optimization" | "source_model_id" | "created_at">>;
    snapshot: SnapshotLike;
    /** The block changes in the Stability tab that are not saved yet (store/voxelEdit.ts). */
    unsavedDraft: boolean;
}): Eligibility {
    const { model, models, snapshot } = input;
    if (!model || snapshot.phase === "no-model") return { kind: "none" };
    if (snapshot.phase === "unavailable") return { kind: "unavailable", message: snapshot.unavailable ?? "The 3D view cannot show this model." };
    const result = snapshot.result;
    if (!result || snapshot.phase === "loading" || snapshot.phase === "error") return snapshot.phase === "error" ? { kind: "unavailable", message: "The check of this model failed, so there is nothing to start from." } : { kind: "waiting" };
    if (result.stats.blockCount === 0) return { kind: "empty" };
    if (input.unsavedDraft) return { kind: "draft", message: DRAFT_MESSAGE };
    if (result.summary.errors > 0) return { kind: "errors", message: ERRORS_MESSAGE };
    // A block version is analysed from its own blocks; one whose analysis has no blocks of its own yet is still arriving.
    if (representation(model) === "blocks" && !result.assembly) return { kind: "waiting" };
    const limit = versionLimitMessage(model, models);
    if (limit) return { kind: "limit", message: limit };
    return { kind: "ok" };
}

/** Why no further version can be made from `model` (the caps the server checks inside its INSERT), else null. */
export function versionLimitMessage(model: Parameters<typeof eligibilityOf>[0]["model"] & object, models: Parameters<typeof eligibilityOf>[0]["models"]): string | null {
    if (versionsOfSource(models, model.id) >= MAX_VERSIONS_PER_SOURCE) {
        return `${plural(MAX_VERSIONS_PER_SOURCE, "version")} have been made from this one already. Delete one in the Models tab to make another.`;
    }
    if (versionCount(models) >= MAX_VERSIONS_PER_PROJECT) {
        return `This project has ${plural(MAX_VERSIONS_PER_PROJECT, "version")} already. Delete some in the Models tab to make more.`;
    }
    if (chainDepth(models, model) + 1 > MAX_VERSION_DEPTH) {
        return `This version comes after ${MAX_VERSION_DEPTH} others in a row. Start again from an earlier version to make another.`;
    }
    return null;
}

/** What a run starts from: the version's blocks, how it relates to the original mesh, and how many times it was stabilized on the way. */
export interface OptimizeBase {
    modelId: string;
    descriptor: AssemblyDescriptor;
    settings: AnalysisSettings;
    /** "blocks": a saved block version (its cell hash is the log's source_hash). "mesh": the voxelisation of an original mesh. */
    source: "blocks" | "mesh";
    stabilizedDepth: number;
}

/** The blocks of the analysis on screen as the descriptor a run starts from; null when the model and its analysis do not agree (yet). */
export function baseOf(model: Parameters<typeof eligibilityOf>[0]["model"] & object, result: AnalysisResult | null): OptimizeBase | null {
    if (!result || result.stats.blockCount === 0) return null;
    const blocks = representation(model) === "blocks";
    if (blocks && !result.assembly) return null;
    const descriptor = result.assembly
        ? result.assembly.descriptor
        : descriptorFromBlocks(result.blocks.map((b) => ({ cell: b.cell, role: b.role ?? "original", step: b.step ?? 0 })));
    return { modelId: model.id, descriptor, settings: result.settings, source: blocks ? "blocks" : "mesh", stabilizedDepth: stabilizationsOfModel(model, MAX_DERIVED_DEPTH) };
}

/** Cells of each named part from the part labels (names and the owner of each cell, -1 for none): the form a run takes. */
export function partsFromLabels(labels: { names: readonly string[]; owner: ArrayLike<number> } | null | undefined): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    if (!labels) return out;
    labels.names.forEach((name) => (out[name] = []));
    for (let c = 0; c < labels.owner.length; c++) {
        const p = labels.owner[c];
        if (p >= 0 && p < labels.names.length) out[labels.names[p]].push(c);
    }
    return out;
}

// ---------- the numbers on screen ----------

export const kgPerBlock = (material: { fem: { rho: number } }): number => material.fem.rho * (ASSEMBLY_BLOCK_MM / 1000) ** 3;

export const kgText = (kg: number): string => `${round(kg, kg < 100 ? 1 : 0)} kg`;
export const pctText = (share: number | null): string => (share === null ? "n/a" : `${Math.round(share * 100)}%`);
export const mmText = (mm: number | null): string => (mm === null ? "n/a" : `${Math.round(mm)} mm`);

/** "103 blocks · 247 kg · strength used 69%": the model as it is now (the idle line). */
export function nowLine(result: Pick<AnalysisResult, "stats" | "stress" | "settings">, kgPerBlockValue: number): string {
    const peak = result.stress ? result.stress.maxUtilisation : null;
    const parts = [plural(result.stats.blockCount, "block"), kgText(result.stats.blockCount * kgPerBlockValue)];
    if (peak !== null) parts.push(`strength used ${pctText(peak)}`);
    return parts.join(" · ");
}

// ---------- the controls, as edits of the spec ----------

export type Aim = "lightest" | "strongest" | "balanced" | "stiffest" | "mix";

export const AIM_METRIC: Record<Exclude<Aim, "mix">, MetricKey> = { lightest: "blocks", strongest: "peak_stress", balanced: "cog_margin", stiffest: "deflection" };
export const AIM_LABEL: Record<Aim, string> = { lightest: "Lightest", strongest: "Strongest", balanced: "Best balanced", stiffest: "Stiffest", mix: "A mix" };
export const METRIC_WORDS: Record<MetricKey, { label: string; tip: string }> = {
    blocks: { label: "Fewer blocks", tip: "Fewer blocks means lighter and cheaper. Technical term: minimise mass." },
    peak_stress: { label: "Less strength used", tip: "Lowers the share of strength the busiest joint uses. Technical term: minimise peak joint utilisation." },
    cog_margin: { label: "Better balance", tip: "Puts the weight further inside the base, so it is harder to tip. Technical term: maximise the centre-of-gravity margin." },
    deflection: { label: "Less sag", tip: "Makes it sag and sway less under its own weight. Technical term: minimise peak deflection (compliance)." },
};
export const METRICS_IN_ORDER: readonly MetricKey[] = ["blocks", "peak_stress", "cog_margin", "deflection"];

export function aimOf(spec: Pick<OptimizationSpec, "objective">): Aim {
    if (spec.objective.length !== 1) return "mix";
    const metric = spec.objective[0].metric;
    return (Object.keys(AIM_METRIC) as Array<keyof typeof AIM_METRIC>).find((k) => AIM_METRIC[k] === metric) ?? "mix";
}

/** Switching the aim: the one metric (or, for a mix, the current one and a second); a goal that adds blocks needs adding allowed, "lightest" only takes out. */
export function withAim(spec: OptimizationSpec, aim: Aim): OptimizationSpec {
    if (aim === "mix") {
        if (spec.objective.length > 1) return spec;
        const first = spec.objective[0]?.metric ?? "blocks";
        const second: MetricKey = first === "peak_stress" ? "cog_margin" : "peak_stress";
        return { ...spec, objective: [{ metric: first, weight: 0.5 }, { metric: second, weight: 0.5 }] };
    }
    const allow = aim === "lightest" ? "remove" : spec.moves.allow === "remove" ? "both" : spec.moves.allow;
    return { ...spec, objective: [{ metric: AIM_METRIC[aim], weight: 1 }], moves: { ...spec.moves, allow } };
}

/** The share (0 to 100) of each metric of the objective, in the objective's order. */
export function sharesOf(spec: Pick<OptimizationSpec, "objective">): Array<{ metric: MetricKey; share: number }> {
    const total = spec.objective.reduce((s, t) => s + t.weight, 0) || 1;
    return spec.objective.map((t) => ({ metric: t.metric, share: Math.round((t.weight / total) * 100) }));
}

/** One metric gets `share` percent, the others keep their proportions in what is left. */
export function withShare(spec: OptimizationSpec, metric: MetricKey, share: number): OptimizationSpec {
    const want = Math.min(99, Math.max(1, Math.round(share)));
    const others = spec.objective.filter((t) => t.metric !== metric);
    const restTotal = others.reduce((s, t) => s + t.weight, 0) || 1;
    const objective = spec.objective.map((t) => (t.metric === metric ? { metric, weight: want / 100 } : { metric: t.metric, weight: ((100 - want) / 100) * (t.weight / restTotal) }));
    return { ...spec, objective };
}

export function withMetricAdded(spec: OptimizationSpec, metric: MetricKey): OptimizationSpec {
    if (spec.objective.length >= SPEC_LIMITS.terms || spec.objective.some((t) => t.metric === metric)) return spec;
    const scaled = spec.objective.map((t) => ({ metric: t.metric, weight: t.weight * 0.7 }));
    const next = { ...spec, objective: [...scaled, { metric, weight: 0.3 }] };
    return metric !== "blocks" && next.moves.allow === "remove" ? { ...next, moves: { ...next.moves, allow: "both" } } : next;
}

export function withMetricRemoved(spec: OptimizationSpec, metric: MetricKey): OptimizationSpec {
    if (spec.objective.length <= 1) return spec;
    return { ...spec, objective: spec.objective.filter((t) => t.metric !== metric) };
}

export type BlocksMode = "none" | "most" | "extra";

export function blocksModeOf(spec: Pick<OptimizationSpec, "constraints">): { mode: BlocksMode; value: number | null } {
    const c = spec.constraints;
    if (c.max_blocks !== null) return { mode: "most", value: c.max_blocks };
    if (c.max_added_blocks !== null) return { mode: "extra", value: c.max_added_blocks };
    return { mode: "none", value: null };
}

/** "No limit" / "at most N" / "at most +N" over the block count; `start` is the model's block count (the first value offered). */
export function withBlocks(spec: OptimizationSpec, mode: BlocksMode, value: number | null, start: number): OptimizationSpec {
    const c = spec.constraints;
    if (mode === "none") return { ...spec, constraints: { ...c, max_blocks: null, max_added_blocks: null } };
    if (mode === "most") return { ...spec, constraints: { ...c, max_blocks: value ?? start, max_added_blocks: null } };
    return { ...spec, constraints: { ...c, max_blocks: null, max_added_blocks: value ?? Math.max(5, Math.round(start * 0.1)) } };
}

export function withConstraint<K extends keyof OptimizationSpec["constraints"]>(spec: OptimizationSpec, key: K, value: OptimizationSpec["constraints"][K]): OptimizationSpec {
    return { ...spec, constraints: { ...spec.constraints, [key]: value } };
}

/** Taking blocks away and putting blocks in are two switches over the one "allow" field; at least one stays on. */
export function withMay(spec: OptimizationSpec, what: "remove" | "add", on: boolean): OptimizationSpec {
    const removing = what === "remove" ? on : spec.moves.allow !== "add";
    const adding = what === "add" ? on : spec.moves.allow !== "remove";
    if (!removing && !adding) return spec;
    return { ...spec, moves: { ...spec.moves, allow: removing && adding ? "both" : removing ? "remove" : "add" } };
}

// ---------- the name of a plan ----------

const LABEL_OF_METRIC: Record<MetricKey, string> = { blocks: AIM_LABEL.lightest, peak_stress: AIM_LABEL.strongest, cog_margin: AIM_LABEL.balanced, deflection: AIM_LABEL.stiffest };
const GOAL_PHRASE: Record<MetricKey, string> = {
    blocks: "use as few blocks as possible",
    peak_stress: "bring the strength used down",
    cog_margin: "put the weight further inside the base",
    deflection: "make it sag and sway less",
};

/**
 * The title a plan is saved under ("v4 · Strongest, +10 blocks") and the sentence shown under the goal, from what the controls say NOW. A plan
 * whose controls were changed no longer is the preset or the reading it came from, so its old title and sentence must not stay.
 */
export function describeSpec(spec: Pick<OptimizationSpec, "objective" | "moves" | "constraints" | "stop">): { title: string; summary: string } {
    const { objective, moves, constraints: c, stop } = spec;
    const adds = moves.allow !== "remove";
    const removes = moves.allow !== "add";
    // "Best balanced" is balance and strength together (the button's own goal); any other mix is named by its parts.
    const metrics = objective.map((t) => t.metric).sort().join();
    const parts = [metrics === "cog_margin,peak_stress" ? AIM_LABEL.balanced : objective.map((t) => LABEL_OF_METRIC[t.metric]).join(" + ")];
    if (c.max_blocks !== null) parts.push(`up to ${c.max_blocks} blocks`);
    else if (c.max_added_blocks !== null && adds) parts.push(`+${c.max_added_blocks} blocks`);
    if (removes && moves.removable === "any") parts.push("any block");
    if (stop.reduce_blocks_by_pct !== null) parts.push(`${Math.round(stop.reduce_blocks_by_pct)}% lighter`);
    const aim = objective.map((t) => GOAL_PHRASE[t.metric]).join(" and ");
    const sentences = [`${aim.charAt(0).toUpperCase()}${aim.slice(1)}.`];
    sentences.push(moves.allow === "remove" ? "Blocks are only taken away." : moves.allow === "add" ? "Blocks are only put in." : "Blocks may be taken away and put in.");
    if (removes) sentences.push(moves.removable === "added" ? "Only the support the stabilizer added may go." : moves.removable === "inner" ? "The outside shape stays the same." : "Any block may go, so the shape may change.");
    if (c.max_blocks !== null) sentences.push(`At most ${c.max_blocks} blocks.`);
    else if (c.max_added_blocks !== null && adds) sentences.push(`Up to ${c.max_added_blocks} extra blocks.`);
    if (stop.reduce_blocks_by_pct !== null) sentences.push(`Stops once it is ${Math.round(stop.reduce_blocks_by_pct)}% lighter.`);
    return { title: parts.join(", ").slice(0, SPEC_LIMITS.title).trim(), summary: sentences.join(" ").slice(0, SPEC_LIMITS.summary).trim() };
}

/** Two specs ask for the same thing (the title, the sentence and the notes are not part of the ask). */
export const sameControls = (a: OptimizationSpec, b: OptimizationSpec): boolean =>
    JSON.stringify([a.objective, a.moves, a.constraints, a.protected, a.stop]) === JSON.stringify([b.objective, b.moves, b.constraints, b.protected, b.stop]);

// ---------- what may not change ----------

const topLayer = (brief: Pick<Brief, "extent">): number => brief.extent.max[2];

/** The boxes the Protect menu offers besides the parts: the top and the bottom layers of the model. */
export function layerBox(kind: "top" | "bottom", count: number, brief: Pick<Brief, "extent">): CellBox {
    const n = Math.max(1, Math.min(9, Math.round(count)));
    return kind === "top"
        ? { min: [0, 0, Math.max(0, topLayer(brief) - n + 1)], max: [9, 9, 9] }
        : { min: [0, 0, 0], max: [9, 9, Math.min(9, n - 1)] };
}

const fullFootprint = (b: CellBox): boolean => b.min[0] === 0 && b.min[1] === 0 && b.max[0] === 9 && b.max[1] === 9;

/** A box in the panel's words: "top 2 layers", "layers 3 to 5", "a box (layers 3 to 5)". */
export function boxWords(box: CellBox, brief: Pick<Brief, "extent">): string {
    const [, , k0] = box.min;
    const k1 = box.max[2];
    const top = topLayer(brief);
    const layers = k0 === k1 ? `layer ${k0 + 1}` : `layers ${k0 + 1} to ${k1 + 1}`;
    if (fullFootprint(box)) {
        if (k1 >= top && k0 > 0) return `top ${plural(top - k0 + 1, "layer")}`;
        if (k0 === 0 && k1 < top) return `bottom ${plural(k1 + 1, "layer")}`;
        return layers;
    }
    return `a box (${layers})`;
}

/** The chip under "Keep as they are": what is protected, and how. */
export function protectLabel(region: ProtectedRegion, brief: Pick<Brief, "extent">): string {
    const what = region.part !== null ? region.part : region.box ? boxWords(region.box, brief) : "something";
    if (region.mode === "keep") return what;
    if (region.mode === "clear") return `Nothing added in ${what}`;
    return `Only ${what} may change`;
}

export function protectTip(region: ProtectedRegion): string {
    if (region.mode === "keep") return "These blocks stay as they are: none is taken out.";
    if (region.mode === "clear") return "Nothing is put in here.";
    return "Only blocks in here may change; everything else stays.";
}

export function withProtection(spec: OptimizationSpec, region: ProtectedRegion): OptimizationSpec {
    if (spec.protected.length >= SPEC_LIMITS.regions) return spec;
    const same = (a: ProtectedRegion) => a.mode === region.mode && a.part === region.part && JSON.stringify(a.box) === JSON.stringify(region.box);
    return spec.protected.some(same) ? spec : { ...spec, protected: [...spec.protected, region] };
}

export function withoutProtection(spec: OptimizationSpec, index: number): OptimizationSpec {
    return { ...spec, protected: spec.protected.filter((_, i) => i !== index) };
}

/** Symmetry the model has (offered) plus "none". */
export const symmetryChoices = (brief: Pick<Brief, "current">): Symmetry[] => ["none", ...brief.current.symmetric];
export const SYMMETRY_WORDS: Record<Symmetry, string> = { none: "Not needed", x: "Left to right", y: "Front to back", xy: "Both ways" };

// ---------- the line that says whether the start already meets the limits ----------

export interface TodayRow {
    key: "strength" | "balance" | "overhang" | "blocks";
    label: string;
    /** "69% (limit 75%)". */
    text: string;
    ok: boolean;
}

/** The figures of the start against the limits the run will hold to. */
export function todayRows(
    start: { blocks: number; maxUtil: number | null; cogMarginMm: number | null; longestReach: number; floating: number },
    effective: Pick<Effective, "maxStressPct" | "minCogMarginMm" | "cantileverBlocks" | "maxBlocks" | "minBlocks">,
): TodayRow[] {
    const rows: TodayRow[] = [];
    if (start.maxUtil !== null) rows.push({ key: "strength", label: "Strength used", text: `${Math.round(start.maxUtil * 100)}% (limit ${Math.round(effective.maxStressPct)}%)`, ok: start.maxUtil * 100 <= effective.maxStressPct + 1e-9 });
    if (start.cogMarginMm !== null) rows.push({ key: "balance", label: "Balance", text: `${Math.round(start.cogMarginMm)} mm (at least ${Math.round(effective.minCogMarginMm)})`, ok: start.cogMarginMm >= effective.minCogMarginMm - 1e-9 });
    rows.push({ key: "overhang", label: "Longest overhang", text: `${start.longestReach} (limit ${effective.cantileverBlocks})`, ok: start.longestReach <= effective.cantileverBlocks });
    rows.push({ key: "blocks", label: "Blocks", text: `${start.blocks} (${effective.minBlocks > 1 ? `${effective.minBlocks} to ` : "up to "}${effective.maxBlocks})`, ok: start.blocks <= effective.maxBlocks && start.blocks >= effective.minBlocks });
    return rows;
}

// ---------- the request ----------

/** The request body stays under the Worker's 6 KB: when the parts of a big model do not fit, the smallest are left out of the brief. */
export function fitBrief(brief: Brief, goal: string, maxBytes = 5500): Brief {
    let fitted = brief;
    const size = (b: Brief) => new TextEncoder().encode(JSON.stringify({ goal, brief: b })).length;
    while (fitted.parts.length > 0 && size(fitted) > maxBytes) {
        const smallest = fitted.parts.reduce((m, p, i, all) => (p.blocks < all[m].blocks ? i : m), 0);
        fitted = { ...fitted, parts: fitted.parts.filter((_, i) => i !== smallest) };
    }
    return fitted;
}

/** What went wrong asking Muse for the plan, in a sentence that ends with what still works. */
export function planErrorMessage(error: unknown): string {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 0;
    const base =
        status === 401
            ? "An access code is needed to ask Muse."
            : status === 429
              ? "Today's limit of AI requests is used up."
              : status === 503
                ? "Muse is not set up on this server."
                : status === 504 || status === 0
                  ? "Muse did not answer."
                  : status === 422
                    ? "Muse could not take that goal."
                    : status === 400
                      ? "That goal could not be sent."
                      : "Muse could not read the goal.";
    const detail = status === 422 && error instanceof Error && error.message ? ` ${error.message}` : "";
    return `${base}${detail} The four buttons below still work.`;
}

// ---------- while it runs ----------

/** One point of the convergence chart: the state after a round (round 0 is the start). */
export interface LiveRow {
    iteration: number;
    blocks: number;
    /** Share of the strength the busiest joint uses (0 to 1), null when nothing stands on the ground. */
    util: number | null;
    /** Weight inside the base, mm. */
    margin: number | null;
    /** How far the busiest block sags, mm (the chart and the counters show it against the start's). */
    deflection: number | null;
}

export const rowOfRecord = (r: Pick<IterationRecord, "iteration" | "blocks" | "maxUtil" | "cogMarginMm" | "maxDeflectionMm">): LiveRow => ({
    iteration: r.iteration,
    blocks: r.blocks,
    util: r.maxUtil,
    margin: r.cogMarginMm,
    deflection: r.maxDeflectionMm,
});

/** Which figure the chart's second line follows: the strength used, unless the goal has no strength in it and is about balance or sag. */
export type Focus = "strength" | "balance" | "sag";

export function focusOf(objective: readonly MetricKey[]): Focus {
    if (objective.includes("peak_stress")) return "strength";
    if (objective.includes("cog_margin")) return "balance";
    if (objective.includes("deflection")) return "sag";
    return "strength";
}

/** The sag against the start's (1 = as before), null when either is unknown. */
export const sagShare = (now: number | null, start: number | null | undefined): number | null => (now === null || start === null || start === undefined || start <= 0 ? null : now / start);

/** What the last round did: "Round 12: took out 4 blocks". */
export function moveSentence(record: Pick<IterationRecord, "iteration" | "removed" | "added">): string {
    const { removed, added, iteration } = record;
    const what =
        removed > 0 && added > 0
            ? `swapped: took out ${plural(removed, "block")}, put in ${added}`
            : removed > 0
              ? `took out ${plural(removed, "block")}`
              : `put in ${plural(added, "block")}`;
    return `Round ${iteration}: ${what}`;
}

/**
 * The counters under the run's title: "Round 23 · 103 → 71 blocks · 247 → 170 kg · 61% strength used". With the goal (its metrics), the figure the
 * goal is about comes before the strength used: "Weight inside the base 139 → 261 mm" for a balance goal, "Sag 62% of before" for a stiffness goal.
 */
export function counterLine(start: { blocks: number; cogMarginMm?: number | null; maxDeflectionMm?: number | null }, now: LiveRow | null, kgPer: number, goal: readonly MetricKey[] = []): string {
    if (!now) return `${plural(start.blocks, "block")} · ${kgText(start.blocks * kgPer)}`;
    const parts = [`Round ${now.iteration}`, `${start.blocks} → ${plural(now.blocks, "block")}`, `${round(start.blocks * kgPer)} → ${kgText(now.blocks * kgPer)}`];
    if (goal.includes("cog_margin") && now.margin !== null) {
        parts.push(start.cogMarginMm === null || start.cogMarginMm === undefined ? `Weight inside the base ${Math.round(now.margin)} mm` : `Weight inside the base ${Math.round(start.cogMarginMm)} → ${Math.round(now.margin)} mm`);
    }
    const sag = goal.includes("deflection") ? sagShare(now.deflection, start.maxDeflectionMm) : null;
    if (sag !== null) parts.push(`Sag ${Math.round(sag * 100)}% of before`);
    if (now.util !== null) parts.push(`${Math.round(now.util * 100)}% strength used`);
    return parts.join(" · ");
}

/** "Optimizing · 12 s of ~30 s". */
export function runningTitle(elapsedMs: number, effort: Effort): string {
    const seconds = Math.floor(elapsedMs / 1000);
    return `Optimizing · ${seconds} s of ~${Math.round(EFFORTS[effort].timeBudgetMs / 1000)} s`;
}

// ---------- the result in words ----------

export const STOP_WORDS: Record<StopReason, string> = {
    // Only said of a run that stopped on its own accord; "every single block" is for a run that proved it (SWEEP_COMPLETE_WORDS).
    converged: "It stopped when the changes it tried no longer helped.",
    "target-reached": "It reached the target you set.",
    "budget-used": "It used the extra blocks it was allowed.",
    "max-iterations": "It stopped at the most rounds it tries.",
    "max-solves": "It stopped at the most checks it makes; Thorough may find a little more.",
    "time-budget": "It ran out of time; Thorough may find a little more.",
    canceled: "You stopped it. This is the best valid state it had reached.",
    infeasible: "It could not meet a limit, so nothing changed.",
};

/** What a run that tried every single change and found none to help says (OptimizeResult.complete). */
export const SWEEP_COMPLETE_WORDS = "No single block can change without breaking a limit or making the goal worse.";

/** Why a finished run stopped, in words: the strong claim of a converged run only when it was proven. */
export function stopWords(result: { stop: StopReason; complete?: boolean }): string {
    return result.stop === "converged" && result.complete === true ? SWEEP_COMPLETE_WORDS : STOP_WORDS[result.stop];
}

/**
 * A valid run that changed nothing: the headline says why first (a Stop or a time-out is not "as good as it gets") and the line under it
 * says what to do next. `rounds` is the last round it reached; `effective` has the scope the controls resolved to.
 */
export function noChangeWords(input: {
    stop: StopReason;
    complete?: boolean;
    rounds: number;
    blocks: number;
    effective: Pick<Effective, "allow" | "removable" | "removableBlocks"> | null;
}): { headline: string; detail: string } {
    const { stop, rounds, blocks, effective } = input;
    switch (stop) {
        case "canceled":
            return { headline: "You stopped it before it changed anything.", detail: `You stopped it at round ${rounds}. Press Optimize again and give it a few seconds.` };
        case "time-budget":
            return { headline: "It ran out of time before it found a change.", detail: "Try Thorough, which gives it more time, or loosen a limit." };
        case "max-solves":
        case "max-iterations":
            return { headline: "It used up its checks before it found a change.", detail: "Loosen a limit, or let more blocks change, and try again." };
        case "budget-used":
            return { headline: "There is no room to put more blocks in.", detail: "Raise the block limit, or let it take blocks away." };
        default: {
            const few = effective !== null && effective.allow !== "add" && effective.removableBlocks < Math.max(3, blocks * 0.03);
            const scope = few
                ? `Only ${effective.removableBlocks} of ${blocks} blocks may be taken out with these settings.${effective.removable !== "any" ? " Choose “Any block” under May change to free more." : " Loosening a protection frees more."}`
                : "";
            return { headline: "Already as good as this goal allows.", detail: [scope, stopWords({ stop, complete: input.complete })].filter(Boolean).join(" ") };
        }
    }
}

/** The sentence that says what the run did to the figures the goal was about. Only what got better is said; the table shows the rest. */
export function verdictLine(before: OptimizeMetrics, after: OptimizeMetrics, objective: readonly MetricKey[], summary?: { shape_changed: boolean }): string {
    const phrases: string[] = [];
    for (const metric of objective) {
        switch (metric) {
            case "blocks": {
                const d = before.blocks - after.blocks;
                if (d > 0) phrases.push(`Lighter by ${plural(d, "block")} (${MINUS}${Math.round((d / before.blocks) * 100)}%)`);
                break;
            }
            case "peak_stress":
                if (before.max_utilisation !== null && after.max_utilisation !== null && Math.round(after.max_utilisation * 100) < Math.round(before.max_utilisation * 100)) {
                    phrases.push(`Strength used ${pctText(before.max_utilisation)} → ${pctText(after.max_utilisation)}`);
                }
                break;
            case "cog_margin":
                if (before.cog_margin_mm !== null && after.cog_margin_mm !== null && Math.round(after.cog_margin_mm) > Math.round(before.cog_margin_mm)) {
                    phrases.push(`Weight ${Math.round(before.cog_margin_mm)} → ${Math.round(after.cog_margin_mm)} mm inside the base`);
                }
                break;
            case "deflection":
                if (before.max_deflection_um !== null && after.max_deflection_um !== null && before.max_deflection_um > 0) {
                    const change = Math.round(((after.max_deflection_um - before.max_deflection_um) / before.max_deflection_um) * 100);
                    if (change < 0) phrases.push(`Sags ${Math.abs(change)}% less`);
                }
                break;
        }
    }
    const still = after.errors === 0 ? "and still stands" : `with ${plural(after.errors, "problem")} left`;
    const shape = summary?.shape_changed ? " The outside shape changed." : "";
    if (phrases.length === 0) return `Nothing got better.${shape}`;
    const first = phrases[0];
    const rest = phrases.slice(1);
    return rest.length === 0 ? `${first} ${still}.${shape}` : `${[first, ...rest.map((p) => p.charAt(0).toLowerCase() + p.slice(1))].join(", ")} — ${still}.${shape}`;
}

export interface CompareRow {
    key: "blocks" | "weight" | "strength" | "balance" | "overhang" | "sag" | "checks";
    label: string;
    tip: string;
    before: string;
    after: string;
    change: string;
    /** The goal was about this figure and it got better. */
    better: boolean;
}

const METRIC_OF_ROW: Partial<Record<CompareRow["key"], MetricKey>> = { blocks: "blocks", weight: "blocks", strength: "peak_stress", balance: "cog_margin", sag: "deflection" };

/** The Before | After | Change table. Deflection is shown as a relative change (the figures are micrometres). */
export function compareRows(before: OptimizeMetrics, after: OptimizeMetrics, objective: readonly MetricKey[]): CompareRow[] {
    const mark = (key: CompareRow["key"], better: boolean) => {
        const metric = METRIC_OF_ROW[key];
        return better && metric !== undefined && objective.includes(metric);
    };
    const rows: CompareRow[] = [];
    const db = after.blocks - before.blocks;
    rows.push({ key: "blocks", label: "Blocks", tip: "How many 100 mm blocks the model is built from.", before: String(before.blocks), after: String(after.blocks), change: db === 0 ? "same" : signed(db), better: mark("blocks", db < 0) });
    const dw = after.weight_kg - before.weight_kg;
    rows.push({ key: "weight", label: "Weight", tip: "Blocks times the weight of one block of the chosen material.", before: kgText(before.weight_kg), after: kgText(after.weight_kg), change: Math.abs(dw) < 0.05 ? "same" : `${signed(round(dw, 1))} kg`, better: mark("weight", dw < 0) });
    if (before.max_utilisation !== null && after.max_utilisation !== null) {
        const d = Math.round(after.max_utilisation * 100) - Math.round(before.max_utilisation * 100);
        rows.push({ key: "strength", label: "Strength used", tip: "How much of a joint's strength the model's own weight uses. Technical term: joint utilisation.", before: pctText(before.max_utilisation), after: pctText(after.max_utilisation), change: d === 0 ? "same" : `${signed(d)} points`, better: mark("strength", d < 0) });
    }
    if (before.cog_margin_mm !== null && after.cog_margin_mm !== null) {
        const d = Math.round(after.cog_margin_mm) - Math.round(before.cog_margin_mm);
        rows.push({ key: "balance", label: "Weight inside the base", tip: "How far the model's weight is from the edge of its base. Technical term: centre-of-gravity margin.", before: mmText(before.cog_margin_mm), after: mmText(after.cog_margin_mm), change: d === 0 ? "same" : `${signed(d)} mm`, better: mark("balance", d > 0) });
    }
    const dl = after.longest_cantilever - before.longest_cantilever;
    rows.push({ key: "overhang", label: "Longest overhang", tip: "How many blocks the biggest overhang sticks out. Technical term: cantilever.", before: String(before.longest_cantilever), after: String(after.longest_cantilever), change: dl === 0 ? "same" : signed(dl), better: false });
    if (before.max_deflection_um !== null && after.max_deflection_um !== null && before.max_deflection_um > 0) {
        const rel = Math.round(((after.max_deflection_um - before.max_deflection_um) / before.max_deflection_um) * 100);
        rows.push({ key: "sag", label: "Sag", tip: "How far the model sags and sways under its own weight, compared with before. Technical term: peak deflection.", before: "100%", after: `${100 + rel}%`, change: rel === 0 ? "same" : `${signed(rel)}%`, better: mark("sag", rel < 0) });
    }
    const problems = after.errors + after.warnings;
    rows.push({ key: "checks", label: "Checks", tip: "The Stability tab's checks for the new version.", before: checksWord(before), after: checksWord(after), change: problems === 0 ? "all pass" : "see Stability", better: false });
    return rows;
}

function checksWord(m: Pick<OptimizeMetrics, "errors" | "warnings">): string {
    if (m.errors > 0) return plural(m.errors, "problem");
    return m.warnings > 0 ? plural(m.warnings, "warning") : "all pass";
}

/** "28% of the 30% asked for" when a "make it N% lighter" target was not met, else null. */
export function targetLine(spec: Pick<OptimizationSpec, "stop">, before: OptimizeMetrics, after: OptimizeMetrics): string | null {
    const want = spec.stop.reduce_blocks_by_pct;
    if (want === null || before.blocks <= 0) return null;
    const got = Math.round(((before.blocks - after.blocks) / before.blocks) * 100);
    return got >= want ? null : `${Math.max(0, got)}% of the ${Math.round(want)}% asked for.`;
}

/** The chat line that presents the saved version: "Optimized v5 · Lightest — 103 → 63 blocks (−39%)." `name` is the version's name in the bar ("v5 · Lightest"). */
export function savedMessage(summary: Pick<OptimizeSummary, "title" | "before" | "after">, name?: string): string {
    const { before, after } = summary;
    const d = after.blocks - before.blocks;
    const pct = before.blocks > 0 ? Math.round((d / before.blocks) * 100) : 0;
    const change = d === 0 ? `${plural(after.blocks, "block")}, same count` : `${before.blocks} → ${plural(after.blocks, "block")} (${signed(pct)}%)`;
    return `Optimized ${name ?? `“${summary.title}”`} — ${change}.`;
}

// ---------- the stage ----------

/** The descriptor of an occupancy: each block keeps the role and step it had in `base` (cell index -> [role, step]); new ones are reinforcement of `newStep`. */
export function descriptorOf(occ: Uint8Array, was: (cell: number) => readonly [number, number] | null, reinforcement: number, newStep: number): AssemblyDescriptor {
    const cells: number[] = [];
    const plane = ASSEMBLY_GRID * ASSEMBLY_GRID;
    for (let c = 0; c < occ.length; c++) {
        if (!occ[c]) continue;
        const k = Math.floor(c / plane);
        const r = c - k * plane;
        const j = Math.floor(r / ASSEMBLY_GRID);
        const [role, step] = was(c) ?? [reinforcement, newStep];
        cells.push(r - j * ASSEMBLY_GRID, j, k, role, step);
    }
    return { version: 1, blockSizeMm: ASSEMBLY_BLOCK_MM, grid: [ASSEMBLY_GRID, ASSEMBLY_GRID, ASSEMBLY_GRID], inset: 0.96, cells };
}

/** Cell index -> [i, j, k]. */
export const cellOf = (c: number): [number, number, number] => {
    const plane = ASSEMBLY_GRID * ASSEMBLY_GRID;
    const k = Math.floor(c / plane);
    const r = c - k * plane;
    const j = Math.floor(r / ASSEMBLY_GRID);
    return [r - j * ASSEMBLY_GRID, j, k];
};

/** The occupancy after round `round` of a finished run: the start with every move up to that round applied. */
export function occupancyAt(
    start: Uint8Array,
    run: { removed: readonly number[]; removedAt: readonly number[]; added: readonly number[]; addedAt: readonly number[] },
    round: number,
): Uint8Array {
    const occ = start.slice();
    run.removed.forEach((c, n) => {
        if (run.removedAt[n] <= round) occ[c] = 0;
    });
    run.added.forEach((c, n) => {
        if (run.addedAt[n] <= round) occ[c] = 1;
    });
    return occ;
}

export type CompareMode = "before" | "after" | "changes";
export const COMPARE_WORDS: Record<CompareMode, string> = { before: "Before", after: "After", changes: "Changes" };
