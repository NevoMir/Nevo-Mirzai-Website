// Jobs: which ones belong to the newest prompt, and the single polling loop that drives them.
//
// The Worker has no queue or cron: GET /jobs/:id is what advances a job (at most one vendor call
// every ~3 s, and on success it copies the GLB into R2). So the page polls every running job of the
// OPEN project; when the user leaves a project, its jobs simply wait until it is opened again.

import { useEffect } from "react";

import { ApiRequestError, getJob } from "@/assignment/lib/api";
import { TERMINAL_JOB_STATUSES, type ChatMessage, type Job } from "@/assignment/shared/contract";
import { refreshProviders } from "@/assignment/store/providers";
import { activeJobsOf, useIsGenerating, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const POLL_MS = 2500;
/** A poll that fails keeps its place in the loop but backs off, up to this. */
const MAX_BACKOFF_MS = 12_000;
/** A poll that gets no answer at all (a dead connection can hang for minutes) is given up on after this. */
const POLL_TIMEOUT_MS = 15_000;

/** AbortSignal.timeout where the browser has it (Safari before 16 does not): a poll then simply has no timeout. */
const timeoutSignal = (ms: number): AbortSignal | undefined =>
    typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

export const isTerminalJob = (job: Pick<Job, "status">): boolean => TERMINAL_JOB_STATUSES.includes(job.status);

/** The jobs the newest prompt started: the last assistant message that points at any. */
export function latestJobIds(messages: readonly ChatMessage[]): string[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        // A hole in the saved chat (anyone can write it) must not throw inside render.
        const message = messages[i];
        const ids = message?.job_ids;
        if (message?.role === "assistant" && Array.isArray(ids) && ids.length > 0) return ids;
    }
    return [];
}

/**
 * Models whose job this page watched go from running to done. Only those may replace a project's
 * cover image: any other browser that merely opens the project must not re-upload it.
 */
const completedHere = new Set<string>();

export const completedThisSession = (modelId: string): boolean => completedHere.has(modelId);

/**
 * Take a fresher copy of a job into the store. A job that has just succeeded also adds its model and, if nothing is on screen yet or it
 * is the first of the newest prompt to finish, shows it. An edit job (a change of a design or a mesh) shows its new version at once
 * (it was made from the one on screen); one that ends with a plan and no model leaves the plan on the job for its card to offer.
 */
export function applyJob(job: Job): void {
    const store = useWorkspaceStore.getState();
    // A poll that was in flight while the user opened another project.
    if (job.project_id !== store.activeProjectId) return;

    const before = store.jobs[job.id];
    if (before) {
        // A response that left before the one already applied (a poll that was in flight when Stop
        // was pressed, or when the project was left and reopened) must not bring a finished job
        // back to life or take a newer copy back in time.
        if (isTerminalJob(before) && !isTerminalJob(job)) return;
        if (Date.parse(job.updated_at) < Date.parse(before.updated_at)) return;
    }
    store.upsertJob(job);

    if (before && !isTerminalJob(before) && isTerminalJob(job)) void refreshProviders();

    if (job.status !== "succeeded" || !job.model || before?.status === "succeeded") return;
    // A job this page sees for the first time can already be done; one it loaded as finished cannot get here.
    if (!before || !isTerminalJob(before)) completedHere.add(job.model.id);
    store.addModel(job.model);

    const state = useWorkspaceStore.getState();
    if (job.kind === "edit") {
        // The change is what the person asked to see: its version goes on the stage, on the tab they are in (the Models tab has no stage).
        state.setActiveModel(job.model.id);
        if (state.workspaceTab === "models") state.setWorkspaceTab("3d");
        return;
    }
    const group = latestJobIds(state.messages);
    const firstOfGroup =
        group.includes(job.id) && !group.some((id) => id !== job.id && state.jobs[id]?.status === "succeeded");
    if (state.activeModelId === null || firstOfGroup) {
        state.setActiveModel(job.model.id);
        state.setWorkspaceTab("3d");
        // A new model is what the next words are about: the composer goes back to editing it.
        state.setComposerChoice(null);
    }
}

async function pollOne(job: Job, failures: Map<string, number>): Promise<void> {
    try {
        applyJob(await getJob(job.id, timeoutSignal(POLL_TIMEOUT_MS)));
        failures.delete(job.id);
    } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
            // The job is gone (its project was purged): show it as failed so the loop can end.
            applyJob({
                ...job,
                status: "failed",
                error: "This job no longer exists on the server.",
                finished_at: new Date().toISOString(),
            });
            failures.delete(job.id);
            return;
        }
        failures.set(job.id, (failures.get(job.id) ?? 0) + 1);
    }
}

/**
 * The polling loop, mounted once by the workspace page. It runs while the open project has a
 * running job (including right after a reload, which is how a run is picked up again) and ends
 * itself when none is left.
 */
export function useJobPolling(): void {
    const generating = useIsGenerating();
    const projectId = useWorkspaceStore((s) => s.activeProjectId);

    useEffect(() => {
        if (!generating) return;
        let cancelled = false;
        let busy = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const failures = new Map<string, number>();

        const tick = async () => {
            if (cancelled || busy) return;
            const jobs = activeJobsOf(useWorkspaceStore.getState());
            if (jobs.length === 0) return;
            busy = true;
            try {
                // pollOne never rejects: it counts the failure and carries on.
                await Promise.all(jobs.map((job) => pollOne(job, failures)));
            } finally {
                busy = false;
            }
            if (cancelled) return;
            const worst = Math.max(0, ...failures.values());
            timer = setTimeout(() => void tick(), Math.min(MAX_BACKOFF_MS, POLL_MS * (1 + worst)));
        };
        // A first look soon after the page (or the prompt) appears, then the steady beat.
        timer = setTimeout(() => void tick(), 800);

        // A hidden tab's timers are throttled to a crawl and a sleeping phone's are frozen: look at
        // once when the tab is shown again or the network returns, rather than at the next slow beat.
        const lookNow = () => {
            if (cancelled || busy || document.visibilityState === "hidden") return;
            clearTimeout(timer);
            failures.clear();
            void tick();
        };
        document.addEventListener("visibilitychange", lookNow);
        window.addEventListener("online", lookNow);
        return () => {
            cancelled = true;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", lookNow);
            window.removeEventListener("online", lookNow);
        };
    }, [generating, projectId]);
}
