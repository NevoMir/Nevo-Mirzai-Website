// The pure side of the "added supports" overlay: a stabilized model shown on its SOURCE mesh in the 3D tab draws only the
// blocks the stabilizer added (columns, footings, brackets, bridges, reinforcement) as solid cubes where they belong on
// the mesh. This file decides which blocks those are, what the chip, the tooltip and the card say about them, and where a
// cell lands in the viewer's display frame. No three.js and no DOM, so Node can test all of it (see supportsLayer.ts for
// the cubes themselves, useSupportsOverlay.ts for the lifecycle).
//
// The result the overlay is given is the analysis of the stabilized assembly under the SOURCE model's transform
// (`transform` maps the source mesh's display frame to analysis mm), so a block's `centerMm` goes through the same
// mmToDisplay the block view uses and lands on the mesh.
import type { AnalysisResult, AnalysisSettings, AnalysisTransform, Block, Vec3 } from "../analysis/types.ts";
import { ROLE_HEX } from "../shared/assembly.ts";
import { BLOCK_ROLES, type AddedRole } from "../shared/contract.ts";
import { ROLE_LABELS, mmToDisplay } from "./analysisGeometry.ts";

// ---------- which blocks ----------

/** A block the stabilizer added: it has a role and the role is not "original". */
export const isAddedBlock = (block: Pick<Block, "role">): boolean => !!block.role && block.role !== "original";

/** Indices (into `AnalysisResult.blocks`) of the added blocks, ascending. */
export function addedBlockIndices(blocks: readonly Pick<Block, "role">[]): number[] {
    const out: number[] = [];
    blocks.forEach((block, i) => {
        if (isAddedBlock(block)) out.push(i);
    });
    return out;
}

/** The overlay has something to draw: a result with at least one added block. */
export const hasAddedSupports = (result: Pick<AnalysisResult, "blocks"> | null | undefined): boolean => !!result && result.blocks.some(isAddedBlock);

// ---------- ids (a support is picked by the viewer like a part is, under an id of its own) ----------

export const SUPPORT_ID_PREFIX = "support:";
export const supportId = (index: number): string => `${SUPPORT_ID_PREFIX}${index}`;
/** The block index a pick id names, or null when it is not a support's id (a part's id is "p1", "s2"). */
export function supportIndexOf(id: string | null | undefined): number | null {
    if (typeof id !== "string" || !id.startsWith(SUPPORT_ID_PREFIX)) return null;
    const text = id.slice(SUPPORT_ID_PREFIX.length);
    const index = Number(text);
    return text !== "" && Number.isInteger(index) && index >= 0 ? index : null;
}

/** What the pointer is over, sorted into the three things the viewer reacts to. */
export interface HoverRoute {
    /** Block index of an added support under the pointer, else null. */
    support: number | null;
    /** The part to light as hovered (the scene's blue tint), else null. */
    part: string | null;
    /** The id the identify tooltip describes (a support's id or a part's id), else null. */
    tip: string | null;
}

/**
 * Where a hover hit goes. A support is lit by the overlay and described by its own tooltip. A part is lit and described only in
 * a model that has several: a one-part model "has nothing to point at" (the pointer tracks it only so the cubes can be hovered),
 * so over its lone mesh neither the tint nor the part tooltip appears, as on a version without supports.
 */
export function routeHover(id: string | null | undefined, partCount: number): HoverRoute {
    const support = supportIndexOf(id);
    if (support !== null) return { support, part: null, tip: id ?? null };
    const part = typeof id === "string" && id !== "" && partCount > 1 ? id : null;
    return { support: null, part, tip: part };
}

/**
 * The added supports are on the stage as cubes to point at: there are some, their switch is on, the parts are not exploded (the
 * cubes are put away then, they would be left behind) and the block view is not showing. Hover, the tooltip and the card of a
 * cube all follow this, so none of them speaks for a cube that is not drawn.
 */
export const supportsDrawn = (state: { has: boolean; shown: boolean; explode: number; blocks: boolean }): boolean => state.has && state.shown && state.explode === 0 && !state.blocks;

// ---------- wording ----------

/** What a role is called in a count: "1 column", "5 columns". */
export const ROLE_NOUNS: Record<AddedRole, readonly [singular: string, plural: string]> = {
    column: ["column", "columns"],
    footing: ["footing", "footings"],
    bracket: ["bracket", "brackets"],
    bridge: ["bridge", "bridges"],
    reinforcement: ["reinforcement", "reinforcements"],
};

export interface SupportCount {
    role: AddedRole;
    /** Blocks of that role. */
    count: number;
    /** "1 column", "5 columns". */
    label: string;
    color: string;
}

/** Blocks added per role, in BLOCK_ROLES order, roles with none left out. */
export function supportCounts(blocks: readonly Pick<Block, "role">[]): SupportCount[] {
    const counts = new Map<AddedRole, number>();
    for (const block of blocks) {
        if (!block.role || block.role === "original") continue;
        counts.set(block.role, (counts.get(block.role) ?? 0) + 1);
    }
    const out: SupportCount[] = [];
    for (const role of BLOCK_ROLES) {
        if (role === "original") continue;
        const count = counts.get(role) ?? 0;
        if (count > 0) out.push({ role, count, label: `${count} ${ROLE_NOUNS[role][count === 1 ? 0 : 1]}`, color: ROLE_HEX[role] });
    }
    return out;
}

/** The stage chip's text: "Added supports: 1 column · 1 footing". Empty when nothing was added. */
export function supportsLegendText(counts: readonly SupportCount[]): string {
    return counts.length ? `Added supports: ${counts.map((c) => c.label).join(" · ")}` : "";
}

/** Blocks the stabilizer added, all roles. */
export const supportsTotal = (counts: readonly SupportCount[]): number => counts.reduce((sum, c) => sum + c.count, 0);

export interface SupportInfo {
    /** Index into AnalysisResult.blocks. */
    index: number;
    role: AddedRole;
    /** "Column". */
    roleLabel: string;
    color: string;
    /** The step on screen, counted from 1; null when the block comes from an earlier version of the model. */
    step: number | null;
    /** "added in step 1" / "added in an earlier version". */
    when: string;
    /** The hover tooltip: "Column · added in step 1". */
    tooltip: string;
    /** The selection card's title: "Added support: column, step 1". */
    heading: string;
    /** Where it is, in words: "0–100 mm up". No cell coordinates. */
    zRange: string;
    /** All of it on one line, for assistive technology and tests. */
    text: string;
}

/**
 * What a block the stabilizer added says about itself. `stepOffset`: the steps of earlier runs the model carries; a block
 * is numbered in the run on screen from 1 (as analysisGeometry.addedWhen does for the block view). Null for an original block.
 */
export function describeSupport(block: Block, settings: Pick<AnalysisSettings, "blockSizeMm">, stepOffset = 0): SupportInfo | null {
    if (!isAddedBlock(block) || !block.role || block.role === "original") return null;
    const role = block.role;
    const roleLabel = ROLE_LABELS[role];
    const own = (block.step ?? stepOffset + 1) - stepOffset;
    const step = own > 0 ? own : null;
    const when = step === null ? "added in an earlier version" : `added in step ${step}`;
    const half = settings.blockSizeMm / 2;
    const zRange = `${Math.round(block.centerMm[2] - half)}–${Math.round(block.centerMm[2] + half)} mm up`;
    const tooltip = `${roleLabel} · ${when}`;
    return {
        index: block.index,
        role,
        roleLabel,
        color: ROLE_HEX[role],
        step,
        when,
        tooltip,
        heading: `Added support: ${roleLabel.toLowerCase()}, ${step === null ? "earlier version" : `step ${step}`}`,
        zRange,
        text: `${tooltip} · ${zRange}`,
    };
}

// ---------- frames ----------

/** The transform the overlay places cubes with: a factor that is not a positive number would collapse the cubes, so it falls back to 1 (as the block view does). */
export function usableTransform(transform: AnalysisTransform): AnalysisTransform {
    return transform.factor > 0 && Number.isFinite(transform.factor) ? transform : { ...transform, factor: 1 };
}

/** The centre of a block in the viewer's display frame (the frame of the loaded mesh, which the result's transform maps to analysis mm). */
export function blockDisplayCenter(block: Pick<Block, "centerMm">, transform: AnalysisTransform): Vec3 {
    return mmToDisplay(block.centerMm, usableTransform(transform));
}

/** The box of a block's whole cell in the display frame. */
export function blockDisplayBox(block: Pick<Block, "centerMm">, cellMm: number, transform: AnalysisTransform): { min: Vec3; max: Vec3 } {
    const t = usableTransform(transform);
    const h = cellMm / 2;
    const [c0, c1] = [mmToDisplay([block.centerMm[0] - h, block.centerMm[1] - h, block.centerMm[2] - h], t), mmToDisplay([block.centerMm[0] + h, block.centerMm[1] + h, block.centerMm[2] + h], t)];
    return { min: [Math.min(c0[0], c1[0]), Math.min(c0[1], c1[1]), Math.min(c0[2], c1[2])], max: [Math.max(c0[0], c1[0]), Math.max(c0[1], c1[1]), Math.max(c0[2], c1[2])] };
}

/** The box that holds every added block, in the display frame: what Fit has to include (a footing can stick out of the mesh). Null when nothing was added. */
export function supportsDisplayBox(result: Pick<AnalysisResult, "blocks" | "settings" | "transform">): { min: Vec3; max: Vec3 } | null {
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const block of result.blocks) {
        if (!isAddedBlock(block)) continue;
        const box = blockDisplayBox(block, result.settings.blockSizeMm, result.transform);
        if (!min || !max) {
            min = [...box.min];
            max = [...box.max];
        } else {
            for (let a = 0; a < 3; a += 1) {
                min[a] = Math.min(min[a], box.min[a]);
                max[a] = Math.max(max[a], box.max[a]);
            }
        }
    }
    return min && max ? { min, max } : null;
}
