// What the Optimization tab reads of the workspace: the version on screen, the Stability tab's verdict for it (the same snapshot), whether it can
// be the start of a run, and the unsaved block changes that would have to be saved first.

import { useMemo } from "react";

import { useAnalysisSnapshot, type AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import type { ModelAsset } from "@/assignment/shared/contract";
import { eligibilityOf, type Eligibility } from "@/assignment/store/optimizeLogic";
import { useVoxelEditStore } from "@/assignment/store/voxelEdit";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

export interface OptimizeView {
    model: ModelAsset | null;
    models: ModelAsset[];
    snapshot: AnalysisSnapshot;
    eligibility: Eligibility;
}

export function useOptimizeView(): OptimizeView {
    const models = useWorkspaceStore((s) => s.models);
    const activeModelId = useWorkspaceStore((s) => s.activeModelId);
    const model = useMemo(() => models.find((m) => m.id === activeModelId) ?? null, [models, activeModelId]);
    const snapshot = useAnalysisSnapshot(model);
    // Changes to the blocks of this version that are not saved: the tab asks for them to be saved first.
    const draft = useVoxelEditStore((s) => s.sourceModelId !== null && s.sourceModelId === activeModelId && (s.draft?.count ?? 0) > 0);
    const eligibility = useMemo(() => eligibilityOf({ model, models, snapshot, unsavedDraft: draft }), [model, models, snapshot, draft]);
    return { model, models, snapshot, eligibility };
}
