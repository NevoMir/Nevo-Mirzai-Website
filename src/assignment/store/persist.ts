// Autosave: the chat and the model on screen are written back with a debounced
// PATCH /projects/:id { data }. The store's `revision` counter says when something worth saving
// changed, so opening a project never counts as an edit (a data PATCH bumps modified_at, which
// would float every project you merely look at to the top of the hub).
//
// Every PATCH carries the whole chat, so the order in which two of them land decides what the
// server keeps. Writes for one project therefore go through `ordered` (each waits for the one
// before it), and a project is only marked saved by a write that actually succeeded.

import { useEffect } from "react";

import { patchProject } from "@/assignment/lib/api";
import type { ProjectData } from "@/assignment/shared/contract";
import { projectDataOf, useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const DEBOUNCE_MS = 900;
/** After a failed save, try again with a growing pause, up to this. */
const MAX_RETRY_MS = 20_000;
/** Browsers refuse a keepalive request whose body is over 64 KB. */
const KEEPALIVE_MAX_BYTES = 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** True while the workspace page is mounted: a retry that comes due after it left must not save. */
let mounted = false;
/** The revision each project's regular save is writing: one save per project at a time. */
const saving = new Map<string, number>();
/** The revision of an exit flush in flight, per project (so a debounced save does not repeat it). */
const flushing = new Map<string, number>();
/** Consecutive failed saves per project, for the retry pause. */
const failures = new Map<string, number>();
/** The last write queued for each project. */
const tails = new Map<string, Promise<unknown>>();

function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
}

function schedule(delay = DEBOUNCE_MS): void {
    clearTimer();
    if (!mounted) return;
    timer = setTimeout(() => void saveNow(), delay);
}

/**
 * Run a write after the ones already queued for this project. `immediate` (a page that is being
 * hidden or closed cannot wait for a slow request in front of it) goes straight out.
 */
function ordered<T>(id: string, write: () => Promise<T>, immediate = false): Promise<T> {
    const previous = tails.get(id);
    const run = immediate || !previous ? write() : previous.then(write, write);
    tails.set(id, run);
    const forget = () => {
        if (tails.get(id) === run) tails.delete(id);
    };
    run.then(forget, forget);
    return run;
}

/** Resolves once every write already queued for this project has landed (or failed). */
export function whenSaved(id: string): Promise<void> {
    const tail = tails.get(id);
    return tail ? tail.then(() => undefined, () => undefined) : Promise.resolve();
}

const fitsKeepalive = (data: ProjectData): boolean =>
    new TextEncoder().encode(JSON.stringify(data)).length <= KEEPALIVE_MAX_BYTES;

/**
 * Write a chat that belongs to a project that is not on screen (a send that finished after the
 * user opened another one). Lets the request outlive the page when it is small enough to.
 */
export function writeProjectData(id: string, data: ProjectData): Promise<unknown> {
    return ordered(id, () => patchProject(id, { data }, { keepalive: fitsKeepalive(data) }));
}

/** Write the open project's unsaved changes now. Safe to call any time: it does nothing when clean. */
export async function saveNow(): Promise<void> {
    clearTimer();
    const store = useWorkspaceStore.getState();
    const id = store.activeProjectId;
    if (!id || store.revision === store.savedRevision) return;
    // One save at a time per project; the one in flight looks again when it ends.
    if (saving.has(id) || flushing.get(id) === store.revision) return;

    const { revision, session } = store;
    const data = projectDataOf(store);
    saving.set(id, revision);
    store.setSaveStatus("saving");
    try {
        const saved = await ordered(id, () => patchProject(id, { data }));
        failures.delete(id);
        const now = useWorkspaceStore.getState();
        // Not if the chat was replaced meanwhile (the same project reopened): its counters restarted.
        if (now.activeProjectId === id && now.session === session) {
            now.markSaved(revision);
            now.updateProjectMeta({ modified_at: saved.modified_at }, id);
            now.setSaveStatus("saved");
        }
    } catch (err) {
        console.warn("Could not save the project", err);
        const count = (failures.get(id) ?? 0) + 1;
        failures.set(id, count);
        const now = useWorkspaceStore.getState();
        if (now.activeProjectId === id && now.session === session) {
            now.setSaveStatus("error");
            schedule(Math.min(MAX_RETRY_MS, 2000 * 2 ** (count - 1)));
        }
    } finally {
        saving.delete(id);
        // Whatever the project on screen has collected meanwhile goes out next: its own newer edits,
        // or another project's edit whose save was skipped because this one was still in flight.
        const now = useWorkspaceStore.getState();
        if (
            !timer &&
            now.activeProjectId &&
            now.revision !== now.savedRevision &&
            !failures.get(now.activeProjectId)
        ) {
            schedule();
        }
    }
}

/**
 * Save from a page that is going away. `immediate`: the tab is being hidden or closed, so the
 * request goes out at once and (when small enough) with keepalive, which lets it finish after unload.
 * The edits count as saved only when the write succeeds.
 */
function flushOnExit(immediate: boolean): void {
    const store = useWorkspaceStore.getState();
    const id = store.activeProjectId;
    if (!id || store.revision === store.savedRevision) return;
    // A save of exactly this content is already on its way.
    if (saving.get(id) === store.revision || flushing.get(id) === store.revision) return;

    const { revision, session } = store;
    const data = projectDataOf(store);
    flushing.set(id, revision);
    ordered(id, () => patchProject(id, { data }, { keepalive: fitsKeepalive(data) }), immediate)
        .then(() => {
            const now = useWorkspaceStore.getState();
            if (now.activeProjectId === id && now.session === session) now.markSaved(revision);
        })
        .catch((err: unknown) => {
            console.warn("Could not save the project on exit", err);
            // Still unsaved: the next look at the tab, or the next edit, writes it again.
            const now = useWorkspaceStore.getState();
            if (now.activeProjectId === id && now.session === session && !timer) schedule(2000);
        })
        .finally(() => {
            if (flushing.get(id) === revision) flushing.delete(id);
            // Edits made while it was on its way still need their own save.
            const now = useWorkspaceStore.getState();
            if (!timer && now.activeProjectId && now.revision !== now.savedRevision && !failures.get(now.activeProjectId)) {
                schedule();
            }
        });
}

/**
 * Mounted once by the workspace page. Watches `revision`, saves leaving-project changes to the
 * project they belong to, and flushes when the tab hides or the page unmounts.
 */
export function useAutosave(): void {
    useEffect(() => {
        mounted = true;
        const unsubscribe = useWorkspaceStore.subscribe((state, prev) => {
            // Moving to another project (or a new chat) with edits not yet written: write them to
            // THEIR project, not the one that is opening.
            const left = prev.activeProjectId;
            if (left && left !== state.activeProjectId && prev.revision !== prev.savedRevision) {
                clearTimer();
                if (saving.get(left) !== prev.revision) {
                    const data = projectDataOf(prev);
                    ordered(left, () => patchProject(left, { data }, { keepalive: fitsKeepalive(data) })).catch(
                        (err: unknown) => console.warn("Could not save the project it was leaving", err),
                    );
                }
            }
            if (!state.activeProjectId) {
                clearTimer();
                return;
            }
            if (state.revision !== prev.revision && state.revision !== state.savedRevision) schedule();
        });
        const onVisibility = () => {
            if (document.visibilityState === "hidden") flushOnExit(true);
        };
        const onPageHide = () => flushOnExit(true);
        document.addEventListener("visibilitychange", onVisibility);
        window.addEventListener("pagehide", onPageHide);
        return () => {
            unsubscribe();
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener("pagehide", onPageHide);
            // Leaving the workspace (to the hub) with a save still pending.
            flushOnExit(false);
            clearTimer();
            mounted = false;
        };
    }, []);
}
