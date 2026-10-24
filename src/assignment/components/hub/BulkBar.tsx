import { Archive, ArchiveRestore, RotateCcw, Tag as TagOutline, Tags, Trash2, X } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { TagMark } from "@/assignment/components/hub/TagMark";
import { useAfterMenuClose } from "@/assignment/components/hub/useAfterMenuClose";
import type { HubTag } from "@/assignment/lib/hub/hubClient";

/** Which list the selection was made in: it decides which actions make sense. */
export type BulkMode = "live" | "archived" | "deleted";

export interface BulkBarProps {
    mode: BulkMode;
    count: number;
    /** Every tag: what "Add tag" offers. */
    tags: HubTag[];
    /** Only the tags the SELECTION carries: all "Remove tag" may offer. A list of every
     *  tag, most of them a no-op, is a list of traps. */
    selectedTags: HubTag[];
    onAddTag: (tagId: string) => void;
    onRemoveTag: (tagId: string) => void;
    onNewTag: () => void;
    onArchive: () => void;
    onUnarchive: () => void;
    onTrash: () => void;
    onRestore: () => void;
    onDeleteForever: () => void;
    onClear: () => void;
}

function TagMenuItem({ tag, onClick }: { tag: HubTag; onClick: () => void }) {
    return (
        <DropdownMenuItem className="gap-1.5 text-xs" onClick={onClick}>
            <TagMark tag={tag} />
            <span className="truncate">{tag.name}</span>
        </DropdownMenuItem>
    );
}

/**
 * The selection's own toolbar. It sits inside the scrolling column, so it floats over the
 * list and never over the sidebar.
 */
export function BulkBar({
    mode,
    count,
    tags,
    selectedTags,
    onAddTag,
    onRemoveTag,
    onNewTag,
    onArchive,
    onUnarchive,
    onTrash,
    onRestore,
    onDeleteForever,
    onClear,
}: BulkBarProps) {
    // "New tag…" opens a dialog: after the menu has closed (see useAfterMenuClose).
    const afterClose = useAfterMenuClose();
    return (
        <div
            data-testid="hub-bulk-bar"
            role="toolbar"
            aria-label="Selected projects"
            className="sticky bottom-4 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg"
        >
            {/* A live region, so a screen reader hears the count change as rows are ticked. */}
            <span role="status" className="px-1 text-xs font-medium text-foreground">
                {count} selected
            </span>

            {mode === "deleted" && (
                <>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs [@media(pointer:coarse)]:h-9" onClick={onRestore}>
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs text-destructive [@media(pointer:coarse)]:h-9"
                        onClick={onDeleteForever}
                    >
                        <Trash2 className="h-3.5 w-3.5" /> Delete forever
                    </Button>
                </>
            )}

            {mode === "archived" && (
                <>
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs [@media(pointer:coarse)]:h-9" onClick={onUnarchive}>
                        <ArchiveRestore className="h-3.5 w-3.5" /> Unarchive
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs text-destructive [@media(pointer:coarse)]:h-9"
                        onClick={onTrash}
                    >
                        <Trash2 className="h-3.5 w-3.5" /> Move to trash
                    </Button>
                </>
            )}

            {mode === "live" && (
                <>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs [@media(pointer:coarse)]:h-9">
                                <Tags className="h-3.5 w-3.5" /> Add tag
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="center"
                            className="max-h-72 w-48 overflow-y-auto"
                            onCloseAutoFocus={afterClose.onCloseAutoFocus}
                        >
                            {tags.map((tag) => (
                                <TagMenuItem key={tag.id} tag={tag} onClick={() => onAddTag(tag.id)} />
                            ))}
                            {tags.length > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuItem className="text-xs" onClick={() => afterClose.defer(onNewTag)}>
                                New tag…
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    {selectedTags.length > 0 && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs [@media(pointer:coarse)]:h-9">
                                    <TagOutline className="h-3.5 w-3.5" /> Remove tag
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="center" className="max-h-72 w-48 overflow-y-auto">
                                {selectedTags.map((tag) => (
                                    <TagMenuItem key={tag.id} tag={tag} onClick={() => onRemoveTag(tag.id)} />
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-xs [@media(pointer:coarse)]:h-9" onClick={onArchive}>
                        <Archive className="h-3.5 w-3.5" /> Archive
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs text-destructive [@media(pointer:coarse)]:h-9"
                        onClick={onTrash}
                    >
                        <Trash2 className="h-3.5 w-3.5" /> Move to trash
                    </Button>
                </>
            )}

            <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
                aria-label="Clear selection"
                onClick={onClear}
            >
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}
