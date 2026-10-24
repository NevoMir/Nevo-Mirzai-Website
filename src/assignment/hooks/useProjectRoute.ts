import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router";

import { ApiRequestError, getProject } from "@/assignment/lib/api";
import { toast } from "@/assignment/components/ui/sonner";
import { DELETED_PATH, HUB_PATH, isProjectId, projectPath } from "@/assignment/lib/projectPath";
import { whenSaved } from "@/assignment/store/persist";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/**
 * Two-way sync between the URL and the open project, so every project has a link and
 * a reload lands back on it:
 *
 *   /app/new     a new chat
 *   /app/<uuid>  the saved project with that id
 *
 * The URL drives loads (reload, deep link, Back/Forward, a hub click) and the store
 * drives the URL (the first send creating the row, "New chat"). Neither side acts
 * when the two already agree; that equality guard is what keeps the pair from
 * ping-ponging. Call it once, from the workspace page.
 */
export function useProjectRoute(): { projectId: string | null; loading: boolean; opening: boolean } {
    const { projectId } = useParams<{ projectId: string }>();
    const urlId = projectId ?? null;
    const navigate = useNavigate();
    const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
    const loadingProjectId = useWorkspaceStore((s) => s.loadingProjectId);

    // Effects read the URL of the render they run in. Refs let the store -> URL effect
    // compare without listing urlId as a dependency (which would make it fire on URL
    // changes, the other direction's job), and keep `navigate` (a new function on every
    // location change) from re-running either effect.
    const urlIdRef = useRef(urlId);
    urlIdRef.current = urlId;
    const navigateRef = useRef(navigate);
    navigateRef.current = navigate;
    /** False until the first URL -> store run has finished: a fresh mount always reloads, a URL change within the page may not. */
    const mountedRef = useRef(false);
    /** undefined until the first store -> URL run, then the last id it saw. */
    const prevActiveRef = useRef<string | null | undefined>(undefined);

    // Effect A: URL -> store.
    useEffect(() => {
        const fresh = !mountedRef.current;
        const store = useWorkspaceStore.getState();

        if (urlId === null) {
            // /app/new with a project still open (Back, the hub's New project): start over.
            if (store.activeProjectId !== null) store.startNewChat();
            return;
        }
        // The first send gave the chat on screen this very id and moved the URL to it:
        // the store already holds everything, there is nothing to fetch.
        if (!fresh && urlId === store.activeProjectId) return;

        if (!isProjectId(urlId)) {
            toast.error("Project not found", { id: `open-${urlId}` });
            navigateRef.current(HUB_PATH, { replace: true });
            return;
        }

        // A different project: clear the old one first so its chat never flashes under the
        // new URL. The loading id also tells effect B that the id changes ahead are ours.
        if (urlId !== store.activeProjectId) store.startNewChat();
        store.setLoadingProjectId(urlId);

        let cancelled = false;
        // A save of this very project may still be on its way (the user just left it, or is coming
        // back to it): read after it lands, or the page would show the chat as it was before.
        whenSaved(urlId)
            .then(() => getProject(urlId))
            .then((detail) => {
                // Dropped when the URL moved on, or a new chat began, while this was in flight.
                if (cancelled || useWorkspaceStore.getState().loadingProjectId !== urlId) return;
                if (detail.deleted_at) {
                    // An old link (or Back after "Move to bin") to a project that is in the bin:
                    // it is not for editing, so send the visitor to where it can be restored.
                    useWorkspaceStore.getState().setLoadingProjectId(null);
                    toast.error("This project is in the bin", {
                        id: `open-${urlId}`,
                        description: "Restore it from Deleted to open it again.",
                    });
                    navigateRef.current(DELETED_PATH, { replace: true });
                    return;
                }
                useWorkspaceStore.getState().setProject(detail);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                useWorkspaceStore.getState().setLoadingProjectId(null);
                const missing = err instanceof ApiRequestError && err.status === 404;
                // An id so StrictMode's doubled effect (dev only) cannot stack two toasts.
                toast.error(missing ? "Project not found" : "This project could not be opened", {
                    id: `open-${urlId}`,
                    description: missing ? "It may have been deleted." : err instanceof Error ? err.message : undefined,
                });
                navigateRef.current(HUB_PATH, { replace: true });
            });
        return () => {
            cancelled = true;
            const s = useWorkspaceStore.getState();
            if (s.loadingProjectId === urlId) s.setLoadingProjectId(null);
        };
    }, [urlId]);

    // Flags the page as mounted only after effect A has had its say (effects run in
    // order), and is StrictMode-safe: the simulated unmount resets it.
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Effect B: store -> URL. Fires only on CHANGES of activeProjectId: on mount of
    // /app/<id> the store is still empty while the URL is not, and reacting to that
    // would rewrite the URL before the fetch above resolves.
    useEffect(() => {
        const prev = prevActiveRef.current;
        prevActiveRef.current = activeProjectId;
        if (prev === undefined || prev === activeProjectId) return;
        // The URL already says so (a load we started landed), or that load is mid-flight.
        if (activeProjectId === urlIdRef.current) return;
        if (useWorkspaceStore.getState().loadingProjectId !== null) return;
        // A row appearing is the first send: replace, so Back does not return to a blank chat.
        // A row disappearing is New chat: push, so Back returns to the project.
        navigateRef.current(projectPath(activeProjectId), { replace: activeProjectId !== null });
    }, [activeProjectId]);

    return {
        projectId: urlId,
        // The spinner case: a URL names a project that is not on screen yet.
        loading: urlId !== null && loadingProjectId === urlId && activeProjectId !== urlId,
        // The same question, answerable from the very first render (the effect that starts the
        // fetch has not run yet, so `loading` is still false there). It stays true until the
        // project lands, and a failed load leaves the page for the hub, so a page can use it to
        // avoid painting the new-chat hero for a frame over a project that is about to appear.
        opening: urlId !== null && activeProjectId !== urlId,
    };
}
