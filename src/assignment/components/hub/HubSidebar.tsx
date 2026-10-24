import { useState } from "react";
import {
    Archive,
    ChevronDown,
    LayoutGrid,
    MoreHorizontal,
    Pencil,
    Plus,
    Tag as TagOutline,
    Trash2,
    type LucideIcon,
} from "lucide-react";

import { BrandLockup } from "@/assignment/components/BrandLockup";
import { SettingsMenu } from "@/assignment/components/SettingsMenu";
import { useAfterMenuClose } from "@/assignment/components/hub/useAfterMenuClose";
import { Button } from "@/assignment/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import type { HubTag } from "@/assignment/lib/hub/hubClient";
import { sameView, VIEW_TITLE, type HubView } from "@/assignment/lib/hub/hubView";
import { tagColor, tagIcon } from "@/assignment/lib/hub/tagIcons";
import { ARCHIVED_PATH, DELETED_PATH, HUB_PATH, tagPath, UNCATEGORIZED_TAG } from "@/assignment/lib/projectPath";

/** Whether the views under "All projects" are folded out. A setting, so it survives a
 *  reload; per browser. */
const VIEWS_OPEN_KEY = "assembly-studio-hub-views-open";

function storedViewsOpen(): boolean {
    try {
        return localStorage.getItem(VIEWS_OPEN_KEY) !== "0";
    } catch {
        return true;
    }
}

interface SidebarRowProps {
    active: boolean;
    onClick: () => void;
    icon: LucideIcon;
    label: string;
    /** Printed on the right when there is something to count. */
    count?: number;
    indent?: boolean;
    testId: string;
}

/**
 * One row of the sidebar: an icon, a label, and a number when there is one.
 *
 * At module level rather than inside `HubSidebar` so it keeps its identity between
 * renders: a component redeclared inside another remounts its whole subtree every time
 * the parent re-renders, which is how a focused row loses focus mid-click.
 */
function SidebarRow({ active, onClick, icon: Icon, label, count, indent, testId }: SidebarRowProps) {
    return (
        <button
            type="button"
            data-testid={testId}
            data-active={active ? "true" : undefined}
            aria-current={active ? "page" : undefined}
            onClick={onClick}
            className={`flex w-full items-center gap-2 rounded-lg py-1.5 text-sm transition-colors ${
                indent ? "pl-8 pr-2" : "px-2"
            } ${active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-secondary"}`}
        >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            {count !== undefined && count > 0 && (
                <span
                    className={`shrink-0 text-xs tabular-nums ${active ? "text-accent-foreground/80" : "text-muted-foreground"}`}
                >
                    {count}
                </span>
            )}
        </button>
    );
}

/** The "⋯" of one tag row. Both its items open a dialog, so they wait for the menu to close first
 *  (see useAfterMenuClose). */
function TagMenu({
    tag,
    onEdit,
    onDelete,
}: {
    tag: HubTag;
    onEdit: (tag: HubTag) => void;
    onDelete: (tag: HubTag) => void;
}) {
    const afterClose = useAfterMenuClose();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Options for ${tag.name}`}
                    className="mr-1 h-5 w-5 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8 [@media(pointer:coarse)]:opacity-100"
                >
                    <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={afterClose.onCloseAutoFocus}>
                <DropdownMenuItem className="gap-2 text-xs" onClick={() => afterClose.defer(() => onEdit(tag))}>
                    <Pencil className="h-3.5 w-3.5" /> Rename / restyle
                </DropdownMenuItem>
                <DropdownMenuItem
                    className="gap-2 text-xs text-destructive focus:text-destructive"
                    onClick={() => afterClose.defer(() => onDelete(tag))}
                >
                    <Trash2 className="h-3.5 w-3.5" /> Delete tag
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export interface HubSidebarProps {
    /** Which list the main column is showing. The highlight comes from here, which means
     *  from the URL, never from a second copy of it. */
    view: HubView;
    tags: HubTag[];
    /** Live projects carrying each tag, by tag id. */
    tagCounts: Record<string, number>;
    uncategorizedCount: number;
    deletedCount: number;
    onNavigate: (path: string) => void;
    /** The brand: a fresh chat. */
    onNewProject: () => void;
    onNewTag: () => void;
    onEditTag: (tag: HubTag) => void;
    onDeleteTag: (tag: HubTag) => void;
    /** The settings row at the bottom. Off inside the phone drawer: the settings menu is not
     *  modal (see SettingsMenu), and a non-modal menu opened from inside a modal dialog closes
     *  the instant it opens, so on a phone it lives in the page header instead. */
    showSettings?: boolean;
}

/**
 * The hub's left column, top to bottom: the logo, "All projects" with Archived folded
 * under it, the tags, Uncategorized, and (pushed to the bottom) Deleted with the
 * settings row beneath it.
 *
 * It is a plain list of links: every row navigates and nothing here holds a copy of
 * "which view is open". The page passes `view` (derived from the URL) and the counts it
 * has already computed for the main column, so the sidebar fetches nothing of its own.
 */
export function HubSidebar({
    view,
    tags,
    tagCounts,
    uncategorizedCount,
    deletedCount,
    onNavigate,
    onNewProject,
    onNewTag,
    onEditTag,
    onDeleteTag,
    showSettings = true,
}: HubSidebarProps) {
    const [viewsOpen, setViewsOpen] = useState(storedViewsOpen);

    const toggleViews = () => {
        setViewsOpen((open) => {
            try {
                localStorage.setItem(VIEWS_OPEN_KEY, open ? "0" : "1");
            } catch {
                // Storage unavailable: the fold is then this visit's only.
            }
            return !open;
        });
    };

    /** One navigating row. `target` is both where it goes and what makes it the active
     *  one: there is no third source of truth. */
    const navRow = ({
        target,
        path,
        ...rest
    }: Omit<SidebarRowProps, "active" | "onClick"> & { target: HubView; path: string }) => (
        <SidebarRow {...rest} active={sameView(view, target)} onClick={() => onNavigate(path)} />
    );

    return (
        <div
            data-testid="hub-sidebar"
            className="flex h-full w-64 shrink-0 flex-col border-r border-border/70 bg-background"
        >
            <button
                type="button"
                aria-label="Assembly Studio: new project"
                title="New project"
                onClick={onNewProject}
                className="flex items-center justify-start px-3 pb-2 pt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <BrandLockup size="sm" layout="row" />
            </button>

            <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-2">
                {/* "All projects" is two controls in one line: the label navigates, the chevron
                    folds its siblings out. A single button that did both would make "show me the
                    others" a navigation. */}
                <div className="flex items-center">
                    {navRow({
                        target: "all",
                        path: HUB_PATH,
                        icon: LayoutGrid,
                        label: VIEW_TITLE.all,
                        testId: "hub-view-all",
                    })}
                    <button
                        type="button"
                        aria-label={viewsOpen ? "Hide the other views" : "Show the other views"}
                        aria-expanded={viewsOpen}
                        data-testid="hub-views-toggle"
                        onClick={toggleViews}
                        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8"
                    >
                        <ChevronDown className={`h-4 w-4 transition-transform ${viewsOpen ? "rotate-180" : ""}`} />
                    </button>
                </div>

                {viewsOpen &&
                    navRow({
                        target: "archived",
                        path: ARCHIVED_PATH,
                        icon: Archive,
                        label: VIEW_TITLE.archived,
                        indent: true,
                        testId: "hub-view-archived",
                    })}

                <div className="mt-4 flex items-center justify-between px-2 pb-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</span>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="New tag"
                        title="New tag (⌘⇧F / Ctrl+Shift+F)"
                        data-testid="hub-new-tag"
                        className="h-5 w-5 [@media(pointer:coarse)]:h-8 [@media(pointer:coarse)]:w-8"
                        onClick={onNewTag}
                    >
                        <Plus className="h-3.5 w-3.5" />
                    </Button>
                </div>

                {tags.map((tag) => {
                    const active = sameView(view, { tag: tag.id });
                    const color = tagColor(tag.color);
                    const Icon = tag.icon ? tagIcon(tag.icon) : null;
                    return (
                        <div
                            key={tag.id}
                            data-testid={`hub-tag-${tag.id}`}
                            data-active={active ? "true" : undefined}
                            className={`group flex items-center rounded-lg ${active ? "bg-accent" : "hover:bg-secondary"}`}
                        >
                            <button
                                type="button"
                                aria-label={`Open ${tag.name}`}
                                aria-current={active ? "page" : undefined}
                                onClick={() => onNavigate(tagPath(tag.id))}
                                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
                                    active ? "font-medium text-accent-foreground" : "text-muted-foreground"
                                }`}
                            >
                                <span
                                    data-testid={`hub-tag-mark-${tag.id}`}
                                    className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded"
                                    style={{ color }}
                                >
                                    {Icon ? (
                                        <Icon className="h-4 w-4" />
                                    ) : (
                                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                                    )}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left">{tag.name}</span>
                                {(tagCounts[tag.id] ?? 0) > 0 && (
                                    <span
                                        className={`shrink-0 text-xs tabular-nums ${active ? "text-accent-foreground/80" : "text-muted-foreground"}`}
                                    >
                                        {tagCounts[tag.id]}
                                    </span>
                                )}
                            </button>
                            <TagMenu tag={tag} onEdit={onEditTag} onDelete={onDeleteTag} />
                        </div>
                    );
                })}

                {/* Not a tag and never will be: "carries no tag" is a question about the join. It
                    sits last, where a tag would be, because that is where the eye looks for "the
                    rest". */}
                {navRow({
                    target: { tag: UNCATEGORIZED_TAG },
                    path: tagPath(UNCATEGORIZED_TAG),
                    icon: TagOutline,
                    label: "Uncategorized",
                    count: uncategorizedCount,
                    testId: "hub-tag-uncategorized",
                })}
            </nav>

            <div className="border-t border-border/70 px-2 py-2">
                {navRow({
                    target: "deleted",
                    path: DELETED_PATH,
                    icon: Trash2,
                    label: VIEW_TITLE.deleted,
                    count: deletedCount,
                    testId: "hub-view-deleted",
                })}
                {showSettings && (
                    // The menu's trigger is a small round button; its ::after is stretched over the
                    // whole row so the label is part of the target too.
                    <div className="relative mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary">
                        <SettingsMenu
                            side="top"
                            align="start"
                            className="after:absolute after:inset-0 after:content-['']"
                        />
                        <span className="min-w-0 flex-1 truncate">Settings</span>
                    </div>
                )}
            </div>
        </div>
    );
}
