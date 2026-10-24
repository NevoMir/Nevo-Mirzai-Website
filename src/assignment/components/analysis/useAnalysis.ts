// What the UI reads of the analysis: the phase and result for the model in the viewer, and the newest verdict
// of any model (live this visit, else the one the server saved).

import { useMemo } from "react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { WEBGL_MESSAGE, webglMissing } from "@/assignment/components/analysis/webgl";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import {
    derivePhase,
    verdictOf,
    type AnalysisPhase,
    type RunState,
    type Verdict,
} from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

export interface AnalysisSnapshot {
    phase: AnalysisPhase;
    /** The result for the model in the viewer (kept while a re-run is in flight); null when there is none yet. */
    result: AnalysisResult | null;
    verdict: Verdict | null;
    run: RunState;
    /** The model's GLB is in the viewer, so the analysis can run. */
    ready: boolean;
    /** Why the viewer cannot show this model (so it cannot be analysed), else null. */
    unavailable: string | null;
}

/** The verdict a result states: counted from its issue list, so the pill always matches the Problems list. */
export function verdictOfResult(result: AnalysisResult | null): Verdict | null {
    if (!result) return null;
    let errors = 0;
    let warnings = 0;
    for (const issue of result.issues) {
        if (issue.severity === "error") errors++;
        else warnings++;
    }
    return verdictOf(
        {
            errors,
            warnings,
            blocks: result.stats.blockCount,
            cantilever_limit: result.settings.cantileverLimit,
            fill_threshold: result.settings.fillThreshold,
        },
        result.settings.maxBlocks,
    );
}

export function useAnalysisSnapshot(model: ModelAsset | null): AnalysisSnapshot {
    const loaded = useAnalysisStore((s) => s.loaded);
    const run = useAnalysisStore((s) => s.run);
    const result = useAnalysisStore((s) => s.result);
    const resultModelId = useAnalysisStore((s) => s.resultModelId);
    const failure = useAnalysisStore((s) => s.viewerFailure);

    const modelId = model?.id ?? null;
    const ready = loaded !== null && model !== null && loaded.url === model.glb_url;
    // The viewer failed to load this model, or cannot draw at all: no triangles will ever arrive.
    const unavailable = ready || !model ? null : failure?.url === model.glb_url ? failure.message : webglMissing() ? WEBGL_MESSAGE : null;
    const phase = derivePhase({ modelId, ready, run, resultModelId, unavailable: unavailable !== null });
    const current = modelId !== null && resultModelId === modelId ? result : null;
    const verdict = useMemo(() => verdictOfResult(current), [current]);
    return { phase, result: current, verdict, run, ready, unavailable };
}

/**
 * The verdict of one model for a chat card or the Models list: this visit's analysis if there is one, else the
 * summary the server stored with the model.
 */
export function useModelVerdict(model: Pick<ModelAsset, "id" | "analysis">): Verdict | null {
    const live = useAnalysisStore((s) => s.summaries[model.id]);
    const stored = useWorkspaceStore((s) => s.models.find((m) => m.id === model.id)?.analysis);
    return useMemo(() => verdictOf(live ?? stored ?? model.analysis), [live, stored, model.analysis]);
}

/** Is this model being analysed right now (the one in the viewer, with a run in flight)? */
export function useModelAnalysing(modelId: string): boolean {
    return useAnalysisStore((s) => s.run.modelId === modelId && s.run.status === "running");
}
