/**
 * The selection card (Cably's Cad3DSelection): one part's name, triangles and size in mm, or the
 * count of several, with Isolate, Hide and Clear. Top right of the uncovered rect.
 */
import { X } from "lucide-react";
import { Button } from "@/assignment/components/ui/button";
import { cn } from "@/assignment/lib/utils";
import { formatCount, num } from "./format.ts";
import type { PartRow } from "./types.ts";

export interface SelectionCardProps {
    rows: readonly PartRow[];
    /** Every selected part is hidden: Show instead of Hide. */
    hidden: boolean;
    /** The view is isolating: the button leaves isolate instead. */
    isolated: boolean;
    onIsolate(): void;
    onHide(): void;
    onClear(): void;
    /** A narrow stage: the card sits at the bottom, above the toolbar, as Cably's does on phones. */
    compact?: boolean;
}

export function SelectionCard({ rows, hidden, isolated, onIsolate, onHide, onClear, compact }: SelectionCardProps) {
    const [one] = rows;
    if (!one) return null;
    const button = "h-7 px-2 text-xs";
    const triangles = rows.reduce((sum, r) => sum + r.triangles, 0);
    return (
        <section
            aria-label="Selection"
            className={cn(
                "pointer-events-auto absolute z-10 rounded-2xl border border-border/70 bg-sidebar/95 p-3 text-xs shadow-lg backdrop-blur",
                compact ? "inset-x-2 bottom-16" : "right-2 top-2 w-60 max-w-[calc(100%-1rem)]",
            )}
        >
            <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{rows.length === 1 ? one.name : `${rows.length} parts`}</h2>
                <Button variant="ghost" size="sm" className="-mr-1 -mt-1 h-6 w-6 shrink-0 p-0" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={onClear}>
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>
            {rows.length === 1 && one.detail && (
                <p className="mt-1.5 flex items-center gap-2">
                    <span className="text-muted-foreground">Blocks</span>
                    {one.swatch && <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px] ring-1 ring-black/25" style={{ background: one.swatch }} />}
                    <span className="font-medium">{one.detail.replace(/ blocks?$/, "")}</span>
                </p>
            )}
            <p className="mt-1.5 flex gap-2">
                <span className="text-muted-foreground">Triangles</span>
                <span className="font-medium">{formatCount(triangles)}</span>
            </p>
            {rows.length === 1 && one.size && (
                <p className="mt-1 flex gap-2">
                    <span className="text-muted-foreground">Size</span>
                    <span className="font-medium">{one.size.map(num).join(" × ")} mm</span>
                </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1">
                <Button variant="outline" size="sm" className={button} onClick={onIsolate} title="Isolate (I)">
                    {isolated ? "Exit isolate" : "Isolate"}
                </Button>
                <Button variant="outline" size="sm" className={button} onClick={onHide} title={`${hidden ? "Show" : "Hide"} (H)`}>
                    {hidden ? "Show" : "Hide"}
                </Button>
            </div>
        </section>
    );
}
