// Editing a model by words: a design edit of a Muse parts model, or a mesh edit of a fused mesh (Hunyuan). Both start here, from the chat.
//
//   design   POST /models/:id/edits -> a job; the server rebuilds the parts, saves the new version and the job polling (store/jobs.ts)
//            puts it on screen. This file only starts it and writes the two chat messages; the card (EditCard) follows the job.
//   mesh     the browser does the work. idle -> describing -> planning -> [refining] -> applying -> saving -> saved
//              describing  the model file is read and three labelled pictures are made (edit/describeMesh.ts, in a Web Worker)
//              planning    POST /models/:id/edits with the pictures; Muse Spark plans a short program (the job, polled like any job)
//              applying    the program runs on the person's own copy of the file and a new GLB is written (edit/session.ts)
//              saving      POST /models/:id/edited?job=<id> (15 to 28 MB, streamed into R2); the new version goes on the stage
//            planning -> noop      the model said the request cannot be done (nothing is saved)
//            any step -> error     kinds: start | plan | unsupported | notfound | toomuch | toobig | apply | save
//              a failed save keeps the local result: Retry the upload (the same job id makes it safe) or Download the GLB
//
// One mesh run at a time per project. A run belongs to its project: leaving it stops the work that is local (the plan stays on the job as
// "Plan ready, apply?", so coming back offers to apply it), but an upload that is under way finishes. Pure rules live in editLogic.ts.

import { create } from "zustand";

import type { MeshEditHandle, OpenOptions, RunOptions } from "@/assignment/edit/runMeshEdit";
import { MeshEditError } from "@/assignment/edit/types";
import { toast } from "@/assignment/components/ui/sonner";
import { ApiRequestError, cancelJob, clearAccessCode, deleteModel, getJob } from "@/assignment/lib/api";
import { fetchModelBytes, startEdit, uploadEditedMesh } from "@/assignment/lib/editApi";
import {
    EDIT_INSTRUCTION_MAX,
    EDIT_PACKAGE_LIMIT,
    MESH_REFINE_OPS,
    type ChatMessage,
    type EditResult,
    type Job,
    type MeshPackage,
    type ModelAsset,
    type StartEditBody,
} from "@/assignment/shared/contract";
import { needsRefine, type MeshProgram } from "@/assignment/shared/meshProgram";
import { editVersion } from "@/assignment/components/workspace/versionActions";
import { requestAccessCode } from "@/assignment/store/access";
import {
    applicablePlan,
    failureOf,
    familyOf,
    regeneratePrompt,
    savedLine,
    splitTechnical,
    type EditErrorKind,
    type EditStatus,
} from "@/assignment/store/editLogic";
import { applyJob } from "@/assignment/store/jobs";
import { saveNow } from "@/assignment/store/persist";
import { refreshProviders } from "@/assignment/store/providers";
import { EDIT_START_LINES, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

export type EditTargetKind = "design" | "mesh";

/** What the card needs to show about one edit that the page is working on (a mesh edit; a design edit is shown from its job alone). */
export interface EditRun {
    /** `pending-N` until the job exists, then the job's id. */
    key: string;
    jobId: string | null;
    projectId: string;
    sourceModelId: string;
    instruction: string;
    target: EditTargetKind;
    status: EditStatus;
    startedAt: number;
    /** The op being applied. */
    step: { index: number; total: number; label: string } | null;
    stage: "texture" | "writing" | null;
    summary: string | null;
    notes: string[];
    errorKind: EditErrorKind | null;
    error: string | null;
    savedModelId: string | null;
    /** The prompt "generate it again" starts from. */
    regenPrompt: string | null;
    /** Size of the file being saved. */
    resultBytes: number | null;
    /** The second pass has been made for this edit (once only). */
    refined: boolean;
    /** The local result is still here (a failed save): Retry and Download are offered. */
    hasLocalResult: boolean;
}

interface EditStoreState {
    runs: Record<string, EditRun>;
    /** Models an Undo took away, so the card says "Undone" instead of "Version deleted". */
    undone: Record<string, true>;
}

export const useEditStore = create<EditStoreState>()(() => ({ runs: {}, undone: {} }));

/** The run for a job id, a hook for the card. */
export const useEditRun = (jobId: string): EditRun | undefined => useEditStore((s) => s.runs[jobId]);

// ---------- what a test can replace ----------

export interface EditDeps {
    startEdit: (sourceId: string, body: StartEditBody, signal?: AbortSignal) => Promise<Job>;
    uploadEditedMesh: (sourceId: string, jobId: string, glb: Uint8Array, signal?: AbortSignal) => Promise<ModelAsset>;
    fetchModelBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
    openMeshEdit: (bytes: ArrayBuffer, options?: OpenOptions) => Promise<MeshEditHandle>;
    getJob: (id: string) => Promise<Job>;
    cancelJob: (id: string) => Promise<Job>;
    deleteModel: (id: string) => Promise<void>;
    requestAccessCode: () => Promise<boolean>;
    now: () => number;
    /** The picture format the model is sent: JPEG is far smaller where the browser can encode it. */
    pictureFormat: () => "png" | "jpeg";
}

const defaultDeps: EditDeps = {
    startEdit,
    uploadEditedMesh,
    fetchModelBytes,
    openMeshEdit: async (bytes, options) => {
        const { openMeshEdit } = await import("@/assignment/edit/runMeshEdit");
        return openMeshEdit(bytes, options);
    },
    getJob: (id) => getJob(id),
    cancelJob: (id) => cancelJob(id),
    deleteModel: (id) => deleteModel(id),
    requestAccessCode,
    now: () => Date.now(),
    // JPEG q80 reads as well as PNG for the model (checked live) and is a third of the size; without a canvas the editor falls back to PNG itself.
    pictureFormat: () => "jpeg",
};
let deps: EditDeps = defaultDeps;

/** Swap the network or the editor (tests). Called with nothing, puts the real ones back. */
export function setEditDeps(next?: Partial<EditDeps>): void {
    deps = { ...defaultDeps, ...next };
}

// ---------- the work in flight (not state: nothing renders from it) ----------

interface Local {
    controller: AbortController;
    handle: MeshEditHandle | null;
    /** The edited file, kept while its upload has not gone through. */
    glb: Uint8Array | null;
}
const locals = new Map<string, Local>();
let counter = 0;

const isAbort = (error: unknown): boolean => (error instanceof Error && error.name === "AbortError") || (error instanceof MeshEditError && error.code === "aborted");
const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

const BUSY: readonly EditStatus[] = ["describing", "planning", "refining", "applying", "saving"];

/** The mesh edit of the project that is in progress (what the bar's run chip shows: its stage, its time, a way to stop it), if any. */
export const busyMeshRunOf = (runs: Readonly<Record<string, EditRun>>, projectId: string | null): EditRun | undefined =>
    projectId === null ? undefined : Object.values(runs).find((r) => r.projectId === projectId && r.target === "mesh" && BUSY.includes(r.status));

/** A hook for the run chip: the project's busy mesh edit, or undefined. */
export const useBusyMeshRun = (projectId: string | null): EditRun | undefined => useEditStore((s) => busyMeshRunOf(s.runs, projectId));

/** Is a mesh edit of this project in progress here? (One at a time.) */
export function meshEditBusy(projectId: string): boolean {
    return busyMeshRunOf(useEditStore.getState().runs, projectId) !== undefined;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
    const out = { ...record };
    delete out[key];
    return out;
}

function setRun(key: string, patch: Partial<EditRun>): void {
    useEditStore.setState((s) => (s.runs[key] ? { runs: { ...s.runs, [key]: { ...s.runs[key], ...patch } } } : s));
}

function putRun(run: EditRun): void {
    useEditStore.setState((s) => ({ runs: { ...s.runs, [run.key]: run } }));
}

/** The run gets its job's id as key (the card looks it up by job). */
function rekey(oldKey: string, jobId: string): string {
    const local = locals.get(oldKey);
    if (local) {
        locals.delete(oldKey);
        locals.set(jobId, local);
    }
    useEditStore.setState((s) => {
        const run = s.runs[oldKey];
        return run ? { runs: { ...without(s.runs, oldKey), [jobId]: { ...run, key: jobId, jobId } } } : s;
    });
    return jobId;
}

function dropLocal(key: string): void {
    const local = locals.get(key);
    local?.handle?.dispose();
    locals.delete(key);
}

// ---------- the chat ----------

const newId = (): string => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function message(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
    return { id: newId(), role, content, timestamp: new Date(deps.now()).toISOString(), ...extra };
}

/** Writes a new assistant line only while the project is still the one on screen (the chat is its own data). */
function say(projectId: string, content: string, extra: Partial<ChatMessage> = {}): string | null {
    const store = useWorkspaceStore.getState();
    if (store.activeProjectId !== projectId) return null;
    const m = message("assistant", content, extra);
    store.addMessage(m);
    return m.id;
}

const MUSE_LINE = "Editing with **Muse Spark**.";

/** The assistant message now points at the job (and the card appears). */
function attachJob(projectId: string, replyId: string | null, job: Job): void {
    const store = useWorkspaceStore.getState();
    if (store.activeProjectId !== projectId) return;
    if (replyId) store.updateMessage(replyId, { content: MUSE_LINE, job_ids: [job.id] });
    else store.addMessage(message("assistant", MUSE_LINE, { job_ids: [job.id] }));
    applyJob(job);
    void saveNow();
    void refreshProviders();
}

/** A start that failed leaves a plain explanation where the card would have been. */
function explainStartFailure(projectId: string, replyId: string | null, text: string): void {
    const store = useWorkspaceStore.getState();
    if (store.activeProjectId !== projectId) return;
    if (replyId) store.updateMessage(replyId, { content: text });
    else store.addMessage(message("assistant", text));
}

async function withAccessCode<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (err) {
        // The stored code was refused: forget it, then ask once and try again.
        if (err instanceof ApiRequestError && err.status === 401) {
            clearAccessCode();
            if (await deps.requestAccessCode()) return work();
        }
        throw err;
    }
}

function startFailureToast(err: unknown): void {
    if (err instanceof ApiRequestError && err.status === 429) toast.warning("Daily limit reached", { description: err.message, duration: 9000 });
    else if (err instanceof ApiRequestError && err.status === 401) toast.error("Access code required", { description: "Enter the access code to edit models." });
    else toast.error("Could not start the edit", { description: errorText(err) });
}

// ---------- starting ----------

export interface StartEditArgs {
    projectId: string;
    modelId: string;
    target: EditTargetKind;
    instruction: string;
}

/**
 * Starts an edit of `modelId` by the words in `instruction`: writes the person's message and the assistant's reply into the chat, then runs
 * the target's flow (see the top of this file). Does nothing visible when another mesh edit of the project is still going.
 */
export async function startDesignOrMeshEdit(a: StartEditArgs): Promise<void> {
    const instruction = a.instruction.replace(/\s+/g, " ").trim();
    const store = useWorkspaceStore.getState();
    if (!instruction || instruction.length > EDIT_INSTRUCTION_MAX) {
        toast.error("That is too long", { description: `Describe the change in at most ${EDIT_INSTRUCTION_MAX} characters.` });
        return;
    }
    const source = store.models.find((m) => m.id === a.modelId);
    if (store.activeProjectId !== a.projectId || !source) return;
    if (a.target === "mesh" && meshEditBusy(a.projectId)) {
        toast.info("Another edit is still running", { description: "Wait for it to finish, or stop it first." });
        return;
    }

    // A failure before a job existed left its card behind (for "try again" and "generate it again"); a new edit replaces it.
    const failed = Object.values(useEditStore.getState().runs).filter((r) => r.jobId === null && r.projectId === a.projectId && r.status === "error");
    if (failed.length > 0) useEditStore.setState((s) => ({ runs: failed.reduce((rest, r) => without(rest, r.key), s.runs) }));
    store.addMessage(message("user", instruction));
    const replyId = say(a.projectId, EDIT_START_LINES[a.target]);
    void saveNow();
    if (a.target === "design") await startDesign(a, source, instruction, replyId);
    else await startMesh(a, source, instruction, replyId);
}

async function startDesign(a: StartEditArgs, source: ModelAsset, instruction: string, replyId: string | null): Promise<void> {
    try {
        const job = await withAccessCode(() => deps.startEdit(source.id, { instruction, target: "design" }));
        attachJob(a.projectId, replyId, job);
    } catch (err) {
        startFailureToast(err);
        explainStartFailure(a.projectId, replyId, `I couldn't start that edit: ${errorText(err)}`);
        void refreshProviders();
    }
}

/** The package must fit the server's limit: PNG first, then JPEG where the browser can encode it, then smaller pictures. */
async function describeWithinLimit(handle: MeshEditHandle, signal: AbortSignal): Promise<MeshPackage> {
    const first = deps.pictureFormat();
    const tries: Array<{ format: "png" | "jpeg"; size?: number }> = first === "png" ? [{ format: "png" }, { format: "jpeg" }, { format: "jpeg", size: 384 }] : [{ format: "jpeg" }, { format: "png" }, { format: "jpeg", size: 384 }];
    let last: MeshPackage | null = null;
    for (const t of tries) {
        const pkg = await handle.describe(t.format, signal, t.size);
        last = pkg;
        if (JSON.stringify(pkg).length <= EDIT_PACKAGE_LIMIT) return pkg;
    }
    return last as MeshPackage;
}

async function startMesh(a: StartEditArgs, source: ModelAsset, instruction: string, replyId: string | null): Promise<void> {
    const key = `pending-${++counter}`;
    const controller = new AbortController();
    locals.set(key, { controller, handle: null, glb: null });
    putRun({
        key, jobId: null, projectId: a.projectId, sourceModelId: source.id, instruction, target: "mesh", status: "describing", startedAt: deps.now(),
        step: null, stage: null, summary: null, notes: [], errorKind: null, error: null, savedModelId: null, regenPrompt: null, resultBytes: null, refined: false, hasLocalResult: false,
    });
    let current = key;
    try {
        const bytes = await deps.fetchModelBytes(source.glb_url, controller.signal);
        const handle = await deps.openMeshEdit(bytes, { originalPrompt: source.prompt, signal: controller.signal });
        const local = locals.get(key);
        if (!local) {
            handle.dispose();
            return;
        }
        local.handle = handle;
        const pkg = await describeWithinLimit(handle, controller.signal);
        const job = await withAccessCode(() => deps.startEdit(source.id, { instruction, target: "mesh", mesh: pkg }, controller.signal));
        current = rekey(key, job.id);
        setRun(current, { status: "planning" });
        attachJob(a.projectId, replyId, job);
    } catch (err) {
        if (isAbort(err)) {
            finishStopped(current, a.projectId, replyId);
            return;
        }
        const failure = failureOf(err, "start");
        setRun(current, { status: "error", errorKind: failure.kind, error: failure.message });
        dropLocal(current);
        if (failure.kind === "start") startFailureToast(err);
        // (The file-format words in brackets are for the card's tooltip, not for the chat.)
        explainStartFailure(a.projectId, replyId, failure.kind === "start" ? `I couldn't start that edit: ${failure.message}` : splitTechnical(failure.message).plain);
        void refreshProviders();
    }
}

/** The person stopped it before a job existed (or the page left the project): nothing is kept. */
function finishStopped(key: string, projectId: string, replyId: string | null): void {
    const run = useEditStore.getState().runs[key];
    dropLocal(key);
    useEditStore.setState((s) => ({ runs: without(s.runs, key) }));
    explainStartFailure(projectId, replyId, "Stopped.");
    // A Stop is "not now", not "never mind": the words go back to the box (of the project on screen; leaving one is not a Stop).
    if (run && useWorkspaceStore.getState().activeProjectId === projectId) useWorkspaceStore.getState().restoreDraft(run.instruction);
}

// ---------- planning is over: run it ----------

async function resultOf(job: Job): Promise<EditResult | null> {
    if (job.edit?.result) return job.edit.result;
    try {
        return (await deps.getJob(job.id)).edit?.result ?? null;
    } catch {
        return null;
    }
}

/** A planning job reached an end (seen through the workspace store, which the job polling feeds). */
async function onPlanJob(key: string, job: Job): Promise<void> {
    const run = useEditStore.getState().runs[key];
    if (!run || run.status !== "planning") return;
    if (job.status === "queued" || job.status === "running" || job.status === "finalizing") return;
    if (job.status === "failed") {
        setRun(key, { status: "error", errorKind: "plan", error: job.error || "The edit could not be planned." });
        dropLocal(key);
        return;
    }
    if (job.status === "canceled") {
        // The card follows the canceled job and says "Stopped.".
        dropLocal(key);
        useEditStore.setState((s) => ({ runs: without(s.runs, key) }));
        return;
    }
    // Claim the run before anything is awaited: the store may call again with the same job.
    setRun(key, { status: "applying" });
    const result = await resultOf(job);
    if (!result) {
        setRun(key, { status: "error", errorKind: "plan", error: "The plan for this edit is missing. Try again." });
        dropLocal(key);
        return;
    }
    if (!result.applied || !result.program || result.program.ops.length === 0) {
        setRun(key, { status: "noop", summary: result.summary, notes: result.notes, regenPrompt: regeneratePrompt(sourceOf(run), run.instruction, result) });
        dropLocal(key);
        return;
    }
    setRun(key, { summary: result.summary, notes: result.notes, regenPrompt: regeneratePrompt(sourceOf(run), run.instruction, result) });
    if (MESH_REFINE_OPS.length > 0 && !run.refined && needsRefine(result.program)) {
        await refine(key, job, result.program);
        return;
    }
    await runAndSave(key, job, result.program);
}

const sourceOf = (run: Pick<EditRun, "sourceModelId">): Pick<ModelAsset, "prompt"> => useWorkspaceStore.getState().models.find((m) => m.id === run.sourceModelId) ?? { prompt: "" };

/** The second pass: zoomed pictures of the first selection, and the model corrects the program (a new job; the run follows it). */
async function refine(key: string, job: Job, program: MeshProgram): Promise<void> {
    const local = locals.get(key);
    const run = useEditStore.getState().runs[key];
    if (!local?.handle || !run) return;
    setRun(key, { status: "refining", refined: true });
    try {
        const views = await local.handle.zoom(program, deps.pictureFormat(), local.controller.signal);
        const next = await withAccessCode(() => deps.startEdit(run.sourceModelId, { instruction: run.instruction, target: "mesh", refine: { of_job_id: job.id, program, views } }, local.controller.signal));
        const current = rekey(key, next.id);
        setRun(current, { status: "planning" });
        const store = useWorkspaceStore.getState();
        // The chat's reply follows the newest job; the first one stays in the list as a finished card.
        const reply = [...store.messages].reverse().find((m) => m.job_ids?.includes(job.id));
        if (reply && store.activeProjectId === run.projectId) store.updateMessage(reply.id, { job_ids: [...(reply.job_ids ?? []).filter((id) => id !== job.id), next.id] });
        applyJob(next);
    } catch (err) {
        if (isAbort(err)) return;
        // The first program is still good enough to try: the second pass is an improvement, not a requirement.
        setRun(key, { status: "applying" });
        await runAndSave(key, job, program);
    }
}

async function runAndSave(key: string, job: Job, program: MeshProgram): Promise<void> {
    const run = useEditStore.getState().runs[key];
    const local = locals.get(key);
    if (!run || !local?.handle) {
        setRun(key, { status: "error", errorKind: "apply", error: "The model is no longer open. Apply the plan again." });
        dropLocal(key);
        return;
    }
    try {
        setRun(key, { status: "applying", step: null, stage: null });
        const options: RunOptions = {
            program,
            instruction: run.instruction,
            jobId: job.id,
            signal: local.controller.signal,
            onProgress: (progress) => {
                if ("stage" in progress) setRun(key, { stage: progress.stage });
                else setRun(key, { step: { index: progress.index, total: progress.total, label: progress.label }, stage: null });
            },
        };
        const out = await local.handle.run(options);
        local.glb = out.glb;
        local.handle.dispose();
        local.handle = null;
        const notes = [...new Set([...run.notes, ...out.notes])].slice(0, 8);
        setRun(key, { notes, resultBytes: out.glb.byteLength, step: null, stage: null, hasLocalResult: true });
        await save(key, job.id);
    } catch (err) {
        if (isAbort(err)) {
            // Stopped while applying: the plan stays on the job ("Plan ready, apply?" after a reload).
            setRun(key, { status: "error", errorKind: "apply", error: "Stopped." });
            dropLocal(key);
            return;
        }
        const failure = failureOf(err, "apply");
        setRun(key, { status: "error", errorKind: failure.kind, error: failure.message, step: null, stage: null });
        dropLocal(key);
    }
}

/** Uploads the local result. Also the retry after a failed upload (the job id makes it safe to repeat). */
async function save(key: string, jobId: string): Promise<void> {
    const run = useEditStore.getState().runs[key];
    const local = locals.get(key);
    if (!run || !local?.glb) return;
    const { projectId, sourceModelId } = run;
    setRun(key, { status: "saving", errorKind: null, error: null });
    try {
        const model = await deps.uploadEditedMesh(sourceModelId, jobId, local.glb, local.controller.signal);
        local.glb = null;
        dropLocal(key);
        const workspace = useWorkspaceStore.getState();
        setRun(key, { status: "saved", savedModelId: model.id, hasLocalResult: false });
        if (workspace.activeProjectId !== projectId) {
            // The server has it; this screen is another project's.
            toast.info("Saved an edited model", { description: "It is in the project you left." });
            return;
        }
        workspace.addModel(model);
        workspace.setActiveModel(model.id);
        // The reply that points at the model, once (the same upload twice comes back as the same model).
        if (!workspace.messages.some((m) => m.model_ids?.includes(model.id))) {
            workspace.addMessage(message("assistant", savedLine(model.edit?.summary ?? run.summary ?? ""), { model_ids: [model.id] }));
        }
        toast.success("Edited");
        void saveNow();
    } catch (err) {
        if (isAbort(err)) {
            setRun(key, { status: "error", errorKind: "save", error: "Stopped." });
            return;
        }
        const failure = failureOf(err, "save");
        setRun(key, { status: "error", errorKind: "save", error: failure.message });
        toast.error("Could not save the edited model", { description: failure.message });
    }
}

// ---------- the card's actions ----------

/** "Apply" on a plan that was made but never run (the page was closed in between): run it on the model, then save. */
export async function applyStoredPlan(jobId: string): Promise<void> {
    const store = useWorkspaceStore.getState();
    const job = store.jobs[jobId];
    if (!job || job.edit === null) return;
    const result = applicablePlan(job) ?? (await resultOf(job).then((r) => (r?.applied && r.program && r.program.ops.length > 0 ? r : null)));
    const source = store.models.find((m) => m.id === job.edit?.source_model_id);
    if (!result?.program || !source) {
        toast.error("This plan can no longer be applied", { description: "The model it was made for is gone." });
        return;
    }
    if (meshEditBusy(job.project_id)) {
        toast.info("Another edit is still running", { description: "Wait for it to finish, or stop it first." });
        return;
    }
    const key = jobId;
    const controller = new AbortController();
    locals.set(key, { controller, handle: null, glb: null });
    putRun({
        key, jobId, projectId: job.project_id, sourceModelId: source.id, instruction: job.prompt, target: "mesh", status: "applying", startedAt: deps.now(),
        step: null, stage: null, summary: result.summary, notes: result.notes, errorKind: null, error: null, savedModelId: null,
        regenPrompt: regeneratePrompt(source, job.prompt, result), resultBytes: null, refined: true, hasLocalResult: false,
    });
    try {
        const bytes = await deps.fetchModelBytes(source.glb_url, controller.signal);
        const handle = await deps.openMeshEdit(bytes, { originalPrompt: source.prompt, signal: controller.signal });
        const local = locals.get(key);
        if (!local) {
            handle.dispose();
            return;
        }
        local.handle = handle;
        await runAndSave(key, job, result.program);
    } catch (err) {
        if (isAbort(err)) {
            setRun(key, { status: "error", errorKind: "apply", error: "Stopped." });
            dropLocal(key);
            return;
        }
        const failure = failureOf(err, "apply");
        setRun(key, { status: "error", errorKind: failure.kind, error: failure.message });
        dropLocal(key);
    }
}

/** Retry the upload of a result that is still here. */
export async function retrySave(jobId: string): Promise<void> {
    const run = useEditStore.getState().runs[jobId];
    if (!run || run.status !== "error" || run.errorKind !== "save" || !locals.get(jobId)?.glb) return;
    await save(jobId, jobId);
}

/** Stops the edit's job on the server (a design edit, or a plan made while this page had no run for it). */
async function cancelOnServer(jobId: string): Promise<void> {
    try {
        applyJob(await withAccessCode(() => deps.cancelJob(jobId)));
    } catch (err) {
        // A job the vendor cannot stop keeps going: its plan then waits as "Plan ready, apply?".
        if (!(err instanceof ApiRequestError && err.status === 409)) toast.error("Could not stop the edit", { description: errorText(err) });
    }
}

/** The Stop button: ends the local work, and the plan if it is still being made. `id`: the job's id (or a run's key before it has a job). */
export async function stopEdit(id: string): Promise<void> {
    const run = useEditStore.getState().runs[id];
    if (!run) {
        await cancelOnServer(id);
        return;
    }
    if (!BUSY.includes(run.status) || run.status === "saving") return;
    locals.get(id)?.controller.abort();
    // Applying: the abort ends the run, and the plan stays on the job. Planning: the job itself is stopped too.
    if (run.status !== "planning") return;
    // The run goes and the card follows the canceled job ("Stopped."), not an error with a "try again".
    dropLocal(id);
    useEditStore.setState((s) => ({ runs: without(s.runs, id) }));
    await cancelOnServer(id);
}

/** Offer the local result as a file (a failed save): true when there was one. */
export function downloadLocalResult(jobId: string, fileName = "edited-model.glb"): boolean {
    const glb = locals.get(jobId)?.glb;
    if (!glb) return false;
    const url = URL.createObjectURL(new Blob([new Uint8Array(glb)], { type: "model/gltf-binary" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
}

/**
 * Undo: delete the edited version and go back to the model it was made from. Only for a version nothing was made from ("blocked" otherwise,
 * with a toast): deleting a version deletes the versions made from it too, and one button in the chat must not take a stabilized or optimized
 * version with it without a word (the Models tab asks first: DeleteVersionDialog).
 */
export async function undoEdit(model: ModelAsset): Promise<"undone" | "gone" | "failed" | "blocked"> {
    const store = useWorkspaceStore.getState();
    const family = familyOf(store.models, model.id);
    if (family.length > 1) {
        toast.info("Other versions were made from this one", { description: "Delete it in the Models tab to remove it together with them." });
        return "blocked";
    }
    let outcome: "undone" | "gone" = "undone";
    try {
        await deps.deleteModel(model.id);
    } catch (err) {
        // Already deleted (another tab, or the project was purged): the end state is the same.
        if (err instanceof ApiRequestError && err.status === 404) outcome = "gone";
        else {
            toast.error("Could not undo the edit", { description: errorText(err) });
            return "failed";
        }
    }
    useWorkspaceStore.getState().removeModels(family, model.source_model_id);
    useEditStore.setState((s) => ({ undone: { ...s.undone, [model.id]: true } }));
    toast(outcome === "gone" ? "Version deleted" : "Undone");
    return outcome;
}

/**
 * "Try again" after a start or a plan that failed through no fault of the words: they go back to the box, on the version they were meant for
 * (3D tab, Edit chosen, the cursor there; a phone leaves for the chat), so they can be changed or sent as they are.
 */
export function restoreEditWords(instruction: string, sourceModelId: string | null): void {
    const workspace = useWorkspaceStore.getState();
    const source = sourceModelId ? workspace.models.find((m) => m.id === sourceModelId) : undefined;
    if (source) editVersion(source);
    else {
        workspace.setComposerChoice("edit");
        workspace.requestComposerFocus();
    }
    useWorkspaceStore.getState().restoreDraft(instruction);
}

/** Remove a finished or failed run's card state (the card goes back to what the job says). */
export function dismissRun(jobId: string): void {
    dropLocal(jobId);
    useEditStore.setState((s) => ({ runs: without(s.runs, jobId) }));
}

// ---------- following the workspace ----------

/** The user left the project: local work stops, an upload that is under way finishes. */
function leaveProject(projectId: string | null): void {
    if (!projectId) return;
    for (const run of Object.values(useEditStore.getState().runs)) {
        if (run.projectId !== projectId) continue;
        if (run.status === "saving") continue;
        if (BUSY.includes(run.status)) locals.get(run.key)?.controller.abort();
        dropLocal(run.key);
        useEditStore.setState((s) => ({ runs: without(s.runs, run.key) }));
    }
}

useWorkspaceStore.subscribe((state, prev) => {
    if (state.activeProjectId !== prev.activeProjectId) {
        leaveProject(prev.activeProjectId);
        return;
    }
    if (state.jobs === prev.jobs) return;
    for (const run of Object.values(useEditStore.getState().runs)) {
        if (run.status !== "planning" || !run.jobId) continue;
        const job = state.jobs[run.jobId];
        if (job && job !== prev.jobs[run.jobId]) void onPlanJob(run.key, job);
    }
});
