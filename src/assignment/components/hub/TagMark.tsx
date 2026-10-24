import type { HubTag } from "@/assignment/lib/hub/hubClient";
import { tagColor, tagIcon } from "@/assignment/lib/hub/tagIcons";

/**
 * A tag's mark in menus: its icon in its colour, or (for a tag with no icon) the colour dot
 * the sidebar and the chips draw. Without this a tag that has no icon would show the
 * fallback folder glyph in a menu and a dot everywhere else.
 */
export function TagMark({ tag, className = "h-3.5 w-3.5" }: { tag: Pick<HubTag, "icon" | "color">; className?: string }) {
    const color = tagColor(tag.color);
    if (tag.icon) {
        const Icon = tagIcon(tag.icon);
        return <Icon className={`${className} shrink-0`} style={{ color }} aria-hidden />;
    }
    return (
        <span aria-hidden className={`${className} flex shrink-0 items-center justify-center`}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        </span>
    );
}
