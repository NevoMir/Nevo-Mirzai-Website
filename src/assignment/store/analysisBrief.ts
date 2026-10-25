// The brief of an analysis result, in plain words: the one sentence that answers "will it stand?", the four figures behind it,
// one line per problem (what, where, why) and the plain words of a check row. Pure functions over an AnalysisResult: no React, no
// store, so the Stability panel, the folded pill, the phone's peek card and scripts/assignment/test-store.mjs share one copy.
//
//   verdictSentence(result)       "Will tip over and 2 arms are too long." + the short pill form ("Will tip over")
//   keyFigures(result)            Balance, Longest overhang, Strength used, Blocks used: value, unit, mark, tooltip (parts float: neutral)
//   issueBrief(issue, result)     { what, where, why } for a row of the problem list; never a cell coordinate
//   sortIssuesForList(issues)     tipping, floating, long arms, overload, other errors, then the warnings
//   checkLabel / checkValue       a check row in plain words ("Overhangs too long", "None longer than 4 blocks")
//   plainDirection                "right", "back left": a direction as the Front view shows it (analysis/plain.ts)
//
// The words come from components/analysis/vocabulary.ts. The exported report keeps the technical terms; nothing here is used by it.

import { hullDistance, outwardNormal } from "@/assignment/analysis/geometry";
import { placeAtPoint, placeOf, plainDirection } from "@/assignment/analysis/plain";
import type { AnalysisResult, CheckKey, CheckRow, Issue, IssueKind } from "@/assignment/analysis/types";
import { CHECK_TERMS, TERMS, type Term } from "@/assignment/components/analysis/vocabulary";
import { fmtMm, fmtPct, plural } from "@/assignment/store/analysisLogic";
import { STRESS_FAIL_SHARE, STRESS_WARN_SHARE } from "@/assignment/viewer/analysisGeometry";

export { plainDirection };

/** What the sentence reads of a result (tests build these by hand). */
export type BriefInput = Pick<AnalysisResult, "issues" | "stability" | "stats">;

const cap = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const are = (n: number): string => (n === 1 ? "is" : "are");
/** Whole millimetres; "< 1 mm" instead of a misleading "0 mm". */
const mmText = (v: number): string => (v < 1 ? "< 1 mm" : `${fmtMm(v)} mm`);

// ---------- the sentence ----------

export type SentenceKind = "pass" | "warn" | "fail" | "empty";

export interface VerdictSentence {
    kind: SentenceKind;
    /** The answer in one sentence, ending with a full stop: "Will tip over and 2 arms are too long." */
    text: string;
    /** A second line, only for a model that passes: "All checks pass." */
    sub: string | null;
    /** The short form for the folded pill and the phone's peek: "Will tip over", "2 arms too long", "Stable". */
    pill: string;
    /** How many reasons the sentence does not spell out (it names at most two): shown as "(+N more)" in `text`. */
    more: number;
}

/** One reason a model fails or is worth a look, in the order the sentence names them. */
interface Reason {
    id: "tip" | "ground" | "floating" | "arms" | "overloaded" | "budget" | "edge" | "loaded" | "thin" | "other";
    /** The clause in the sentence: "2 arms are too long". */
    text: string;
    /** The pill form: "2 arms too long". */
    pill: string;
    /** A reason the model "won't stand" for (as opposed to a rule it breaks: the block budget, the longest arm). */
    stands: boolean;
}

const countOf = (issues: readonly Issue[], kind: IssueKind, severity: Issue["severity"]): number =>
    issues.filter((issue) => issue.kind === kind && issue.severity === severity).length;

/** "2 arms" / "1 arm": the noun after the count. */
const counted = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The reasons behind the issues of one severity, in the order the sentence names them. */
function reasonsOf(result: BriefInput, severity: Issue["severity"]): Reason[] {
    const { issues, stability, stats } = result;
    const n = (kind: IssueKind) => countOf(issues, kind, severity);
    const out: Reason[] = [];
    if (severity === "error") {
        // Nothing grounded: the floating parts are the same fact, said once.
        const nothingGrounded = !stability && stats.blockCount > 0 && issues.some((issue) => issue.kind === "floating");
        if (n("cog-outside") > 0) out.push({ id: "tip", text: "will tip over", pill: "Will tip over", stands: true });
        if (nothingGrounded) out.push({ id: "ground", text: "nothing touches the ground", pill: "Nothing on the ground", stands: true });
        else if (n("floating") > 0) {
            const k = n("floating");
            out.push({ id: "floating", text: `${counted(k, "part")} ${are(k)} floating`, pill: `${counted(k, "part")} floating`, stands: true });
        }
        if (n("cantilever-too-long") > 0) {
            const k = n("cantilever-too-long");
            // A long arm breaks a design rule rather than gravity: alone it is "1 arm is too long", not "won't stand".
            out.push({ id: "arms", text: `${counted(k, "arm")} ${are(k)} too long`, pill: `${counted(k, "arm")} too long`, stands: false });
        }
        if (n("overstressed") > 0) {
            const k = n("overstressed");
            out.push({ id: "overloaded", text: `${counted(k, "joint")} ${are(k)} overloaded`, pill: `${counted(k, "joint")} overloaded`, stands: true });
        }
        if (n("too-many-blocks") > 0) out.push({ id: "budget", text: "it is over the block budget", pill: "Over the block budget", stands: false });
        return out;
    }
    if (n("cog-outside") > 0) out.push({ id: "edge", text: "it is balanced on the very edge", pill: "Balanced on the edge", stands: true });
    if (n("highly-stressed") > 0) {
        const k = n("highly-stressed");
        out.push({ id: "loaded", text: `${counted(k, "joint")} ${are(k)} heavily loaded`, pill: `${counted(k, "joint")} heavily loaded`, stands: true });
    }
    if (n("thin-features") > 0) out.push({ id: "thin", text: "thin parts were left out", pill: "Thin parts left out", stands: true });
    return out;
}

/**
 * The answer to "will it stand?" in one sentence, and the same in a few words for the folded panel. Names at most two reasons
 * in this order: tipping, nothing on the ground, floating parts, long arms, overloaded joints, the block budget (errors); the very
 * edge, heavily loaded joints, thin parts left out (warnings). A failing model is described by its errors only, a model with
 * only warnings by its warnings.
 */
export function verdictSentence(result: BriefInput): VerdictSentence {
    const { issues, stats } = result;
    if (stats.blockCount === 0 || issues.some((issue) => issue.kind === "empty")) {
        return { kind: "empty", text: "Nothing to check: the model has no blocks.", sub: null, pill: "No blocks", more: 0 };
    }
    if (issues.some((issue) => issue.severity === "error")) {
        const errors = reasonsOf(result, "error");
        // An error of a kind the briefs do not know still fails the model: say so rather than "Will stand".
        const reasons: Reason[] = errors.length > 0 ? errors : [{ id: "other", text: "there are problems to fix", pill: "Problems to fix", stands: false }];
        const shown = reasons.slice(0, 2);
        const more = reasons.length - shown.length;
        const tail = more > 0 ? ` (+${more} more)` : "";
        let text: string;
        if (reasons[0].id === "tip") {
            const rest = shown.slice(1).map((r) => r.text);
            text = `Will tip over${rest.length > 0 ? ` and ${rest.join(" and ")}` : ""}${tail}.`;
        } else if (shown.some((r) => r.stands)) {
            text = `Won't stand: ${shown.map((r) => r.text).join(" and ")}${tail}.`;
        } else {
            text = `${cap(shown.map((r) => r.text).join(" and "))}${tail}.`;
        }
        return { kind: "fail", text, sub: null, pill: reasons[0].pill, more };
    }
    if (issues.length > 0) {
        const warnings = reasonsOf(result, "warning");
        const reasons: Reason[] = warnings.length > 0 ? warnings : [{ id: "other", text: "there is something to look at", pill: "Something to look at", stands: true }];
        const shown = reasons.slice(0, 2);
        const more = reasons.length - shown.length;
        const tail = more > 0 ? ` (+${more} more)` : "";
        return { kind: "warn", text: `Will stand, but ${shown.map((r) => r.text).join(" and ")}${tail}.`, sub: null, pill: reasons[0].pill, more };
    }
    return { kind: "pass", text: "Will stand.", sub: "All checks pass.", pill: "Stable", more: 0 };
}

// ---------- the four figures ----------

/** A mark is a symbol as well as a colour: check, warning, cross, neutral dot. */
export type Mark = "pass" | "warn" | "fail" | "none";
export type FigureKey = "balance" | "overhang" | "strength" | "blocks";

export interface KeyFigure {
    key: FigureKey;
    /** "Balance" */
    label: string;
    /** "85 mm" */
    value: string;
    /** "outside" */
    unit: string;
    mark: Mark;
    /** For a screen reader: "Balance: fails. 85 mm outside the base." */
    summary: string;
    /** The tooltip: the plain meaning, then the technical term. */
    tip: string;
    /** The technical term, for the glossary: "Centre-of-gravity margin to the support base". */
    tech: string;
}

const MARK_WORD: Record<Mark, string> = { pass: "passes", warn: "has a warning", fail: "fails", none: "" };

/** Blocks the stabilizer added (every role but "original"); 0 for a model made from a mesh. */
export function addedBlockCount(result: Pick<AnalysisResult, "assembly">): number {
    const roles = result.assembly?.roleCounts;
    if (!roles) return 0;
    return roles.reduce((sum, n, i) => (i > 0 ? sum + n : sum), 0);
}

/** A figure's parts; `phrase` becomes the sentence a screen reader hears after the mark. */
function figure(key: FigureKey, term: Term, parts: { value: string; unit: string; mark: Mark; phrase: string }): KeyFigure {
    const word = MARK_WORD[parts.mark];
    return {
        key,
        label: term.label,
        value: parts.value,
        unit: parts.unit,
        mark: parts.mark,
        summary: `${term.label}: ${word ? `${word}. ` : ""}${parts.phrase}.`,
        tip: term.tip,
        tech: term.tech,
    };
}

/**
 * Is the strength figure no real reading? Parts of the model float, the estimate leaves them out ("not analysed"), and the worst joint
 * of the part that stands is nowhere near a warning: the figure is the grounded part's alone, so "0%" would say the model is fine when
 * it is not. The same rule the stabilizer's log uses (store/stabilizeLogic.ts metricsOf: "n/a"), so the panel and the log agree.
 */
export function strengthIsPartial(result: Partial<Pick<AnalysisResult, "stats" | "stress">>): boolean {
    const stress = result.stress;
    if (!stress) return false;
    const left = (result.stats?.floatingCount ?? 0) > 0 || stress.unsupportedBlocks > 0;
    return left && stress.maxUtilisation < STRESS_WARN_SHARE;
}

/**
 * The four figures that answer "is it OK?": balance, longest overhang, strength used, blocks used. Each has a mark. Balance fails
 * outside the base or with nothing on the ground and warns on the very edge (the report's 1 mm); the longest overhang fails past the
 * limit; strength used warns above 75% and fails above 100%; blocks used is a plain number unless a budget is set.
 *
 * Parts that float are not a green tick, so a figure never contradicts "Won't stand: 1 part is floating": the balance and the strength
 * of the part on the ground alone are neutral. Balance keeps its number and says "base only"; strength has no reading ("-", "floating
 * parts not counted"). A reading that fails or warns is real and stays as it is.
 */
export function keyFigures(result: AnalysisResult): KeyFigure[] {
    const { issues, stability, stats, settings } = result;
    const empty = stats.blockCount === 0;

    // Balance
    let balance: KeyFigure;
    if (empty) balance = figure("balance", TERMS.balance, { value: "-", unit: "no blocks", mark: "none", phrase: "No blocks" });
    else if (!stability) balance = figure("balance", TERMS.balance, { value: "-", unit: "nothing on the ground", mark: "fail", phrase: "Nothing touches the ground" });
    else if (!stability.inside) {
        const v = mmText(-stability.marginMm);
        balance = figure("balance", TERMS.balance, { value: v, unit: "outside", mark: "fail", phrase: `${v} outside the base` });
    } else {
        const v = mmText(stability.marginMm);
        // Inside, but within 1 mm of the edge: the engine raises a warning about it.
        const edge = issues.some((issue) => issue.kind === "cog-outside");
        // Parts float: the margin is the grounded part's, so it is not a pass for the model.
        const baseOnly = !edge && (stats.floatingCount ?? 0) > 0;
        balance = figure("balance", TERMS.balance, {
            value: v,
            unit: edge ? "on the edge" : baseOnly ? "base only" : "inside",
            mark: edge ? "warn" : baseOnly ? "none" : "pass",
            phrase: edge ? "On the very edge of the base" : baseOnly ? `For information only: ${v} inside the base, counting only the grounded part` : `${v} inside the base`,
        });
        if (baseOnly) balance.tip = `Only the grounded part is counted: the floating parts are not. ${balance.tip}`;
    }

    // Longest overhang
    const longest = stats.longestCantilever;
    const limit = settings.cantileverLimit;
    let overhang: KeyFigure;
    if (empty) overhang = figure("overhang", TERMS.longestOverhang, { value: "-", unit: "no blocks", mark: "none", phrase: "No blocks" });
    else if (longest === 0) overhang = figure("overhang", TERMS.longestOverhang, { value: "none", unit: "", mark: "pass", phrase: "No overhang" });
    else {
        const blocks = plural(longest, "block");
        overhang = figure("overhang", TERMS.longestOverhang, {
            value: blocks,
            unit: `max ${limit}`,
            mark: longest > limit ? "fail" : "pass",
            phrase: `${blocks}, the most allowed is ${limit}`,
        });
    }

    // Strength used
    let strength: KeyFigure;
    if (!result.stress) strength = figure("strength", TERMS.strengthUsed, { value: "-", unit: "no estimate", mark: "none", phrase: "No estimate" });
    else if (strengthIsPartial(result)) {
        // Parts float and were left out of the estimate: the worst joint of the part on the ground says nothing about the model.
        strength = figure("strength", TERMS.strengthUsed, { value: "-", unit: "floating parts not counted", mark: "none", phrase: "No reading: the floating parts are not analysed, only the grounded part was checked" });
        strength.tip = `Not worked out: parts of the model float, so only the grounded part was checked. ${strength.tip}`;
    } else {
        const u = result.stress.maxUtilisation;
        strength = figure("strength", TERMS.strengthUsed, {
            value: fmtPct(u),
            unit: "worst joint",
            mark: u > STRESS_FAIL_SHARE ? "fail" : u > STRESS_WARN_SHARE ? "warn" : "pass",
            phrase: `${fmtPct(u)} used at the worst joint`,
        });
    }

    // Blocks used
    const budget = settings.maxBlocks;
    const added = addedBlockCount(result);
    const unit = [budget !== null ? `of ${budget}` : null, added > 0 ? `+${added} added` : null].filter((part): part is string => part !== null).join(" · ");
    const blocks = figure("blocks", TERMS.blocksUsed, {
        value: String(stats.blockCount),
        unit,
        mark: budget === null ? "none" : stats.blockCount > budget ? "fail" : "pass",
        phrase: `${plural(stats.blockCount, "block")}${budget !== null ? `, the budget is ${budget}` : ""}${added > 0 ? `, ${added} added by the stabilizer` : ""}`,
    });

    return [balance, overhang, strength, blocks];
}

// ---------- the problem list ----------

export interface IssueBrief {
    /** The first line: "Arm too long: 6 blocks (max 4)". */
    what: string;
    /** The second line, in words: "600-700 mm up, right side" or "weight pulls to the right"; "" when the issue has no place. */
    where: string;
    /** The reason behind "Why": the issue's detail, in plain words. */
    why: string;
    tone: "fail" | "warn";
}

/**
 * Where a model that is inside its base but on the very edge of it would go over: the side of the base the weight is nearest
 * to (the same edge analysis/issues.ts names), in the Front view's words. "" when there is no base.
 */
function edgeDirection(result: Pick<AnalysisResult, "stability">): string {
    const s = result.stability;
    if (!s || s.supportHull.length < 2) return "";
    const out = outwardNormal(s.supportHull, hullDistance(s.groundPointMm, s.supportHull).edge);
    return out ? plainDirection(out[0], out[1]) : "";
}

/**
 * One problem as three short strings. `where` is a height and a side as the Front view shows them (never a cell coordinate); for
 * a tip it is the direction the weight pulls in. `what` and `why` are the issue's own title and detail, which are worded for
 * a student (analysis/issues.ts, analysis/stress.ts).
 */
export function issueBrief(issue: Issue, result: Pick<AnalysisResult, "blocks" | "settings" | "stability">): IssueBrief {
    const bs = result.settings.blockSizeMm;
    let where = "";
    if (issue.kind === "cog-outside") {
        const s = result.stability;
        if (issue.severity === "error") {
            const dir = s?.tipDirection ? plainDirection(s.tipDirection[0], s.tipDirection[1]) : "";
            where = dir ? `weight pulls to the ${dir}` : "weight is past the base";
        } else {
            const dir = edgeDirection(result);
            where = dir ? `weight is at the ${dir} edge` : "weight is on the edge of the base";
        }
    } else if (issue.blocks.length > 0) {
        // A stress issue is about one joint, at the peak block (the first); its other blocks are the region around it.
        const stress = issue.kind === "overstressed" || issue.kind === "highly-stressed";
        where = placeOf(result.blocks, stress ? issue.blocks.slice(0, 1) : issue.blocks, bs)?.line ?? "";
    } else if (issue.kind === "thin-features") {
        where = placeAtPoint(result.blocks, issue.focusMm, bs)?.line ?? "";
    }
    return { what: issue.title, where, why: issue.detail, tone: issue.severity === "error" ? "fail" : "warn" };
}

/** Where an issue sits in the list: tip, floating, arms, overload, other errors, then the warnings (edge, loaded, thin). */
function listRank(issue: Issue): number {
    if (issue.severity === "error") {
        switch (issue.kind) {
            case "cog-outside":
                return 0;
            case "floating":
                return 1;
            case "cantilever-too-long":
                return 2;
            case "overstressed":
                return 3;
            default:
                return 4;
        }
    }
    switch (issue.kind) {
        case "cog-outside":
            return 10;
        case "highly-stressed":
            return 11;
        case "thin-features":
            return 12;
        default:
            return 13;
    }
}

/** The issues in the order the problem list shows them (a new array; issues of the same rank keep the engine's order). */
export function sortIssuesForList(issues: readonly Issue[]): Issue[] {
    return issues
        .map((issue, i) => ({ issue, i }))
        .sort((a, b) => listRank(a.issue) - listRank(b.issue) || a.i - b.i)
        .map((x) => x.issue);
}

// ---------- the checks ----------

/** The row's name in plain words: "Balance", "Overhanging blocks", "Overhangs too long", "Blocks used", "Floating parts", "Strength used". */
export const checkLabel = (key: CheckKey): string => CHECK_TERMS[key].label;

/** What the check rows read of a result. */
export type CheckInput = Pick<AnalysisResult, "issues" | "stability" | "stats" | "settings" | "cantilevers" | "bodies" | "stress">;

/**
 * The value of a check row in plain words ("Inside the base, 142 mm from the edge", "None longer than 4 blocks", "Worst joint uses
 * 132% of its strength"). The engine's own value (`row.value`: "Inside the base · 142 mm margin", cell coordinates) stays in the
 * exported report. Where the engine's line is plain already (no estimate: "No blocks", "Nothing stands on the ground"), it is used.
 */
export function checkValue(row: Pick<CheckRow, "key" | "value">, result: CheckInput): string {
    const { stability, stats, settings } = result;
    const empty = stats.blockCount === 0;
    switch (row.key) {
        case "cog": {
            if (empty) return "No blocks";
            if (!stability) return "Nothing touches the ground";
            const notes: string[] = [];
            if ((stability.groundedBodies ?? 1) > 1) notes.push(`weakest of ${stability.groundedBodies} separate pieces`);
            if (stats.floatingCount > 0) notes.push(`${plural(stats.floatingCount, "floating block")} not counted`);
            const tail = notes.length > 0 ? ` · ${notes.join(" · ")}` : "";
            if (!stability.inside) {
                const dir = stability.tipDirection ? plainDirection(stability.tipDirection[0], stability.tipDirection[1]) : "";
                return `Outside the base by ${mmText(-stability.marginMm)}${dir ? `, tips to the ${dir}` : ""}${tail}`;
            }
            if (result.issues.some((issue) => issue.kind === "cog-outside")) return `On the very edge of the base${tail}`;
            return `Inside the base, ${mmText(stability.marginMm)} from the edge${tail}`;
        }
        case "cantilevered":
            return empty ? "No blocks" : stats.cantileveredCount === 0 ? "None" : plural(stats.cantileveredCount, "block");
        case "long-cantilevers": {
            if (empty) return "No blocks";
            const arms = result.cantilevers.filter((run) => run.overLimit.length > 0).length;
            return arms === 0 ? `None longer than ${plural(settings.cantileverLimit, "block")}` : `${plural(arms, "arm")} longer than ${plural(settings.cantileverLimit, "block")}`;
        }
        case "components":
            return `${plural(stats.blockCount, "block")}${settings.maxBlocks !== null ? ` (budget ${settings.maxBlocks})` : ""}`;
        case "floating": {
            if (empty) return "No blocks";
            const parts = result.bodies.filter((body) => !body.grounded).length;
            return parts === 0 ? "None" : `${plural(stats.floatingCount, "block")} in ${plural(parts, "floating part")}`;
        }
        case "stress": {
            if (!result.stress) return row.value;
            const left = result.stress.unsupportedBlocks > 0 ? ` · ${plural(result.stress.unsupportedBlocks, "floating block")} not analysed` : "";
            // Parts float: the reading is the grounded part's, and "0%" would say the model is fine.
            if (strengthIsPartial(result)) return `Only the grounded part was checked, and it is well within its strength${left}`;
            return `Worst joint uses ${fmtPct(result.stress.maxUtilisation)} of its strength${left}`;
        }
    }
}
