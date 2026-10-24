import { useRef } from "react";
import { Boxes, Pin } from "lucide-react";

import { InlineName, renameJustSettled, type RenameInPlace } from "@/assignment/components/hub/InlineName";
import { ProjectMenu } from "@/assignment/components/hub/ProjectMenu";
import { ProjectPreview } from "@/assignment/components/hub/ProjectPreview";
import { TagChips, type TagChipsProps } from "@/assignment/components/hub/TagChips";
import { modelCountLabel, relativeTime, type HubProject } from "@/assignment/lib/hub/hubClient";

export interface ProjectCardProps extends TagChipsProps, RenameInPlace {
    onOpen: (project: HubProject) => void;
    className?: string;
    /** The same project appears in Recent AND in the list (one card component, two
     *  places), so the test handle says which one this is. */
    testIdPrefix?: string;
}

/**
 * One project as a picture with its name underneath: the Recent row's shape. The list
 * below it uses `ProjectRow`; both draw the picture with `ProjectPreview` and hang the
 * same `ProjectMenu` off it.
 */
export function ProjectCard(props: ProjectCardProps) {
    const {
        project,
        onOpen,
        className = "",
        testIdPrefix = "project-card",
        renamingId = null,
        onCommitRename,
        onCancelRename,
    } = props;

    /** The card's Open button: where focus goes when a keyboard rename ends. */
    const openRef = useRef<HTMLButtonElement>(null);

    /** Open, except while the name is being edited, when a click anywhere on the card is
     *  the "click away to finish" that commits the name on blur. */
    const open = () => {
        if (renamingId !== project.id && !renameJustSettled(project.id)) onOpen(project);
    };

    return (
        <div
            data-testid={`${testIdPrefix}-${project.id}`}
            className={`group relative flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card transition-shadow hover:shadow-lg ${className}`}
        >
            <button
                ref={openRef}
                type="button"
                // The picture is the card's Open button, the one a keyboard reaches.
                onClick={open}
                className="relative block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open ${project.name}`}
            >
                <ProjectPreview project={project} testIdPrefix={testIdPrefix} className="aspect-[4/3] w-full" />
                {/* How much is inside, over the picture's corner: a text line for it would not fit a
                    card this narrow, and a third line would make the card taller. */}
                {project.model_count > 0 && (
                    <span
                        title={modelCountLabel(project.model_count)}
                        className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground backdrop-blur-sm"
                    >
                        <Boxes className="h-3 w-3" aria-hidden />
                        {project.model_count}
                    </span>
                )}
            </button>

            <div className="flex items-center gap-1 px-3 py-2">
                <div className="min-w-0 flex-1">
                    {/* The name and its stamp open the project too: a tap on a card opens it, and
                        Rename is the "⋯" menu's. */}
                    <p
                        onClick={open}
                        className="flex cursor-pointer items-center gap-1 truncate text-sm font-medium text-foreground"
                    >
                        {project.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        <InlineName
                            value={project.name}
                            editing={renamingId === project.id}
                            onCommit={(name) => onCommitRename?.(project, name)}
                            onCancel={() => onCancelRename?.()}
                            className="truncate"
                            settleKey={project.id}
                            returnFocusTo={() => openRef.current}
                        />
                    </p>
                    <p onClick={open} className="cursor-pointer truncate text-[11px] text-muted-foreground">
                        Edited {relativeTime(project.modified_at)}
                    </p>
                    {/* Two at most, under the title: the picture is the thing a card is for.
                        The rest are a "+N". */}
                    <TagChips {...props} maxChips={2} testIdPrefix={testIdPrefix} className="mt-1 flex-wrap" />
                </div>

                <ProjectMenu {...props} />
            </div>
        </div>
    );
}
