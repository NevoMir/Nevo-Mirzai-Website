// Reading what a version row records (models.meta) and the two facts the server derives from it: how many stabilizations lie on the path
// from the root to the row, and whether the row is a mesh or a block assembly. Pure TypeScript with no DOM, shared by the Worker, the browser
// and the Node scripts.
//
// models.meta holds, by kind: DerivedMeta (stabilized), EditMeta (edited) or OptimizeSummary (optimized). The server writes it from a
// validated upload and is the only writer, so a read checks the shape and rebuilds the object field by field (bounded, so a damaged row
// cannot crash a page) but does not re-run the upload validation: this is the read path of every project (up to MAX_VERSIONS_PER_PROJECT rows).

import {
    MAX_DERIVED_DEPTH,
    MAX_VERSION_DEPTH,
    type EditChanges,
    type EditEntry,
    type EditMeta,
    type EditTarget,
    type MeshOpName,
    type ModelKind,
    type OptimizeMetricKey,
    type OptimizeSummary,
} from "./contract.ts";
import { readDerivedMeta } from "./derivedMeta.ts";
import type { OptimizeMetrics } from "./optimizeMeta.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Stored JSON text or an already parsed value -> the value, or undefined when it does not parse. */
function parsed(raw: unknown): unknown {
    if (typeof raw !== "string") return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);
/**
 * Display text (a label, a sentence): clipped to `max` characters instead of refused. The Worker is the only writer of these rows and keeps its own
 * bounds, so an over-long value is a writer's slip; losing the whole record for it would hide the version's name and its edit from the page.
 */
const text = (value: unknown, max: number): string | null => (typeof value === "string" ? (value.length <= max ? value : value.slice(0, max)) : null);
const int = (value: unknown, min: number, max: number): number | null => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const EDIT_TARGETS: readonly EditTarget[] = ["design", "mesh", "voxel"];
const MESH_OPS: readonly MeshOpName[] = ["stretch", "move", "scale", "rotate", "delete", "recolor", "add_parts", "mirror_copy"];
const STOPS: readonly OptimizeSummary["stop"][] = ["converged", "target-reached", "budget-used", "max-iterations", "max-solves", "time-budget", "canceled", "infeasible"];
const METRIC_KEYS: readonly OptimizeMetricKey[] = ["blocks", "peak_stress", "cog_margin", "deflection"];

function names(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const v of value.slice(0, 60)) {
        const s = text(v, 80);
        if (s === null) return null;
        out.push(s);
    }
    return out;
}

function changesOf(value: unknown): EditChanges | null | undefined {
    if (value === null) return null;
    if (!isRecord(value)) return undefined;
    const added = names(value.added);
    const changed = names(value.changed);
    const removed = names(value.removed);
    return added && changed && removed ? { added, changed, removed } : undefined;
}

function entryOf(value: unknown): EditEntry | null {
    if (!isRecord(value)) return null;
    const n = int(value.n, 1, 12);
    const instruction = text(value.instruction, 500);
    const summary = text(value.summary, 300);
    const added = int(value.added, 0, 1000);
    const removed = int(value.removed, 0, 1000);
    const moved = int(value.moved, 0, 1000);
    if (n === null || instruction === null || summary === null || added === null || removed === null || moved === null) return null;
    return { n, instruction, summary, added, removed, moved };
}

/** A stored or embedded EditMeta, or null when it is missing or unusable. */
export function readEditMeta(raw: unknown): EditMeta | null {
    const v = parsed(raw);
    if (!isRecord(v) || v.version !== 1) return null;
    const target = typeof v.target === "string" && (EDIT_TARGETS as readonly string[]).includes(v.target) ? (v.target as EditTarget) : null;
    const depth = int(v.depth, 1, MAX_VERSION_DEPTH);
    const label = text(v.label, 80);
    const summary = text(v.summary, 400);
    const engine = text(v.engine, 80);
    const stabilized = int(v.stabilized_depth, 0, MAX_DERIVED_DEPTH);
    const baseSteps = int(v.base_steps, 0, 255);
    const createdAt = str(v.created_at, 40);
    const jobId = v.job_id === null ? null : str(v.job_id, 64);
    const changes = changesOf(v.changes);
    if (target === null || depth === null || label === null || summary === null || engine === null || stabilized === null || baseSteps === null || createdAt === null) return null;
    if (v.job_id !== null && jobId === null) return null;
    if (changes === undefined || !Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > 12) return null;
    const entries: EditEntry[] = [];
    for (const e of v.entries) {
        const entry = entryOf(e);
        if (!entry) return null;
        entries.push(entry);
    }
    let ops: EditMeta["ops"] = null;
    if (v.ops !== null) {
        if (!Array.isArray(v.ops)) return null;
        ops = [];
        for (const o of v.ops.slice(0, 12)) {
            const name = isRecord(o) && typeof o.op === "string" && (MESH_OPS as readonly string[]).includes(o.op) ? (o.op as MeshOpName) : null;
            const opLabel = isRecord(o) ? text(o.label, 80) : null;
            if (name === null || opLabel === null) return null;
            ops.push({ op: name, label: opLabel });
        }
    }
    const notes = Array.isArray(v.notes) ? v.notes.slice(0, 8).map((n) => text(n, 200)) : null;
    if (notes === null || notes.some((n) => n === null)) return null;
    return {
        version: 1,
        target,
        depth,
        label,
        summary,
        entries,
        engine,
        changes,
        ops,
        notes: notes as string[],
        stabilized_depth: stabilized,
        base_steps: baseSteps,
        job_id: jobId,
        created_at: createdAt,
    };
}

function metricsOf(value: unknown): OptimizeMetrics | null {
    if (!isRecord(value)) return null;
    const blocks = int(value.blocks, 0, 1000);
    const weight = num(value.weight_kg);
    const errors = int(value.errors, 0, 1000);
    const warnings = int(value.warnings, 0, 1000);
    const floating = int(value.floating_blocks, 0, 1000);
    const over = int(value.over_limit, 0, 1000);
    const longest = int(value.longest_cantilever, 0, 1000);
    const nullable = (x: unknown): number | null | undefined => (x === null ? null : (num(x) ?? undefined));
    const margin = nullable(value.cog_margin_mm);
    const util = nullable(value.max_utilisation);
    const defl = nullable(value.max_deflection_um);
    if (blocks === null || weight === null || errors === null || warnings === null || floating === null || over === null || longest === null) return null;
    if (margin === undefined || util === undefined || defl === undefined) return null;
    return {
        blocks,
        weight_kg: weight,
        errors,
        warnings,
        floating_blocks: floating,
        over_limit: over,
        longest_cantilever: longest,
        cog_margin_mm: margin,
        max_utilisation: util,
        max_deflection_um: defl,
    };
}

/** A stored or embedded OptimizeSummary, or null when it is missing or unusable. */
export function readOptimizeSummary(raw: unknown): OptimizeSummary | null {
    const v = parsed(raw);
    if (!isRecord(v) || v.version !== 1) return null;
    const title = text(v.title, 80);
    const goal = text(v.goal, 400);
    const stop = typeof v.stop === "string" && (STOPS as readonly string[]).includes(v.stop) ? (v.stop as OptimizeSummary["stop"]) : null;
    const stabilized = int(v.stabilized_depth, 0, MAX_DERIVED_DEPTH);
    const removed = int(v.removed, 0, 1000);
    const added = int(v.added, 0, 1000);
    const iterations = int(v.iterations, 0, 100_000);
    const solves = int(v.solves, 0, 1_000_000);
    const duration = num(v.duration_ms);
    const solver = v.solver === "awatif-wasm" || v.solver === "awatif-ts" ? v.solver : null;
    const material = v.material === "concrete" || v.material === "timber" ? v.material : null;
    const createdAt = str(v.created_at, 40);
    const before = metricsOf(v.before);
    const after = metricsOf(v.after);
    if (title === null || goal === null || stop === null || stabilized === null || removed === null || added === null || iterations === null || solves === null) return null;
    if (duration === null || solver === null || material === null || createdAt === null || before === null || after === null || typeof v.shape_changed !== "boolean") return null;
    if (!Array.isArray(v.objective) || v.objective.length < 1 || v.objective.length > 3 || !v.objective.every((k) => (METRIC_KEYS as readonly unknown[]).includes(k))) return null;
    return {
        version: 1,
        title,
        goal,
        objective: [...(v.objective as OptimizeMetricKey[])],
        stop,
        shape_changed: v.shape_changed,
        stabilized_depth: stabilized,
        removed,
        added,
        before,
        after,
        iterations,
        solves,
        duration_ms: duration,
        solver,
        material,
        created_at: createdAt,
    };
}

/**
 * Stabilizations on the path from the root to this row: the DerivedMeta.depth of a stabilized row, EditMeta.stabilized_depth of an edited
 * one, OptimizeSummary.stabilized_depth of an optimized one, 0 for a root. A row whose meta cannot be read counts as the maximum (the
 * conservative answer: it can then not be stabilized again).
 */
export function stabilizationsOf(row: { kind: ModelKind; meta: unknown }): number {
    switch (row.kind) {
        case "stabilized":
            return readDerivedMeta(row.meta)?.depth ?? MAX_DERIVED_DEPTH;
        case "edited":
            return readEditMeta(row.meta)?.stabilized_depth ?? MAX_DERIVED_DEPTH;
        case "optimized":
            return readOptimizeSummary(row.meta)?.stabilized_depth ?? MAX_DERIVED_DEPTH;
        default:
            return 0;
    }
}

/**
 * What the row's GLB is: a "mesh" (generated, example, and an edit of a parts design or a mesh) or a "blocks" assembly (stabilized,
 * optimized, and an edit of blocks). The stabilizer's first run applies exactly to the mesh representation (D14): its source has no steps.
 */
export function representationOf(row: { kind: ModelKind; meta: unknown }): "mesh" | "blocks" {
    switch (row.kind) {
        case "stabilized":
        case "optimized":
            return "blocks";
        case "edited":
            return readEditMeta(row.meta)?.target === "voxel" ? "blocks" : "mesh";
        default:
            return "mesh";
    }
}
