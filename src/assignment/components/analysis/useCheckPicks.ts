// Picking a check or a figure of the panel: show its issues (or blocks) on the stage, or let go when it is the one on show.
// The chips of the answer and the rows of "All checks and numbers" are the same picks, so they share this.

import { useCallback } from "react";

import type { AnalysisResult, CheckKey } from "@/assignment/analysis/types";
import { checkTarget, type CheckTarget } from "@/assignment/components/analysis/panelLogic";
import { useAnalysisStore } from "@/assignment/store/analysis";

export interface CheckPicks {
    /** The check whose blocks are on the stage, if any. */
    shownCheck: CheckKey | null;
    /** Show the check `key` (named `label` when the pick has no single issue to be named after), or let go when it is on show. */
    toggle: (target: CheckTarget) => void;
    /** What `key` would show, for the callers that need to know whether it can show anything. */
    targetOf: (key: CheckKey, label: string) => CheckTarget;
}

export function useCheckPicks(result: AnalysisResult): CheckPicks {
    const shownCheck = useAnalysisStore((s) => s.selection?.check ?? null);
    const selectIssues = useAnalysisStore((s) => s.selectIssues);
    const selectBlocks = useAnalysisStore((s) => s.selectBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);

    const toggle = useCallback(
        (target: CheckTarget) => {
            if (shownCheck === target.key) {
                clearSelection();
                return;
            }
            // The overhanging-blocks row has no issue of its own: it shows the blocks themselves.
            if (target.ids.length === 0) {
                if (target.blocks.length > 0) selectBlocks(target.blocks, { check: target.key, label: target.label ?? "Overhanging blocks" });
                return;
            }
            selectIssues(target.ids, { check: target.key, label: target.label });
        },
        [shownCheck, clearSelection, selectBlocks, selectIssues],
    );
    const targetOf = useCallback((key: CheckKey, label: string) => checkTarget(result, key, label), [result]);
    return { shownCheck, toggle, targetOf };
}
