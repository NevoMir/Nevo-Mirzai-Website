/**
 * A menu at a point (Cably's editor ContextMenu): the right-click on the model, or a parts row's ⋯.
 * A dropdown menu anchored to an empty box at the click; an entry may be disabled, saying why in its tooltip.
 */
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import type { Px } from "./types.ts";

export interface MenuEntry {
    label: string;
    run(): void;
    disabled?: boolean;
    title?: string;
}

export function ViewerContextMenu({ at, entries, onClose }: { at: Px; entries: readonly MenuEntry[]; onClose(): void }) {
    return (
        <DropdownMenu open modal={false} onOpenChange={(open) => !open && onClose()}>
            <DropdownMenuTrigger asChild>
                <span aria-hidden className="pointer-events-none fixed h-0 w-0" style={{ left: at.x, top: at.y }} />
            </DropdownMenuTrigger>
            {/* Closing gives the keys back to the stage (onClose), not to the empty box. */}
            <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
                {entries.map((entry) => (
                    <DropdownMenuItem key={entry.label} disabled={entry.disabled} title={entry.title} className="data-[disabled]:pointer-events-auto" onSelect={() => entry.run()}>
                        {entry.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
