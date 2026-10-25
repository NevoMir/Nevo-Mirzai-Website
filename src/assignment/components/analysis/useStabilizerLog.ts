// What the "What the stabilizer did" section shows and says, and whether there is one for the model on screen.

import { useMemo } from "react";

import { addedSoFar } from "@/assignment/components/analysis/panelLogic";
import type { DerivedMeta, ModelAsset, StabilizeStepLog } from "@/assignment/shared/contract";
import { plural } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";

/** What the section shows and says: the steps, how many blocks they added, and the figures before and after when they are known. */
export interface StabilizerLogData {
    /** "saved": the log of the version on screen (it is stored with it); "run": a run that is not saved yet. */
    source: "saved" | "run";
    steps: readonly StabilizeStepLog[];
    added: number;
    /** The figures before and after, and the blocks added by role; null for a stopped run that was not written yet. */
    meta: Pick<DerivedMeta, "before" | "after" | "added_by_role" | "added_blocks"> | null;
}

/**
 * The log the section shows for the model on screen, else null (then the section is not there). A stabilized version has its own,
 * stored with it. A run that is not saved yet and is about this model (it was stopped, it waits for a decision, it is uploading)
 * has the log of the run, which is what the Save button is about.
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
            return { source: "run", steps, added: run ? run.meta.added_blocks : addedSoFar(moves), meta: run ? run.meta : null };
        }
        // A stabilized version that added nothing (a model that needed no change) has no log: four equal rows and no steps say nothing.
        if (model.kind === "stabilized" && model.derived && (model.derived.added_blocks > 0 || model.derived.steps.length > 0)) {
            return { source: "saved", steps: model.derived.steps, added: model.derived.added_blocks, meta: model.derived };
        }
        return null;
    }, [model, status, sourceModelId, steps, moves, run]);
}

/** "7 steps": the closed section's summary. The blocks it added are the tag of the row above ("+16 blocks"), said once. */
export const logSummary = (log: StabilizerLogData): string => plural(log.steps.length, "step");

