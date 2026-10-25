/**
 * The legend chip of the added-supports overlay, in the chip stack of the 3D tab: "Added supports: 1 column · 1 footing",
 * each count with the swatch of its role colour, and a switch that shows or hides the cubes. It only says what the
 * overlay is and reports the toggle; the viewer draws (or not) what it is told.
 */
import { cn } from "@/assignment/lib/utils";
import { supportsLegendText, supportsTotal, type SupportCount } from "./supports.ts";

export interface SupportsChipProps {
    counts: readonly SupportCount[];
    /** The cubes are on the stage. */
    shown: boolean;
    onShownChange(shown: boolean): void;
    /** Why the cubes are not drawn although the switch is on (the parts are exploded): said beside the switch. */
    note?: string;
    className?: string;
}

export function SupportsChip({ counts, shown, onShownChange, note, className }: SupportsChipProps) {
    if (!counts.length) return null;
    const total = supportsTotal(counts);
    return (
        <div
            role="group"
            aria-label={`${supportsLegendText(counts)} (${total} ${total === 1 ? "block" : "blocks"})`}
            className={cn("pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-background/85 py-0.5 pl-2 pr-1.5 text-[11px] text-foreground shadow-sm backdrop-blur", className)}
        >
            <span className="text-muted-foreground">Added supports:</span>
            <ul className="flex flex-wrap items-center gap-x-1.5">
                {counts.map((c, i) => (
                    <li key={c.role} className="flex items-center gap-1.5">
                        {i > 0 && (
                            <span aria-hidden className="text-muted-foreground">
                                ·
                            </span>
                        )}
                        <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/25" style={{ background: c.color }} />
                        <span className="tabular-nums">{c.label}</span>
                    </li>
                ))}
            </ul>
            {note && <span className="text-muted-foreground">{note}</span>}
            <label className="flex cursor-pointer items-center gap-1.5 pl-0.5 text-muted-foreground" title={shown ? "Hide the added supports" : "Show the added supports"}>
                <span aria-hidden>Show</span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={shown}
                    aria-label="Show added supports"
                    onClick={() => onShownChange(!shown)}
                    className={cn(
                        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                        shown ? "bg-primary" : "bg-muted-foreground/40",
                    )}
                >
                    <span aria-hidden className={cn("inline-block h-3 w-3 rounded-full bg-white shadow transition-transform motion-reduce:transition-none", shown ? "translate-x-3.5" : "translate-x-0.5")} />
                </button>
            </label>
        </div>
    );
}
