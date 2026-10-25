// Block assemblies with a consistent log of each kind, built here with the shared writer (src/assignment/shared), so the version tests need
// no browser, stabilizer, optimizer or AI: test-versions-backend.mjs (in Node, against the Worker's own code) and smoke-derived.mjs (against
// wrangler dev) share them.
//
//   stabilizedFixture({ more, depth, overrides })      the shelf arm (21 original blocks) + a 5-block column (step 1) + `more` reinforcement cells (step 2)
//   editedFixture({ source, edits, ... })               a block edit of any descriptor: `edits` = [{ add: cells, remove: cells }, ...]
//   optimizedFixture({ source, remove, add, ... })      an optimizer result of any descriptor
//
// Each returns { descriptor, glb, hash, <the log> }. `overrides` is merged into the log last (a tampered log: the writer refuses one that does
// not add up by itself, so tamper with fields that only the Worker's cross-checks can catch).
const shared = (name) => import(`../../src/assignment/shared/${name}.ts`);
export const { descriptorFromBlocks, assemblyHash, CELL_STRIDE } = await shared("assembly");
export const { writeAssemblyGlb, readAssemblyGlb } = await shared("assemblyGlb");
export const { BLOCK_ROLES } = await shared("contract");
const { presetSpec } = await shared("optimizeSpec");

export const range = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);
export const box = (x0, x1, y0, y1, z0, z1) => range(x1 - x0, x0).flatMap((i) => range(y1 - y0, y0).flatMap((j) => range(z1 - z0, z0).map((k) => [i, j, k])));
const unique = (cells) => [...new Map(cells.map((c) => [c.join(), c])).values()];
export const codeOf = ([i, j, k]) => k * 100 + j * 10 + i;

export const ARM = unique([...box(0, 3, 0, 3, 0, 1), ...box(1, 2, 1, 2, 1, 6), ...box(2, 9, 1, 2, 5, 6)]);
export const COLUMN = box(8, 9, 1, 2, 0, 5).map((cell) => ({ cell, role: "column", step: 1 }));

/** A valid AnalysisSummary for `blocks` blocks. */
export function summaryFor(blocks, over, at = new Date().toISOString()) {
    return {
        version: 1, blocks, bodies: 1, floating_blocks: 0, cantilevered: over ? 7 : 1, longest_cantilever: over ? 7 : 3, over_limit: over ? 3 : 0,
        cantilever_limit: 4, cog_mm: [450, 150, 250], cog_inside: true, cog_margin_mm: 40, size_mm: [900, 300, 600], coverage: 0.8, fill_threshold: 0.1,
        errors: over ? 2 : 0, warnings: 0,
        stress: { material: "concrete", max_utilisation: over ? 1.98 : 0.21, max_at: [2, 1, 5], stressed_blocks: over ? 6 : 0, overstressed_blocks: over ? 3 : 0, analysed_blocks: blocks, unsupported_blocks: 0 },
        analyzed_at: at,
    };
}
/** StabilizationMetrics (the figures of one side of a before/after). */
export const metricsFor = (blocks, over) => ({ blocks, errors: over ? 2 : 0, warnings: 0, floating_blocks: 0, over_limit: over ? 3 : 0, longest_cantilever: over ? 7 : 3, cog_margin_mm: 40, max_utilisation: over ? 1.98 : 0.21, overstressed_blocks: over ? 3 : 0 });
/** OptimizeMetrics. */
export const optMetricsFor = (blocks, over = false) => ({ blocks, weight_kg: blocks * 2.4, errors: over ? 2 : 0, warnings: 0, floating_blocks: 0, over_limit: over ? 3 : 0, longest_cantilever: over ? 7 : 3, cog_margin_mm: 40, max_utilisation: over ? 1.98 : 0.21, max_deflection_um: 12.5 });
const stepMetrics = (m) => ({ blocks: m.blocks, errors: m.errors, floating_blocks: m.floating_blocks, over_limit: m.over_limit, longest_cantilever: m.longest_cantilever, cog_margin_mm: m.cog_margin_mm, max_utilisation: m.max_utilisation });

/** [{cell, role, step}] of a descriptor. */
export function blocksOf(descriptor) {
    const out = [];
    for (let n = 0; n < descriptor.cells.length; n += CELL_STRIDE) {
        out.push({ cell: [descriptor.cells[n], descriptor.cells[n + 1], descriptor.cells[n + 2]], role: BLOCK_ROLES[descriptor.cells[n + 3]], step: descriptor.cells[n + 4] });
    }
    return out;
}
export const highestStep = (descriptor) => {
    let h = 0;
    for (let n = 4; n < descriptor.cells.length; n += CELL_STRIDE) h = Math.max(h, descriptor.cells[n]);
    return h;
};
/** A mesh-like source: every cell original, step 0 (what voxelising a generated model gives). */
export const plainDescriptor = (cells = ARM) => descriptorFromBlocks(cells.map((cell) => ({ cell })));

/**
 * A consistent stabilizer log for any descriptor: one step per distinct step number among the blocks this run added. Blocks with a step up
 * to `priorSteps` came with the source (a second run keeps the first run's roles and steps) and are not this run's.
 */
export async function metaFor(descriptor, depth, overrides = {}, priorSteps = 0) {
    const byStep = new Map();
    const byRole = {};
    let base = 0;
    for (let n = 0; n < descriptor.cells.length; n += CELL_STRIDE) {
        const role = BLOCK_ROLES[descriptor.cells[n + 3]];
        const step = descriptor.cells[n + 4];
        if (role === "original" || step <= priorSteps) {
            base++;
            continue;
        }
        const entry = byStep.get(step) ?? { role, n: 0 };
        entry.n++;
        byStep.set(step, entry);
        byRole[role] = (byRole[role] ?? 0) + 1;
    }
    const total = descriptor.cells.length / CELL_STRIDE;
    const before = metricsFor(base, true);
    const after = metricsFor(total, false);
    const steps = [...byStep.entries()].sort((a, b) => a[0] - b[0]).map(([, v], i) => ({
        n: i + 1, move: v.role, reason: "cantilever", added: v.n,
        text: `Added a ${v.n}-block ${v.role} under the arm tip at x = 850 mm, y = 150 mm because the cantilever reached 7 > 4 blocks. Peak stress 198% to 21%.`,
        at_mm: [850, 150, 250], before: stepMetrics(before), after: stepMetrics(after),
    }));
    const at = overrides.created_at ?? new Date().toISOString();
    return {
        version: 1, depth, stabilizer: "1.0.0", solver: "awatif-ts", material: "concrete", target_utilisation: 0.6, cantilever_limit: 4, fill_threshold: 0.1,
        complete: true, stop: "stable", added_blocks: total - base, added_by_role: byRole, before, after, steps, duration_ms: 42,
        assembly_hash: await assemblyHash(descriptor), after_summary: summaryFor(total, false, at), created_at: at, ...overrides,
    };
}

/**
 * The arm plus its column plus `more` reinforcement cells: each distinct `more` is a distinct result (hash). From depth 2 on the column is
 * the earlier run's (step 1) and only the reinforcement is this run's, as the stabilizer logs it.
 */
export async function stabilizedFixture({ more = [], depth = 1, overrides = {} } = {}) {
    const blocks = [...ARM.map((cell) => ({ cell })), ...COLUMN, ...more.map((cell) => ({ cell, role: "reinforcement", step: 2 }))];
    const descriptor = descriptorFromBlocks(blocks);
    const meta = await metaFor(descriptor, depth, overrides, depth >= 2 ? 1 : 0);
    return { descriptor, meta, glb: writeAssemblyGlb(descriptor, meta), hash: meta.assembly_hash };
}

let freshCounter = 0;
/** Free cells away from the arm (y >= 3), a different one every call. */
export const freshCells = (count = 1) => Array.from({ length: count }, () => {
    const n = freshCounter++;
    return [n % 10, 3 + (Math.floor(n / 10) % 6), 8];
});

const boundingBox = (cells) => {
    const lo = [9, 9, 9];
    const hi = [0, 0, 0];
    for (const c of cells) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], c[a]); hi[a] = Math.max(hi[a], c[a]); }
    return [...lo, ...hi];
};

/**
 * A block edit of `source` (a descriptor). `edits` is a list of instructions, each `{ add?: cells, remove?: cells, moved?: number, instruction?, summary? }`;
 * what an instruction adds is role "user" with step baseSteps + n. `baseSteps` defaults to the highest step of the source. The log is consistent with
 * the cells (counts, steps, hash), except where `overrides` says otherwise.
 */
export async function editedFixture({ source, edits, baseSteps = highestStep(source), stabilizedDepth = 0, depth = 1, overrides = {}, parts = [], labels = null }) {
    const map = new Map(blocksOf(source).map((b) => [codeOf(b.cell), b]));
    const before = map.size;
    const entries = edits.map((e, i) => {
        for (const cell of e.remove ?? []) if (!map.delete(codeOf(cell))) throw new RangeError(`cell ${cell} is empty`);
        for (const cell of e.add ?? []) {
            if (map.has(codeOf(cell))) throw new RangeError(`cell ${cell} is taken`);
            map.set(codeOf(cell), { cell, role: "user", step: baseSteps + i + 1 });
        }
        const target = (e.add ?? []).length > 0 ? boundingBox(e.add) : boundingBox(e.remove ?? [[0, 0, 0]]);
        return {
            n: i + 1,
            instruction: e.instruction ?? `change number ${i + 1}`,
            summary: e.summary ?? `Changed ${(e.add ?? []).length} blocks.`,
            notes: "",
            ops: [{ op: (e.add ?? []).length > 0 ? "add" : "remove", box: target }],
            added: (e.add ?? []).length,
            removed: (e.remove ?? []).length,
            moved: e.moved ?? 0,
            skipped_protected: 0,
            model: "meta/muse-spark-1.3-contributor",
            cost_usd: 0.0004,
        };
    });
    const descriptor = descriptorFromBlocks([...map.values()]);
    const total = map.size;
    const hash = await assemblyHash(descriptor);
    const at = overrides.created_at ?? new Date().toISOString();
    const log = {
        version: 1, depth, stabilized_depth: stabilizedDepth, base_steps: baseSteps, edits: entries, parts, labels: labels ?? ".".repeat(total),
        before: metricsFor(before, true), after: metricsFor(total, false), assembly_hash: hash, after_summary: summaryFor(total, false, at), created_at: at, ...overrides,
    };
    return { descriptor, log, glb: writeAssemblyGlb(descriptor, null, log), hash };
}

/**
 * An optimizer result of `source` (a descriptor): `remove` cells are gone, `add` cells are reinforcement of step highest + 1. `sourceHash` is the cell
 * hash of a block-version source and null for a mesh source.
 */
export async function optimizedFixture({ source, remove = [], add = [], sourceHash, stabilizedDepth = 0, shapeChanged = false, goal = "Lightest", overrides = {}, parts = [], labels = null }) {
    const map = new Map(blocksOf(source).map((b) => [codeOf(b.cell), b]));
    const before = map.size;
    const step = add.length > 0 ? highestStep(source) + 1 : 0;
    const removedCodes = remove.map(codeOf).sort((a, b) => a - b);
    for (const cell of remove) if (!map.delete(codeOf(cell))) throw new RangeError(`cell ${cell} is empty`);
    for (const cell of add) map.set(codeOf(cell), { cell, role: "reinforcement", step });
    const descriptor = descriptorFromBlocks([...map.values()]);
    const total = map.size;
    const hash = await assemblyHash(descriptor);
    const at = overrides.created_at ?? new Date().toISOString();
    const meta = {
        version: 1, optimizer: "1.0.0", solver: "awatif-ts", material: "concrete", spec: presetSpec("lightest", { blocks: before }), source_hash: sourceHash ?? null,
        stabilized_depth: stabilizedDepth, goal, shape_changed: shapeChanged, parts, labels: labels ?? ".".repeat(total), step,
        removed: removedCodes, removed_at: removedCodes.map(() => 1), added: add.length, added_at: add.map(() => 2), stop: "converged", feasible: true,
        before: optMetricsFor(before, false), after: optMetricsFor(total, false),
        history: [[0, before, 0.3, 40, 12.5, 1, 0, 0, 1], [1, total, 0.3, 40, 12.5, 0.9, removedCodes.length, add.length, 2]],
        solves: 2, duration_ms: 120, assembly_hash: hash, after_summary: summaryFor(total, false, at), created_at: at, ...overrides,
    };
    return { descriptor, meta, glb: writeAssemblyGlb(descriptor, null, null, meta), hash };
}

// ---------- byte-level tampering ----------

/** Offset of the BIN chunk's first byte in a GLB (JSON chunk first). */
export function binStart(bytes) {
    return 20 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true) + 8;
}
export function flipBit(bytes, at, bit = 0) {
    const copy = bytes.slice();
    copy[at] ^= 1 << bit;
    return copy;
}
/** Applies `fn` to the parsed JSON chunk and writes the file back (padding with spaces). The result is NOT canonical; the reader should refuse it. */
export function patchJson(bytes, fn) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(12, true);
    const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
    fn(doc);
    const json = new TextEncoder().encode(JSON.stringify(doc));
    const pad = (4 - (json.length % 4)) % 4;
    const jl = json.length + pad;
    const rest = bytes.subarray(20 + len);
    const out = new Uint8Array(20 + jl + rest.length);
    const ov = new DataView(out.buffer);
    out.set(bytes.subarray(0, 12));
    ov.setUint32(8, out.length, true);
    ov.setUint32(12, jl, true);
    ov.setUint32(16, 0x4e4f534a, true);
    out.set(json, 20);
    out.fill(0x20, 20 + json.length, 20 + jl);
    out.set(rest, 20 + jl);
    return out;
}
/** [start, end) of the JSON text that the extras key `name` occupies in the file, for flipping bytes inside one log. */
export function logSpan(bytes, name) {
    const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
    const text = new TextDecoder().decode(bytes.subarray(20, 20 + len));
    const start = text.indexOf(`"${name}":`);
    if (start < 0) return null;
    // The log is the last key of scenes[0].extras, so it ends at the "}" that closes extras: scan for the matching brace.
    let depth = 0;
    let end = text.indexOf("{", start);
    const begin = end;
    for (; end < text.length; end++) {
        if (text[end] === "{") depth++;
        else if (text[end] === "}" && --depth === 0) break;
    }
    // ASCII up to here (the fixtures use ASCII text), so character offsets are byte offsets.
    return [20 + begin, 20 + end + 1];
}
