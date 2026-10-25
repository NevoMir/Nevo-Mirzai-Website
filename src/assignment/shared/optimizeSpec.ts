// The language of an optimization spec: what Muse Spark is asked to write, what comes back, how an untrusted answer is cleaned, and the
// four goals that need no model. PURE: no imports, nothing from the engine, so the Worker (which calls the model and cleans its answer),
// the page (which cleans what the user edits) and the Node tests share it. Ships as src/assignment/shared/optimizeSpec.ts.
//
//   SPEC_SCHEMA / SPEC_SYSTEM_PROMPT / specUserMessage   the request to the model (worker/optimizeSpec.ts sends it)
//   Brief                                                the facts about THIS model the model is given (analysis/optimize/spec.ts briefOf makes it)
//   repairSpec(raw, ctx)                                 untrusted answer -> a clean OptimizationSpec + plain notes (never throws)
//   presetSpec(kind, ctx)                                the four chips (and the fallback when the model is down)

export type MetricKey = "blocks" | "peak_stress" | "cog_margin" | "deflection";
export const METRIC_KEYS: readonly MetricKey[] = ["blocks", "peak_stress", "cog_margin", "deflection"];
export type Symmetry = "none" | "x" | "y" | "xy";

export const SPEC_VERSION = 1;

export type MoveAllow = "remove" | "add" | "both";
export type Removable = "added" | "inner" | "any";
export type ProtectMode = "keep" | "clear" | "only";

export interface CellBox {
    min: [number, number, number];
    max: [number, number, number];
}

export interface ProtectedRegion {
    mode: ProtectMode;
    /** Exactly one of part / box is set. */
    part: string | null;
    box: CellBox | null;
}

export interface OptimizationSpec {
    /**
     * false: the goal has nothing to do with weight, strength, stability or stiffness (a colour, a style, a new part). The page shows
     * `notes` and does not offer Run until the user picks a goal. (Added to the schema after the live tests; a plain boolean like
     * keep_one_piece, to be confirmed with one live call when the build lands.)
     */
    actionable: boolean;
    /** <= 48 characters: the card title ("Lightest stable"). */
    title: string;
    /** <= 240 characters: one sentence, what the optimizer will do. Shown above the controls. */
    summary: string;
    /** 1-3 metrics, weights > 0 (normalised to sum to 1 when compiled). */
    objective: Array<{ metric: MetricKey; weight: number }>;
    moves: { allow: MoveAllow; removable: Removable };
    constraints: {
        /** Peak joint utilisation allowed, % of the allowable stress. null: 75 (no stress warning), or the start's level when it already uses more. */
        max_stress_pct: number | null;
        /** Smallest centre-of-gravity margin, mm. null: 100, or the start's margin when that is smaller. */
        min_cog_margin_mm: number | null;
        /** Longest cantilever, blocks. null: the analysis setting. */
        max_cantilever_blocks: number | null;
        /** Most blocks in all. */
        max_blocks: number | null;
        /** Most blocks more than the start has. */
        max_added_blocks: number | null;
        /** Never fewer than this % of the start's blocks. null: 50 when removable is "any", else none. */
        min_blocks_pct: number | null;
        /** Deflection must stay at or under this % of the start's (100 = no worse than now). */
        max_deflection_pct: number | null;
        /** Stay one free-standing piece (never split into two structures). */
        keep_one_piece: boolean;
        symmetry: Symmetry;
    };
    protected: ProtectedRegion[];
    /** Stop early once the goal is met. */
    stop: { reduce_blocks_by_pct: number | null };
    /** <= 3 short sentences: assumptions made, things asked for that the optimizer cannot do. */
    notes: string[];
}

// ---------- limits of every field (also the clamp of repairSpec and the range of the page's controls) ----------

export const SPEC_LIMITS = {
    title: 48,
    summary: 240,
    note: 160,
    notes: 3,
    terms: 3,
    regions: 6,
    partName: 80,
    stressPct: [20, 100],
    cogMarginMm: [0, 400],
    cantileverBlocks: [1, 10],
    blocks: [1, 1000],
    addedBlocks: [0, 400],
    minBlocksPct: [10, 100],
    deflectionPct: [20, 300],
    reducePct: [1, 90],
} as const;

export const DEFAULT_MAX_STRESS_PCT = 75;
export const DEFAULT_MIN_COG_MARGIN_MM = 100;
export const DEFAULT_MIN_BLOCKS_PCT_ANY = 50;

// ---------- the request ----------

const NULLABLE_NUMBER = { type: ["number", "null"] } as const;
const NULLABLE_INT = { type: ["integer", "null"] } as const;
const CELL_TRIPLE = { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3 } as const;

/** The `json_schema` of OpenRouter's response_format (strict: every key required, nulls for "not asked"). Tested live with Muse Spark. */
export const SPEC_SCHEMA = {
    name: "optimization_spec",
    strict: true,
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["actionable", "title", "summary", "objective", "moves", "constraints", "protected", "stop", "notes"],
        properties: {
            actionable: { type: "boolean" },
            title: { type: "string" },
            summary: { type: "string" },
            objective: {
                type: "array",
                minItems: 1,
                maxItems: SPEC_LIMITS.terms,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["metric", "weight"],
                    properties: { metric: { type: "string", enum: [...METRIC_KEYS] }, weight: { type: "number" } },
                },
            },
            moves: {
                type: "object",
                additionalProperties: false,
                required: ["allow", "removable"],
                properties: {
                    allow: { type: "string", enum: ["remove", "add", "both"] },
                    removable: { type: "string", enum: ["added", "inner", "any"] },
                },
            },
            constraints: {
                type: "object",
                additionalProperties: false,
                required: ["max_stress_pct", "min_cog_margin_mm", "max_cantilever_blocks", "max_blocks", "max_added_blocks", "min_blocks_pct", "max_deflection_pct", "keep_one_piece", "symmetry"],
                properties: {
                    max_stress_pct: NULLABLE_NUMBER,
                    min_cog_margin_mm: NULLABLE_NUMBER,
                    max_cantilever_blocks: NULLABLE_INT,
                    max_blocks: NULLABLE_INT,
                    max_added_blocks: NULLABLE_INT,
                    min_blocks_pct: NULLABLE_NUMBER,
                    max_deflection_pct: NULLABLE_NUMBER,
                    keep_one_piece: { type: "boolean" },
                    symmetry: { type: "string", enum: ["none", "x", "y", "xy"] },
                },
            },
            protected: {
                type: "array",
                maxItems: SPEC_LIMITS.regions,
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["mode", "part", "box"],
                    properties: {
                        mode: { type: "string", enum: ["keep", "clear", "only"] },
                        part: { type: ["string", "null"] },
                        box: {
                            anyOf: [
                                { type: "null" },
                                { type: "object", additionalProperties: false, required: ["min", "max"], properties: { min: CELL_TRIPLE, max: CELL_TRIPLE } },
                            ],
                        },
                    },
                },
            },
            stop: {
                type: "object",
                additionalProperties: false,
                required: ["reduce_blocks_by_pct"],
                properties: { reduce_blocks_by_pct: NULLABLE_NUMBER },
            },
            notes: { type: "array", maxItems: SPEC_LIMITS.notes, items: { type: "string" } },
        },
    },
} as const;

export const SPEC_SYSTEM_PROMPT = `You turn a user's goal for a block structure into an optimization spec (JSON). The structure is a 10 x 10 x 10 lattice of 100 mm blocks: cells (i, j) run along the ground, k is up, k = 0 is on the ground. An optimizer adds or removes whole blocks to reach the goal and checks every step with a structural analysis; you only describe the goal. Fill every field; use null for a number the user did not ask for (the defaults then apply).

objective (1-3 metrics, weights 0-1):
- blocks: fewer blocks = lighter and cheaper. "lightweight, lightest, cheapest, less material, save weight".
- peak_stress: the highest joint stress as a share of what the material allows; lower = stronger. "stronger, safer, less stressed, sturdy".
- cog_margin: how far the centre of gravity is inside the base; larger = harder to tip. "stable, won't tip over, steady, balanced".
- deflection: how much it sags or sways under its own weight; lower = stiffer. "stiff, rigid, stiffness, less bending".
"As X as possible but Y" or "X without losing Y": X is the objective, Y is a constraint. "As stable as possible" = cog_margin and peak_stress, about half each.

moves.allow: "remove" when the goal only makes it lighter; "add" when it strengthens with extra blocks; "both" when either can help or the goal mixes both.
moves.removable: "added" = only the blocks the stabilizer added; "inner" = those plus hidden inner blocks, the outside shape stays exactly the same (DEFAULT); "any" = any block, the shape may change: only when the user accepts a different shape ("thin it out", "remove parts", "simplify").

constraints (the structure must always stay valid, never relax that): max_stress_pct (default 75), min_cog_margin_mm (default 100), max_cantilever_blocks, max_blocks ("at most 150 blocks"), max_added_blocks ("at most 20 extra blocks"; a goal that adds blocks should always get one), min_blocks_pct ("keep at least 70% of the blocks"), max_deflection_pct (100 = not stiffer-worse than now), keep_one_piece (true unless asked otherwise), symmetry ("none" unless the user asks to keep it symmetric AND the value is listed in MODEL.current.symmetric: x = mirror left-right, y = front-back, xy = both; if the model lacks that symmetry use "none" and say so in notes).
stop.reduce_blocks_by_pct: "make it 30% lighter" = objective blocks with 30; null otherwise.

protected: "don't touch / don't remove anything from the seat" = mode keep with the part's exact name from the MODEL parts list; "leave the doorway clear / nothing in front of" = mode clear; "only change the roof" = mode only. Use a part name only if it is in the list; otherwise give a box (min and max cell, inclusive). Exactly one of part / box per entry, the other null. With removable "inner" the outside of the whole model already stays exactly as it is, so "keep the cap's look / shape" needs no protection (a keep on a part also stops its hidden inner blocks from being removed, which is rarely wanted).

actionable: false when the goal has nothing to do with weight, strength, stability or stiffness (colour, style, adding new parts, a different shape); then set the other fields to harmless defaults (objective blocks, allow remove, removable added) and explain in notes. Otherwise true.
title: at most 40 characters. summary: one sentence saying what will be done. notes: at most 3 short sentences about assumptions you made or parts of the request this tool cannot do (colours, adding new parts, changing the shape's style); notes only state things, they never ask the person to do or answer something (the page has no way to reply). A protection that names a part the model does not have cannot be kept: say so in one sentence. Write title, summary and notes in plain words for a student: blocks, weight, strength used, balance, overhang; never utilisation, centre of gravity or cantilever.

Examples (abridged):
Goal "make it as light as possible but still stable": objective [blocks 1], moves {remove, inner}, constraints all null except keep_one_piece true and symmetry none, protected [], stop null.
Goal "as stable as possible with at most 20 extra blocks": objective [cog_margin 0.5, peak_stress 0.5], moves {both, inner}, max_added_blocks 20.
Goal "keep the backrest untouched and make the rest 25% lighter" (Backrest is in the parts list): objective [blocks 1], moves {remove, inner}, protected [{keep, part Backrest}], stop 25.`;

/** The user message: the model's facts and the goal, both as data. */
export function specUserMessage(goal: string, brief: Brief): string {
    return `MODEL:\n${JSON.stringify(brief)}\n\nGOAL: ${JSON.stringify(goal.slice(0, GOAL_MAX))}`;
}

export interface Brief {
    grid: string;
    blocks: number;
    extent: CellBox;
    blocks_per_layer: number[];
    added_by_stabilizer: number;
    hidden_inner_blocks: number;
    parts: Array<{ name: string; blocks: number; box: CellBox }>;
    current: { cog_margin_mm: number | null; peak_stress_pct: number | null; longest_cantilever: number; max_cantilever_blocks: number; symmetric: Symmetry[] };
}

// ---------- the facts the model is given: cleaning a brief that came over the wire ----------

/** Most named parts a model carries (letters A to Z) and the longest part name; a name reaches the model as data, so it is made safe. */
export const MAX_PARTS = 26;
export const MAX_PART_NAME = 40;

/** Part names the log and the model can carry: letters, digits, spaces and . _ ( ) -, at most 40; "" when nothing is left. */
export function cleanPartName(name: string): string {
    return name.replace(/[^\p{L}\p{N} _.()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PART_NAME).trim();
}

/** The most the model is shown of one goal (the Worker cuts the goal here too). */
export const GOAL_MAX = 600;

const BRIEF_GRID = "10x10x10 cells of 100 mm; cell (i, j, k), k up, k = 0 on the ground";

/**
 * An untrusted brief (the page's, in a request body) -> a bounded Brief, or null when it is not one. Every number is clamped, the parts are
 * at most 26 with safe names, the grid text is ours. Never throws.
 */
export function cleanBrief(raw: unknown): Brief | null {
    if (!isRecord(raw)) return null;
    // The size is not clamped: a count outside 1 to 1000 is no model of this lattice.
    const blocks = typeof raw.blocks === "number" && Number.isInteger(raw.blocks) && raw.blocks >= 1 && raw.blocks <= 1000 ? raw.blocks : null;
    const extent = cleanBox(raw.extent);
    if (blocks === null || !extent) return null;
    const layers = Array.isArray(raw.blocks_per_layer) ? raw.blocks_per_layer : [];
    const parts: Brief["parts"] = [];
    const seen = new Set<string>();
    if (Array.isArray(raw.parts)) {
        for (const p of raw.parts) {
            if (!isRecord(p) || typeof p.name !== "string") continue;
            const name = cleanPartName(p.name);
            const box = cleanBox(p.box);
            const n = num(p.blocks, 1, 1000, true);
            if (!name || !box || n === null || seen.has(name.toLowerCase())) continue;
            seen.add(name.toLowerCase());
            parts.push({ name, blocks: n, box });
            if (parts.length >= MAX_PARTS) break;
        }
    }
    const cur = isRecord(raw.current) ? raw.current : {};
    const symmetric = (Array.isArray(cur.symmetric) ? cur.symmetric : []).filter((s): s is Symmetry => s === "x" || s === "y" || s === "xy").slice(0, 3);
    return {
        grid: BRIEF_GRID,
        blocks,
        extent,
        blocks_per_layer: Array.from({ length: 10 }, (_, k) => num(layers[k], 0, 100, true) ?? 0),
        added_by_stabilizer: num(raw.added_by_stabilizer, 0, 1000, true) ?? 0,
        hidden_inner_blocks: num(raw.hidden_inner_blocks, 0, 1000, true) ?? 0,
        parts,
        current: {
            cog_margin_mm: num(cur.cog_margin_mm, -2000, 2000, true),
            peak_stress_pct: num(cur.peak_stress_pct, 0, 5000, true),
            longest_cantilever: num(cur.longest_cantilever, 0, 10, true) ?? 0,
            max_cantilever_blocks: num(cur.max_cantilever_blocks, 1, 10, true) ?? 4,
            symmetric: [...new Set(symmetric)],
        },
    };
}

/** The goal as the Worker and the model get it: control characters become spaces, blanks collapse, at most 600 characters; "" when nothing is left. */
export const cleanGoal = (v: unknown): string => text(v, GOAL_MAX);

// ---------- cleaning an answer ----------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

function num(v: unknown, lo: number, hi: number, integer = false): number | null {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    const c = Math.min(hi, Math.max(lo, n));
    return integer ? Math.round(c) : Math.round(c * 100) / 100;
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as T) : fallback);

function cleanBox(v: unknown): CellBox | null {
    if (!isRecord(v)) return null;
    const take = (t: unknown): [number, number, number] | null => {
        if (!Array.isArray(t) || t.length !== 3) return null;
        const o = t.map((x) => num(x, 0, 9, true));
        return o.every((x) => x !== null) ? ([o[0], o[1], o[2]] as [number, number, number]) : null;
    };
    const a = take(v.min);
    const b = take(v.max);
    if (!a || !b) return null;
    return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
}

/** Names compare by their letters and digits of any script, ignoring case, accents and spacing ("Ñandú" is "nandu", "座椅" stays itself). */
const normName = (s: string): string => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A name has to be this long before it may stand for a part by being part of another name ("a" must not find every part with an "a"). */
const MIN_LOOSE_NAME = 3;

/**
 * The part for what the model wrote, and whether it was the same name: the same text ignoring case, accents and spacing (`exact`), else the
 * only part that contains it or is contained in it (a guess). Names with no letter or digit match nothing, and a name under three
 * characters never matches by being part of another.
 */
export function findPart(name: string, parts: readonly string[]): { part: string; exact: boolean } | null {
    const want = normName(name);
    if (!want) return null;
    const exact = parts.filter((p) => normName(p) === want);
    if (exact.length === 1) return { part: exact[0], exact: true };
    const loose = parts.filter((p) => {
        const have = normName(p);
        if (!have) return false;
        return (want.length >= MIN_LOOSE_NAME && have.includes(want)) || (have.length >= MIN_LOOSE_NAME && want.includes(have));
    });
    return loose.length === 1 ? { part: loose[0], exact: false } : null;
}

/** The exact part name for what the model wrote (see findPart), else null. */
export const matchPart = (name: string, parts: readonly string[]): string | null => findPart(name, parts)?.part ?? null;

/** What repairSpec needs to know about the model: the names of its parts and its size. The Worker has both from the brief it was sent. */
export interface RepairContext {
    partNames: readonly string[];
    blocks: number;
}

export const repairContextOfBrief = (brief: Brief): RepairContext => ({ partNames: brief.parts.map((p) => p.name), blocks: brief.blocks });

export interface Repaired {
    spec: OptimizationSpec;
    /** What the cleaning changed or dropped, in plain words (shown under the controls). */
    changes: string[];
}

/** An untrusted answer (or an edited spec) -> a valid OptimizationSpec. Never throws; an unusable answer gives the "lightest stable" preset. */
export function repairSpec(raw: unknown, ctx: RepairContext): Repaired {
    const changes: string[] = [];
    if (!isRecord(raw)) return { spec: presetSpec("lightest", { blocks: ctx.blocks }), changes: ["The answer could not be read, so the Lightest goal was used."] };

    const merged = new Map<MetricKey, number>();
    if (Array.isArray(raw.objective)) {
        for (const t of raw.objective) {
            if (!isRecord(t)) continue;
            const metric = typeof t.metric === "string" ? (t.metric.trim().toLowerCase().replace(/[\s-]+/g, "_") as MetricKey) : null;
            const w = num(t.weight, 0, 1000);
            if (metric && METRIC_KEYS.includes(metric) && w !== null && w > 0) merged.set(metric, (merged.get(metric) ?? 0) + w);
            else changes.push("An aim that is not one of the four was dropped.");
        }
    }
    let objective = [...merged].map(([metric, weight]) => ({ metric, weight })).slice(0, SPEC_LIMITS.terms);
    if (objective.length === 0) {
        objective = [{ metric: "blocks", weight: 1 }];
        changes.push("No usable aim, so the aim is fewer blocks.");
    }
    const total = objective.reduce((s, t) => s + t.weight, 0);
    objective = objective.map((t) => ({ metric: t.metric, weight: Math.round((t.weight / total) * 1000) / 1000 }));

    const mv = isRecord(raw.moves) ? raw.moves : {};
    const allow = oneOf<MoveAllow>(mv.allow, ["remove", "add", "both"], "remove");
    const removable = oneOf<Removable>(mv.removable, ["added", "inner", "any"], "inner");

    const c = isRecord(raw.constraints) ? raw.constraints : {};
    const constraints: OptimizationSpec["constraints"] = {
        max_stress_pct: num(c.max_stress_pct, ...SPEC_LIMITS.stressPct),
        min_cog_margin_mm: num(c.min_cog_margin_mm, ...SPEC_LIMITS.cogMarginMm),
        max_cantilever_blocks: num(c.max_cantilever_blocks, ...SPEC_LIMITS.cantileverBlocks, true),
        max_blocks: num(c.max_blocks, ...SPEC_LIMITS.blocks, true),
        max_added_blocks: num(c.max_added_blocks, ...SPEC_LIMITS.addedBlocks, true),
        min_blocks_pct: num(c.min_blocks_pct, ...SPEC_LIMITS.minBlocksPct),
        max_deflection_pct: num(c.max_deflection_pct, ...SPEC_LIMITS.deflectionPct),
        keep_one_piece: c.keep_one_piece === false ? false : true,
        symmetry: oneOf<Symmetry>(c.symmetry, ["none", "x", "y", "xy"], "none"),
    };

    const names = ctx.partNames;
    const regions: ProtectedRegion[] = [];
    if (Array.isArray(raw.protected)) {
        for (const r of raw.protected.slice(0, SPEC_LIMITS.regions)) {
            if (!isRecord(r)) continue;
            const mode = oneOf<ProtectMode>(r.mode, ["keep", "clear", "only"], "keep");
            const partRaw = text(r.part, SPEC_LIMITS.partName);
            const box = cleanBox(r.box);
            if (partRaw) {
                const found = findPart(partRaw, names);
                if (found) {
                    regions.push({ mode, part: found.part, box: null });
                    // A guess is said out loud: the chip shows the real part, and the person should know it was not the name they used.
                    if (!found.exact) changes.push(`"${partRaw}" was read as the part "${found.part}".`);
                } else if (box) regions.push({ mode, part: null, box });
                else changes.push(`There is no part called "${partRaw}" in this model, so that protection was dropped.`);
            } else if (box) regions.push({ mode, part: null, box });
        }
    }

    const reduce = isRecord(raw.stop) ? num(raw.stop.reduce_blocks_by_pct, ...SPEC_LIMITS.reducePct) : null;
    const notes = (Array.isArray(raw.notes) ? raw.notes : []).map((n) => text(n, SPEC_LIMITS.note)).filter(Boolean).slice(0, SPEC_LIMITS.notes);

    const spec: OptimizationSpec = {
        actionable: raw.actionable === false ? false : true,
        title: text(raw.title, SPEC_LIMITS.title) || "Custom goal",
        summary: text(raw.summary, SPEC_LIMITS.summary) || "Work towards the goal you described.",
        objective,
        moves: { allow, removable },
        constraints,
        protected: regions,
        stop: { reduce_blocks_by_pct: reduce },
        notes,
    };
    return { spec, changes };
}

// ---------- the chips ----------

export type PresetKind = "lightest" | "most-stable" | "strongest" | "stiffest";

/** Four goals that need no model; the chips of the tab and the fallback when Muse Spark is unavailable. */
export function presetSpec(kind: PresetKind, ctx: { blocks: number }): OptimizationSpec {
    const base = (): OptimizationSpec["constraints"] => ({ max_stress_pct: null, min_cog_margin_mm: null, max_cantilever_blocks: null, max_blocks: null, max_added_blocks: null, min_blocks_pct: null, max_deflection_pct: null, keep_one_piece: true, symmetry: "none" });
    const extra = Math.max(5, Math.min(40, Math.round(ctx.blocks * 0.1)));
    switch (kind) {
        case "lightest":
            return { actionable: true, title: "Lightest stable", summary: "Take out as many blocks as possible without changing the outside shape or breaking a stability check.", objective: [{ metric: "blocks", weight: 1 }], moves: { allow: "remove", removable: "inner" }, constraints: base(), protected: [], stop: { reduce_blocks_by_pct: null }, notes: [] };
        case "most-stable":
            return { actionable: true, title: `Most stable, +${extra} blocks`, summary: `Use up to ${extra} extra blocks where they widen the base and relieve the most stressed joints.`, objective: [{ metric: "cog_margin", weight: 0.5 }, { metric: "peak_stress", weight: 0.5 }], moves: { allow: "both", removable: "inner" }, constraints: { ...base(), max_added_blocks: extra }, protected: [], stop: { reduce_blocks_by_pct: null }, notes: [] };
        case "strongest":
            return { actionable: true, title: "Lowest joint stress", summary: "Bring the peak joint stress down as far as a few extra blocks can.", objective: [{ metric: "peak_stress", weight: 1 }], moves: { allow: "both", removable: "inner" }, constraints: { ...base(), max_added_blocks: extra }, protected: [], stop: { reduce_blocks_by_pct: null }, notes: [] };
        case "stiffest":
            return { actionable: true, title: "Stiffest", summary: "Make it sag and sway as little as possible with a few extra blocks.", objective: [{ metric: "deflection", weight: 1 }], moves: { allow: "both", removable: "inner" }, constraints: { ...base(), max_added_blocks: extra }, protected: [], stop: { reduce_blocks_by_pct: null }, notes: [] };
    }
}
