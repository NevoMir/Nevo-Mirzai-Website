import { useEffect, useState } from "react";
import { Box } from "lucide-react";

import type { HubProject } from "@/assignment/lib/hub/hubClient";

export interface ProjectPreviewProps {
    project: Pick<HubProject, "id" | "thumbnail_url">;
    /** Sizing only: the card gives it `aspect-[4/3] w-full`, the row a 60 px box.
     *  Everything else about the frame is fixed below. */
    className?: string;
    testIdPrefix?: string;
}

/**
 * The picture of a project: the viewer capture the workspace saved, or a quiet box glyph
 * for a project that has none yet (nothing generated, or the capture is still on its way).
 * The card's frame and the row's thumbnail are the same component at two sizes.
 *
 * The frame sits on `bg-canvas` so a capture with a transparent background reads the
 * same as the viewer's own stage, in light and in dark.
 */
export function ProjectPreview({ project, className = "", testIdPrefix = "project-card" }: ProjectPreviewProps) {
    const url = project.thumbnail_url;
    // A thumbnail that fails to load (deleted from storage, offline) falls back to the glyph
    // instead of a broken-image icon; a NEW url (a fresh capture) gets another try.
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    useEffect(() => setFailedUrl(null), [url]);
    const showImage = !!url && failedUrl !== url;

    return (
        <div
            data-testid={`${testIdPrefix}-preview-${project.id}`}
            data-preview-source={showImage ? "thumbnail" : "placeholder"}
            className={`relative flex items-center justify-center overflow-hidden bg-canvas ${className}`}
        >
            {showImage ? (
                <img
                    src={url}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onError={() => setFailedUrl(url)}
                    className="h-full w-full object-cover"
                />
            ) : (
                <Box className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.5} aria-hidden />
            )}
        </div>
    );
}
