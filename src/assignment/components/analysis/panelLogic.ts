// Pure rules behind the panel's components, apart from React and the stores so scripts/assignment/test-panel.mjs can pin them:
// what a pick of a check or a figure shows, the labels of the points it puts on the stage, and the words of the stabilizer's rows.

import { placeOf } from "@/assignment/analysis/plain";
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisResult, type AnalysisSettings, type CheckKey, type CheckRow, type Issue, type StressPoint } from "@/assignment/analysis/types";
import { MATERIAL_FACTS } from "@/assignment/components/analysis/stressText";
import type { DerivedMeta } from "@/assignment/shared/contract";
import { keyFigures, strengthIsPartial, type KeyFigure, type Mark } from "@/assignment/store/analysisBrief";
import { cantileveredBlocks, fmtPct, issuesForCheck, issuesForCheckRow, mentionsAxes, plural } from "@/assignment/store/analysisLogic";
import { stressArrow } from "@/assignment/store/stabilizeLogic";
import { STRESS_FAIL_SHARE, STRESS_WARN_SHARE } from "@/assignment/viewer/analysisGeometry";

// ---------- what a check or a figure shows ----------

/** What a check shows on the stage: the issues behind it, else a group of blocks, else nothing to show. */
export interface CheckTarget {
    key: CheckKey;
    /** Issue ids, worst first (the order of the report). */
    ids: string[];
    /** Blocks without an issue of their own (the overhanging blocks), else empty. */
    blocks: number[];
    /** What to call the pick when it has no single issue: "Strength used: 2 places", "Overhanging blocks: 6 blocks". */
    label?: string;
}

/**
 * The target of a check row: the issues of its kind (a balance check that fails because nothing touches the ground shows
 * the floating parts instead, as issuesForCheckRow says), or for the overhanging-blocks row the blocks themselves.
 */
export function checkTarget(result: AnalysisResult, key: CheckKey, label: string): CheckTarget {
    const row = result.checks.find((c) => c.key === key);
    const issues = row ? issuesForCheckRow(result, row) : issuesForCheck(result.issues, key);
    const ids = issues.map((issue) => issue.id);
    const blocks = key === "cantilevered" ? cantileveredBlocks(result.blocks) : [];
    // A balance check that fails with nothing on the ground shows the floating parts, and says so.
    const viaFloating = key === "cog" && ids.length > 0 && issuesForCheck(result.issues, "cog").length === 0;
    let name: string | undefined;
    if (ids.length > 1) name = `${viaFloating ? "Floating parts" : label}: ${ids.length} places`;
    else if (ids.length === 0 && blocks.length > 0) name = `${label}: ${plural(blocks.length, "block")}`;
    return { key, ids, blocks, label: name };
}

/** The blocks of the longest overhang, whether or not it is past the limit, and how long it is; null when nothing overhangs. */
export function longestOverhang(result: Pick<AnalysisResult, "cantilevers">): { blocks: number[]; reach: number } | null {
    let best: AnalysisResult["cantilevers"][number] | null = null;
    for (const run of result.cantilevers) if (!best || run.reach > best.reach) best = run;
    return best && best.blocks.length > 0 ? { blocks: best.blocks, reach: best.reach } : null;
}

/** The name a stress point goes by on the stage (its callout and the phone's chip): the row that shows it matches on it. */
export const stressPointLabel = (point: Pick<StressPoint, "rank" | "utilisation">): string => `Strength point ${point.rank}: ${fmtPct(point.utilisation)}`;

// ---------- how many problems the list shows ----------

/** The problems listed before "N more": three is what fits above the details. */
export const PROBLEM_CAP = 3;

/**
 * The rows the list shows. `selectedIds` are the issues on show: when one of them is past the cap the list opens by itself
 * (`locked`: it cannot be closed while that pick stands), so what the stage is pointing at (a click on a block there) is never
 * hidden in the panel. `auto`: opened by the pick alone, not by the user, so the panel can remember it.
 */
export function visibleProblems<T extends { id: string }>(
    issues: readonly T[],
    expanded: boolean,
    selectedIds: readonly string[],
): { shown: T[]; hidden: number; locked: boolean; auto: boolean } {
    const locked = issues.slice(PROBLEM_CAP).some((issue) => selectedIds.includes(issue.id));
    if (expanded || locked) return { shown: [...issues], hidden: 0, locked, auto: locked && !expanded };
    return { shown: issues.slice(0, PROBLEM_CAP), hidden: Math.max(0, issues.length - PROBLEM_CAP), locked: false, auto: false };
}

// ---------- the stabilizer's rows ----------

type Fixable = Pick<DerivedMeta, "before" | "after">;

/** How many problems (errors and warnings) the stabilizer took away. */
export const problemsFixed = (meta: Fixable): number =>
    Math.max(0, meta.before.errors + meta.before.warnings - (meta.after.errors + meta.after.warnings));

/**
 * "3 problems fixed · strength used was 198%": what a stabilized version did, in two figures. The strength it ended at is the chip
 * above (a figure said once), so the line gives the one the chip cannot: where it started. Left out when it did not change.
 */
export function confirmedLine(meta: Fixable): string {
    const parts: string[] = [];
    const fixed = problemsFixed(meta);
    if (fixed > 0) parts.push(`${plural(fixed, "problem")} fixed`);
    const { before, after } = meta;
    if (before.max_utilisation !== null && (after.max_utilisation === null || fmtPct(before.max_utilisation) !== fmtPct(after.max_utilisation))) {
        parts.push(`strength used was ${fmtPct(before.max_utilisation)}`);
    }
    return parts.length > 0 ? parts.join(" · ") : "Nothing was removed or moved";
}

/**
 * What a stabilized version that is ready to switch to is like, in words and no figures (the top bar's mark and the version itself
 * have them): "All checks pass" or "Improved, not fully stable". "" when its figures are not known.
 */
export function readyOutcome(meta: Pick<DerivedMeta, "complete" | "after"> | null): string {
    if (!meta) return "";
    return meta.complete && meta.after.errors === 0 && meta.after.warnings === 0 ? "All checks pass" : "Improved, not fully stable";
}

/**
 * The body of the strip of a run that ends short of its goal: what it added and how strength used moved. Not what is left: the
 * headline above it says that ("Improved, not fully stable: 1 problem remains ..."), and a second "remains" is the same thing twice.
 */
export function runLine(meta: Pick<DerivedMeta, "added_blocks" | "before" | "after">): string {
    const { before, after } = meta;
    const parts = [`+${plural(meta.added_blocks, "block")}`];
    // Warnings only count when there are no errors: with errors, the headline names them.
    if (after.errors === 0 && after.warnings > 0) parts.push(plural(after.warnings, "warning"));
    if (before.max_utilisation !== null && after.max_utilisation !== null) parts.push(`strength used ${stressArrow(before.max_utilisation, after.max_utilisation)}`);
    return parts.join(" · ");
}

/** A run's blocks added so far, from its moves. */
export const addedSoFar = (moves: ReadonlyArray<{ cells: readonly unknown[] }>): number => moves.reduce((sum, m) => sum + m.cells.length, 0);

// ---------- where a stress point is, in words ----------

/**
 * Where a stress point is, never as cell coordinates: the height and the side of the model it is on, as the Front view shows them
 * ("200-300 mm up, back left"). A point is a joint at its peak block (`blocks[0]`) with the blocks around it, and the problem list
 * names the joint by that block (analysisBrief.ts), so this does too: the same joint is in the same place in both. "" when it has
 * no blocks.
 */
export const pointWhere = (point: Pick<StressPoint, "blocks">, result: Pick<AnalysisResult, "blocks" | "settings">): string =>
    placeOf(result.blocks, point.blocks.slice(0, 1), result.settings.blockSizeMm)?.line ?? "";

// ---------- the closed sections' summaries and the pages ----------

/** The pages the panel can show: the report, and the two that open from the header. */
export type PanelPage = "report" | "settings" | "about";

export const PAGE_TITLE: Record<Exclude<PanelPage, "report">, string> = {
    settings: "Settings",
    about: "How is this computed?",
};

/**
 * A run that has just started to wait for a decision (Save or Discard, Retry, Dismiss) is on the report page, where its strip is: the
 * Settings or About page that was open gives way. Only that moment (`wasWaiting` false, `waiting` true), so a user who then goes to
 * look at a page is left there.
 */
export const bringsReportForward = (wasWaiting: boolean, waiting: boolean, page: PanelPage): boolean => waiting && !wasWaiting && page !== "report";

/** What the marks and summaries below read of a result: tests build these by hand, so each part is optional. */
type MarkInput = Partial<Pick<AnalysisResult, "stats" | "stress" | "issues">>;

// Is the strength figure no real reading (parts float and the worst joint is the grounded part's)? The rule lives with the figures, in
// store/analysisBrief.ts, and is re-exported here for the rows and sections below.
export { strengthIsPartial };

/**
 * The mark of a row of the checks: the engine's two states (pass, fail) plus what it says elsewhere. A joint at 85% of what it
 * takes passes the engine's check (it only fails above 100%) but the answer calls it heavily loaded, so the row warns too; a
 * figure worked out for the grounded part only (parts float) is neutral rather than green.
 */
export function checkMark(row: Pick<CheckRow, "key" | "status">, result: MarkInput = {}): Mark {
    if (row.status === "info") return "none";
    if (row.status === "fail") return "fail";
    if (row.key === "stress" && result.stress) {
        const peak = result.stress.maxUtilisation;
        if (peak > STRESS_FAIL_SHARE) return "fail";
        if (peak > STRESS_WARN_SHARE) return "warn";
        return strengthIsPartial(result) ? "none" : "pass";
    }
    if (row.key === "cog") {
        if (result.issues?.some((issue) => issue.kind === "cog-outside" && issue.severity === "warning")) return "warn";
        if ((result.stats?.floatingCount ?? 0) > 0) return "none";
    }
    return "pass";
}

/**
 * The closed checks section's summary, in words: "All pass", "Some need a look" (a warning) or "Some fail" (the figures are in the
 * chips above and inside the section, so the first view says each number once). "No blocks" for an empty model, whose rows would
 * only say it failed. Empty when no check is required (nothing to pass).
 */
export function checksSummary(result: Pick<AnalysisResult, "checks"> & MarkInput): string {
    if (result.stats?.blockCount === 0) return "No blocks";
    const required = result.checks.filter((check) => check.status !== "info");
    if (required.length === 0) return "";
    const marks = required.map((check) => checkMark(check, result));
    if (marks.includes("fail")) return "Some fail";
    return marks.includes("warn") ? "Some need a look" : "All pass";
}

/**
 * The closed strength section's summary, in words ("Overloaded", "Heavily loaded", "Partly analysed", "Fine"), or why there is none.
 * The peak is in the chip. "Partly analysed": parts float and were left out, so "Fine" would be about the base alone.
 */
export function strengthSummary(result: Pick<AnalysisResult, "stress"> & MarkInput): string {
    if (!result.stress) return "No estimate";
    const peak = result.stress.maxUtilisation;
    if (peak > STRESS_FAIL_SHARE) return "Overloaded";
    if (peak > STRESS_WARN_SHARE) return "Heavily loaded";
    return strengthIsPartial(result) ? "Partly analysed" : "Fine";
}

/** The most loaded joints listed before "Show all". */
export const POINTS_SHOWN = 5;

// ---------- lines that name a direction ----------

/** The words the briefs use for a direction (analysis/plain.ts): "right", "back left", "front". */
const DIRECTION_WORD = /\b(?:right|left|front|back)\b/i;

/**
 * Does a line the briefs wrote name a direction? Then the panel says, once, that right, left, front and back are as the Front view
 * shows them. For the briefs' own lines ("weight pulls to the right", "600-700 mm up, back left", "tips to the front"), not for free
 * text. `texts` may also be the engine's older wording with axes (+X, -Y), which the report keeps.
 */
export const namesDirection = (texts: readonly string[]): boolean => texts.some((text) => DIRECTION_WORD.test(text) || mentionsAxes([text]));

/** A direction in free text (an issue's explanation): "towards the right", "at the back left", "the left side"; "left out" is not one. */
const DIRECTION_PHRASE = /\b(?:(?:to|towards|on|at|in) the (?:front|back|left|right)|(?:front|back) (?:left|right)|(?:right|left|front|back) (?:side|edge))\b/i;
export const explainsDirection = (texts: readonly string[]): boolean => texts.some((text) => DIRECTION_PHRASE.test(text) || mentionsAxes([text]));

// ---------- the four figures, as the panel shows them ----------

/** "+3 added": the part of the blocks chip's unit that the green row's tag ("+3 blocks") already says. */
const ADDED_UNIT = /^\+\d+ added$/;

/**
 * The four figures of the answer (store/analysisBrief.ts keyFigures) with what only the panel knows how to say: a stabilized version's
 * blocks chip does not repeat the "+N added" of the tag in the row below it. (Parts that float are the figures' own business: balance and
 * strength are neutral there already, so the chips never contradict "Won't stand".)
 */
export function panelFigures(result: AnalysisResult): KeyFigure[] {
    return keyFigures(result).map((figure): KeyFigure => {
        if (figure.key !== "blocks") return figure;
        const unit = figure.unit
            .split(" · ")
            .filter((part) => !ADDED_UNIT.test(part))
            .join(" · ");
        return unit === figure.unit ? figure : { ...figure, unit };
    });
}

/** The short names of the phone's mini chips. */
const COMPACT_LABEL: Record<KeyFigure["key"], string> = { balance: "Balance", overhang: "Overhang", strength: "Strength", blocks: "Blocks" };

/**
 * A figure for the phone's mini chip, which has no room for the unit: the label, and a value that keeps the qualifier that makes the
 * number readable, as touch has no tooltips ("92 out", not "92 mm"; "7 / 4", not "7 blocks"; "85% used", not "85%").
 */
export function compactFigure(figure: Pick<KeyFigure, "key" | "value" | "unit">): { label: string; value: string } {
    const label = COMPACT_LABEL[figure.key];
    const { value, unit } = figure;
    switch (figure.key) {
        case "balance": {
            const mm = value.replace(/\s*mm$/, "");
            if (unit === "outside") return { label, value: `${mm} out` };
            if (unit === "inside") return { label, value: `${mm} in` };
            if (unit === "base only") return { label, value: `${mm} base` };
            if (unit === "on the edge") return { label, value: "edge" };
            if (unit === "nothing on the ground") return { label, value: "no base" };
            return { label, value };
        }
        case "overhang": {
            const blocks = value.match(/^(\d+) blocks?$/)?.[1];
            const max = unit.match(/^max (\d+)$/)?.[1];
            return { label, value: blocks && max ? `${blocks} / ${max}` : value };
        }
        case "strength":
            return { label, value: value === "-" ? "n/a" : `${value} used` };
        case "blocks":
            return { label, value: unit.startsWith("of ") ? `${value} / ${unit.slice(3).split(" · ")[0]}` : value };
    }
}

// ---------- the settings the answer was reached with ----------

/**
 * Which settings differ from the assignment's, in the words of the Settings page ("longest overhang 6, fill threshold 60%"); null
 * when none do. The sentence under the answer and the pill's tooltip say it.
 */
export function customSettingsLine(settings: Pick<AnalysisSettings, "cantileverLimit" | "fillThreshold" | "maxBlocks" | "material">): string | null {
    const base = DEFAULT_ANALYSIS_SETTINGS;
    const parts: string[] = [];
    if (settings.cantileverLimit !== base.cantileverLimit) parts.push(`longest overhang ${settings.cantileverLimit}`);
    if (Math.abs(settings.fillThreshold - base.fillThreshold) > 1e-6) parts.push(`fill threshold ${Math.round(settings.fillThreshold * 100)}%`);
    if (settings.maxBlocks !== null) parts.push(`block budget ${settings.maxBlocks}`);
    if (settings.material !== base.material) parts.push(`${(MATERIAL_FACTS[settings.material]?.label ?? settings.material).toLowerCase()} blocks`);
    return parts.length > 0 ? parts.join(", ") : null;
}

// ---------- problems with nothing to show ----------

/** Can "Show" point at this problem? An empty model has no block, no place and no mark to fly to: its row only explains. */
export const issueCanShow = (issue: Pick<Issue, "kind">): boolean => issue.kind !== "empty";
