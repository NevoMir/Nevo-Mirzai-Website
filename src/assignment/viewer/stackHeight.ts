// What the chip stack reserves at the top of the stage, as a plain function (GlbViewer measures the stack and renders around
// it; the tests pin the rule). Pure: no three.js, no DOM.

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
