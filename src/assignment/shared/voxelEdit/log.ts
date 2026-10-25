// M0 SKELETON (foundation commit): a straight port of the prototype's editMeta.ts with the renames of spec 2.3. Owner C owns this file
// from M1 (together with ops.ts, scene.ts, ...) and keeps the exported names and shapes; summarizeVoxelEdit is new here.
//
// Validation of VoxelEditLog: what a block version made by words records about the instructions it was made with (the full log).
// It arrives inside an uploaded GLB (scenes[0].extras["nevo:edit"]) from a browser nobody vouches for, so every field is checked and the
// object is rebuilt field by field, like checkDerivedMeta. The server keeps only the slim EditMeta (summarizeVoxelEdit) in models.meta.

import {
    EDIT_INSTRUCTION_MAX,
    MAX_DERIVED_DEPTH,
    MAX_VERSION_DEPTH,
    MAX_VOXEL_EDITS_PER_VERSION,
    MAX_VOXEL_OPS,
    type AnalysisSummary,
    type EditEntry,
    type EditMeta,
    type StabilizationMetrics,
} from "../contract.ts";
import { checkAnalysisSummary, fail, finite as finiteIn, integer as integerIn, type Result } from "../analysisSummary.ts";
import { fullMetrics } from "../derivedMeta.ts";
import { VOXEL_DIRS, VOXEL_OP_NAMES, type VoxelDir, type VoxelEditEntry, type VoxelOp, type VoxelOpName } from "./ops.ts";

/** The full record inside an edited block version's GLB (scenes[0].extras["nevo:edit"]), at most 32 KB. */
export interface VoxelEditLog {
    version: 1;
    /** Ancestors above this version, as the browser counted them (the server computes its own: EditMeta.depth). */
    depth: number;
    /** Stabilizations in the chain above this version: a stabilization of it records stabilized_depth + 1 as its DerivedMeta.depth. */
    stabilized_depth: number;
    /** Highest step among the blocks of the version this one was edited from; edit n created blocks of step base_steps + n. */
    base_steps: number;
    edits: VoxelEditEntry[]; // 1..MAX_VOXEL_EDITS_PER_VERSION
    /** Names of the parts the labels refer to ('A' = parts[0]); at most 26. */
    parts: string[];
    /** One character per block in canonical order: 'A'-'Z' = part, '.' = none. Length = number of blocks. */
    labels: string;
    before: StabilizationMetrics; // the version it was edited from
    after: StabilizationMetrics; // this version
    assembly_hash: string;
    after_summary: AnalysisSummary;
    created_at: string;
}

const integer = (value: unknown, field: string, min: number, max: number): Result<number> => integerIn(value, field, min, max, "edit");
const finite = (value: unknown, field: string, min: number, max: number): Result<number> => finiteIn(value, field, min, max, "edit");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const REGION = /^(all|[A-Z]|[a-z]\d{1,2}|role:[a-z]{3,13})$/;
const MAX_PARTS = 26;
const MAX_PART_NAME = 40;

function text(value: unknown, field: string, min: number, max: number): Result<string> {
    if (typeof value !== "string" || value.length < min || value.length > max) return fail(`edit.${field} must be ${min} to ${max} characters`);
    if (CONTROL.test(value)) return fail(`edit.${field} has control characters`);
    return { ok: true, value };
}

function ints(value: unknown, field: string, n: number, min: number, max: number): Result<number[]> {
    if (!Array.isArray(value) || value.length !== n) return fail(`edit.${field} must be ${n} whole numbers`);
    const out: number[] = [];
    for (const v of value as unknown[]) {
        const r = integer(v, field, min, max);
        if (!r.ok) return r;
        out.push(r.value);
    }
    return { ok: true, value: out };
}

/** An operation, rebuilt: only the fields its kind uses are kept. */
function checkOp(value: unknown, at: string): Result<VoxelOp> {
    if (!isRecord(value)) return fail(`edit.${at} must be an object`);
    if (typeof value.op !== "string" || !(VOXEL_OP_NAMES as readonly string[]).includes(value.op)) return fail(`edit.${at}.op is not an operation`);
    const op: VoxelOp = { op: value.op as VoxelOpName };
    if (value.region !== undefined) {
        if (typeof value.region !== "string" || !REGION.test(value.region)) return fail(`edit.${at}.region is not a region id`);
        op.region = value.region;
    }
    if (value.box !== undefined) {
        const b = ints(value.box, `${at}.box`, 6, 0, 9);
        if (!b.ok) return b;
        if (b.value[0] > b.value[3] || b.value[1] > b.value[4] || b.value[2] > b.value[5]) return fail(`edit.${at}.box must be ordered`);
        op.box = b.value as VoxelOp["box"];
    }
    if (value.dirs !== undefined) {
        if (!Array.isArray(value.dirs) || value.dirs.length < 1 || value.dirs.length > 6 || !value.dirs.every((d) => (VOXEL_DIRS as readonly unknown[]).includes(d))) return fail(`edit.${at}.dirs is not a list of directions`);
        op.dirs = [...new Set(value.dirs as VoxelDir[])];
    }
    if (value.amount !== undefined) { const r = integer(value.amount, `${at}.amount`, -9, 9); if (!r.ok) return r; op.amount = r.value; }
    if (value.axis !== undefined) { if (value.axis !== "i" && value.axis !== "j" && value.axis !== "k") return fail(`edit.${at}.axis must be i, j or k`); op.axis = value.axis; }
    if (value.at !== undefined) { const r = integer(value.at, `${at}.at`, 0, 9); if (!r.ok) return r; op.at = r.value; }
    if (value.plane !== undefined) { const r = finite(value.plane, `${at}.plane`, -9, 18); if (!r.ok) return r; if (Math.round(r.value * 2) !== r.value * 2) return fail(`edit.${at}.plane must be a whole or half number`); op.plane = r.value; }
    if (value.offset !== undefined) { const r = ints(value.offset, `${at}.offset`, 3, -9, 9); if (!r.ok) return r; op.offset = r.value as VoxelOp["offset"]; }
    if (value.wall !== undefined) { const r = integer(value.wall, `${at}.wall`, 1, 4); if (!r.ok) return r; op.wall = r.value; }
    if (value.include_added !== undefined) { if (typeof value.include_added !== "boolean") return fail(`edit.${at}.include_added must be true or false`); op.include_added = value.include_added; }
    return { ok: true, value: op };
}

function checkEntry(value: unknown, index: number): Result<VoxelEditEntry> {
    const at = `edits[${index}]`;
    if (!isRecord(value)) return fail(`edit.${at} must be an object`);
    const n = integer(value.n, `${at}.n`, 1, MAX_VOXEL_EDITS_PER_VERSION);
    if (!n.ok) return n;
    if (n.value !== index + 1) return fail(`edit.${at}.n must be ${index + 1}`);
    const instruction = text(value.instruction, `${at}.instruction`, 1, EDIT_INSTRUCTION_MAX);
    if (!instruction.ok) return instruction;
    const summary = text(value.summary, `${at}.summary`, 1, 200);
    if (!summary.ok) return summary;
    const notes = text(value.notes, `${at}.notes`, 0, 200);
    if (!notes.ok) return notes;
    if (!Array.isArray(value.ops) || value.ops.length > MAX_VOXEL_OPS) return fail(`edit.${at}.ops must be a list of at most ${MAX_VOXEL_OPS}`);
    const ops: VoxelOp[] = [];
    for (let i = 0; i < value.ops.length; i++) {
        const o = checkOp(value.ops[i], `${at}.ops[${i}]`);
        if (!o.ok) return o;
        ops.push(o.value);
    }
    const added = integer(value.added, `${at}.added`, 0, 1000); if (!added.ok) return added;
    const removed = integer(value.removed, `${at}.removed`, 0, 1000); if (!removed.ok) return removed;
    const moved = integer(value.moved, `${at}.moved`, 0, 1000); if (!moved.ok) return moved;
    const skipped = integer(value.skipped_protected, `${at}.skipped_protected`, 0, 1000); if (!skipped.ok) return skipped;
    const model = text(value.model, `${at}.model`, 0, 64); if (!model.ok) return model;
    let cost: number | null = null;
    if (value.cost_usd !== null) { const c = finite(value.cost_usd, `${at}.cost_usd`, 0, 10); if (!c.ok) return c; cost = c.value; }
    return { ok: true, value: { n: n.value, instruction: instruction.value, summary: summary.value, notes: notes.value, ops, added: added.value, removed: removed.value, moved: moved.value, skipped_protected: skipped.value, model: model.value, cost_usd: cost } };
}

/** Checks an untrusted VoxelEditLog and rebuilds it. `now` caps `created_at` as for AnalysisSummary (null: keep as is). */
export function checkVoxelEditLog(value: unknown, now: number | null): Result<VoxelEditLog> {
    if (!isRecord(value)) return fail("edit must be an object");
    if (value.version !== 1) return fail("edit.version must be 1");
    const depth = integer(value.depth, "depth", 1, MAX_VERSION_DEPTH); if (!depth.ok) return depth;
    const stabilized = integer(value.stabilized_depth, "stabilized_depth", 0, MAX_DERIVED_DEPTH); if (!stabilized.ok) return stabilized;
    const base = integer(value.base_steps, "base_steps", 0, 255); if (!base.ok) return base;
    if (!Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > MAX_VOXEL_EDITS_PER_VERSION) return fail(`edit.edits must be a list of 1 to ${MAX_VOXEL_EDITS_PER_VERSION}`);
    if (base.value + value.edits.length > 255) return fail("edit.base_steps + edits is more than 255");
    const edits: VoxelEditEntry[] = [];
    for (let i = 0; i < value.edits.length; i++) { const e = checkEntry(value.edits[i], i); if (!e.ok) return e; edits.push(e.value); }
    if (!Array.isArray(value.parts) || value.parts.length > MAX_PARTS) return fail(`edit.parts must be a list of at most ${MAX_PARTS} names`);
    const parts: string[] = [];
    for (const p of value.parts as unknown[]) { const t = text(p, "parts", 1, MAX_PART_NAME); if (!t.ok) return t; parts.push(t.value); }
    if (typeof value.labels !== "string" || value.labels.length > 1000 || !/^[A-Z.]*$/.test(value.labels)) return fail("edit.labels must be A-Z or '.' only, at most 1000 characters");
    for (const ch of value.labels) if (ch !== "." && ch.charCodeAt(0) - 65 >= parts.length) return fail("edit.labels uses a part that is not in edit.parts");
    const before = fullMetrics(value.before, "before"); if (!before.ok) return before;
    const after = fullMetrics(value.after, "after"); if (!after.ok) return after;
    if (after.value.blocks !== value.labels.length) return fail("edit.labels must have one character per block");
    if (typeof value.assembly_hash !== "string" || !HEX64.test(value.assembly_hash)) return fail("edit.assembly_hash must be a SHA-256 hex string");
    const summary = checkAnalysisSummary(value.after_summary, now);
    if (!summary.ok) return fail(`edit.after_summary: ${summary.error}`);
    const stamp = checkAnalysisSummary({ ...summary.value, analyzed_at: value.created_at }, now);
    if (!stamp.ok) return fail("edit.created_at must be an ISO-8601 date");
    const meta: VoxelEditLog = {
        version: 1, depth: depth.value, stabilized_depth: stabilized.value, base_steps: base.value, edits, parts, labels: value.labels,
        before: before.value, after: after.value, assembly_hash: value.assembly_hash, after_summary: summary.value, created_at: stamp.value.analyzed_at,
    };
    if (JSON.stringify(meta).length > 32 * 1024) return fail("edit is larger than 32768 bytes");
    return { ok: true, value: meta };
}

/** An embedded edit log, or null when it is missing or unusable. */
export function readVoxelEditLog(raw: unknown): VoxelEditLog | null {
    try {
        const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
        const result = checkVoxelEditLog(value, null);
        return result.ok ? result.value : null;
    } catch {
        return null;
    }
}

// ---------- the slim copy the server keeps ----------

/** Words for a version's name: the last instruction, tidied, at most 40 characters ("Make the back taller"). */
export function labelOfInstruction(instruction: string): string {
    const clean = instruction.replace(/\s+/g, " ").replace(/[.!?\s]+$/, "").trim();
    const sentence = clean.charAt(0).toUpperCase() + clean.slice(1);
    return sentence.length <= 40 ? sentence : `${sentence.slice(0, 39).trimEnd()}\u2026`;
}

/**
 * The EditMeta (target "voxel") the server stores in models.meta for a validated log: instructions and counts, without ops, labels or
 * metrics. `ctx.depth` is the server's own count of ancestors (D15: the client's claim is not stored).
 */
export function summarizeVoxelEdit(log: VoxelEditLog, ctx: { depth: number }): EditMeta {
    const entries: EditEntry[] = log.edits.map((e) => ({
        n: e.n,
        instruction: e.instruction.slice(0, 160),
        summary: e.summary.slice(0, 200),
        added: e.added,
        removed: e.removed,
        moved: e.moved,
    }));
    const last = log.edits[log.edits.length - 1];
    return {
        version: 1,
        target: "voxel",
        depth: ctx.depth,
        label: labelOfInstruction(last.instruction),
        summary: last.summary.slice(0, 240),
        entries,
        engine: last.model.slice(0, 64),
        changes: null,
        ops: null,
        notes: [],
        stabilized_depth: log.stabilized_depth,
        base_steps: log.base_steps,
        job_id: null,
        created_at: log.created_at,
    };
}
