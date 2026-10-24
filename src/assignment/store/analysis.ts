// The analysis tool's state: the settings, the run (progress, error), the result for the model in the viewer,
// what the viewer should show of it (colour mode, layer cut, highlight) and which issue is selected.
//
// The analysis itself is run by components/analysis/useAnalysisRunner.ts; this file only holds what it
// reports and what the panel and the viewer read. Pure rules live in analysisLogic.ts.

import { create } from "zustand";

import { DEFAULT_ANALYSIS_VIEW } from "@/assignment/analysis/types";
import type {
    AnalysisColorBy,
    AnalysisResult,
    AnalysisSettings,
    AnalysisViewState,
    CheckKey,
    LoadedModel,
} from "@/assignment/analysis/types";
import type { AnalysisSummary } from "@/assignment/shared/contract";
import {
    IDLE_RUN,
    centreBlockMm,
    indexIssuesByBlock,
    layerMaxForSelection,
    loadSettings,
    nextLayerMax,
    reconcileSelection,
    sameSettings,
    sanitizeSettings,
    saveSettings,
    selectionView,
    type RunState,
    type SelectionState,
} from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/** What the viewer is told, minus `mode`, which the workspace tab decides. */
export type ViewBits = Omit<AnalysisViewState, "mode">;

export type AnalysisSelection = SelectionState;

const NO_BLOCKS: number[] = [];
/** Issue kinds whose cause is easiest to judge against the original mesh (what the blocks left out or joined). */
const GHOST_KINDS: readonly string[] = ["thin-features", "floating"];
const EMPTY_INDEX = new Map<number, string>();
let focusToken = 0;

const INITIAL_VIEW: ViewBits = {
    colorBy: DEFAULT_ANALYSIS_VIEW.colorBy,
    layerMax: DEFAULT_ANALYSIS_VIEW.layerMax,
    showGhost: DEFAULT_ANALYSIS_VIEW.showGhost,
    showCog: DEFAULT_ANALYSIS_VIEW.showCog,
    highlight: NO_BLOCKS,
    focus: null,
};

type PickState = Pick<AnalysisState, "selection" | "layerRaised" | "hoverIssueId" | "view">;

/**
 * The state with nothing picked: no selection, no highlight, and no callout pointing at what is not there. `{}`
 * when nothing was picked, so a no-op does not wake the viewer with a new view object.
 */
function clearedPick(s: Pick<AnalysisState, "selection" | "layerRaised" | "view">): PickState | Record<string, never> {
    if (s.selection === null && s.view.highlight.length === 0 && s.view.focus === null && !s.layerRaised) return {};
    return { selection: null, layerRaised: false, hoverIssueId: null, view: { ...s.view, highlight: NO_BLOCKS, focus: null } };
}

interface SelectOptions {
    check?: CheckKey | null;
    /** Fly the camera to the issue (default). A click on a block in the viewer passes false: it is already looking. */
    focus?: boolean;
    label?: string;
}

interface AnalysisState {
    settings: AnalysisSettings;
    /** The model the viewer reported as loaded (its url says which). */
    loaded: LoadedModel | null;
    /** The viewer could not show this url (it failed to load): there are no triangles to analyse. */
    viewerFailure: { url: string; message: string } | null;
    run: RunState;
    /** The latest result and the model it is for. */
    result: AnalysisResult | null;
    resultModelId: string | null;
    /** block index -> issue id, for the result above. */
    blockIssues: ReadonlyMap<number, string>;
    /** The newest summary per model this visit, so cards and badges show a verdict without the result. */
    summaries: Record<string, AnalysisSummary>;
    view: ViewBits;
    selection: AnalysisSelection | null;
    /**
     * Bumped each time the user picks something to show (a card, a check row, a block), not when a re-run keeps
     * the pick: the phone's report sheet closes on a new pick only.
     */
    selectionSerial: number;
    /** The last pick raised the layer cut to keep its blocks in view (the panel says so). */
    layerRaised: boolean;
    /** The issue under the pointer in the viewer, so its card lights up. */
    hoverIssueId: string | null;
    /** Bumped by Retry: the runner starts again. */
    attempt: number;
    /** Desktop: the report panel is open (false = folded into a pill). */
    panelOpen: boolean;
    /** Phone: the report sheet is open. */
    sheetOpen: boolean;
    /** Bumped when something outside the canvas asks to see the analysis (a chat card): a phone then leaves the chat. */
    openRequest: number;

    setLoaded: (loaded: LoadedModel | null) => void;
    /** The viewer could not show the model at `url`. */
    modelFailed: (url: string, message: string) => void;
    /**
     * The model in the viewer changed (to this id, this url). The viewer's handle for any other url is stale (its
     * scene is gone or reloading, so its triangles read as empty) and a pick made on another model's result no
     * longer means anything: both go at once, not when the next run starts.
     */
    modelChanged: (modelId: string | null, glbUrl: string | null) => void;
    updateSettings: (patch: Partial<AnalysisSettings>) => void;
    resetSettings: () => void;

    runStarted: (modelId: string) => void;
    runProgress: (modelId: string, stage: string, progress: number) => void;
    runSucceeded: (modelId: string, result: AnalysisResult) => void;
    runFailed: (modelId: string, message: string) => void;
    retry: () => void;

    setColorBy: (colorBy: AnalysisColorBy) => void;
    setLayerMax: (layerMax: number) => void;
    setShowGhost: (show: boolean) => void;
    setShowCog: (show: boolean) => void;

    selectIssues: (ids: readonly string[], options?: SelectOptions) => void;
    /** A group of blocks that is no issue (the cantilevered-blocks row): highlight them and look at their middle. */
    selectBlocks: (blocks: readonly number[], options: { check: CheckKey; label: string }) => void;
    /** A click on an issue card: select it, or clear it when it is the one selected. */
    toggleIssue: (id: string) => void;
    clearSelection: () => void;
    hoverBlock: (index: number | null) => void;
    clickBlock: (index: number | null) => void;

    setPanelOpen: (open: boolean) => void;
    setSheetOpen: (open: boolean) => void;
}

export const useAnalysisStore = create<AnalysisState>()((set, get) => ({
    settings: loadSettings(),
    loaded: null,
    viewerFailure: null,
    run: IDLE_RUN,
    result: null,
    resultModelId: null,
    blockIssues: EMPTY_INDEX,
    summaries: {},
    view: INITIAL_VIEW,
    selection: null,
    selectionSerial: 0,
    layerRaised: false,
    hoverIssueId: null,
    attempt: 0,
    panelOpen: true,
    sheetOpen: false,
    openRequest: 0,

    // A model that loaded is not one that failed.
    setLoaded: (loaded) => set(loaded ? { loaded, viewerFailure: null } : { loaded }),
    modelFailed: (url, message) => set({ viewerFailure: { url, message } }),
    modelChanged: (modelId, glbUrl) =>
        set((s) => ({
            ...(s.loaded && s.loaded.url !== glbUrl ? { loaded: null } : {}),
            ...(s.resultModelId === modelId ? {} : clearedPick(s)),
        })),

    updateSettings: (patch) => {
        const next = sanitizeSettings({ ...get().settings, ...patch });
        if (sameSettings(next, get().settings)) return;
        saveSettings(next);
        set({ settings: next });
    },
    resetSettings: () => get().updateSettings(sanitizeSettings(null)),

    runStarted: (modelId) =>
        set((s) => ({
            run: { modelId, status: "running", error: null, stage: "Starting", progress: 0 },
            // Another model than the one the result (and so the pick) belongs to: start without its pick.
            ...(s.resultModelId === modelId ? {} : clearedPick(s)),
        })),
    runProgress: (modelId, stage, progress) =>
        set((s) =>
            s.run.modelId === modelId && s.run.status === "running" ? { run: { ...s.run, stage, progress } } : {},
        ),
    runSucceeded: (modelId, result) =>
        set((s) => {
            // A re-run of the model on screen keeps the colour mode, the layer cut and the selection (as far as it
            // still exists); another model starts fresh.
            const same = s.resultModelId === modelId && s.result !== null;
            const kept = same ? reconcileSelection(result, s.selection) : null;
            let layerMax = nextLayerMax(
                same && s.result ? { layerMax: s.view.layerMax, layers: s.result.stats.layers } : null,
                result.stats.layers,
            );
            // The kept pick may have moved up (other settings, other blocks): the cut still must not hide it.
            if (kept) layerMax = layerMaxForSelection(result, kept.highlight, s.view.focus?.mm ?? null, layerMax);
            return {
                run: { ...IDLE_RUN },
                result,
                resultModelId: modelId,
                blockIssues: indexIssuesByBlock(result.issues),
                summaries: { ...s.summaries, [modelId]: result.summary },
                selection: kept ? kept.selection : null,
                hoverIssueId: null,
                layerRaised: kept ? s.layerRaised : false,
                view: {
                    ...s.view,
                    layerMax,
                    highlight: kept ? kept.highlight : NO_BLOCKS,
                    // The callout belongs to the pick: with the pick gone it must not hang in the scene.
                    focus: kept ? s.view.focus : null,
                },
            };
        }),
    runFailed: (modelId, message) =>
        set((s) =>
            s.run.modelId === modelId ? { run: { ...s.run, status: "error", error: message, progress: 0 } } : {},
        ),
    retry: () => set((s) => ({ attempt: s.attempt + 1 })),

    setColorBy: (colorBy) => set((s) => (s.view.colorBy === colorBy ? {} : { view: { ...s.view, colorBy } })),
    setLayerMax: (layerMax) =>
        set((s) => (s.view.layerMax === layerMax ? {} : { layerRaised: false, view: { ...s.view, layerMax } })),
    setShowGhost: (showGhost) => set((s) => (s.view.showGhost === showGhost ? {} : { view: { ...s.view, showGhost } })),
    setShowCog: (showCog) => set((s) => (s.view.showCog === showCog ? {} : { view: { ...s.view, showCog } })),

    selectIssues: (ids, options = {}) => {
        const { result, view } = get();
        const sv = result ? selectionView(result.issues, ids, options.label) : null;
        if (!result || !sv) {
            get().clearSelection();
            return;
        }
        const flyTo = options.focus !== false && sv.focusMm !== null;
        // Thin parts left out are not in any block, and a floating part is best judged against the mesh it came
        // from (is the model really in two pieces, or did a thin joint fall under the fill threshold?).
        const needsGhost = ids.some((id) => {
            const kind = result.issues.find((issue) => issue.id === id)?.kind;
            return kind !== undefined && GHOST_KINDS.includes(kind);
        });
        // A layer cut that hides the picked blocks would light up nothing: raise it to show them.
        const layerMax = layerMaxForSelection(result, sv.highlight, sv.focusMm, view.layerMax);
        set((s) => ({
            selection: { ids: [...ids], check: options.check ?? null, label: sv.label },
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: {
                ...view,
                layerMax,
                showGhost: view.showGhost || needsGhost,
                highlight: sv.highlight,
                // A click on a block does not fly; it also must not leave the previous pick's callout up.
                focus: flyTo && sv.focusMm ? { mm: sv.focusMm, token: ++focusToken, label: sv.label } : null,
            },
        }));
    },
    selectBlocks: (blocks, options) => {
        const { result, view } = get();
        const focusMm = result ? centreBlockMm(result.blocks, blocks) : null;
        if (!result || !focusMm) {
            get().clearSelection();
            return;
        }
        const layerMax = layerMaxForSelection(result, blocks, focusMm, view.layerMax);
        set((s) => ({
            selection: { ids: [], check: options.check, label: options.label },
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: {
                ...view,
                layerMax,
                highlight: [...blocks],
                focus: { mm: focusMm, token: ++focusToken, label: options.label },
            },
        }));
    },
    toggleIssue: (id) => {
        const { selection } = get();
        if (selection && selection.ids.length === 1 && selection.ids[0] === id) get().clearSelection();
        else get().selectIssues([id]);
    },
    clearSelection: () => set((s) => clearedPick(s)),
    hoverBlock: (index) => {
        const id = index === null ? null : (get().blockIssues.get(index) ?? null);
        if (id !== get().hoverIssueId) set({ hoverIssueId: id });
    },
    clickBlock: (index) => {
        const id = index === null ? undefined : get().blockIssues.get(index);
        if (id === undefined) get().clearSelection();
        else get().selectIssues([id], { focus: false });
    },

    setPanelOpen: (panelOpen) => set({ panelOpen }),
    setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));

/**
 * Show the analysis of a model: make it the one in the viewer and switch to the Analysis tab. For the chat
 * cards and the Models list.
 */
export function openAnalysisFor(modelId: string): void {
    const workspace = useWorkspaceStore.getState();
    workspace.setActiveModel(modelId);
    workspace.setWorkspaceTab("analysis");
    useAnalysisStore.setState((s) => ({ openRequest: s.openRequest + 1, panelOpen: true, sheetOpen: true }));
}
