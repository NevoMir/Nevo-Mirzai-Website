import { useState } from "react";
import { Blocks, Download, Loader2, PanelLeftClose } from "lucide-react";

import { ChecksSection } from "@/assignment/components/analysis/ChecksSection";
import { DefinitionsSection } from "@/assignment/components/analysis/DefinitionsSection";
import { IssuesSection } from "@/assignment/components/analysis/IssuesSection";
import { MetricsSection } from "@/assignment/components/analysis/MetricsSection";
import {
    ErrorState,
    LoadingState,
    NoModelState,
    RunningState,
    UnavailableState,
} from "@/assignment/components/analysis/PanelStates";
import { SettingsSection } from "@/assignment/components/analysis/SettingsSection";
import { VerdictHeader } from "@/assignment/components/analysis/VerdictHeader";
import { ViewSection } from "@/assignment/components/analysis/ViewSection";
import type { AnalysisSnapshot } from "@/assignment/components/analysis/useAnalysis";
import { downloadText } from "@/assignment/components/analysis/download";
import { Button } from "@/assignment/components/ui/button";
import { toast } from "@/assignment/components/ui/sonner";
import { modelFileName } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { reportStem } from "@/assignment/store/analysisLogic";

/** Width of the report panel on the desktop, and the space it takes from the viewer (panel + its margins). */
export const ANALYSIS_PANEL_PX = 320;
export const ANALYSIS_DOCK_INSET_PX = ANALYSIS_PANEL_PX + 24;

export interface AnalysisPanelProps {
    model: ModelAsset | null;
    snapshot: AnalysisSnapshot;
    /** "dock" = the floating panel on the desktop, "sheet" = the body of the phone's bottom sheet. */
    variant: "dock" | "sheet";
    /** Dock only: fold the panel away. */
    onCollapse?: () => void;
}

/**
 * The report: the verdict, the constraints, the problems with where and why, the view controls, the numbers
 * and the settings, and the two downloads. Everything it shows comes from the analysis store.
 */
export function AnalysisPanel({ model, snapshot, variant, onCollapse }: AnalysisPanelProps) {
    const { phase, result, verdict, run, unavailable } = snapshot;
    const retry = useAnalysisStore((s) => s.retry);
    const updating = phase === "running" && result !== null;
    const [busy, setBusy] = useState<"json" | "csv" | null>(null);

    const download = async (kind: "json" | "csv") => {
        if (!result || !model || busy) return;
        setBusy(kind);
        try {
            // The report builders load on first use.
            const report = await import("@/assignment/analysis/report");
            const stem = reportStem(modelFileName(model));
            if (kind === "json") {
                const meta = { modelId: model.id, modelUrl: model.glb_url, prompt: model.prompt, provider: model.provider };
                downloadText(`${stem}.json`, "application/json", report.buildReportJson(result, meta));
            } else {
                downloadText(`${stem}-blocks.csv`, "text/csv", report.buildBlocksCsv(result));
            }
        } catch {
            toast.error("Could not create the file");
        } finally {
            setBusy(null);
        }
    };

    let body;
    if (phase === "no-model") {
        body = <NoModelState />;
    } else if (phase === "unavailable") {
        body = <UnavailableState message={unavailable ?? "The model could not be displayed."} />;
    } else if (phase === "error") {
        body = (
            <>
                <ErrorState message={run.error ?? "The analysis failed."} onRetry={retry} />
                <SettingsSection />
            </>
        );
    } else if (result && verdict) {
        body = (
            <div className={cn("transition-opacity", updating && "opacity-60")} aria-busy={updating}>
                <VerdictHeader result={result} verdict={verdict} />
                <ChecksSection result={result} />
                <IssuesSection result={result} />
                <ViewSection result={result} />
                <MetricsSection result={result} />
                <SettingsSection />
                <DefinitionsSection />
            </div>
        );
    } else if (phase === "running") {
        body = <RunningState run={run} />;
    } else {
        body = <LoadingState />;
    }

    return (
        <div
            data-testid="analysis-panel"
            data-phase={phase}
            className={cn(
                "flex h-full min-h-0 flex-col overflow-hidden",
                variant === "dock" && "rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur",
            )}
        >
            <header className={cn("flex shrink-0 items-center gap-2 border-b border-border/60 py-2.5 pl-4", variant === "sheet" ? "pr-12" : "pr-2.5")}>
                <Blocks className="h-4 w-4 shrink-0 text-accent" aria-hidden />
                <div className="min-w-0 flex-1">
                    <h2 className="flex items-center gap-2 text-sm font-semibold leading-tight text-foreground">
                        Structure check
                        {updating && (
                            <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground" role="status">
                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                                Updating…
                            </span>
                        )}
                    </h2>
                    {/* Which model this is about: a project can hold several. */}
                    {model && (
                        <p className="truncate text-[11px] leading-tight text-muted-foreground" title={model.prompt}>
                            {model.prompt}
                        </p>
                    )}
                </div>
                {onCollapse && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={onCollapse}
                        aria-label="Collapse the report panel"
                        title="Collapse the report panel"
                    >
                        <PanelLeftClose className="h-4 w-4" />
                    </Button>
                )}
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-testid="analysis-scroll">
                {body}
            </div>

            {result && (
                <footer className="flex shrink-0 gap-2 border-t border-border/60 p-3">
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 gap-1.5 px-2 text-xs"
                        disabled={busy !== null}
                        onClick={() => void download("json")}
                        aria-label="Download report (JSON)"
                        data-testid="download-json"
                    >
                        <Download />
                        Report (JSON)
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 gap-1.5 px-2 text-xs"
                        disabled={busy !== null}
                        onClick={() => void download("csv")}
                        aria-label="Download blocks (CSV)"
                        data-testid="download-csv"
                    >
                        <Download />
                        Blocks (CSV)
                    </Button>
                </footer>
            )}
        </div>
    );
}
