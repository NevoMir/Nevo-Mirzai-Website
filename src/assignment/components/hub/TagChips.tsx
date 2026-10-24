import { X } from "lucide-react";

import { TagChecklist, type ProjectMenuProps } from "@/assignment/components/hub/ProjectMenu";
import { useAfterMenuClose } from "@/assignment/components/hub/useAfterMenuClose";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import type { HubProject, HubTag } from "@/assignment/lib/hub/hubClient";
import { tagColor, tagIcon, tagTextColor } from "@/assignment/lib/hub/tagIcons";

export interface TagChipsProps extends ProjectMenuProps {
    /** How many chips are drawn before the rest fold into "+N": three beside a row's
     *  name, two under a card's. */
    maxChips?: number;
    /** A chip's name opens that tag's list. WITHOUT it the chips are plain text, which
     *  is what the bin and the shelf want: a tag view of things that are not in any
     *  view is a dead end. */
    onOpenTag?: (tag: HubTag) => void;
    /** The × on each chip. */
    onRemoveTag?: (project: HubProject, tag: HubTag) => void;
    /** `project-row`, `recent-card`: the same project is drawn in two places, so its
     *  chips say which. */
    testIdPrefix?: string;
    className?: string;
}

/**
 * The tags a project carries, as chips (a project may carry several).
 *
 * Derived from the two props the menu already needs (`tags`, `projectTags`), so
 * carrying them costs a row nothing extra.
 *
 * Past `maxChips` the rest fold into a "+N" that opens the row's own Tags checklist,
 * the same component the "⋯" menu uses, so the answer to "what else is on this?" is
 * also where you change it. Read-only rows get a "+N" that only names them.
 */
export function TagChips({
    project,
    tags = [],
    projectTags = [],
    maxChips = 3,
    onOpenTag,
    onRemoveTag,
    onToggleTag,
    onNewTag,
    testIdPrefix = "project-row",
    className = "",
}: TagChipsProps) {
    // "New tag…" in the "+N" menu opens a dialog: after the menu has closed (see useAfterMenuClose).
    const afterClose = useAfterMenuClose();
    const carried = projectTags.length ? tags.filter((t) => projectTags.includes(t.id)) : [];
    if (!carried.length) return null;

    const shown = carried.slice(0, maxChips);
    const rest = carried.slice(maxChips);

    return (
        <span className={`flex min-w-0 max-w-full flex-wrap items-center gap-1 ${className}`}>
            {shown.map((tag) => {
                const color = tagColor(tag.color);
                const Icon = tag.icon ? tagIcon(tag.icon) : null;
                // The mark keeps the pure colour; the name is drawn in a readable mix of it.
                const mark = Icon ? (
                    <Icon className="h-3 w-3 shrink-0" style={{ color }} />
                ) : (
                    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                );
                const label = (
                    <>
                        {mark}
                        <span className="truncate">{tag.name}</span>
                    </>
                );
                return (
                    <span
                        key={tag.id}
                        data-testid={`${testIdPrefix}-tag-${project.id}-${tag.id}`}
                        className="flex max-w-[9rem] items-center gap-1 rounded-full py-px pl-1.5 pr-1 text-[10px] font-medium leading-none"
                        style={{ backgroundColor: `${color}22`, color: tagTextColor(color) }}
                    >
                        {onOpenTag ? (
                            <button
                                type="button"
                                aria-label={`Show the tag ${tag.name}`}
                                // The row underneath is a click target of its own, and this one is
                                // not "open the project".
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenTag(tag);
                                }}
                                className="flex min-w-0 items-center gap-1 hover:underline focus-visible:underline focus-visible:outline-none"
                            >
                                {label}
                            </button>
                        ) : (
                            <span className="flex min-w-0 items-center gap-1">{label}</span>
                        )}
                        {onRemoveTag && (
                            <button
                                type="button"
                                aria-label={`Remove tag ${tag.name}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveTag(project, tag);
                                }}
                                // A 10 px target 4 px from the name's own button cannot be hit on purpose
                                // with a finger, and a tap meant to open the tag's list would take the tag
                                // off. Touch removes tags in the ⋯ menu's Tags checklist instead.
                                className="shrink-0 rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none [@media(pointer:coarse)]:hidden"
                            >
                                <X className="h-2.5 w-2.5" />
                            </button>
                        )}
                    </span>
                );
            })}

            {rest.length > 0 &&
                (onToggleTag ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                data-testid={`${testIdPrefix}-tags-more-${project.id}`}
                                aria-label={`${rest.length} more tag${rest.length === 1 ? "" : "s"} on ${project.name}`}
                                onClick={(e) => e.stopPropagation()}
                                className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium leading-none text-muted-foreground hover:bg-secondary"
                            >
                                +{rest.length}
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            align="start"
                            className="max-h-72 w-52 overflow-y-auto"
                            onCloseAutoFocus={afterClose.onCloseAutoFocus}
                        >
                            <TagChecklist
                                project={project}
                                tags={tags}
                                projectTags={projectTags}
                                onToggleTag={onToggleTag}
                                onNewTag={onNewTag && ((p) => afterClose.defer(() => onNewTag(p)))}
                            />
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <span
                        data-testid={`${testIdPrefix}-tags-more-${project.id}`}
                        title={rest.map((t) => t.name).join(", ")}
                        className="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium leading-none text-muted-foreground"
                    >
                        +{rest.length}
                    </span>
                ))}
        </span>
    );
}
