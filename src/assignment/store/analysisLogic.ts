// Pure logic behind the analysis report: settings (clamped, persisted), the verdict wording, which issue a
// check or a block belongs to, what selecting an issue puts on the viewer, and the run phase. No React and no
// store, so store/analysis.ts, the components and scripts/assignment/test-store.mjs share one copy.

import {
    DEFAULT_ANALYSIS_SETTINGS,
    type AnalysisColorBy,
    type AnalysisResult,
    type AnalysisSettings,
    type Block,
    type CheckKey,
    type CheckRow,
    type Issue,
    type IssueKind,
    type Vec3,
} from "@/assignment/analysis/types";
import { technicalWordsIn } from "@/assignment/components/analysis/vocabulary";
import { MATERIAL_IDS, type AnalysisSummary, type MaterialId, type StressSummary } from "@/assignment/shared/contract";
import { STRESS_WARN_SHARE } from "@/assignment/viewer/analysisGeometry";

// ---------- settings ----------

export const SETTINGS_STORAGE_KEY = "assembly-studio-analysis-settings";

/** What the settings panel lets the user pick; sanitizeSettings clamps stored and typed values to it. */
export const FILL_RANGE = { min: 0.1, max: 0.9, step: 0.05 } as const;
/**
 * A reach is counted along the structure in horizontal block steps (a step across a corner is one). A straight arm
 * or a plate can never reach further than 9 in a 10-wide grid; larger limits only matter for winding arms. The worker
 * accepts 1-10 for the saved summary, so the box stops there too.
 */
export const LIMIT_RANGE = { min: 1, max: 10 } as const;
export const BUDGET_RANGE = { min: 1, max: 1000 } as const;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Anything (a stored string, a half-typed field) -> valid settings. The target size and the block size are
 * fixed by the assignment, so they are never read from storage.
 */
export function sanitizeSettings(raw: unknown): AnalysisSettings {
    const base = DEFAULT_ANALYSIS_SETTINGS;
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const fill =
        typeof r.fillThreshold === "number" && Number.isFinite(r.fillThreshold)
            ? Math.round(clamp(r.fillThreshold, FILL_RANGE.min, FILL_RANGE.max) * 100) / 100
            : base.fillThreshold;
    const limit =
        typeof r.cantileverLimit === "number" && Number.isFinite(r.cantileverLimit)
            ? clamp(Math.round(r.cantileverLimit), LIMIT_RANGE.min, LIMIT_RANGE.max)
            : base.cantileverLimit;
    const budget =
        typeof r.maxBlocks === "number" && Number.isFinite(r.maxBlocks) && r.maxBlocks >= 1
            ? clamp(Math.round(r.maxBlocks), BUDGET_RANGE.min, BUDGET_RANGE.max)
            : null;
    const material: MaterialId = MATERIAL_IDS.includes(r.material as MaterialId) ? (r.material as MaterialId) : base.material;
    return {
        targetSizeMm: base.targetSizeMm,
        blockSizeMm: base.blockSizeMm,
        fillThreshold: fill,
        cantileverLimit: limit,
        maxBlocks: budget,
        material,
    };
}

export function loadSettings(): AnalysisSettings {
    try {
        const text = localStorage.getItem(SETTINGS_STORAGE_KEY);
        return sanitizeSettings(text ? JSON.parse(text) : null);
    } catch {
        // Storage blocked or a corrupt value: the defaults.
        return sanitizeSettings(null);
    }
}

export function saveSettings(settings: AnalysisSettings): void {
    try {
        localStorage.setItem(
            SETTINGS_STORAGE_KEY,
            JSON.stringify({
                fillThreshold: settings.fillThreshold,
                cantileverLimit: settings.cantileverLimit,
                maxBlocks: settings.maxBlocks,
                material: settings.material,
            }),
        );
    } catch {
        // Not persisted (private mode): the settings still apply to this visit.
    }
}

export const sameSettings = (a: AnalysisSettings, b: AnalysisSettings): boolean =>
    a.targetSizeMm === b.targetSizeMm &&
    a.blockSizeMm === b.blockSizeMm &&
    a.fillThreshold === b.fillThreshold &&
    a.cantileverLimit === b.cantileverLimit &&
    a.maxBlocks === b.maxBlocks &&
    a.material === b.material;

/** One string per distinct set of settings: "was this model already saved with these?" */
export const settingsKey = (s: AnalysisSettings): string =>
    `${s.targetSizeMm}|${s.blockSizeMm}|${s.fillThreshold}|${s.cantileverLimit}|${s.maxBlocks ?? "-"}|${s.material}`;

/** The stress part of two summaries. Both missing is the same (a summary saved before the estimate, or nothing on the ground). */
function sameStress(a: StressSummary | null | undefined, b: StressSummary | null | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        a.material === b.material &&
        Math.abs(a.max_utilisation - b.max_utilisation) < 1e-6 &&
        a.stressed_blocks === b.stressed_blocks &&
        a.overstressed_blocks === b.overstressed_blocks &&
        a.analysed_blocks === b.analysed_blocks &&
        a.unsupported_blocks === b.unsupported_blocks
    );
}

/** Two summaries that say the same thing about the same settings (analysed_at is ignored). */
export function sameSummary(a: AnalysisSummary | null | undefined, b: AnalysisSummary | null | undefined): boolean {
    if (!a || !b) return false;
    return (
        a.blocks === b.blocks &&
        a.bodies === b.bodies &&
        a.floating_blocks === b.floating_blocks &&
        a.cantilevered === b.cantilevered &&
        a.longest_cantilever === b.longest_cantilever &&
        a.over_limit === b.over_limit &&
        a.cantilever_limit === b.cantilever_limit &&
        a.fill_threshold === b.fill_threshold &&
        a.cog_inside === b.cog_inside &&
        a.errors === b.errors &&
        a.warnings === b.warnings &&
        sameStress(a.stress, b.stress)
    );
}

// ---------- the verdict ----------

export type VerdictKind = "pass" | "warn" | "fail";

/**
 * What a verdict leaves for the stabilizer to act on. The stabilizer moves on floating parts, long arms, the balance and the joint
 * stress, never on thin parts that were left out of the blocks (nothing it adds brings them back), so a warning about those alone
 * is nothing for it to fix:
 *  - "stabilize": a problem (an error), a model balanced on the edge, or a warning that cannot be told apart from those;
 *  - "stress": only heavily loaded joints are left (the button says "Reduce stress");
 *  - "none": nothing the stabilizer can fix (a clean model, or only "thin parts left out").
 */
export type StabilizeFix = "stabilize" | "stress" | "none";

export interface Verdict {
    kind: VerdictKind;
    /** What the stabilizer can do about it (see StabilizeFix); counted from the issues of a result, else inferred from the summary. */
    fix: StabilizeFix;
    errors: number;
    warnings: number;
    blocks: number;
    /** "limit 9, fill 60%" when the analysis ran with other than the default settings, else null. */
    custom: string | null;
    /** The big pill in the report: "Stable · all checks pass", "3 problems found", "2 warnings". */
    headline: string;
    /** The compact form for badges and the chat card: "Stable", "3 problems", "2 warnings". */
    short: string;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Which settings differ from the assignment's defaults, in words: "limit 9, fill 60%"; null when none do. */
export function customSettingsNote(s: {
    cantileverLimit?: number;
    fillThreshold?: number;
    maxBlocks?: number | null;
    material?: MaterialId;
}): string | null {
    const base = DEFAULT_ANALYSIS_SETTINGS;
    const parts: string[] = [];
    if (s.cantileverLimit !== undefined && s.cantileverLimit !== base.cantileverLimit) parts.push(`limit ${s.cantileverLimit}`);
    if (s.fillThreshold !== undefined && Math.abs(s.fillThreshold - base.fillThreshold) > 1e-6) {
        parts.push(`fill ${Math.round(s.fillThreshold * 100)}%`);
    }
    if (s.maxBlocks !== undefined && s.maxBlocks !== null) parts.push(`budget ${s.maxBlocks}`);
    if (s.material !== undefined && s.material !== base.material) parts.push(`material ${s.material}`);
    return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * What verdictOf reads of a summary (or of a result, which has no summary of that shape). The optional figures only tell the
 * stabilizer's part apart (fixOfSummary); `fix` is that part given outright, for a result whose issues are at hand.
 */
export type VerdictInput = Pick<AnalysisSummary, "errors" | "warnings" | "blocks"> &
    Partial<Pick<AnalysisSummary, "cantilever_limit" | "fill_threshold" | "coverage" | "cog_inside" | "cog_margin_mm">> & {
        /** The material the stress was estimated with; a stored summary says it in `stress`. */
        material?: MaterialId;
        stress?: (Pick<StressSummary, "material"> & Partial<Pick<StressSummary, "max_utilisation">>) | null;
        fix?: StabilizeFix;
    };

// ---------- what the stabilizer can do about a verdict ----------

/**
 * Mirrors COVERAGE_WARN and EDGE_MARGIN_MM of analysis/issues.ts (the engine is loaded on demand, so the panel's logic does not import
 * it); test-store.mjs pins them equal to the engine's.
 */
export const COVERAGE_WARN_SHARE = 0.8;
export const EDGE_WARN_MM = 1;

/** The fix a result's own issue list leaves: counted from the kinds, so it is exactly what the Problems list shows. */
export function fixOfIssues(issues: ReadonlyArray<Pick<Issue, "kind" | "severity">>): StabilizeFix {
    if (issues.some((issue) => issue.severity === "error")) return "stabilize";
    const left = issues.filter((issue) => issue.severity === "warning" && issue.kind !== "thin-features");
    if (left.length === 0) return "none";
    return left.every((issue) => issue.kind === "highly-stressed") ? "stress" : "stabilize";
}

/**
 * The same from a saved summary, which has the counts but not the kinds. The warnings a model without errors can have are three:
 * balanced on the edge (the centre of gravity inside the base by less than EDGE_WARN_MM), heavily loaded joints (the peak above the
 * warning level), and thin parts left out (coverage below COVERAGE_WARN_SHARE). Anything that does not add up to those (a summary
 * from before the stress estimate, a rounded margin) is offered as "stabilize" rather than hidden.
 */
export function fixOfSummary(s: Pick<VerdictInput, "errors" | "warnings" | "coverage" | "cog_inside" | "cog_margin_mm" | "stress">): StabilizeFix {
    if (Math.round(s.errors) > 0) return "stabilize";
    const warnings = Math.round(s.warnings);
    if (warnings <= 0) return "none";
    if (s.cog_inside === true && typeof s.cog_margin_mm === "number" && s.cog_margin_mm < EDGE_WARN_MM) return "stabilize";
    if (typeof s.stress?.max_utilisation === "number" && s.stress.max_utilisation > STRESS_WARN_SHARE) return "stress";
    const thin = typeof s.coverage === "number" && s.coverage < COVERAGE_WARN_SHARE;
    return thin && warnings === 1 ? "none" : "stabilize";
}

/** The stabilizer button's words for a verdict, or null when there is nothing for it to fix (so no button and no pill). */
export type StabilizeLabel = "Stabilize" | "Reduce stress";

export function stabilizeLabelOf(verdict: (Pick<Verdict, "kind"> & Partial<Pick<Verdict, "fix">>) | null): StabilizeLabel | null {
    if (!verdict || verdict.kind === "pass") return null;
    if (verdict.kind === "fail") return "Stabilize";
    // A warning-only verdict whose fix is not known is offered under the plain word: "Reduce stress" is a claim about the cause.
    return verdict.fix === "none" ? null : verdict.fix === "stress" ? "Reduce stress" : "Stabilize";
}

export function verdictOf(s: VerdictInput | null | undefined, maxBlocks?: number | null): Verdict | null {
    if (!s) return null;
    const errors = Math.max(0, Math.round(s.errors));
    const warnings = Math.max(0, Math.round(s.warnings));
    const custom = customSettingsNote({
        cantileverLimit: s.cantilever_limit,
        fillThreshold: s.fill_threshold,
        maxBlocks,
        material: s.material ?? s.stress?.material,
    });
    const fix = s.fix ?? fixOfSummary({ ...s, errors, warnings });
    const base = { errors, warnings, blocks: s.blocks, custom, fix };
    if (errors > 0) {
        return { ...base, kind: "fail", headline: `${plural(errors, "problem")} found`, short: plural(errors, "problem") };
    }
    if (warnings > 0) {
        return { ...base, kind: "warn", headline: plural(warnings, "warning"), short: plural(warnings, "warning") };
    }
    return { ...base, kind: "pass", headline: "Stable · all checks pass", short: "Stable" };
}

// ---------- issues: by check, by block, selection ----------

/** Which issue kinds belong to each check row (a failing row selects them). */
export const CHECK_ISSUE_KINDS: Record<CheckKey, readonly IssueKind[]> = {
    cog: ["cog-outside"],
    cantilevered: [],
    "long-cantilevers": ["cantilever-too-long"],
    components: ["too-many-blocks"],
    floating: ["floating"],
    stress: ["overstressed", "highly-stressed"],
};

export function issuesForCheck(issues: readonly Issue[], key: CheckKey): Issue[] {
    const kinds = CHECK_ISSUE_KINDS[key];
    return issues.filter((issue) => kinds.includes(issue.kind));
}

/**
 * The issues a check row opens. The same as issuesForCheck, except that a centre-of-gravity row that fails
 * because nothing touches the ground has no issue of its own: its cause is the floating parts, so it opens those.
 */
export function issuesForCheckRow(result: Pick<AnalysisResult, "issues" | "stability">, row: Pick<CheckRow, "key" | "status">): Issue[] {
    const own = issuesForCheck(result.issues, row.key);
    if (own.length > 0 || row.key !== "cog" || row.status !== "fail" || result.stability) return own;
    return issuesForCheck(result.issues, "floating");
}

/** How an issue card relates to the selection: it is the only one shown, one of several, or not shown. */
export type SelectionRole = "only" | "member" | "none";

export function selectionRole(selection: Pick<SelectionState, "ids"> | null, id: string): SelectionRole {
    if (!selection || !selection.ids.includes(id)) return "none";
    return selection.ids.length === 1 ? "only" : "member";
}

/**
 * block index -> the id of the issue it belongs to. `issues` is ordered errors first, so a block in an error
 * and a warning belongs to the error.
 */
export function indexIssuesByBlock(issues: readonly Issue[]): Map<number, string> {
    const map = new Map<number, string>();
    for (const issue of issues) {
        for (const block of issue.blocks) if (!map.has(block)) map.set(block, issue.id);
    }
    return map;
}

export interface SelectionView {
    /** Union of the blocks of the chosen issues, ascending. */
    highlight: number[];
    /** Where the camera goes: the first chosen issue's focus point. */
    focusMm: Vec3 | null;
    label: string;
}

/** What selecting these issues puts on the viewer; null when none of the ids exists. */
export function selectionView(issues: readonly Issue[], ids: readonly string[], label?: string): SelectionView | null {
    const chosen = ids.map((id) => issues.find((issue) => issue.id === id)).filter((issue): issue is Issue => !!issue);
    if (chosen.length === 0) return null;
    const blocks = new Set<number>();
    for (const issue of chosen) for (const block of issue.blocks) blocks.add(block);
    return {
        highlight: [...blocks].sort((a, b) => a - b),
        focusMm: chosen[0].focusMm,
        label: label ?? (chosen.length === 1 ? chosen[0].title : `${chosen.length} issues`),
    };
}

/** The ids of a selection that still exist after a re-run (issue ids may change with the settings). */
export const keepExistingIds = (issues: readonly Issue[], ids: readonly string[]): string[] =>
    ids.filter((id) => issues.some((issue) => issue.id === id));

/** Blocks with nothing underneath (within the limit or beyond it): the "Overhanging blocks" row shows these. */
export const cantileveredBlocks = (blocks: readonly Block[]): number[] =>
    blocks.filter((block) => block.status === "cantilever" || block.status === "overreach").map((block) => block.index);

/** The block of the group closest to the group's centre: a point the camera can look at that is on the design. */
export function centreBlockMm(blocks: readonly Block[], ids: readonly number[]): Vec3 | null {
    if (ids.length === 0) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const id of ids) {
        x += blocks[id].centerMm[0];
        y += blocks[id].centerMm[1];
        z += blocks[id].centerMm[2];
    }
    const n = ids.length;
    let best = blocks[ids[0]].centerMm;
    let bestDistance = Infinity;
    for (const id of ids) {
        const c = blocks[id].centerMm;
        const d = (c[0] - x / n) ** 2 + (c[1] - y / n) ** 2 + (c[2] - z / n) ** 2;
        if (d < bestDistance) {
            bestDistance = d;
            best = c;
        }
    }
    return best;
}

/** What is selected in the report: issues (by id) or, for the cantilevered-blocks row, a group of blocks. */
export interface SelectionState {
    /** Issue ids; several when a failing check row selected every issue of its kind. Empty for a block group. */
    ids: string[];
    check: CheckKey | null;
    /** What to call it: the issue's title, or "Long cantilevers: 3 places". */
    label: string;
}

/**
 * The selection after a re-run: the issues that still exist (the settings can change them), or the new
 * cantilevered blocks. null when nothing of it is left. When nothing about the selection changed, `prev` itself
 * comes back, so whatever watches the selection by identity does not mistake a re-run for a new choice.
 */
export function reconcileSelection(
    result: Pick<AnalysisResult, "issues" | "blocks">,
    prev: SelectionState | null,
): { selection: SelectionState; highlight: number[] } | null {
    if (!prev) return null;
    const stable = (next: SelectionState): SelectionState =>
        next.check === prev.check && next.label === prev.label && next.ids.length === prev.ids.length && next.ids.every((id, i) => id === prev.ids[i])
            ? prev
            : next;
    if (prev.ids.length === 0) {
        if (prev.check !== "cantilevered") return null;
        const blocks = cantileveredBlocks(result.blocks);
        if (blocks.length === 0) return null;
        return { selection: stable({ ...prev, label: `Overhanging blocks: ${plural(blocks.length, "block")}` }), highlight: blocks };
    }
    const ids = keepExistingIds(result.issues, prev.ids);
    const view = ids.length > 0 ? selectionView(result.issues, ids) : null;
    if (!view) return null;
    // Same issues as before: keep the wording ("Overhangs too long: 3 places").
    const label = ids.length === prev.ids.length ? prev.label : view.label;
    return { selection: stable({ ids, check: prev.check, label }), highlight: view.highlight };
}

/** Does any of this report text name a direction as +X, -Y, ...? Then the report says which way those point. */
export const mentionsAxes = (texts: readonly string[]): boolean => texts.some((text) => /(?:^|[\s(])[+\-−][XY]\b/.test(text));

// ---------- colour and preview ----------

/** A result with blocks a stabilizer step added (a stabilized model), so colouring by role says something (one copy: the stage's menu uses it too). */
export { hasAddedBlocks } from "@/assignment/viewer/stageControls";

/**
 * The colour mode the stage actually uses. The user's choice stands unless it cannot be drawn: stress needs the
 * estimate, role needs added blocks. The live preview of a stabilizer run always paints by role.
 */
export function resolveColorBy(
    choice: AnalysisColorBy,
    ctx: { stress: boolean; roles: boolean; forceRole: boolean },
): AnalysisColorBy {
    if (ctx.forceRole) return "role";
    if (choice === "stress" && !ctx.stress) return "status";
    if (choice === "role" && !ctx.roles) return "status";
    return choice;
}

const cellIndexCache = new WeakMap<object, Map<number, number>>();

/** grid cell -> block index of a result (cached per result). */
function cellIndex(result: Pick<AnalysisResult, "blocks" | "gridSize">): Map<number, number> {
    let map = cellIndexCache.get(result);
    if (!map) {
        const [gx, gy] = result.gridSize;
        map = new Map();
        for (const b of result.blocks) map.set((b.cell[2] * gy + b.cell[1]) * gx + b.cell[0], b.index);
        cellIndexCache.set(result, map);
    }
    return map;
}

/**
 * Block indices of `from` as indices of `to`, matched by grid cell; blocks `to` does not have are dropped. The stage may
 * show another result than the report (the live preview of a run), whose block numbers differ, while the cells stay where
 * they are.
 */
export function mapBlockIndices(
    from: Pick<AnalysisResult, "blocks">,
    to: Pick<AnalysisResult, "blocks" | "gridSize">,
    indices: readonly number[],
): number[] {
    const at = cellIndex(to);
    const [gx, gy] = to.gridSize;
    const out: number[] = [];
    for (const index of indices) {
        const b = from.blocks[index];
        if (!b) continue;
        const found = at.get((b.cell[2] * gy + b.cell[1]) * gx + b.cell[0]);
        if (found !== undefined) out.push(found);
    }
    return out.sort((a, b) => a - b);
}

/** The blocks a stabilizer step added, as block indices of `result` (ascending). */
export function stepBlocks(result: Pick<AnalysisResult, "blocks">, step: number): number[] {
    const out: number[] = [];
    for (const b of result.blocks) if (b.step === step) out.push(b.index);
    return out;
}

/** Who put a preview on the stage: only that store takes it off again (store/workGuard.ts lets one of them work at a time). */
export type PreviewOwner = "stabilize" | "blocks" | "optimize";

/** The unsaved result the stage shows while a stabilizer run, a block edit or an optimizer run is under way (or waiting to be saved). */
export interface PreviewState {
    /** The model the work started from: the preview is drawn only while that model is the one on screen. */
    modelId: string;
    result: AnalysisResult;
    owner: PreviewOwner;
}

/** What the stage draws: the preview of a run while it is for the model on screen, else the model's own result. */
export function stageResultOf(s: {
    result: AnalysisResult | null;
    resultModelId: string | null;
    preview: PreviewState | null;
}): AnalysisResult | null {
    if (s.preview && s.preview.modelId === s.resultModelId) return s.preview.result;
    return s.result;
}

// ---------- layers ----------

/**
 * The layer cut after a new result. A new model shows everything; a re-run of the same model keeps the cut,
 * unless it showed everything before, in which case it still does.
 */
export function nextLayerMax(prev: { layerMax: number; layers: number } | null, layers: number): number {
    const top = Math.max(0, layers - 1);
    if (!prev) return top;
    if (prev.layerMax >= prev.layers - 1) return top;
    return Math.min(prev.layerMax, top);
}

/**
 * The layer cut a selection needs. The cut stays where the user put it unless it would hide part of what was
 * picked (the blocks, or the point the camera flies to); then it rises to that layer. It never goes down: the
 * user may have cut for a reason, and a cut that hides a violation is the worse of the two.
 */
export function layerMaxForSelection(
    result: Pick<AnalysisResult, "blocks" | "stats" | "settings">,
    blocks: readonly number[],
    focusMm: Vec3 | null,
    current: number,
): number {
    const top = Math.max(0, result.stats.layers - 1);
    let need = 0;
    for (const index of blocks) need = Math.max(need, result.blocks[index]?.cell[2] ?? 0);
    if (focusMm) need = Math.max(need, Math.floor(focusMm[2] / result.settings.blockSizeMm));
    return Math.max(current, Math.min(need, top));
}

// ---------- room for the report panel ----------

/** The least width the model is framed in beside the open report panel before the panel overlaps it instead. */
export const MIN_STAGE_PX = 360;

/** Is there room for the panel (`dockPx` wide with its margins) beside a model at least MIN_STAGE_PX wide? */
export const dockFits = (freeWidth: number, dockPx: number): boolean => freeWidth - dockPx >= MIN_STAGE_PX;

/**
 * How much of the viewer's left the open panel takes. All of it when it fits; in a narrow window only what keeps
 * the model MIN_STAGE_PX wide, so the panel overlaps the stage instead of squeezing the model to a sliver.
 */
export const dockInset = (freeWidth: number, dockPx: number): number =>
    Math.max(0, Math.min(dockPx, freeWidth - MIN_STAGE_PX));

// ---------- run phase ----------

/**
 * What the first-run panel says at each stage of the engine ("Checking the model…", then this). The engine labels its stages for its
 * own progress callback ("Voxelising the model"); the panel is written for a student (vocabulary.ts keeps "voxel" out of it), so it
 * speaks from the machine-readable step, not the label.
 */
export const STAGE_WORDS: Readonly<Record<string, string>> = {
    voxelize: "Building the blocks",
    flood: "Filling the inside",
    analyze: "Checking the structure",
    stress: "Estimating stress",
};

/** The panel's words for a stage: by its step; a stage this does not know keeps the engine's label unless that is technical. */
export function stageWords(step: string | undefined, label: string): string {
    const known = step === undefined ? undefined : STAGE_WORDS[step];
    if (known !== undefined) return known;
    return technicalWordsIn(label).length > 0 ? "Checking the model" : label;
}

export type AnalysisPhase = "no-model" | "unavailable" | "loading" | "running" | "error" | "done";

export interface RunState {
    modelId: string | null;
    status: "idle" | "running" | "error";
    error: string | null;
    stage: string;
    /** 0-1 */
    progress: number;
}

export const IDLE_RUN: RunState = { modelId: null, status: "idle", error: null, stage: "", progress: 0 };

/**
 * What the report shows for the model in the viewer. "loading" = the model is not in the viewer yet (or the
 * run is about to start); "unavailable" = the viewer cannot show the model (the triangles are read from its
 * scene, so there is nothing to analyse); a run for another model, or one that was aborted, never counts.
 */
export function derivePhase(input: {
    modelId: string | null;
    ready: boolean;
    run: RunState;
    resultModelId: string | null;
    /** The viewer reported that it cannot show this model. */
    unavailable?: boolean;
}): AnalysisPhase {
    const { modelId, ready, run, resultModelId } = input;
    if (!modelId) return "no-model";
    if (!ready) return input.unavailable ? "unavailable" : "loading";
    if (run.modelId === modelId && run.status === "running") return "running";
    if (run.modelId === modelId && run.status === "error") return "error";
    if (resultModelId === modelId) return "done";
    return "loading";
}

// ---------- formatting ----------

const nf = new Intl.NumberFormat("en-US");

/** 1234.4 -> "1,234". */
export const fmtMm = (n: number): string => nf.format(Math.round(n));

/** 0.734 -> "73%". */
export const fmtPct = (u: number): string => `${Math.round(u * 100)}%`;

/** +120 / −45, with a real minus sign. */
export const fmtSignedMm = (n: number): string => `${n < 0 ? "−" : "+"}${nf.format(Math.abs(Math.round(n)))}`;

/**
 * "Scaled to 1000 × 640 × 820 mm · 237 blocks of 100 mm". A block assembly (a stabilized model) was never scaled: it
 * is made of the blocks themselves.
 */
export function scaleLine(result: Pick<AnalysisResult, "sizeMm" | "settings" | "stats"> & { assembly?: AnalysisResult["assembly"] }): string {
    const n = result.stats.blockCount;
    const blocks = `${n} ${n === 1 ? "block" : "blocks"} of ${result.settings.blockSizeMm} mm`;
    if (result.assembly) return `${result.assembly.steps > 0 ? "Block assembly built by the stabilizer" : "Block assembly"} · ${blocks}`;
    const [x, y, z] = result.sizeMm.map((v) => Math.round(v));
    return `Scaled to ${x} × ${y} × ${z} mm · ${blocks}`;
}

/** `a-wooden-chair-meshy-analysis` from the model's file name: the report files share its stem. */
export function reportStem(modelFileName: string): string {
    return `${modelFileName.replace(/\.glb$/i, "")}-analysis`;
}
