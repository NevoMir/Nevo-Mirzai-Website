import { ArrowLeft, Blocks, Info, Loader2, PanelLeftClose, Settings } from "lucide-react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { ExportMenu } from "@/assignment/components/analysis/ExportMenu";
import { PAGE_TITLE, type PanelPage } from "@/assignment/components/analysis/panelLogic";
import { Button } from "@/assignment/components/ui/button";
import { modelTitle } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";

const iconButton = "h-11 w-11 text-muted-foreground hover:bg-secondary hover:text-foreground md:h-7 md:w-7";

export interface PanelHeaderProps {
    page: PanelPage;
    model: ModelAsset | null;
    /** The result the export menu writes its files from, when there is one. */
    result: AnalysisResult | null;
    /** A re-run is under way: the numbers below are about to change. */
    updating: boolean;
    /** The settings are not the assignment's: the gear carries a dot. */
    customSettings: boolean;
    variant: "dock" | "sheet";
    onPage: (page: PanelPage) => void;
    /** Dock only: fold the panel away. */
    onCollapse?: () => void;
}

/**
 * The header, 44 px: the panel's name and the model it is about, then what the panel offers beyond the report, grouped by
 * what it is. The gear (settings) and the info (how it is computed) open a page inside the panel, not a popover: the phone's sheet
 * keeps focus inside itself. On a page, the back arrow takes the place of the title.
 */
export function PanelHeader({ page, model, result, updating, customSettings, variant, onPage, onCollapse }: PanelHeaderProps) {
    const sheet = variant === "sheet";
    const fold = onCollapse && (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            className={iconButton}
            onClick={onCollapse}
            aria-label="Collapse the stability panel"
            title="Collapse"
            data-testid="analysis-collapse"
        >
            <PanelLeftClose />
        </Button>
    );

    if (page !== "report") {
        return (
            <header
                className={cn("flex min-h-11 shrink-0 items-center gap-1 border-b border-border/60 py-1 pl-1.5", sheet ? "pr-12" : "pr-1.5")}
                data-testid="analysis-header"
                data-page={page}
            >
                <Button type="button" variant="ghost" size="icon" className={iconButton} onClick={() => onPage("report")} aria-label="Back to the report" title="Back" data-testid="analysis-back" autoFocus>
                    <ArrowLeft />
                </Button>
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight text-foreground">{PAGE_TITLE[page]}</h2>
                {fold}
            </header>
        );
    }

    return (
        <header
            className={cn("flex min-h-11 shrink-0 items-center gap-1 border-b border-border/60 py-1 pl-4", sheet ? "pr-12" : "pr-1.5")}
            data-testid="analysis-header"
            data-page="report"
        >
            <Blocks className="mr-1 h-4 w-4 shrink-0 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 text-sm font-semibold leading-tight text-foreground">
                    Stability
                    {updating && (
                        <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground" role="status">
                            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
                            Updating…
                        </span>
                    )}
                </h2>
                {/* Which model this is about: a project can hold several. */}
                {model && (
                    <p className="truncate text-[11px] leading-tight text-muted-foreground" title={model.prompt}>
                        {modelTitle(model)}
                    </p>
                )}
            </div>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(iconButton, "relative")}
                onClick={() => onPage("settings")}
                aria-label={customSettings ? "Settings (custom settings are on)" : "Settings"}
                title="Settings"
                data-testid="analysis-settings-button"
            >
                <Settings />
                {customSettings && <span aria-hidden data-testid="analysis-custom-dot" className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary md:right-0.5 md:top-0.5" />}
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className={iconButton}
                onClick={() => onPage("about")}
                aria-label="How is this computed?"
                title="How is this computed?"
                data-testid="analysis-about-button"
            >
                <Info />
            </Button>
            <ExportMenu model={model} result={result} />
            {fold}
        </header>
    );
}
