import { RunStrip } from "@/assignment/components/analysis/RunStrip";
import { StabilizeAction } from "@/assignment/components/analysis/StabilizeAction";
import type { AnalysisResult } from "@/assignment/analysis/types";
import type { ModelAsset } from "@/assignment/shared/contract";
import type { Verdict } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";

/**
 * Under the answer: the one action. While a run has something to say (it goes, it waits for a decision, it failed) that is the
 * run strip; otherwise the action itself (Stabilize, the stabilized version's row, or nothing). A run that was saved is its version,
 * which the action shows. The outcome of a run stays until it is dismissed, whichever model is on screen by then.
 */
export function StabilizeCard({
    model,
    result,
    verdict,
    analysing,
    compact = false,
}: {
    model: ModelAsset;
    result: AnalysisResult;
    verdict: Verdict;
    analysing: boolean;
    /** The phone's peek card: the action without its secondary controls. */
    compact?: boolean;
}) {
    const status = useStabilizeStore((s) => s.status);
    if (status !== "idle" && status !== "saved") return <RunStrip model={model} compact={compact} />;
    return <StabilizeAction model={model} result={result} verdict={verdict} analysing={analysing} compact={compact} />;
}
