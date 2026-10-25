import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type Ref } from "react";
import { Check, ChevronDown, Loader2, TriangleAlert, WandSparkles } from "lucide-react";

import { TONE } from "@/assignment/components/analysis/style";
import { revealStabilizeCard } from "@/assignment/components/analysis/stabilizeFocus";
import { useModelAnalysing, useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { handleVersionKey, openVersion, versionKeyEvent } from "@/assignment/components/workspace/versionActions";
import {
    offerLabel,
    rememberStabilized,
    segmentLabel,
    segmentTitle,
    stabilizedTarget,
    statusMark,
    targetOf,
    versionMenuLine,
    versionOrdinal,
    type MarkTone,
    type StatusMark,
    type VersionKind,
    type VersionOrdinal,
} from "@/assignment/components/workspace/versionLogic";
import type { VersionSwitcherState } from "@/assignment/components/workspace/useVersionSwitcherState";
import { cn } from "@/assignment/lib/utils";
import type { ModelAsset } from "@/assignment/shared/contract";
import type { Verdict } from "@/assignment/store/analysisLogic";
import type { VersionFamily } from "@/assignment/store/versions";

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
 * How the switcher is set: `words` says "4 problems" beside the mark (else just the count), `small` is the phone's row (taller
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
    /** The model this half stands for (the original, or the stabilized version it would open). */
    model: ModelAsset;
    active: boolean;
    look: Look;
    onPick: () => void;
    buttonRef: Ref<HTMLButtonElement>;
    /** Which of several stabilized versions this half stands for ("v2" beside its name), else null. */
    ordinal?: VersionOrdinal | null;
}

function Segment({ kind, model, active, look, onPick, buttonRef, ordinal = null }: SegmentProps) {
    const { mark, analysing } = useMarkOf(model);
    const label = kind === "original" ? "Original" : "Stabilized";
    return (
        <button
            ref={buttonRef}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={segmentLabel(kind, mark, ordinal)}
            title={segmentTitle(kind, mark, ordinal)}
            tabIndex={active ? 0 : -1}
            data-testid={`version-${kind}`}
            data-active={active}
            data-tone={mark.tone}
            onClick={onPick}
            className={segmentClass(active, look)}
        >
            {label}
            {ordinal && (
                <span aria-hidden className="-ml-0.5 font-mono text-[10px] text-muted-foreground" data-testid="version-ordinal">
                    v{ordinal.n}
                </span>
            )}
            <Mark mark={mark} analysing={analysing} detail={look.words ? "text" : "count"} />
        </button>
    );
}

/** One stabilized version in the menu: "v2 · +16 blocks · Stable · 5:41 PM". */
function VersionMenuItem({ model, active, ordinal }: { model: ModelAsset; active: boolean; ordinal: VersionOrdinal | null }) {
    const { mark, analysing } = useMarkOf(model);
    const line = versionMenuLine(model, mark, new Date(), undefined, ordinal);
    return (
        <DropdownMenuItem
            className="gap-2 text-xs"
            data-testid="version-menu-item"
            data-active={active}
            aria-label={`Show the stabilized version: ${line}`}
            onSelect={() => openVersion(model)}
        >
            <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">
                {active ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
            </span>
            <Mark mark={mark} analysing={analysing} detail="none" />
            <span className="whitespace-nowrap">{line}</span>
        </DropdownMenuItem>
    );
}

/**
 * The chevron beside the Stabilized half when there are several versions: it opens the list, newest first. The half itself is
 * one click to the version last seen (or the newest), so the list is only for choosing another one.
 */
function VersionMenu({ family, look }: { family: VersionFamily; look: Look }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    data-testid="version-menu-trigger"
                    aria-label={`Choose a stabilized version (${family.stabilized.length} versions)`}
                    title="Choose another stabilized version"
                    className={cn(
                        "grid shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground data-[state=open]:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        look.small ? "h-8 w-8" : "h-7 w-6",
                    )}
                >
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem]" data-testid="version-menu">
                {family.stabilized.map((model) => (
                    <VersionMenuItem key={model.id} model={model} active={family.active.id === model.id} ordinal={versionOrdinal(family, model)} />
                ))}
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
 * The bar's version switcher: "Original | Stabilized", each with its structural status (a red "4 problems", a green
 * "Stable"), one click to the other one on whichever tab is open. It is the only way to move between the versions of a model
 * from the stage or the Stability tab: neither has a button of its own for it. With several stabilized versions the Stabilized half still
 * opens the one seen last in one click, says which ("v2"), and a chevron beside it opens the list, newest first. A model that has
 * problems and no stabilized version yet gets a "Stabilize…" pill that opens the Stability tab at its Stabilize button. "V" flips
 * between the two while the 3D view or this switch has focus (WorkspaceShell, and the switch's own key handler).
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
    const stabilizedRef = useRef<HTMLButtonElement>(null);
    const stabilizedActive = family.isStabilized;
    const stabilized = stabilizedTarget(family);

    // Which stabilized version is on screen, for "back to stabilized" (the V key, a click on the half).
    useEffect(() => rememberStabilized(family), [family]);

    // Arrow keys move the choice, like the report's other segmented controls (the radio-group keys); V flips it.
    const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        // The version menu is a portal: its key presses bubble here through the React tree, but they are not ours.
        if (event.defaultPrevented || !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        if (event.key.toLowerCase() === "v") {
            // Keep the focus on the half that is now showing.
            const toStabilized = !stabilizedActive;
            if (handleVersionKey(versionKeyEvent(event))) (toStabilized ? stabilizedRef : originalRef).current?.focus();
            return;
        }
        const kind: VersionKind | null = event.key === "ArrowLeft" ? "original" : event.key === "ArrowRight" ? "stabilized" : null;
        if (!kind) return;
        const target = targetOf(kind, family);
        if (!target) return;
        event.preventDefault();
        if (target.id !== family.active.id) openVersion(target);
        (kind === "original" ? originalRef : stabilizedRef).current?.focus();
    };

    if (!stabilized) return null;
    const several = family.stabilized.length > 1;
    return (
        <div data-testid="version-switcher" data-mode="switch" className={cn(card(look), "gap-0.5", className)}>
            <div role="radiogroup" aria-label="Model version" aria-keyshortcuts="V" onKeyDown={onKeyDown} className="flex items-center gap-0.5">
                <Segment
                    kind="original"
                    model={root}
                    active={!stabilizedActive}
                    look={look}
                    buttonRef={originalRef}
                    onPick={() => openVersion(root)}
                />
                <Segment
                    kind="stabilized"
                    model={stabilized}
                    active={stabilizedActive}
                    look={look}
                    buttonRef={stabilizedRef}
                    onPick={() => openVersion(stabilized)}
                    ordinal={several ? versionOrdinal(family, stabilized) : null}
                />
            </div>
            {several && <VersionMenu family={family} look={look} />}
            {/* Said aloud when the choice changes; the buttons only carry the state. */}
            <span className="sr-only" role="status" aria-live="polite">
                {stabilizedActive ? "Showing the stabilized version" : "Showing the original version"}
            </span>
        </div>
    );
}

/** The original has problems and no stabilized version: its status, and the pill that leads to the fix. */
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
