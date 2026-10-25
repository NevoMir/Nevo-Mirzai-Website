// Changing the blocks by words: the person writes what they want ("add a shelf under the seat"), the AI editor answers with a few cell
// operations (worker/voxelEdit.ts), the app applies them to a COPY of the blocks, checks the copy with the same analysis the Stability tab
// uses, and shows a proposal with the change of verdict. Apply puts it in a draft (up to 12 changes, undo and redo); Save version writes the
// draft as ONE new version of the project (POST /models/:id/derived with the edit log in the file). Nothing is saved until then.
//
//   idle -> planning -> proposal -> (Apply) idle with a draft -> saving -> saved
//                  \-> idle with a notice (a question, a refusal, nothing to change)
//   saving -> error (the upload failed: Retry, or keep working)
//
// The unsaved result is drawn on the stage through the analysis store's preview slot (owner "blocks"), painted by role so the blocks made by
// the edits stand out in sky blue. One piece of work at a time (store/workGuard.ts): a session takes the guard when it starts and gives it
// back when it ends (saved, discarded, project left). A session belongs to the version it started from and to the project it was in.
//
// requestBlockEdit is what the composer's router calls (store/editRouter.ts): it resolves when the proposal (or the answer that there is none)
// has come back, and it REJECTS with a sentence fit for the person when nothing could be asked, so the router can take its note back.

import { create } from "zustand";

import type { AnalysisResult, AnalysisSettings } from "@/assignment/analysis/types";
import { toast } from "@/assignment/components/ui/sonner";
import { createDerivedModel } from "@/assignment/lib/api";
import { requestVoxelEdit } from "@/assignment/lib/voxelEditApi";
import { descriptorFromBlocks, type AssemblyDescriptor } from "@/assignment/shared/assembly";
import { EDIT_INSTRUCTION_MAX, MAX_VERSION_DEPTH, type ModelAsset, type VoxelEditBody, type VoxelEditResponse } from "@/assignment/shared/contract";
import { chainDepth, stabilizationsOfModel, versionTitle } from "@/assignment/shared/versionTree";
import { descriptorOfGrid, gridFromDescriptor, maxStep, type EditGrid } from "@/assignment/shared/voxelEdit/grid";
import { buildEditVersion, logEntry } from "@/assignment/shared/voxelEdit/meta";
import { applyEdit, cleanAnswer, type EditReport, type VoxelEditEntry } from "@/assignment/shared/voxelEdit/ops";
import { rawOpOf } from "@/assignment/shared/voxelEdit/replay";
import { buildScene, pieceRegions } from "@/assignment/shared/voxelEdit/scene";
import { flatText } from "@/assignment/shared/voxelEdit/text";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { postAssistantNote } from "@/assignment/store/chatNotes";
import { partLabelsFor, primePartLabels, type PartLabelling } from "@/assignment/store/partLabels";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import {
    canAddChange,
    countsLine,
    keepDraft,
    loadSavedDraft,
    sceneIssuesOf,
    sceneNameOf,
    verdictChange,
    verdictOfAnalysis,
    type VerdictChange,
} from "@/assignment/store/voxelEditLogic";
import type { Verdict } from "@/assignment/store/analysisLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { acquireWork, setWorkWaiting, workBusyMessage, WORK_CHIP_WORDS } from "@/assignment/store/workGuard";

export type BlockEditStatus = "idle" | "planning" | "proposal" | "saving" | "error";

/** What the AI editor proposed, worked out against the blocks as they are now: nothing of it is applied yet. */
export interface Proposal {
    instruction: string;
    /** The editor's sentence ("Made the backrest 2 blocks taller."), or one built from the numbers. */
    summary: string;
    /** How it read an ambiguous word ("I took the left of the Front view as the left"), else "". */
    notes: string;
    /** What an operation could not do, and what it cut or kept. */
    warnings: string[];
    added: number;
    removed: number;
    moved: number;
    /** Blocks the stabilizer added that were left alone. */
    protectedKept: number;
    /** Half the blocks gone, or 200 and more added: the card words its warning more strongly. */
    large: boolean;
    before: Verdict;
    after: Verdict;
    change: VerdictChange;
    blocksBefore: number;
    blocksAfter: number;
}

/** The unsaved changes, as the card shows them. */
export interface DraftView {
    /** Changes applied (the draft is these, in order). */
    count: number;
    /** Changes that were undone and can be put back. */
    redo: number;
    verdict: Verdict;
    /** Against the saved version the draft started from. */
    change: VerdictChange;
    blocks: number;
    baseBlocks: number;
    /** The sentence of the last change. */
    last: string;
    /** The twelfth change: save before going on. */
    full: boolean;
}

/** An answer that is not a proposal: a question, a refusal, or "nothing would change". */
export interface Notice {
    kind: "ask" | "refused" | "nothing";
    text: string;
    warnings: string[];
}

interface VoxelEditState {
    status: BlockEditStatus;
    /** The version the session started from and the project it was in. */
    sourceModelId: string | null;
    projectId: string | null;
    /** Bumped by every request: late answers of an earlier one carry the old number. */
    runId: number;
    /** The words of the request in flight or of the proposal. */
    instruction: string;
    /** When the request began (deps.now()); null otherwise. */
    startedAt: number | null;
    /** Putting a kept draft back, not asking the editor. */
    resuming: boolean;
    proposal: Proposal | null;
    draft: DraftView | null;
    /** The analysis of the draft (what the panel's headline shows while a draft exists); the same object as the stage's preview, without its frame. */
    draftResult: AnalysisResult | null;
    notice: Notice | null;
    error: string | null;
    savedModelId: string | null;
    /** Stabilize the new version as soon as it is saved. */
    stabilizeAfter: boolean;
    /** A draft kept from before a reload, for the model named: Continue / Discard. */
    resumable: { modelId: string; count: number } | null;

    request: (modelId: string, instruction: string) => Promise<void>;
    apply: () => void;
    discardProposal: () => void;
    undo: () => void;
    redo: () => void;
    /** Throws the whole draft (and any proposal) away. */
    discard: () => void;
    save: () => Promise<void>;
    /** Saves the draft, then stabilizes the new version. */
    saveAndStabilize: () => Promise<void>;
    setStabilizeAfter: (on: boolean) => void;
    /** Stop the request in flight. */
    cancel: () => void;
    dismissNotice: () => void;
    /** Looks for a draft kept in this browser for `modelId` (after a reload). */
    findResumable: (modelId: string) => void;
    /** Rebuilds the kept draft of `modelId` from its logged operations and shows it. */
    resume: () => Promise<void>;
    /** Puts the version the unsaved changes belong to back on the stage. */
    goToSource: () => void;
    /** The workspace or the project was left. */
    leave: () => void;
}

// ---------- what a test can replace ----------

export interface VoxelEditDeps {
    ask: (body: VoxelEditBody, signal: AbortSignal) => Promise<VoxelEditResponse>;
    /** The analysis (with the stress estimate) of a block assembly on its own, in the headless frame; `key` names the model for the caches. */
    analyse: (descriptor: AssemblyDescriptor, settings: AnalysisSettings, key: string, signal: AbortSignal) => Promise<AnalysisResult>;
    upload: (sourceId: string, glb: Uint8Array) => Promise<ModelAsset>;
    labels: (model: ModelAsset) => Promise<PartLabelling>;
    now: () => number;
}

/** How long the upload may take before it counts as failed (the file is about 100 KB: only a lost connection takes longer). */
export const SAVE_TIMEOUT_MS = 30_000;

const defaultDeps: VoxelEditDeps = {
    ask: (body, signal) => requestVoxelEdit(body, signal),
    analyse: async (descriptor, settings, key, signal) => {
        const { runAnalysis } = await import("@/assignment/analysis/runAnalysis");
        // The cells are the blocks: the triangles are never read (the headless frame has none).
        return runAnalysis(() => ({ positions: new Float32Array(0) }), settings, { assembly: descriptor, cacheKey: key, signal });
    },
    upload: (sourceId, glb) =>
        createDerivedModel(sourceId, glb, typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(SAVE_TIMEOUT_MS) : undefined),
    labels: (model) => partLabelsFor(model),
    now: () => Date.now(),
};
let deps: VoxelEditDeps = defaultDeps;

/** Swap the editor, the analysis or the upload (tests). Called with nothing, puts the real ones back. */
export function setVoxelEditDeps(next?: Partial<VoxelEditDeps>): void {
    deps = { ...defaultDeps, ...next };
}

// ---------- the session in hand (not state: nothing renders from it) ----------

interface Applied {
    entry: VoxelEditEntry;
    grid: EditGrid;
    result: AnalysisResult;
}

interface Session {
    source: ModelAsset;
    projectId: string;
    /** The analysis of the source as the stage shows it: its frame is the one the draft is drawn in. */
    base: AnalysisResult;
    /**
     * The source's blocks analysed as an assembly, the way every change is: the "before" of a proposal. It is `base` for a block version; for
     * the original mesh it leaves out what only a voxelised mesh has (thin parts left out), so a change is judged against like with like.
     */
    start: AnalysisResult;
    baseGrid: EditGrid;
    baseVerdict: Verdict;
    baseSteps: number;
    /** Versions above the source, and stabilizations above it (the saved version records both). */
    sourceDepth: number;
    stabilizedDepth: number;
    /** Changes applied, then those that were undone (the redo stack): `cursor` of them count. */
    steps: Applied[];
    cursor: number;
    /** A proposal that is not applied yet. */
    pending: { applied: Applied; report: EditReport } | null;
    release: () => void;
}
let ctx: Session | null = null;
let counter = 0;
/** Bumped by every analysis key; the caches of runAnalysis are keyed by it. */
let analysisKey = 0;
/** The request (or the resuming of a draft) in flight: Stop, a project left and a discard abort it. */
let flight: AbortController | null = null;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

const INITIAL = {
    status: "idle" as BlockEditStatus,
    sourceModelId: null,
    projectId: null,
    instruction: "",
    startedAt: null,
    resuming: false,
    proposal: null,
    draft: null,
    draftResult: null,
    notice: null,
    error: null,
    savedModelId: null,
};

const hasContent = (s: Session): boolean => s.steps.length > 0;
const gridOf = (s: Session): EditGrid => (s.cursor === 0 ? s.baseGrid : s.steps[s.cursor - 1].grid);
const resultOf = (s: Session): AnalysisResult => (s.cursor === 0 ? s.start : s.steps[s.cursor - 1].result);

/** The analysis of a draft in the frame of the version on the stage, so the blocks line up with the mesh they were made over. */
const onStage = (s: Session, result: AnalysisResult): AnalysisResult => ({ ...result, transform: s.base.transform });

/** The unsaved result into the analysis store's preview slot (or out of it), as the block editor's. */
function showOnStage(s: Session | null, result: AnalysisResult | null): void {
    const analysis = useAnalysisStore.getState();
    if (s && result) analysis.setPreview(s.source.id, onStage(s, result), "blocks");
    else if (s) analysis.setPreview(s.source.id, null, "blocks");
}

export const useVoxelEditStore = create<VoxelEditState>()((set, get) => {
    const stale = (runId: number): boolean => get().runId !== runId || ctx === null;

    /**
     * Ends the session: aborts what is in flight, takes the preview off the stage, gives the guard back, forgets the kept draft.
     * `empty`: the session never held a change, so the draft kept from before a reload is not its own and stays.
     */
    const closeSession = (patch: Partial<VoxelEditState> = {}, empty = false): void => {
        const s = ctx;
        ctx = null;
        flight?.abort();
        flight = null;
        if (s) {
            showOnStage(s, null);
            s.release();
        }
        if (!empty) keepDraft(null);
        set({ ...INITIAL, runId: get().runId + 1, resumable: null, stabilizeAfter: false, ...patch });
    };

    /** The draft as the card shows it, for the session as it stands; also keeps it in sessionStorage and puts it on the stage. */
    const publish = (): void => {
        const s = ctx;
        if (!s) return;
        if (s.steps.length === 0) {
            // (A session that never held a change does not own the draft kept from before a reload.)
            showOnStage(s, null);
            set({ draft: null, draftResult: null });
            return;
        }
        // Every change undone: the blocks are the saved version's again, with the changes waiting to be put back.
        const now = resultOf(s);
        const verdict = verdictOfAnalysis(now);
        set({
            draft: {
                count: s.cursor,
                redo: s.steps.length - s.cursor,
                verdict,
                change: verdictChange(s.baseVerdict, verdict, s.start.issues, now.issues),
                blocks: now.stats.blockCount,
                baseBlocks: s.start.stats.blockCount,
                last: s.cursor > 0 ? s.steps[s.cursor - 1].entry.summary : "",
                full: canAddChange(s.cursor, s.baseSteps) !== null,
            },
            draftResult: s.cursor > 0 ? now : null,
        });
        showOnStage(s, s.cursor > 0 ? now : null);
        keepDraft(s.cursor > 0 ? { v: 1, projectId: s.projectId, modelId: s.source.id, baseSteps: s.baseSteps, entries: s.steps.slice(0, s.cursor).map((x) => x.entry) } : null);
    };

    /** Starts a session for `model`: takes the guard, reads its blocks and labels. Throws a sentence fit for the person. */
    const openSession = async (model: ModelAsset, projectId: string, signal: AbortSignal): Promise<Session> => {
        const release = acquireWork("blocks", projectId, { label: WORK_CHIP_WORDS.blocks, stop: () => get().cancel() });
        if (!release) throw new Error(workBusyMessage("blocks", projectId) ?? "Something else is running. Try again when it ends.");
        try {
            const analysis = useAnalysisStore.getState();
            const base = analysis.resultModelId === model.id ? analysis.result : null;
            if (!base) throw new Error("Wait for the check of this model to finish, then try again.");
            if (base.blocks.length === 0) throw new Error("There are no blocks to change in this model.");
            const models = useWorkspaceStore.getState().models;
            const sourceDepth = chainDepth(models, model);
            if (sourceDepth + 1 > MAX_VERSION_DEPTH) throw new Error("This chain of versions is as long as it can get. Start again from an earlier version.");
            const descriptor = base.assembly?.descriptor ?? descriptorFromBlocks(base.blocks.map((b) => ({ cell: [b.cell[0], b.cell[1], b.cell[2]] as [number, number, number] })));
            const labelling = await deps.labels(model);
            const grid = gridFromDescriptor(descriptor, labelling.names.length > 0 ? labelling : null);
            const start = base.assembly ? base : await deps.analyse(descriptor, analysis.settings, `blocks:${model.id}:${++analysisKey}`, signal);
            return {
                source: model,
                projectId,
                base,
                start,
                baseGrid: grid,
                baseVerdict: verdictOfAnalysis(start),
                baseSteps: maxStep(grid),
                sourceDepth,
                stabilizedDepth: stabilizationsOfModel(model),
                steps: [],
                cursor: 0,
                pending: null,
                release,
            };
        } catch (error) {
            release();
            throw error;
        }
    };

    const analyseGrid = (s: Session, grid: EditGrid, signal: AbortSignal): Promise<AnalysisResult> =>
        deps.analyse(descriptorOfGrid(grid), useAnalysisStore.getState().settings, `blocks:${s.source.id}:${++analysisKey}`, signal);

    /** The request ended without a proposal: back to the field (the draft, if any, stays). */
    const backToIdle = (runId: number, patch: Partial<VoxelEditState> = {}): void => {
        if (get().runId !== runId) return;
        const s = ctx;
        flight = null;
        set({ status: "idle", startedAt: null, resuming: false, ...patch });
        if (s && !hasContent(s) && !s.pending) closeSession(patch, true);
    };

    /** The version is saved: it goes on the stage, the chat says so, the session ends. */
    const finishSave = (s: Session, model: ModelAsset, grid: EditGrid): void => {
        const workspace = useWorkspaceStore.getState();
        if (workspace.activeProjectId !== s.projectId) {
            // The server has it; this screen is another project's.
            toast.info("Saved a version", { description: "It is in the project you left." });
            closeSession();
            return;
        }
        workspace.addModel(model);
        primePartLabels(model.id, { names: [...grid.parts], owner: labelOwners(grid) });
        // The new version goes on the stage unless the person has moved to another family in the meantime.
        const now = useWorkspaceStore.getState();
        const active = now.models.find((m) => m.id === now.activeModelId);
        const switched = active === undefined || active.id === s.source.id || active.id === model.id;
        if (switched) {
            workspace.setActiveModel(model.id);
            // The edit's blocks are sky blue by role: keep the colouring that shows what changed.
            useAnalysisStore.getState().setColorBy("role");
        }
        const title = versionTitle(now.models, model);
        postAssistantNote(s.projectId, `Saved ${title}. ${model.edit?.summary ?? ""}`.trim(), { modelIds: [model.id] });
        if (switched) toast.success("Saved your changes as a new version");
        else toast.success("Saved a new version", { description: "Find it in the Models tab." });
        const stabilize = get().stabilizeAfter;
        closeSession({ savedModelId: model.id });
        if (stabilize && switched) void stabilizeWhenReady(model.id);
    };

    return {
        ...INITIAL,
        runId: 0,
        stabilizeAfter: false,
        resumable: null,

        request: async (modelId, raw) => {
            const state = get();
            if (state.status === "planning" || state.status === "saving") throw new Error("Wait for the current change to finish.");
            // One line: the words go into the saved log, which refuses control characters (a newline typed with Shift+Enter, a pasted tab).
            const instruction = flatText(raw);
            if (!instruction) throw new Error("Write what you want to change.");
            if (instruction.length > EDIT_INSTRUCTION_MAX) throw new Error(`Keep it under ${EDIT_INSTRUCTION_MAX} characters.`);
            const workspace = useWorkspaceStore.getState();
            const projectId = workspace.activeProjectId;
            const model = workspace.models.find((m) => m.id === modelId);
            if (!projectId || !model) throw new Error("This model is not in the project any more.");
            // Unsaved changes to another version wait for a decision: one session at a time.
            if (ctx && ctx.source.id !== modelId) {
                if (hasContent(ctx)) throw new Error("Save or discard the changes you made to the other version first.");
                closeSession({}, true);
            }
            if (ctx && ctx.projectId !== projectId) closeSession();

            // A proposal that was never answered is replaced by this request: the stage goes back to the draft (or the saved version) until the new one comes.
            if (ctx?.pending) {
                ctx.pending = null;
                publish();
            }
            const runId = ++counter;
            const controller = new AbortController();
            flight = controller;
            set({ runId, status: "planning", instruction, startedAt: deps.now(), resuming: false, proposal: null, notice: null, error: null, savedModelId: null, sourceModelId: modelId, projectId });
            let session = ctx;
            try {
                if (!session) {
                    session = await openSession(model, projectId, controller.signal);
                    if (get().runId !== runId) {
                        session.release();
                        return;
                    }
                    ctx = session;
                    set({ resumable: null });
                }
                const why = canAddChange(session.cursor, session.baseSteps);
                if (why) throw new Error(why);
            } catch (error) {
                const mine = get().runId === runId;
                if (mine) {
                    flight = null;
                    if (ctx && !hasContent(ctx)) closeSession({}, true);
                    else set({ status: "idle", startedAt: null, sourceModelId: ctx ? ctx.source.id : null, projectId: ctx ? ctx.projectId : null });
                }
                // Stop, or a newer request: nothing to report.
                if (!mine || isAbort(error)) return;
                throw error;
            }

            const grid = gridOf(session);
            const current = resultOf(session);
            const history = session.steps.slice(0, session.cursor).map((x) => ({ instruction: x.entry.instruction, summary: x.entry.summary }));
            const scene = buildScene(grid, { name: sceneNameOf(model), summary: current.summary, issues: sceneIssuesOf(current), history });

            let response: VoxelEditResponse;
            try {
                response = await deps.ask({ instruction, scene: scene.text }, controller.signal);
            } catch (error) {
                // Stop (or a newer request, or a project left): nothing to report.
                if (isAbort(error) || stale(runId)) {
                    backToIdle(runId);
                    return;
                }
                backToIdle(runId);
                throw error;
            }
            if (stale(runId)) return;
            // The person went to another version, or another project, while the editor thought: the answer is not for what they look at now.
            const here = useWorkspaceStore.getState();
            if (here.activeProjectId !== projectId || here.activeModelId !== modelId) {
                backToIdle(runId);
                return;
            }

            const answer = cleanAnswer(response.answer);
            if (!answer) {
                backToIdle(runId);
                throw new Error("The AI editor's answer could not be read. Please try again.");
            }
            const shown = (notice: Notice): void => {
                backToIdle(runId, { notice, sourceModelId: modelId, projectId });
                postAssistantNote(projectId, notice.text);
            };
            if (answer.ops.length === 0) {
                shown({ kind: "ask", text: answer.clarification || answer.summary || "The editor did not find a way to make that change.", warnings: [] });
                return;
            }

            const no = session.cursor + 1;
            const result = applyEdit(grid, answer, scene.regions, session.baseSteps + no);
            const problems = [...result.report.rejected, ...result.report.warnings];
            if (!result.ok) {
                shown({ kind: "refused", text: result.reason, warnings: problems.filter((p) => p !== result.reason) });
                return;
            }
            if (result.report.added + result.report.removed + result.report.moved === 0) {
                // The editor's own sentence says what it meant to do ("Mirrored the column"); what the person needs to hear is that nothing came of it.
                shown({ kind: "nothing", text: answer.notes ? `Nothing would change. ${answer.notes}` : "Nothing would change.", warnings: problems });
                return;
            }

            let analysed: AnalysisResult;
            try {
                analysed = await analyseGrid(session, result.grid, controller.signal);
            } catch (error) {
                if (isAbort(error) || stale(runId)) {
                    backToIdle(runId);
                    return;
                }
                backToIdle(runId);
                throw new Error(errorText(error, "The changed blocks could not be checked."));
            }
            if (stale(runId)) return;

            const entry = logEntry(no, instruction, answer, result.report, response.model ?? "", response.cost_usd ?? null);
            const after = verdictOfAnalysis(analysed);
            session.pending = { applied: { entry, grid: result.grid, result: analysed }, report: result.report };
            flight = null;
            const proposal: Proposal = {
                instruction,
                summary: entry.summary,
                notes: entry.notes,
                warnings: problems,
                added: result.report.added,
                removed: result.report.removed,
                moved: result.report.moved,
                protectedKept: result.report.protectedKept,
                large: result.report.large,
                before: verdictOfAnalysis(current),
                after,
                change: verdictChange(verdictOfAnalysis(current), after, current.issues, analysed.issues),
                blocksBefore: current.stats.blockCount,
                blocksAfter: analysed.stats.blockCount,
            };
            set({ status: "proposal", startedAt: null, proposal });
            // The proposal on the stage, painted by role so the blocks it makes are sky blue.
            showOnStage(session, analysed);
            postAssistantNote(projectId, `${entry.summary} The proposal is on the Stability tab: ${countsLine(proposal)}, ${proposal.change.text.toLowerCase()}.`);
        },

        apply: () => {
            const s = ctx;
            if (!s || !s.pending || get().status !== "proposal") return;
            s.steps = [...s.steps.slice(0, s.cursor), s.pending.applied];
            s.cursor = s.steps.length;
            s.pending = null;
            set({ status: "idle", proposal: null, instruction: "", notice: null });
            publish();
        },

        discardProposal: () => {
            const s = ctx;
            if (!s || !s.pending) return;
            s.pending = null;
            set({ status: "idle", proposal: null, instruction: "" });
            if (!hasContent(s)) closeSession({}, true);
            else publish();
        },

        undo: () => {
            const s = ctx;
            if (!s || s.cursor === 0 || get().status === "planning" || get().status === "saving") return;
            s.pending = null;
            s.cursor--;
            set({ status: "idle", proposal: null, notice: null });
            publish();
        },

        redo: () => {
            const s = ctx;
            if (!s || s.cursor >= s.steps.length || get().status === "planning" || get().status === "saving") return;
            s.pending = null;
            s.cursor++;
            set({ status: "idle", proposal: null, notice: null });
            publish();
        },

        discard: () => {
            if (get().status === "saving") return;
            closeSession();
        },

        setStabilizeAfter: (on) => set({ stabilizeAfter: on }),

        cancel: () => {
            const s = ctx;
            if (get().status !== "planning") return;
            flight?.abort();
            // The request that is waiting must find itself out of date, whichever step it is in.
            const runId = get().runId + 1;
            set({ runId });
            if (s) backToIdle(runId);
            else set({ status: "idle", startedAt: null, resuming: false });
        },

        dismissNotice: () => set({ notice: null }),

        save: async () => {
            const s = ctx;
            const state = get();
            if (!s || s.cursor === 0 || state.status === "saving" || state.status === "planning") return;
            const runId = state.runId;
            const taken = s.steps.slice(0, s.cursor);
            const last = taken[taken.length - 1];
            set({ status: "saving", error: null, proposal: null });
            s.pending = null;
            try {
                const { descriptor, log } = await buildEditVersion({
                    baseSteps: s.baseSteps,
                    sourceDepth: s.sourceDepth,
                    stabilizedDepth: s.stabilizedDepth,
                    entries: taken.map((x) => x.entry),
                    grid: last.grid,
                    beforeSummary: s.start.summary,
                    afterSummary: last.result.summary,
                    createdAt: new Date(deps.now()).toISOString(),
                });
                const { writeAssemblyGlb } = await import("@/assignment/shared/assemblyGlb");
                const model = await deps.upload(s.source.id, writeAssemblyGlb(descriptor, null, log));
                if (get().runId !== runId || ctx !== s) return;
                finishSave(s, model, last.grid);
            } catch (error) {
                if (get().runId !== runId || ctx !== s) return;
                set({ status: "error", error: errorText(error, "The version could not be saved."), startedAt: null });
                toast.error("Could not save the version", { description: errorText(error, "Check your connection and try again.") });
            }
        },

        saveAndStabilize: async () => {
            set({ stabilizeAfter: true });
            await get().save();
        },

        findResumable: (modelId) => {
            if (ctx) return;
            const kept = loadSavedDraft();
            const workspace = useWorkspaceStore.getState();
            const next =
                kept && kept.modelId === modelId && kept.projectId === workspace.activeProjectId && workspace.models.some((m) => m.id === modelId)
                    ? { modelId, count: kept.entries.length }
                    : null;
            const was = get().resumable;
            if (was?.modelId !== next?.modelId || was?.count !== next?.count) set({ resumable: next });
        },

        resume: async () => {
            const kept = loadSavedDraft();
            const workspace = useWorkspaceStore.getState();
            const model = kept ? workspace.models.find((m) => m.id === kept.modelId) : undefined;
            const projectId = workspace.activeProjectId;
            if (ctx || !kept || !model || !projectId || kept.projectId !== projectId) return;
            const runId = ++counter;
            set({ runId, status: "planning", resuming: true, startedAt: deps.now(), instruction: "", notice: null, error: null, sourceModelId: model.id, projectId });
            const controller = new AbortController();
            flight = controller;
            let session: Session | null = null;
            try {
                session = await openSession(model, projectId, controller.signal);
                if (get().runId !== runId) {
                    session.release();
                    return;
                }
                ctx = session;
                // Replay the logged operations one at a time (a step is a state the person can undo to).
                let grid = session.baseGrid;
                for (const entry of kept.entries) {
                    const answer = { summary: entry.summary, notes: entry.notes, clarification: "", ops: entry.ops.map(rawOpOf) };
                    const applied = applyEdit(grid, answer, pieceRegions(grid), session.baseSteps + entry.n);
                    if (!applied.ok) throw new Error("Your unsaved changes no longer fit this version.");
                    const result = await analyseGrid(session, applied.grid, controller.signal);
                    if (stale(runId)) return;
                    session.steps.push({ entry, grid: applied.grid, result });
                    grid = applied.grid;
                }
                session.cursor = session.steps.length;
                flight = null;
                set({ status: "idle", startedAt: null, resuming: false, resumable: null });
                publish();
            } catch (error) {
                if (get().runId !== runId) return;
                closeSession();
                if (!isAbort(error)) toast.error("Could not bring back your changes", { description: errorText(error, "They are gone.") });
            }
        },

        goToSource: () => {
            const id = ctx?.source.id ?? get().sourceModelId;
            if (id && useWorkspaceStore.getState().models.some((m) => m.id === id)) useWorkspaceStore.getState().setActiveModel(id);
        },

        leave: () => {
            // An upload that is under way finishes (and is shown only if its project is still open).
            if (get().status === "saving") return;
            if (ctx) closeSession({}, !hasContent(ctx));
            else set({ resumable: null });
        },
    };

});

/** The cell -> part table of a grid, for the labels of a version just saved. */
function labelOwners(grid: EditGrid): Int8Array {
    const owner = new Int8Array(grid.label.length).fill(-1);
    for (let c = 0; c < owner.length; c++) if (grid.occ[c]) owner[c] = grid.label[c];
    return owner;
}

/** Waits for the analysis of the new version, then starts the stabilizer on it. */
async function stabilizeWhenReady(modelId: string): Promise<void> {
    const ready = (): AnalysisResult | null => {
        const s = useAnalysisStore.getState();
        return s.resultModelId === modelId && s.result && s.run.status !== "running" ? s.result : null;
    };
    let result = ready();
    if (!result) {
        result = await new Promise<AnalysisResult | null>((resolve) => {
            const timer = setTimeout(() => {
                unsubscribe();
                resolve(null);
            }, 20_000);
            const unsubscribe = useAnalysisStore.subscribe(() => {
                const r = ready();
                if (r) {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(r);
                }
            });
        });
    }
    const model = useWorkspaceStore.getState().models.find((m) => m.id === modelId);
    if (!result || !model) {
        toast.info("Saved. Press Stabilize when the check has finished.");
        return;
    }
    if (!useStabilizeStore.getState().start(model, result)) toast.error("Could not start stabilizing", { description: "Another run is going, or the model has no blocks." });
}

/** What the router calls (store/editRouter.ts): the change to the blocks of `modelId`, asked for and shown as a proposal. Rejects with a sentence fit for the person. */
export async function requestBlockEdit(a: { modelId: string; instruction: string }): Promise<void> {
    await useVoxelEditStore.getState().request(a.modelId, a.instruction);
}

// The work guard tells the shell whether this work is running or waits for a decision: a request in flight is the run chip with its Stop; a
// proposal or a draft is the "Draft" chip on the version control (store/workGuard.ts setWorkWaiting). Following the state keeps every path
// (apply, undo, redo, save, a refused answer) in step without each one saying so.
useVoxelEditStore.subscribe((state) => setWorkWaiting("blocks", ctx !== null && state.status !== "planning"));

// The project was left (or the version the draft is about was deleted): the session ends with it.
useWorkspaceStore.subscribe((state, prev) => {
    if (state.activeProjectId !== prev.activeProjectId) {
        useVoxelEditStore.getState().leave();
        return;
    }
    if (state.models === prev.models) return;
    const { sourceModelId, status } = useVoxelEditStore.getState();
    if (sourceModelId && status !== "saving" && ctx && !state.models.some((m) => m.id === sourceModelId)) useVoxelEditStore.getState().discard();
});
