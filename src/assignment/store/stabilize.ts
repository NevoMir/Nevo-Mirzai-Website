// The Stabilize run: start it for the model in the analysis, follow it step by step (the log and a live preview on the
// stage), and either save the result as a new model of the project or throw it away.
//
//   idle -> running -> finished -> saving -> saved          a run that reached its goal is saved at once
//                  \-> canceled -> saving -> saved          Stop keeps what was added so far; it can still be saved
//                  \-> finished (a partial result waits for Save / Discard)
//   saving -> error (the upload failed: Retry, or Download GLB anyway)      running -> error (the run failed)
//
// A saved version is put on the stage at once (the tab stays where it is), painted by what was added (the Added blocks colouring, so
// the supports stand out), with the toast "Switched to the stabilized version": the top bar's Original | Stabilized switch then goes
// back and forth. The one block budget is the analysis settings' (optionsFor).
//
// One run at a time. A run belongs to the project it started in: leaving that project (or the workspace) stops it, and
// a save that finishes after the user moved on is not put on the screen of whatever project is open by then (the server
// has the model either way). The stabilizer itself is analysis/stabilize/runStabilize.ts (a Web Worker); it is loaded
// on first use, like the analysis engine. Pure rules live in stabilizeLogic.ts.

import { create } from "zustand";

import type { ProgressEvent, StepEvent } from "@/assignment/analysis/stabilize/runStabilize";
import type { StabilizeInput, StabilizeOptions, StabilizeResult } from "@/assignment/analysis/stabilize/types";
import type { AnalysisResult } from "@/assignment/analysis/types";
import { toast } from "@/assignment/components/ui/sonner";
import { createDerivedModel } from "@/assignment/lib/api";
import { CELL_STRIDE } from "@/assignment/shared/assembly";
import { BLOCK_ROLES, type AddedRole, type ModelAsset, type StabilizeStepLog, type StepMetrics } from "@/assignment/shared/contract";
import { stabilizationsOfModel } from "@/assignment/shared/versionTree";
import { useAnalysisStore } from "@/assignment/store/analysis";
import {
    DEFAULT_CHOICES,
    metricsOf,
    optionsFor,
    buildStoppedResult,
    outcomeOf,
    previewDescriptor,
    sanitizeChoices,
    savedMessage,
    stepOffsetOf,
    uploadErrorMessage,
    type RunMove,
    type RunStatus,
    type StabilizeChoices,
    type StabilizeProgress,
    type StoppedRun,
} from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { rootOf } from "@/assignment/store/versions";
import { acquireWork, WORK_CHIP_WORDS, workBusyMessage } from "@/assignment/store/workGuard";

export type StabilizeStatus = RunStatus;

interface StabilizeState {
    status: StabilizeStatus;
    /** The model the run started from and the project it was in. */
    sourceModelId: string | null;
    projectId: string | null;
    sourcePrompt: string;
    /** Bumped by every start: late answers of an earlier run carry the old number. */
    runId: number;
    /** The log so far (the final one once the run is over). */
    steps: StabilizeStepLog[];
    /** The moves so far, with the cells each added: what a stopped run is rebuilt from. */
    moves: RunMove[];
    progress: StabilizeProgress | null;
    /** The stabilizer's answer (or, for a stopped run, what was made of its moves when the user saved). */
    result: StabilizeResult | null;
    /**
     * The assembly as it stands, drawn on the stage in role colours while it is for the model on screen. The same object
     * is in the analysis store (which colours and picks against it).
     */
    preview: AnalysisResult | null;
    /** What went wrong when status is "error": the run itself, or the upload (then `result` is still there). */
    errorKind: "run" | "save" | null;
    error: string | null;
    /** The version that was saved. */
    savedModelId: string | null;
    /**
     * When the run (or its save) last came to an end that the user should see: finished, stopped, failed or saved. The banner
     * takes the keyboard focus if this is fresh when it appears, so a keyboard user is not left on a button that is gone.
     * A saved version that is switched to has no analysis yet, so its row appears only when that lands (a fetch of its file and a
     * run): the stamp is renewed then, so the window counts from the row's appearance, not from the save.
     */
    endedAt: number | null;
    /** The analysis of the source when the run started, for the "problems a -> b" chips. */
    startMetrics: StepMetrics | null;
    options: StabilizeOptions | null;
    /** What the stabilizer is asked besides the analysis settings (the strength it aims under). */
    choices: StabilizeChoices;

    setChoices: (patch: Partial<StabilizeChoices>) => void;
    /** Start a run on `result`, the analysis of `model`. False when one is already going or there is nothing to do. */
    start: (model: ModelAsset, result: AnalysisResult) => boolean;
    /** Stop. What was added so far is kept (Save partial / Discard); a run with no step yet just ends. */
    cancel: () => void;
    /** Upload the result as a new model of the project (and, for a stopped run, write it first). Also the retry. */
    save: () => Promise<void>;
    /** Drop the result and the preview (not while running or saving). */
    discard: () => void;
    /** A timeline click: the blocks of step `n` on the stage, the camera at its place. The same step again clears. */
    selectStep: (n: number | null) => void;
    /** The user left the project or the workspace. */
    leave: () => void;
}

// ---------- what a test can replace ----------

export interface StabilizeDeps {
    /** Runs the stabilizer (analysis/stabilize/runStabilize.ts); rejects with an AbortError when `signal` aborts. */
    run: (input: StabilizeInput, hooks: { sourceDepth: number; signal: AbortSignal; onStep: (event: StepEvent) => void; onProgress: (event: ProgressEvent) => void }) => Promise<StabilizeResult>;
    /** The result for a run that was stopped, made from the moves it had reported. */
    finishStopped: (run: StoppedRun) => Promise<StabilizeResult>;
    upload: (sourceId: string, glb: Uint8Array) => Promise<ModelAsset>;
    now: () => number;
}

/**
 * How long the upload may take before it counts as failed. The file is about 100 KB, so only a connection that is gone
 * takes longer; the card then offers Retry and Download instead of waiting for ever (the server stores the same
 * assembly once, so a retry after a request that did get through returns the model it made).
 */
export const UPLOAD_TIMEOUT_MS = 30_000;

const uploadSignal = (): AbortSignal | undefined =>
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(UPLOAD_TIMEOUT_MS) : undefined;

const defaultDeps: StabilizeDeps = {
    run: async (input, hooks) => {
        const { runStabilize } = await import("@/assignment/analysis/stabilize/runStabilize");
        return runStabilize(input, hooks);
    },
    finishStopped: (run) => buildStoppedResult(run),
    upload: (sourceId, glb) => createDerivedModel(sourceId, glb, uploadSignal()),
    now: () => Date.now(),
};
let deps: StabilizeDeps = defaultDeps;

/** Swap the stabilizer or the upload (tests). Called with nothing, puts the real ones back. */
export function setStabilizeDeps(next?: Partial<StabilizeDeps>): void {
    deps = { ...defaultDeps, ...next };
}

// ---------- the run in flight (not state: nothing renders from it) ----------

interface RunContext {
    source: AnalysisResult;
    input: StabilizeInput;
    sourceDepth: number;
    controller: AbortController;
    startedAt: number;
    /** How long it had run when Stop was pressed (a stopped run is written with this). */
    stoppedAfterMs: number;
}
let ctx: RunContext | null = null;
let counter = 0;
/** Gives the work guard back (store/workGuard.ts): the run holds it from its start until it is saved, thrown away or has failed. */
let releaseWork: (() => void) | null = null;
const giveBackWork = (): void => {
    releaseWork?.();
    releaseWork = null;
};
/**
 * The saved version the run switched to while its analysis has not landed: when it does, `endedAt` is renewed (see the field).
 * Not state: nothing renders from it.
 */
let awaitingAnalysisOf: string | null = null;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** The assembly engine, loaded on first use. */
const engine = () => import("@/assignment/analysis/assembly");

/** The assembly of the run so far, analysed in the frame of the model on screen so it lines up with its mesh. */
async function previewOf(c: RunContext, moves: readonly RunMove[]): Promise<AnalysisResult> {
    const { analyzeAssembly } = await engine();
    return { ...analyzeAssembly(previewDescriptor(c.source, moves), null, c.source.settings), transform: c.source.transform };
}

const ROLE_WORD = { column: "column", footing: "footing", bracket: "bracket", bridge: "bridge", reinforcement: "reinforcement" } as const;

const INITIAL = {
    status: "idle" as StabilizeStatus,
    sourceModelId: null,
    projectId: null,
    sourcePrompt: "",
    steps: [] as StabilizeStepLog[],
    moves: [] as RunMove[],
    progress: null,
    result: null,
    preview: null,
    errorKind: null,
    error: null,
    savedModelId: null,
    endedAt: null,
    startMetrics: null,
    options: null,
};

export const useStabilizeStore = create<StabilizeState>()((set, get) => {
    /** A run that was replaced, stopped or left must not touch the state any more. */
    const stale = (runId: number): boolean => get().runId !== runId || get().status !== "running";

    /** Puts the assembly as it stands on the stage (and in the state). A failure to draw it must not stop the run. */
    const showPreview = async (runId: number, moves: readonly RunMove[]): Promise<void> => {
        const c = ctx;
        if (!c) return;
        try {
            const preview = await previewOf(c, moves);
            if (get().runId !== runId || ctx !== c) return;
            const { sourceModelId } = get();
            if (!sourceModelId) return;
            set({ preview });
            useAnalysisStore.getState().setPreview(sourceModelId, preview, "stabilize");
        } catch {
            // The log is what matters; the stage keeps its last picture.
        }
    };

    const clearPreview = (): void => {
        const { sourceModelId, preview } = get();
        if (preview && sourceModelId) useAnalysisStore.getState().setPreview(sourceModelId, null, "stabilize");
        set({ preview: null });
    };

    const reset = (): void => {
        ctx?.controller.abort();
        ctx = null;
        giveBackWork();
        awaitingAnalysisOf = null;
        clearPreview();
        set({ ...INITIAL });
    };

    const onProgress = (runId: number, event: ProgressEvent): void => {
        if (stale(runId)) return;
        set({
            progress: {
                candidatesDone: event.candidatesDone,
                candidatesTotal: event.candidatesTotal,
                steps: event.steps,
                blocks: event.blocks,
                elapsedMs: event.elapsedMs,
            },
        });
    };

    const onStep = (runId: number, event: StepEvent): void => {
        if (stale(runId)) return;
        const { steps, moves } = get();
        // The log is gap-free by contract; a step out of order would make the numbers on the blocks lie.
        if (event.step.n !== steps.length + 1) return;
        const next = [...moves, { step: event.step, cells: event.cells, roles: event.roles }];
        set({ steps: [...steps, event.step], moves: next, progress: null });
        void showPreview(runId, next);
    };

    const finish = async (runId: number, result: StabilizeResult): Promise<void> => {
        const c = ctx;
        if (!c || stale(runId)) return;
        // The log and the moves of the finished run (the search may have tidied earlier moves away: what it returns is final).
        const moves = result.meta.steps.map((step): RunMove => {
            const cells: Array<[number, number, number]> = [];
            const roles: RunMove["roles"] = [];
            const { cells: flat } = result.descriptor;
            for (let n = 0; n < flat.length; n += CELL_STRIDE) {
                if (flat[n + 4] === stepOffsetOf(c.source) + step.n) {
                    cells.push([flat[n], flat[n + 1], flat[n + 2]]);
                    roles.push(BLOCK_ROLES[flat[n + 3]] as AddedRole);
                }
            }
            return { step, cells, roles };
        });
        set({ status: "finished", result, steps: result.meta.steps, moves, progress: null, endedAt: deps.now() });
        await showPreview(runId, moves);
        // Reached its goal: nothing to decide, it is saved. Anything less waits for the user.
        if (get().runId === runId && get().status === "finished" && outcomeOf(result) === "complete") void get().save();
    };

    const drive = async (runId: number): Promise<void> => {
        const c = ctx;
        if (!c) return;
        try {
            // The first picture is the model itself in role colours, so the stage switches before the first step lands.
            await showPreview(runId, []);
            if (stale(runId)) return;
            const result = await deps.run(c.input, {
                sourceDepth: c.sourceDepth,
                signal: c.controller.signal,
                onStep: (event) => onStep(runId, event),
                onProgress: (event) => onProgress(runId, event),
            });
            await finish(runId, result);
        } catch (error) {
            if (stale(runId) || isAbort(error)) return;
            // A run that failed has nothing to decide: the work is over.
            giveBackWork();
            set({
                status: "error",
                errorKind: "run",
                error: error instanceof Error && error.message ? error.message : "Stabilizing failed.",
                progress: null,
                endedAt: deps.now(),
            });
        }
    };

    return {
        ...INITIAL,
        runId: 0,
        choices: DEFAULT_CHOICES,

        setChoices: (patch) => set((s) => ({ choices: sanitizeChoices({ ...s.choices, ...patch }) })),

        start: (model, result) => {
            const s = get();
            if (s.status === "running" || s.status === "saving") return false;
            const projectId = useWorkspaceStore.getState().activeProjectId;
            if (!projectId || result.stats.blockCount === 0) return false;
            // Another piece of work (a block edit, an optimizer run) is going: only one at a time.
            if (workBusyMessage("stabilize", projectId) !== null) return false;
            // Whatever an earlier run left on the screen goes.
            reset();
            releaseWork = acquireWork("stabilize", projectId, { label: WORK_CHIP_WORDS.stabilize, stop: () => get().cancel() });
            if (!releaseWork) return false;
            // On a phone the report is a sheet over an 80% black overlay: fold it away, so the stage with the growing
            // preview is what the run shows (the summary pill carries Stop, and the sheet comes back when a decision waits).
            useAnalysisStore.getState().setSheetOpen(false);
            const runId = ++counter;
            const options = optionsFor(get().choices, result.settings);
            const controller = new AbortController();
            ctx = {
                source: result,
                input: {
                    cells: result.blocks.map((b): [number, number, number] => [b.cell[0], b.cell[1], b.cell[2]]),
                    settings: result.settings,
                    options,
                    // A stabilized model keeps the role and step of its blocks when it is stabilized again.
                    assembly: result.assembly ? result.assembly.descriptor : null,
                },
                // The stabilizations on the way from the original to this version (edits and optimizations carry the count along).
                sourceDepth: stabilizationsOfModel(model),
                controller,
                startedAt: deps.now(),
                stoppedAfterMs: 0,
            };
            const { blocks, errors, floating_blocks, over_limit, longest_cantilever, cog_margin_mm, max_utilisation } = metricsOf(result, options.targetUtilisation);
            set({
                status: "running",
                sourceModelId: model.id,
                projectId,
                sourcePrompt: model.prompt,
                runId,
                options,
                startMetrics: { blocks, errors, floating_blocks, over_limit, longest_cantilever, cog_margin_mm, max_utilisation },
            });
            void drive(runId);
            return true;
        },

        cancel: () => {
            const c = ctx;
            if (get().status !== "running" || !c) return;
            c.stoppedAfterMs = deps.now() - c.startedAt;
            c.controller.abort();
            // Nothing added: there is nothing to keep, so the card is simply back.
            if (get().moves.length === 0) reset();
            else set({ status: "canceled", progress: null, endedAt: deps.now() });
        },

        save: async () => {
            const s = get();
            const c = ctx;
            if (!c || !s.sourceModelId || !s.projectId) return;
            if (s.status !== "finished" && s.status !== "canceled" && !(s.status === "error" && s.errorKind === "save")) return;
            if (s.moves.length === 0 && !s.result) return;
            const runId = s.runId;
            const { sourceModelId, projectId, sourcePrompt } = s;
            set({ status: "saving", errorKind: null, error: null });
            try {
                let result = s.result;
                if (!result) {
                    // A stopped run: the stabilizer is gone, what it reported is made into the version (two solves).
                    result = await deps.finishStopped({
                        source: c.source,
                        moves: s.moves,
                        sourceDepth: c.sourceDepth,
                        options: c.input.options,
                        elapsedMs: c.stoppedAfterMs,
                    });
                    if (get().runId !== runId) return;
                    set({ result });
                }
                const model = await deps.upload(sourceModelId, result.glb);
                if (get().runId !== runId) return;
                const workspace = useWorkspaceStore.getState();
                if (workspace.activeProjectId !== projectId) {
                    // The server has it; this screen is another project's.
                    toast.info("Saved a stabilized version", { description: "It is in the project you left." });
                    reset();
                    return;
                }
                workspace.addModel(model);
                // The new version goes on the stage, in the tab the user is in -- unless they have moved to another model in the
                // meantime (the run belongs to the family it started from; do not pull them away from what they chose to look at).
                const now = useWorkspaceStore.getState();
                const active = now.models.find((m) => m.id === now.activeModelId);
                const here = active ? rootOf(now.models, active) : null;
                const family = rootOf(now.models, model);
                const switched = active === undefined || (here !== null && family !== null && here.id === family.id);
                if (switched) {
                    workspace.setActiveModel(model.id);
                    // The preview painted the added blocks by role; the version that replaces it keeps that colouring (the user can pick
                    // another from the stage's Colour menu), so the supports do not turn into blocks that look like the original's the
                    // moment the toast says the new version is shown. A model with no added blocks is drawn by status until it has some.
                    useAnalysisStore.getState().setColorBy("role");
                    if (useAnalysisStore.getState().resultModelId !== model.id) awaitingAnalysisOf = model.id;
                }
                // The same assembly saved twice comes back as the same model, which the chat already presents.
                if (!workspace.messages.some((m) => m.model_ids?.includes(model.id))) {
                    workspace.addMessage({
                        id: crypto.randomUUID(),
                        role: "assistant",
                        content: savedMessage(sourcePrompt, result.meta),
                        timestamp: new Date(deps.now()).toISOString(),
                        model_ids: [model.id],
                    });
                }
                if (switched) toast.success("Switched to the stabilized version");
                else toast.success("Saved a stabilized version", { description: "Find it in the Models tab." });
                clearPreview();
                giveBackWork();
                set({ status: "saved", savedModelId: model.id, endedAt: deps.now() });
            } catch (error) {
                if (get().runId !== runId) return;
                set({ status: "error", errorKind: "save", error: uploadErrorMessage(error), endedAt: deps.now() });
                toast.error("Could not save the stabilized version");
            }
        },

        discard: () => {
            const { status } = get();
            if (status === "running" || status === "saving") return;
            reset();
        },

        selectStep: (n) => {
            const analysis = useAnalysisStore.getState();
            const step = n === null ? undefined : get().steps.find((x) => x.n === n);
            if (n === null || !step || !ctx) {
                analysis.clearSelection();
                return;
            }
            const absolute = stepOffsetOf(ctx.source) + n;
            if (analysis.stepSelection === absolute) analysis.clearSelection();
            else analysis.selectStepBlocks(absolute, { atMm: step.at_mm, label: `Step ${n}: ${ROLE_WORD[step.move]}` });
        },

        leave: () => {
            const { status } = get();
            // An upload that is under way finishes (and is shown only if its project is still open).
            if (status === "saving" || status === "idle") return;
            reset();
        },
    };
});

// The saved version's analysis landed: its row is on screen now, so the end of the run counts from here (see `endedAt`).
useAnalysisStore.subscribe((state, prev) => {
    if (awaitingAnalysisOf === null || state.result === prev.result || state.resultModelId !== awaitingAnalysisOf) return;
    const { status, savedModelId } = useStabilizeStore.getState();
    const landed = status === "saved" && savedModelId === awaitingAnalysisOf;
    awaitingAnalysisOf = null;
    if (landed) useStabilizeStore.setState({ endedAt: deps.now() });
});

// A run belongs to its project: opening another one (or a new chat) stops it.
useWorkspaceStore.subscribe((state, prev) => {
    if (state.activeProjectId !== prev.activeProjectId) {
        useStabilizeStore.getState().leave();
        return;
    }
    // The user went to look at something else before the new version's analysis landed: it does not count as the run's end any more.
    if (awaitingAnalysisOf !== null && state.activeModelId !== prev.activeModelId && state.activeModelId !== awaitingAnalysisOf) awaitingAnalysisOf = null;
    if (state.models === prev.models) return;
    // The version the "Stabilized" banner is about was deleted (the Models tab): it would offer to open what is gone.
    const { status, savedModelId, discard } = useStabilizeStore.getState();
    if (status === "saved" && savedModelId && !state.models.some((m) => m.id === savedModelId)) discard();
});
