/**
 * The app's routes as plain string helpers with no imports.
 *
 * Every path is RELATIVE to the router's basename (APP_BASE, "/assignment_alex"):
 * pass them to navigate() and <Link>, never to window.location.
 *
 *   /app                  the projects hub, showing All projects
 *   /app/new              a new chat
 *   /app/archived         the hub, showing the archive shelf
 *   /app/deleted          the hub, showing the bin (kept 7 days)
 *   /app/tag/<uuid>       the hub, scoped to one tag
 *   /app/tag/uncategorized  the hub, showing live projects with no tag
 *   /app/<uuid>           the saved project with that id
 *
 * `projectPath(null)` answers `/app/new` on purpose: "the store lost its id" (a
 * delete, a new chat) must keep the user in the workspace with a composer, not
 * bounce them to a list.
 */

/** The projects hub. */
export const HUB_PATH = "/app";

/** The workspace with a blank chat. */
export const NEW_PROJECT_PATH = "/app/new";

/** The hub's two fixed views besides All projects; each is a URL of its own so
 *  it can be linked, refreshed and backed out of. */
export const ARCHIVED_PATH = "/app/archived";
export const DELETED_PATH = "/app/deleted";

/**
 * The id of the pseudo-tag "Uncategorized": live projects carrying no tag at all.
 * It is not a tags row and never will be ("has no rows in project_tags" cannot be
 * renamed, coloured or filed into). Spelling it as a tag id lets one route, one
 * view and one heading serve both.
 */
export const UNCATEGORIZED_TAG = "uncategorized";

/** A pathname without its trailing slash(es). React Router matches `/app/deleted/` to the
 *  `/app/deleted` route, but `useLocation().pathname` keeps the slash, so every comparison
 *  against the constants above has to go through this first. The root stays "/". */
export function normalizePath(pathname: string): string {
    return pathname.replace(/\/+$/, "") || "/";
}

/** URL of a saved project, or of the blank chat when there is none. */
export function projectPath(id: string | null): string {
    return id ? `${HUB_PATH}/${id}` : NEW_PROJECT_PATH;
}

export function tagPath(id: string): string {
    return `${HUB_PATH}/tag/${id}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");

/** Is this string shaped like a project id? Anything else cannot be a saved project. */
export function isProjectId(id: string): boolean {
    return UUID_RE.test(id);
}

/** `/app/<uuid>`: the only project-carrying route, kept strict so the hub's own
 *  `/app/new`, `/app/archived` and two-segment tag routes are never mistaken for one. */
const PROJECT_PATH_RE = new RegExp(`^${HUB_PATH}/${UUID}$`, "i");
const TAG_PATH_RE = new RegExp(`^${HUB_PATH}/tag/(?:${UUID}|${UNCATEGORIZED_TAG})$`, "i");

export function isProjectPath(pathname: string): boolean {
    return PROJECT_PATH_RE.test(normalizePath(pathname));
}

export function isTagPath(pathname: string): boolean {
    return TAG_PATH_RE.test(normalizePath(pathname));
}
