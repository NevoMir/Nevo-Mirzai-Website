// One piece of long work on the model at a time. A stabilizer run, a block edit (its proposal and the draft it leaves) and an optimizer run
// all draw on the stage, put a preview there and end in a new version; two at once would fight over the preview and over which version
// they start from. Each store takes the guard before it starts (`acquireWork`) and gives it back when it ends; the second asks and is told
// to finish or discard the first.
//
// The guard belongs to the project it was taken in: opening another project (or a new chat) drops it, as it drops the work (every one of
// these runs stops when its project is left). Taking the guard again for the same kind and project is allowed (the router holds it while a
// request is out, the store holds it for the draft); it is free when every taker has given it back.

import { create } from "zustand";

import { TERMINAL_JOB_STATUSES } from "@/assignment/shared/contract";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

export type WorkKind = "stabilize" | "blocks" | "optimize";

/** What a caller may tell the guard about its work: how the run chip words it, and how to stop it. */
export interface WorkOptions {
    /** The run chip's words ("Optimizing"); the kind's own words stand in. */
    label?: string;
    /** Stops the work (the chip's Stop button); without it the chip has none. */
    stop?: () => void;
}

export interface WorkHold {
    kind: WorkKind;
    projectId: string;
    /** When the work began (Date.now()). */
    since: number;
    label: string | null;
    stop: (() => void) | null;
    /** The work has ended and a result waits for a decision (Keep or Discard): the tab shows a dot, not a spinner. */
    waiting: boolean;
}

interface Held extends WorkHold {
    token: number;
    holders: number;
}

interface GuardState {
    held: Held | null;
}

const useGuard = create<GuardState>()(() => ({ held: null }));

/** The nouns of "Finish or discard the ... first." */
const WORK_NOUN: Record<WorkKind, string> = {
    stabilize: "stabilizing",
    blocks: "block changes",
    optimize: "optimization",
};

/** The chip's words while the work runs. */
export const WORK_CHIP_WORDS: Record<WorkKind, string> = {
    stabilize: "Stabilizing",
    blocks: "Changing the blocks",
    optimize: "Optimizing",
};

let counter = 0;

/** An edit job of the project (a change of a design or a mesh, on the queue) is still running: it will end in a new version too. */
function editJobRunning(projectId: string): boolean {
    return Object.values(useWorkspaceStore.getState().jobs).some(
        (job) => job.project_id === projectId && job.kind === "edit" && !TERMINAL_JOB_STATUSES.includes(job.status),
    );
}

/**
 * Take the guard for `kind` in `projectId`. Returns the function that gives it back (call it once, when the work ends or is thrown away), or
 * null when other work holds it: say so with `workBusyMessage()`.
 */
export function acquireWork(kind: WorkKind, projectId: string, options: WorkOptions = {}): (() => void) | null {
    const held = useGuard.getState().held;
    // A change of the design or the mesh is on its way: it makes a version of its own, which this work would not start from.
    if (editJobRunning(projectId)) return null;
    // Another project's hold is stale (its work stopped when that project was left): the workspace shows one project.
    if (held && held.projectId === projectId && held.kind !== kind) return null;
    let token: number;
    if (held && held.projectId === projectId) {
        token = held.token;
        useGuard.setState({
            held: { ...held, holders: held.holders + 1, label: options.label ?? held.label, stop: options.stop ?? held.stop },
        });
    } else {
        token = ++counter;
        useGuard.setState({
            held: { kind, projectId, since: Date.now(), label: options.label ?? null, stop: options.stop ?? null, waiting: false, token, holders: 1 },
        });
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const now = useGuard.getState().held;
        if (!now || now.token !== token) return;
        if (now.holders > 1) useGuard.setState({ held: { ...now, holders: now.holders - 1 } });
        else useGuard.setState({ held: null });
    };
}

/** The work of `kind` has ended and a result waits for a decision (or goes back to running). The Optimization tab shows a dot for the first, a spinner for the second. */
export function setWorkWaiting(kind: WorkKind, waiting: boolean): void {
    const held = useGuard.getState().held;
    if (!held || held.kind !== kind || held.waiting === waiting) return;
    useGuard.setState({ held: { ...held, waiting } });
}

/** The work holding the guard right now, if any. */
export function currentWork(): WorkHold | null {
    return useGuard.getState().held;
}

/** The same as a hook, for the run chip and the buttons that start work. */
export function useCurrentWork(): WorkHold | null {
    return useGuard((s) => s.held);
}

/** Would `acquireWork(kind, projectId)` be refused? The sentence to show if so, else null. */
export function workBusyMessage(kind: WorkKind, projectId: string | null): string | null {
    if (projectId !== null && editJobRunning(projectId)) return "Wait for the change to finish first.";
    const held = useGuard.getState().held;
    if (!held || held.projectId !== projectId || held.kind === kind) return null;
    return `Finish or discard the ${WORK_NOUN[held.kind]} first.`;
}

/** Is any work holding the guard in this project? A change of a design or a mesh may start only when nothing is: the sentence if so, else null. */
export function anyWorkMessage(projectId: string | null): string | null {
    const held = useGuard.getState().held;
    if (!held || held.projectId !== projectId) return null;
    return `Finish or discard the ${WORK_NOUN[held.kind]} first.`;
}

/** Forget everything (tests). */
export function resetWorkGuard(): void {
    useGuard.setState({ held: null });
}

// Opening another project, or a new chat, ends the work of the one that was open.
useWorkspaceStore.subscribe((state, prev) => {
    if (state.activeProjectId !== prev.activeProjectId && useGuard.getState().held) useGuard.setState({ held: null });
});
