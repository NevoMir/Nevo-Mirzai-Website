// The geometry of the convergence chart, apart from the drawing so the tests can read it: the paths, the axis marks, the sentence for a screen reader.

import { kgText, pctText, plural, sagShare, type Focus, type LiveRow } from "@/assignment/store/optimizeLogic";

export const CHART_WIDTH = 288;
export const CHART_HEIGHT = 110;
export const PAD = { left: 38, right: 30, top: 8, bottom: 16 };

export interface ChartPaths {
    /** The step area under the weight (blocks), closed to the floor. */
    area: string;
    /** The weight, as a line. */
    weight: string;
    /** The goal's figure (strength used, balance or sag), as a line on the right axis (breaks where there is no figure). */
    strength: string;
    /** What the second line follows. */
    focus: Focus;
    /** The three marks of the right axis (top, middle, bottom) and what the axis counts in. */
    rightTicks: string[];
    rightTitle: string;
    /** y of the dashed strength limit line (only when it follows the strength used), or null. */
    limitY: number | null;
    /** The three labelled marks of the left axis: kg and y. */
    ticks: Array<{ y: number; text: string }>;
    /** The end of the weight line: where the dot sits. */
    end: { x: number; y: number } | null;
    /** The weight axis range, kg. */
    range: [number, number];
}

const num = (n: number): string => (Math.round(n * 10) / 10).toString();

/** The top of the right axis for a figure that peaks at `peak`: 100 mm steps for the balance, quarters of the start for the sag. */
const niceTop = (focus: Focus, peak: number): number => (focus === "balance" ? Math.max(100, Math.ceil(peak / 100) * 100) : Math.max(1, Math.ceil(peak * 4) / 4));

/**
 * The geometry of the chart: weight (left axis, kg) with the blocks as a step area under it, and the figure the goal is about on the right
 * axis: the share of strength used (0 to 100%, with the limit as a dashed line), the balance (mm) or the sag (against the start's). The
 * horizontal axis is the round; while a run goes it reaches at least `minRounds`, so the line grows from the left instead of being
 * stretched over the whole width every time.
 */
export function chartPaths(rows: readonly LiveRow[], kgPer: number, limit: number | null, minRounds = 12, width = CHART_WIDTH, height = CHART_HEIGHT, focus: Focus = "strength"): ChartPaths {
    const innerW = width - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const lastRound = rows.length > 0 ? rows[rows.length - 1].iteration : 0;
    const x = (round: number): number => PAD.left + (innerW * round) / Math.max(1, Math.max(lastRound, minRounds));
    const kgs = rows.map((r) => r.blocks * kgPer);
    const hi = kgs.length > 0 ? Math.max(...kgs) : 1;
    const lo = kgs.length > 0 ? Math.min(...kgs) : 0;
    // A little room above the start and below the end, and never a flat axis.
    const pad = Math.max(0.5, (hi - lo) * 0.08);
    const top = hi + pad;
    const bottom = Math.max(0, lo - pad);
    const yWeight = (kg: number): number => PAD.top + innerH * (1 - (kg - bottom) / Math.max(1e-6, top - bottom));
    // The right axis in its own units: strength used 0..1, balance 0..top mm, sag 0..top times the start's.
    const startSag = rows.length > 0 ? rows[0].deflection : null;
    const rightValue = (r: LiveRow): number | null => (focus === "strength" ? r.util : focus === "balance" ? r.margin : sagShare(r.deflection, startSag));
    const peak = Math.max(0, ...rows.map((r) => rightValue(r) ?? 0));
    const top2 = focus === "strength" ? 1 : niceTop(focus, peak);
    const yUtil = (u: number): number => PAD.top + innerH * (1 - Math.min(1, Math.max(0, u / top2)));

    let area = "";
    let weight = "";
    rows.forEach((r, n) => {
        const px = x(r.iteration);
        const py = yWeight(kgs[n]);
        if (n === 0) {
            weight = `M${num(px)} ${num(py)}`;
            area = `M${num(px)} ${num(PAD.top + innerH)} L${num(px)} ${num(py)}`;
        } else {
            // A step: the count holds until the next round changes it.
            const prev = yWeight(kgs[n - 1]);
            weight += ` L${num(px)} ${num(prev)} L${num(px)} ${num(py)}`;
            area += ` L${num(px)} ${num(prev)} L${num(px)} ${num(py)}`;
        }
    });
    if (rows.length > 0) area += ` L${num(x(rows[rows.length - 1].iteration))} ${num(PAD.top + innerH)} Z`;

    let strength = "";
    let open = false;
    rows.forEach((r) => {
        const v = rightValue(r);
        if (v === null) {
            open = false;
            return;
        }
        strength += `${open ? " L" : " M"}${num(x(r.iteration))} ${num(yUtil(v))}`;
        open = true;
    });
    const tickText = (v: number): string => (focus === "strength" ? `${Math.round(v * 100)}%` : focus === "balance" ? String(Math.round(v)) : `${Math.round(v * 100)}%`);
    const rightTicks = [top2, top2 / 2, 0].map(tickText);
    const rightTitle = focus === "strength" ? "used" : focus === "balance" ? "mm" : "sag";

    const ticks = [top, (top + bottom) / 2, bottom].map((kg) => ({ y: yWeight(kg), text: kgText(kg).replace(" kg", "") }));
    const end = rows.length > 0 ? { x: x(rows[rows.length - 1].iteration), y: yWeight(kgs[kgs.length - 1]) } : null;
    return { area, weight, strength: strength.trim(), focus, rightTicks, rightTitle, limitY: limit === null || focus !== "strength" ? null : yUtil(limit), ticks, end, range: [bottom, top] };
}

/** The sentence a screen reader gets for the picture. */
export function chartSummary(rows: readonly LiveRow[], kgPer: number, limit: number | null, focus: Focus = "strength"): string {
    if (rows.length === 0) return "No rounds yet.";
    const first = rows[0];
    const last = rows[rows.length - 1];
    const parts = [`After ${plural(last.iteration, "round")}, ${first.blocks} blocks became ${last.blocks}, ${kgText(first.blocks * kgPer)} became ${kgText(last.blocks * kgPer)}`];
    if (focus === "strength" && last.util !== null) parts.push(`strength used is ${pctText(last.util)}${limit !== null ? `, the limit is ${pctText(limit)}` : ""}`);
    if (focus === "balance" && last.margin !== null) parts.push(`the weight sits ${Math.round(last.margin)} mm inside the base${first.margin !== null ? `, it was ${Math.round(first.margin)} mm` : ""}`);
    const sag = focus === "sag" ? sagShare(last.deflection, first.deflection) : null;
    if (sag !== null) parts.push(`it sags ${Math.round(sag * 100)}% of what it did before`);
    return `${parts.join("; ")}.`;
}

/** At most `max` rows for the table: the first, the last and an even sample between. */
export function sampleRows<T>(rows: readonly T[], max: number): T[] {
    if (rows.length <= max) return [...rows];
    return Array.from({ length: max }, (_, i) => rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
}
