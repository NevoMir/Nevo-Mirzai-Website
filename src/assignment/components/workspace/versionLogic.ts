// Pure logic behind the version control in the workspace bar: when it is shown, what each half says about the model's structure, the
// words on its buttons and in its tree, which model the "V", "[" and "]" keys (or a click) go to, and which links the chat cards offer
// between the versions of a model. No React and no stores, so the components, the keyboard shortcuts and
// scripts/assignment/test-versions-ui.mjs share one copy.

import { versionDetail } from "@/assignment/components/workspace/format";
import type { ModelAsset } from "@/assignment/shared/contract";
import { treeRows, versionName, type TreeRow } from "@/assignment/shared/versionTree";
import { stabilizeLabelOf, type AnalysisPhase, type Verdict } from "@/assignment/store/analysisLogic";
import type { VersionFamily } from "@/assignment/store/versions";
import type { WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

/** The two halves of the control: the model as it was made, and the version you are working on (the head of the family). */
export type VersionKind = "original" | "head";

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

/** "v4": the place of a version in its family, v1 being the original and the others counted from the oldest. */
export interface VersionOrdinal {
    n: number;
}

/** The place of a model in its family: 1 for the original, 2 for the oldest version, and so on; null for a model that is not in it. */
export function versionOrdinal(family: Pick<VersionFamily, "root" | "versions"> | null, model: Pick<ModelAsset, "id">): VersionOrdinal | null {
    if (!family || !family.root) return null;
    if (family.root.id === model.id) return { n: 1 };
    const at = family.versions.findIndex((m) => m.id === model.id);
    return at < 0 ? null : { n: at + 2 };
}

/** "v4 · Lightest": the head's text in the control; the original is just "Original". */
export function familyTitle(family: Pick<VersionFamily, "root" | "versions"> | null, model: ModelAsset): string {
    const ordinal = versionOrdinal(family, model);
    return ordinal ? `v${ordinal.n} · ${versionName(model)}` : versionName(model);
}

/** The accessible name of a half: "Show the original version (4 problems)", "Show v4 · Lightest (Stable)". */
export function segmentLabel(kind: VersionKind, mark: Pick<StatusMark, "text">, title: string | null = null): string {
    return kind === "original" ? `Show the original version (${mark.text})` : `Show ${title ?? "the latest version"} (${mark.text})`;
}

/**
 * The tooltip of a half: its state (the compact bar shows only a symbol and a number, so the words are here), what it shows, and
 * the keys. The keys work while the 3D view or the control itself has focus, never as a bare key anywhere on the page.
 */
export function segmentTitle(kind: VersionKind, mark?: Pick<StatusMark, "text"> | null, head?: { title: string; detail: string | null } | null): string {
    const what =
        kind === "original"
            ? "The original model, as it was made"
            : head
              ? `${head.title}${head.detail ? ` (${head.detail})` : ""}`
              : "The version you are working on";
    return `${mark ? `${what} · ${mark.text}` : what}. V switches, [ and ] walk the versions, while the 3D view or this switch has focus`;
}

// ---------- the tree of versions ----------

/** "5:41 PM" for a version made today, "Oct 23, 5:41 PM" for an older one; null when the stamp does not parse. */
export function clockTime(iso: string, now: Date = new Date(), locale?: string): string | null {
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return null;
    const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
    return sameDay ? time : `${at.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}

/** The rows of the tree popover: the original and every version below it, depth first. */
export function familyRows(family: Pick<VersionFamily, "root" | "versions">): TreeRow<ModelAsset>[] {
    return family.root ? treeRows([family.root, ...family.versions], family.root) : [];
}

/** "v2 · +16 blocks · Stable · 5:41 PM": one version in the tree, the words a screen reader hears for the row. */
export function versionRowLine(
    model: ModelAsset,
    title: string,
    mark: Pick<StatusMark, "text">,
    now: Date = new Date(),
    locale?: string,
): string {
    return [title, versionDetail(model), mark.text, clockTime(model.created_at, now, locale)].filter((part): part is string => Boolean(part)).join(" · ");
}

// ---------- when the switcher is there ----------

/**
 * "switch": the family has at least one version, so the bar offers Original | the version you are working on.
 * "offer": the original has problems the stabilizer can act on and no version yet, so the bar offers a "Stabilize…" pill.
 * "none": nothing to switch to or to offer (a clean model, one whose only warning is thin parts left out, which the stabilizer cannot
 * fix, a model not analysed yet, a version whose original is gone, the Models tab with its own tree).
 */
export type SwitcherMode = "switch" | "offer" | "none";

export function switcherMode(input: {
    family: Pick<VersionFamily, "root" | "versions" | "active"> | null;
    /** The original's verdict (the summary of its newest analysis). */
    rootVerdict: (Pick<Verdict, "kind"> & Partial<Pick<Verdict, "fix">>) | null;
    tab: WorkspaceTab;
}): SwitcherMode {
    const { family, rootVerdict, tab } = input;
    if (tab === "models" || !family || !family.root) return "none";
    if (family.versions.length > 0) return "switch";
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
    family: Pick<VersionFamily, "root" | "versions"> | null;
    rootVerdict: Pick<Verdict, "kind"> | null;
    tab: WorkspaceTab;
}): boolean {
    const { family, rootVerdict, tab } = input;
    return tab !== "models" && Boolean(family?.root) && family?.versions.length === 0 && rootVerdict === null;
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

type Walkable = Pick<VersionFamily, "root" | "versions" | "active" | "head" | "isVersion">;

/** The model "V" flips to: the original from a version, the version you are working on (the head) from the original. */
export function toggleTarget(family: Walkable | null): ModelAsset | null {
    if (!family || !family.root) return null;
    return family.isVersion ? family.root : family.head;
}

/** The model a half opens. */
export function targetOf(kind: VersionKind, family: Walkable | null): ModelAsset | null {
    if (!family) return null;
    return kind === "original" ? family.root : family.head;
}

// ---------- the keys ----------

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

/** A bare key: no modifier (a chord belongs to the browser or another shortcut), not a held key, not an IME composition, not already handled. */
function isBare(e: KeyLike): boolean {
    return !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && !e.isComposing && !e.defaultPrevented;
}

/** A bare "V": flips between the original and the version you are working on. */
export function isVersionKey(e: KeyLike): boolean {
    return e.key.toLowerCase() === "v" && isBare(e);
}

/** A bare "[" or "]": to the parent of the version on screen, or to its newest child. null: neither. */
export function stepKeyOf(e: KeyLike): "parent" | "child" | null {
    if (!isBare(e)) return null;
    return e.key === "[" ? "parent" : e.key === "]" ? "child" : null;
}

/** A bare "O": flips between the 3D view and the Optimization tab. */
export function isOptimizeKey(e: KeyLike): boolean {
    return e.key.toLowerCase() === "o" && isBare(e);
}

/**
 * Where a bare key must not act: a text field, a menu, a dialog or a list is being used. (The prompt box counts too: a letter
 * typed there is text.) Duck-typed on `closest`, so it runs without a DOM in tests.
 */
export const TYPING_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], [role='menu'], [role='dialog'], [role='listbox']";

export function inTypingContext(target: EventTarget | null): boolean {
    const element = target as { closest?: (selector: string) => unknown } | null;
    return Boolean(element && typeof element.closest === "function" && element.closest(TYPING_SELECTOR));
}

/** The composer's box carries this mark (Composer.tsx), whichever way it is set: "Prompt" for a new model, "Describe a change" for an edit. */
export const COMPOSER_SELECTOR = "[data-composer]";

const OPEN_DIALOG_SELECTOR = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Where a chord (⇧⌘O new project, ⌘\ hide the chat, ⌘. stop) must not act: in a dialog or a menu, or in a text field other than the
 * composer's box (a chord typed into a rename, the access-code field or the "Change the blocks" field must not throw that work away). The
 * composer's box is the one field they work from, in both of its modes: the person has just pressed Enter there, with the run going.
 * Duck-typed on `closest`, like `inTypingContext`, so it runs without a DOM in tests; `root` is where an open dialog is looked for.
 */
export function shortcutBlocked(target: EventTarget | null, root: { querySelector(selector: string): unknown } = document): boolean {
    if (root.querySelector(OPEN_DIALOG_SELECTOR)) return true;
    const el = target as { closest?: (selector: string) => unknown; tagName?: string; isContentEditable?: boolean } | null;
    if (!el || typeof el.closest !== "function") return false;
    if (el.closest(OVERLAY_SELECTOR)) return true;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA") return !el.closest(COMPOSER_SELECTOR);
    if (tag === "INPUT" || tag === "SELECT") return true;
    return el.isContentEditable === true;
}

// ---------- when the added supports did not come ----------

/**
 * The 3D tab of a block version that sits on a mesh is the mesh with the blocks on it, and the blocks come from the analysis of the
 * version's file. When that run fails (the file could not be fetched or read) the stage is the bare mesh, which looks like a
 * version that added nothing: this says why, or null when nothing went wrong (or any other tab, which has its own error).
 */
export function supportsFailure(input: { onSource: boolean; tab: WorkspaceTab; phase: AnalysisPhase; error: string | null }): string | null {
    if (!input.onSource || input.tab !== "3d" || input.phase !== "error") return null;
    return input.error && input.error.trim() !== "" ? input.error : "This version's blocks could not be read.";
}

// ---------- the links between the versions of a model (chat cards) ----------

/** One link of a model's card: the model it opens and what it is called. */
export interface PairLink {
    model: ModelAsset;
    label: "Original" | "Previous" | "Latest";
}

/**
 * The links a model's card offers, from the family of that model: the same targets as the bar (an original links to the version its
 * right half opens, "Latest"; a version to the original), so the same words never open different models. A version made from another
 * version also gets "Previous", the one it was made from: an extra for walking a chain, never the answer to "Original".
 * `family` is `versionFamily(models, model.id)`.
 */
export function pairLinks(family: Walkable | null, models: readonly ModelAsset[]): PairLink[] {
    if (!family) return [];
    if (!family.isVersion) return family.head ? [{ model: family.head, label: "Latest" }] : [];
    const links: PairLink[] = [];
    if (family.root) links.push({ model: family.root, label: "Original" });
    const source = family.active.source_model_id ? models.find((m) => m.id === family.active.source_model_id) : undefined;
    if (source && source.id !== family.root?.id && source.id !== family.active.id) links.push({ model: source, label: "Previous" });
    return links;
}
