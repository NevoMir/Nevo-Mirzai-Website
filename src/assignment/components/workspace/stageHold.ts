// The stage between two versions of one model. A stabilized version is drawn over the mesh it was made from, so flipping between
// the original and a stabilized version (the bar's switch, or the switch a saved run makes by itself) changes the active model
// but not the mesh on stage. The new model has no result of its own until its analysis lands, and without one the viewer drops the
// block view for the plain mesh: the stage flashes to the model chrome (the part count, the Parts list, a different toolbar), the
// camera is framed again for it, and again when the blocks come back, right after the user was watching the stabilizer's preview.
//
// The fix is to keep drawing what the stage drew last until the new version's own result lands. What the report says does not
// change: the panel keeps its skeleton (and no verdict) until the new model's result exists. Only the stage holds.
//
// Pure (`holdStage`) and a hook around it (`useHeldStage`). Generic over the result type and free of imports other than "react",
// so a Node test can run both.

import { useRef } from "react";

/** What the stage drew last, and over which mesh. */
export interface StageHold<R> {
    /** The mesh on stage when it was drawn: a hold is good for that mesh only. */
    url: string;
    /** The version family the mesh belongs to (the root model's id): a hold never carries over to another model. */
    family: string;
    result: R;
}

export interface StageHoldInput<R> {
    /** The active model's own result (null until its analysis lands). */
    own: R | null;
    /** The stabilizer's live preview, when it is for the active model. */
    preview: R | null;
    /** The mesh the viewer is showing. */
    url: string | null;
    /** The active model's family: the root model's id, else the model's own. */
    family: string | null;
    /**
     * The active model's own analysis is on its way: the mesh is on stage and no result or failure has come yet. False for a
     * failed analysis or a viewer that cannot show the model, where the plain stage (and the error) is the honest picture.
     */
    waiting: boolean;
}

export interface StageHoldOutput<R> {
    /** The result to hand the viewer as `analysis`: the active model's own, else the held one while a version is on its way. */
    analysis: R | null;
    /** What to remember for the next render. */
    held: StageHold<R> | null;
    /** `analysis` is the last version's picture, not this model's: its blocks are not the report's, so a hover or click on one means nothing. */
    holding: boolean;
}

/** Decides what the stage draws, and what it keeps for the next render. */
export function holdStage<R>(held: StageHold<R> | null, input: StageHoldInput<R>): StageHoldOutput<R> {
    const { own, preview, url, family, waiting } = input;
    // Whatever the stage draws now is what it will hold: the preview wins while the stabilizer is working (the viewer draws it).
    const drawn = preview ?? own;
    if (drawn !== null && url !== null && family !== null) {
        const same = held !== null && held.result === drawn && held.url === url && held.family === family;
        return { analysis: own, held: same ? held : { url, family, result: drawn }, holding: false };
    }
    // Nothing of its own to draw yet, on the mesh the last picture was drawn on, with the analysis on its way: draw that picture.
    if (held !== null && drawn === null && waiting && url !== null && held.url === url && held.family === family) {
        return { analysis: held.result, held, holding: true };
    }
    // The model went, the mesh changed, or the analysis failed: nothing is held for a stage that is not coming back to it.
    return { analysis: own, held: null, holding: false };
}

/**
 * The colouring to hand the viewer. The store settles the user's choice against the result it holds, which is the other version's
 * while a picture is held (a stabilized picture over an original's result has no "added blocks" to colour by, say): so while one is
 * held the choice itself goes to the viewer, which resolves it against the picture it draws and falls back where it cannot.
 */
export function stageColorBy<C>(settled: C, choice: C, holding: boolean): C {
    return holding ? choice : settled;
}

/** `holdStage` with the hold kept between renders. */
export function useHeldStage<R>(input: StageHoldInput<R>): { analysis: R | null; holding: boolean } {
    const ref = useRef<StageHold<R> | null>(null);
    const out = holdStage(ref.current, input);
    // Written during the render, like the shell's other "latest" refs: the same inputs always give the same hold, so a render that
    // is thrown away leaves nothing behind that the next one would not have made.
    ref.current = out.held;
    return { analysis: out.analysis, holding: out.holding };
}
