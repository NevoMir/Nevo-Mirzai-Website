import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { Archive, Boxes, LayoutGrid, LayoutTemplate, Loader2, Menu, Search, SquarePen, Tag, Trash2, type LucideIcon } from "lucide-react";

import { BrandLockup } from "@/assignment/components/BrandLockup";
import { SettingsMenu } from "@/assignment/components/SettingsMenu";
import { BulkBar, type BulkMode } from "@/assignment/components/hub/BulkBar";
import { ExamplesDialog } from "@/assignment/components/hub/ExamplesDialog";
import { HubSidebar } from "@/assignment/components/hub/HubSidebar";
import { ProjectCard, type ProjectCardProps } from "@/assignment/components/hub/ProjectCard";
import { ProjectRow, type ProjectRowProps, type RowClickMods } from "@/assignment/components/hub/ProjectRow";
import { TagDialog } from "@/assignment/components/hub/TagDialog";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/assignment/components/ui/alert-dialog";
import { Button } from "@/assignment/components/ui/button";
import { Input } from "@/assignment/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/assignment/components/ui/sheet";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import { toast } from "@/assignment/components/ui/sonner";
import {
    addProjectTag,
    archiveProjects,
    compareByDeleted,
    compareByModified,
    deleteProjectsForever,
    deleteTag,
    isArchived,
    isTrashed,
    pinProject,
    removeProjectTag,
    renameProject,
    restoreProjects,
    sortProjects,
    trashProjects,
    unarchiveProjects,
    type HubProject,
    type HubTag,
} from "@/assignment/lib/hub/hubClient";
import { focusHeirOf, HUB_LIST_HEADING_ID, rescueFocus } from "@/assignment/lib/hub/focusRescue";
import { filingTagId, hubViewFor, VIEW_TITLE, viewTagId } from "@/assignment/lib/hub/hubView";
import { applyRowClick, EMPTY_SELECTION, withoutIds, type RowSelection } from "@/assignment/lib/hub/rowSelection";
import { tagColor, tagIcon } from "@/assignment/lib/hub/tagIcons";
import { useHubData } from "@/assignment/lib/hub/useHubData";
import { useRowGestures } from "@/assignment/lib/hub/useRowGestures";
import {
    HUB_PATH,
    NEW_PROJECT_PATH,
    normalizePath,
    projectPath,
    tagPath,
    UNCATEGORIZED_TAG,
} from "@/assignment/lib/projectPath";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/** The glyph a view's title wears, in the slot a tag's icon or dot takes. */
const VIEW_ICON: Record<string, LucideIcon> = {
    all: LayoutGrid,
    archived: Archive,
    deleted: Trash2,
    uncategorized: Tag,
};

/** How many projects the Recent row shows. */
const RECENT_COUNT = 8;

const plural = (n: number) => `${n} project${n === 1 ? "" : "s"}`;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Anything open on top of the page that owns Escape: a menu, a dialog, a confirm (Radix's
 *  AlertDialog is `alertdialog`, not `dialog`). */
const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"]';

/** A field the user types into. A checkbox is an <input> too, but Escape there is not "stop typing". */
function isTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
    return target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type);
}

/** What a card or a row is handed besides its own click handler: the menu, the chips and the rename. */
type MenuProps = Omit<ProjectCardProps, "onOpen">;

/**
 * The projects hub: what `/app` is.
 *
 * Two columns. The LEFT one is fixed: the logo, "All projects" with Archived folded under
 * it, the tags (a project carries several), then Deleted and the settings row pinned to
 * the bottom. The RIGHT one is the list: the recent projects as cards, the name of
 * whatever the sidebar has selected, New project beside the search box, and one line per
 * project under that.
 *
 * Which list is on screen is the URL's answer, not a piece of state (see
 * lib/hub/hubView.ts), so every view can be linked, refreshed and backed out of, and the
 * sidebar's highlight has one source.
 *
 * Data: ONE read gives every project (trashed and archived included) and every tag; the
 * views are filters of it. Every edit is applied to the list first and written second,
 * and put back with a toast when the server says no.
 */
export default function ProjectsHub() {
    /** `/app/tag/:tagId`; the id may be a tags row or "uncategorized". */
    const { tagId: routeTagId = null } = useParams<{ tagId: string }>();
    const navigate = useNavigate();
    // Without a trailing slash: the router matches `/app/deleted/` to `/app/deleted`, the location keeps it.
    const pathname = normalizePath(useLocation().pathname);
    const view = useMemo(() => hubViewFor(pathname, routeTagId), [pathname, routeTagId]);
    const activeTagId = viewTagId(view);
    const deletedView = view === "deleted";
    const archivedView = view === "archived";

    /** Is the user in the middle of something a refresh must not rearrange? Set below, once the
     *  state it reads exists (selection, rename); open menus and dialogs are asked of the DOM. */
    const midGestureRef = useRef(false);

    const {
        projects,
        tags,
        status,
        error: loadError,
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
    } = useHubData({
        isBusy: () => midGestureRef.current || !!document.querySelector(OVERLAY_SELECTOR),
    });

    const projectsRef = useRef(projects);
    projectsRef.current = projects;

    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const [navOpen, setNavOpen] = useState(false);
    /** The "From example…" grid, over the page. */
    const [examplesOpen, setExamplesOpen] = useState(false);
    const [tagDialog, setTagDialog] = useState<{
        open: boolean;
        tag: HubTag | null;
        /** Opened from the bulk bar's "New tag…": the selection is tagged with it as soon as it exists. */
        fileSelection?: boolean;
        /** Opened from a row's Tags submenu: that one row gets it. */
        forProject?: HubProject | null;
    }>({ open: false, tag: null });
    /** The rows a "Delete forever" is about: the one thing on this page that cannot be
     *  undone, so it still asks. Moving to the trash does not. */
    const [confirmForever, setConfirmForever] = useState<HubProject[] | null>(null);
    const [confirmDeleteTag, setConfirmDeleteTag] = useState<HubTag | null>(null);
    /** Which name is being edited, and WHERE. The field opens in the row (or the card)
     *  itself, so this holds only which one is open; the text belongs to the field until
     *  it is committed. The place matters because Recent shows the same projects as the
     *  list: without it, a field opened in the list would also open on that project's card
     *  and the two would blur each other shut. */
    const [renaming, setRenaming] = useState<{ id: string; at: "row" | "card" } | null>(null);

    // The tab title says where you are; the workspace sets its own when it mounts.
    useEffect(() => {
        const previous = document.title;
        return () => {
            document.title = previous;
        };
    }, []);

    // ---------------------------------------------------------------- partitions
    /** Not in the trash and not on the archive shelf: what "my projects" means. */
    const live = useMemo(() => projects.filter((p) => !isTrashed(p) && !isArchived(p)), [projects]);
    const archivedProjects = useMemo(
        () => sortProjects(projects.filter((p) => !isTrashed(p) && isArchived(p))),
        [projects],
    );
    /** The trash, most recently thrown away first. */
    const trashedProjects = useMemo(() => projects.filter((p) => isTrashed(p)).sort(compareByDeleted), [projects]);
    const uncategorized = useMemo(() => live.filter((p) => p.tag_ids.length === 0), [live]);
    const tagCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const tag of tags) counts[tag.id] = 0;
        for (const p of live) for (const id of p.tag_ids) if (id in counts) counts[id] += 1;
        return counts;
    }, [tags, live]);

    /** The tag the page is scoped to. The list is authoritative, so a tag page whose tag
     *  holds nothing yet still names it. */
    const currentTag = useMemo(() => tags.find((t) => t.id === activeTagId) ?? null, [tags, activeTagId]);
    /** A tag page for a tag that is gone (deleted in another tab, an old bookmark). */
    const tagMissing = status === "ready" && !!activeTagId && activeTagId !== UNCATEGORIZED_TAG && !currentTag;

    const q = query.trim().toLowerCase();

    /** The view's projects, before the search box. */
    const viewProjects = useMemo(() => {
        if (deletedView) return trashedProjects;
        if (archivedView) return archivedProjects;
        if (activeTagId === UNCATEGORIZED_TAG) return uncategorized;
        if (activeTagId) return live.filter((p) => p.tag_ids.includes(activeTagId));
        return live;
    }, [deletedView, archivedView, activeTagId, trashedProjects, archivedProjects, uncategorized, live]);

    const rowProjects = useMemo(
        () => viewProjects.filter((p) => !q || p.name.toLowerCase().includes(q)),
        [viewProjects, q],
    );

    const recent = useMemo(() => [...live].sort(compareByModified).slice(0, RECENT_COUNT), [live]);
    /** Recent is "what I was last working on": a thing to show above a list of live
     *  projects, and nonsense above the bin, the shelf, or a search. */
    const showRecent = status === "ready" && !deletedView && !archivedView && !q && recent.length > 0;

    // ---------------------------------------------------------------- selection
    /** Which rows are ticked, and where the next shift-click measures from. The arithmetic
     *  is in lib/hub/rowSelection.ts; what lives here is what may be done with the result. */
    const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
    const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);
    // Changing what is on screen drops the selection: a bulk delete measured against a list
    // the user is no longer looking at is the worst bug this page could have. The SEARCH
    // counts, and so does the view.
    useEffect(() => clearSelection(), [pathname, q, clearSelection]);

    /** The rows a range may cover, in the order they are drawn. */
    const orderedIds = useMemo(() => rowProjects.map((p) => p.id), [rowProjects]);
    // For the callbacks an Undo toast runs from an older render.
    const orderedIdsRef = useRef(orderedIds);
    orderedIdsRef.current = orderedIds;
    /** Only what is on screen counts as selected: a row that left the list under the
     *  selection (a refresh brought news) is no longer the bar's to act on. */
    const selectedIds = useMemo(
        () => orderedIds.filter((id) => selection.selected.has(id)),
        [orderedIds, selection],
    );
    const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
    const selectedProjects = useMemo(
        () => rowProjects.filter((p) => selectedSet.has(p.id)),
        [rowProjects, selectedSet],
    );
    /** Which tags the SELECTION carries: the only ones "Remove tag" may offer. */
    const selectedTags = useMemo(() => {
        const ids = new Set<string>();
        for (const p of selectedProjects) for (const t of p.tag_ids) ids.add(t);
        return tags.filter((t) => ids.has(t.id));
    }, [selectedProjects, tags]);

    /** Tick (or untick) one row: its checkbox, its ⋯ → Select, a long press, and any click
     *  on a row once something is selected. */
    const tickRow = (id: string, mods?: RowClickMods) =>
        setSelection((prev) => applyRowClick(prev, orderedIds, id, mods));

    const { listRef, dragging, handlers: gestureHandlers } = useRowGestures({
        enabled: true,
        orderedIds,
        selected: selectedSet,
        onTick: tickRow,
        onSweep: (selected, anchor) => setSelection({ selected, anchor }),
    });
    midGestureRef.current = selectedIds.length > 0 || !!renaming || dragging;

    // ---------------------------------------------------------------- navigation
    const openProject = (project: HubProject) => navigate(projectPath(project.id));

    /** The tag a project made here is filed under: the one whose page this is. "Uncategorized" is the absence of a
     *  tag, and a tag that is gone cannot be filed into. */
    const seedTagId = (): string | null => {
        const tagId = filingTagId(view);
        return tagId && tags.some((t) => t.id === tagId) ? tagId : null;
    };

    /** A fresh chat. `seedTag` files the new project under the tag whose page this is. */
    const startProject = (seedTag: boolean) => {
        const seed = seedTag ? seedTagId() : null;
        // Reset first: the workspace mounts with whatever the store still holds from the last
        // visit, and an empty composer is the point of /app/new.
        useWorkspaceStore.getState().startNewChat();
        navigate(seed ? `${NEW_PROJECT_PATH}?tag=${encodeURIComponent(seed)}` : NEW_PROJECT_PATH);
    };

    const goTo = (path: string) => {
        setNavOpen(false);
        navigate(path);
    };

    // ---------------------------------------------------------------- writes
    /** A project that is still open in the workspace store and then binned or deleted would
     *  be written straight back by its autosave. No navigation follows: this page does not
     *  mount the route hook, so the store change stays a store change. */
    const forgetIfOpen = (ids: string[]) => {
        const store = useWorkspaceStore.getState();
        if (store.activeProjectId && ids.includes(store.activeProjectId)) store.startNewChat();
    };

    const togglePin = async (project: HubProject) => {
        const next = !project.pinned;
        patchProject(project.id, { pinned: next });
        try {
            const row = await write(() => pinProject(project.id, next));
            patchProject(project.id, { pinned: row.pinned });
        } catch (err) {
            patchProject(project.id, { pinned: project.pinned });
            toast.error(next ? "Could not pin the project" : "Could not unpin the project", {
                description: messageOf(err),
            });
        }
    };

    /** Put a tag on one row, or take it off: the list first, the server after, and the list
     *  put back when the server says no. */
    const toggleTag = async (project: HubProject, tagId: string, add: boolean): Promise<boolean> => {
        setTagOn([project.id], tagId, add);
        try {
            const n = await write(() => (add ? addProjectTag([project.id], tagId) : removeProjectTag([project.id], tagId)));
            // The server changed nothing. Harmless if it already agreed, but then the chip drawn
            // a line ago may be a lie: re-read rather than keep it.
            if (n === 0) void resync();
            return true;
        } catch (err) {
            setTagOn([project.id], tagId, !add);
            toast.error(add ? "Could not add the tag" : "Could not remove the tag", { description: messageOf(err) });
            return false;
        }
    };

    /** The × on a chip takes a label off in one tap and asks nothing, so it says so and offers
     *  the way back, as archiving and binning do. */
    const removeTagFromRow = async (project: HubProject, tag: HubTag) => {
        if (!(await toggleTag(project, tag.id, false))) return;
        toast(`Removed "${tag.name}" from "${project.name}"`, {
            action: { label: "Undo", onClick: () => void toggleTag(project, tag.id, true) },
        });
    };

    const tagSelection = async (tag: HubTag, add: boolean, ids = selectedIds) => {
        if (!ids.length) return;
        setTagOn(ids, tag.id, add);
        setSelection((prev) => withoutIds(prev, ids));
        // The bulk bar this was clicked in leaves with the selection; the rows stay.
        rescueFocus(focusHeirOf(orderedIdsRef.current, new Set(ids), false));
        try {
            // The SERVER's count, never the one asked for: adding skips the rows that already
            // carried the tag and removing only counts the ones that did. Short means the chips
            // just drawn may be wrong, so the list is re-read.
            const n = await write(() => (add ? addProjectTag(ids, tag.id) : removeProjectTag(ids, tag.id)));
            if (n < ids.length) void resync();
            toast(
                n === 0
                    ? `No change: "${tag.name}" was ${add ? "already on" : "not on"} ${plural(ids.length)}`
                    : add
                      ? `${plural(n)} tagged "${tag.name}"`
                      : `"${tag.name}" removed from ${plural(n)}`,
            );
        } catch (err) {
            void resync();
            toast.error(add ? "Could not tag the projects" : "Could not remove the tag", {
                description: messageOf(err),
            });
        }
    };

    const commitRename = async (project: HubProject, value: string) => {
        const name = value.trim();
        setRenaming(null);
        if (!name || name === project.name) return;
        patchProject(project.id, { name });
        try {
            const row = await write(() => renameProject(project.id, name));
            // The server stamps the edit; take its stamp rather than guess one.
            patchProject(project.id, { name: row.name, modified_at: row.modified_at });
            const store = useWorkspaceStore.getState();
            if (store.activeProjectId === project.id) {
                store.updateProjectMeta({ name: row.name, modified_at: row.modified_at });
            }
        } catch (err) {
            patchProject(project.id, { name: project.name });
            toast.error("Rename failed", { description: messageOf(err) });
        }
    };

    /**
     * One bulk write over a set of ids. The list changes first; the server's count says
     * whether it agreed. When the count is short we do not know WHICH rows it left alone, so
     * the list is re-read rather than guessed at. A failure puts the rows back.
     * Resolves to how many the server changed.
     */
    const applyBulk = async (spec: {
        ids: string[];
        run: (ids: string[]) => Promise<number>;
        patch: ((p: HubProject) => HubProject) | "drop";
        told: (n: number) => string;
        failure: string;
        /** Offered on the toast, for the moves that can be taken back. */
        undo?: (ids: string[]) => void;
    }): Promise<number> => {
        const { ids, run, patch, told, failure, undo } = spec;
        if (!ids.length) return 0;
        const wanted = new Set(ids);
        // From the ref, not this render's list: an Undo toast calls back into an older render.
        const before = projectsRef.current.filter((p) => wanted.has(p.id));
        // Only the rows this was about leave the selection: a menu action on one more row, or an
        // Undo, must not throw away a selection somebody is still making.
        setSelection((prev) => withoutIds(prev, ids));
        // The control that holds keyboard focus (a row's ⋯, the bulk bar) is leaving with the rows.
        rescueFocus(focusHeirOf(orderedIdsRef.current, wanted, true));
        if (patch === "drop") dropProjects(ids);
        else patchProjects(ids, patch);
        try {
            const n = await write(() => run(ids));
            if (n !== ids.length) void resync();
            if (n === 0) {
                // Another tab got there first: "0 projects moved" is not good news.
                toast("Nothing changed", { description: "The list was out of date, so it has been refreshed." });
            } else {
                toast(told(n), undo ? { action: { label: "Undo", onClick: () => undo(ids) } } : undefined);
            }
            return n;
        } catch (err) {
            restoreRows(before);
            void resync();
            toast.error(failure, { description: messageOf(err) });
            return 0;
        }
    };

    const restoreSelected = (ids: string[]) => {
        // Restoring only lifts the bin: a project that was archived first comes back to the
        // Archived shelf, and the toast says where to look for it.
        const toShelf = projectsRef.current.filter((p) => ids.includes(p.id) && isArchived(p)).length;
        const where = toShelf === 0 ? "" : toShelf === ids.length ? " to Archived" : `, ${toShelf} to Archived`;
        return applyBulk({
            ids,
            run: restoreProjects,
            patch: (p) => ({ ...p, deleted_at: null }),
            told: (n) => (n === 1 ? `Project restored${where}` : `${plural(n)} restored${where}`),
            failure: "Could not restore",
        });
    };

    /** Into the trash: a stamp, not a removal. */
    const trashSelected = async (ids: string[]) => {
        const stamp = new Date().toISOString();
        const n = await applyBulk({
            ids,
            run: trashProjects,
            patch: (p) => ({ ...p, deleted_at: stamp }),
            told: (count) =>
                count === 1 ? "Moved to Deleted, kept for 7 days" : `${plural(count)} moved to Deleted, kept for 7 days`,
            failure: "Could not move to the trash",
            undo: (undone) => void restoreSelected(undone),
        });
        if (n) forgetIfOpen(ids);
    };

    const unarchiveSelected = (ids: string[]) =>
        applyBulk({
            ids,
            run: unarchiveProjects,
            patch: (p) => ({ ...p, archived_at: null }),
            told: (n) => (n === 1 ? "Project unarchived" : `${plural(n)} unarchived`),
            failure: "Could not unarchive",
        });

    /** Onto the shelf: the row stays live and keeps its place, it is simply off the grid until
     *  it is brought back. */
    const archiveSelected = (ids: string[]) => {
        const stamp = new Date().toISOString();
        return applyBulk({
            ids,
            run: archiveProjects,
            patch: (p) => ({ ...p, archived_at: stamp }),
            told: (n) => (n === 1 ? "Project archived" : `${plural(n)} archived`),
            failure: "Could not archive",
            undo: (undone) => void unarchiveSelected(undone),
        });
    };

    const deleteForever = async (ids: string[]) => {
        setConfirmForever(null);
        const n = await applyBulk({
            ids,
            run: deleteProjectsForever,
            patch: "drop",
            told: (n) => (n === 1 ? "Project deleted for good" : `${plural(n)} deleted for good`),
            failure: "Could not delete",
        });
        if (n) forgetIfOpen(ids);
    };

    const removeTag = async (tag: HubTag) => {
        setConfirmDeleteTag(null);
        try {
            await write(() => deleteTag(tag.id));
            removeTagLocally(tag.id);
            if (activeTagId === tag.id) navigate(HUB_PATH);
            toast(`Tag "${tag.name}" deleted`);
        } catch (err) {
            toast.error("Could not delete the tag", { description: messageOf(err) });
        }
    };

    // ---------------------------------------------------------------- what a card or row offers
    /** A click on a row: it opens the project ("Otherwise it should always click into the
     *  project"), modifier keys or not, unless something is already selected, when it ticks
     *  the row (Shift: the run from the anchor). */
    const rowClicked = (project: HubProject, mods: RowClickMods) => {
        if (selectedIds.length > 0) {
            tickRow(project.id, mods);
        } else if (isTrashed(project)) {
            // A project in the bin is not opened (an edit or a generation there would be thrown away
            // when the bin empties); getting it back is one tap.
            toast("This project is in the trash", {
                id: "hub-trashed-open",
                description: "Restore it to open it.",
                action: { label: "Restore", onClick: () => void restoreSelected([project.id]) },
            });
        } else {
            openProject(project);
        }
    };

    /**
     * What a card or a row may offer, decided by where the project is. In the trash there
     * are two things to do (bring it back, or throw it away); on the shelf there are two
     * (bring it back, or bin it). Renaming and re-filing something deliberately put away is
     * a menu of decisions nobody came here to make.
     *
     * `at` says WHERE this copy is drawn (the same project is a card in Recent and a row in
     * the list), so the name field opens in the one that was meant, and only in that one.
     */
    const menuProps = (project: HubProject, at: "row" | "card"): MenuProps => {
        const shared: MenuProps = { project, tags, projectTags: project.tag_ids };
        if (isTrashed(project)) {
            return {
                ...shared,
                onRestore: (p) => void restoreSelected([p.id]),
                onDeleteForever: (p) => setConfirmForever([p]),
            };
        }
        if (isArchived(project)) {
            return {
                ...shared,
                onOpenProject: openProject,
                onUnarchive: (p) => void unarchiveSelected([p.id]),
                onDelete: (p) => void trashSelected([p.id]),
            };
        }
        return {
            ...shared,
            onOpenProject: openProject,
            // A chip's name is a link to that tag's list. Not in the bin and not on the shelf:
            // those rows are not IN the list a tag names.
            onOpenTag: (tag) => navigate(tagPath(tag.id)),
            // The × on a chip is the one-click half of the Tags checklist: taking a label off is
            // the common gesture, putting one on is a choice.
            onRemoveTag: (p, tag) => void removeTagFromRow(p, tag),
            // Rename happens IN the row (or the card): the menu item opens the field where the
            // name is written. The ⋯ is the only way in: a tap on the name opens the project.
            onRename: (p) => setRenaming({ id: p.id, at }),
            renamingId: renaming?.at === at ? renaming.id : null,
            onCommitRename: (p, name) => void commitRename(p, name),
            onCancelRename: () => setRenaming(null),
            onToggleTag: (p, tagId, next) => void toggleTag(p, tagId, next),
            onNewTag: (p) => setTagDialog({ open: true, tag: null, forProject: p }),
            onArchive: (p) => void archiveSelected([p.id]),
            onTogglePin: (p) => void togglePin(p),
            onDelete: (p) => void trashSelected([p.id]),
        };
    };

    const rowProps = (project: HubProject): ProjectRowProps => ({
        ...menuProps(project, "row"),
        selected: selectedSet.has(project.id),
        selectionActive: selectedIds.length > 0,
        onSelect: (p, mods) => tickRow(p.id, mods),
        onOpen: rowClicked,
    });

    // ---------------------------------------------------------------- keyboard
    // ⌘F / Ctrl+F focuses the search box; ⌘⇧O starts a project and ⌘⇧F a tag (the two things
    // this page creates, without the mouse); Escape drops the selection. ONE listener for all
    // four, reading what it may do from a ref: every dialog toggle would otherwise
    // re-subscribe it.
    const shortcutsRef = useRef({
        canProject: false,
        dialogOpen: false,
        newProject: () => {},
        clearSelection: () => {},
    });
    shortcutsRef.current = {
        // The same conditions as the buttons, so a shortcut can never run what the page does not offer.
        canProject: !deletedView && !archivedView,
        dialogOpen: tagDialog.open || navOpen || examplesOpen || !!renaming || !!confirmForever || !!confirmDeleteTag,
        newProject: () => startProject(true),
        clearSelection,
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const state = shortcutsRef.current;
            const overlayOpen = () => state.dialogOpen || !!document.querySelector(OVERLAY_SELECTOR);
            if (e.key === "Escape") {
                // An open dialog's, or an open menu's, Escape is its own: closing the bulk bar's
                // "Add tag" must not also throw the selection away. So is the name field's, and that
                // one has to be asked directly: its Escape closes the field before this listener
                // runs, so overlayOpen() no longer sees it.
                if (e.defaultPrevented || isTextEntry(e.target)) return;
                if (!overlayOpen()) state.clearSelection();
                return;
            }
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
            const key = e.key.toLowerCase();
            if (e.shiftKey) {
                // Creating something behind an open dialog, or while a field owns the keys, is
                // never what was meant.
                const el = e.target as HTMLElement | null;
                const tagName = el?.tagName ?? "";
                if (
                    overlayOpen() ||
                    el?.isContentEditable ||
                    tagName === "INPUT" ||
                    tagName === "TEXTAREA" ||
                    tagName === "SELECT"
                ) {
                    return;
                }
                if (key === "o" && state.canProject) {
                    e.preventDefault();
                    state.newProject();
                } else if (key === "f") {
                    e.preventDefault();
                    setTagDialog({ open: true, tag: null });
                }
                return;
            }
            if (key !== "f") return;
            e.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // ---------------------------------------------------------------- rendering
    /** The heading over the list. */
    const viewTitle = activeTagId
        ? activeTagId === UNCATEGORIZED_TAG
            ? "Uncategorized"
            : (currentTag?.name ?? (tagMissing ? "Unknown tag" : "Tag"))
        : VIEW_TITLE[view as "all" | "archived" | "deleted"];

    useEffect(() => {
        document.title = `${viewTitle} · Assembly Studio`;
    }, [viewTitle]);

    const emptyText = q
        ? "Nothing matches that."
        : tagMissing
          ? "This tag does not exist any more."
          : deletedView
            ? "Nothing has been deleted."
            : archivedView
              ? "Nothing is archived."
              : activeTagId === UNCATEGORIZED_TAG
                ? live.length > 0
                    ? "Every project carries a tag."
                    : "Nothing here yet."
                : activeTagId
                  ? "Nothing carries this tag yet."
                  : "Nothing here yet.";

    const bulkMode: BulkMode = deletedView ? "deleted" : archivedView ? "archived" : "live";

    const sidebar = (showSettings: boolean) => (
        <HubSidebar
            showSettings={showSettings}
            view={view}
            tags={tags}
            tagCounts={tagCounts}
            uncategorizedCount={uncategorized.length}
            deletedCount={trashedProjects.length}
            onNavigate={goTo}
            onNewProject={() => {
                setNavOpen(false);
                startProject(false);
            }}
            onNewTag={() => {
                setNavOpen(false);
                setTagDialog({ open: true, tag: null });
            }}
            onEditTag={(tag) => setTagDialog({ open: true, tag })}
            onDeleteTag={setConfirmDeleteTag}
        />
    );

    const titleMark = (() => {
        if (currentTag) {
            const Icon = currentTag.icon ? tagIcon(currentTag.icon) : null;
            const color = tagColor(currentTag.color);
            return Icon ? (
                <Icon className="h-4 w-4" style={{ color }} />
            ) : (
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
            );
        }
        const ViewIcon = VIEW_ICON[activeTagId === UNCATEGORIZED_TAG ? "uncategorized" : (view as string)] ?? LayoutGrid;
        return <ViewIcon className="h-4 w-4 text-muted-foreground" />;
    })();

    return (
        <div className="flex h-dvh w-full bg-background">
            <div className="hidden shrink-0 md:flex">{sidebar(true)}</div>

            {/* Phone: the same sidebar, in a drawer behind the brand. The title is the dialog's
                accessible name (a screen reader would otherwise announce an unnamed dialog, and
                Radix logs an error for it); sighted users already have the sidebar's own brand
                lockup, so it is sr-only. aria-describedby={undefined} says there is no
                description on purpose: the drawer is a nav list. */}
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
                <SheetContent side="left" hideClose className="w-64 p-0" aria-describedby={undefined}>
                    <SheetTitle className="sr-only">Navigation</SheetTitle>
                    {sidebar(false)}
                </SheetContent>
            </Sheet>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2 md:hidden">
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Open the menu"
                        className="h-8 w-8"
                        onClick={() => setNavOpen(true)}
                    >
                        <Menu className="h-4 w-4" />
                    </Button>
                    <BrandLockup size="sm" layout="row" />
                    {/* Settings sit here on a phone, outside the drawer (see HubSidebar's showSettings). */}
                    <SettingsMenu side="bottom" align="end" className="ml-auto" />
                </header>

                <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
                        {status === "loading" && (
                            <div className="space-y-3" aria-busy="true">
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Loader2 className="h-4 w-4 animate-spin" /> Loading your projects…
                                </div>
                                <div className="flex flex-col gap-2">
                                    {[0, 1, 2, 3].map((i) => (
                                        <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
                                    ))}
                                </div>
                            </div>
                        )}

                        {status === "error" && (
                            <div
                                role="alert"
                                className="flex flex-col items-start gap-2 rounded-xl border border-border/70 bg-card p-4"
                            >
                                <p className="text-sm font-medium text-foreground">Could not load your projects</p>
                                {loadError && <p className="text-xs text-muted-foreground">{loadError}</p>}
                                <Button size="sm" variant="outline" onClick={() => void reload()}>
                                    Try again
                                </Button>
                            </div>
                        )}

                        {showRecent && (
                            <section aria-labelledby="hub-recent">
                                <h2 id="hub-recent" className="mb-2 text-sm font-semibold text-foreground">
                                    Recent
                                </h2>
                                {/* Cards keep their 4:3 picture, so narrower is also shorter. 12 px of
                                    gap x 4 = 48 px off the widths of the five a row holds. */}
                                <div
                                    data-testid="hub-recent-row"
                                    className="flex snap-x gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]"
                                >
                                    {recent.map((project) => (
                                        <ProjectCard
                                            key={`recent-${project.id}`}
                                            {...menuProps(project, "card")}
                                            onOpen={openProject}
                                            testIdPrefix="recent-card"
                                            className="w-[calc(28%-9px)] min-w-[180px] shrink-0 snap-start"
                                        />
                                    ))}
                                </div>
                            </section>
                        )}

                        {status === "ready" && (
                            <section aria-labelledby={HUB_LIST_HEADING_ID}>
                                <div className="mb-3">
                                    {/* tabIndex -1: where keyboard focus lands when the row that held it is gone
                                        and no other row is left (see lib/hub/focusRescue.ts). */}
                                    <h2
                                        id={HUB_LIST_HEADING_ID}
                                        tabIndex={-1}
                                        data-testid="hub-view-title"
                                        className="flex items-center gap-2 text-lg font-semibold text-foreground focus:outline-none"
                                    >
                                        {/* Every view carries a mark in the SAME 16 px box (a tag's icon, its
                                            dot, or the view's own glyph) so the title text starts at one x and
                                            switching views does not shift it. */}
                                        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                            {titleMark}
                                        </span>
                                        <span className="truncate">{viewTitle}</span>
                                    </h2>
                                    {deletedView && (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            Deleted projects are kept for 7 days, then removed for good.
                                        </p>
                                    )}
                                    {archivedView && (
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            Archived projects are kept for good. They are simply off your list.
                                        </p>
                                    )}
                                </div>

                                <div className="mb-3 flex items-center gap-2">
                                    {!deletedView && !archivedView && (
                                        <Button
                                            size="sm"
                                            data-testid="hub-new-project"
                                            className="shrink-0 gap-2 bg-accent text-accent-foreground hover:bg-accent-hover"
                                            title="New project (⌘⇧O / Ctrl+Shift+O)"
                                            onClick={() => startProject(true)}
                                        >
                                            <SquarePen className="h-4 w-4" /> New project
                                        </Button>
                                    )}
                                    {!deletedView && !archivedView && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            data-testid="hub-from-example"
                                            className="shrink-0 gap-2"
                                            title="Start from a ready-made example. Nothing is generated, so it costs nothing."
                                            onClick={() => setExamplesOpen(true)}
                                        >
                                            <LayoutTemplate className="h-4 w-4" />
                                            {/* Icon only on a phone, where the search box needs the room; still the button's name. */}
                                            <span className="sr-only sm:not-sr-only">From example…</span>
                                        </Button>
                                    )}
                                    <div className="relative min-w-0 flex-1">
                                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            ref={searchRef}
                                            value={query}
                                            onChange={(e) => setQuery(e.target.value)}
                                            placeholder="Search projects"
                                            aria-label="Search projects"
                                            title="Search (⌘F / Ctrl+F)"
                                            // 16 px on a phone: iOS Safari zooms the page in on a smaller field.
                                            className="h-9 w-full pl-7 text-base md:text-sm"
                                        />
                                    </div>
                                </div>

                                {rowProjects.length === 0 ? (
                                    activeTagId === null && !deletedView && !archivedView && !q ? (
                                        <div
                                            data-testid="hub-empty"
                                            className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 px-6 py-14 text-center"
                                        >
                                            <Boxes className="h-9 w-9 text-accent" strokeWidth={1.5} aria-hidden />
                                            <div>
                                                <p className="text-sm font-medium text-foreground">No projects yet</p>
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    Describe an object and Assembly Studio builds it as a 3D model.
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap items-center justify-center gap-2">
                                                <Button
                                                    className="gap-2 bg-accent text-accent-foreground hover:bg-accent-hover"
                                                    onClick={() => startProject(false)}
                                                >
                                                    <SquarePen className="h-4 w-4" /> Describe something to build
                                                </Button>
                                                <Button variant="outline" className="gap-2" onClick={() => setExamplesOpen(true)}>
                                                    <LayoutTemplate className="h-4 w-4" /> Open an example
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <p data-testid="hub-empty" className="text-sm text-muted-foreground">
                                            {emptyText}
                                        </p>
                                    )
                                ) : (
                                    <div
                                        ref={listRef}
                                        data-testid="hub-projects-grid"
                                        {...gestureHandlers}
                                        className={`flex flex-col gap-2 ${dragging ? "select-none" : ""}`}
                                    >
                                        {rowProjects.map((project) => (
                                            <ProjectRow key={project.id} {...rowProps(project)} />
                                        ))}
                                    </div>
                                )}
                            </section>
                        )}

                        {selectedIds.length > 0 && (
                            <BulkBar
                                mode={bulkMode}
                                count={selectedIds.length}
                                tags={tags}
                                selectedTags={selectedTags}
                                onAddTag={(tagId) => {
                                    const tag = tags.find((t) => t.id === tagId);
                                    if (tag) void tagSelection(tag, true);
                                }}
                                onRemoveTag={(tagId) => {
                                    const tag = tags.find((t) => t.id === tagId);
                                    if (tag) void tagSelection(tag, false);
                                }}
                                onNewTag={() => setTagDialog({ open: true, tag: null, fileSelection: true })}
                                onArchive={() => void archiveSelected(selectedIds)}
                                onUnarchive={() => void unarchiveSelected(selectedIds)}
                                onTrash={() => void trashSelected(selectedIds)}
                                onRestore={() => void restoreSelected(selectedIds)}
                                onDeleteForever={() => setConfirmForever(selectedProjects)}
                                onClear={() => {
                                    rescueFocus(focusHeirOf(orderedIdsRef.current, selectedSet, false));
                                    clearSelection();
                                }}
                            />
                        )}
                    </div>
                </main>
            </div>

            <ExamplesDialog open={examplesOpen} onOpenChange={setExamplesOpen} tagId={seedTagId()} />

            <TagDialog
                open={tagDialog.open}
                onOpenChange={(open) => setTagDialog((prev) => ({ ...prev, open }))}
                tag={tagDialog.tag}
                existingNames={tags.map((t) => t.name)}
                usedColors={tags.map((t) => t.color)}
                onSaved={(saved) => {
                    upsertTag(saved);
                    // "New tag…" from the bulk bar or from a row's menu: the tag was the means, the
                    // filing was the point.
                    if (tagDialog.fileSelection) void tagSelection(saved, true);
                    if (tagDialog.forProject) void toggleTag(tagDialog.forProject, saved.id, true);
                }}
            />

            <AlertDialog open={!!confirmForever} onOpenChange={(open) => !open && setConfirmForever(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirmForever?.length === 1
                                ? `Delete "${confirmForever[0].name}" for good?`
                                : `Delete ${plural(confirmForever?.length ?? 0)} for good?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This cannot be undone. The projects, their conversations and their generated models are
                            removed.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => confirmForever && void deleteForever(confirmForever.map((p) => p.id))}
                        >
                            Delete forever
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={!!confirmDeleteTag} onOpenChange={(open) => !open && setConfirmDeleteTag(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete the tag "{confirmDeleteTag?.name}"?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The projects carrying it are kept. They simply stop carrying it.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => confirmDeleteTag && void removeTag(confirmDeleteTag)}
                        >
                            Delete tag
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
