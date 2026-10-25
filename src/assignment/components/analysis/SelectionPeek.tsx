import { X } from "lucide-react";

import { useAnalysisStore } from "@/assignment/store/analysis";

/**
 * Phone: what is being shown on the model, as a small chip at the top of the stage; tap the x to let go. Nothing when nothing is
 * shown. (The summary and the actions are in the peek card at the bottom, AnalysisPeekCard.)
 */
export function SelectionPeek() {
    const selection = useAnalysisStore((s) => s.selection);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    if (!selection) return null;
    return (
        <div className="pointer-events-none flex items-center" data-testid="analysis-selection">
            <div className="pointer-events-auto flex h-8 min-w-0 items-center gap-1 rounded-2xl border border-primary/50 bg-sidebar/95 pl-2.5 pr-1 text-xs shadow-lg backdrop-blur">
                <span className="min-w-0 truncate text-foreground" title={selection.label}>
                    {selection.label}
                </span>
                <button
                    type="button"
                    onClick={clearSelection}
                    aria-label="Clear the highlight"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="h-3.5 w-3.5" aria-hidden />
                </button>
            </div>
        </div>
    );
}
