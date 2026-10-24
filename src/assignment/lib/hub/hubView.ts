import { ARCHIVED_PATH, DELETED_PATH, normalizePath, UNCATEGORIZED_TAG } from "@/assignment/lib/projectPath";

/**
 * Which of the hub's lists is on screen.
 *
 * The URL is the state (`/app`, `/app/archived`, `/app/tag/<id>`, `/app/deleted`),
 * so a view can be linked, refreshed and backed out of, and so the sidebar
 * highlights itself from the router rather than from a second copy of "where am
 * I" in component state. This module is the whole translation.
 *
 * A tag view carries an id that may be a tags row OR the string `uncategorized`
 * (see `UNCATEGORIZED_TAG`). Callers that are about to write with it must check.
 */
export type HubView = "all" | "archived" | "deleted" | { tag: string };

/**
 * The view for a path. `tagId` is the `/app/tag/:tagId` route param, and it wins,
 * because only the router knows it matched a two-segment route.
 */
export function hubViewFor(pathname: string, tagId?: string | null): HubView {
    if (tagId) return { tag: tagId };
    // `/app/deleted/` reaches the same route as `/app/deleted`, so it must read the same.
    const path = normalizePath(pathname);
    if (path === ARCHIVED_PATH) return "archived";
    if (path === DELETED_PATH) return "deleted";
    return "all";
}

/** The tag this view is scoped to, or null. */
export function viewTagId(view: HubView): string | null {
    return typeof view === "object" ? view.tag : null;
}

/** The tag id to FILE with: null for Uncategorized, which is the absence of one
 *  and can never be written. */
export function filingTagId(view: HubView): string | null {
    const id = viewTagId(view);
    return id && id !== UNCATEGORIZED_TAG ? id : null;
}

/** What the sidebar row and the main column's heading both call a view. A tag
 *  names itself, so it is not in here. */
export const VIEW_TITLE: Record<"all" | "archived" | "deleted", string> = {
    all: "All projects",
    archived: "Archived projects",
    deleted: "Deleted",
};

/** Two views are the same when they name the same list. */
export function sameView(a: HubView, b: HubView): boolean {
    return typeof a === "object" || typeof b === "object" ? viewTagId(a) === viewTagId(b) : a === b;
}
