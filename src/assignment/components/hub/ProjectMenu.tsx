import {
    Archive,
    ArchiveRestore,
    FolderOpen,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    RotateCcw,
    SquareCheck,
    Tags,
    Trash2,
} from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { TagMark } from "@/assignment/components/hub/TagMark";
import { useAfterMenuClose } from "@/assignment/components/hub/useAfterMenuClose";
import type { HubProject, HubTag } from "@/assignment/lib/hub/hubClient";

export interface ProjectMenuProps {
    project: HubProject;
    /** Every tag: the "Tags" submenu's checklist. A project carries several at once, so
     *  the items TOGGLE; there is no "move", and no "remove from a folder". The list
     *  itself is {@link TagChecklist}, which the row's "+N" chip opens as well. */
    tags?: HubTag[];
    /** The tag ids this project carries right now. */
    projectTags?: string[];
    /** Open the project in the workspace. */
    onOpenProject?: (project: HubProject) => void;
    onRename?: (project: HubProject) => void;
    /** Add (`next`) or remove one tag. */
    onToggleTag?: (project: HubProject, tagId: string, next: boolean) => void;
    /** "New tag…" from inside the submenu: create one, then put it on this row. */
    onNewTag?: (project: HubProject) => void;
    /** Onto the archive shelf, and back off it. */
    onArchive?: (project: HubProject) => void;
    onUnarchive?: (project: HubProject) => void;
    onTogglePin?: (project: HubProject) => void;
    /** Into the bin: kept for seven days. */
    onDelete?: (project: HubProject) => void;
    /** Deleted view only: out of the bin, or gone for good. */
    onRestore?: (project: HubProject) => void;
    onDeleteForever?: (project: HubProject) => void;
    /** A list row that may be ticked: the way into selecting, with a long press. The same
     *  toggle reads Deselect on a ticked row, so the "⋯" never vanishes under the focus
     *  it is handing back. */
    onSelect?: (project: HubProject) => void;
    selected?: boolean;
}

export interface TagChecklistProps {
    project: HubProject;
    tags?: HubTag[];
    /** The ones this project carries right now. */
    projectTags?: string[];
    onToggleTag: (project: HubProject, tagId: string, next: boolean) => void;
    onNewTag?: (project: HubProject) => void;
}

/**
 * "Which tags does this project carry" as a list of ticks: the menu's Tags submenu,
 * and the same list again behind a row's "+N" chip.
 *
 * It renders menu ITEMS and no container, so both callers supply their own (a
 * `DropdownMenuSubContent` here, a `DropdownMenuContent` there) and there is exactly
 * one checklist in the app rather than two that drift.
 */
export function TagChecklist({ project, tags = [], projectTags = [], onToggleTag, onNewTag }: TagChecklistProps) {
    return (
        <>
            {tags.map((tag) => (
                <DropdownMenuCheckboxItem
                    key={tag.id}
                    className="text-xs"
                    checked={projectTags.includes(tag.id)}
                    // Radix closes the menu on select; a checklist is used in runs, so the popup
                    // stays open and the row updates under the tick.
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(next) => onToggleTag(project, tag.id, next === true)}
                >
                    <span className="flex min-w-0 items-center gap-1.5">
                        <TagMark tag={tag} />
                        <span className="truncate">{tag.name}</span>
                    </span>
                </DropdownMenuCheckboxItem>
            ))}
            {tags.length === 0 && !onNewTag && (
                <DropdownMenuItem className="text-xs" disabled>
                    No tags yet
                </DropdownMenuItem>
            )}
            {onNewTag && (
                <>
                    {tags.length > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuItem className="text-xs" onClick={() => onNewTag(project)}>
                        New tag…
                    </DropdownMenuItem>
                </>
            )}
        </>
    );
}

/**
 * The "⋯" of one project: the card's and the row's, one component.
 *
 * Every item is optional and the page hands over only the ones that make sense for
 * where the project is (the bin offers Restore and Delete forever, the shelf offers
 * Unarchive), so this can end up with nothing to offer. A "⋯" that opens an empty
 * popup is worse than no "⋯" at all, so it then renders nothing.
 *
 * Extra props are ignored on purpose: the card and the row both spread their own
 * props in, and the handlers' contract is the same in both places.
 */
export function ProjectMenu({
    project,
    tags = [],
    projectTags = [],
    onOpenProject,
    onRename,
    onToggleTag,
    onNewTag,
    onArchive,
    onUnarchive,
    onTogglePin,
    onDelete,
    onRestore,
    onDeleteForever,
    onSelect,
    selected = false,
}: ProjectMenuProps) {
    /** Rename, Delete forever and "New tag…" open something (the name field, a confirm dialog, the
     *  tag dialog) rather than act on the project. That has to wait for this menu to finish
     *  closing: see useAfterMenuClose. The click only ARMS it; the menu's close runs it. */
    const afterClose = useAfterMenuClose();

    const hasMenu = Boolean(
        onSelect ||
            onOpenProject ||
            onRename ||
            onToggleTag ||
            onArchive ||
            onUnarchive ||
            onTogglePin ||
            onDelete ||
            onRestore ||
            onDeleteForever,
    );
    if (!hasMenu) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 [@media(pointer:coarse)]:opacity-100"
                    aria-label={`Options for ${project.name}`}
                >
                    <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                className="w-48"
                onCloseAutoFocus={afterClose.onCloseAutoFocus}
            >
                {onSelect && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onSelect(project)}>
                        <SquareCheck className="h-3.5 w-3.5" /> {selected ? "Deselect" : "Select"}
                    </DropdownMenuItem>
                )}
                {onOpenProject && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onOpenProject(project)}>
                        <FolderOpen className="h-3.5 w-3.5" /> Open
                    </DropdownMenuItem>
                )}
                {onRestore && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onRestore(project)}>
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </DropdownMenuItem>
                )}
                {onRename && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => afterClose.defer(() => onRename(project))}>
                        <Pencil className="h-3.5 w-3.5" /> Rename
                    </DropdownMenuItem>
                )}
                {onToggleTag && (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="gap-2 text-xs">
                            <Tags className="h-3.5 w-3.5" /> Tags
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-72 w-52 overflow-y-auto">
                            <TagChecklist
                                project={project}
                                tags={tags}
                                projectTags={projectTags}
                                onToggleTag={onToggleTag}
                                onNewTag={onNewTag && ((p) => afterClose.defer(() => onNewTag(p)))}
                            />
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
                {onTogglePin && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onTogglePin(project)}>
                        {project.pinned ? (
                            <>
                                <PinOff className="h-3.5 w-3.5" /> Unpin
                            </>
                        ) : (
                            <>
                                <Pin className="h-3.5 w-3.5" /> Pin
                            </>
                        )}
                    </DropdownMenuItem>
                )}
                {onArchive && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onArchive(project)}>
                        <Archive className="h-3.5 w-3.5" /> Archive
                    </DropdownMenuItem>
                )}
                {onUnarchive && (
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => onUnarchive(project)}>
                        <ArchiveRestore className="h-3.5 w-3.5" /> Unarchive
                    </DropdownMenuItem>
                )}
                {(onDelete || onDeleteForever) && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            className="gap-2 text-xs text-destructive focus:text-destructive"
                            onClick={() =>
                                onDeleteForever
                                    ? afterClose.defer(() => onDeleteForever(project))
                                    : onDelete?.(project)
                            }
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {onDeleteForever ? "Delete forever" : "Move to trash"}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
