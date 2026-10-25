// The Optimization tab's run: a goal in words (or one of four buttons) becomes a spec, the spec becomes controls the person can change, the
// run follows the optimizer block by block on the stage, and the result is either kept as a new version of the project or thrown away.
//
//   idle -> planning -> ready -> running -> result -> saving -> saved        a goal typed in words is read by Muse Spark first (planning);
//        \-----------> ready                                                  a button fills the controls at once, no network
//   ready/result -> idle (Discard)    result -> ready (Try again)    running/saving -> error (Retry / Download / Dismiss)
//
// A saved version is put on the stage at once and presented in the chat. Nothing is saved before "Keep this version": the stage shows the
// run's blocks as a preview (the analysis store's preview slot, owner "optimize") with what changed marked on it (view.diff).
//
// One run at a time (store/workGuard.ts: with a stabilizer run or a block change the second asks the person to finish the first). A run belongs
// to the model it started from and to its project: leaving the project stops it. The optimizer itself is analysis/optimize/runOptimize.ts (a Web
// Worker); it is loaded on first use, like the analysis engine. Pure rules live in optimizeLogic.ts.

import { create } from "zustand";

import type { OptimizeInput } from "@/assignment/analysis/optimize/optimizeAssembly";
import type { OptimizeWireResult } from "@/assignment/analysis/optimize/protocol";
import type { OptimizePrepared, RunOptimizeOptions } from "@/assignment/analysis/optimize/runOptimize";
import type { Effective } from "@/assignment/analysis/optimize/spec";
import type { Metrics } from "@/assignment/analysis/optimize/types";
import { materialOf } from "@/assignment/analysis/materials";
import type { AnalysisDiff, AnalysisResult, AnalysisSettings, AnalysisTransform } from "@/assignment/analysis/types";
import { toast } from "@/assignment/components/ui/sonner";
import { createDerivedModel } from "@/assignment/lib/api";
import { requestOptimizeSpec } from "@/assignment/lib/optimizeApi";
import { CELL_STRIDE, roleIndex, type AssemblyDescriptor } from "@/assignment/shared/assembly";
import type { ModelAsset, OptimizeSpecBody, OptimizeSpecResponse } from "@/assignment/shared/contract";
import type { OptimizeMeta } from "@/assignment/shared/optimizeMeta";
import { repairSpec, presetSpec, cleanGoal, repairContextOfBrief, type Brief, type OptimizationSpec, type PresetKind } from "@/assignment/shared/optimizeSpec";
import { rootOf, versionTitle } from "@/assignment/shared/versionTree";
import { withAccessRetry } from "@/assignment/store/access";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { sameSettings } from "@/assignment/store/analysisLogic";
import { postAssistantNote } from "@/assignment/store/chatNotes";
import {
    EFFORTS,
    baseOf,
    cellOf,
    chipOf,
    describeSpec,
    descriptorOf,
    fitBrief,
    kgPerBlock,
    moveSentence,
    occupancyAt,
    planErrorMessage,
    rowOfRecord,
    sameControls,
    savedMessage,
    type CompareMode,
    type Effort,
    type LiveRow,
    type OptimizeBase,
} from "@/assignment/store/optimizeLogic";
import { uploadErrorMessage } from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { acquireWork, setWorkWaiting, workBusyMessage } from "@/assignment/store/workGuard";

export type OptimizePhase = "idle" | "planning" | "ready" | "running" | "result" | "saving" | "saved" | "error";

/** The last rounds, newest last, for "What it did". */
const RECENT_MOVES = 5;
/** The stage is repainted at most four times a second while the run goes. */
export const PREVIEW_MS = 250;
/** What the person reads when the settings of the Stability tab change under a plan that was made with the old ones. */
export const SETTINGS_CHANGED_NOTICE = "The settings in the Stability tab changed, so the plan was cleared. Choose a goal again.";
/** How long the upload may take before it counts as failed (the file is about 100 KB: only a connection that is gone takes longer). */
export const UPLOAD_TIMEOUT_MS = 30_000;

// ---------- what a test can replace ----------

export interface RunHooks {
    signal: AbortSignal;
    onStart: NonNullable<RunOptimizeOptions["onStart"]>;
    onIteration: NonNullable<RunOptimizeOptions["onIteration"]>;
    onProgress: NonNullable<RunOptimizeOptions["onProgress"]>;
}

export interface OptimizeDeps {
    /** The facts about a version a run would start from (the controls' figures and the brief), on the page's own thread. */
    prepare: (input: { assembly: AssemblyDescriptor; settings: AnalysisSettings; parts: Record<string, number[]> }) => Promise<OptimizePrepared>;
    /** The spec compiler and the engine's constants, loaded with the first plan. */
    engine: () => Promise<Pick<typeof import("@/assignment/analysis/optimize/spec"), "compileSpec">>;
    /** Muse Spark's reading of a goal (POST /llm/optimize-spec). */
    plan: (body: OptimizeSpecBody, signal: AbortSignal) => Promise<OptimizeSpecResponse>;
    /** Runs the optimizer (analysis/optimize/runOptimize.ts); resolves with stop "canceled" when stopped, rejects with an AbortError when it could not stop. */
    run: (input: OptimizeInput, hooks: RunHooks) => Promise<OptimizeWireResult>;
    /** The analysis of a descriptor in the frame of the model on screen, for the stage. */
    analyze: (descriptor: AssemblyDescriptor, settings: AnalysisSettings, transform: AnalysisTransform) => Promise<AnalysisResult>;
    upload: (sourceId: string, glb: Uint8Array) => Promise<ModelAsset>;
    /** The cells of each named part of the model (the part labels), {} when it has none. */
    parts: (model: ModelAsset) => Promise<Record<string, number[]>>;
    /** The optimizer's log inside a saved optimized version's file (what it took out and put in), null when it cannot be read. */
    readLog: (model: Pick<ModelAsset, "glb_url">) => Promise<OptimizeMeta | null>;
    now: () => number;
}

const uploadSignal = (): AbortSignal | undefined =>
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UPLOAD_TIMEOUT_MS) : undefined;

const defaultDeps: OptimizeDeps = {
    prepare: async (input) => (await import("@/assignment/analysis/optimize/runOptimize")).prepareOptimize(input),
    engine: () => import("@/assignment/analysis/optimize/spec"),
    plan: (body, signal) => withAccessRetry(() => requestOptimizeSpec(body, signal)),
    run: async (input, hooks) => (await import("@/assignment/analysis/optimize/runOptimize")).runOptimize(input, hooks),
    analyze: async (descriptor, settings, transform) => {
        const { analyzeAssembly } = await import("@/assignment/analysis/assembly");
        return { ...analyzeAssembly(descriptor, null, settings), transform };
    },
    upload: (sourceId, glb) => createDerivedModel(sourceId, glb, uploadSignal()),
    parts: async (model) => {
        const { cellsByPart, partLabelsFor } = await import("@/assignment/store/partLabels");
        return cellsByPart(await partLabelsFor(model));
    },
    readLog: async (model) => {
        try {
            const response = await fetch(model.glb_url, { credentials: "same-origin" });
            if (!response.ok) return null;
            const { readAssemblyGlb } = await import("@/assignment/shared/assemblyGlb");
            const read = readAssemblyGlb(new Uint8Array(await response.arrayBuffer()));
            return read.ok ? read.optimization : null;
        } catch {
            return null;
        }
    },
    now: () => Date.now(),
};
let deps: OptimizeDeps = defaultDeps;

/** Swap the optimizer, Muse, the part labels or the upload (tests). Called with nothing, puts the real ones back. */
export function setOptimizeDeps(next?: Partial<OptimizeDeps>): void {
    deps = { ...defaultDeps, ...next };
}

// ---------- the session in hand (not state: nothing renders from it) ----------

interface Session {
    modelId: string;
    projectId: string;
    base: OptimizeBase;
    /** The analysis of the version the run starts from (the frame its blocks are drawn in, and "Before"). */
    source: AnalysisResult;
    prepared: OptimizePrepared;
    parts: Record<string, number[]>;
    compile: (spec: OptimizationSpec) => { effective: Effective; warnings: string[] };
    /** Occupancy, role and step of the start, by cell index. */
    occ: Uint8Array;
    role: Uint8Array;
    step: Uint8Array;
    controller: AbortController | null;
    release: (() => void) | null;
    /** The run so far: cells taken out and put in (net), for the stage while it goes. */
    live: Uint8Array;
    removedNow: Set<number>;
    addedNow: Set<number>;
    /** The finished run's analysis for "After" and "Changes", made once. */
    after: AnalysisResult | null;
    previewTimer: ReturnType<typeof setTimeout> | null;
    lastPreviewAt: number;
    previewToken: number;
}
let session: Session | null = null;
let preparing: { key: string; promise: Promise<Session> } | null = null;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const errorText = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback);

interface OptimizeState {
    phase: OptimizePhase;
    /** The version the plan, run or result belongs to, and its project. */
    modelId: string | null;
    projectId: string | null;
    /** Bumped by every start: late answers of an earlier run carry the old number. */
    runId: number;
    /** What is typed in the goal field. */
    goalText: string;
    /** What is recorded with the result: the words, or the label of the button. */
    goalLabel: string | null;
    chip: PresetKind | null;
    spec: OptimizationSpec | null;
    /** The plan as it first arrived (Muse's reading, or the button's), for "Reset". */
    suggestion: OptimizationSpec | null;
    /** What the cleaning changed in Muse's answer, in plain words. */
    planChanges: string[];
    /** What the figures of the start and the compiled spec say: the controls show them. */
    startMetrics: Metrics | null;
    effective: Effective | null;
    warnings: string[];
    brief: Brief | null;
    /** What one block weighs in the run's material, kg (the counters and the chart). */
    kgPer: number;
    effort: Effort;
    /** Asking Muse failed (the controls stay hidden and the buttons work), or the run could not start. */
    notice: string | null;
    /** The facts of the version are being prepared (a button was pressed): buttons wait. */
    preparing: boolean;

    // the run
    /** Stop was pressed and the run has not answered yet (the button says so). */
    stopping: boolean;
    startedAt: number | null;
    history: LiveRow[];
    recent: string[];
    latest: LiveRow | null;
    solves: number;

    // the end
    result: OptimizeWireResult | null;
    compare: CompareMode;
    /** The round the stage shows while the slider is used (null: the end). */
    scrubRound: number | null;
    savedModelId: string | null;
    errorKind: "run" | "save" | null;
    error: string | null;
    endedAt: number | null;
    /** The saved optimized version whose changes are marked on the stage ("Show what changed"), else null. */
    changesOf: string | null;
    changesNote: string | null;
    // the panel
    panelOpen: boolean;

    setGoalText: (text: string) => void;
    /** A button: fills the controls at once. */
    chooseChip: (model: ModelAsset, result: AnalysisResult, chip: PresetKind) => Promise<void>;
    /** The words typed in the goal field, read by Muse Spark. */
    planGoal: (model: ModelAsset, result: AnalysisResult) => Promise<void>;
    /** A control changed. */
    editSpec: (change: (spec: OptimizationSpec) => OptimizationSpec) => void;
    resetSpec: () => void;
    setEffort: (effort: Effort) => void;
    run: () => void;
    /** Stops planning or the run (the run still hands back the best state it had). */
    cancel: () => void;
    /** Drops a plan that is not yet running (the settings it was made with changed): back to the goal field with `notice`. */
    dropPlan: (notice: string) => void;
    keep: () => Promise<void>;
    discard: () => void;
    /** Back to the controls with the same plan. */
    tryAgain: () => void;
    setCompare: (mode: CompareMode) => void;
    scrubTo: (round: number | null) => void;
    /** Mark on the stage what a saved optimized version took out and put in (read from the log inside its file); the same again takes the marks off. */
    toggleChanges: (model: ModelAsset) => Promise<void>;
    /** Light up on the stage the blocks a protection holds (the pointer is on its chip); null puts the stage back. */
    peekProtection: (index: number | null) => void;
    setPanelOpen: (open: boolean) => void;
    /** The user left the project or the workspace. */
    leave: () => void;
}

const INITIAL = {
    phase: "idle" as OptimizePhase,
    modelId: null as string | null,
    projectId: null as string | null,
    goalLabel: null as string | null,
    chip: null as PresetKind | null,
    spec: null as OptimizationSpec | null,
    suggestion: null as OptimizationSpec | null,
    planChanges: [] as string[],
    startMetrics: null as Metrics | null,
    effective: null as Effective | null,
    warnings: [] as string[],
    brief: null as Brief | null,
    kgPer: 2.4,
    notice: null as string | null,
    preparing: false,
    stopping: false,
    startedAt: null as number | null,
    history: [] as LiveRow[],
    recent: [] as string[],
    latest: null as LiveRow | null,
    solves: 0,
    result: null as OptimizeWireResult | null,
    compare: "changes" as CompareMode,
    scrubRound: null as number | null,
    savedModelId: null as string | null,
    errorKind: null as "run" | "save" | null,
    error: null as string | null,
    endedAt: null as number | null,
    changesOf: null as string | null,
    changesNote: null as string | null,
};

// ---------- the stage ----------

/** The blocks lit by a chip under the pointer: taken off again only if the stage still shows exactly them (a pick of the person's stays). */
let peeked: number[] | null = null;

function unpeek(): void {
    if (peeked === null) return;
    const lit = peeked;
    peeked = null;
    const { view } = useAnalysisStore.getState();
    if (view.highlight.length === lit.length && view.highlight.every((v, i) => v === lit[i])) useAnalysisStore.setState({ view: { ...view, highlight: [] } });
}

/** The preview slot and the diff of the view are this store's to set and clear (the slot is shared with the stabilizer, which has its own owner). */
function putPreview(modelId: string, result: AnalysisResult | null): void {
    useAnalysisStore.getState().setPreview(modelId, result, "optimize");
}

function putDiff(diff: AnalysisDiff | null): void {
    const view = useAnalysisStore.getState().view;
    if ((view.diff ?? null) === diff) return;
    useAnalysisStore.setState({ view: { ...view, diff } });
}

/** Only the model the run belongs to has its changes marked: another version's blocks are not these. */
function showDiff(modelId: string, diff: AnalysisDiff | null): void {
    putDiff(useWorkspaceStore.getState().activeModelId === modelId ? diff : null);
}

const cellsOf = (cells: Iterable<number>): Array<[number, number, number]> => [...cells].sort((a, b) => a - b).map(cellOf);

function diffOf(s: Session, dimRest: boolean): AnalysisDiff {
    return { removed: cellsOf(s.removedNow), added: cellsOf(s.addedNow), dimRest };
}

export const useOptimizeStore = create<OptimizeState>()((set, get) => {
    const stale = (runId: number): boolean => get().runId !== runId;

    const unpack = (descriptor: AssemblyDescriptor) => {
        const occ = new Uint8Array(1000);
        const role = new Uint8Array(1000);
        const step = new Uint8Array(1000);
        for (let n = 0; n < descriptor.cells.length; n += CELL_STRIDE) {
            const c = (descriptor.cells[n + 2] * 10 + descriptor.cells[n + 1]) * 10 + descriptor.cells[n];
            occ[c] = 1;
            role[c] = descriptor.cells[n + 3];
            step[c] = descriptor.cells[n + 4];
        }
        return { occ, role, step };
    };

    /** The descriptor of an occupancy: the start's blocks as they were, new ones as reinforcement of the next step. */
    const descriptorAt = (s: Session, occ: Uint8Array): AssemblyDescriptor => {
        let highest = 0;
        for (let c = 0; c < 1000; c++) if (s.occ[c] && s.step[c] > highest) highest = s.step[c];
        return descriptorOf(occ, (c) => (s.occ[c] ? [s.role[c], s.step[c]] : null), roleIndex("reinforcement"), highest + 1);
    };

    /** The version's blocks, figures and brief, made once per version and analysis. */
    const ensureSession = async (model: ModelAsset, result: AnalysisResult): Promise<Session> => {
        const projectId = useWorkspaceStore.getState().activeProjectId;
        if (!projectId) throw new Error("There is no project open.");
        // The analysis on screen is still the one made with the old settings (the tab checks again a moment after a change): a plan from it would be stale.
        if (!sameSettings(useAnalysisStore.getState().settings, result.settings)) throw new Error("The settings in the Stability tab changed and the model is being checked again. Try again in a moment.");
        if (session && session.modelId === model.id && session.source === result) return session;
        const key = model.id;
        if (preparing && preparing.key === key) return preparing.promise;
        const base = baseOf(model, result);
        if (!base) throw new Error("This version has no blocks to start from yet.");
        const promise = (async (): Promise<Session> => {
            const [parts, engine] = await Promise.all([deps.parts(model).catch(() => ({})), deps.engine()]);
            const prepared = await deps.prepare({ assembly: base.descriptor, settings: base.settings, parts });
            const { occ, role, step } = unpack(base.descriptor);
            const next: Session = {
                modelId: model.id,
                projectId,
                base,
                source: result,
                prepared,
                parts,
                compile: (spec) => {
                    const compiled = engine.compileSpec(spec, prepared.context);
                    return { effective: compiled.effective, warnings: compiled.warnings };
                },
                occ,
                role,
                step,
                controller: null,
                release: session?.modelId === model.id ? session.release : null,
                live: occ.slice(),
                removedNow: new Set(),
                addedNow: new Set(),
                after: null,
                previewTimer: null,
                lastPreviewAt: 0,
                previewToken: 0,
            };
            session = next;
            return next;
        })();
        preparing = { key, promise };
        try {
            return await promise;
        } finally {
            if (preparing?.promise === promise) preparing = null;
        }
    };

    const clearStage = (): void => {
        unpeek();
        const s = session;
        if (s) {
            if (s.previewTimer) clearTimeout(s.previewTimer);
            s.previewTimer = null;
            s.previewToken++;
            putPreview(s.modelId, null);
        }
        putDiff(null);
    };

    const releaseWork = (): void => {
        session?.release?.();
        if (session) session.release = null;
    };

    const reset = (): void => {
        const s = session;
        s?.controller?.abort();
        clearStage();
        releaseWork();
        session = null;
        preparing = null;
        set({ ...INITIAL, runId: get().runId + 1, startMetrics: null });
    };

    const applySpec = (spec: OptimizationSpec): { spec: OptimizationSpec; effective: Effective; warnings: string[] } => {
        const s = session as Session;
        const clean = repairSpec(spec, repairContextOfBrief(s.prepared.brief)).spec;
        const compiled = s.compile(clean);
        return { spec: clean, ...compiled };
    };

    const planned = (spec: OptimizationSpec, extra: Partial<OptimizeState>): void => {
        const s = session as Session;
        const applied = applySpec(spec);
        set({
            phase: "ready",
            modelId: s.modelId,
            projectId: s.projectId,
            spec: applied.spec,
            suggestion: applied.spec,
            effective: applied.effective,
            warnings: applied.warnings,
            startMetrics: s.prepared.context.start,
            brief: s.prepared.brief,
            kgPer: kgPerBlock(materialOf(s.base.settings.material)),
            preparing: false,
            notice: null,
            error: null,
            errorKind: null,
            ...extra,
        });
    };

    // ----- the stage while the run goes -----

    const flushPreview = async (runId: number): Promise<void> => {
        const s = session;
        if (!s) return;
        s.previewTimer = null;
        const token = ++s.previewToken;
        s.lastPreviewAt = deps.now();
        try {
            const preview = await deps.analyze(descriptorAt(s, s.live), s.base.settings, s.source.transform);
            if (stale(runId) || session !== s || s.previewToken !== token || get().phase !== "running") return;
            putPreview(s.modelId, preview);
            showDiff(s.modelId, diffOf(s, false));
        } catch {
            // The run is what matters; the stage keeps its last picture.
        }
    };

    const schedulePreview = (runId: number): void => {
        const s = session;
        if (!s || s.previewTimer) return;
        const wait = Math.max(0, s.lastPreviewAt + PREVIEW_MS - deps.now());
        s.previewTimer = setTimeout(() => void flushPreview(runId), wait);
    };

    // ----- the end of a run -----

    /** Puts the stage in the mode the result card asks for. */
    const showCompare = async (mode: CompareMode, round: number | null): Promise<void> => {
        const s = session;
        const wire = get().result;
        if (!s || !wire) return;
        const runId = get().runId;
        if (round !== null) {
            const occ = occupancyAt(s.occ, wire.result, round);
            const removed = new Set<number>();
            const added = new Set<number>();
            for (let c = 0; c < 1000; c++) {
                if (s.occ[c] && !occ[c]) removed.add(c);
                if (!s.occ[c] && occ[c]) added.add(c);
            }
            try {
                const preview = await deps.analyze(descriptorAt(s, occ), s.base.settings, s.source.transform);
                if (stale(runId) || session !== s || get().scrubRound !== round) return;
                putPreview(s.modelId, preview);
                showDiff(s.modelId, { removed: cellsOf(removed), added: cellsOf(added), dimRest: false });
            } catch {
                // keep the last picture
            }
            return;
        }
        if (mode === "before") {
            putPreview(s.modelId, null);
            putDiff(null);
            return;
        }
        try {
            s.after ??= await deps.analyze(wire.descriptor, s.base.settings, s.source.transform);
            if (stale(runId) || session !== s || get().compare !== mode || get().scrubRound !== null) return;
            putPreview(s.modelId, s.after);
            const removed = wire.meta.removed;
            const added: number[] = [];
            if (wire.meta.step > 0) {
                for (let n = 0; n < wire.descriptor.cells.length; n += CELL_STRIDE) {
                    if (wire.descriptor.cells[n + 4] === wire.meta.step) added.push((wire.descriptor.cells[n + 2] * 10 + wire.descriptor.cells[n + 1]) * 10 + wire.descriptor.cells[n]);
                }
            }
            showDiff(s.modelId, mode === "changes" ? { removed: cellsOf(removed), added: cellsOf(added), dimRest: true } : null);
        } catch {
            // keep the last picture
        }
    };

    const finish = async (runId: number, wire: OptimizeWireResult): Promise<void> => {
        const s = session;
        if (!s || stale(runId)) return;
        if (s.previewTimer) clearTimeout(s.previewTimer);
        s.previewTimer = null;
        s.previewToken++;
        const keepable = wire.changed && wire.meta.feasible;
        set({ phase: "result", result: wire, compare: keepable ? "changes" : "before", scrubRound: null, endedAt: deps.now(), error: null, errorKind: null, stopping: false });
        if (keepable) {
            // The guard stays held while the result waits: nothing else may start from this version meanwhile (the tab shows a dot).
            setWorkWaiting("optimize", true);
            await showCompare("changes", null);
        } else {
            // Nothing to decide: the stage goes back to the version and the guard is free.
            putPreview(s.modelId, null);
            putDiff(null);
            releaseWork();
        }
    };

    const startRun = async (runId: number): Promise<void> => {
        const s = session;
        const state = get();
        if (!s || !state.spec || !s.controller || !state.goalLabel) return;
        const input: OptimizeInput = {
            assembly: s.base.descriptor,
            settings: s.base.settings,
            spec: state.spec,
            goal: state.goalLabel,
            source: s.base.source,
            parts: s.parts,
            stabilizedDepth: s.base.stabilizedDepth,
            timeBudgetMs: EFFORTS[state.effort].timeBudgetMs,
        };
        try {
            const wire = await deps.run(input, {
                signal: s.controller.signal,
                onStart: (event) => {
                    if (stale(runId)) return;
                    const row: LiveRow = { iteration: 0, blocks: event.start.blocks, util: event.start.maxUtil, margin: event.start.cogMarginMm, deflection: event.start.maxDeflectionMm };
                    set({ startMetrics: event.start, effective: event.effective, warnings: event.warnings, history: [row], latest: row });
                },
                onIteration: (event) => {
                    if (stale(runId) || session !== s) return;
                    for (const c of event.removedCells) {
                        s.live[c] = 0;
                        if (s.addedNow.has(c)) s.addedNow.delete(c);
                        else s.removedNow.add(c);
                    }
                    for (const c of event.addedCells) {
                        s.live[c] = 1;
                        if (s.removedNow.has(c)) s.removedNow.delete(c);
                        else s.addedNow.add(c);
                    }
                    const row = rowOfRecord(event.record);
                    set((now) => ({
                        history: [...now.history, row],
                        latest: row,
                        solves: event.record.solves,
                        recent: [...now.recent, moveSentence(event.record)].slice(-RECENT_MOVES),
                    }));
                    schedulePreview(runId);
                },
                onProgress: (event) => {
                    if (stale(runId)) return;
                    set({ solves: event.solves });
                },
            });
            await finish(runId, wire);
        } catch (error) {
            if (stale(runId)) return;
            if (isAbort(error)) {
                // The worker did not answer a Stop in time and was ended: nothing was kept.
                clearStage();
                releaseWork();
                set({ phase: "ready", notice: "Stopped. Nothing was kept.", stopping: false });
                return;
            }
            clearStage();
            releaseWork();
            set({ phase: "error", errorKind: "run", error: errorText(error, "The optimization failed."), endedAt: deps.now(), stopping: false });
        }
    };

    return {
        ...INITIAL,
        runId: 0,
        goalText: "",
        effort: "quick" as Effort,
        panelOpen: true,

        setGoalText: (goalText) => set({ goalText: goalText.slice(0, 2000) }),

        chooseChip: async (model, result, chip) => {
            if (get().phase === "saved") reset();
            const s = get();
            if (s.phase !== "idle" && s.phase !== "ready") return;
            const runId = get().runId;
            set({ preparing: true, notice: null });
            try {
                const next = await ensureSession(model, result);
                if (stale(runId)) return;
                const label = chipOf(chip).label;
                session = next;
                // The button's name is the plan's name (the saved version is "v4 · Strongest", not the preset's own title).
                planned({ ...presetSpec(chip, { blocks: next.prepared.context.start.blocks }), title: label }, { goalLabel: label, chip, planChanges: [], goalText: label });
            } catch (error) {
                if (stale(runId)) return;
                set({ preparing: false, notice: errorText(error, "Could not read this version.") });
            }
        },

        planGoal: async (model, result) => {
            if (get().phase === "saved") reset();
            const s = get();
            if (s.phase !== "idle" && s.phase !== "ready") return;
            const goal = cleanGoal(s.goalText);
            if (!goal) return;
            const runId = s.runId + 1;
            const controller = new AbortController();
            // The reading belongs to this version from now on: the panel shows it only for the version it is about.
            set({ runId, phase: "planning", modelId: model.id, projectId: useWorkspaceStore.getState().activeProjectId, notice: null, preparing: false });
            let next: Session;
            try {
                next = await ensureSession(model, result);
            } catch (error) {
                // Reading the version failed, not Muse: the message says what is wrong with the version.
                if (stale(runId)) return;
                set({ phase: "idle", modelId: null, projectId: null, notice: errorText(error, "Could not read this version.") });
                return;
            }
            try {
                if (stale(runId)) return;
                next.controller = controller;
                const answer = await deps.plan({ goal, brief: fitBrief(next.prepared.brief, goal) }, controller.signal);
                if (stale(runId) || controller.signal.aborted) return;
                next.controller = null;
                planned(answer.spec, { goalLabel: goal, chip: null, planChanges: answer.changes });
            } catch (error) {
                if (stale(runId) || controller.signal.aborted || isAbort(error)) return;
                if (session) session.controller = null;
                set({ phase: "idle", modelId: null, projectId: null, notice: planErrorMessage(error) });
            }
        },

        editSpec: (change) => {
            const s = get();
            if (!session || !s.spec || s.phase !== "ready") return;
            unpeek();
            // Changing a control is choosing a goal: a plan Muse found nothing to do for becomes one the person has taken over.
            const applied = applySpec({ ...change(s.spec), actionable: true });
            // The title (the saved version's name) and the sentence under the goal follow the controls; back at the plan as it came, they are its own again.
            const named = s.suggestion && sameControls(applied.spec, s.suggestion) ? { title: s.suggestion.title, summary: s.suggestion.summary } : describeSpec(applied.spec);
            set({ spec: { ...applied.spec, ...named }, effective: applied.effective, warnings: applied.warnings });
        },

        resetSpec: () => {
            const s = get();
            if (!session || !s.suggestion) return;
            const applied = applySpec(s.suggestion);
            set({ spec: applied.spec, effective: applied.effective, warnings: applied.warnings });
        },

        setEffort: (effort) => set({ effort }),

        run: () => {
            const s = get();
            const sess = session;
            if (s.phase !== "ready" || !sess || !s.spec || !s.spec.actionable || !s.goalLabel) return;
            // The plan was made with the settings of the Stability tab as they were; a run with other ones would be judged by that tab differently.
            if (!sameSettings(useAnalysisStore.getState().settings, sess.base.settings)) {
                get().dropPlan(SETTINGS_CHANGED_NOTICE);
                return;
            }
            unpeek();
            const busy = workBusyMessage("optimize", sess.projectId);
            const release = busy ? null : acquireWork("optimize", sess.projectId, { label: "Optimizing", stop: () => get().cancel() });
            if (!release) {
                set({ notice: busy ?? "Wait for the change to finish first." });
                return;
            }
            sess.release = release;
            const runId = s.runId + 1;
            sess.controller = new AbortController();
            sess.live = sess.occ.slice();
            sess.removedNow = new Set();
            sess.addedNow = new Set();
            sess.after = null;
            sess.lastPreviewAt = 0;
            // On a phone the panel is open over the stage: the run is watched on the stage, the panel keeps the strip.
            set({
                runId,
                phase: "running",
                notice: null,
                stopping: false,
                startedAt: deps.now(),
                history: [],
                recent: [],
                latest: null,
                solves: 0,
                result: null,
                scrubRound: null,
                error: null,
                errorKind: null,
                endedAt: null,
            });
            void startRun(runId);
        },

        cancel: () => {
            const s = get();
            const sess = session;
            if (s.phase === "planning") {
                sess?.controller?.abort();
                set({ phase: "idle", modelId: null, projectId: null, runId: s.runId + 1 });
            } else if (s.phase === "running" && sess?.controller) {
                // The optimizer hands back the best state it had (stop "canceled"); the card then offers to keep it. Until it does the button says so.
                set({ stopping: true });
                sess.controller.abort();
            }
        },

        dropPlan: (notice) => {
            const { phase } = get();
            if (phase !== "ready" && phase !== "planning") return;
            reset();
            set({ notice });
        },

        keep: async () => {
            const s = get();
            const sess = session;
            const wire = s.result;
            if (!sess || !wire || (s.phase !== "result" && !(s.phase === "error" && s.errorKind === "save"))) return;
            if (!wire.changed || !wire.meta.feasible) return;
            const runId = s.runId;
            const { modelId, projectId } = sess;
            set({ phase: "saving", errorKind: null, error: null });
            try {
                const model = await deps.upload(modelId, wire.glb);
                if (stale(runId)) return;
                const workspace = useWorkspaceStore.getState();
                if (workspace.activeProjectId !== projectId) {
                    // The server has it; this screen is another project's.
                    toast.info("Saved an optimized version", { description: "It is in the project you left." });
                    reset();
                    return;
                }
                workspace.addModel(model);
                // The new version goes on the stage unless the person has gone to another model in the meantime.
                const now = useWorkspaceStore.getState();
                const active = now.models.find((m) => m.id === now.activeModelId);
                const here = active ? rootOf(now.models, active) : null;
                const family = rootOf(now.models, model);
                const switched = active === undefined || (here !== null && family !== null && here.id === family.id);
                if (switched) workspace.setActiveModel(model.id);
                const summary = model.optimization;
                const name = versionTitle(useWorkspaceStore.getState().models, model);
                postAssistantNote(projectId, summary ? savedMessage(summary, name) : `Optimized ${name}.`, { modelIds: [model.id] });
                if (switched) toast.success("Switched to the optimized version");
                else toast.success("Saved an optimized version", { description: "Find it in the Models tab." });
                clearStage();
                releaseWork();
                set({ phase: "saved", savedModelId: model.id, endedAt: deps.now() });
            } catch (error) {
                if (stale(runId)) return;
                set({ phase: "error", errorKind: "save", error: uploadErrorMessage(error), endedAt: deps.now() });
                toast.error("Could not save the optimized version");
            }
        },

        discard: () => {
            const { phase } = get();
            if (phase === "running" || phase === "saving" || phase === "planning") return;
            reset();
        },

        tryAgain: () => {
            const s = get();
            if (!session || !s.spec || (s.phase !== "result" && s.phase !== "error" && s.phase !== "saved")) return;
            if (s.phase === "saved") {
                reset();
                return;
            }
            clearStage();
            releaseWork();
            set({ phase: "ready", result: null, error: null, errorKind: null, scrubRound: null, history: [], recent: [], latest: null, stopping: false });
        },

        setCompare: (compare) => {
            if (get().phase !== "result") return;
            set({ compare, scrubRound: null });
            void showCompare(compare, null);
        },

        scrubTo: (round) => {
            const s = get();
            if (s.phase !== "result") return;
            set({ scrubRound: round });
            void showCompare(s.compare, round);
        },

        toggleChanges: async (model) => {
            if (get().changesOf === model.id) {
                putDiff(null);
                set({ changesOf: null, changesNote: null });
                return;
            }
            if (model.kind !== "optimized") return;
            set({ changesOf: model.id, changesNote: null });
            const log = await deps.readLog(model);
            // The person may have gone elsewhere, or pressed it again, while the file was read.
            if (get().changesOf !== model.id) return;
            if (!log) {
                set({ changesOf: null, changesNote: "The log inside this version's file could not be read." });
                return;
            }
            const removed = log.removed;
            const added: number[] = [];
            // The blocks it put in are the ones of its own step; they are in the file, the removed ones are only in the log.
            const analysis = useAnalysisStore.getState();
            const stage = analysis.resultModelId === model.id ? analysis.result : null;
            if (stage && log.step > 0) stage.blocks.forEach((b) => b.step === log.step && added.push((b.cell[2] * 10 + b.cell[1]) * 10 + b.cell[0]));
            showDiff(model.id, { removed: cellsOf(removed), added: cellsOf(added), dimRest: true });
        },

        peekProtection: (index) => {
            unpeek();
            const s = get();
            const sess = session;
            if (index === null || !sess || s.phase !== "ready" || !s.spec) return;
            const region = s.spec.protected[index];
            if (!region) return;
            const view = useAnalysisStore.getState().view;
            // The person's own pick stays; a hover does not replace it.
            if (view.highlight.length > 0) return;
            const mask = region.part !== null ? sess.prepared.context.parts[region.part] : null;
            const box = region.box;
            const lit: number[] = [];
            sess.source.blocks.forEach((b, i) => {
                const [x, y, z] = b.cell;
                const inside = mask ? mask[(z * 10 + y) * 10 + x] === 1 : box ? x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2] : false;
                if (inside) lit.push(i);
            });
            if (lit.length === 0) return;
            peeked = lit;
            useAnalysisStore.setState({ view: { ...view, highlight: lit } });
        },

        setPanelOpen: (panelOpen) => set({ panelOpen }),

        leave: () => {
            const { phase } = get();
            // An upload that is under way finishes (and is shown only if its project is still open).
            if (phase === "saving" || (phase === "idle" && !session)) return;
            reset();
        },
    };
});

// The settings of the Stability tab (material, overhang limit, block budget) are the ground a plan stands on: a plan made with the old ones is
// dropped, not run, so the card and the Stability tab never disagree about the same version. (A run under way keeps the settings it started with.)
useAnalysisStore.subscribe((state, prev) => {
    if (state.settings === prev.settings || sameSettings(state.settings, prev.settings)) return;
    useOptimizeStore.getState().dropPlan(SETTINGS_CHANGED_NOTICE);
});

// A run belongs to its project: opening another one (or a new chat) stops it. A model that is not the run's has no marks of its changes.
useWorkspaceStore.subscribe((state, prev) => {
    const store = useOptimizeStore.getState();
    if (state.activeProjectId !== prev.activeProjectId) {
        store.leave();
        return;
    }
    // The marks of a saved version's changes are for that version only.
    if (state.activeModelId !== prev.activeModelId && store.changesOf !== null && store.changesOf !== state.activeModelId) {
        putDiff(null);
        useOptimizeStore.setState({ changesOf: null, changesNote: null });
    }
    if (state.activeModelId !== prev.activeModelId && session) {
        const mine = state.activeModelId === session.modelId;
        // A plan made for one version is not a plan for another.
        if (!mine && (store.phase === "idle" || store.phase === "planning" || store.phase === "ready")) {
            store.leave();
            return;
        }
        // The marks of a result belong to its version: off while another is on screen, back when it returns.
        if (store.phase === "result" || store.phase === "running") {
            if (mine) {
                useOptimizeStore.getState().setCompare(store.compare);
            } else putDiff(null);
        }
    }
    // The version the "Saved" card is about was deleted (the Models tab): it would offer to open what is gone.
    if (state.models !== prev.models && store.phase === "saved" && store.savedModelId && !state.models.some((m) => m.id === store.savedModelId)) store.discard();
});

/** What a test needs to put the module back to nothing. */
export function resetOptimizeStore(): void {
    session?.controller?.abort();
    if (session?.previewTimer) clearTimeout(session.previewTimer);
    session?.release?.();
    session = null;
    preparing = null;
    useOptimizeStore.setState({ ...INITIAL, runId: useOptimizeStore.getState().runId + 1, goalText: "", effort: "quick", panelOpen: true });
}
