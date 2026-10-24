/**
 * The parts list (Cably's Cad3DParts, ungrouped): every part the model draws. A row's eye hides or
 * shows the part, hovering it lights the part faintly, a click selects it (Shift, Cmd or Ctrl adds),
 * its ⋯ opens the right-click menu's entries; the selected row scrolls into view.
 */
import { useEffect, useRef } from "react";
import { Eye, EyeOff, MoreHorizontal } from "lucide-react";
import { cn } from "@/assignment/lib/utils";
import { partDetail } from "./format.ts";
import type { PartRow, Px } from "./types.ts";

export interface PartsPanelProps {
    rows: readonly PartRow[];
    selected: readonly string[];
    hidden: readonly string[];
    onSelect(id: string, adding: boolean): void;
    onToggle(id: string): void;
    onHover(id: string | null): void;
    onMenu(id: string, at: Px): void;
}

export function PartsPanel({ rows, selected, hidden, onSelect, onToggle, onHover, onMenu }: PartsPanelProps) {
    const listRef = useRef<HTMLUListElement>(null);
    const last = selected[selected.length - 1];
    useEffect(() => {
        const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])].find((el) => el.dataset.row === last);
        row?.scrollIntoView?.({ block: "nearest" });
    }, [last]);
    return (
        <aside
            aria-label="Parts"
            className="pointer-events-auto absolute bottom-16 left-2 top-2 z-10 flex w-64 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-2xl border border-border/70 bg-sidebar/95 shadow-lg backdrop-blur"
        >
            <h2 className="flex items-baseline gap-1.5 px-3 pb-1 pt-2.5 text-xs font-semibold">
                Parts
                <span className="font-normal text-muted-foreground">{rows.length}</span>
            </h2>
            <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
                {rows.map((row) => {
                    const off = hidden.includes(row.id);
                    const on = selected.includes(row.id);
                    return (
                        <li
                            key={row.id}
                            data-row={row.id}
                            data-selected={on ? "" : undefined}
                            className={cn("flex items-center gap-0.5 rounded-md text-xs", on && "bg-muted", off && "text-muted-foreground")}
                            onMouseEnter={() => onHover(row.id)}
                            onMouseLeave={() => onHover(null)}
                        >
                            <button
                                type="button"
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
                                aria-label={`${off ? "Show" : "Hide"} ${row.name}`}
                                title={off ? "Show (H)" : "Hide (H)"}
                                onClick={() => onToggle(row.id)}
                            >
                                {off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </button>
                            <button
                                type="button"
                                className="h-7 min-w-0 flex-1 truncate rounded-md px-1 text-left"
                                aria-pressed={on}
                                title={`${row.name} · ${partDetail(row)}`}
                                onClick={(event) => onSelect(row.id, event.shiftKey || event.metaKey || event.ctrlKey)}
                            >
                                {row.swatch && <span aria-hidden className="mr-1.5 inline-block h-2.5 w-2.5 rounded-[3px] align-[-1px] ring-1 ring-black/25" style={{ background: row.swatch }} />}
                                {row.name}
                                {row.detail && <span className="ml-1.5 text-muted-foreground">{row.detail}</span>}
                            </button>
                            <button
                                type="button"
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                                aria-label={`More for ${row.name}`}
                                title="Isolate, hide, frame"
                                onClick={(event) => {
                                    const r = event.currentTarget.getBoundingClientRect();
                                    onMenu(row.id, { x: r.left, y: r.bottom });
                                }}
                            >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </aside>
    );
}
