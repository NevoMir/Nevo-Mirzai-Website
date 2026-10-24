import { useCallback, useId, useRef } from "react";
import { Boxes, Pin } from "lucide-react";

import { InlineName, renameJustSettled, type RenameInPlace } from "@/assignment/components/hub/InlineName";
import { ProjectMenu } from "@/assignment/components/hub/ProjectMenu";
import { ProjectPreview } from "@/assignment/components/hub/ProjectPreview";
import { TagChips, type TagChipsProps } from "@/assignment/components/hub/TagChips";
import {
    isArchived,
    isTrashed,
    modelCountLabel,
    relativeTime,
    shortDate,
    type HubProject,
} from "@/assignment/lib/hub/hubClient";

/** The only thing a row's click handler needs to know about the event, and the only
 *  thing a keyboard "click" can also answer: Shift extends a selection (once there is
 *  one; nothing selects from nothing). */
export interface RowClickMods {
    shiftKey?: boolean;
}

export interface ProjectRowProps extends TagChipsProps, RenameInPlace {
    selected?: boolean;
    /** Something is selected somewhere: the page is selecting, and only then is there a
     *  checkbox, on every row that may be ticked. */
    selectionActive?: boolean;
    /** Tick (or untick) this row: its checkbox, its ⋯ → Select. Absent = the row is not
     *  selectable at all. */
    onSelect?: (project: HubProject, mods?: RowClickMods) => void;
    /** A plain click on the row. The PAGE decides whether that opens the project or ticks
     *  it: it is the only thing that knows whether it is selecting. */
    onOpen: (project: HubProject, mods: RowClickMods) => void;
}

/**
 * One project as a line: the picture small on the left, its name, tags and stamps to its
 * right, the "⋯" at the end.
 *
 * The row is a `role="button"`, not a `<button>` wrapping its contents, for two reasons:
 * the checkbox and the menu are themselves buttons (and a button inside a button is
 * invalid), and the page's long press (and its sweep) start on a pointerdown that lands
 * on the row itself. Clicks that land on a nested control are the control's, so `onOpen`
 * ignores them.
 *
 * The name is plain text, part of the row: a click opens the project. Rename is the ⋯
 * menu's, and opens the field here.
 */
export function ProjectRow(props: ProjectRowProps) {
    const {
        project,
        selected = false,
        selectionActive = false,
        onSelect,
        onOpen,
        renamingId = null,
        onCommitRename,
        onCancelRename,
    } = props;

    const trashed = isTrashed(project);
    const archived = isArchived(project);
    /** The name field is open in THIS row. Clicking the row is then the standard "click
     *  away to finish" of every rename-in-place (Finder, Drive): the blur commits the
     *  name, and that is all it does. Opening the project (or moving the selection) on
     *  the same click would yank the user out of the page they were just typing in. */
    const renamingHere = renamingId === project.id;

    /** The box leaves the page when the selection empties (its own untick, Escape) and
     *  the focus on it would fall to the page body: it goes to the row, the same project,
     *  instead. Stable, so React calls it at mount and at unmount only, when the box is
     *  still in the page. */
    const rowRef = useRef<HTMLDivElement>(null);
    const box = useRef<HTMLInputElement | null>(null);
    const boxRef = useCallback((el: HTMLInputElement | null) => {
        if (!el && document.activeElement === box.current) rowRef.current?.focus();
        box.current = el;
    }, []);

    /** The edited-time / model-count line, which the row's accessible name does not carry. */
    const metaId = useId();

    /** A click on the "⋯", the checkbox, or anything else that handles itself. */
    const onControl = (target: EventTarget | null) =>
        target instanceof Element && !!target.closest('button,a,input,[role="menu"],[role="menuitem"]');

    return (
        <div
            ref={rowRef}
            data-testid={`project-row-${project.id}`}
            data-project-row=""
            data-project-id={project.id}
            role="button"
            tabIndex={0}
            // While nothing is selected the row opens the project, so it is a plain button; once
            // something is, a click ticks it, and only then is it a toggle (and "Open" a lie). The
            // label would swallow the row's content, so the stamp and model count are its
            // description instead.
            aria-label={selectionActive ? project.name : `Open ${project.name}`}
            aria-describedby={metaId}
            aria-pressed={onSelect && selectionActive ? selected : undefined}
            onClick={(e) => {
                if (renamingHere || renameJustSettled(project.id) || onControl(e.target)) return;
                onOpen(project, e);
            }}
            onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                if (renamingHere || onControl(e.target)) return;
                e.preventDefault();
                onOpen(project, e);
            }}
            // A 60 px picture and 6 px of padding above and below it. No callout: a held
            // finger on the picture is a long press, not iOS's Save Image.
            className={`group relative flex cursor-pointer select-none items-center gap-3 rounded-xl border px-2.5 py-1.5 transition-colors [-webkit-touch-callout:none] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected ? "border-primary/70 bg-primary/5" : "border-border/70 bg-card hover:bg-secondary"
            }`}
        >
            {onSelect && selectionActive && (
                <input
                    ref={boxRef}
                    type="checkbox"
                    checked={selected}
                    readOnly
                    aria-label={`Select ${project.name}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        onSelect(project, e);
                    }}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-primary [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
                />
            )}

            <ProjectPreview
                project={project}
                testIdPrefix="project-row"
                className="aspect-[4/3] h-[60px] shrink-0 rounded-md border border-border/60"
            />

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* The chips sit on the NAME's line: they say what this project is about, which
                    is the same question the name answers. On a phone they wrap under it. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-medium text-foreground">
                    <span className="flex min-w-0 max-w-full items-center gap-1.5">
                        {project.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        <InlineName
                            value={project.name}
                            editing={renamingHere}
                            onCommit={(name) => onCommitRename?.(project, name)}
                            onCancel={() => onCancelRename?.()}
                            className="truncate"
                            settleKey={project.id}
                            returnFocusTo={() => rowRef.current}
                        />
                    </span>
                    <TagChips {...props} maxChips={3} testIdPrefix="project-row" />
                </div>
                <div
                    id={metaId}
                    className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted-foreground"
                >
                    <span className="truncate">
                        {trashed
                            ? `Deleted ${relativeTime(project.deleted_at ?? "")}`
                            : archived
                              ? `Archived ${relativeTime(project.archived_at ?? "")}`
                              : `Edited ${relativeTime(project.modified_at)}`}
                    </span>
                    <span className="hidden truncate md:inline">Created {shortDate(project.created_at)}</span>
                    <span className="inline-flex items-center gap-1 truncate">
                        <Boxes className="h-3 w-3 shrink-0" aria-hidden />
                        {modelCountLabel(project.model_count)}
                    </span>
                </div>
            </div>

            <ProjectMenu {...props} />
        </div>
    );
}
