// Pure logic behind the version switcher in the workspace bar: when it is shown, what each half says about the
// model's structure, the words on its buttons and menu, which model the "V" key (or a click) goes to, and which links the
// Models list and the chat cards offer between the versions of a model. No React and no stores, so the components, the keyboard
// shortcut and scripts/assignment/test-versions-ui.mjs share one copy.

import { addedBlocksLabel } from "@/assignment/components/workspace/format";
import type { ModelAsset } from "@/assignment/shared/contract";
import { stabilizeLabelOf, type AnalysisPhase, type Verdict } from "@/assignment/store/analysisLogic";
import type { VersionFamily } from "@/assignment/store/versions";
import type { WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

/** The two halves of a family: the model as it was made, and the corrected version with supports added. */
export type VersionKind = "original" | "stabilized";

// ---------- what each half says about the structure ----------

/** red: problems; amber: warnings only; green: stable; none: nothing known (yet). */
export type MarkTone = "fail" | "warn" | "pass" | "none";

export interface StatusMark {
    tone: MarkTone;
    /** "4 problems", "2 warnings", "Stable", "Checking…" or "Not analysed yet". */
    text: string;
    /** The number behind "4 problems" / "2 warnings" (the compact form shows only this), else null. */
    count: number | null;
}

/**
 * The mark next to "Original" or "Stabilized", from the model's verdict (this visit's analysis, else the summary the
 * server saved). It is the very verdict the Stability tab and the Models list show, so the bar never disagrees with the
 * report: problems (errors) read in red, a model with only warnings in amber, a clean one "Stable".
 */
export function statusMark(verdict: Pick<Verdict, "kind" | "errors" | "warnings" | "short"> | null, analysing = false): StatusMark {
    if (!verdict) return { tone: "none", text: analysing ? "Checking…" : "Not analysed yet", count: null };
    if (verdict.kind === "fail") return { tone: "fail", text: verdict.short, count: verdict.errors };
    if (verdict.kind === "warn") return { tone: "warn", text: verdict.short, count: verdict.warnings };
    return { tone: "pass", text: "Stable", count: null };
}

/** Which of several stabilized versions a half stands for: `n` counts from the oldest. */
export interface VersionOrdinal {
    n: number;
    of: number;
}

/** The accessible name of a half: "Show the original version (4 problems)", "Show the stabilized version 2 of 3 (Stable)". */
export function segmentLabel(kind: VersionKind, mark: Pick<StatusMark, "text">, ordinal?: VersionOrdinal | null): string {
    const which = ordinal ? ` ${ordinal.n} of ${ordinal.of}` : "";
    return `Show the ${kind} version${which} (${mark.text})`;
}

/**
 * The tooltip of a half: its state (the compact bar shows only a symbol and a number, so the words are here), what it shows, and
 * the key. The key works while the 3D view or the switch itself has focus, never as a bare key anywhere on the page.
 */
export function segmentTitle(kind: VersionKind, mark?: Pick<StatusMark, "text"> | null, ordinal?: VersionOrdinal | null): string {
    const what =
        kind === "original"
            ? "The original model, as it was made"
            : `The stabilized version${ordinal ? ` ${ordinal.n} of ${ordinal.of}` : ""}: the original plus the supports that were added`;
    return `${mark ? `${what} · ${mark.text}` : what}. V switches while the 3D view or this switch has focus`;
}

// ---------- the menu of several stabilized versions ----------

/** "5:41 PM" for a version made today, "Oct 23, 5:41 PM" for an older one; null when the stamp does not parse. */
export function clockTime(iso: string, now: Date = new Date(), locale?: string): string | null {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return null;
    const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
    return sameDay ? time : `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}

/** The place of a stabilized version among the family's, oldest first ("2 of 3"); null for a model that is not one of them. */
export function versionOrdinal(family: Pick<VersionFamily, "stabilized"> | null, model: Pick<ModelAsset, "id">): VersionOrdinal | null {
    if (!family) return null;
    const at = family.stabilized.findIndex((m) => m.id === model.id);
    return at < 0 ? null : { n: family.stabilized.length - at, of: family.stabilized.length };
}

/** "v2 · +16 blocks · Stable · 5:41 PM": one stabilized version in the menu, newest first (the "v2" tells two like versions apart). */
export function versionMenuLine(
    model: Pick<ModelAsset, "derived" | "created_at">,
    mark: Pick<StatusMark, "text">,
    now: Date = new Date(),
    locale?: string,
    ordinal?: VersionOrdinal | null,
): string {
    const added = model.derived ? (model.derived.added_blocks === 0 ? "No blocks added" : addedBlocksLabel(model.derived.added_blocks)) : null;
    const name = ordinal ? `v${ordinal.n}` : null;
    return [name, added, mark.text, clockTime(model.created_at, now, locale)].filter((part): part is string => Boolean(part)).join(" · ");
}

// ---------- when the switcher is there ----------

/**
 * "switch": the model has a stabilized version, so the bar offers Original | Stabilized.
 * "offer": the original has problems the stabilizer can act on and no stabilized version yet, so the bar offers a "Stabilize…" pill.
 * "none": nothing to switch to or to offer (a clean model, one whose only warning is thin parts left out, which the stabilizer cannot
 * fix, a model not analysed yet, a version whose original is gone, the Models tab with its own list).
 */
export type SwitcherMode = "switch" | "offer" | "none";

export function switcherMode(input: {
    family: Pick<VersionFamily, "root" | "stabilized" | "active"> | null;
    /** The original's verdict (the summary of its newest analysis). */
    rootVerdict: (Pick<Verdict, "kind"> & Partial<Pick<Verdict, "fix">>) | null;
    tab: WorkspaceTab;
}): SwitcherMode {
    const { family, rootVerdict, tab } = input;
    if (tab === "models" || !family || !family.root) return "none";
    if (family.stabilized.length > 0) return "switch";
    // The pill leads to the Stabilize card, so it is there exactly when the card is (store/stabilizeLogic.ts stabilizeOffer).
    if (family.active.id === family.root.id && stabilizeLabelOf(rootVerdict) !== null) return "offer";
    return "none";
}

/**
 * The switcher is not there yet but may be soon: the original is in the viewer and its first analysis has not told whether it has
 * problems. A bar that gives the switcher a row of its own (a phone, a narrow window) keeps the room, so the model is not re-framed
 * when the verdict lands.
 */
export function switcherPending(input: {
    family: Pick<VersionFamily, "root" | "stabilized"> | null;
    rootVerdict: Pick<Verdict, "kind"> | null;
    tab: WorkspaceTab;
}): boolean {
    const { family, rootVerdict, tab } = input;
    return tab !== "models" && Boolean(family?.root) && family?.stabilized.length === 0 && rootVerdict === null;
}

// ---------- where the switcher sits in the bar ----------

/** Below this free width (the window minus the chat panel) the switcher drops the words next to its marks. */
export const VERSION_BAR_COMPACT_BELOW_PX = 980;
/**
 * Below this free width the bar has no room for the switcher beside the tabs (Home, the project's name, the tabs with their status
 * and the save text need about 700 px before the switcher's 180): it gets a row of its own under the bar, as on a phone.
 */
export const VERSION_BAR_ROW_BELOW_PX = 860;
/** The switcher's row under the bar: 8 px of air and the card (40 px on a phone, where its controls are 32 px; 36 px on a desktop). */
export const PHONE_SWITCHER_ROW_PX = 48;
export const DESKTOP_SWITCHER_ROW_PX = 44;

export interface SwitcherLayout {
    /** On a row of its own under the bar (a phone, a window too narrow for the bar), else inside the bar's tab card. */
    inRow: boolean;
    /** The row is there: the switcher is, or may be soon (see switcherPending), and a row holds its place so nothing moves when it lands. */
    rowKept: boolean;
    /** The row's height with its air above, or 0: what the viewer's top inset leaves for it. */
    rowPx: number;
    /** Only the number beside each mark, not the words. */
    compact: boolean;
}

/** Where the switcher goes for this much room. `freeWidth` is the window minus the chat panel. */
export function switcherLayout(input: { mobile: boolean; freeWidth: number; mode: SwitcherMode; pending: boolean }): SwitcherLayout {
    const inRow = input.mobile || input.freeWidth < VERSION_BAR_ROW_BELOW_PX;
    const rowKept = inRow && (input.mode !== "none" || input.pending);
    return {
        inRow,
        rowKept,
        rowPx: rowKept ? (input.mobile ? PHONE_SWITCHER_ROW_PX : DESKTOP_SWITCHER_ROW_PX) : 0,
        compact: input.freeWidth < VERSION_BAR_COMPACT_BELOW_PX,
    };
}

/** The pill's words: the card it opens says "Stabilize", or "Reduce stress" when only heavily loaded joints are left. */
export function offerLabel(rootVerdict: (Pick<Verdict, "kind"> & Partial<Pick<Verdict, "fix">>) | null): string {
    return `${stabilizeLabelOf(rootVerdict) ?? "Stabilize"}…`;
}

// ---------- where a click, an arrow or "V" goes ----------

/** Which stabilized version of an original was on screen last, so going back and forth returns to the same one. */
const lastStabilized = new Map<string, string>();

/** Note the stabilized version on screen (call it whenever a family is shown or left). */
export function rememberStabilized(family: Pick<VersionFamily, "root" | "active" | "isStabilized"> | null): void {
    if (family?.root && family.isStabilized) lastStabilized.set(family.root.id, family.active.id);
}

/** Forget what was remembered (tests; a project that was left). */
export function forgetStabilized(): void {
    lastStabilized.clear();
}

/** The stabilized version the "Stabilized" half stands for: the one on screen, else the one seen last, else the newest. */
export function stabilizedTarget(family: Pick<VersionFamily, "root" | "stabilized" | "active" | "isStabilized"> | null): ModelAsset | null {
    if (!family) return null;
    if (family.isStabilized) return family.active;
    const remembered = family.root ? lastStabilized.get(family.root.id) : undefined;
    return family.stabilized.find((m) => m.id === remembered) ?? family.stabilized[0] ?? null;
}

/** The model "V" flips to: the original from a stabilized version, a stabilized version from the original. */
export function toggleTarget(family: Pick<VersionFamily, "root" | "stabilized" | "active" | "isStabilized"> | null): ModelAsset | null {
    if (!family || !family.root) return null;
    return family.isStabilized ? family.root : stabilizedTarget(family);
}

/** The model a half opens. */
export function targetOf(kind: VersionKind, family: Pick<VersionFamily, "root" | "stabilized" | "active" | "isStabilized"> | null): ModelAsset | null {
    if (!family) return null;
    return kind === "original" ? family.root : stabilizedTarget(family);
}

// ---------- the "V" key ----------

/** The parts of a keydown the shortcut looks at. */
export interface KeyLike {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    isComposing: boolean;
    defaultPrevented: boolean;
}

/** A bare "V": no modifier (a chord belongs to the browser or another shortcut), not a held key, not an IME composition, not already handled. */
export function isVersionKey(e: KeyLike): boolean {
    return e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing && !e.defaultPrevented;
}

/**
 * Where a bare letter must not act: a text field, a menu, a dialog or a list is being used. (The prompt box counts too: a letter
 * typed there is text.) Duck-typed on `closest`, so it runs without a DOM in tests.
 */
export const TYPING_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], [role='menu'], [role='dialog'], [role='listbox']";

export function inTypingContext(target: EventTarget | null): boolean {
    const element = target as { closest?: (selector: string) => unknown } | null;
    return Boolean(element && typeof element.closest === "function" && element.closest(TYPING_SELECTOR));
}

// ---------- when the added supports did not come ----------

/**
 * The 3D tab of a stabilized model is the original mesh with the added blocks on it, and the blocks come from the analysis of the
 * stabilized file. When that run fails (the file could not be fetched or read) the stage is the bare mesh, which looks like a
 * stabilizer that added nothing: this says why, or null when nothing went wrong (or the Stability tab, which has its own error).
 */
export function supportsFailure(input: { onSource: boolean; tab: WorkspaceTab; phase: AnalysisPhase; error: string | null }): string | null {
    if (!input.onSource || input.tab !== "3d" || input.phase !== "error") return null;
    return input.error && input.error.trim() !== "" ? input.error : "The stabilized model's blocks could not be read.";
}

// ---------- the links between the versions of a model (Models list, chat cards) ----------

/** One link of a model's card: the model it opens and what it is called. */
export interface PairLink {
    model: ModelAsset;
    label: "Original" | "Stabilized" | "Previous";
}

/**
 * The links a model's row or card offers, from the family of that model: the same two targets as the bar (an original links to the
 * stabilized version its "Stabilized" half opens, a version to the original), so the same words never open different models. A
 * version made from another version also gets "Previous", the one it was made from: an extra for walking a chain, never the
 * answer to "Original". `family` is `versionFamily(models, model.id)`.
 */
export function pairLinks(family: Pick<VersionFamily, "root" | "stabilized" | "active" | "isStabilized"> | null, models: readonly ModelAsset[]): PairLink[] {
    if (!family) return [];
    if (!family.isStabilized) {
        const stabilized = stabilizedTarget(family);
        return stabilized ? [{ model: stabilized, label: "Stabilized" }] : [];
    }
    const links: PairLink[] = [];
    if (family.root) links.push({ model: family.root, label: "Original" });
    const source = family.active.source_model_id ? models.find((m) => m.id === family.active.source_model_id) : undefined;
    if (source && source.id !== family.root?.id && source.id !== family.active.id) links.push({ model: source, label: "Previous" });
    return links;
}
