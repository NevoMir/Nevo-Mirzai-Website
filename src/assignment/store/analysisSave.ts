// Saving a model's analysis summary with the model (PUT /models/:id/analysis), once per model and settings.

import type { AnalysisSettings } from "@/assignment/analysis/types";
import { putModelAnalysis } from "@/assignment/lib/api";
import type { AnalysisSummary } from "@/assignment/shared/contract";
import { sameSummary, settingsKey } from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/** model id -> the settings key its summary was last saved with (this page visit). */
const savedWith = new Map<string, string>();

/**
 * Save the summary once per model and settings. Skipped when the server already has the same numbers (opening
 * an analysed project again must not rewrite it). A failure is ignored: the verdict still shows this visit,
 * and the next run tries again.
 */
export async function saveSummary(modelId: string, settings: AnalysisSettings, summary: AnalysisSummary): Promise<void> {
    const key = settingsKey(settings);
    if (savedWith.get(modelId) === key) return;
    const stored = useWorkspaceStore.getState().models.find((m) => m.id === modelId)?.analysis;
    savedWith.set(modelId, key);
    if (sameSummary(stored, summary)) return;
    try {
        const model = await putModelAnalysis(modelId, summary);
        // The Models list and the chat cards pick the stored summary up from the store. Only while the model's own
        // project is open: the save outlives a click on Home, and addModel would append a foreign model to the
        // project opened meanwhile (the server has the summary either way).
        if (model.project_id === useWorkspaceStore.getState().activeProjectId) useWorkspaceStore.getState().addModel(model);
    } catch {
        savedWith.delete(modelId);
    }
}

/** Forget what was saved (tests). */
export function forgetSavedSummaries(): void {
    savedWith.clear();
}
