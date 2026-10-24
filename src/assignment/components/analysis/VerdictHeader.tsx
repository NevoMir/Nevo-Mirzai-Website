import { Check, Minus, RotateCcw, X } from "lucide-react";

import { TONE, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisResult } from "@/assignment/analysis/types";
import { cn } from "@/assignment/lib/utils";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { plural, scaleLine, type Verdict } from "@/assignment/store/analysisLogic";

const SEGMENT_TONE = { pass: "bg-success", fail: "bg-destructive", info: "bg-muted-foreground/40" } as const;

/**
 * The first thing in the report: is the design OK? A banner with the verdict in words and a symbol (never
 * colour alone), how many of the required checks pass, a segment per check, and what was analysed.
 */
export function VerdictHeader({ result, verdict }: { result: AnalysisResult; verdict: Verdict }) {
    const resetSettings = useAnalysisStore((s) => s.resetSettings);
    const tone = TONE[VERDICT_TONE[verdict.kind]];
    const required = result.checks.filter((check) => check.status !== "info");
    const passing = required.filter((check) => check.status === "pass").length;
    const Glyph = verdict.kind === "pass" ? Check : verdict.kind === "fail" ? X : Minus;
    const checks = required.length > 0 ? `${passing} of ${required.length} checks pass` : "Structure checked";
    const sub =
        verdict.kind === "warn"
            ? "Nothing fails, but there is something to look at"
            : verdict.warnings > 0
              ? `${checks} · ${plural(verdict.warnings, "warning")}`
              : checks;

    return (
        <div className="px-4 pb-3 pt-3.5" data-testid="analysis-verdict" data-verdict={verdict.kind}>
            <div role="status" className={cn("rounded-xl border px-3.5 py-3", tone.soft, tone.border)}>
                <div className="flex items-center gap-3">
                    <span
                        aria-hidden
                        className={cn(
                            "grid h-10 w-10 shrink-0 place-items-center rounded-full",
                            tone.solid,
                            verdict.kind === "warn" ? "text-amber-950" : "text-white",
                        )}
                    >
                        <Glyph className="h-5 w-5" strokeWidth={3} />
                    </span>
                    <div className="min-w-0">
                        <p className={cn("text-[15px] font-semibold leading-tight", tone.text)}>{verdict.headline}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
                    </div>
                </div>
                {result.checks.length > 0 && (
                    <div className="mt-3 flex gap-1" aria-hidden>
                        {result.checks.map((check) => (
                            <span
                                key={check.key}
                                title={`${check.label}: ${check.value}`}
                                className={cn("h-1.5 flex-1 rounded-full", SEGMENT_TONE[check.status])}
                            />
                        ))}
                    </div>
                )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground" data-testid="analysis-scale-line">
                {scaleLine(result)}
            </p>
            {/* The settings are remembered in this browser and decide the verdict, so a non-default one is said here. */}
            {verdict.custom && (
                <p
                    className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] text-foreground"
                    data-testid="analysis-custom-settings"
                >
                    <span>
                        <span className="font-medium">Custom settings:</span> {verdict.custom}
                        <span className="text-muted-foreground">
                            {" "}
                            (default: limit {DEFAULT_ANALYSIS_SETTINGS.cantileverLimit}, fill {Math.round(DEFAULT_ANALYSIS_SETTINGS.fillThreshold * 100)}%, {DEFAULT_ANALYSIS_SETTINGS.material})
                        </span>
                    </span>
                    <button
                        type="button"
                        onClick={resetSettings}
                        className="ml-auto flex items-center gap-1 rounded-md px-1 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <RotateCcw className="h-3 w-3" aria-hidden />
                        Reset
                    </button>
                </p>
            )}
        </div>
    );
}
