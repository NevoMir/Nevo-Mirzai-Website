// Downloads: a JSON report of the whole analysis and a CSV of the blocks.

import type { AnalysisResult, Block, CheckRow, Issue } from "./types.ts";
import { DEFINITIONS } from "./definitions.ts";
import type { Definition } from "./definitions.ts";

export interface ReportMeta {
    modelId?: string;
    modelName?: string;
    modelUrl?: string;
    prompt?: string;
    provider?: string;
    /** ISO date; defaults to the time the report is built. */
    generatedAt?: string;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface ReportDocument {
    report: "block-structure-analysis";
    version: 1;
    generated_at: string;
    model: ReportMeta;
    verdict: { passes: boolean; errors: number; warnings: number };
    settings: AnalysisResult["settings"];
    scaling: { size_mm: [number, number, number]; scale_factor: number; offset_mm: [number, number, number]; grid: [number, number, number] };
    checks: CheckRow[];
    issues: Array<Omit<Issue, "blocks" | "focusMm"> & { focus_mm: [number, number, number]; blocks: number[]; cells: Array<[number, number, number]> }>;
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
    blocks: Array<{ index: number; cell: [number, number, number]; centre_mm: [number, number, number]; status: Block["status"]; reach: number | null; body: number; fill: number }>;
    definitions: Definition[];
}

/** The analysis as a plain object (what buildReportJson prints). */
export function buildReport(result: AnalysisResult, meta: ReportMeta = {}): ReportDocument {
    const { blocks, stability } = result;
    const cells = (ids: number[]) => ids.map((id) => [...blocks[id].cell] as [number, number, number]);
    const errors = result.issues.filter((issue) => issue.severity === "error").length;
    return {
        report: "block-structure-analysis",
        version: 1,
        generated_at: meta.generatedAt ?? new Date().toISOString(),
        model: { ...meta, generatedAt: undefined },
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
        blocks: blocks.map((b) => ({ index: b.index, cell: b.cell, centre_mm: b.centerMm, status: b.status, reach: b.reach, body: b.body, fill: r3(b.fill) })),
        definitions: DEFINITIONS,
    };
}

/** The report as pretty-printed JSON, ready to download. */
export function buildReportJson(result: AnalysisResult, meta: ReportMeta = {}): string {
    return JSON.stringify(buildReport(result, meta), null, 2);
}

/** One row per block: index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill (x/y/z = block centre). */
export function buildBlocksCsv(result: AnalysisResult): string {
    const lines = ["index,i,j,k,x_mm,y_mm,z_mm,status,reach,body,fill"];
    for (const b of result.blocks) {
        lines.push([b.index, b.cell[0], b.cell[1], b.cell[2], r1(b.centerMm[0]), r1(b.centerMm[1]), r1(b.centerMm[2]), b.status, b.reach ?? "", b.body, r3(b.fill)].join(","));
    }
    return `${lines.join("\n")}\n`;
}
