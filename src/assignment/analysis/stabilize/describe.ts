// The sentence the timeline shows for one accepted move. Fixed templates, filled with the measured numbers, so the log
// reads the same in the panel, the chat card, the JSON report and the example files. At most 300 characters (the limit
// the Worker enforces on StabilizeStepLog.text).

import type { AddedRole, StabilizeReason, StepMetrics } from "../../shared/contract.ts";

export interface StepContext {
    move: AddedRole;
    reason: StabilizeReason;
    /** Blocks added by this move. */
    added: number;
    /** Separate pieces the blocks make (3 columns of one move); absent or 1: one piece. */
    parts?: number;
    /** Centre of the move in analysis mm; z is the height of the blocks, except for a floating part, where it is the part's own height. */
    atMm: [number, number, number];
    /** What the move holds up or fixes: "arm tip", "arm", "overhang", "slab", "floating part", "joint". */
    target: string;
    before: StepMetrics;
    after: StepMetrics;
    limit: number;
    /** For floating moves: blocks in the part; for stress moves: the utilisation that triggered it. */
    partBlocks?: number;
    trigger?: number;
    /** For footings: the side of the structure they went on ("+X", "-Y", "+X and -Y"); absent when they went all round. */
    side?: string;
    /** For stress and reinforcement moves: the cell of the stressed joint. */
    cell?: [number, number, number];
}

const MAX = 300;
const pct = (u: number | null): string => (u === null ? "n/a" : `${Math.round(u * 100)}%`);
const mm = (v: number): string => `${Math.round(v)} mm`;
const blocks = (n: number): string => `${n}-block`;
/** "a 5-block column", or "3 columns (15 blocks)" when the move put several pieces down at once. */
const what = (c: StepContext): string => (c.parts !== undefined && c.parts > 1 ? `${c.parts} ${c.move}s (${c.added} blocks)` : `a ${blocks(c.added)} ${c.move}`);
const arrow = (a: string | number, b: string | number): string => `${a} → ${b}`;

const pctOf = (u: number | null): number | null => (u === null ? null : Math.round(u * 100));
const samePeak = (b: StepMetrics, a: StepMetrics): boolean => pctOf(b.max_utilisation) === pctOf(a.max_utilisation);
/** Peak stress that went up: the move put load on a part that carried none, so the next steps are what bring it down. */
const rose = (b: StepMetrics, a: StepMetrics): boolean => b.max_utilisation !== null && a.max_utilisation !== null && (pctOf(a.max_utilisation) as number) > (pctOf(b.max_utilisation) as number);

/** "floating blocks 9 → 0" whenever a move changed it, whatever it was made for (a column under an arm can join a floating part). */
function floatingClause(b: StepMetrics, a: StepMetrics): string {
    return b.floating_blocks === a.floating_blocks ? "" : `floating blocks ${arrow(b.floating_blocks, a.floating_blocks)}`;
}

/** Peak stress as a clause, or "" when there is nothing to say (no change, or no grounded block). A rise is worded as one. */
function stressClause(b: StepMetrics, a: StepMetrics): string {
    if (samePeak(b, a)) return "";
    const move = arrow(pct(b.max_utilisation), pct(a.max_utilisation));
    return rose(b, a) ? `peak stress rises ${move} as the new support takes load` : `peak stress ${move}`;
}

/** The clauses that say something, as one sentence: "Longest cantilever 7 → 4; peak stress 64% → 60%." */
function sentence(clauses: string[]): string {
    const text = clauses.filter((x) => x !== "").join("; ");
    return text === "" ? "" : ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function describeStep(c: StepContext): string {
    const at = `x = ${mm(c.atMm[0])}, y = ${mm(c.atMm[1])}`;
    let text: string;
    switch (c.reason) {
        case "floating":
            text =
                c.move === "bridge"
                    ? `Joined the floating part (${c.partBlocks ?? "?"} blocks, around ${mm(c.atMm[2])} high) to the structure with ${what(c)}. Floating blocks ${arrow(c.before.floating_blocks, c.after.floating_blocks)}.`
                    : `Added ${what(c)} under the floating part at ${at} so it reaches the ground. Floating blocks ${arrow(c.before.floating_blocks, c.after.floating_blocks)}.`;
            break;
        case "cantilever": {
            const lb = c.before.longest_cantilever;
            const la = c.after.longest_cantilever;
            const floating = floatingClause(c.before, c.after);
            const stress = stressClause(c.before, c.after);
            // A support that only prepares the next move changes none of the figures: say "stays", never "5 → 5".
            const quiet = lb === la && floating === "" && stress === "";
            const hold = quiet && c.after.max_utilisation !== null && c.after.max_utilisation > 0 ? `peak stress stays at ${pct(c.after.max_utilisation)} for now` : "";
            text = `Added ${what(c)} under the ${c.target} at ${at} because the cantilever reached ${lb} > ${c.limit} blocks.${sentence([lb === la ? `longest cantilever stays at ${lb}` : `longest cantilever ${arrow(lb, la)}`, floating, stress, hold])}`;
            break;
        }
        case "cog": {
            const margin = c.before.cog_margin_mm;
            const outside = margin !== null && margin < 0 ? `${mm(-margin)} outside it` : "close to its edge";
            const moved = `COG margin ${arrow(margin === null ? "n/a" : Math.round(margin), c.after.cog_margin_mm === null ? "n/a" : Math.round(c.after.cog_margin_mm))} mm`;
            text = `Widened the base with ${what(c)}${c.side ? ` on the ${c.side} side` : ""} because the centre of gravity was ${outside}.${sentence([moved, floatingClause(c.before, c.after), rose(c.before, c.after) ? stressClause(c.before, c.after) : ""])}`;
            break;
        }
        case "stress": {
            const peak = samePeak(c.before, c.after) ? `peak stress stays at ${pct(c.after.max_utilisation)}` : stressClause(c.before, c.after);
            const carried = pct(c.trigger ?? c.before.max_utilisation);
            text =
                c.move === "reinforcement"
                    ? `Thickened the joint at block (${(c.cell ?? [0, 0, 0]).join(", ")}) with ${c.added} blocks because it carried ${carried} of the allowable stress.${sentence([peak, floatingClause(c.before, c.after)])}`
                    : `Added ${what(c)} under the ${c.target} at ${at} because the joint above it carried ${carried} of the allowable stress.${sentence([peak, floatingClause(c.before, c.after)])}`;
            break;
        }
    }
    return text.length <= MAX ? text : `${text.slice(0, MAX - 1)}…`;
}
