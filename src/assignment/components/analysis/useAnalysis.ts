// What the UI reads of the analysis: the phase and result for the model in the viewer, and the newest verdict
// of any model (live this visit, else the one the server saved).

import { useMemo } from "react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { WEBGL_MESSAGE, webglMissing } from "@/assignment/components/analysis/webgl";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { verdictSentence, type VerdictSentence } from "@/assignment/store/analysisBrief";
import {
    derivePhase,
    fixOfIssues,
    verdictOf,
    type AnalysisPhase,
    type RunState,
    type Verdict,
} from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { useVersionFamily } from "@/assignment/store/versions";

export interface AnalysisSnapshot {
    phase: AnalysisPhase;
    /** The result for the model in the viewer (kept while a re-run is in flight); null when there is none yet. */
    result: AnalysisResult | null;
    verdict: Verdict | null;
    /**
     * The answer in one sentence ("Will tip over and 2 arms are too long.") and its short pill form, from the result; null until
     * there is one. The panel's first line, the folded pill and the phone's peek read it (store/analysisBrief.ts).
     */
    sentence: VerdictSentence | null;
    run: RunState;
    /**
     * What the viewer should draw as `analysis`. The same as `result` now that the stage has no Original half (the top bar's
     * switch changes the model instead); kept so the shell's `analysis={snapshot.viewResult}` keeps working.
     */
    viewResult: AnalysisResult | null;
    /** The stabilizer's work in progress, when it is for this model: the viewer's `previewResult` (drawn instead of `viewResult`). */
    previewResult: AnalysisResult | null;
    /**
     * The mesh the model is analysed over is in the viewer, so the analysis can run. That is the model's own GLB, except
     * for a stabilized model shown on the mesh it was made from: there it is the source's.
     */
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
            material: result.settings.material,
            // The kinds of the issues say what the stabilizer can do; the counts alone cannot (store/analysisLogic.ts fixOfIssues).
            fix: fixOfIssues(result.issues),
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
    const preview = useAnalysisStore((s) => s.preview);

    const modelId = model?.id ?? null;
    // What the viewer draws for this model: a stabilized model is shown over the mesh it was made from (store/versions.ts),
    // so that mesh's url, not the model's own, says whether it has loaded or failed.
    const family = useVersionFamily();
    const shownUrl = model === null ? null : family && family.active.id === model.id ? family.display.glb_url : model.glb_url;
    const ready = loaded !== null && shownUrl !== null && loaded.url === shownUrl;
    // The viewer failed to load this model, or cannot draw at all: no triangles will ever arrive.
    const unavailable = ready || !model ? null : failure?.url === shownUrl ? failure.message : webglMissing() ? WEBGL_MESSAGE : null;
    const phase = derivePhase({ modelId, ready, run, resultModelId, unavailable: unavailable !== null });
    const current = modelId !== null && resultModelId === modelId ? result : null;
    const verdict = useMemo(() => verdictOfResult(current), [current]);
    const sentence = useMemo(() => (current ? verdictSentence(current) : null), [current]);
    const previewResult = preview && modelId !== null && preview.modelId === modelId ? preview.result : null;
    return { phase, result: current, verdict, sentence, run, viewResult: current, previewResult, ready, unavailable };
}

/**
 * The verdict of one model for a chat card or the Models list: this visit's analysis if there is one, else the
 * summary the server stored with the model.
 */
export function useModelVerdict(model: Pick<ModelAsset, "id" | "analysis"> | null): Verdict | null {
    const id = model?.id ?? null;
    const live = useAnalysisStore((s) => (id === null ? undefined : s.summaries[id]));
    const stored = useWorkspaceStore((s) => (id === null ? undefined : s.models.find((m) => m.id === id)?.analysis));
    const own = model?.analysis;
    return useMemo(() => verdictOf(live ?? stored ?? own), [live, stored, own]);
}

/** Is this model being analysed right now (the one in the viewer, with a run in flight)? */
export function useModelAnalysing(modelId: string): boolean {
    return useAnalysisStore((s) => s.run.modelId === modelId && s.run.status === "running");
}
