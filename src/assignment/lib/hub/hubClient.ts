import * as api from "@/assignment/lib/api";
import type { HubProject, HubTag } from "@/assignment/shared/contract";

export type { HubProject, HubTag };

/**
 * Every read and write the projects hub makes, in one module.
 *
 * Function names and signatures follow Cably's hubClient so the hub page ports
 * mechanically; underneath it is plain REST (lib/api.ts) instead of Supabase.
 * Differences worth knowing:
 *   - there are no teams, so nothing takes a team id;
 *   - a project row already carries `tag_ids` and `thumbnail_url`, so the
 *     separate `listProjectTags` read is just `tagIdsByProject(projects)`;
 *   - `loadHub()` fetches projects and tags in ONE request (what the page wants);
 *   - the count the bulk writes return is the number of rows that changed.
 *
 * The page stays a page: it renders what these functions return and calls them back.
 */

/** Fired when something outside the hub's own gestures changed the project list (the workspace's
 *  Undo of "moved to the bin" lands while the hub is already on screen). */
export const HUB_CHANGED_EVENT = "assembly-hub-changed";

export function notifyHubChanged(): void {
    window.dispatchEvent(new Event(HUB_CHANGED_EVENT));
}

/** In the bin: waiting out its seven days, not gone. Every list that means
 *  "my projects" has to filter on this; the Deleted page is its negation. */
export function isTrashed(p: Pick<HubProject, "deleted_at">): boolean {
    return !!p.deleted_at;
}

/** On the Archived shelf. Every view but "Archived projects" filters these
 *  out, and none of them counts it as deleted: `archived_at` and `deleted_at`
 *  are two different answers to "why is this not on my grid". */
export function isArchived(p: Pick<HubProject, "archived_at">): boolean {
    return !!p.archived_at;
}

/** Newest first, as a comparator that is a real total order. ISO stamps compare as text. */
function newestFirst(a: string, b: string): number {
    return a < b ? 1 : a > b ? -1 : 0;
}

/** The tiebreak every comparator below ends on: created_at (the server's own second key),
 *  then id, then 0. Bulk writes stamp ONE `now` on every row they touch, so ties are the
 *  normal case, and a comparator that answers -1 both ways for them (`a < b ? 1 : -1`)
 *  reverses a tied group on every re-sort. */
function thenCreated(a: HubProject, b: HubProject): number {
    return newestFirst(a.created_at, b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Most recently modified first: Recent's order, and the grid's once pinned rows are placed. */
export function compareByModified(a: HubProject, b: HubProject): number {
    return newestFirst(a.modified_at, b.modified_at) || thenCreated(a, b);
}

/** Most recently thrown away first: the bin's order. */
export function compareByDeleted(a: HubProject, b: HubProject): number {
    return newestFirst(a.deleted_at ?? "", b.deleted_at ?? "") || compareByModified(a, b);
}

/** Pinned first, then most recently modified: the grid's order. Sorting says
 *  nothing about the bin: filter with `isTrashed` first. */
export function sortProjects(items: HubProject[]): HubProject[] {
    return [...items].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return compareByModified(a, b);
    });
}

/** "2 days ago": the modified stamp, at card size. */
export function relativeTime(iso: string, now = Date.now()): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const secs = Math.max(0, Math.round((now - then) / 1000));
    if (secs < 60) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    return `${Math.round(days / 365)} year${days < 730 ? "" : "s"} ago`;
}

/** "12 Sep 2026": a date that is not about how long ago it was (a row's Created
 *  stamp). Fixed to en-GB so the words are the same for everyone. */
export function shortDate(iso: string): string {
    const then = new Date(iso);
    if (!Number.isFinite(then.getTime())) return "";
    return then.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "3 models", "1 model", "No models yet": what a card or a row says about what is inside. */
export function modelCountLabel(count: number): string {
    if (count <= 0) return "No models yet";
    return `${count} model${count === 1 ? "" : "s"}`;
}

/**
 * Everything the hub needs to paint, in one request: every project (BINNED AND
 * ARCHIVED ROWS INCLUDED, sorted pinned-first) and every tag, alphabetically.
 * The Deleted and Archived pages are views of this same list, not second queries.
 */
export async function loadHub(): Promise<{ projects: HubProject[]; tags: HubTag[] }> {
    const { projects, tags } = await api.listProjects();
    return {
        projects: sortProjects(projects),
        tags: [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    };
}

/** Every project, sorted. Prefer `loadHub()` when the tags are needed too. */
export async function listProjects(): Promise<HubProject[]> {
    return (await loadHub()).projects;
}

/** Every tag, alphabetically: the sidebar's list. */
export async function listTags(): Promise<HubTag[]> {
    const tags = await api.listTags();
    return [...tags].sort((a, b) => a.name.localeCompare(b.name));
}

/** One tag by id: what /app/tag/:id needs before it has the list. Null when it is gone. */
export async function getTag(tagId: string): Promise<HubTag | null> {
    return (await api.listTags()).find((t) => t.id === tagId) ?? null;
}

/** `{ [projectId]: tagId[] }` for these projects. EVERY project gets an entry,
 *  empty array included, so a row renders its chips without a `?? []`. */
export function tagIdsByProject(projects: Pick<HubProject, "id" | "tag_ids">[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of projects) out[p.id] = [...p.tag_ids];
    return out;
}

export async function createTag(input: { name: string; icon?: string | null; color?: string | null }): Promise<HubTag> {
    return api.createTag({ name: input.name.trim(), icon: input.icon ?? null, color: input.color ?? "#3b82f6" });
}

export async function updateTag(
    tagId: string,
    patch: { name?: string; icon?: string | null; color?: string | null },
): Promise<HubTag> {
    const body: { name?: string; icon?: string | null; color?: string } = {};
    if (patch.name !== undefined) body.name = patch.name.trim();
    if (patch.icon !== undefined) body.icon = patch.icon;
    if (patch.color) body.color = patch.color;
    return api.updateTag(tagId, body);
}

/** Delete a tag. Its projects are NOT deleted: they simply stop carrying it. */
export async function deleteTag(tagId: string): Promise<void> {
    await api.deleteTag(tagId);
}

/**
 * The bulk writes the selection makes, all the same shape: a set of ids in, the
 * NUMBER OF ROWS THAT ACTUALLY CHANGED back. A caller that selected six projects
 * and is told four were moved can say so.
 */
async function writeMany(ids: string[], action: Parameters<typeof api.bulkProjects>[1]): Promise<number> {
    const wanted = [...new Set(ids.filter(Boolean))];
    return wanted.length ? api.bulkProjects(wanted, action) : 0;
}

/** Into the bin: recoverable for seven days, then purged. */
export function trashProjects(ids: string[]): Promise<number> {
    return writeMany(ids, "trash");
}

/** Back out of the bin, still carrying whatever tags it was filed under. */
export function restoreProjects(ids: string[]): Promise<number> {
    return writeMany(ids, "restore");
}

/** Gone: the row and everything that hangs off it (models, jobs, files). */
export function deleteProjectsForever(ids: string[]): Promise<number> {
    return writeMany(ids, "purge");
}

/** Onto the Archived shelf, and back off it. Not the bin: the row stays live and is never purged. */
export function archiveProjects(ids: string[]): Promise<number> {
    return writeMany(ids, "archive");
}

export function unarchiveProjects(ids: string[]): Promise<number> {
    return writeMany(ids, "unarchive");
}

async function tagMany(ids: string[], tagId: string, add: boolean): Promise<number> {
    const wanted = [...new Set(ids.filter(Boolean))];
    return wanted.length ? api.setProjectsTag(wanted, tagId, add) : 0;
}

/** Put one tag on a set of projects; the count is how many were newly tagged. */
export function addProjectTag(projectIds: string[], tagId: string): Promise<number> {
    return tagMany(projectIds, tagId, true);
}

/** Take one tag off a set of projects; the count is how many were carrying it. */
export function removeProjectTag(projectIds: string[], tagId: string): Promise<number> {
    return tagMany(projectIds, tagId, false);
}

export async function setProjectPinned(projectId: string, pinned: boolean): Promise<void> {
    await api.patchProject(projectId, { pinned });
}

export async function deleteProject(projectId: string): Promise<void> {
    await deleteProjectsForever([projectId]);
}

/** Rename a project. */
export async function renameStoredProject(projectId: string, name: string): Promise<void> {
    await api.patchProject(projectId, { name });
}

/** Pin or unpin, answering with the server's row. */
export function pinProject(projectId: string, pinned: boolean): Promise<HubProject> {
    return api.patchProject(projectId, { pinned });
}

/** Rename, answering with the server's row (its new `modified_at` included), so the
 *  list can take the stamp the server chose instead of guessing one. */
export function renameProject(projectId: string, name: string): Promise<HubProject> {
    return api.patchProject(projectId, { name });
}

/** Rename and answer with the row's new `modified_at`, for the project that is open. */
export async function renameProjectRow(projectId: string, name: string): Promise<string | null> {
    const project = await api.patchProject(projectId, { name });
    return project.modified_at ?? null;
}

export async function createProject(input: { name?: string; tagId?: string | null } = {}): Promise<HubProject> {
    const name = input.name?.trim();
    return api.createProject({
        ...(name ? { name } : {}),
        ...(input.tagId ? { tag_id: input.tagId } : {}),
    });
}
