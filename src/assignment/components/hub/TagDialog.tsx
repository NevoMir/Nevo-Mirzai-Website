import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/assignment/components/ui/dialog";
import { Input } from "@/assignment/components/ui/input";
import { ApiRequestError } from "@/assignment/lib/api";
import { createTag, updateTag, type HubTag } from "@/assignment/lib/hub/hubClient";
import { isImeKey } from "@/assignment/lib/hub/ime";
import {
    DEFAULT_TAG_COLOR,
    isTagColor,
    nextTagColor,
    TAG_COLORS,
    TAG_ICON_GROUPS,
    tagColorName,
    tagIcon,
} from "@/assignment/lib/hub/tagIcons";

/** Long enough for any sensible label; short enough to fit the sidebar. */
const TAG_NAME_MAX = 40;

export interface TagDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Editing an existing tag, or null to create one. */
    tag?: HubTag | null;
    /** Every tag name in use: a tag name is unique (ignoring case). */
    existingNames?: string[];
    /** Colours the existing tags already wear: a new tag starts on one they do not, so
     *  tags tell apart without anyone picking. */
    usedColors?: string[];
    onSaved: (tag: HubTag) => void;
}

/**
 * New tag / tag settings.
 *
 * A tag is a name, a colour and (optionally) an icon. The checks here (name present and
 * not already used, colour `#rrggbb`) each have a server-side counterpart: the Worker
 * answers 409 for a duplicate name and 400 for a bad colour. This dialog exists to say
 * so before the round trip, not instead of it.
 */
export function TagDialog({
    open,
    onOpenChange,
    tag = null,
    existingNames = [],
    usedColors = [],
    onSaved,
}: TagDialogProps) {
    const [name, setName] = useState("");
    /** null = colour only, which is what a tag is when nobody picks a glyph. The sidebar,
     *  the chips and the preview above all read it the same way. */
    const [icon, setIcon] = useState<string | null>(null);
    /** The catalogue is long and in groups; a box that narrows it is what makes that a
     *  feature rather than a scroll. */
    const [iconQuery, setIconQuery] = useState("");
    const [color, setColor] = useState<string>(DEFAULT_TAG_COLOR);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which opening of the dialog this is. A save that finishes after the dialog was closed and
     *  opened again belongs to the opening before: it must not close the new one or reset its
     *  busy flag. */
    const session = useRef(0);

    useEffect(() => {
        if (!open) return;
        session.current += 1;
        setName(tag?.name ?? "");
        setIcon(tag?.icon ?? null);
        setIconQuery("");
        setColor(tag?.color && isTagColor(tag.color) ? tag.color : nextTagColor(usedColors));
        setError(null);
        setBusy(false);
        // usedColors is read when the dialog opens, not tracked: the palette does not move
        // under a dialog that is already showing a colour.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, tag]);

    const taken = useMemo(
        () =>
            new Set(
                existingNames
                    .filter((n) => n.toLowerCase() !== (tag?.name ?? "").toLowerCase())
                    .map((n) => n.trim().toLowerCase()),
            ),
        [existingNames, tag?.name],
    );

    const trimmed = name.trim();
    const nameError = !trimmed
        ? "A tag needs a name."
        : taken.has(trimmed.toLowerCase())
          ? "That name is already used by another tag."
          : null;

    const Icon = icon ? tagIcon(icon) : null;

    /** The groups, with everything that does not match the box dropped, and a group that
     *  is left with nothing dropped with it. Matching is on the icon NAME, which is what
     *  the catalogue is keyed by and what a reader searching for "rocket" has in mind. */
    const groups = useMemo(() => {
        const needle = iconQuery.trim().toLowerCase();
        return TAG_ICON_GROUPS.map((group) => ({
            group: group.group,
            names: Object.keys(group.icons).filter((n) => !needle || n.toLowerCase().includes(needle)),
        })).filter((group) => group.names.length > 0);
    }, [iconQuery]);

    const save = async () => {
        if (nameError) {
            setError(nameError);
            return;
        }
        if (!isTagColor(color)) {
            setError("Pick a colour.");
            return;
        }
        const mine = session.current;
        setBusy(true);
        setError(null);
        try {
            const saved = tag
                ? await updateTag(tag.id, { name: trimmed, icon, color })
                : await createTag({ name: trimmed, icon, color });
            // The tag exists now whatever happened to the dialog meanwhile.
            onSaved(saved);
            if (mine === session.current) onOpenChange(false);
        } catch (err) {
            // 409: another tab made a tag with this name since this list was read.
            if (mine === session.current) {
                setError(
                    err instanceof ApiRequestError && err.status === 409
                        ? "That name is already used by another tag."
                        : err instanceof Error
                          ? err.message
                          : String(err),
                );
            }
        } finally {
            if (mine === session.current) setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{tag ? "Tag settings" : "New tag"}</DialogTitle>
                    <DialogDescription>Give it a name, then a colour and, if you like, an icon.</DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div
                            data-testid="tag-preview"
                            className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border"
                            style={{ backgroundColor: `${color}22`, color }}
                        >
                            {Icon ? (
                                <Icon className="h-6 w-6" />
                            ) : (
                                // Exactly what the sidebar draws for a tag with no icon.
                                <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: color }} />
                            )}
                        </div>
                        <Input
                            autoFocus
                            aria-label="Tag name"
                            placeholder="Tag name"
                            maxLength={TAG_NAME_MAX}
                            value={name}
                            onChange={(e) => {
                                setName(e.target.value);
                                // A server's "already used" (or a network error) was about the name
                                // as it was; the live check below speaks for the new one.
                                setError(null);
                            }}
                            onKeyDown={(e) => {
                                // Enter that confirms an IME candidate is not "create the tag".
                                if (e.key === "Enter" && !isImeKey(e) && !nameError && !busy) void save();
                            }}
                        />
                    </div>

                    <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Icon</p>
                        <Input
                            value={iconQuery}
                            onChange={(e) => setIconQuery(e.target.value)}
                            placeholder="Search icons"
                            aria-label="Search icons"
                            // 16 px on a phone (iOS Safari zooms the page in on anything smaller).
                            className="mb-1.5 h-8 text-base md:text-xs"
                        />
                        <div
                            data-testid="tag-icon-picker"
                            className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border p-2"
                        >
                            {/* First, because a colour IS a tag: the icon is the extra. */}
                            <button
                                type="button"
                                aria-label="No icon (colour only)"
                                aria-pressed={!icon}
                                onClick={() => setIcon(null)}
                                className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors ${
                                    !icon
                                        ? "bg-accent text-accent-foreground ring-2 ring-primary"
                                        : "text-muted-foreground hover:bg-secondary"
                                }`}
                            >
                                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                                No icon (colour only)
                            </button>

                            {groups.map((group) => (
                                <div key={group.group}>
                                    <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {group.group}
                                    </p>
                                    <div className="grid grid-cols-8 gap-1">
                                        {group.names.map((iconName) => {
                                            const Candidate = tagIcon(iconName);
                                            const picked = icon === iconName;
                                            return (
                                                <button
                                                    key={iconName}
                                                    type="button"
                                                    aria-label={iconName}
                                                    title={iconName}
                                                    aria-pressed={picked}
                                                    onClick={() => setIcon(iconName)}
                                                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                                                        picked
                                                            ? "bg-accent text-accent-foreground ring-2 ring-primary"
                                                            : "text-muted-foreground hover:bg-secondary"
                                                    }`}
                                                >
                                                    <Candidate className="h-4 w-4" />
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}

                            {groups.length === 0 && (
                                <p className="px-1 py-2 text-xs text-muted-foreground">No icon matches that.</p>
                            )}
                        </div>
                    </div>

                    <div>
                        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Colour</p>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {TAG_COLORS.map((swatch) => (
                                <button
                                    key={swatch}
                                    type="button"
                                    aria-label={tagColorName(swatch)}
                                    title={tagColorName(swatch)}
                                    aria-pressed={color.toLowerCase() === swatch}
                                    onClick={() => setColor(swatch)}
                                    style={{ backgroundColor: swatch }}
                                    className={`h-6 w-6 rounded-full border-2 transition-transform ${
                                        color.toLowerCase() === swatch ? "scale-110 border-foreground" : "border-transparent"
                                    }`}
                                />
                            ))}
                            <input
                                type="color"
                                aria-label="Custom colour"
                                value={isTagColor(color) ? color : DEFAULT_TAG_COLOR}
                                onChange={(e) => setColor(e.target.value)}
                                className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                            />
                        </div>
                    </div>

                    {(error || (name.length > 0 && nameError)) && (
                        <p role="alert" className="text-xs text-destructive">
                            {error ?? nameError}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                    <Button onClick={() => void save()} disabled={busy || !!nameError}>
                        {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                        {tag ? "Save" : "Create tag"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
