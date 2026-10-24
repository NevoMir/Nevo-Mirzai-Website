// Sending a prompt, retrying a failed model, stopping a run: the writes the chat makes.
//
// They are plain functions over the workspace store (not hooks) because they outlive the component
// that called them: a send keeps going while the user switches project, the layout flips between
// phone and desktop, or the panel remounts.

import {
    ApiRequestError,
    bulkProjects,
    cancelJob,
    clearAccessCode,
    createProject,
    generate,
} from "@/assignment/lib/api";
import { toast } from "@/assignment/components/ui/sonner";
import type { ChatMessage, HubProject, Job, ProviderId } from "@/assignment/shared/contract";
import { applyJob, isTerminalJob, latestJobIds } from "@/assignment/store/jobs";
import { saveNow, writeProjectData } from "@/assignment/store/persist";
import { isCancelable, providerInfo, providerLabel, refreshProviders } from "@/assignment/store/providers";
import { replyContent } from "@/assignment/store/replies";
import { selectIsGenerating, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const PROJECT_NAME_MAX = 48;

export function newId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The prompt as a project name: on one line, at most 48 characters, cut at a word boundary. */
export function projectNameFromPrompt(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim();
    if (!flat) return "Untitled project";
    if (flat.length <= PROJECT_NAME_MAX) return flat;
    const room = flat.slice(0, PROJECT_NAME_MAX - 1);
    const space = room.lastIndexOf(" ");
    // A single very long word has no boundary to cut at: take the characters that fit.
    const cut = space >= 12 ? room.slice(0, space) : room;
    return `${cut.replace(/[\s,.;:!?-]+$/, "")}…`;
}

const errorText = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

export interface SendRequest {
    prompt: string;
    providers: ProviderId[];
    /** Seed tag for the project a first send creates (from the hub's tag page). */
    tagId?: string | null;
    /** Asks the visitor for the access code; resolves true once a valid one is stored. */
    requestAccessCode: () => Promise<boolean>;
}

export type SendOutcome =
    | { ok: true }
    /** Nothing was started. `restorePrompt`: give the text back to the composer. */
    | { ok: false; restorePrompt: boolean };

/** POST /generate; a rejected access code asks for a new one once and tries again. */
async function startJobs(
    projectId: string,
    prompt: string,
    providers: ProviderId[],
    requestAccessCode: () => Promise<boolean>,
): Promise<Job[]> {
    try {
        return await generate(projectId, { prompt, providers });
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 401) {
            // The stored code was refused: forget it, then ask.
            clearAccessCode();
            if (await requestAccessCode()) return generate(projectId, { prompt, providers });
        }
        throw err;
    }
}

function failureToast(err: unknown): void {
    if (err instanceof ApiRequestError && err.status === 429) {
        toast.warning("Daily limit reached", { description: err.message, duration: 9000 });
    } else if (err instanceof ApiRequestError && err.status === 401) {
        toast.error("Access code required", { description: "Enter the access code to generate models." });
    } else {
        toast.error("Could not start the generation", { description: errorText(err) });
    }
}

function replyFor(jobs: Job[], providers: ProviderId[], retry: boolean): ChatMessage {
    const info = useWorkspaceStore.getState().providers?.providers;
    return {
        id: newId(),
        role: "assistant",
        // What the run looked like when it started; the chat shows the line that fits the jobs now.
        content: replyContent(info, providers, retry),
        timestamp: new Date().toISOString(),
        job_ids: jobs.map((job) => job.id),
    };
}

const STARTED_ELSEWHERE = {
    description: "It continues in its own project. Open it to see the result.",
};

/**
 * The whole send: the user's message, the project row (first send), the jobs, the reply that points
 * at them. A send that cannot start is undone (message removed, prompt handed back).
 */
export async function sendPrompt(request: SendRequest): Promise<SendOutcome> {
    const prompt = request.prompt.trim();
    const store = useWorkspaceStore.getState();
    if (!prompt || store.sending) return { ok: false, restorePrompt: true };

    const userMessage: ChatMessage = {
        id: newId(),
        role: "user",
        content: prompt,
        timestamp: new Date().toISOString(),
    };
    // The chat as it was before this send: what a send that finishes in the background saves.
    const history = store.messages;
    const modelOnScreen = store.activeModelId;
    const ticket = store.beginSend();
    const wasSaved = store.revision === store.savedRevision;
    // Synchronously, so the first send flips the hero into the chat panel in the same tick.
    store.addMessage(userMessage);
    const revisionWithMessage = useWorkspaceStore.getState().revision;

    const undo = (): SendOutcome => {
        const now = useWorkspaceStore.getState();
        now.removeMessage(userMessage.id);
        // The chat is back to what the server already holds (nothing else changed meanwhile): that is
        // not an edit worth a save, which would only float the project to the top of the hub.
        const after = useWorkspaceStore.getState();
        if (wasSaved && after.revision === revisionWithMessage + 1) after.markSaved(after.revision);
        return { ok: false, restorePrompt: true };
    };

    try {
        let projectId = store.activeProjectId;
        if (!projectId) {
            let created: HubProject;
            try {
                created = await createProject({
                    name: projectNameFromPrompt(prompt),
                    ...(request.tagId ? { tag_id: request.tagId } : {}),
                });
            } catch (err) {
                toast.error("Could not create the project", { description: errorText(err) });
                return undo();
            }
            // New chat was pressed while the row was being made: the user has moved on, and the row
            // is empty, so it goes to the bin instead of sitting in the hub.
            if (!useWorkspaceStore.getState().messages.some((m) => m.id === userMessage.id)) {
                void bulkProjects([created.id], "trash").catch(() => {});
                return { ok: false, restorePrompt: false };
            }
            useWorkspaceStore.getState().adoptProject(created);
            projectId = created.id;
        }

        let jobs: Job[];
        try {
            jobs = await startJobs(projectId, prompt, request.providers, request.requestAccessCode);
        } catch (err) {
            failureToast(err);
            void refreshProviders();
            return useWorkspaceStore.getState().activeProjectId === projectId ? undo() : { ok: false, restorePrompt: false };
        }

        const reply = replyFor(jobs, request.providers, false);
        const now = useWorkspaceStore.getState();
        if (now.activeProjectId !== projectId) {
            // The user opened another project while the jobs started: the run belongs to its own
            // project, so write its chat there instead of into the one on screen.
            await writeProjectData(projectId, {
                messages: [...history, userMessage, reply],
                active_model_id: modelOnScreen,
            }).catch(() => {});
            toast.success("Generation started", STARTED_ELSEWHERE);
            return { ok: true };
        }
        // The same project was opened again meanwhile and came back from the server without this
        // prompt: put it back, or the reply would answer nobody.
        if (!now.messages.some((m) => m.id === userMessage.id)) now.addMessage(userMessage);
        // The reply first: a job that is already done is "the first of its prompt" only once the
        // reply that groups it exists.
        useWorkspaceStore.getState().addMessage(reply);
        jobs.forEach(applyJob);
        // The reply is what ties the jobs to this chat: write it now, not after the debounce.
        void saveNow();
        void refreshProviders();
        return { ok: true };
    } finally {
        useWorkspaceStore.getState().endSend(ticket);
    }
}

/** Run one model again on the same prompt (a failed or canceled card's Retry). */
export async function retryJob(job: Job, requestAccessCode: () => Promise<boolean>): Promise<void> {
    const store = useWorkspaceStore.getState();
    const projectId = store.activeProjectId;
    if (!projectId || store.sending) return;
    const ticket = store.beginSend();
    try {
        let jobs: Job[];
        try {
            jobs = await startJobs(projectId, job.prompt, [job.provider], requestAccessCode);
        } catch (err) {
            failureToast(err);
            void refreshProviders();
            return;
        }
        const now = useWorkspaceStore.getState();
        if (now.activeProjectId !== projectId) {
            toast.success("Generation started", STARTED_ELSEWHERE);
            return;
        }
        now.addMessage(replyFor(jobs, [job.provider], true));
        jobs.forEach(applyJob);
        void saveNow();
        void refreshProviders();
    } finally {
        useWorkspaceStore.getState().endSend(ticket);
    }
}

/** The jobs of the open project that are still running, the newest prompt's first. */
function runningJobs(): Job[] {
    const store = useWorkspaceStore.getState();
    const newest = latestJobIds(store.messages)
        .map((id) => store.jobs[id])
        .filter((job): job is Job => Boolean(job) && !isTerminalJob(job));
    // Nothing from the newest prompt is running (a queued send finished meanwhile): stop whatever is.
    return newest.length > 0
        ? newest
        : Object.values(store.jobs).filter((job) => job.project_id === store.activeProjectId && !isTerminalJob(job));
}

let stopping = false;

/**
 * Stop button: cancel the models of the newest prompt that are still running.
 *
 * Some providers (Tencent Hunyuan) cannot cancel a task that has started: the server leaves such a
 * job running, and so does this, since dropping it here would only hide a run that is still being
 * paid for. A prompt waiting in the queue is handed back to the box, never sent by the Stop itself.
 */
export async function stopGeneration(requestAccessCode: () => Promise<boolean>): Promise<void> {
    if (stopping) return;
    const store = useWorkspaceStore.getState();

    const queued = store.queuedPrompt;
    if (queued) {
        // Otherwise the moment this run ends, the queue would start a second paid one.
        store.setQueuedPrompt(null);
        store.restoreDraft(queued);
        toast.info("Queued prompt moved back to the box", { description: "It was not sent." });
    }

    const info = store.providers?.providers;
    const targets = runningJobs().filter((job) => isCancelable(providerInfo(info, job.provider), store.unstoppable));
    if (targets.length === 0) {
        if (runningJobs().length > 0) {
            toast.info("This model cannot be stopped", {
                description: "It keeps running at the provider. The result will appear here and in the Models tab.",
            });
        }
        return;
    }

    stopping = true;
    let asked: Promise<boolean> | null = null;
    // Stopping a paid run needs the access code, like starting one. One question for all the models.
    const askAgain = (): Promise<boolean> => {
        if (!asked) {
            clearAccessCode();
            asked = requestAccessCode();
        }
        return asked;
    };
    const outcome: { notStopped: string | null } = { notStopped: null };
    try {
        await Promise.all(
            targets.map(async (job) => {
                try {
                    let result: Job;
                    try {
                        result = await cancelJob(job.id);
                    } catch (err) {
                        if (!(err instanceof ApiRequestError && err.status === 401) || !(await askAgain())) throw err;
                        result = await cancelJob(job.id);
                    }
                    applyJob(result);
                    // The server answered but left it running: the provider could not cancel it.
                    if (!isTerminalJob(result)) {
                        useWorkspaceStore.getState().markUnstoppable(job.provider);
                        outcome.notStopped ??= `${providerLabel(info, job.provider)} cannot cancel a run that has started. It will finish and appear in the Models tab.`;
                    }
                } catch (err) {
                    if (err instanceof ApiRequestError && err.status === 409) {
                        // Remembered, so the Stop button stops being offered for this model.
                        useWorkspaceStore.getState().markUnstoppable(job.provider);
                        outcome.notStopped ??= err.message;
                    }
                    else if (err instanceof ApiRequestError && err.status === 401) failureToast(err);
                    else toast.error("Could not stop one of the models", { description: errorText(err) });
                }
            }),
        );
    } finally {
        stopping = false;
    }
    if (outcome.notStopped) toast.info("Not stopped", { description: outcome.notStopped });
    void refreshProviders();
}

/**
 * Leaving the open project (Home, a new project) while a model is still being made: it keeps going
 * at the provider, but this page only collects results for the project that is open.
 */
export function noteRunLeftBehind(): void {
    const state = useWorkspaceStore.getState();
    if (!selectIsGenerating(state) || state.project?.deleted_at) return;
    toast.info("Still generating", {
        description: "Your model keeps being made. Open this project again to collect it.",
        duration: 7000,
    });
}

/** New project, from the chat's own button or the shortcut. */
export function startNewProject(): void {
    noteRunLeftBehind();
    useWorkspaceStore.getState().startNewChat();
}
