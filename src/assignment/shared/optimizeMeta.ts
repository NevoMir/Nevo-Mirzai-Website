// M0 SKELETON (foundation commit): the prototype's optimizeMeta.ts with the renames of spec 2.3 (depth -> stabilized_depth; shape_changed, parts,
// labels, goal added) and the frozen functions of 7.4 (crossCheckOptimized with its source argument, summarizeOptimize). Owner D owns this file
// from M1 and keeps the exported names and shapes. Differences from the prototype that D must keep or consciously change:
//   - OptimizeMeta.goal (the person's words or the chip's label, 1 to 300): OptimizeSummary.goal needs it and summarizeOptimize only gets the meta.
//   - crossCheckOptimized(d, m, source): `source.assembly_hash` is the CELL hash (assemblyHash of the cells) of a block version and must be null for
//     a source of mesh representation (generated, example, edited design/mesh: their models.assembly_hash is not a block hash). The caller passes that.
//
// What an optimized model records about how it was made, and the validation of it.
//
// It arrives inside an uploaded GLB (scenes[0].extras["nevo:optimization"]) from a browser nobody vouches for and it is read back from D1
// (models.meta, as the slim OptimizeSummary), so, exactly like shared/derivedMeta.ts, every field is checked and the object is rebuilt field by
// field: unknown keys are dropped, sizes are bounded, and the stored JSON stays under OPTIMIZE_META_LIMIT. The claims about stress are the client's
// (the Stability tab recomputes the verdict from the geometry every time it opens); counts of blocks are not: crossCheckOptimized ties them to the cells.

import { checkAnalysisSummary, fail, finite, integer, type Result } from "./analysisSummary.ts";
import { BLOCK_ROLES, MATERIAL_IDS, MAX_DERIVED_DEPTH, type AnalysisSummary, type MaterialId, type ModelKind, type OptimizeSummary } from "./contract.ts";
import { CELL_STRIDE, type AssemblyDescriptor } from "./assembly.ts";
import { repairSpec, type OptimizationSpec } from "./optimizeSpec.ts";

export const OPTIMIZE_META_LIMIT = 32 * 1024;
export const OPTIMIZE_HISTORY_ROWS = 120;
export const OPTIMIZER_VERSION = "1.0.0";

export const STOP_REASONS = ["converged", "target-reached", "budget-used", "max-iterations", "max-solves", "time-budget", "canceled", "infeasible"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** The figures of one side of the comparison, taken from the engine itself (the same numbers the Stability tab shows for that version). */
export interface OptimizeMetrics {
    blocks: number;
    weight_kg: number;
    errors: number;
    warnings: number;
    floating_blocks: number;
    over_limit: number;
    longest_cantilever: number;
    cog_margin_mm: number | null;
    max_utilisation: number | null;
    /** Largest displacement of a block centre under self-weight, micrometres. */
    max_deflection_um: number | null;
}

/** One row of the convergence chart, compact on purpose (up to 120 are saved with the model). Columns: HISTORY_COLUMNS. */
export type HistoryRow = [iteration: number, blocks: number, utilisation: number, cogMarginMm: number, deflectionUm: number, objective: number, removed: number, added: number, solves: number];
export const HISTORY_COLUMNS = ["iteration", "blocks", "utilisation", "cog_margin_mm", "deflection_um", "objective", "removed", "added", "solves"] as const;

/** Everything an optimized model records about how it was made (GLB scenes[0].extras["nevo:optimization"]; models.meta.optimized). */
export interface OptimizeMeta {
    version: 1;
    optimizer: string;
    solver: "awatif-wasm" | "awatif-ts";
    material: MaterialId;
    /** The spec that was run (as the user confirmed it). */
    spec: OptimizationSpec;
    /** assemblyHash of the version it was made from; null when it was made from an original mesh (no assembly). */
    source_hash: string | null;
    /** Stabilizations on the path from the root to the version this was made from (0 for a mesh): an optimization does not add one. */
    stabilized_depth: number;
    /** The person's words, or the label of the chip they clicked (1 to 300). */
    goal: string;
    /** True iff a visible-surface block of the source was removed (never under removable "added" or "inner"). */
    shape_changed: boolean;
    /** Names of the parts the labels refer to ('A' = parts[0]); at most 26. Inherited by cell from the source. */
    parts: string[];
    /** One character per block in canonical order: 'A'-'Z' = part, '.' = none. Length = number of blocks. */
    labels: string;
    /** The step number the blocks it added carry in the descriptor (0 when it added none). */
    step: number;
    /** Cell codes (k * 100 + j * 10 + i) of the source's blocks that are gone, ascending. */
    removed: number[];
    /** The iteration that took out each of `removed` (same order); the replay slider steps through these. */
    removed_at: number[];
    added: number;
    /** The iteration that put in each added block, in the descriptor's order (ascending cell). */
    added_at: number[];
    stop: StopReason;
    /** Every constraint holds in the result. A result that is not feasible is never saved. */
    feasible: boolean;
    before: OptimizeMetrics;
    after: OptimizeMetrics;
    history: HistoryRow[];
    solves: number;
    duration_ms: number;
    assembly_hash: string;
    after_summary: AnalysisSummary;
    created_at: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_PARTS = 26;
const MAX_PART_NAME = 40;
const SOLVERS = ["awatif-wasm", "awatif-ts"] as const;
const integerM = (value: unknown, field: string, min: number, max: number): Result<number> => integer(value, field, min, max, "meta");
const finiteM = (value: unknown, field: string, min: number, max: number): Result<number> => finite(value, field, min, max, "meta");

function metrics(value: unknown, field: string): Result<OptimizeMetrics> {
    if (!isRecord(value)) return fail(`meta.${field} must be an object`);
    const ints: Record<string, number> = {};
    for (const [key, max] of [["blocks", 1000], ["errors", 1000], ["warnings", 1000], ["floating_blocks", 1000], ["over_limit", 1000], ["longest_cantilever", 1000]] as const) {
        const r = integerM(value[key], `${field}.${key}`, 0, max);
        if (!r.ok) return r;
        ints[key] = r.value;
    }
    const weight = finiteM(value.weight_kg, `${field}.weight_kg`, 0, 100_000);
    if (!weight.ok) return weight;
    const optional = (key: string, lo: number, hi: number): Result<number | null> => {
        if (value[key] === null) return { ok: true, value: null };
        return finiteM(value[key], `${field}.${key}`, lo, hi);
    };
    const margin = optional("cog_margin_mm", -2000, 2000);
    if (!margin.ok) return margin;
    const util = optional("max_utilisation", 0, 50);
    if (!util.ok) return util;
    const defl = optional("max_deflection_um", 0, 1e9);
    if (!defl.ok) return defl;
    return {
        ok: true,
        value: {
            blocks: ints.blocks,
            weight_kg: weight.value,
            errors: ints.errors,
            warnings: ints.warnings,
            floating_blocks: ints.floating_blocks,
            over_limit: ints.over_limit,
            longest_cantilever: ints.longest_cantilever,
            cog_margin_mm: margin.value,
            max_utilisation: util.value,
            max_deflection_um: defl.value,
        },
    };
}

function ascendingInts(value: unknown, field: string, max: number): Result<number[]> {
    if (!Array.isArray(value) || value.length > 1000) return fail(`meta.${field} must be a list of at most 1000 numbers`);
    let previous = -1;
    for (const x of value) {
        if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > max || x <= previous) return fail(`meta.${field} must be strictly ascending whole numbers from 0 to ${max}`);
        previous = x;
    }
    return { ok: true, value: value as number[] };
}

function iterations(value: unknown, field: string, length: number): Result<number[]> {
    if (!Array.isArray(value) || value.length !== length) return fail(`meta.${field} must have ${length} entries`);
    for (const x of value) if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 1000) return fail(`meta.${field} must be iteration numbers from 1 to 1000`);
    return { ok: true, value: value as number[] };
}

/** Checks untrusted OptimizeMeta and rebuilds it. `now` caps `created_at` as for AnalysisSummary (null: keep as is). */
export function checkOptimizeMeta(value: unknown, now: number | null): Result<OptimizeMeta> {
    if (!isRecord(value)) return fail("meta must be an object");
    if (value.version !== 1) return fail("meta.version must be 1");
    if (typeof value.optimizer !== "string" || value.optimizer.length === 0 || value.optimizer.length > 16) return fail("meta.optimizer must be 1 to 16 characters");
    if (!(SOLVERS as readonly unknown[]).includes(value.solver)) return fail("meta.solver must be awatif-wasm or awatif-ts");
    if (!(MATERIAL_IDS as readonly unknown[]).includes(value.material)) return fail("meta.material is not a known material");
    if (!isRecord(value.spec)) return fail("meta.spec must be an object");
    // The spec is rebuilt by the same cleaner the page uses; the part names in it are taken as they are (the server has no mesh to check them against).
    const names = Array.isArray(value.spec.protected) ? value.spec.protected.map((r) => (isRecord(r) && typeof r.part === "string" ? r.part : "")).filter(Boolean) : [];
    const spec = repairSpec(value.spec, { partNames: names, blocks: 1000 }).spec;
    let sourceHash: string | null = null;
    if (value.source_hash !== null) {
        if (typeof value.source_hash !== "string" || !HEX64.test(value.source_hash)) return fail("meta.source_hash must be a SHA-256 hex string or null");
        sourceHash = value.source_hash;
    }
    const stabilized = integerM(value.stabilized_depth, "stabilized_depth", 0, MAX_DERIVED_DEPTH);
    if (!stabilized.ok) return stabilized;
    if (typeof value.goal !== "string" || value.goal.length < 1 || value.goal.length > 300 || CONTROL.test(value.goal)) return fail("meta.goal must be 1 to 300 characters without control characters");
    if (typeof value.shape_changed !== "boolean") return fail("meta.shape_changed must be true or false");
    if (!Array.isArray(value.parts) || value.parts.length > MAX_PARTS) return fail(`meta.parts must be a list of at most ${MAX_PARTS} names`);
    const parts: string[] = [];
    for (const name of value.parts as unknown[]) {
        if (typeof name !== "string" || name.length < 1 || name.length > MAX_PART_NAME || CONTROL.test(name)) return fail(`meta.parts must be names of 1 to ${MAX_PART_NAME} characters`);
        parts.push(name);
    }
    if (typeof value.labels !== "string" || value.labels.length > 1000 || !/^[A-Z.]*$/.test(value.labels)) return fail("meta.labels must be A-Z or '.' only, at most 1000 characters");
    for (const ch of value.labels) if (ch !== "." && ch.charCodeAt(0) - 65 >= parts.length) return fail("meta.labels uses a part that is not in meta.parts");
    const step = integerM(value.step, "step", 0, 255);
    if (!step.ok) return step;
    const removed = ascendingInts(value.removed, "removed", 999);
    if (!removed.ok) return removed;
    const removedAt = iterations(value.removed_at, "removed_at", removed.value.length);
    if (!removedAt.ok) return removedAt;
    const added = integerM(value.added, "added", 0, 1000);
    if (!added.ok) return added;
    const addedAt = iterations(value.added_at, "added_at", added.value);
    if (!addedAt.ok) return addedAt;
    if ((added.value > 0) !== (step.value > 0)) return fail("meta.step must be 0 exactly when nothing was added");
    if (!(STOP_REASONS as readonly unknown[]).includes(value.stop)) return fail("meta.stop is not a known stop reason");
    if (value.feasible !== true) return fail("meta.feasible must be true: a result that breaks a constraint is not saved");
    const before = metrics(value.before, "before");
    if (!before.ok) return before;
    const after = metrics(value.after, "after");
    if (!after.ok) return after;
    if (after.value.blocks !== before.value.blocks - removed.value.length + added.value) return fail("meta.after.blocks must be before.blocks - removed + added");
    if (after.value.blocks !== value.labels.length) return fail("meta.labels must have one character per block");

    if (!Array.isArray(value.history) || value.history.length > OPTIMIZE_HISTORY_ROWS) return fail(`meta.history must be a list of at most ${OPTIMIZE_HISTORY_ROWS} rows`);
    const history: HistoryRow[] = [];
    for (const row of value.history) {
        if (!Array.isArray(row) || row.length !== HISTORY_COLUMNS.length || !row.every((x) => typeof x === "number" && Number.isFinite(x))) return fail("meta.history rows must be nine numbers");
        const [iteration, blocks] = row as number[];
        if (!Number.isInteger(iteration) || iteration < 0 || iteration > 1000 || !Number.isInteger(blocks) || blocks < 0 || blocks > 1000) return fail("meta.history rows have a bad iteration or block count");
        history.push([...(row as number[])] as HistoryRow);
    }
    const solves = integerM(value.solves, "solves", 0, 100_000);
    if (!solves.ok) return solves;
    const duration = finiteM(value.duration_ms, "duration_ms", 0, 3_600_000);
    if (!duration.ok) return duration;
    if (typeof value.assembly_hash !== "string" || !HEX64.test(value.assembly_hash)) return fail("meta.assembly_hash must be a SHA-256 hex string");
    const summary = checkAnalysisSummary(value.after_summary, now);
    if (!summary.ok) return fail(`meta.after_summary: ${summary.error}`);
    const stamp = checkAnalysisSummary({ ...summary.value, analyzed_at: value.created_at }, now);
    if (!stamp.ok) return fail("meta.created_at must be an ISO-8601 date");

    const meta: OptimizeMeta = {
        version: 1,
        optimizer: value.optimizer,
        solver: value.solver as OptimizeMeta["solver"],
        material: value.material as MaterialId,
        spec,
        source_hash: sourceHash,
        stabilized_depth: stabilized.value,
        goal: value.goal,
        shape_changed: value.shape_changed,
        parts,
        labels: value.labels,
        step: step.value,
        removed: removed.value,
        removed_at: removedAt.value,
        added: added.value,
        added_at: addedAt.value,
        stop: value.stop as StopReason,
        feasible: true,
        before: before.value,
        after: after.value,
        history,
        solves: solves.value,
        duration_ms: duration.value,
        assembly_hash: value.assembly_hash,
        after_summary: summary.value,
        created_at: stamp.value.analyzed_at,
    };
    if (JSON.stringify(meta).length > OPTIMIZE_META_LIMIT) return fail(`meta is larger than ${OPTIMIZE_META_LIMIT} bytes`);
    return { ok: true, value: meta };
}

/** Stored or embedded meta, or null when it is missing or unusable. */
export function readOptimizeMeta(raw: unknown): OptimizeMeta | null {
    try {
        const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        const result = checkOptimizeMeta(value, null);
        return result.ok ? result.value : null;
    } catch {
        return null;
    }
}

/**
 * An error message when the log disagrees with the blocks, else null (one pass over the cells; the Worker runs it on upload next to
 * assemblyHash, with no source GLB). `added` blocks are the ones with the log's step, and they are reinforcement; the removed cells are not in
 * the file. `source.assembly_hash` is the cell hash of a block version, null for a source of mesh representation (see the header).
 */
export function crossCheckOptimized(descriptor: Pick<AssemblyDescriptor, "cells">, meta: OptimizeMeta, source: { kind: ModelKind; assembly_hash: string | null }): string | null {
    const cells = descriptor.cells;
    const blocks = cells.length / CELL_STRIDE;
    if (!meta.feasible) return "A result that breaks a limit cannot be saved.";
    if (meta.after.blocks !== blocks) return `The log counts ${meta.after.blocks} blocks, the file has ${blocks}.`;
    if (meta.after_summary.blocks !== blocks) return `The analysis in the log counts ${meta.after_summary.blocks} blocks, the file has ${blocks}.`;
    if (meta.labels.length !== blocks) return "The log has a label for every block but not for the blocks in the file.";
    if (meta.after.blocks !== meta.before.blocks - meta.removed.length + meta.added) return "The log's counts do not add up: before - removed + added is not the number of blocks.";
    if (source.assembly_hash === null ? meta.source_hash !== null : meta.source_hash !== source.assembly_hash) {
        return "The log was made from a different model than the one it is saved on.";
    }
    const present = new Set<number>();
    let added = 0;
    const reinforcement = BLOCK_ROLES.indexOf("reinforcement");
    for (let n = 0; n < cells.length; n += CELL_STRIDE) {
        const code = cells[n + 2] * 100 + cells[n + 1] * 10 + cells[n];
        present.add(code);
        if (meta.step > 0 && cells[n + 4] === meta.step) {
            if (cells[n + 3] !== reinforcement) return "A block the optimizer added is not a reinforcement block.";
            added++;
        }
    }
    if (added !== meta.added) return `The log says ${meta.added} blocks were added, the file has ${added}.`;
    for (const code of meta.removed) if (present.has(code)) return "A block the log says was removed is in the file.";
    return null;
}

/** The OptimizeSummary the server stores in models.meta for a validated log (at most OPTIMIZE_SUMMARY_LIMIT). */
export function summarizeOptimize(meta: OptimizeMeta): OptimizeSummary {
    return {
        version: 1,
        title: meta.spec.title.slice(0, 48),
        goal: meta.goal.slice(0, 300),
        objective: meta.spec.objective.map((t) => t.metric),
        stop: meta.stop,
        shape_changed: meta.shape_changed,
        stabilized_depth: meta.stabilized_depth,
        removed: meta.removed.length,
        added: meta.added,
        before: meta.before,
        after: meta.after,
        iterations: meta.history.length > 0 ? meta.history[meta.history.length - 1][0] : 0,
        solves: meta.solves,
        duration_ms: Math.round(meta.duration_ms),
        solver: meta.solver,
        material: meta.material,
        created_at: meta.created_at,
    };
}
