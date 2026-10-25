// What the one-line summary of the analysis says, for the folded pill and the phone's peek card: the answer in a few words, or the
// stabilizer run when that is the news.

import { useMemo } from "react";
import { Blocks, Info, Loader2, Square, TriangleAlert, type LucideIcon } from "lucide-react";

import { customSettingsLine } from "@/assignment/components/analysis/panelLogic";
import { TONE, VERDICT_ICON, VERDICT_TONE, type ToneStyle } from "@/assignment/components/analysis/style";
import type { AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { verdictSentence } from "@/assignment/store/analysisBrief";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { outcomeOf, runBadge, type RunBadge } from "@/assignment/store/stabilizeLogic";

/** What the one-line summary of the analysis says, with the symbol that goes with it. */
export interface Chip {
    Icon: LucideIcon;
    text: string;
    tone: ToneStyle;
    spin: boolean;
    /** "longest overhang 9, fill threshold 60%" when the verdict is for other than the default settings. */
    custom?: string | null;
}

const RUN_ICON: Record<RunBadge["kind"], LucideIcon> = {
    running: Loader2,
    saving: Loader2,
    review: TriangleAlert,
    stopped: Square,
    nothing: Info,
    failed: TriangleAlert,
};
const RUN_TONE: Record<RunBadge["kind"], ToneStyle> = {
    running: TONE.muted,
    saving: TONE.muted,
    review: TONE.warn,
    stopped: TONE.warn,
    nothing: TONE.muted,
    failed: TONE.fail,
};

/** The one-line summary of the analysis for the folded pill and the phone's card: the run when there is news, else the answer in a few words. */
export function summaryChip(snapshot: AnalysisSnapshot, run: RunBadge | null = null): Chip {
    const { phase, verdict, result } = snapshot;
    // A run in progress, or one that waits for a decision, is the news; the verdict is what it is changing.
    if (run) return { Icon: RUN_ICON[run.kind], text: run.text, tone: RUN_TONE[run.kind], spin: run.kind === "running" || run.kind === "saving" };
    if (phase === "running") return { Icon: Loader2, text: "Checking…", tone: TONE.muted, spin: true };
    if (phase === "loading" && !verdict) return { Icon: Loader2, text: "Loading…", tone: TONE.muted, spin: true };
    if (phase === "unavailable") return { Icon: VERDICT_ICON.warn, text: "Model not shown", tone: TONE.warn, spin: false };
    if (phase === "error") return { Icon: VERDICT_ICON.fail, text: "Check failed", tone: TONE.fail, spin: false };
    if (verdict) {
        // "Will tip over", "2 arms too long", "Stable": the first reason in a few words.
        const text = snapshot.sentence?.pill ?? (result ? verdictSentence(result).pill : verdict.short);
        // The result's own settings in the Settings page's words; a verdict without a result (a stored summary) has the store's short form.
        const custom = result ? customSettingsLine(result.settings) : verdict.custom;
        return { Icon: VERDICT_ICON[verdict.kind], text, tone: TONE[VERDICT_TONE[verdict.kind]], spin: false, custom };
    }
    return { Icon: Blocks, text: "Stability", tone: TONE.muted, spin: false };
}

/** The state of the Stabilize run for the pill, or null when there is no run to speak of (then the pill says the verdict). */
export function useRunBadge(): RunBadge | null {
    const status = useStabilizeStore((s) => s.status);
    const steps = useStabilizeStore((s) => s.steps.length);
    const errorKind = useStabilizeStore((s) => s.errorKind);
    const outcome = useStabilizeStore((s) => (s.result ? outcomeOf(s.result) : null));
    return useMemo(() => runBadge({ status, steps, errorKind, outcome }), [status, steps, errorKind, outcome]);
}
