import { Info, Loader2 } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import { useAnalysisStore } from "@/assignment/store/analysis";

/**
 * Shown while the stage is on "Original": the report beside it is always about the stabilized model, so a line says so,
 * and while the original blocks are still being made it says that the stage has not changed yet. (If making them fails the
 * store goes back to the stabilized view and says so in a toast.)
 */
export function CompareNotice() {
    const original = useAnalysisStore((s) => s.view.compare === "original");
    const loading = useAnalysisStore((s) => s.originalState === "loading" || s.originalFor !== s.result);
    const setCompare = useAnalysisStore((s) => s.setCompare);
    if (!original) return null;
    const Icon = loading ? Loader2 : Info;
    return (
        <div className="px-4 pb-3" data-testid="compare-notice" data-loading={loading}>
            <div className="flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2 text-[11px] leading-snug text-muted-foreground" role="status" aria-busy={loading}>
                <Icon className={loading ? "mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" : "mt-0.5 h-3.5 w-3.5 shrink-0"} aria-hidden />
                <span className="min-w-0 flex-1">
                    {loading
                        ? "Preparing the original blocks. The stage still shows the stabilized model."
                        : "The stage shows the original blocks on their own. The report below is about the stabilized model."}
                </span>
                <Button type="button" size="sm" variant="ghost" className="-my-1 h-6 shrink-0 px-2 text-[11px]" onClick={() => setCompare("stabilized")}>
                    Show stabilized
                </Button>
            </div>
        </div>
    );
}
