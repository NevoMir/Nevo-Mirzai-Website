import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";

import { TONE } from "@/assignment/components/analysis/style";
import { useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { openVersion } from "@/assignment/components/workspace/versionActions";
import { statusMark, type StatusMark } from "@/assignment/components/workspace/versionLogic";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { versionName } from "@/assignment/shared/versionTree";
import { useVersionFamily } from "@/assignment/store/versions";

const MARK_ICON = { pass: CircleCheck, warn: TriangleAlert, fail: CircleX } as const;

function Half({ label, model, mark, pressed, testId }: { label: string; model: ModelAsset; mark: StatusMark; pressed: boolean; testId: string }) {
    const tone = mark.tone === "none" ? null : mark.tone;
    const Icon = tone ? MARK_ICON[tone] : null;
    return (
        <button
            type="button"
            aria-pressed={pressed}
            title={`${label} · ${mark.text}`}
            onClick={() => !pressed && openVersion(model)}
            data-testid={testId}
            className={cn(
                "flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring md:min-h-7",
                pressed ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
        >
            <span className="truncate">{label}</span>
            {Icon && tone && <Icon className={cn("h-3.5 w-3.5 shrink-0", TONE[tone].icon)} aria-label={mark.text} />}
        </button>
    );
}

/**
 * The Stability tab's own way back: "Original | Stabilized" under the header, so after Stabilize the unstable model is one click away
 * (the bar's version control does the same; this one sits where the person is looking). Nothing when the model has no version yet.
 */
export function StabilityVersionToggle() {
    const family = useVersionFamily();
    const root = family?.root ?? null;
    const head = family?.head ?? null;
    const rootVerdict = useModelVerdict(root);
    const headVerdict = useModelVerdict(head);
    if (!family || !root || !head || head.id === root.id) return null;
    // The right half is the head: the version on screen, or (from the original) the one the person was last working on.
    const onOriginal = family.active.id === root.id;
    return (
        <div className="shrink-0 border-b border-border/60 px-3 py-2" data-testid="analysis-version-toggle">
            <div role="group" aria-label="Which version to check" className="flex gap-1 rounded-lg bg-secondary p-0.5">
                <Half label="Original" model={root} mark={statusMark(rootVerdict)} pressed={onOriginal} testId="analysis-version-original" />
                <Half label={versionName(head)} model={head} mark={statusMark(headVerdict)} pressed={!onOriginal} testId="analysis-version-latest" />
            </div>
        </div>
    );
}
