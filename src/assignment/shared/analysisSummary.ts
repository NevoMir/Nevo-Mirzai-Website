// Validation of the analysis summary a browser saves with PUT /models/:id/analysis (the contract's AnalysisSummary).
// The site has no login, so the body is untrusted: every field is checked and the object is rebuilt field by
// field, which drops unknown keys and keeps the stored JSON small and predictable.

import { MATERIAL_IDS, type AnalysisSummary, type MaterialId, type StressSummary } from "./contract.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The target volume is a 10 x 10 x 10 grid of blocks, so no count can go past 1000.
const MAX_COUNT = 1000;
// A model is scaled to 1000 mm: the box is at most 1100 mm with some slack, the centre of gravity can sit a little
// outside of it, and the margin to the support base is bounded by the footprint.
const MAX_SIZE_MM = 1100;
const COG_RANGE: [number, number] = [-1000, 2000];
const MAX_MARGIN_MM = 2000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function integer(value: unknown, field: string, min: number, max: number, scope = "summary"): Result<number> {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return fail(`${scope}.${field} must be a whole number from ${min} to ${max}`);
    }
    return { ok: true, value };
}

export function finite(value: unknown, field: string, min: number, max: number, scope = "summary"): Result<number> {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        return fail(`${scope}.${field} must be a number from ${min} to ${max}`);
    }
    return { ok: true, value };
}

export function triple(value: unknown, field: string, min: number, max: number): Result<[number, number, number]> {
    if (!Array.isArray(value) || value.length !== 3) return fail(`summary.${field} must be three numbers`);
    const out: number[] = [];
    for (const item of value) {
        const n = finite(item, field, min, max);
        if (!n.ok) return n;
        out.push(n.value);
    }
    return { ok: true, value: [out[0], out[1], out[2]] };
}

const MAX_UTILISATION = 50;

/** The `stress` block of a summary. Rebuilt field by field like the rest. */
export function checkStressSummary(value: unknown): Result<StressSummary> {
    if (!isRecord(value)) return fail("summary.stress must be an object");
    if (typeof value.material !== "string" || !(MATERIAL_IDS as readonly string[]).includes(value.material)) {
        return fail(`summary.stress.material must be one of ${MATERIAL_IDS.join(", ")}`);
    }
    const max = finite(value.max_utilisation, "stress.max_utilisation", 0, MAX_UTILISATION);
    if (!max.ok) return max;
    let at: [number, number, number] | null = null;
    if (value.max_at !== null && value.max_at !== undefined) {
        const t = triple(value.max_at, "stress.max_at", 0, 9);
        if (!t.ok) return t;
        if (!t.value.every(Number.isInteger)) return fail("summary.stress.max_at must be whole grid coordinates");
        at = t.value;
    }
    const counts: Array<[keyof StressSummary, number]> = [];
    for (const field of ["stressed_blocks", "overstressed_blocks", "analysed_blocks", "unsupported_blocks"] as const) {
        const n = integer(value[field], `stress.${field}`, 0, MAX_COUNT);
        if (!n.ok) return n;
        counts.push([field, n.value]);
    }
    const c = Object.fromEntries(counts) as Record<string, number>;
    return {
        ok: true,
        value: {
            material: value.material as MaterialId,
            max_utilisation: max.value,
            max_at: at,
            stressed_blocks: c.stressed_blocks,
            overstressed_blocks: c.overstressed_blocks,
            analysed_blocks: c.analysed_blocks,
            unsupported_blocks: c.unsupported_blocks,
        },
    };
}

/**
 * Checks a summary and rebuilds it. `now` is the server clock that caps `analyzed_at`; pass null to keep the stamp
 * as it is (summaries read back from the database were capped when they were saved).
 */
export function checkAnalysisSummary(value: unknown, now: number | null): Result<AnalysisSummary> {
    if (!isRecord(value)) return fail("summary must be an object");
    if (value.version !== 1) return fail("summary.version must be 1");

    const blocks = integer(value.blocks, "blocks", 0, MAX_COUNT);
    if (!blocks.ok) return blocks;
    const bodies = integer(value.bodies, "bodies", 0, MAX_COUNT);
    if (!bodies.ok) return bodies;
    const floating = integer(value.floating_blocks, "floating_blocks", 0, MAX_COUNT);
    if (!floating.ok) return floating;
    const cantilevered = integer(value.cantilevered, "cantilevered", 0, MAX_COUNT);
    if (!cantilevered.ok) return cantilevered;
    // A winding overhang can be longer than the grid is wide, so only the block count bounds its length.
    const longest = integer(value.longest_cantilever, "longest_cantilever", 0, MAX_COUNT);
    if (!longest.ok) return longest;
    const overLimit = integer(value.over_limit, "over_limit", 0, MAX_COUNT);
    if (!overLimit.ok) return overLimit;
    const limit = integer(value.cantilever_limit, "cantilever_limit", 1, 10);
    if (!limit.ok) return limit;

    let cog: [number, number, number] | null = null;
    if (value.cog_mm !== null) {
        const t = triple(value.cog_mm, "cog_mm", COG_RANGE[0], COG_RANGE[1]);
        if (!t.ok) return t;
        cog = t.value;
    }
    if (typeof value.cog_inside !== "boolean") return fail("summary.cog_inside must be true or false");
    const margin = finite(value.cog_margin_mm, "cog_margin_mm", -MAX_MARGIN_MM, MAX_MARGIN_MM);
    if (!margin.ok) return margin;
    const size = triple(value.size_mm, "size_mm", 0, MAX_SIZE_MM);
    if (!size.ok) return size;
    const coverage = finite(value.coverage, "coverage", 0, 1);
    if (!coverage.ok) return coverage;
    const fill = finite(value.fill_threshold, "fill_threshold", 0, 1);
    if (!fill.ok) return fill;
    const errors = integer(value.errors, "errors", 0, MAX_COUNT);
    if (!errors.ok) return errors;
    const warnings = integer(value.warnings, "warnings", 0, MAX_COUNT);
    if (!warnings.ok) return warnings;

    // Optional: summaries saved before the stress estimate existed (and ones where it could not be computed) have none.
    let stress: StressSummary | null | undefined;
    if (value.stress !== undefined && value.stress !== null) {
        const parsed = checkStressSummary(value.stress);
        if (!parsed.ok) return parsed;
        stress = parsed.value;
    } else if (value.stress === null) {
        stress = null;
    }

    const stamp = value.analyzed_at;
    const parts = typeof stamp === "string" && stamp.length <= 40 ? ISO_DATE_RE.exec(stamp) : null;
    if (!parts) return fail("summary.analyzed_at must be an ISO-8601 date such as 2026-01-31T12:00:00.000Z");
    // Date.parse rolls impossible dates over (Feb 30 becomes Mar 2); a stamp that names one is a bug, not a date.
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
        return fail("summary.analyzed_at is not a valid date");
    }
    const time = Date.parse(stamp as string);
    if (!Number.isFinite(time)) return fail("summary.analyzed_at is not a valid date");
    // The stamp is the browser's clock and nothing shows it, so a clock that runs ahead is capped to the server's
    // instead of refused: a refusal would silently drop every verdict that browser tries to save.
    const stampedAt = now === null ? time : Math.min(time, now);

    return {
        ok: true,
        value: {
            version: 1,
            blocks: blocks.value,
            bodies: bodies.value,
            floating_blocks: floating.value,
            cantilevered: cantilevered.value,
            longest_cantilever: longest.value,
            over_limit: overLimit.value,
            cantilever_limit: limit.value,
            cog_mm: cog,
            cog_inside: value.cog_inside,
            cog_margin_mm: margin.value,
            size_mm: size.value,
            coverage: coverage.value,
            fill_threshold: fill.value,
            errors: errors.value,
            warnings: warnings.value,
            ...(stress !== undefined ? { stress } : {}),
            // Stored in the contract's canonical form (UTC, millisecond precision) whatever offset the client used.
            analyzed_at: new Date(stampedAt).toISOString(),
        },
    };
}

/** A stored summary, or null when the column is empty or holds something unusable (bad JSON, an old shape). */
export function readStoredAnalysis(raw: string | null): AnalysisSummary | null {
    if (!raw) return null;
    try {
        const result = checkAnalysisSummary(JSON.parse(raw), null);
        return result.ok ? result.value : null;
    } catch {
        return null;
    }
}
