// What the "How this version was made" section shows and says, and whether there is one for the model on screen: the stabilizer's steps for a
// stabilized version (or a run that is not saved yet), the requests and what they changed for a version edited by words, the goal and the
// before and after figures for an optimized version.

import { useMemo } from "react";

import { addedSoFar } from "@/assignment/components/analysis/panelLogic";
import type { DerivedMeta, EditMeta, ModelAsset, OptimizeSummary, StabilizeStepLog } from "@/assignment/shared/contract";
import { plural } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";

/** What the section shows and says: where the log comes from, its title, and the data of that kind. */
export interface StabilizerLogData {
    /** Whose log it is: the stabilizer's, a change by words, or the optimizer's. */
    kind: "stabilizer" | "edit" | "optimizer";
    /** "saved": the log of the version on screen (it is stored with it); "run": a run that is not saved yet. */
    source: "saved" | "run";
    /** The section's heading. */
    title: string;
    /** The stabilizer's steps (empty for the other two kinds). */
    steps: readonly StabilizeStepLog[];
    /** The blocks the stabilizer added (0 for the other two kinds). */
    added: number;
    /** The figures before and after, and the blocks added by role; null for a stopped run that was not written yet, and for the other two kinds. */
    meta: Pick<DerivedMeta, "before" | "after" | "added_by_role" | "added_blocks"> | null;
    /** A version edited by words: its requests and what they did. */
    edit: EditMeta | null;
    /** An optimized version: its goal and figures. */
    optimization: OptimizeSummary | null;
}

export const STABILIZER_LOG_TITLE = "What the stabilizer did";
export const EDIT_LOG_TITLE = "What was changed";
export const OPTIMIZER_LOG_TITLE = "What the optimizer did";

/** Why the optimizer stopped, in plain words. */
export const OPTIMIZE_STOP_WORDS: Record<OptimizeSummary["stop"], string> = {
    converged: "No single block can change without breaking a limit or the goal.",
    "target-reached": "It reached the target you set.",
    "budget-used": "It used up the blocks it was allowed to add.",
    "max-iterations": "It stopped after the most rounds it tries.",
    "max-solves": "It stopped after the most checks it makes.",
    "time-budget": "It stopped when its time ran out. This is the best valid state it found.",
    canceled: "Stopped by you. This is the best valid state it had reached.",
    infeasible: "It could not meet the limits, so nothing was changed.",
};

/**
 * The log the section shows for the model on screen, else null (then the section is not there). A stabilized version has its own, stored with
 * it; so has a version edited by words and an optimized one. A stabilizer run that is not saved yet and is about this model (it was
 * stopped, it waits for a decision, it is uploading) has the log of the run, which is what the Save button is about.
 */
export function useStabilizerLog(model: ModelAsset | null): StabilizerLogData | null {
    const status = useStabilizeStore((s) => s.status);
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const steps = useStabilizeStore((s) => s.steps);
    const moves = useStabilizeStore((s) => s.moves);
    const run = useStabilizeStore((s) => s.result);
    return useMemo(() => {
        if (!model) return null;
        const pending = status !== "idle" && status !== "running" && status !== "saved" && sourceModelId === model.id && steps.length > 0;
        if (pending) {
            return {
                kind: "stabilizer",
                source: "run",
                title: STABILIZER_LOG_TITLE,
                steps,
                added: run ? run.meta.added_blocks : addedSoFar(moves),
                meta: run ? run.meta : null,
                edit: null,
                optimization: null,
            };
        }
        // A stabilized version that added nothing (a model that needed no change) has no log: four equal rows and no steps say nothing.
        if (model.kind === "stabilized" && model.derived && (model.derived.added_blocks > 0 || model.derived.steps.length > 0)) {
            return { kind: "stabilizer", source: "saved", title: STABILIZER_LOG_TITLE, steps: model.derived.steps, added: model.derived.added_blocks, meta: model.derived, edit: null, optimization: null };
        }
        if (model.kind === "edited" && model.edit) {
            return { kind: "edit", source: "saved", title: EDIT_LOG_TITLE, steps: [], added: 0, meta: null, edit: model.edit, optimization: null };
        }
        if (model.kind === "optimized" && model.optimization) {
            return { kind: "optimizer", source: "saved", title: OPTIMIZER_LOG_TITLE, steps: [], added: 0, meta: null, edit: null, optimization: model.optimization };
        }
        return null;
    }, [model, status, sourceModelId, steps, moves, run]);
}

/** The closed section's summary: "7 steps" for the stabilizer, "2 requests" for a change by words, the goal's title for the optimizer. */
export function logSummary(log: StabilizerLogData): string {
    if (log.kind === "edit" && log.edit) return plural(log.edit.entries.length, "request");
    if (log.kind === "optimizer" && log.optimization) return log.optimization.title;
    return plural(log.steps.length, "step");
}
