import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert, Trash2, WandSparkles } from "lucide-react";

import { TONE } from "@/assignment/components/analysis/style";
import { revealStabilizeCard } from "@/assignment/components/analysis/stabilizeFocus";
import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/assignment/components/ui/sheet";
import { DeleteVersionDialog } from "@/assignment/components/workspace/DeleteVersionDialog";
import { KindIcon, TreeConnector } from "@/assignment/components/workspace/KindIcon";
import { versionDetail } from "@/assignment/components/workspace/format";
import { draftIsOn } from "@/assignment/components/workspace/shellLogic";
import { handleVersionKey, openVersion, stepVersion, versionKeyEvent } from "@/assignment/components/workspace/versionActions";
import {
    familyRows,
    familyTitle,
    offerLabel,
    segmentLabel,
    segmentTitle,
    statusMark,
    targetOf,
    versionRowLine,
    type MarkTone,
    type StatusMark,
    type VersionKind,
} from "@/assignment/components/workspace/versionLogic";
import type { VersionSwitcherState } from "@/assignment/components/workspace/useVersionSwitcherState";
import { useAfterMenuClose } from "@/assignment/components/hub/useAfterMenuClose";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import { canDelete, isVersion, KIND_WORD, rememberHead, stepTarget } from "@/assignment/shared/versionTree";
import type { Verdict } from "@/assignment/store/analysisLogic";
import { deleteVersion } from "@/assignment/store/models";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import type { VersionFamily } from "@/assignment/store/versions";
import { useVoxelEditStore } from "@/assignment/store/voxelEdit";

// ---------- a status mark: a symbol and a number, never colour alone ----------

const MARK_TEXT: Record<MarkTone, string> = { fail: TONE.fail.text, warn: TONE.warn.text, pass: TONE.pass.text, none: "text-muted-foreground" };

/** How much a mark says beside its symbol: the words ("4 problems"), just the number, or nothing. */
type MarkDetail = "text" | "count" | "none";

/**
 * Four marks, four shapes: a hollow ring (nothing known yet), a tick (stable), a filled dot (problems), a triangle (warnings).
 * Where only the number fits, the shape still tells problems from warnings.
 */
function Mark({ mark, analysing, detail }: { mark: StatusMark; analysing: boolean; detail: MarkDetail }) {
    if (mark.tone === "none") {
        return analysing ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        ) : (
            // Hollow: nothing is known about it yet.
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full border border-muted-foreground/60" />
        );
    }
    if (mark.tone === "pass") {
        return (
            <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", MARK_TEXT.pass)} data-mark="pass">
                <Check className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={3} aria-hidden />
                {detail === "text" && mark.text}
            </span>
        );
    }
    return (
        <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", MARK_TEXT[mark.tone])} data-mark={mark.tone}>
            {mark.tone === "warn" ? (
                <TriangleAlert className={cn("h-3 w-3 shrink-0", TONE.warn.icon)} aria-hidden />
            ) : (
                <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE.fail.solid)} />
            )}
            {detail === "text" ? mark.text : detail === "count" ? mark.count : null}
        </span>
    );
}

/** The mark of one model, from its verdict (live this visit, else the saved summary). */
function useMarkOf(model: ModelAsset | null): { mark: StatusMark; analysing: boolean; verdict: Verdict | null } {
    const verdict = useModelVerdict(model);
    const analysing = useModelAnalysing(model?.id ?? "");
    return { mark: statusMark(verdict, analysing), analysing, verdict };
}

// ---------- the two halves ----------

/**
 * How the control is set: `words` says "4 problems" beside the mark (else just the count), `small` is the phone's row (taller
 * controls for a finger), `embedded` sits inside the bar's tab card instead of being a card of its own.
 */
interface Look {
    words: boolean;
    small: boolean;
    embedded: boolean;
}

const segmentClass = (active: boolean, { words, small }: Look) =>
    cn(
        "flex items-center gap-1.5 whitespace-nowrap rounded-xl text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        small ? "h-8" : "h-7",
        words ? "px-2.5" : "px-2",
        active ? "bg-background font-medium text-foreground shadow-sm ring-1 ring-border/70" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
    );

interface SegmentProps {
    kind: VersionKind;
    /** The model this half stands for (the original, or the version you are working on). */
    model: ModelAsset;
    /** "v4 · Lightest" for the head, "Original" for the root. */
    title: string;
    active: boolean;
    look: Look;
    onPick: () => void;
    buttonRef: Ref<HTMLButtonElement>;
}

/** Unsaved block changes (applied edits, not a mere proposal) wait on this version: the half or row that stands for it says so. */
function useDraftOn(model: ModelAsset): boolean {
    return useVoxelEditStore((s) => draftIsOn(s, model.id));
}

function Segment({ kind, model, title, active, look, onPick, buttonRef }: SegmentProps) {
    const { mark, analysing } = useMarkOf(model);
    // On the half that stands for the version the changes belong to, wherever the person is looking (the original can be on screen).
    const draft = useDraftOn(model);
    // The compact bar keeps the number and drops the name ("v4"): the words are in the tooltip.
    const text = kind === "head" && !look.words ? title.split(" · ")[0] : title;
    return (
        <button
            ref={buttonRef}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={segmentLabel(kind, mark, kind === "head" ? title : null)}
            title={segmentTitle(kind, mark, kind === "head" ? { title, detail: versionDetail(model) } : null)}
            tabIndex={active ? 0 : -1}
            data-testid={`version-${kind}`}
            data-active={active}
            data-tone={mark.tone}
            onClick={onPick}
            className={segmentClass(active, look)}
        >
            <span className={cn("truncate", kind === "head" && "max-w-[11rem]")} data-testid={`version-${kind}-text`}>
                {text}
            </span>
            <Mark mark={mark} analysing={analysing} detail={look.words ? "text" : "count"} />
            {draft && (
                <span
                    data-testid="version-draft"
                    title="You have changes to this version that are not saved yet"
                    className="rounded-full border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium leading-4 text-primary"
                >
                    Draft
                </span>
            )}
        </button>
    );
}

// ---------- the tree of versions ----------

/** The cap of rows the popover shows without scrolling. */
const TREE_MAX_HEIGHT = "min(22rem, 60dvh)";

/**
 * One row of the tree: the connectors, the kind's glyph, "v2 · Taller back", what it did, its mark, the time. The glyphs and the tick are
 * pictures: a screen reader gets the kind in a word ("Edited") and the row on screen from `aria-current` on the row itself.
 */
function TreeRowBody({ row, family, active }: { row: ReturnType<typeof familyRows>[number]; family: VersionFamily; active: boolean }) {
    const { model } = row;
    const { mark, analysing } = useMarkOf(model);
    const draft = useDraftOn(model);
    const title = familyTitle(family, model);
    const detail = versionDetail(model);
    const line = versionRowLine(model, title, mark);
    return (
        <>
            <TreeConnector depth={row.depth} lines={row.lines} last={row.last} cell={14} />
            <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">{active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}</span>
            <KindIcon kind={model.kind} className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={line}>
                {/* "v4 · Lightest" does not say what kind of version it is; "v1 · Original" does. */}
                {isVersion(model) && !title.includes(KIND_WORD[model.kind]) && (
                    <span className="sr-only" data-testid="version-row-kind">
                        {KIND_WORD[model.kind]}.{" "}
                    </span>
                )}
                <span className="text-xs">{title}</span>
                {detail && <span className="ml-1.5 text-[11px] text-muted-foreground">{detail}</span>}
            </span>
            {draft && (
                <span data-testid="version-row-draft" className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 text-[10px] font-medium leading-4 text-primary">
                    Draft
                </span>
            )}
            <Mark mark={mark} analysing={analysing} detail="none" />
            <span className="sr-only">{mark.text}</span>
        </>
    );
}

/** The rows of the tree as buttons, for the phone's sheet: the same rows as the desktop menu, one finger tall. */
export function VersionTreeList({ family, onPick }: { family: VersionFamily; onPick: (model: ModelAsset) => void }) {
    const rows = familyRows(family);
    return (
        <ul className="mt-2 overflow-y-auto px-2 pb-2" style={{ maxHeight: TREE_MAX_HEIGHT }} data-testid="version-tree-list">
            {rows.map((row) => {
                const active = row.model.id === family.active.id;
                return (
                    <li key={row.model.id}>
                        <button
                            type="button"
                            data-testid="version-menu-item"
                            data-active={active}
                            data-depth={row.depth}
                            aria-current={active ? "true" : undefined}
                            className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-secondary/60"
                            onClick={() => onPick(row.model)}
                        >
                            <TreeRowBody row={row} family={family} active={active} />
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

/**
 * The tree behind the chevron: every version of the family, indented under the one it was made from, the one on screen ticked. A row
 * opens that version; below, the version on screen can walk to its parent or newest child and be deleted. A Sheet on a phone.
 */
function VersionTree({ family, look, onDelete }: { family: VersionFamily; look: Look; onDelete: (model: ModelAsset) => void }) {
    const rows = familyRows(family);
    const [open, setOpen] = useState(false);
    const models = useWorkspaceStore((s) => s.models);
    const { defer, onCloseAutoFocus } = useAfterMenuClose();
    const parent = stepTarget(models, family.active, "parent");
    const child = stepTarget(models, family.active, "child");
    const deletable = canDelete(family.active);

    const trigger = (
        <button
            type="button"
            data-testid="version-menu-trigger"
            aria-label={`Show all versions (${rows.length})`}
            title="All versions of this model"
            onClick={look.small ? () => setOpen(true) : undefined}
            className={cn(
                "grid shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground data-[state=open]:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                look.small ? "h-8 w-8" : "h-7 w-6",
            )}
        >
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </button>
    );

    if (look.small) {
        // A phone: the rows are buttons in a sheet from the bottom.
        return (
            <>
                {trigger}
                <Sheet open={open} onOpenChange={setOpen}>
                    <SheetContent side="bottom" className="max-h-[70dvh] gap-0 rounded-t-2xl border-border/70 bg-sidebar p-0 pb-[env(safe-area-inset-bottom)]" data-testid="version-sheet">
                        <SheetTitle className="px-4 pt-4 text-sm">Versions · {rows.length}</SheetTitle>
                        <SheetDescription className="sr-only">Every version of this model. Pick one to show it.</SheetDescription>
                        <VersionTreeList
                            family={family}
                            onPick={(model) => {
                                openVersion(model);
                                setOpen(false);
                            }}
                        />
                        <div className="flex flex-wrap gap-2 border-t border-border/70 px-4 py-3">
                            <button type="button" disabled={!parent} onClick={() => stepVersion("parent")} className="h-9 rounded-lg border border-border px-3 text-xs disabled:opacity-50">
                                Earlier version
                            </button>
                            <button type="button" disabled={!child} onClick={() => stepVersion("child")} className="h-9 rounded-lg border border-border px-3 text-xs disabled:opacity-50">
                                Later version
                            </button>
                            {deletable && (
                                <button
                                    type="button"
                                    data-testid="version-delete"
                                    onClick={() => {
                                        setOpen(false);
                                        onDelete(family.active);
                                    }}
                                    className="ml-auto h-9 rounded-lg px-3 text-xs text-destructive hover:bg-destructive/10"
                                >
                                    Delete {familyTitle(family, family.active)}…
                                </button>
                            )}
                        </div>
                    </SheetContent>
                </Sheet>
            </>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[22rem] max-w-[calc(100vw-1rem)] p-1" data-testid="version-menu" onCloseAutoFocus={onCloseAutoFocus}>
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">Versions · {rows.length}</p>
                <div className="overflow-y-auto" style={{ maxHeight: TREE_MAX_HEIGHT }}>
                    {rows.map((row) => {
                        const active = row.model.id === family.active.id;
                        return (
                            <DropdownMenuItem
                                key={row.model.id}
                                className="min-h-8 gap-2 px-1.5 text-xs"
                                data-testid="version-menu-item"
                                data-active={active}
                                data-depth={row.depth}
                                aria-current={active ? "true" : undefined}
                                onSelect={() => openVersion(row.model)}
                            >
                                <TreeRowBody row={row} family={family} active={active} />
                            </DropdownMenuItem>
                        );
                    })}
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="gap-2 text-xs" disabled={!parent} onSelect={() => void stepVersion("parent")} data-testid="version-earlier">
                    Earlier version <DropdownMenuShortcut>[</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem className="gap-2 text-xs" disabled={!child} onSelect={() => void stepVersion("child")} data-testid="version-later">
                    Later version <DropdownMenuShortcut>]</DropdownMenuShortcut>
                </DropdownMenuItem>
                {deletable && (
                    <DropdownMenuItem
                        className="gap-2 text-xs text-destructive focus:text-destructive"
                        data-testid="version-delete"
                        onSelect={() => defer(() => onDelete(family.active))}
                    >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        Delete {familyTitle(family, family.active)}…
                    </DropdownMenuItem>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------- the switcher ----------

/**
 * The card: 36 px tall like the other cards of the bar (40 px in the phone's row, where the controls are 32 px). Embedded in the
 * bar's tab card it is only a tray: the tab card is the card.
 */
const card = ({ small, embedded }: Look) =>
    embedded
        ? "flex shrink-0 items-center rounded-xl bg-secondary/60 p-[2px]"
        : cn(
              "pointer-events-auto flex shrink-0 items-center rounded-2xl border border-border/70 bg-sidebar/95 p-[3px] shadow-lg backdrop-blur",
              small ? "h-10" : "h-9",
          );

/**
 * The bar's version control: "Original | v4 · Lightest ▾", each half with its structural status (a red "4 problems", a green "Stable"),
 * one click to the other one on whichever tab is open. The right half is the version you are working on (the one on screen, else the one
 * seen last, else the newest); the chevron beside it opens the tree of every version, newest ones under the one they were made from.
 * It is the only way to move between the versions of a model from the stage or the Stability tab: neither has a button of its own. A
 * model that has problems and no version yet gets a "Stabilize…" pill that opens the Stability tab at its Stabilize button. "V" flips
 * between the two halves, "[" and "]" walk the tree, while the 3D view or this control has focus (WorkspaceShell, and the control's own key
 * handler).
 *
 * `compact` drops the words next to the marks (a narrow bar); `row` is the phone's row under the bar: compact, with controls tall
 * enough for a finger; `embedded` sits inside the bar's tab card (a tray without its own border), where it fills room the tab strip
 * leaves free, so nothing in the bar moves when it comes and goes.
 */
export function VersionSwitcher({
    state,
    compact = false,
    row = false,
    embedded = false,
    className,
}: {
    state: VersionSwitcherState;
    compact?: boolean;
    row?: boolean;
    embedded?: boolean;
    className?: string;
}) {
    const { mode, family } = state;
    if (mode === "none" || !family || !family.root) return null;
    const look: Look = { words: !compact && !row, small: row, embedded };
    return mode === "switch" ? (
        <Switch family={family} root={family.root} look={look} className={className} />
    ) : (
        <Offer root={family.root} look={look} className={className} />
    );
}

function Switch({ family, root, look, className }: { family: VersionFamily; root: ModelAsset; look: Look; className?: string }) {
    const originalRef = useRef<HTMLButtonElement>(null);
    const headRef = useRef<HTMLButtonElement>(null);
    const [confirming, setConfirming] = useState<ModelAsset | null>(null);
    const models = useWorkspaceStore((s) => s.models);
    const onVersion = family.isVersion;
    const head = family.head;

    // Which version is on screen, for "back to the version" (the V key, a click on the half).
    useEffect(() => {
        if (family.isVersion) rememberHead(models, family.active);
    }, [family, models]);

    // Arrow keys move the choice, like the report's other segmented controls (the radio-group keys); V flips it, [ and ] walk the tree.
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        // The tree menu is a portal: its key presses bubble here through the React tree, but they are not ours.
        if (event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        const key = event.key.toLowerCase();
        if (key === "v" || key === "[" || key === "]") {
            // Keep the focus on the half that is now showing.
            if (handleVersionKey(versionKeyEvent(event))) {
                const showing = useWorkspaceStore.getState().activeModelId;
                (showing === root.id ? originalRef : headRef).current?.focus();
            }
            return;
        }
        const kind: VersionKind | null = event.key === "ArrowLeft" ? "original" : event.key === "ArrowRight" ? "head" : null;
        if (!kind) return;
        const target = targetOf(kind, family);
        if (!target) return;
        event.preventDefault();
        if (target.id !== family.active.id) openVersion(target);
        (kind === "original" ? originalRef : headRef).current?.focus();
    };

    const confirmDelete = (model: ModelAsset) => {
        setConfirming(null);
        void deleteVersion(model);
    };

    if (!head) return null;
    return (
        <div data-testid="version-switcher" data-mode="switch" className={cn(card(look), "gap-0.5", className)}>
            <div role="radiogroup" aria-label="Model version" aria-keyshortcuts="V [ ]" onKeyDown={onKeyDown} className="flex items-center gap-0.5">
                <Segment kind="original" model={root} title="Original" active={!onVersion} look={look} buttonRef={originalRef} onPick={() => openVersion(root)} />
                <Segment kind="head" model={head} title={familyTitle(family, head)} active={onVersion} look={look} buttonRef={headRef} onPick={() => openVersion(head)} />
            </div>
            <VersionTree family={family} look={look} onDelete={setConfirming} />
            <DeleteVersionDialog model={confirming} models={models} onConfirm={confirmDelete} onCancel={() => setConfirming(null)} />
            {/* Said aloud when the choice changes; the buttons only carry the state. */}
            <span className="sr-only" role="status" aria-live="polite">
                {onVersion ? `Showing ${familyTitle(family, family.active)}` : "Showing the original version"}
            </span>
        </div>
    );
}

/** The original has problems and no version: its status, and the pill that leads to the fix. */
function Offer({ root, look, className }: { root: ModelAsset; look: Look; className?: string }) {
    const { mark, analysing, verdict } = useMarkOf(root);
    const label = offerLabel(verdict);
    return (
        <div
            data-testid="version-switcher"
            data-mode="offer"
            // V here says there is nothing to switch to yet (the switch is the other half of its reach; see Switch).
            onKeyDown={(event) => void handleVersionKey(versionKeyEvent(event))}
            className={cn(card(look), "gap-1", className)}
        >
            <span
                // role="img": a bare span's aria-label is not announced, and the mark beside "Original" is only a symbol and a number.
                role="img"
                data-testid="version-original"
                data-active="true"
                data-tone={mark.tone}
                title={`The original model · ${mark.text}`}
                aria-label={`Original version (${mark.text})`}
                className={cn("flex items-center gap-1.5 whitespace-nowrap px-2 text-xs font-medium text-foreground", !look.words && "px-1.5")}
            >
                Original
                <Mark mark={mark} analysing={analysing} detail={look.words ? "text" : "count"} />
            </span>
            <button
                type="button"
                data-testid="version-stabilize"
                onClick={() => revealStabilizeCard(root.id)}
                title="Open the Stability tab at the Stabilize button. Nothing runs until you press it."
                className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-accent/50 bg-accent/10 text-xs font-medium text-accent-hover transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-accent",
                    look.small ? "h-8" : "h-7",
                    look.words ? "px-2.5" : "px-2",
                )}
            >
                <WandSparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {label}
            </button>
        </div>
    );
}
