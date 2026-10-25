// What the Stability panel shows of the block editor for the model on screen: the draft's analysis (its headline replaces the model's own while
// the person has unsaved changes), and whether the editor has the floor (a proposal or a draft is there, so the Stabilize button waits).

import { useMemo } from "react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import type { ModelAsset } from "@/assignment/shared/contract";
import { verdictSentence, type VerdictSentence } from "@/assignment/store/analysisBrief";
import type { Verdict } from "@/assignment/store/analysisLogic";
import { useVoxelEditStore } from "@/assignment/store/voxelEdit";
import { verdictOfAnalysis } from "@/assignment/store/voxelEditLogic";

export interface BlockDraftView {
    /** Unsaved changes of this model are applied: the headline is theirs. */
    drafting: boolean;
    /** A proposal or a draft is there for this model: the editor has the floor. */
    editing: boolean;
    result: AnalysisResult | null;
    verdict: Verdict | null;
    sentence: VerdictSentence | null;
}

export function useBlockDraft(model: ModelAsset | null): BlockDraftView {
    const draftResult = useVoxelEditStore((s) => (model !== null && s.sourceModelId === model.id ? s.draftResult : null));
    const editing = useVoxelEditStore((s) => model !== null && s.sourceModelId === model.id && (s.proposal !== null || s.draft !== null));
    const verdict = useMemo(() => (draftResult ? verdictOfAnalysis(draftResult) : null), [draftResult]);
    const sentence = useMemo(() => (draftResult ? verdictSentence(draftResult) : null), [draftResult]);
    return { drafting: draftResult !== null, editing, result: draftResult, verdict, sentence };
}
