// Pure logic behind the Stabilize card and its timeline: what the user may ask for, what the progress and the result
// say in words, and how a run that was stopped is turned into a model that can still be saved. No React and no store,
// so store/stabilize.ts, the components and scripts/assignment/test-store.mjs share one copy.

import type { AnalysisResult, AnalysisSettings } from "@/assignment/analysis/types";
import {
    DEFAULT_STABILIZE_OPTIONS,
    DEFAULT_TARGET_UTILISATION,
    MAX_TARGET_UTILISATION,
    STABILIZER_VERSION,
    type StabilizeOptions,
    type StabilizeResult,
} from "@/assignment/analysis/stabilize/types";
import { assemblyHash, descriptorFromBlocks, type AssemblyDescriptor } from "@/assignment/shared/assembly";
import {
    MAX_DERIVED_DEPTH,
    MAX_DERIVED_PER_PROJECT,
    MAX_DERIVED_PER_SOURCE,
    type AddedRole,
    type DerivedMeta,
    type ModelAsset,
    type StabilizationMetrics,
    type StabilizeStepLog,
    type StabilizeStop,
    type StepMetrics,
} from "@/assignment/shared/contract";
import { fmtPct, plural, type Verdict } from "@/assignment/store/analysisLogic";
import { STRESS_WARN_SHARE } from "@/assignment/viewer/analysisGeometry";

// ---------- what the user can choose ----------

/**
 * The Options popover: how far down the stress is pushed, and how many blocks may be used in all. The target stops at the
 * warning level (not from materials.ts: that pulls in the solver): a higher one would let a run end "complete" while the
 * report still warns about the joints it left.
 */
export const TARGET_RANGE = { min: 0.4, max: STRESS_WARN_SHARE, step: 0.05 } as const;

export interface StabilizeChoices {
    /** Share of the allowable stress the stabilizer aims under (0.4 up to the warning level, 0.75). */
    target: number;
    /** The most blocks the stabilized model may have; null: the analysis budget, else the 1000 cells of the grid. */
    maxBlocks: number | null;
}

export const DEFAULT_CHOICES: StabilizeChoices = { target: DEFAULT_TARGET_UTILISATION, maxBlocks: null };

/** Anything -> valid choices (a half-typed field, a stored value). */
export function sanitizeChoices(raw: unknown): StabilizeChoices {
    const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const t = typeof r.target === "number" && Number.isFinite(r.target) ? r.target : DEFAULT_CHOICES.target;
    const target = Math.round(Math.min(TARGET_RANGE.max, Math.max(TARGET_RANGE.min, t)) * 100) / 100;
    const maxBlocks =
        typeof r.maxBlocks === "number" && Number.isFinite(r.maxBlocks) && r.maxBlocks >= 1 ? Math.min(1000, Math.round(r.maxBlocks)) : null;
    return { target, maxBlocks };
}

/** What the stabilizer is given: the choices over the analysis settings in force. */
export function optionsFor(choices: StabilizeChoices, settings: Pick<AnalysisSettings, "maxBlocks">): StabilizeOptions {
    return {
        ...DEFAULT_STABILIZE_OPTIONS,
        targetUtilisation: choices.target,
        maxBlocks: Math.min(choices.maxBlocks ?? settings.maxBlocks ?? 1000, 1000),
    };
}

// ---------- may it be offered? ----------

export interface StabilizeOffer {
    /** The primary button: "Reduce stress" when nothing fails and only a stress warning is left. */
    label: "Stabilize" | "Reduce stress";
    /** The newest stabilized version of this model, when there is one: the card then offers to open it. */
    child: Pick<ModelAsset, "id"> | null;
    /** Why a new run cannot start (shown instead of the button), else null. */
    blocked: string | null;
}

/**
 * Whether the Stabilize card is shown for this model, and in what state. null: nothing to fix (the card stays away).
 * `analysing`: an analysis of this model is running, so its numbers are about to change.
 */
export function stabilizeOffer(input: {
    model: Pick<ModelAsset, "id" | "derived">;
    models: ReadonlyArray<Pick<ModelAsset, "id" | "kind" | "source_model_id" | "created_at">>;
    result: Pick<AnalysisResult, "stats" | "stress">;
    verdict: Pick<Verdict, "kind"> | null;
    analysing: boolean;
}): StabilizeOffer | null {
    const { model, models, result, verdict } = input;
    if (!verdict || result.stats.blockCount === 0) return null;
    // Stress above the warning level is a warning (so the verdict covers it); "pass" means there is nothing to fix.
    if (verdict.kind === "pass") return null;
    const children = models.filter((m) => m.kind === "stabilized" && m.source_model_id === model.id);
    const child = children.length > 0 ? children[children.length - 1] : null;
    let blocked: string | null = null;
    if (input.analysing) blocked = "Wait for the analysis to finish.";
    else if ((model.derived?.depth ?? 0) >= MAX_DERIVED_DEPTH) blocked = "This version has been stabilized the maximum number of times.";
    else if (children.length >= MAX_DERIVED_PER_SOURCE) {
        blocked = `This model has ${MAX_DERIVED_PER_SOURCE} stabilized versions already. Delete one in the Models tab to make another.`;
    } else if (models.filter((m) => m.kind === "stabilized").length >= MAX_DERIVED_PER_PROJECT) {
        blocked = `This project has ${MAX_DERIVED_PER_PROJECT} stabilized versions already. Delete some in the Models tab to make more.`;
    }
    return { label: verdict.kind === "warn" ? "Reduce stress" : "Stabilize", child, blocked };
}

// ---------- while it runs ----------

/** Where a run is (store/stabilize.ts has the transitions). */
export type RunStatus = "idle" | "running" | "finished" | "saving" | "saved" | "error" | "canceled";

export interface StabilizeProgress {
    candidatesDone: number;
    candidatesTotal: number;
    steps: number;
    blocks: number;
    elapsedMs: number;
}

/** "Step 3 · evaluating 24 moves…" */
export function progressLine(progress: Pick<StabilizeProgress, "candidatesTotal"> | null, steps: number): string {
    const n = progress?.candidatesTotal ?? 0;
    const head = `Step ${steps + 1}`;
    return n > 0 ? `${head} · evaluating ${plural(n, "move")}…` : `${head} · looking for the next move…`;
}

export interface RunChips {
    /** Blocks added so far. */
    added: number;
    /** Problems (errors) at the start and now. */
    problems: [number, number];
    /** Peak stress as a share of the allowable at the start and now; null: no block stands on the ground. */
    stress: [number | null, number | null];
}

/** The numbers under the progress line: from the metrics the run started with, and the log so far. */
export function runChips(start: Pick<StepMetrics, "errors" | "max_utilisation">, steps: readonly StabilizeStepLog[]): RunChips {
    const last = steps[steps.length - 1];
    return {
        added: steps.reduce((sum, s) => sum + s.added, 0),
        problems: [start.errors, last ? last.after.errors : start.errors],
        stress: [start.max_utilisation, last ? last.after.max_utilisation : start.max_utilisation],
    };
}

/**
 * The chips under a step of the timeline: each figure the move changed, then how many blocks it added.
 * `errors 3 → 2`, `peak 198% → 72%`, `+5`.
 */
export function stepChips(step: StabilizeStepLog): string[] {
    const { before: b, after: a } = step;
    const chips: string[] = [];
    if (b.errors !== a.errors) chips.push(`errors ${b.errors} → ${a.errors}`);
    if (b.floating_blocks !== a.floating_blocks) chips.push(`floating ${b.floating_blocks} → ${a.floating_blocks}`);
    if (b.longest_cantilever !== a.longest_cantilever) chips.push(`reach ${b.longest_cantilever} → ${a.longest_cantilever}`);
    if (b.cog_margin_mm !== null && a.cog_margin_mm !== null && Math.round(b.cog_margin_mm) !== Math.round(a.cog_margin_mm)) {
        chips.push(`margin ${Math.round(b.cog_margin_mm)} → ${Math.round(a.cog_margin_mm)} mm`);
    }
    if (b.max_utilisation !== null && a.max_utilisation !== null && Math.round(b.max_utilisation * 100) !== Math.round(a.max_utilisation * 100)) {
        chips.push(`peak ${stressArrow(b.max_utilisation, a.max_utilisation)}`);
    }
    chips.push(`+${step.added}`);
    return chips;
}

/** "198% → 21%" (or "n/a" where there is no stress). */
export function stressArrow(a: number | null, b: number | null): string {
    return `${a === null ? "n/a" : fmtPct(a)} → ${b === null ? "n/a" : fmtPct(b)}`;
}

/**
 * The metrics of a result, rounded like the stabilizer logs them (analysis/stabilize/measure.ts), so the card and the log agree.
 * `target` is the stress level the run aims for: while blocks float, only the grounded part is solved, so a peak below the
 * warning level (or the target, if lower) is not a real figure and is left out (null), as the stabilizer does.
 */
export function metricsOf(result: AnalysisResult, target: number = MAX_TARGET_UTILISATION): StabilizationMetrics {
    const s = result.summary;
    const peak = result.stress ? result.stress.maxUtilisation : null;
    const unknown = peak !== null && s.floating_blocks > 0 && peak < Math.min(target, MAX_TARGET_UTILISATION);
    return {
        blocks: s.blocks,
        errors: s.errors,
        warnings: s.warnings,
        floating_blocks: s.floating_blocks,
        over_limit: s.over_limit,
        longest_cantilever: s.longest_cantilever,
        cog_margin_mm: result.stability ? s.cog_margin_mm : null,
        max_utilisation: peak === null || unknown ? null : Math.min(50, Math.round(peak * 1000) / 1000),
        overstressed_blocks: result.stress ? result.stress.overstressedBlocks : 0,
    };
}

// ---------- when it is over ----------

export type Outcome = "complete" | "partial" | "nothing";

/** complete: no errors and the stress is under the target (saved at once). partial: better, not done. nothing: no block was added. */
export function outcomeOf(result: Pick<StabilizeResult, "complete"> & { meta: Pick<DerivedMeta, "added_blocks"> }): Outcome {
    if (result.meta.added_blocks === 0) return "nothing";
    return result.complete ? "complete" : "partial";
}

/** What is left to fix after a run, in words ("2 floating blocks", "peak stress 130%"); empty when nothing is. */
export function remainingProblems(after: StabilizationMetrics, target: number, limit: number): string[] {
    const out: string[] = [];
    if (after.floating_blocks > 0) out.push(plural(after.floating_blocks, "floating block"));
    if (after.over_limit > 0) out.push(`a cantilever of ${after.longest_cantilever} blocks (limit ${limit})`);
    if (after.cog_margin_mm !== null && after.cog_margin_mm < 0) out.push("the centre of gravity is outside the base");
    if (after.max_utilisation !== null && after.max_utilisation > target) {
        out.push(`peak stress ${fmtPct(after.max_utilisation)} against the ${fmtPct(target)} target`);
    }
    return out;
}

/** "Improved, not fully stable: 1 problem remains (a cantilever of 5 blocks (limit 4))". */
export function partialHeadline(after: StabilizationMetrics, target: number, limit: number): string {
    const left = remainingProblems(after, target, limit);
    // Errors are the problems; with none, whatever is still short of the target counts.
    const count = after.errors > 0 ? after.errors : left.length;
    const what = count > 0 ? `${plural(count, "problem")} ${count === 1 ? "remains" : "remain"}` : "some problems remain";
    return `Improved, not fully stable: ${what}${left.length > 0 ? ` (${left.join("; ")})` : ""}`;
}

/** Why the search ended, for a run that did not reach its goal. */
export function stopReason(stop: StabilizeStop): string {
    switch (stop) {
        case "stable":
            return "It reached its goal.";
        case "no-improving-move":
            return "No further move improves it.";
        case "max-steps":
            return "It reached the limit of steps.";
        case "max-blocks":
            return "It reached the block budget.";
        case "time-budget":
            return "It ran out of time.";
        case "canceled":
            return "It was stopped.";
    }
}

/** Why a run that added no block added none, in words the Options can change (or not). */
export function nothingLine(
    result: Pick<StabilizeResult, "stop" | "before">,
    options: Pick<StabilizeOptions, "targetUtilisation" | "maxBlocks"> | null,
): string {
    const target = fmtPct(options?.targetUtilisation ?? DEFAULT_TARGET_UTILISATION);
    const budget = options ? plural(options.maxBlocks, "block") : "the block budget";
    switch (result.stop) {
        case "stable": {
            const peak = result.before.max_utilisation;
            return `This model already meets the target${peak !== null ? ` (peak stress ${fmtPct(peak)} against ${target})` : ""}. There is no problem left that the stabilizer can fix.`;
        }
        case "max-blocks":
            return `The block budget (${budget}) leaves no room: the model has ${plural(result.before.blocks, "block")} already. Raise the budget in Options.`;
        case "no-improving-move":
            return `The stabilizer found no move that improves this model within the options (target stress ${target}, up to ${budget}).`;
        default:
            return `The stabilizer stopped before it added anything. ${stopReason(result.stop)}`;
    }
}

/** "+14 blocks · all checks pass · peak stress 180% → 54%". */
export function stabilizedLine(meta: Pick<DerivedMeta, "added_blocks" | "before" | "after">): string {
    const parts = [`+${plural(meta.added_blocks, "block")}`];
    const { after, before } = meta;
    const left = after.errors > 0 ? `${plural(after.errors, "problem")} ${after.errors === 1 ? "remains" : "remain"}` : plural(after.warnings, "warning");
    parts.push(after.errors === 0 && after.warnings === 0 ? "all checks pass" : left);
    if (before.max_utilisation !== null && after.max_utilisation !== null) parts.push(`peak stress ${stressArrow(before.max_utilisation, after.max_utilisation)}`);
    return parts.join(" · ");
}

/** The chat line that presents a saved version. `prompt` is the model's prompt. */
export function savedMessage(prompt: string, meta: Pick<DerivedMeta, "added_blocks" | "after" | "complete">): string {
    const added = plural(meta.added_blocks, "block");
    if (meta.complete) {
        // "Complete" is the stabilizer's goal (no errors, stress under the target); a warning of the report can outlast it.
        const { warnings } = meta.after;
        if (warnings === 0) return `Stabilized version of **${prompt}**: +${added}, passes all checks.`;
        return `Stabilized version of **${prompt}**: +${added}, no problems left, ${plural(warnings, "warning")} to look at.`;
    }
    const left = Math.max(meta.after.errors, meta.after.warnings);
    return `Improved version of **${prompt}**: +${added}, ${left > 0 ? `${plural(left, "problem")} left` : "close to the target"}.`;
}

/** A prompt shortened to `max` characters for a line that names the model a banner is about. */
export function clipText(text: string, max = 40): string {
    const one = text.replace(/\s+/g, " ").trim();
    return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A run that has ended and waits for the user: Save or Discard, Retry, or dismissing what went wrong. */
export function needsDecision(status: RunStatus, outcome: Outcome | null): boolean {
    if (status === "canceled" || status === "error") return true;
    // A run that reached its goal is saved at once: only a partial result (or none to speak of) waits.
    return status === "finished" && outcome !== "complete";
}

export interface RunBadge {
    kind: "running" | "saving" | "review" | "stopped" | "nothing" | "failed";
    /** The one-line state of the run, for the summary pill that stays on screen when the report is folded away. */
    text: string;
}

/**
 * What the summary pill says while a run is going or waiting for a decision, else null (then it says the verdict). The
 * report is a sheet on a phone and can be folded into the pill on the desktop, and the run must not be invisible there.
 */
export function runBadge(run: { status: RunStatus; steps: number; outcome: Outcome | null; errorKind: "run" | "save" | null }): RunBadge | null {
    switch (run.status) {
        case "running":
            return { kind: "running", text: run.steps > 0 ? `Stabilizing… ${plural(run.steps, "step")}` : "Stabilizing…" };
        case "saving":
            return { kind: "saving", text: "Saving the stabilized version…" };
        case "canceled":
            return { kind: "stopped", text: "Stopped: save or discard" };
        case "error":
            return { kind: "failed", text: run.errorKind === "save" ? "Could not save" : "Stabilizing failed" };
        case "finished":
            if (run.outcome === "complete") return { kind: "saving", text: "Saving the stabilized version…" };
            return run.outcome === "nothing" ? { kind: "nothing", text: "Nothing to add" } : { kind: "review", text: "Review stabilized version" };
        default:
            return null;
    }
}

/** `a-lamp-meshy-stabilized.glb` from the source model's file name. */
export function stabilizedFileName(sourceFileName: string): string {
    return `${sourceFileName.replace(/\.glb$/i, "")}-stabilized.glb`;
}

/** The Worker refuses a file its writer would not have produced, which is what a page from before a deploy sends. */
export function uploadErrorMessage(error: unknown): string {
    const message = error instanceof Error && error.message ? error.message : "The version could not be saved.";
    return /unexpected content/i.test(message) ? "Reload the page and stabilize again: this page is older than the server." : message;
}

// ---------- the assembly of a run ----------

/** The moves of a run, as the stabilizer reports them (a `step` event): the log entry, the cells it added and each one's role. */
export interface RunMove {
    step: StabilizeStepLog;
    cells: Array<[number, number, number]>;
    roles: AddedRole[];
}

/**
 * The stabilizer numbers the steps of a run from 1 in its log, and the blocks they add after the highest step the analysed
 * model already has (a stabilized model that is stabilized again). `offset` is that number.
 */
export const stepOffsetOf = (source: Pick<AnalysisResult, "assembly"> | null | undefined): number => source?.assembly?.steps ?? 0;

/**
 * The offset of a saved stabilized model: its highest step minus the steps its own log has. Needs the log to have one step
 * per number, which the stabilizer's output has.
 */
export const savedStepOffset = (result: Pick<AnalysisResult, "assembly"> | null | undefined, logged: number): number =>
    Math.max(0, (result?.assembly?.steps ?? 0) - logged);

/**
 * The assembly of a run so far: the analysed model's blocks as they are (a stabilized model keeps the roles and steps it
 * has) and, for every move, the cells it added in their role and step. The same blocks the stabilizer's descriptor has.
 */
export function previewDescriptor(source: Pick<AnalysisResult, "blocks" | "assembly">, moves: readonly RunMove[], inset?: number): AssemblyDescriptor {
    const offset = stepOffsetOf(source);
    return descriptorFromBlocks(
        [
            ...source.blocks.map((b) => ({ cell: b.cell, role: b.role, step: b.step })),
            ...moves.flatMap((m) => m.cells.map((cell, q) => ({ cell, role: m.roles[q] ?? m.step.move, step: offset + m.step.n }))),
        ],
        inset ?? source.assembly?.descriptor.inset,
    );
}

// ---------- a run that was stopped ----------

export interface StoppedRun {
    source: AnalysisResult;
    moves: readonly RunMove[];
    sourceDepth: number;
    options: StabilizeOptions;
    elapsedMs: number;
    now?: Date;
}

/**
 * A stopped run as a result that can be saved. The worker was terminated, so only the moves it reported survive: they are
 * made into the assembly, the engine measures it (the same analysis and stress estimate the Analysis tab runs), and it is
 * written as the same assembly GLB, with `stop: "canceled"`. The stabilizer's own figures are not available, so the log keeps
 * the numbers the moves were reported with and the start and end are measured here (the TypeScript solver, one small model).
 */
export async function buildStoppedResult(run: StoppedRun): Promise<StabilizeResult> {
    const { source, moves, options } = run;
    const [{ analyzeAssembly }, { applyStress, computeStress }, { solveFrameTs }, { writeAssemblyGlb }] = await Promise.all([
        import("@/assignment/analysis/assembly"),
        import("@/assignment/analysis/stress"),
        import("@/assignment/analysis/fem/index"),
        import("@/assignment/shared/assemblyGlb"),
    ]);
    const descriptor = previewDescriptor(source, moves);
    const base = analyzeAssembly(descriptor, null, source.settings);
    const analysed = applyStress(base, computeStress(base, { solve: solveFrameTs, backend: "ts" }));
    // The engine never aims above the warning level (analysis/stabilize/types.ts), whatever the options say.
    const target = Math.min(options.targetUtilisation, MAX_TARGET_UTILISATION);
    const before = metricsOf(source, target);
    const after = metricsOf(analysed, target);
    const byRole: Partial<Record<AddedRole, number>> = {};
    let added = 0;
    for (const m of moves) {
        m.cells.forEach((_, q) => {
            const role = m.roles[q] ?? m.step.move;
            byRole[role] = (byRole[role] ?? 0) + 1;
            added += 1;
        });
    }
    const complete = after.errors === 0 && (after.max_utilisation === null || after.max_utilisation <= target + 1e-9);
    const meta: DerivedMeta = {
        version: 1,
        depth: run.sourceDepth + 1,
        stabilizer: STABILIZER_VERSION,
        solver: "awatif-ts",
        material: source.settings.material,
        target_utilisation: target,
        cantilever_limit: source.settings.cantileverLimit,
        fill_threshold: source.settings.fillThreshold,
        complete,
        stop: "canceled",
        added_blocks: added,
        added_by_role: byRole,
        before,
        after,
        steps: moves.map((m) => m.step),
        duration_ms: Math.max(0, Math.min(3_600_000, Math.round(run.elapsedMs))),
        assembly_hash: await assemblyHash(descriptor),
        after_summary: analysed.summary,
        created_at: (run.now ?? new Date()).toISOString(),
    };
    const glb = writeAssemblyGlb(descriptor, meta);
    return { descriptor, meta, glb, before, after, stop: "canceled", complete, addedByRole: byRole };
}
