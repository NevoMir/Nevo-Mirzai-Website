// Validation of DerivedMeta: what a stabilized model records about how it was made. It arrives inside an uploaded GLB
// (scenes[0].extras["nevo:stabilization"]) from a browser nobody vouches for, and it is read back from D1 (models.meta),
// so every field is checked and the object is rebuilt field by field: unknown keys are dropped, sizes are bounded,
// and the stored JSON stays under DERIVED_META_LIMIT.

import {
    BLOCK_ROLES,
    DERIVED_META_LIMIT,
    MATERIAL_IDS,
    MAX_DERIVED_DEPTH,
    MAX_STABILIZE_STEPS,
    type AddedRole,
    type DerivedMeta,
    type MaterialId,
    type StabilizationMetrics,
    type StabilizeReason,
    type StabilizeStepLog,
    type StabilizeStop,
    type StepMetrics,
} from "./contract.ts";
import { checkAnalysisSummary, fail, finite as finiteIn, integer as integerIn, type Result } from "./analysisSummary.ts";

// The shared helpers name their field "summary.<field>"; here the object is "meta".
const integer = (value: unknown, field: string, min: number, max: number): Result<number> => integerIn(value, field, min, max, "meta");
const finite = (value: unknown, field: string, min: number, max: number): Result<number> => finiteIn(value, field, min, max, "meta");

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const REASONS: readonly StabilizeReason[] = ["floating", "cantilever", "cog", "stress"];
const STOPS: readonly StabilizeStop[] = ["stable", "no-improving-move", "max-steps", "max-blocks", "time-budget", "canceled"];
const ADDED_ROLES: readonly AddedRole[] = BLOCK_ROLES.filter((r): r is AddedRole => r !== "original" && r !== "user");
const SOLVERS = ["awatif-wasm", "awatif-ts"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_TEXT = 300;
const MAX_UTIL = 50;

const text = (value: unknown, field: string, max: number): Result<string> => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) return fail(`meta.${field} must be 1 to ${max} characters`);
    // No control characters: the text is shown in the page and exported into reports.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) return fail(`meta.${field} has control characters`);
    return { ok: true, value };
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): Result<T> {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) return fail(`meta.${field} must be one of ${allowed.join(", ")}`);
    return { ok: true, value: value as T };
}

function stepMetrics(value: unknown, field: string): Result<StepMetrics> {
    if (!isRecord(value)) return fail(`meta.${field} must be an object`);
    const blocks = integer(value.blocks, `${field}.blocks`, 0, 1000);
    const errors = integer(value.errors, `${field}.errors`, 0, 1000);
    const floating = integer(value.floating_blocks, `${field}.floating_blocks`, 0, 1000);
    const over = integer(value.over_limit, `${field}.over_limit`, 0, 1000);
    const longest = integer(value.longest_cantilever, `${field}.longest_cantilever`, 0, 1000);
    for (const r of [blocks, errors, floating, over, longest]) if (!r.ok) return r;
    let margin: number | null = null;
    if (value.cog_margin_mm !== null) {
        const m = finite(value.cog_margin_mm, `${field}.cog_margin_mm`, -2000, 2000);
        if (!m.ok) return m;
        margin = m.value;
    }
    let util: number | null = null;
    if (value.max_utilisation !== null) {
        const u = finite(value.max_utilisation, `${field}.max_utilisation`, 0, MAX_UTIL);
        if (!u.ok) return u;
        util = u.value;
    }
    return {
        ok: true,
        value: {
            blocks: (blocks as { value: number }).value,
            errors: (errors as { value: number }).value,
            floating_blocks: (floating as { value: number }).value,
            over_limit: (over as { value: number }).value,
            longest_cantilever: (longest as { value: number }).value,
            cog_margin_mm: margin,
            max_utilisation: util,
        },
    };
}

/** Also used by shared/voxelEdit/log.ts for the before/after figures of an edit log. */
export function fullMetrics(value: unknown, field: string): Result<StabilizationMetrics> {
    const base = stepMetrics(value, field);
    if (!base.ok) return base;
    const v = value as Record<string, unknown>;
    const warnings = integer(v.warnings, `${field}.warnings`, 0, 1000);
    if (!warnings.ok) return warnings;
    const over = integer(v.overstressed_blocks, `${field}.overstressed_blocks`, 0, 1000);
    if (!over.ok) return over;
    return { ok: true, value: { ...base.value, warnings: warnings.value, overstressed_blocks: over.value } };
}

function step(value: unknown, index: number): Result<StabilizeStepLog> {
    const at = `steps[${index}]`;
    if (!isRecord(value)) return fail(`meta.${at} must be an object`);
    const n = integer(value.n, `${at}.n`, 1, MAX_STABILIZE_STEPS);
    if (!n.ok) return n;
    if (n.value !== index + 1) return fail(`meta.${at}.n must be ${index + 1}`);
    const move = oneOf(value.move, ADDED_ROLES, `${at}.move`);
    if (!move.ok) return move;
    const reason = oneOf(value.reason, REASONS, `${at}.reason`);
    if (!reason.ok) return reason;
    const added = integer(value.added, `${at}.added`, 1, 1000);
    if (!added.ok) return added;
    const t = text(value.text, `${at}.text`, MAX_TEXT);
    if (!t.ok) return t;
    if (!Array.isArray(value.at_mm) || value.at_mm.length !== 3) return fail(`meta.${at}.at_mm must be three numbers`);
    const at_mm: number[] = [];
    for (const c of value.at_mm as unknown[]) {
        const f = finite(c, `${at}.at_mm`, -1000, 2000);
        if (!f.ok) return f;
        at_mm.push(f.value);
    }
    const before = stepMetrics(value.before, `${at}.before`);
    if (!before.ok) return before;
    const after = stepMetrics(value.after, `${at}.after`);
    if (!after.ok) return after;
    return {
        ok: true,
        value: { n: n.value, move: move.value, reason: reason.value, added: added.value, text: t.value, at_mm: [at_mm[0], at_mm[1], at_mm[2]], before: before.value, after: after.value },
    };
}

/** Checks untrusted DerivedMeta and rebuilds it. `now` caps `created_at` as for AnalysisSummary (null: keep as is). */
export function checkDerivedMeta(value: unknown, now: number | null): Result<DerivedMeta> {
    if (!isRecord(value)) return fail("meta must be an object");
    if (value.version !== 1) return fail("meta.version must be 1");
    const depth = integer(value.depth, "depth", 1, MAX_DERIVED_DEPTH);
    if (!depth.ok) return depth;
    const stabilizer = text(value.stabilizer, "stabilizer", 16);
    if (!stabilizer.ok) return stabilizer;
    const solver = oneOf(value.solver, SOLVERS, "solver");
    if (!solver.ok) return solver;
    const material = oneOf<MaterialId>(value.material, MATERIAL_IDS, "material");
    if (!material.ok) return material;
    const target = finite(value.target_utilisation, "target_utilisation", 0.1, 1);
    if (!target.ok) return target;
    const limit = integer(value.cantilever_limit, "cantilever_limit", 1, 10);
    if (!limit.ok) return limit;
    const fill = finite(value.fill_threshold, "fill_threshold", 0, 1);
    if (!fill.ok) return fill;
    if (typeof value.complete !== "boolean") return fail("meta.complete must be true or false");
    const stop = oneOf(value.stop, STOPS, "stop");
    if (!stop.ok) return stop;
    const addedBlocks = integer(value.added_blocks, "added_blocks", 0, 1000);
    if (!addedBlocks.ok) return addedBlocks;

    if (!isRecord(value.added_by_role)) return fail("meta.added_by_role must be an object");
    const byRole: Partial<Record<AddedRole, number>> = {};
    let sum = 0;
    for (const role of ADDED_ROLES) {
        const n = value.added_by_role[role];
        if (n === undefined) continue;
        const c = integer(n, `added_by_role.${role}`, 0, 1000);
        if (!c.ok) return c;
        if (c.value > 0) byRole[role] = c.value;
        sum += c.value;
    }
    if (sum !== addedBlocks.value) return fail("meta.added_by_role must add up to added_blocks");

    const before = fullMetrics(value.before, "before");
    if (!before.ok) return before;
    const after = fullMetrics(value.after, "after");
    if (!after.ok) return after;
    if (after.value.blocks !== before.value.blocks + addedBlocks.value) return fail("meta.after.blocks must be before.blocks + added_blocks");

    if (!Array.isArray(value.steps) || value.steps.length > MAX_STABILIZE_STEPS) return fail(`meta.steps must be a list of at most ${MAX_STABILIZE_STEPS}`);
    const steps: StabilizeStepLog[] = [];
    let stepBlocks = 0;
    for (let i = 0; i < value.steps.length; i++) {
        const s = step(value.steps[i], i);
        if (!s.ok) return s;
        stepBlocks += s.value.added;
        steps.push(s.value);
    }
    if (stepBlocks !== addedBlocks.value) return fail("meta.steps must add up to added_blocks");

    const duration = finite(value.duration_ms, "duration_ms", 0, 3_600_000);
    if (!duration.ok) return duration;
    if (typeof value.assembly_hash !== "string" || !HEX64.test(value.assembly_hash)) return fail("meta.assembly_hash must be a SHA-256 hex string");
    const summary = checkAnalysisSummary(value.after_summary, now);
    if (!summary.ok) return fail(`meta.after_summary: ${summary.error}`);
    const stamp = checkAnalysisSummary({ ...summary.value, analyzed_at: value.created_at }, now);
    if (!stamp.ok) return fail("meta.created_at must be an ISO-8601 date");

    const meta: DerivedMeta = {
        version: 1,
        depth: depth.value,
        stabilizer: stabilizer.value,
        solver: solver.value,
        material: material.value,
        target_utilisation: target.value,
        cantilever_limit: limit.value,
        fill_threshold: fill.value,
        complete: value.complete,
        stop: stop.value,
        added_blocks: addedBlocks.value,
        added_by_role: byRole,
        before: before.value,
        after: after.value,
        steps,
        duration_ms: duration.value,
        assembly_hash: value.assembly_hash,
        after_summary: summary.value,
        created_at: stamp.value.analyzed_at,
    };
    if (JSON.stringify(meta).length > DERIVED_META_LIMIT) return fail(`meta is larger than ${DERIVED_META_LIMIT} bytes`);
    return { ok: true, value: meta };
}

/** Stored or embedded meta, or null when it is missing or unusable. */
export function readDerivedMeta(raw: unknown): DerivedMeta | null {
    try {
        const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        const result = checkDerivedMeta(value, null);
        return result.ok ? result.value : null;
    } catch {
        return null;
    }
}
