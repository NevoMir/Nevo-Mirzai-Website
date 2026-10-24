/**
 * The viewer's toolbar (Cably's Cad3DView bar as a floating pill): Parts toggle with a count badge, Fit,
 * Iso/Top/Front/Right, zoom, Explode (a slider popover), Split into parts (single-mesh models), and
 * Download GLB. Wide strips scroll sideways with a fade instead of a scrollbar (useEdgeFade); on a
 * narrow stage the four views fold into a View menu. In the block view the model-only buttons (Parts,
 * Explode, Split) are left out: there are no parts to list, move or cut there.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Download, Expand, Eye, ListTree, Loader2, Maximize, Scissors, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/assignment/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { HIDDEN_BAR, useEdgeFade } from "@/assignment/hooks/useEdgeFade";
import { cn } from "@/assignment/lib/utils";
import type { ViewPreset } from "./types.ts";

export type SplitState = "off" | "working" | "on";

export interface ViewerToolbarProps {
    compact: boolean;
    /** The block view is on stage: no parts list, explode or split. */
    blocks?: boolean;
    partCount: number;
    treeOpen: boolean;
    onToggleTree(): void;
    onView(view: ViewPreset): void;
    onZoom(steps: number): void;
    /** More than one part: there is something to explode. */
    canExplode: boolean;
    explode: number;
    onExplode(percent: number): void;
    /** Only offered for a model that is a single mesh. */
    canSplit: boolean;
    split: SplitState;
    /** 0..1 while splitting. */
    splitProgress: number;
    onSplit(): void;
    downloadUrl: string | null;
    downloadName: string;
}

const PRESETS: Array<{ view: Exclude<ViewPreset, "fit">; label: string; key: string }> = [
    { view: "iso", label: "Iso", key: "1" },
    { view: "top", label: "Top", key: "2" },
    { view: "front", label: "Front", key: "3" },
    { view: "right", label: "Right", key: "4" },
];

const iconButton = "h-8 w-8 p-0";
const textButton = "h-8 px-2 text-xs";
const pressed = "bg-muted text-foreground";

function Tip({ label, children }: { label: string; children: ReactElement }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
            <TooltipContent side="top" className="px-2 py-1 text-xs">
                {label}
            </TooltipContent>
        </Tooltip>
    );
}

const Divider = () => <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;

export function ViewerToolbar(props: ViewerToolbarProps) {
    const { compact, partCount, treeOpen, canExplode, explode, canSplit, split, blocks = false } = props;
    const fade = useEdgeFade();
    const [explodeOpen, setExplodeOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);

    // The explode popover closes on a press outside it, or when there is nothing to explode.
    useEffect(() => {
        if (!explodeOpen) return;
        const away = (event: PointerEvent) => {
            if (!wrapRef.current?.contains(event.target as Node)) setExplodeOpen(false);
        };
        document.addEventListener("pointerdown", away);
        return () => document.removeEventListener("pointerdown", away);
    }, [explodeOpen]);
    const popoverOpen = explodeOpen && canExplode && !blocks;

    return (
        <div ref={wrapRef} className="pointer-events-auto relative flex max-w-full justify-center">
            {popoverOpen && (
                <div
                    role="group"
                    aria-label="Explode"
                    className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-border/70 bg-sidebar/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
                    onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.stopPropagation();
                        setExplodeOpen(false);
                    }}
                >
                    <label htmlFor="assembly-explode" className="font-medium">
                        Explode
                    </label>
                    <input
                        id="assembly-explode"
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={explode}
                        autoFocus
                        aria-valuetext={`${explode} percent`}
                        className="h-1.5 w-40 cursor-pointer accent-primary"
                        onChange={(event) => props.onExplode(Number(event.target.value))}
                    />
                    <span className="w-9 text-right tabular-nums text-muted-foreground">{explode}%</span>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" disabled={explode === 0} onClick={() => props.onExplode(0)}>
                        Reset
                    </Button>
                </div>
            )}
            <div className="flex h-11 max-w-full items-center gap-1 rounded-2xl border border-border/70 bg-sidebar/95 px-2 shadow-lg backdrop-blur">
                <div ref={fade} className={cn("-mx-1 flex min-w-0 items-center gap-1 self-stretch overflow-x-auto px-1", HIDDEN_BAR)}>
                    {!blocks && (
                        <Tip label={treeOpen ? "Hide the parts list" : "Show the parts list"}>
                            <Button variant="ghost" size="sm" className={cn("relative", iconButton, treeOpen && pressed)} aria-label="Parts" aria-pressed={treeOpen} onClick={props.onToggleTree}>
                                <ListTree className="h-4 w-4" />
                                {partCount > 0 && (
                                    <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-primary px-1 text-[9px] font-medium leading-[14px] text-primary-foreground">
                                        {partCount}
                                    </span>
                                )}
                            </Button>
                        </Tip>
                    )}
                    <Tip label={blocks ? "Fit the 1 m volume (0)" : "Fit the model (0)"}>
                        <Button variant="ghost" size="sm" className={iconButton} aria-label="Fit" onClick={() => props.onView("fit")}>
                            <Maximize className="h-4 w-4" />
                        </Button>
                    </Tip>
                    {compact ? (
                        <DropdownMenu modal={false}>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className={textButton} aria-label="View">
                                    <Eye className="h-4 w-4" />
                                    View
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" side="top">
                                {PRESETS.map((p) => (
                                    <DropdownMenuItem key={p.view} onSelect={() => props.onView(p.view)}>
                                        {p.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        PRESETS.map((p) => (
                            <Tip key={p.view} label={`${p.label} view (${p.key})`}>
                                <Button variant="ghost" size="sm" className={textButton} aria-label={`${p.label} view`} onClick={() => props.onView(p.view)}>
                                    {p.label}
                                </Button>
                            </Tip>
                        ))
                    )}
                    <Divider />
                    <Tip label="Zoom out (−)">
                        <Button variant="ghost" size="sm" className={iconButton} aria-label="Zoom out" onClick={() => props.onZoom(-1)}>
                            <ZoomOut className="h-4 w-4" />
                        </Button>
                    </Tip>
                    <Tip label="Zoom in (+)">
                        <Button variant="ghost" size="sm" className={iconButton} aria-label="Zoom in" onClick={() => props.onZoom(1)}>
                            <ZoomIn className="h-4 w-4" />
                        </Button>
                    </Tip>
                    {!blocks && (
                        <>
                            <Divider />
                            <Tip label={canExplode ? "Explode the parts" : "Explode needs a model with several parts"}>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(iconButton, (popoverOpen || (canExplode && explode > 0)) && pressed)}
                                    aria-label="Explode"
                                    aria-expanded={popoverOpen}
                                    disabled={!canExplode}
                                    onClick={() => setExplodeOpen((open) => !open)}
                                >
                                    <Expand className="h-4 w-4" />
                                </Button>
                            </Tip>
                        </>
                    )}
                    {canSplit && !blocks && (
                        <Tip label={split === "on" ? "Back to the original model" : split === "working" ? `Splitting… ${Math.round(props.splitProgress * 100)}%` : "Split into parts"}>
                            <Button
                                variant="ghost"
                                size="sm"
                                className={cn(iconButton, split === "on" && pressed)}
                                aria-label="Split into parts"
                                aria-pressed={split === "on"}
                                disabled={split === "working"}
                                onClick={props.onSplit}
                            >
                                {split === "working" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                            </Button>
                        </Tip>
                    )}
                    {props.downloadUrl && (
                        <>
                            <Divider />
                            <Tip label="Download GLB">
                                <Button asChild variant="ghost" size="sm" className={iconButton}>
                                    <a href={props.downloadUrl} download={`${props.downloadName}.glb`} aria-label="Download GLB">
                                        <Download className="h-4 w-4" />
                                    </a>
                                </Button>
                            </Tip>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
