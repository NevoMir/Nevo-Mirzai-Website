// What the stage's own view controls say and offer, as plain functions (ColorChip and ViewerToolbar render them; the tests
// pin them). The colour menu: which colourings there are, which cannot be used and why. The layer cut: how it reads in the
// toolbar button, its badge and its popover. Pure: no three.js, no DOM.
import type { AnalysisColorBy, AnalysisResult, Block } from "../analysis/types.ts";
import { COLOR_MODE_HINTS, COLOR_MODE_LABELS, topLayer } from "./analysisGeometry.ts";

// ---------- the colour menu ----------

/** The result on stage has blocks the stabilizer added: it is a whole stabilized model, not the blocks it started from. */
export function hasAddedBlocks(result: Pick<AnalysisResult, "assembly"> | null | undefined): boolean {
    return !!result?.assembly && result.assembly.roleCounts.some((n, role) => role > 0 && n > 0);
}

export interface ColorOption {
    value: AnalysisColorBy;
    label: string;
    /** The one plain line under the name. */
    hint: string;
    /** The colouring cannot be used on this result: the menu shows it greyed, with `reason` in place of the hint. */
    disabled?: boolean;
    reason?: string;
}

/** The order of the menu. "role" (Added blocks) is only offered where something was added. */
const ORDER: readonly AnalysisColorBy[] = ["status", "reach", "stress", "layer", "role"];

export interface ColorOptionsInput {
    /** The result on stage (null: nothing to colour). */
    analysis: Pick<AnalysisResult, "stress" | "assembly"> | null | undefined;
    /** An analysis is running: a missing strength estimate may still come. */
    busy?: boolean;
    /** The colouring on stage. Always represented in the menu, whatever the result can do. */
    current?: AnalysisColorBy;
}

/**
 * The colourings the menu lists. Strength needs the stress estimate (greyed with the reason when it is missing or still on its
 * way); Added blocks appears only when blocks were added (or is what is on stage).
 */
export function colorOptions({ analysis, busy = false, current }: ColorOptionsInput): ColorOption[] {
    const added = hasAddedBlocks(analysis);
    const options: ColorOption[] = [];
    for (const value of ORDER) {
        if (value === "role" && !added && current !== "role") continue;
        const option: ColorOption = { value, label: COLOR_MODE_LABELS[value], hint: COLOR_MODE_HINTS[value] };
        if (value === "stress" && !analysis?.stress) {
            option.disabled = true;
            option.reason = busy ? "Still being worked out." : "There is no strength estimate for this model.";
        }
        options.push(option);
    }
    return options;
}

/** What the chip reads while the stabilizer previews a run: the stage paints what it added whatever was chosen. */
export const PREVIEW_COLOR_LABEL = "Added blocks (live preview)";

export interface ColorChipModel {
    /** The colouring on stage, resolved against the result (see resolveColorBy). */
    value: AnalysisColorBy;
    options: ColorOption[];
    /** The chip's visible text: "Colour: Status", or "Colour: Added blocks (live preview)" while it is locked. */
    text: string;
    /** Set while the stage is locked to a colouring (the live preview); the menu cannot be opened. */
    locked?: string;
}

export function colorChipModel({ analysis, colorBy, previewing = false, busy = false }: { analysis: ColorOptionsInput["analysis"]; colorBy: AnalysisColorBy; previewing?: boolean; busy?: boolean }): ColorChipModel {
    const options = colorOptions({ analysis, busy, current: colorBy });
    if (previewing) return { value: "role", options, text: `Colour: ${PREVIEW_COLOR_LABEL}`, locked: PREVIEW_COLOR_LABEL };
    return { value: colorBy, options, text: `Colour: ${COLOR_MODE_LABELS[colorBy]}` };
}

// ---------- the layer cut ----------

export interface LayerCut {
    /** Layers the model has (at least 1). */
    count: number;
    /** Layers shown, counted from the ground (1..count). */
    shown: number;
    /** The cut hides something: the top layer is above it. */
    cut: boolean;
    /** The cut as the slider's value: the highest layer shown, from 0. */
    max: number;
    /** On the toolbar button when a cut is active: "1–7" (or "1"); null when everything is shown. */
    badge: string | null;
    /** The popover's heading: "Layers 1–7 of 10". */
    heading: string;
    /** "up to 700 mm". */
    upTo: string;
}

const range = (shown: number) => (shown === 1 ? "1" : `1–${shown}`);

/** How the layer cut reads for `layerMax` (the highest layer shown, from 0; anything past the top shows everything). */
export function layerCut(blocks: readonly Pick<Block, "cell">[], layerMax: number, blockMm: number): LayerCut {
    const count = Math.max(1, topLayer(blocks) + 1);
    const max = Math.min(count - 1, Math.max(0, Number.isFinite(layerMax) ? Math.round(layerMax) : count - 1));
    const shown = max + 1;
    const cut = shown < count;
    return {
        count,
        shown,
        cut,
        max,
        badge: cut ? range(shown) : null,
        heading: `${shown === 1 ? "Layer" : "Layers"} ${range(shown)} of ${count}`,
        upTo: `up to ${Math.round(shown * blockMm)} mm`,
    };
}
