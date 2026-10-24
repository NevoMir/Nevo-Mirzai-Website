import { useCallback, useEffect, useRef, useState } from "react";

import {
    HUB_CHANGED_EVENT,
    loadHub,
    sortProjects,
    type HubProject,
    type HubTag,
} from "@/assignment/lib/hub/hubClient";
import { createLoadGate, type LoadMode } from "@/assignment/lib/hub/loadGate";

/** "loading" is only the first paint; later reads keep showing the list they replace. */
export type HubStatus = "loading" | "ready" | "error";

// How a read lands (the ordering rules are in lib/hub/loadGate.ts):
//  - "initial"    shows the loading state, then the list;
//  - "sync"       replaces the list without a spinner. For after a write whose count came
//                 back short, when the screen has to be told the truth;
//  - "background" a refresh the user did not ask for (the window regained focus). It is
//                 thrown away if the user changed anything while it travelled or a write
//                 is still in flight, because the answer may predate that change.

/** Focus fires on every alt-tab; one read per few seconds is plenty. */
const BACKGROUND_REFRESH_MIN_MS = 4000;
/** A refresh that found the user mid-gesture tries again this often... */
const BACKGROUND_RETRY_MS = 2500;
/** ...at most this many times; the next focus starts over. */
const BACKGROUND_RETRY_MAX = 8;

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The hub's data: every project (trashed and archived included) and every tag, read in
 * ONE request. The Archived and Deleted pages are views of this same list.
 *
 * The page edits the list optimistically through the patch helpers below and wraps each
 * server write in `write()`, which is what lets a background refresh tell "the server's
 * list" from "the list the user is in the middle of changing". `isBusy` tells it when the
 * user is mid-gesture (a menu open, a name being typed) so rows are not rearranged under them.
 */
export function useHubData(options: { isBusy?: () => boolean } = {}) {
    // Read through a ref: the refresh effect must not re-subscribe on every render.
    const isBusyRef = useRef(options.isBusy);
    isBusyRef.current = options.isBusy;

    const [projects, setProjects] = useState<HubProject[]>([]);
    const [tags, setTags] = useState<HubTag[]>([]);
    const [status, setStatus] = useState<HubStatus>("loading");
    const [error, setError] = useState<string | null>(null);

    /** Which read may land, and whether a write got in its way. */
    const [gate] = useState(createLoadGate);
    const lastLoadAt = useRef(0);
    /** What the screen holds, as the server last told it, to skip a refresh that changes nothing. */
    const shownRef = useRef("");
    const retryTimer = useRef<number | undefined>(undefined);

    const load = useCallback(
        async (mode: LoadMode, attempt = 0): Promise<void> => {
            // A background read yields to an initial/sync one that is already on its way.
            const ticket = gate.begin(mode);
            if (!ticket) return;
            lastLoadAt.current = Date.now();
            window.clearTimeout(retryTimer.current);
            /** A refresh must not rearrange rows under an open menu, a dialog, a name being typed or a
             *  selection being made. It waits a moment and asks again. */
            const deferIfBusy = () => {
                if (!isBusyRef.current?.()) return false;
                if (attempt < BACKGROUND_RETRY_MAX) {
                    retryTimer.current = window.setTimeout(
                        () => void load("background", attempt + 1),
                        BACKGROUND_RETRY_MS,
                    );
                }
                return true;
            };
            const land = (data: Awaited<ReturnType<typeof loadHub>>) => {
                if (mode === "background") {
                    if (deferIfBusy()) return;
                    // The same news the screen already shows.
                    if (JSON.stringify(data) === shownRef.current) return;
                }
                shownRef.current = JSON.stringify(data);
                setProjects(data.projects);
                setTags(data.tags);
                setStatus("ready");
                setError(null);
            };
            let readAgain = false;
            try {
                if (mode === "background" && deferIfBusy()) return;
                if (mode === "initial") {
                    setStatus("loading");
                    setError(null);
                }
                const data = await loadHub();
                const verdict = gate.judge(ticket);
                if (verdict === "land") land(data);
                else if (verdict === "again") readAgain = true;
            } catch (err) {
                if (gate.superseded(ticket)) return;
                // A refresh that fails keeps the list on screen: no toast, no error panel.
                if (mode === "background") return;
                if (mode === "initial") {
                    setError(messageOf(err));
                    setStatus("error");
                } else {
                    // A sync read may have overtaken a slow initial one: if it fails too, the
                    // skeleton must not stay up for good.
                    setStatus((s) => (s === "loading" ? "error" : s));
                    setError((e) => e ?? messageOf(err));
                    throw err;
                }
            } finally {
                gate.end(ticket);
            }
            // A write came and went while this read travelled: its answer may predate it.
            if (readAgain) await load("sync");
        },
        [gate],
    );

    useEffect(() => {
        void load("initial");
        return () => window.clearTimeout(retryTimer.current);
    }, [load]);

    // Another tab (or the workspace in one) may have changed things while this one was
    // in the background.
    useEffect(() => {
        const refresh = () => {
            if (document.visibilityState === "hidden") return;
            if (Date.now() - lastLoadAt.current < BACKGROUND_REFRESH_MIN_MS) return;
            void load("background");
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [load]);

    // A change made elsewhere in the app while the hub is on screen (the workspace's Undo).
    useEffect(() => {
        const onChanged = () => void load("sync").catch(() => {});
        window.addEventListener(HUB_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(HUB_CHANGED_EVENT, onChanged);
    }, [load]);

    /** Try again after the first read failed. */
    const reload = useCallback(() => load("initial"), [load]);

    /** Re-read the truth after a write came back short or failed. Never throws. */
    const resync = useCallback(async () => {
        try {
            await load("sync");
        } catch {
            // The list stays as the optimistic edit left it; the next read corrects it.
        }
    }, [load]);

    /** Run a server write so refreshes know a change is under way. */
    const write = useCallback(
        async <T>(run: () => Promise<T>): Promise<T> => {
            gate.writeBegan();
            try {
                return await run();
            } finally {
                // A resync that landed in the middle of this write was held back; read now.
                if (gate.writeEnded()) void load("sync").catch(() => {});
            }
        },
        [gate, load],
    );

    // ---------- Local edits (the optimistic half of every write) ----------

    /** Merge a patch into one row and re-sort (pinning and renaming both move rows). */
    const patchProject = useCallback((id: string, patch: Partial<HubProject>) => {
        setProjects((prev) => sortProjects(prev.map((p) => (p.id === id ? { ...p, ...patch } : p))));
    }, []);

    /** Transform several rows at once. */
    const patchProjects = useCallback((ids: string[], patch: (p: HubProject) => HubProject) => {
        const wanted = new Set(ids);
        setProjects((prev) => sortProjects(prev.map((p) => (wanted.has(p.id) ? patch(p) : p))));
    }, []);

    /** Remove rows (deleting for good). */
    const dropProjects = useCallback((ids: string[]) => {
        const gone = new Set(ids);
        setProjects((prev) => prev.filter((p) => !gone.has(p.id)));
    }, []);

    /** Put rows back exactly as they were: the rollback of any of the edits above. */
    const restoreRows = useCallback((rows: HubProject[]) => {
        const byId = new Map(rows.map((r) => [r.id, r]));
        setProjects((prev) => {
            const seen = new Set<string>();
            const next = prev.map((p) => {
                seen.add(p.id);
                return byId.get(p.id) ?? p;
            });
            for (const row of rows) if (!seen.has(row.id)) next.push(row);
            return sortProjects(next);
        });
    }, []);

    /** Add or remove one tag on rows, in place: a row does not jump while its tags are ticked. */
    const setTagOn = useCallback((ids: string[], tagId: string, add: boolean) => {
        const wanted = new Set(ids);
        setProjects((prev) =>
            prev.map((p) => {
                if (!wanted.has(p.id)) return p;
                const has = p.tag_ids.includes(tagId);
                if (add === has) return p;
                return { ...p, tag_ids: add ? [...p.tag_ids, tagId] : p.tag_ids.filter((t) => t !== tagId) };
            }),
        );
    }, []);

    /** Insert or replace a tag, keeping the list alphabetical. */
    const upsertTag = useCallback((tag: HubTag) => {
        setTags((prev) => [...prev.filter((t) => t.id !== tag.id), tag].sort((a, b) => a.name.localeCompare(b.name)));
    }, []);

    /** Remove a tag and take it off every project that carried it. */
    const removeTagLocally = useCallback((tagId: string) => {
        setTags((prev) => prev.filter((t) => t.id !== tagId));
        setProjects((prev) =>
            prev.map((p) => (p.tag_ids.includes(tagId) ? { ...p, tag_ids: p.tag_ids.filter((t) => t !== tagId) } : p)),
        );
    }, []);

    return {
        projects,
        tags,
        status,
        error,
        reload,
        resync,
        write,
        patchProject,
        patchProjects,
        dropProjects,
        restoreRows,
        setTagOn,
        upsertTag,
        removeTagLocally,
    };
}
