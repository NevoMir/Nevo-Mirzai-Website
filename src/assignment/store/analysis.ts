// The analysis tool's state: the settings, the run (progress, error), the result for the model in the viewer, what the
// viewer should show of it (colour mode, layer cut, highlight, focus) and which issue is selected.
//
// The analysis itself is run by components/analysis/useAnalysisRunner.ts; this file only holds what it
// reports and what the panel and the viewer read. Pure rules live in analysisLogic.ts.
//
// Two results can be on the stage: `result` (the model's own analysis, which the report panel always reads) and the
// `preview` (the stabilizer's work in progress, store/stabilize.ts). stageResultOf says which one the viewer draws; block
// numbers differ between them, so a pick made against the report is translated by grid cell (mapBlockIndices). Which VERSION of
// a model is on the stage is not decided here: the top bar's Original | Stabilized switch changes the active model
// (components/workspace/versionActions.ts), and the analysis follows it.

import { create } from "zustand";

import { DEFAULT_ANALYSIS_VIEW } from "@/assignment/analysis/types";
import type {
    AnalysisColorBy,
    AnalysisResult,
    AnalysisSettings,
    AnalysisViewState,
    CheckKey,
    LoadedModel,
    Vec3,
} from "@/assignment/analysis/types";
import type { AnalysisSummary } from "@/assignment/shared/contract";
import {
    IDLE_RUN,
    centreBlockMm,
    hasAddedBlocks,
    indexIssuesByBlock,
    layerMaxForSelection,
    loadSettings,
    mapBlockIndices,
    nextLayerMax,
    reconcileSelection,
    resolveColorBy,
    sameSettings,
    sanitizeSettings,
    saveSettings,
    selectionView,
    stageResultOf,
    stepBlocks,
    type PreviewState,
    type RunState,
    type SelectionState,
} from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { meshFailures, versionFamily } from "@/assignment/store/versions";

/** What the viewer is told, minus `mode`, which the workspace tab decides. */
export type ViewBits = Omit<AnalysisViewState, "mode">;

export type AnalysisSelection = SelectionState;

const NO_BLOCKS: number[] = [];
/** Issue kinds whose cause is easiest to judge against the original mesh (what the blocks left out or joined). */
const GHOST_KINDS: readonly string[] = ["thin-features", "floating"];
/** Issue kinds that are about the stress estimate: showing one is a reason to paint the blocks by stress. */
const STRESS_KINDS: readonly string[] = ["overstressed", "highly-stressed"];
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

type PickState = Pick<AnalysisState, "selection" | "layerRaised" | "hoverIssueId" | "view" | "stepSelection">;

/**
 * The state with nothing picked: no selection, no highlight, and no callout pointing at what is not there. `{}`
 * when nothing was picked, so a no-op does not wake the viewer with a new view object.
 */
function clearedPick(
    s: Pick<AnalysisState, "selection" | "layerRaised" | "view" | "stepSelection">,
): PickState | Record<string, never> {
    if (s.selection === null && s.view.highlight.length === 0 && s.view.focus === null && !s.layerRaised && s.stepSelection === null) return {};
    return {
        selection: null,
        layerRaised: false,
        hoverIssueId: null,
        stepSelection: null,
        view: { ...s.view, highlight: NO_BLOCKS, focus: null },
    };
}

/** The result the viewer draws (see the header). */
export const selectStageResult = (s: AnalysisState): AnalysisResult | null =>
    stageResultOf({ result: s.result, resultModelId: s.resultModelId, preview: s.preview });

/**
 * Applies `patch`, then re-derives the colour mode the stage uses from the user's choice: stress needs an estimate, role
 * (the added blocks) needs added blocks, and the live preview always paints by role. Every change that can alter what is
 * possible goes through here.
 */
function settle(s: AnalysisState, patch: Partial<AnalysisState>): Partial<AnalysisState> {
    const next = { ...s, ...patch } as AnalysisState;
    const stage = selectStageResult(next);
    const colorBy = resolveColorBy(next.colorChoice, {
        stress: !!stage?.stress,
        roles: hasAddedBlocks(stage),
        forceRole: next.preview !== null && next.preview.modelId === next.resultModelId,
    });
    return colorBy === next.view.colorBy ? patch : { ...patch, view: { ...next.view, colorBy } };
}

/** A block number from the viewer (a block of the stage) as a block number of the report's result; null if the report has no such block. */
function toReportIndex(s: AnalysisState, index: number | null): number | null {
    if (index === null) return null;
    const stage = selectStageResult(s);
    if (!s.result || !stage || stage === s.result) return index;
    const mapped = mapBlockIndices(stage, s.result, [index]);
    return mapped.length > 0 ? mapped[0] : null;
}

/**
 * The url of the GLB the viewer shows for a model. A stabilized model is shown over the mesh it was made from (store/versions.ts),
 * so that is the mesh whose handle counts as "this model's"; the caller may still pass the model's own url (it cannot know), and
 * a model the project does not have is shown from the url it was given.
 */
function shownUrlOf(modelId: string | null, glbUrl: string | null): string | null {
    if (modelId === null) return glbUrl;
    const family = versionFamily(useWorkspaceStore.getState().models, modelId, meshFailures());
    return family && family.display.id !== modelId ? family.display.glb_url : glbUrl;
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
    /**
     * The colour mode the user picked. `view.colorBy` is what the stage uses: the same, unless it cannot be drawn or the
     * stabilizer's live preview forces its own (the role colours).
     */
    colorChoice: AnalysisColorBy;
    /** The stabilizer's work in progress (store/stabilize.ts), drawn instead of `result` while it is for the model on screen. */
    preview: PreviewState | null;
    selection: AnalysisSelection | null;
    /** The stabilizer step whose blocks are shown (a timeline click), else null. */
    stepSelection: number | null;
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
     * longer means anything: both go at once, not when the next run starts. For a stabilized version the handle that
     * stays is the one of the mesh it is shown on (its source's), whatever url is passed.
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
    /**
     * Paint the stage by stress, unless that cannot be seen: there is no estimate, the stabilizer's preview paints by
     * role, or it already is. The stress rows and cards call it (through the picks below), so "Show" on a stress
     * point shows the heat map the point belongs to instead of a highlight on status colours.
     */
    showStress: () => void;
    /** The stabilizer's work in progress for `modelId`; null removes it. */
    setPreview: (modelId: string, result: AnalysisResult | null) => void;
    setLayerMax: (layerMax: number) => void;
    setShowGhost: (show: boolean) => void;
    setShowCog: (show: boolean) => void;

    selectIssues: (ids: readonly string[], options?: SelectOptions) => void;
    /** A group of blocks that is no issue (the overhanging-blocks row): highlight them and look at their middle. */
    selectBlocks: (blocks: readonly number[], options: { check: CheckKey; label: string }) => void;
    /**
     * Look at a point that is no block or issue (the balance point of a model that stands): the camera flies to `mm` and a callout
     * names it. Nothing is highlighted. It is a pick like the others (Esc and Clear let go; the layer cut rises to show it; a phone's
     * sheet closes), with an empty selection that carries the label.
     */
    focusPoint: (mm: Vec3, label: string) => void;
    /** A stabilizer step (a timeline click): highlight the blocks it added and fly to `atMm`. */
    selectStepBlocks: (step: number, options: { atMm: Vec3; label: string }) => void;
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
    colorChoice: INITIAL_VIEW.colorBy,
    preview: null,
    selection: null,
    stepSelection: null,
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
        set((s) => {
            const shownUrl = shownUrlOf(modelId, glbUrl);
            const other = s.resultModelId !== modelId;
            const cleared = other ? (clearedPick(s) as Partial<PickState>) : {};
            return settle(s, {
                ...(s.loaded && s.loaded.url !== shownUrl ? { loaded: null } : {}),
                ...cleared,
            });
        }),

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
    runSucceeded: (modelId, result) => {
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
            return settle(s, {
                run: { ...IDLE_RUN },
                result,
                resultModelId: modelId,
                blockIssues: indexIssuesByBlock(result.issues),
                summaries: { ...s.summaries, [modelId]: result.summary },
                selection: kept ? kept.selection : null,
                stepSelection: null,
                hoverIssueId: null,
                layerRaised: kept ? s.layerRaised : false,
                view: {
                    ...s.view,
                    layerMax,
                    highlight: kept ? kept.highlight : NO_BLOCKS,
                    // The callout belongs to the pick: with the pick gone it must not hang in the scene.
                    focus: kept ? s.view.focus : null,
                },
            });
        });
    },
    runFailed: (modelId, message) =>
        set((s) =>
            s.run.modelId === modelId ? { run: { ...s.run, status: "error", error: message, progress: 0 } } : {},
        ),
    retry: () => set((s) => ({ attempt: s.attempt + 1 })),

    setColorBy: (colorBy) => set((s) => (s.colorChoice === colorBy ? {} : settle(s, { colorChoice: colorBy }))),
    showStress: () => {
        const s = get();
        if (!s.result?.stress || s.colorChoice === "stress") return;
        if (s.preview !== null && s.preview.modelId === s.resultModelId) return;
        get().setColorBy("stress");
    },
    setPreview: (modelId, result) =>
        set((s) => {
            if (!s.preview && !result) return {};
            const preview = result ? { modelId, result } : null;
            // Entering or leaving the preview changes whose block numbers the pick refers to; inside it, a step
            // selection follows the growing assembly (its blocks move up in the list as blocks are added).
            const entering = !s.preview !== !preview;
            const cleared = entering ? (clearedPick(s) as Partial<PickState>) : {};
            let view = cleared.view ?? s.view;
            if (!entering && preview && s.stepSelection !== null) view = { ...view, highlight: stepBlocks(preview.result, s.stepSelection) };
            return settle(s, { ...cleared, preview, ...(view !== s.view ? { view } : {}) });
        }),

    setLayerMax: (layerMax) =>
        set((s) => (s.view.layerMax === layerMax ? {} : { layerRaised: false, view: { ...s.view, layerMax } })),
    setShowGhost: (showGhost) => set((s) => (s.view.showGhost === showGhost ? {} : { view: { ...s.view, showGhost } })),
    setShowCog: (showCog) => set((s) => (s.view.showCog === showCog ? {} : { view: { ...s.view, showCog } })),

    selectIssues: (ids, options = {}) => {
        if (options.focus !== false) {
            const issues = get().result?.issues ?? [];
            if (options.check === "stress" || ids.some((id) => STRESS_KINDS.includes(issues.find((issue) => issue.id === id)?.kind ?? ""))) get().showStress();
        }
        const state = get();
        const { result, view } = state;
        const stage = selectStageResult(state);
        const sv = result ? selectionView(result.issues, ids, options.label) : null;
        if (!result || !stage || !sv) {
            get().clearSelection();
            return;
        }
        const highlight = stage === result ? sv.highlight : mapBlockIndices(result, stage, sv.highlight);
        const flyTo = options.focus !== false && sv.focusMm !== null;
        // Thin parts left out are not in any block, and a floating part is best judged against the mesh it came
        // from (is the model really in two pieces, or did a thin joint fall under the fill threshold?).
        const needsGhost = ids.some((id) => {
            const kind = result.issues.find((issue) => issue.id === id)?.kind;
            return kind !== undefined && GHOST_KINDS.includes(kind);
        });
        // A layer cut that hides the picked blocks would light up nothing: raise it to show them.
        const layerMax = layerMaxForSelection(stage, highlight, sv.focusMm, view.layerMax);
        set((s) => ({
            selection: { ids: [...ids], check: options.check ?? null, label: sv.label },
            stepSelection: null,
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: {
                ...view,
                layerMax,
                showGhost: view.showGhost || needsGhost,
                highlight,
                // A click on a block does not fly; it also must not leave the previous pick's callout up.
                focus: flyTo && sv.focusMm ? { mm: sv.focusMm, token: ++focusToken, label: sv.label } : null,
            },
        }));
    },
    selectBlocks: (blocks, options) => {
        if (options.check === "stress") get().showStress();
        const state = get();
        const { result, view } = state;
        const stage = selectStageResult(state);
        const focusMm = result ? centreBlockMm(result.blocks, blocks) : null;
        if (!result || !stage || !focusMm) {
            get().clearSelection();
            return;
        }
        const highlight = stage === result ? [...blocks] : mapBlockIndices(result, stage, blocks);
        const layerMax = layerMaxForSelection(stage, highlight, focusMm, view.layerMax);
        set((s) => ({
            selection: { ids: [], check: options.check, label: options.label },
            stepSelection: null,
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: {
                ...view,
                layerMax,
                highlight,
                focus: { mm: focusMm, token: ++focusToken, label: options.label },
            },
        }));
    },
    focusPoint: (mm, label) => {
        const state = get();
        const stage = selectStageResult(state);
        if (!state.result || !stage) return;
        const { view } = state;
        // Like every pick: a layer cut that hides the point's layer rises to show it.
        const layerMax = layerMaxForSelection(stage, NO_BLOCKS, mm, view.layerMax);
        set((s) => ({
            selection: { ids: [], check: null, label },
            stepSelection: null,
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: { ...view, layerMax, highlight: NO_BLOCKS, focus: { mm, token: ++focusToken, label } },
        }));
    },
    selectStepBlocks: (step, options) => {
        const state = get();
        const { view } = state;
        const stage = selectStageResult(state);
        const highlight = stage ? stepBlocks(stage, step) : [];
        if (!stage || highlight.length === 0) {
            get().clearSelection();
            return;
        }
        const layerMax = layerMaxForSelection(stage, highlight, options.atMm, view.layerMax);
        set((s) => ({
            selection: { ids: [], check: null, label: options.label },
            stepSelection: step,
            selectionSerial: s.selectionSerial + 1,
            layerRaised: layerMax > view.layerMax,
            view: { ...view, layerMax, highlight, focus: { mm: options.atMm, token: ++focusToken, label: options.label } },
        }));
    },
    toggleIssue: (id) => {
        const { selection } = get();
        if (selection && selection.ids.length === 1 && selection.ids[0] === id) get().clearSelection();
        else get().selectIssues([id]);
    },
    clearSelection: () => set((s) => clearedPick(s)),
    hoverBlock: (index) => {
        const mapped = toReportIndex(get(), index);
        const id = mapped === null ? null : (get().blockIssues.get(mapped) ?? null);
        if (id !== get().hoverIssueId) set({ hoverIssueId: id });
    },
    clickBlock: (index) => {
        const mapped = toReportIndex(get(), index);
        const id = mapped === null ? undefined : get().blockIssues.get(mapped);
        if (id === undefined) get().clearSelection();
        else get().selectIssues([id], { focus: false });
    },

    setPanelOpen: (panelOpen) => set({ panelOpen }),
    setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));

/** Show the analysis of a model: make it the one in the viewer and switch to the Stability tab. For the chat cards and the Models list. */
export function openAnalysisFor(modelId: string): void {
    const workspace = useWorkspaceStore.getState();
    workspace.setActiveModel(modelId);
    workspace.setWorkspaceTab("analysis");
    useAnalysisStore.setState((s) => ({ openRequest: s.openRequest + 1, panelOpen: true, sheetOpen: true }));
}
