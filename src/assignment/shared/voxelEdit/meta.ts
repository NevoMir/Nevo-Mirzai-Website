// Building the log that is saved with an edited block version (VoxelEditLog, log.ts) from what the editing session knows.

import type { AnalysisSummary, StabilizationMetrics } from "../contract.ts";
import { assemblyHash, type AssemblyDescriptor } from "../assembly.ts";
import { descriptorOfGrid, labelString, type EditGrid } from "./grid.ts";
import type { VoxelEditLog } from "./log.ts";
import type { AppliedOp, EditReport, RawAnswer, VoxelEditEntry } from "./ops.ts";
import { flatInstruction } from "./text.ts";

/** The figures the stabilizer's log also keeps, from an analysis summary. */
export function metricsOfSummary(s: AnalysisSummary): StabilizationMetrics {
    return {
        blocks: s.blocks,
        errors: s.errors,
        warnings: s.warnings,
        floating_blocks: s.floating_blocks,
        over_limit: s.over_limit,
        longest_cantilever: s.longest_cantilever,
        cog_margin_mm: s.cog_mm === null ? null : s.cog_margin_mm,
        max_utilisation: s.stress ? s.stress.max_utilisation : null,
        overstressed_blocks: s.stress?.overstressed_blocks ?? 0,
    };
}

/** One applied instruction as the log keeps it. `n` is 1-based within the version being saved. */
export function logEntry(
    n: number,
    instruction: string,
    answer: Pick<RawAnswer, "summary" | "notes">,
    report: Pick<EditReport, "applied" | "added" | "removed" | "moved" | "protectedKept">,
    model: string,
    costUsd: number | null,
): VoxelEditEntry {
    return {
        n,
        // One line, no control characters: the log validator refuses them, and a version that cannot be written would be lost with its draft.
        instruction: flatInstruction(instruction) || "(no text)",
        summary: answer.summary.slice(0, 200) || summaryOf(report.applied),
        notes: answer.notes.slice(0, 200),
        ops: report.applied.map((a: AppliedOp) => a.op),
        added: report.added,
        removed: report.removed,
        moved: report.moved,
        skipped_protected: report.protectedKept,
        model: model.slice(0, 64),
        cost_usd: costUsd,
    };
}

/** A sentence from the numbers, for an answer whose own summary is empty. */
export function summaryOf(applied: readonly AppliedOp[]): string {
    const parts = applied.map((a) => a.text);
    return parts.length > 0 ? `${parts.join("; ")}.`.replace(/^./, (ch) => ch.toUpperCase()).slice(0, 200) : "No change.";
}

export interface EditSessionState {
    /** Highest step among the blocks of the version the session started from. */
    baseSteps: number;
    /** Versions above the one the session started from (0 for an original, 1 for a version made from it, ...). The saved version is one deeper. */
    sourceDepth: number;
    /** Stabilizations above it (0 for a plain model). */
    stabilizedDepth: number;
    entries: VoxelEditEntry[];
    grid: EditGrid;
    /** The analysis summary of the version the session started from, and of the draft. */
    beforeSummary: AnalysisSummary;
    afterSummary: AnalysisSummary;
    createdAt: string;
}

/** The log and the descriptor to save as a new edited version. Async only for the SHA-256. */
export async function buildEditVersion(state: EditSessionState): Promise<{ descriptor: AssemblyDescriptor; log: VoxelEditLog }> {
    const descriptor = descriptorOfGrid(state.grid);
    const log: VoxelEditLog = {
        version: 1,
        depth: state.sourceDepth + 1,
        stabilized_depth: state.stabilizedDepth,
        base_steps: state.baseSteps,
        // Defence in depth: a draft kept before the words were flattened at the entry still saves.
        edits: state.entries.map((e) => (flatInstruction(e.instruction) === e.instruction ? e : { ...e, instruction: flatInstruction(e.instruction) || "(no text)" })),
        parts: [...state.grid.parts],
        labels: labelString(state.grid),
        before: metricsOfSummary(state.beforeSummary),
        after: metricsOfSummary(state.afterSummary),
        assembly_hash: await assemblyHash(descriptor),
        after_summary: state.afterSummary,
        created_at: state.createdAt,
    };
    return { descriptor, log };
}
