// Structural analysis of a generated model as an assembly of 100 mm blocks.
//
// Pipeline (runs in the browser, in a Web Worker): triangles of the loaded model -> scaled so the longest side
// fits the 1000 mm target volume, bottom on the ground -> solid voxelisation into 100 mm blocks -> structural
// and stability checks -> issues that point at the blocks causing them.
//
// Frame: "analysis mm", Z-up, origin at the min corner of the 10 x 10 x 10 target grid. The scaled model is
// centred in X/Y inside the 1000 x 1000 footprint and rests on z = 0. Grid cell (i, j, k) spans
// [i*100, (i+1)*100) x [j*100, (j+1)*100) x [k*100, (k+1)*100); k is the layer (0 = on the ground).

import type { AnalysisSummary, BlockRole, MaterialId } from "@/assignment/shared/contract";
import type { AssemblyDescriptor } from "@/assignment/shared/assembly";

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface AnalysisSettings {
    targetSizeMm: number; // the longest side of the model is scaled to this (1000)
    blockSizeMm: number; // edge of one block (100)
    /**
     * 0-1: share of a block's volume the model must fill for the block to be used. The fill is an estimate that
     * errs high by up to 8 points per exposed face (see voxelize.ts), so this is "about this much of the block".
     */
    fillThreshold: number;
    cantileverLimit: number; // longest allowed cantilever, in blocks (4)
    maxBlocks: number | null; // optional budget of components; null = no limit
    /** What the blocks are made of, for the stress estimate (analysis/materials.ts). Does not change the voxel grid. */
    material: MaterialId;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
    targetSizeMm: 1000,
    blockSizeMm: 100,
    // 10%: a 40-60 mm leg or arm fills only 10-35% of the block it stands in (less where it straddles a block
    // boundary), so a higher threshold drops thin furniture legs and the whole model floats. It cannot go lower
    // because one layer of fine cells (voxelize.ts) is 1/12 = 8.3% of a block: a face that merely grazes the
    // next block, or lies exactly on the boundary between two blocks, must stay under the threshold or it turns
    // that block into a component of its own. 10% is also the lowest value the settings panel offers.
    fillThreshold: 0.1,
    cantileverLimit: 4,
    maxBlocks: null,
    material: "concrete",
};

/** Input: a triangle soup, 9 floats per triangle (x, y, z of 3 vertices), Z-up, any units/placement. */
export interface TriangleSoup {
    positions: Float32Array;
}

/** model space -> analysis mm: mm = (p - modelMin) * factor + offsetMm. */
export interface AnalysisTransform {
    factor: number;
    modelMin: Vec3;
    offsetMm: Vec3;
}

export type BlockStatus =
    | "supported" // on the ground, or on a column of blocks that reaches the ground
    | "cantilever" // nothing under it, held sideways within the limit
    | "overreach" // a cantilever further than cantileverLimit blocks from its last support
    | "floating"; // part of a body that does not touch the ground

export interface Block {
    index: number; // position in AnalysisResult.blocks
    cell: Vec3; // grid coordinates i, j, k
    centerMm: Vec3;
    status: BlockStatus;
    /**
     * Horizontal blocks to the nearest supported block (0 = supported); null for floating blocks. A step goes to
     * a block that shares a face, or diagonally across a corner (one step, not two) when at least one of the two
     * blocks beside that corner exists, so a plate is measured by its overhang, not by a staircase to its corner.
     */
    reach: number | null;
    body: number; // id of the connected structure it belongs to
    fill: number; // 0-1 share of the block filled by the model
    cantilever: number | null; // id of the CantileverRun it belongs to
    /** Only for a block assembly (a stabilized model): what the block is for, and the stabilizer step that added it (0 = original). */
    role?: BlockRole;
    step?: number;
}

/** A connected group of blocks that have nothing underneath (an overhang, arm, bridge or hanging part). */
export interface CantileverRun {
    id: number;
    blocks: number[];
    roots: number[]; // supported blocks it is attached to
    reach: number; // longest horizontal distance from a support, in blocks
    overLimit: number[]; // blocks with reach > cantileverLimit
    layers: Vec2; // lowest and highest layer k
}

/** A 6-connected structure. */
export interface Body {
    id: number;
    blocks: number[];
    grounded: boolean;
}

/**
 * Stability of the weakest free-standing structure. Every grounded body is judged on its own (its centre of
 * gravity against the base made of its own ground blocks): bodies that share no face carry no load between them,
 * so one piece cannot be kept up by an unrelated one. The body with the smallest margin is reported here; with a
 * single grounded body (the usual case) that is simply the whole design.
 */
export interface Stability {
    cogMm: Vec3; // centre of gravity of that body's blocks (uniform block mass)
    groundPointMm: Vec2; // the COG projected on the ground
    supportHull: Vec2[]; // convex hull (CCW, mm) of that body's ground footprint: its support base
    footprint: Vec2[]; // grid cells (i, j) of that body's blocks on the ground
    inside: boolean;
    /** Signed distance from the ground point to the hull edge: > 0 inside (safety margin), < 0 outside. */
    marginMm: number;
    /** Unit vector the structure would tip towards when the COG is outside; null when inside. */
    tipDirection: Vec2 | null;
    /** Nearest point of the hull to the ground point (where it would pivot). */
    pivotMm: Vec2;
    /** The grounded body these numbers belong to (an id of AnalysisResult.bodies). */
    bodyId?: number;
    /** How many grounded bodies were judged (1 for a design in one piece). */
    groundedBodies?: number;
}

export type IssueKind =
    | "empty"
    | "cog-outside"
    | "cantilever-too-long"
    | "floating"
    | "too-many-blocks"
    | "thin-features"
    | "overstressed" // a joint carries more than 100 % of the allowable stress (error)
    | "highly-stressed"; // a joint carries more than STRESS_WARN (75 %) of the allowable (warning)

export interface Issue {
    id: string;
    kind: IssueKind;
    severity: "error" | "warning";
    title: string; // "Cantilever too long: 6 blocks"
    detail: string; // the why, in one or two plain sentences with numbers
    blocks: number[]; // the blocks to highlight
    focusMm: Vec3; // where to point the camera and the callout
}

export type CheckKey = "cog" | "cantilevered" | "long-cantilevers" | "components" | "floating" | "stress";

/** The required constraints, one row each, for the report. */
export interface CheckRow {
    key: CheckKey;
    label: string; // "Centre of gravity"
    value: string; // "Inside the base, 120 mm margin"
    status: "pass" | "fail" | "info";
}

export interface AnalysisStats {
    blockCount: number;
    groundBlocks: number;
    cantileveredCount: number; // cantilever + overreach
    longestCantilever: number; // in blocks, 0 when none
    overLimitCount: number;
    floatingCount: number;
    bodyCount: number;
    layers: number; // highest occupied layer + 1
    coverage: number; // 0-1: share of the model's solid volume that ended up inside blocks
}

// ---------- Stress (self-weight, linear frame model: analysis/stress.ts) ----------

export type StressMode = "tension" | "compression" | "shear";

/** A place where the structure is stressed: a group of neighbouring blocks around one peak. */
export interface StressPoint {
    rank: number; // 1 = the worst
    blocks: number[]; // indices into AnalysisResult.blocks; blocks[0] is the peak
    cell: Vec3; // the peak block's grid cell
    centreMm: Vec3;
    utilisation: number; // 0.73 = 73 % of the allowable stress
    mode: StressMode; // which stress governs
    tensionKPa: number; // joint tension at the peak (0 when the joint is in compression)
    allowableKPa: number; // what the material allows for the governing mode
    /** The joint that governs: the two blocks it connects. */
    joint: [Vec3, Vec3] | null;
}

export interface StressAnalysis {
    version: 1;
    loadCase: "self-weight";
    material: MaterialId;
    solver: { name: "Awatif"; backend: "wasm" | "ts"; ms: number };
    /** Utilisation per entry of AnalysisResult.blocks; NaN where there is no load path (the block is in a floating structure). */
    byBlock: Float32Array;
    analysedBlocks: number;
    unsupportedBlocks: number;
    maxUtilisation: number;
    maxBlock: number | null;
    stressedBlocks: number; // > STRESS_WARN (75 %)
    overstressedBlocks: number; // > STRESS_FAIL (100 %)
    points: StressPoint[]; // worst first, at most 8
}

/** For a result that came from a block assembly (a stabilized model) rather than from voxelising a mesh. */
export interface AssemblyInfo {
    descriptor: AssemblyDescriptor;
    /** Blocks per role in BLOCK_ROLES order. */
    roleCounts: number[];
    steps: number; // highest stabilizer step
}

export interface AnalysisResult {
    settings: AnalysisSettings;
    gridSize: Vec3; // cells per axis (10, 10, 10)
    /**
     * Where the lattice sits in the frame of the mesh the viewer draws it over. For a mesh: its own voxelisation transform.
     * For a stabilized model: the transform of the mesh on stage, which is its SOURCE's (the same one voxelising the source
     * gives, voxelize.ts transformForBounds) while the viewer shows the original, or the stabilized GLB's own when that is
     * what is on stage (the source is gone).
     */
    transform: AnalysisTransform;
    sizeMm: Vec3; // the scaled model's bounding box
    blocks: Block[];
    bodies: Body[];
    cantilevers: CantileverRun[];
    stability: Stability | null; // null when nothing touches the ground
    issues: Issue[]; // errors first
    checks: CheckRow[];
    stats: AnalysisStats;
    summary: AnalysisSummary;
    /** null until the stress estimate has run (it is a second stage) or when it could not (nothing stands on the ground). */
    stress: StressAnalysis | null;
    assembly: AssemblyInfo | null;
    timingsMs: { voxelize: number; analyze: number };
}

// ---------- Viewer <-> report panel ----------

export type AnalysisColorBy = "status" | "reach" | "layer" | "stress" | "role";

/** How the viewer shows an analysis. Owned by the workspace, passed to <GlbViewer analysisView>. */
export interface AnalysisViewState {
    mode: "model" | "blocks"; // "blocks" = the analysis view (block assembly + overlays)
    colorBy: AnalysisColorBy;
    layerMax: number; // show layers 0..layerMax (inclusive); >= stats.layers - 1 shows everything
    showGhost: boolean; // the original model, faint, inside the blocks
    showCog: boolean; // COG marker, drop line, support base outline
    highlight: number[]; // block indices to emphasise (others dimmed); [] = none
    /** Bumped to ask the viewer to frame `focusMm` (an issue was clicked); the viewer animates the camera to it. */
    focus: { mm: Vec3; token: number; label?: string } | null;
}

export const DEFAULT_ANALYSIS_VIEW: AnalysisViewState = {
    mode: "model",
    colorBy: "status",
    layerMax: 9,
    showGhost: false,
    showCog: true,
    highlight: [],
    focus: null,
};

/** Handed to the workspace once a GLB is loaded, so it can run the analysis on the same geometry. */
export interface LoadedModel {
    url: string;
    /** The block assembly the GLB declares (a stabilized model), else null: then the triangles are voxelised. */
    assembly: AssemblyDescriptor | null;
    /** The model's triangles in the viewer's frame (Z-up, as loaded: no explode/split offsets). */
    extractTriangles(): TriangleSoup;
}
