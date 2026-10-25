// Downloads: a JSON report of the whole analysis and a CSV of the blocks.

import type { AnalysisResult, Block, CheckRow, Issue, IssueKind, StressMode } from "./types.ts";
import { BLOCK_ROLES, type BlockRole, type DerivedMeta, type MaterialId } from "../shared/contract.ts";
import { DEFINITIONS, STRESS_ASSUMPTIONS } from "./definitions.ts";
import type { Definition } from "./definitions.ts";
import { COVERAGE_WARN, EDGE_MARGIN_MM } from "./issues.ts";
import { STRESS_FAIL, STRESS_WARN, materialOf } from "./materials.ts";

export interface ReportMeta {
    modelId?: string;
    modelName?: string;
    modelUrl?: string;
    prompt?: string;
    provider?: string;
    /** ISO date; defaults to the time the report is built. */
    generatedAt?: string;
    /** How a stabilized model was made (ModelAsset.derived): goes into the report's `stabilization` key. */
    derived?: DerivedMeta | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * One finding as a measurement, for a reader who wants the numbers: what was measured (in the engine's terms), its value, the limit it
 * is held to and the cells it is about. The screen words the same finding for a student; the report keeps this beside the plain `title`
 * and `detail`, and beside the sentence in `technical`.
 */
export interface IssueTechnicalSummary {
    /** The issue's kind, repeated so the summary reads on its own. */
    kind: IssueKind;
    /** What was measured: "Centre-of-gravity margin to the support base", "Cantilever reach", "Joint utilisation". */
    metric: string;
    /** The measured value in `unit`; null when it could not be measured (nothing touches the ground). */
    measured: number | null;
    /** What it is held to; null when no limit applies. */
    limit: number | null;
    /** mm; blocks (a count of blocks); ratio (0.73 = 73 % of the allowable, 0.8 = 80 % of the model's volume). */
    unit: "mm" | "blocks" | "ratio";
    /** "max": the measured value must not exceed the limit; "min": it must not fall short of it; null when there is no limit. */
    bound: "max" | "min" | null;
    /** The grid cells (i, j, k) the measurement is about: the peak block of a joint, the blocks past the limit, the floating blocks. */
    cells: Array<[number, number, number]>;
}

export interface ReportDocument {
    report: "block-structure-analysis";
    version: 1;
    generated_at: string;
    model: ReportMeta;
    verdict: { passes: boolean; errors: number; warnings: number };
    settings: AnalysisResult["settings"];
    scaling: { size_mm: [number, number, number]; scale_factor: number; offset_mm: [number, number, number]; grid: [number, number, number] };
    checks: CheckRow[];
    /** `title` and `detail` are what the screen says (plain words); `technical` is the same finding in the engine's terms, with the figures. */
    issues: Array<
        Omit<Issue, "blocks" | "focusMm"> & {
            technical: string;
            /** The same finding as a measurement: kind, measured value against its limit, cells. Absent in reports that predate it. */
            technical_summary?: IssueTechnicalSummary;
            focus_mm: [number, number, number];
            blocks: number[];
            cells: Array<[number, number, number]>;
        }
    >;
    stability: {
        cog_mm: [number, number, number];
        inside_base: boolean;
        margin_mm: number;
        tip_direction: [number, number] | null;
        pivot_mm: [number, number];
        support_base_mm: Array<[number, number]>;
        /** The grounded body these numbers describe (the weakest one) and how many grounded bodies were judged. */
        body: number | null;
        grounded_bodies: number;
    } | null;
    cantilever_runs: Array<{ id: number; reach: number; blocks: number; over_limit_blocks: number; layers: [number, number]; roots: number[] }>;
    bodies: Array<{ id: number; blocks: number; grounded: boolean }>;
    stats: AnalysisResult["stats"];
    blocks: Array<{
        index: number;
        cell: [number, number, number];
        centre_mm: [number, number, number];
        status: Block["status"];
        reach: number | null;
        body: number;
        fill: number;
        /** Only for a block assembly (a stabilized model): what the block is for and the stabilizer step that added it (0 = original). */
        role?: BlockRole;
        step?: number;
        /** Joint utilisation (0.73 = 73 % of the allowable); null where there is no load path. Present when the stress was estimated. */
        utilisation?: number | null;
    }>;
    definitions: Definition[];
    /** The joint-stress estimate; null when it could not be made (nothing on the ground, solver failure); absent in reports that predate it. */
    stress?: {
        load_case: "self-weight";
        material: {
            id: MaterialId;
            name: string;
            density_kg_m3: number;
            youngs_modulus_gpa: number;
            joint_tension_mpa: number;
            compression_mpa: number;
            shear_mpa: number;
        };
        solver: { name: string; backend: "wasm" | "ts"; ms: number };
        thresholds: { warn: number; fail: number };
        max_utilisation: number;
        max_at: { cell: [number, number, number]; centre_mm: [number, number, number] } | null;
        stressed_blocks: number;
        overstressed_blocks: number;
        analysed_blocks: number;
        unsupported_blocks: number;
        points: Array<{
            rank: number;
            utilisation: number;
            mode: StressMode;
            tension_kpa: number;
            allowable_kpa: number;
            cell: [number, number, number];
            centre_mm: [number, number, number];
            joint: [[number, number, number], [number, number, number]] | null;
            blocks: number;
        }>;
        assumptions: readonly string[];
    } | null;
    /** Present for a block assembly (a stabilized model). */
    assembly?: { blocks: number; added_blocks: number; steps: number; role_counts: Record<BlockRole, number> };
    /** How the stabilizer made the model (its log), when the caller passed it in `ReportMeta.derived`. */
    stabilization?: DerivedMeta;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const triple = (v: readonly number[]): string => `(${v.map(r1).join(", ")})`;

/**
 * An issue in the engine's own terms and units, for the exported report: the screen words every finding for a student ("Arm too
 * long: 6 blocks (max 4)"), the report keeps the cantilever, the centre of gravity, the utilisation and the cells.
 */
export function technicalLine(issue: Issue, result: AnalysisResult): string {
    const { settings, stability, stats, stress, blocks } = result;
    switch (issue.kind) {
        case "empty":
            return `No block is at least ${pct(settings.fillThreshold)} filled (fill threshold), so no component is left to analyse.`;
        case "cog-outside": {
            if (!stability) return "The centre of gravity could not be judged: no block touches the ground.";
            const cog = `Centre of gravity ${triple(stability.cogMm)} mm`;
            if (stability.inside) return `${cog} projects ${r1(stability.marginMm)} mm inside the edge of the support base: balanced on the edge (margin under 1 mm).`;
            const tip = stability.tipDirection ? `; it tips about ${triple(stability.pivotMm)} mm towards (${stability.tipDirection.map(r3).join(", ")})` : "";
            return `${cog} projects ${r1(-stability.marginMm)} mm outside the support base${tip}.`;
        }
        case "cantilever-too-long": {
            const run = result.cantilevers.find((r) => `cantilever-${r.id}` === issue.id);
            if (!run) return `Cantilever longer than the limit of ${settings.cantileverLimit} blocks.`;
            return `Cantilever run ${run.id}: reach ${run.reach} blocks against a limit of ${settings.cantileverLimit}; ${run.overLimit.length} of its ${run.blocks.length} blocks are over the limit (layers k ${run.layers[0]} to ${run.layers[1]}).`;
        }
        case "floating": {
            const body = result.bodies.find((b) => `floating-${b.id}` === issue.id);
            return `Floating structure ${body ? `${body.id}: ${body.blocks.length} blocks` : `of ${issue.blocks.length} blocks`}, not connected to a block on the ground (no load path).`;
        }
        case "too-many-blocks":
            return `Components used: ${stats.blockCount} against a budget of ${settings.maxBlocks}.`;
        case "thin-features": {
            // Two findings share the kind (issues.ts), told apart the way technicalSummary tells them: too little of the model kept
            // (coverage under the warning level), or thin joints a lower fill threshold would keep, which connect floating parts.
            if (stats.coverage < COVERAGE_WARN) return `Coverage ${pct(stats.coverage)} (warning below ${pct(COVERAGE_WARN)}) at a fill threshold of ${pct(settings.fillThreshold)}.`;
            const n = issue.blocks.length;
            return `${n} floating ${n === 1 ? "block" : "blocks"} would be connected at a lower fill threshold (now ${pct(settings.fillThreshold)}); coverage is ${pct(stats.coverage)}.`;
        }
        case "overstressed":
        case "highly-stressed": {
            const peak = issue.blocks[0];
            const point = stress?.points.find((p) => p.blocks.includes(peak));
            const u = stress && peak !== undefined ? stress.byBlock[peak] : Number.NaN;
            const cell = peak !== undefined && blocks[peak] ? ` at block (${blocks[peak].cell.join(", ")})` : "";
            const load = point ? `: ${point.mode} ${Math.round(point.tensionKPa)} of ${Math.round(point.allowableKPa)} kPa allowable` : "";
            return `Joint utilisation ${Number.isFinite(u) ? pct(u) : "n/a"} of the allowable stress${load}${cell}; ${issue.kind === "overstressed" ? "over 100% (overstressed)" : "over 75% (highly stressed)"}.`;
        }
    }
}

/**
 * An issue as a measurement (see IssueTechnicalSummary): the number the check looked at, the limit it was held to, and where. The
 * limits are the engine's own (settings, issues.ts, materials.ts), so this never disagrees with `technical` or with the verdict.
 */
export function technicalSummary(issue: Issue, result: AnalysisResult, cells: Array<[number, number, number]>): IssueTechnicalSummary {
    const { settings, stability, stats, stress, blocks } = result;
    const base = { kind: issue.kind, cells };
    switch (issue.kind) {
        case "empty":
            return { ...base, metric: `Blocks filled to at least ${pct(settings.fillThreshold)} (fill threshold)`, measured: 0, limit: 1, unit: "blocks", bound: "min" };
        case "cog-outside":
            return {
                ...base,
                metric: "Centre-of-gravity margin to the support base",
                // Signed: negative is outside the base. An error is held to 0, the edge warning to the report's 1 mm.
                measured: stability ? r1(stability.marginMm) : null,
                limit: issue.severity === "error" ? 0 : EDGE_MARGIN_MM,
                unit: "mm",
                bound: "min",
            };
        case "cantilever-too-long": {
            const run = result.cantilevers.find((r) => `cantilever-${r.id}` === issue.id);
            const reaches = issue.blocks.map((id) => blocks[id]?.reach ?? 0);
            const reach = run ? run.reach : reaches.length > 0 ? Math.max(...reaches) : null;
            return { ...base, metric: "Cantilever reach", measured: reach, limit: settings.cantileverLimit, unit: "blocks", bound: "max" };
        }
        case "floating": {
            const body = result.bodies.find((b) => `floating-${b.id}` === issue.id);
            return { ...base, metric: "Blocks with no load path to the ground", measured: body ? body.blocks.length : issue.blocks.length, limit: 0, unit: "blocks", bound: "max" };
        }
        case "too-many-blocks":
            return { ...base, metric: "Components used", measured: stats.blockCount, limit: settings.maxBlocks, unit: "blocks", bound: settings.maxBlocks === null ? null : "max" };
        case "thin-features":
            // Two findings share the kind: too little of the model kept (coverage), or thin joints that would connect floating parts.
            return stats.coverage < COVERAGE_WARN
                ? { ...base, metric: "Coverage (share of the model's volume inside blocks)", measured: r3(stats.coverage), limit: COVERAGE_WARN, unit: "ratio", bound: "min" }
                : { ...base, metric: "Floating blocks a lower fill threshold would connect", measured: issue.blocks.length, limit: 0, unit: "blocks", bound: "max" };
        case "overstressed":
        case "highly-stressed": {
            const peak = issue.blocks[0];
            const u = stress && peak !== undefined ? stress.byBlock[peak] : Number.NaN;
            return {
                ...base,
                metric: "Joint utilisation (share of the allowable stress)",
                measured: Number.isFinite(u) ? r3(u) : null,
                limit: issue.kind === "overstressed" ? STRESS_FAIL : STRESS_WARN,
                unit: "ratio",
                bound: "max",
                // A joint is its peak block; the rest of the issue's blocks are the region around it.
                cells: peak !== undefined && blocks[peak] ? [[...blocks[peak].cell]] : [],
            };
        }
    }
}

/** The analysis as a plain object (what buildReportJson prints). */
export function buildReport(result: AnalysisResult, meta: ReportMeta = {}): ReportDocument {
    const { blocks, stability, stress, assembly } = result;
    const cells = (ids: number[]) => ids.map((id) => [...blocks[id].cell] as [number, number, number]);
    const errors = result.issues.filter((issue) => issue.severity === "error").length;
    const utilisationOf = (index: number): number | null => {
        const u = stress ? stress.byBlock[index] : Number.NaN;
        return Number.isFinite(u) ? r3(u) : null;
    };
    return {
        report: "block-structure-analysis",
        version: 1,
        generated_at: meta.generatedAt ?? new Date().toISOString(),
        model: { ...meta, generatedAt: undefined, derived: undefined },
        verdict: { passes: errors === 0, errors, warnings: result.issues.length - errors },
        settings: result.settings,
        scaling: {
            size_mm: result.sizeMm.map(r1) as [number, number, number],
            scale_factor: result.transform.factor,
            offset_mm: result.transform.offsetMm.map(r1) as [number, number, number],
            grid: result.gridSize,
        },
        checks: result.checks,
        issues: result.issues.map((issue) => ({
            id: issue.id,
            kind: issue.kind,
            severity: issue.severity,
            title: issue.title,
            detail: issue.detail,
            technical: technicalLine(issue, result),
            technical_summary: technicalSummary(issue, result, cells(issue.blocks)),
            focus_mm: issue.focusMm.map(r1) as [number, number, number],
            blocks: issue.blocks,
            cells: cells(issue.blocks),
        })),
        stability: stability && {
            cog_mm: stability.cogMm.map(r1) as [number, number, number],
            inside_base: stability.inside,
            margin_mm: r1(stability.marginMm),
            tip_direction: stability.tipDirection && [r3(stability.tipDirection[0]), r3(stability.tipDirection[1])],
            pivot_mm: stability.pivotMm.map(r1) as [number, number],
            support_base_mm: stability.supportHull.map((p) => [r1(p[0]), r1(p[1])] as [number, number]),
            body: stability.bodyId ?? null,
            grounded_bodies: stability.groundedBodies ?? 1,
        },
        cantilever_runs: result.cantilevers.map((run) => ({
            id: run.id,
            reach: run.reach,
            blocks: run.blocks.length,
            over_limit_blocks: run.overLimit.length,
            layers: run.layers,
            roots: run.roots,
        })),
        bodies: result.bodies.map((body) => ({ id: body.id, blocks: body.blocks.length, grounded: body.grounded })),
        stats: result.stats,
        blocks: blocks.map((b) => ({
            index: b.index,
            cell: b.cell,
            centre_mm: b.centerMm,
            status: b.status,
            reach: b.reach,
            body: b.body,
            fill: r3(b.fill),
            ...(b.role !== undefined ? { role: b.role, step: b.step ?? 0 } : {}),
            ...(stress ? { utilisation: utilisationOf(b.index) } : {}),
        })),
        definitions: DEFINITIONS,
        stress: stress ? stressReport(result) : null,
        ...(assembly ? { assembly: assemblyReport(result) } : {}),
        ...(meta.derived ? { stabilization: meta.derived } : {}),
    };
}

function stressReport(result: AnalysisResult): NonNullable<ReportDocument["stress"]> {
    const stress = result.stress;
    if (!stress) throw new Error("No stress estimate to report.");
    const m = materialOf(stress.material).fem;
    const at = stress.maxBlock === null ? null : result.blocks[stress.maxBlock];
    const triple = (v: readonly number[]) => v.map(r1) as [number, number, number];
    return {
        load_case: stress.loadCase,
        material: {
            id: stress.material,
            name: m.name,
            density_kg_m3: m.rho,
            youngs_modulus_gpa: m.E / 1e9,
            joint_tension_mpa: m.jointTension / 1e6,
            compression_mpa: m.compression / 1e6,
            shear_mpa: m.shear / 1e6,
        },
        solver: { name: "Awatif FEM (open source, MIT)", backend: stress.solver.backend, ms: r1(stress.solver.ms) },
        thresholds: { warn: STRESS_WARN, fail: STRESS_FAIL },
        max_utilisation: r3(stress.maxUtilisation),
        max_at: at ? { cell: [...at.cell], centre_mm: triple(at.centerMm) } : null,
        stressed_blocks: stress.stressedBlocks,
        overstressed_blocks: stress.overstressedBlocks,
        analysed_blocks: stress.analysedBlocks,
        unsupported_blocks: stress.unsupportedBlocks,
        points: stress.points.map((p) => ({
            rank: p.rank,
            utilisation: r3(p.utilisation),
            mode: p.mode,
            tension_kpa: r1(p.tensionKPa),
            allowable_kpa: r1(p.allowableKPa),
            cell: [...p.cell],
            centre_mm: triple(p.centreMm),
            joint: p.joint && [[...p.joint[0]], [...p.joint[1]]],
            blocks: p.blocks.length,
        })),
        assumptions: STRESS_ASSUMPTIONS,
    };
}

function assemblyReport(result: AnalysisResult): NonNullable<ReportDocument["assembly"]> {
    const info = result.assembly;
    if (!info) throw new Error("No assembly to report.");
    const role_counts = Object.fromEntries(BLOCK_ROLES.map((role, n) => [role, info.roleCounts[n] ?? 0])) as Record<BlockRole, number>;
    const total = info.roleCounts.reduce((sum, n) => sum + n, 0);
    return { blocks: total, added_blocks: total - role_counts.original, steps: info.steps, role_counts };
}

/** The report as pretty-printed JSON, ready to download. */
export function buildReportJson(result: AnalysisResult, meta: ReportMeta = {}): string {
    return JSON.stringify(buildReport(result, meta), null, 2);
}

/**
 * One row per block: index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill,role,step,utilisation (x/y/z = block centre).
 * role and step are empty unless the model is a block assembly; utilisation (0.73 = 73 % of the allowable) is empty
 * where there is no stress estimate or no load path.
 */
export function buildBlocksCsv(result: AnalysisResult): string {
    const lines = ["index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill,role,step,utilisation"];
    for (const b of result.blocks) {
        const u = result.stress ? result.stress.byBlock[b.index] : Number.NaN;
        lines.push(
            [
                b.index,
                b.cell[0],
                b.cell[1],
                b.cell[2],
                r1(b.centerMm[0]),
                r1(b.centerMm[1]),
                r1(b.centerMm[2]),
                b.status,
                b.reach ?? "",
                b.body,
                r3(b.fill),
                b.role ?? "",
                b.role !== undefined ? (b.step ?? 0) : "",
                Number.isFinite(u) ? r3(u) : "",
            ].join(","),
        );
    }
    return `${lines.join("\n")}\n`;
}
