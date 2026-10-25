/**
 * The card of a picked support (a cube the stabilizer added to the model): "Added support: column, step 1", where it is, and a
 * button to frame it. The sibling of SelectionCard, in the same place (top right of the uncovered rect); a support is not a
 * part, so there is no Isolate or Hide here.
 */
import { Focus, X } from "lucide-react";
import { Button } from "@/assignment/components/ui/button";
import { cn } from "@/assignment/lib/utils";
import type { SupportInfo } from "./supports.ts";

export interface SupportCardProps {
    info: SupportInfo;
    onFrame(): void;
    onClear(): void;
    /** A narrow stage: the card sits at the bottom, above the toolbar. */
    compact?: boolean;
}

export function SupportCard({ info, onFrame, onClear, compact }: SupportCardProps) {
    return (
        <section
            aria-label={info.heading}
            className={cn(
                "pointer-events-auto absolute z-10 rounded-2xl border border-border/70 bg-sidebar/95 p-3 text-xs shadow-lg backdrop-blur",
                compact ? "inset-x-2 bottom-16" : "right-2 top-2 w-60 max-w-[calc(100%-1rem)]",
            )}
        >
            <div className="flex items-start gap-2">
                <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Added support</h2>
                <Button variant="ghost" size="sm" className="-mr-1 -mt-1 h-6 w-6 shrink-0 p-0" aria-label="Clear the selection" title="Clear the selection (Esc)" onClick={onClear}>
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>
            <p className="mt-1.5 flex items-center gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/25" style={{ background: info.color }} />
                <span className="font-medium">{info.roleLabel}</span>
                <span className="text-muted-foreground">{info.when}</span>
            </p>
            <p className="mt-1 flex gap-2">
                <span className="text-muted-foreground">Height</span>
                <span className="font-medium">{info.zRange}</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onFrame} title="Frame this block">
                    <Focus className="h-3.5 w-3.5" />
                    Frame
                </Button>
            </div>
        </section>
    );
}
