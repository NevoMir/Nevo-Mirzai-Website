// Compiling a spec: the model's facts (SpecContext, the Brief it is shown) and the step from an OptimizationSpec to the numbers and masks of
// an OptimizeConfig. The language itself (types, schema, prompt, repair, presets) is shared/optimizeSpec.ts.
//
//   briefOf(ctx)                the facts about THIS model the language model needs (parts, extent, current figures)
//   compileSpec(spec, ctx)      -> OptimizeConfig + the resolved ("effective") values for the controls + warnings

import { roleIndex } from "../../shared/assembly.ts";
import { cellCoords, cellIndex, NB6, inGrid } from "../stabilize/grid.ts";
import { CELLS, DIMS } from "./evaluate.ts";
import { DEFAULT_MAX_STRESS_PCT, DEFAULT_MIN_BLOCKS_PCT_ANY, DEFAULT_MIN_COG_MARGIN_MM, SPEC_LIMITS } from "../../shared/optimizeSpec.ts";
import type { Brief, CellBox, MoveAllow, OptimizationSpec, RepairContext, Removable, Symmetry } from "../../shared/optimizeSpec.ts";
import type { Limits, Metrics, ObjectiveTerm, OptimizeConfig } from "./types.ts";

export * from "../../shared/optimizeSpec.ts";

/** The block an edit made by words: the person's own, never "support the stabilizer added", so the scope "added" leaves it alone. */
const USER_ROLE = roleIndex("user");

/** What repairSpec / compileSpec / briefOf need of the model being optimized. */
export interface SpecContext {
    /** 1 where a block is (index (k * 10 + j) * 10 + i). */
    occ: Uint8Array;
    /** Per cell: role index of the block (0 = original = in the analysed model; "user" = made by an edit; the others were added by the stabilizer). */
    role: Uint8Array;
    /** Cells of each named part of the source mesh (only parts that own at least one block). May be empty (a single-mesh model). */
    parts: Record<string, Uint8Array>;
    cantileverLimit: number;
    /** The block budget of the Stability tab's settings (null: none). It is a limit of the run too: a result over it is marked there as an error. */
    budget: number | null;
    /** Figures of the start. */
    start: Metrics;
}

/** Cells whose six neighbours are all blocks: not visible from outside. */
export function hiddenInner(occ: Uint8Array): Uint8Array {
    const out = new Uint8Array(CELLS);
    for (let c = 0; c < CELLS; c++) {
        if (!occ[c]) continue;
        const [i, j, k] = cellCoords(DIMS, c);
        let all = true;
        for (const [a, b, d] of NB6) {
            const ni = i + a, nj = j + b, nk = k + d;
            if (!inGrid(DIMS, ni, nj, nk) || !occ[cellIndex(DIMS, ni, nj, nk)]) { all = false; break; }
        }
        if (all) out[c] = 1;
    }
    return out;
}

/** The mirror symmetries the start has (about the middle of the lattice). */
export function symmetriesOf(occ: Uint8Array): Symmetry[] {
    const test = (fx: boolean, fy: boolean): boolean => {
        for (let c = 0; c < CELLS; c++) {
            const [i, j, k] = cellCoords(DIMS, c);
            if (occ[c] !== occ[cellIndex(DIMS, fx ? 9 - i : i, fy ? 9 - j : j, k)]) return false;
        }
        return true;
    };
    const out: Symmetry[] = [];
    if (test(true, false)) out.push("x");
    if (test(false, true)) out.push("y");
    if (test(true, true)) out.push("xy");
    return out;
}

function boxOf(cells: ArrayLike<number>): CellBox | null {
    const min: [number, number, number] = [9, 9, 9];
    const max: [number, number, number] = [0, 0, 0];
    let any = false;
    for (let c = 0; c < CELLS; c++) {
        if (!cells[c]) continue;
        any = true;
        const p = cellCoords(DIMS, c);
        for (let a = 0; a < 3; a++) { if (p[a] < min[a]) min[a] = p[a]; if (p[a] > max[a]) max[a] = p[a]; }
    }
    return any ? { min, max } : null;
}

export function briefOf(ctx: SpecContext): Brief {
    const perLayer = Array.from({ length: 10 }, () => 0);
    let added = 0;
    for (let c = 0; c < CELLS; c++) if (ctx.occ[c]) { perLayer[cellCoords(DIMS, c)[2]]++; if (ctx.role[c] !== 0 && ctx.role[c] !== USER_ROLE) added++; }
    const hidden = hiddenInner(ctx.occ);
    const parts: Brief["parts"] = [];
    for (const [name, cells] of Object.entries(ctx.parts)) {
        let n = 0;
        const own = new Uint8Array(CELLS);
        for (let c = 0; c < CELLS; c++) if (cells[c] && ctx.occ[c]) { n++; own[c] = 1; }
        const box = boxOf(own);
        if (n > 0 && box) parts.push({ name, blocks: n, box });
    }
    return {
        grid: "10x10x10 cells of 100 mm; cell (i, j, k), k up, k = 0 on the ground",
        blocks: ctx.start.blocks,
        extent: boxOf(ctx.occ) ?? { min: [0, 0, 0], max: [0, 0, 0] },
        blocks_per_layer: perLayer,
        added_by_stabilizer: added,
        hidden_inner_blocks: hidden.reduce((a, b) => a + b, 0),
        parts,
        current: {
            cog_margin_mm: ctx.start.cogMarginMm === null ? null : Math.round(ctx.start.cogMarginMm),
            peak_stress_pct: ctx.start.maxUtil === null ? null : Math.round(ctx.start.maxUtil * 100),
            longest_cantilever: ctx.start.longestReach,
            max_cantilever_blocks: ctx.cantileverLimit,
            symmetric: symmetriesOf(ctx.occ),
        },
    };
}

export const repairContextOf = (ctx: Pick<SpecContext, "parts" | "start">): RepairContext => ({ partNames: Object.keys(ctx.parts), blocks: ctx.start.blocks });

// ---------- compiling ----------

/** The values the optimizer will really use, for the controls ("effective") and for the log. */
export interface Effective {
    terms: ObjectiveTerm[];
    maxStressPct: number;
    minCogMarginMm: number;
    cantileverBlocks: number;
    maxBlocks: number;
    minBlocks: number;
    maxDeflectionPct: number | null;
    keepOnePiece: boolean;
    symmetry: Symmetry;
    allow: MoveAllow;
    removable: Removable;
    stopAtBlocks: number | null;
    removableBlocks: number;
    addableCells: number;
}

export interface Compiled {
    config: OptimizeConfig;
    effective: Effective;
    /** Things the user should know before pressing Run (a protection that covers everything removable, a limit the start already breaks ...). */
    warnings: string[];
}

export interface CompileOptions {
    maxIterations?: number;
    maxSolves?: number;
    timeBudgetMs?: number;
}

export function compileSpec(spec: OptimizationSpec, ctx: SpecContext, options: CompileOptions = {}): Compiled {
    const warnings: string[] = [];
    const n0 = ctx.start.blocks;
    const cn = spec.constraints;

    // objective
    const sum = spec.objective.reduce((s, t) => s + t.weight, 0) || 1;
    const terms: ObjectiveTerm[] = spec.objective.map((t) => ({ metric: t.metric, weight: t.weight / sum }));

    // block budget
    const startMargin = ctx.start.cogMarginMm;
    let maxBlocks = Math.min(1000, cn.max_blocks ?? 1000);
    if (cn.max_added_blocks !== null) maxBlocks = Math.min(maxBlocks, n0 + cn.max_added_blocks);
    let allow = spec.moves.allow;
    let defaultExtra: number | null = null;
    if (allow !== "remove" && cn.max_blocks === null && cn.max_added_blocks === null) {
        defaultExtra = Math.max(5, Math.round(n0 * 0.1));
        maxBlocks = Math.min(maxBlocks, n0 + defaultExtra);
    }
    // The Stability tab's block budget (Settings) is a limit as well: without it a result could stand over the budget and be marked there.
    const budget = ctx.budget ?? null;
    const budgeted = budget !== null && budget < maxBlocks;
    if (budgeted) maxBlocks = Math.max(1, budget);
    if (defaultExtra !== null && terms.some((t) => t.metric !== "blocks")) {
        warnings.push(
            budgeted
                ? `No block limit was given and the block budget in Settings is ${budget}, so at most ${Math.max(0, budget - n0)} extra blocks may be added.`
                : `No block budget was given, so at most ${defaultExtra} extra blocks (10 %) may be added.`,
        );
    } else if (budgeted && defaultExtra === null && allow !== "remove") {
        warnings.push(`The block budget in Settings is ${budget}, lower than the limit asked for, so at most ${budget} blocks are used.`);
    }
    let minBlocks = 1;
    const minPct = cn.min_blocks_pct ?? (spec.moves.removable === "any" ? DEFAULT_MIN_BLOCKS_PCT_ANY : null);
    if (minPct !== null) minBlocks = Math.max(1, Math.ceil((n0 * minPct) / 100));
    if (spec.moves.removable === "any" && cn.min_blocks_pct === null) warnings.push(`Any block may be removed, so the structure keeps at least ${DEFAULT_MIN_BLOCKS_PCT_ANY} % of its blocks.`);
    if (maxBlocks < minBlocks) {
        warnings.push("The block limits contradict each other; the minimum was lowered.");
        minBlocks = Math.min(minBlocks, maxBlocks);
    }
    if (n0 > maxBlocks && allow === "add") {
        warnings.push(`The model already has more than ${maxBlocks} blocks; only removals can satisfy that limit.`);
        allow = "both";
    }

    // stability constraints
    // A model that already uses more than the usual 75 % (its only problem is the "heavily loaded" warning) cannot be asked to get under
    // it before anything else may change: with no limit given the run holds it at today's level instead.
    const startStressPct = ctx.start.maxUtil === null ? null : ctx.start.maxUtil * 100;
    const stressAdapts = cn.max_stress_pct === null && startStressPct !== null && startStressPct > DEFAULT_MAX_STRESS_PCT + 1e-9;
    const maxStressPct = cn.max_stress_pct ?? (stressAdapts ? Math.min(SPEC_LIMITS.stressPct[1], Math.ceil((startStressPct as number) - 1e-9)) : DEFAULT_MAX_STRESS_PCT);
    if (stressAdapts) warnings.push(`The model already uses ${Math.round(startStressPct as number)} % of its strength, more than the usual ${DEFAULT_MAX_STRESS_PCT} %, so the run keeps it at or under ${Math.round(maxStressPct)} %.`);
    const minCog = cn.min_cog_margin_mm ?? Math.min(DEFAULT_MIN_COG_MARGIN_MM, Math.max(0, Math.floor(startMargin ?? DEFAULT_MIN_COG_MARGIN_MM)));
    const cantilever = cn.max_cantilever_blocks ?? ctx.cantileverLimit;
    if (ctx.start.maxUtil !== null && ctx.start.maxUtil * 100 > maxStressPct + 1e-9) warnings.push(`The model already uses more than ${Math.round(maxStressPct)} % of its strength (${Math.round(ctx.start.maxUtil * 100)} %); it first tries to bring it under. If it cannot, nothing is changed; a higher limit keeps what it finds.`);
    if (startMargin !== null && startMargin < minCog - 1e-9) warnings.push(`The weight sits only ${Math.round(startMargin)} mm inside the base, less than the ${Math.round(minCog)} mm asked for; it first tries to widen it.`);
    if (cantilever < ctx.start.longestReach) warnings.push(`The longest overhang (${ctx.start.longestReach} blocks) is already past the limit of ${cantilever}.`);
    // The Stability tab judges with its own settings: a result that really uses a looser limit is marked there, so optimizeAssembly does not offer it.
    if (cantilever > ctx.cantileverLimit) warnings.push(`An overhang of ${cantilever} blocks is longer than the ${ctx.cantileverLimit} the Stability tab allows, so a result that uses the extra length cannot be kept.`);
    if (maxStressPct > 75 && !stressAdapts) warnings.push(`Using more than 75 % of the strength is a warning in the Stability tab.`);
    const maxDeflectionMm = cn.max_deflection_pct !== null && ctx.start.maxDeflectionMm !== null ? (ctx.start.maxDeflectionMm * cn.max_deflection_pct) / 100 : null;

    // symmetry
    let symmetry = cn.symmetry;
    if (symmetry !== "none" && !symmetriesOf(ctx.occ).includes(symmetry)) {
        warnings.push(`The model is not mirror-symmetric ${symmetry === "xy" ? "both ways" : symmetry === "x" ? "left to right" : "front to back"}, so symmetry cannot be kept.`);
        symmetry = "none";
    }

    // masks
    const hidden = hiddenInner(ctx.occ);
    const canRemove = new Uint8Array(CELLS);
    const canAdd = new Uint8Array(CELLS);
    for (let c = 0; c < CELLS; c++) {
        if (ctx.occ[c]) {
            if (spec.moves.removable === "any") canRemove[c] = 1;
            else if ((ctx.role[c] !== 0 && ctx.role[c] !== USER_ROLE) || (spec.moves.removable === "inner" && hidden[c])) canRemove[c] = 1;
        } else canAdd[c] = 1;
    }
    const inBox = (c: number, b: CellBox): boolean => {
        const [i, j, k] = cellCoords(DIMS, c);
        return i >= b.min[0] && i <= b.max[0] && j >= b.min[1] && j <= b.max[1] && k >= b.min[2] && k <= b.max[2];
    };
    for (const r of spec.protected) {
        const member = (c: number): boolean => (r.part !== null ? !!ctx.parts[r.part]?.[c] : r.box !== null ? inBox(c, r.box) : false);
        if (r.part !== null && !ctx.parts[r.part]) { warnings.push(`There is no part "${r.part}" in this model; that protection is ignored.`); continue; }
        for (let c = 0; c < CELLS; c++) {
            const inside = member(c);
            if (r.mode === "keep" && inside) canRemove[c] = 0;
            else if (r.mode === "clear" && inside) canAdd[c] = 0;
            else if (r.mode === "only" && !inside) { canRemove[c] = 0; canAdd[c] = 0; }
        }
    }
    const removableBlocks = canRemove.reduce((a, b) => a + b, 0);
    const addableCells = canAdd.reduce((a, b) => a + b, 0);
    const allowRemove = allow !== "add";
    const allowAdd = allow !== "remove";
    if (allowRemove && removableBlocks < Math.max(3, n0 * 0.03)) warnings.push(removableBlocks === 0 ? "No block may be removed with these settings." : `Only ${removableBlocks} of ${n0} blocks may be removed with these settings; little can change.${spec.moves.removable !== "any" ? " Allowing \"any block\" or loosening a protection frees more." : ""}`);
    if (allowAdd && !allowRemove && addableCells === 0) warnings.push("Nothing may be added with these protections.");

    const bodies = ctx.start.bodies;
    const limits: Limits = {
        maxUtil: maxStressPct / 100,
        minMarginMm: minCog,
        cantileverLimit: cantilever,
        maxBlocks,
        minBlocks,
        maxDeflectionMm,
        maxBodies: cn.keep_one_piece ? Math.max(1, bodies) : 1000,
    };
    const stopAtBlocks = spec.stop.reduce_blocks_by_pct !== null ? Math.max(1, Math.floor(n0 * (1 - spec.stop.reduce_blocks_by_pct / 100))) : null;
    const config: OptimizeConfig = {
        terms,
        limits,
        allowRemove,
        allowAdd,
        canRemove,
        canAdd,
        symmetry,
        stopAtBlocks,
        maxIterations: options.maxIterations ?? 150,
        maxSolves: options.maxSolves ?? Math.max(200, Math.min(600, Math.round(150 + 1.5 * n0))),
        timeBudgetMs: options.timeBudgetMs ?? 60_000,
        blockSizeMm: 100,
    };
    return {
        config,
        warnings,
        effective: {
            terms,
            maxStressPct,
            minCogMarginMm: minCog,
            cantileverBlocks: cantilever,
            maxBlocks,
            minBlocks,
            maxDeflectionPct: cn.max_deflection_pct,
            keepOnePiece: cn.keep_one_piece,
            symmetry,
            allow,
            removable: spec.moves.removable,
            stopAtBlocks,
            removableBlocks,
            addableCells,
        },
    };
}
