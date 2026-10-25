// Pure logic behind the workspace shell: the words on the Stability tab, how much of the window the floating panels cover (so the
// viewer frames the model in what is left), how a change from the stage's own controls reaches the analysis store, and which
// tab a ?tab= link means. No React and no stores, so WorkspaceShell, the page and scripts/assignment/test-versions-ui.mjs share one copy.

import type { AnalysisColorBy, AnalysisViewState } from "@/assignment/analysis/types";
import type { Insets } from "@/assignment/components/workspace/useViewerInsets";
import { dockInset, type AnalysisPhase, type Verdict } from "@/assignment/store/analysisLogic";
import type { WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

// ---------- the tab ----------

/** The tab that shows the report. Its id stays "analysis" (links, saved state and tests use it); its name is "Stability". */
export const STABILITY_TAB_LABEL = "Stability";

/** The tab's accessible name: "Stability, running", "Stability, failed", "Stability, 3 problems", "Stability, stable". */
export function stabilityTabLabel(snapshot: { phase: AnalysisPhase; verdict: Pick<Verdict, "short"> | null }): string {
    if (snapshot.phase === "running") return `${STABILITY_TAB_LABEL}, running`;
    if (snapshot.phase === "error") return `${STABILITY_TAB_LABEL}, failed`;
    return snapshot.verdict ? `${STABILITY_TAB_LABEL}, ${snapshot.verdict.short.toLowerCase()}` : STABILITY_TAB_LABEL;
}

/**
 * What a tap on a tab does to the phone's report sheet, as its new state (null: leave it as it is). Only the Stability tab has a
 * sheet. The first tap lands on the tab's peek card (the answer, the four figures and the one action, over the stage); a tap on
 * the tab that is already open opens the full report, and another one folds it away.
 */
export function sheetOnTabTap(input: { mobile: boolean; tapped: WorkspaceTab; current: WorkspaceTab; sheetOpen: boolean }): boolean | null {
    if (!input.mobile || input.tapped !== "analysis" || input.current !== "analysis") return null;
    return !input.sheetOpen;
}

/**
 * The tab a ?tab= link means: the ids "3d", "analysis" and "models" as ever (an opened example links to ?tab=analysis), and
 * "stability", the tab's name now, as another way to say "analysis". Anything else means no tab.
 */
export function tabFromParam(param: string | null): WorkspaceTab | null {
    switch (param) {
        case "3d":
        case "models":
            return param;
        case "analysis":
        case "stability":
            return "analysis";
        default:
            return null;
    }
}

// ---------- what the floating panels cover ----------

/** The phone's row under the bar that holds the picked issue's chip: 8 px of air and the 32 px chip. */
export const PHONE_SELECTION_ROW_PX = 40;
/** The desktop's folded pill under the bar: its row (the pill is 34 px) and a little air. */
export const FOLDED_PILL_ROW_PX = 40;
/** Air between the phone's peek card and the stage's toolbar above it. */
export const PHONE_PEEK_GAP_PX = 8;
/** The dock's margin under the peek card (more where there is a home indicator): the card's own height comes from the card. */
export const PHONE_PEEK_MARGIN_PX = 12;

export interface InsetsInput {
    /** What the bar and the chat panel cover. */
    insets: Insets;
    /** The Stability tab is open. */
    analysisOn: boolean;
    mobile: boolean;
    /** The version switcher's row under the bar, or 0. */
    switcherRowPx: number;
    /** Desktop: the report is open (false = folded into its pill). */
    panelOpen: boolean;
    /** The window minus the chat panel. */
    freeWidth: number;
    /** Desktop: how much the open report takes from the left. */
    dockInsetPx: number;
    /** Phone: the height of the peek card with its margin (measured, else the card's own estimate plus PHONE_PEEK_MARGIN_PX). */
    peekPx: number;
}

/**
 * The room the viewer frames the model in. The report floats over the viewer: beside it on the desktop, under the folded pill,
 * or on a phone between the picked-issue row at the top and the peek card at the bottom (the sheet is an overlay and takes none).
 */
export function viewerInsetsFor(input: InsetsInput): Insets {
    const { insets, analysisOn, mobile, switcherRowPx, panelOpen, freeWidth, dockInsetPx, peekPx } = input;
    if (!analysisOn) return switcherRowPx > 0 ? { ...insets, top: insets.top + switcherRowPx } : insets;
    // On a phone the row holds the switcher and the picked issue's chip side by side, and the peek card sits at the bottom.
    if (mobile) {
        return { ...insets, top: insets.top + Math.max(PHONE_SELECTION_ROW_PX, switcherRowPx), bottom: insets.bottom + peekPx + PHONE_PEEK_GAP_PX };
    }
    // In a narrow window the panel overlaps the model rather than squeezing it to a sliver. (An open panel is under the
    // switcher's row, not beside the model.)
    return panelOpen
        ? { ...insets, left: insets.left + dockInset(freeWidth, dockInsetPx) }
        : { ...insets, top: insets.top + switcherRowPx + FOLDED_PILL_ROW_PX + 4 };
}

// ---------- the stage's own controls ----------

/** What the stage's colour menu, layer popover and Show menu change: any of these at once. */
export type ViewPatch = Partial<Pick<AnalysisViewState, "colorBy" | "layerMax" | "showGhost" | "showCog">>;

/** The analysis store's setters for those four (the store itself satisfies this). */
export interface ViewSetters {
    setColorBy(colorBy: AnalysisColorBy): void;
    setLayerMax(layerMax: number): void;
    setShowGhost(show: boolean): void;
    setShowCog(show: boolean): void;
}

/** Hand a change from the stage to the store, one setter per field that is in the patch (the store decides what a colour mode may be). */
export function applyViewPatch(patch: ViewPatch, to: ViewSetters): void {
    if (patch.colorBy !== undefined) to.setColorBy(patch.colorBy);
    if (patch.layerMax !== undefined) to.setLayerMax(patch.layerMax);
    if (patch.showGhost !== undefined) to.setShowGhost(patch.showGhost);
    if (patch.showCog !== undefined) to.setShowCog(patch.showCog);
}
