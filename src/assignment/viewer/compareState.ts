// What the Compare chip says and what the chip stack reserves, as plain functions (GlbViewer renders them; the tests pin them).
// Pure: no three.js, no DOM.
import type { AnalysisResult, CompareMode } from "../analysis/types.ts";

/** Where the analysis of the original half stands (the store's originalState). */
export type CompareStatus = "idle" | "loading" | "error";

/** The result on stage still has blocks the stabilizer added: it is the whole stabilized model, not the original half. */
export function hasAddedBlocks(result: Pick<AnalysisResult, "assembly"> | null | undefined): boolean {
    return !!result?.assembly && result.assembly.roleCounts.some((n, role) => role > 0 && n > 0);
}

export interface CompareInput {
    /** The chip is on (a stabilized model, in the block view). */
    on: boolean;
    /** What the workspace asked to see. */
    requested: CompareMode;
    /** The stabilizer's preview is on stage instead of the result. */
    previewing: boolean;
    /** The result on stage has added blocks (hasAddedBlocks). */
    addedOnStage: boolean;
    /** The workspace's word on the original half; undefined: it does not say. */
    status?: CompareStatus;
}

export interface CompareState {
    /** The pressed button: what is on stage. null while the preview is (none of the three is). */
    value: CompareMode | null;
    /** Original was asked for and the stage still draws the whole stabilized model: the original half is being analysed. */
    waiting: boolean;
    /** The workspace says the original half could not be analysed. */
    failed: boolean;
    /** Waiting with no word that it is loading (or failed): the viewer gives up after a while. */
    unreported: boolean;
}

export function compareState({ on, requested, previewing, addedOnStage, status }: CompareInput): CompareState {
    const waiting = on && !previewing && requested === "original" && addedOnStage;
    return {
        value: previewing ? null : waiting ? "stabilized" : requested,
        waiting,
        failed: waiting && status === "error",
        unreported: waiting && status !== "loading" && status !== "error",
    };
}

/** A measured chip stack: its height with the gap above it, and which view (blocks or model) it was measured in. */
export interface MeasuredStack {
    blocks: boolean;
    px: number;
}

/**
 * The height the camera keeps clear for the chip stack: what was measured in the view on screen, else the estimate (the
 * measurement of the other view, or none yet, or an element with no size, say nothing about this one).
 */
export function stackHeight(measured: MeasuredStack | null, blocks: boolean, estimate: number, topPx: number): number {
    return measured && measured.blocks === blocks && measured.px > topPx ? measured.px : estimate;
}
