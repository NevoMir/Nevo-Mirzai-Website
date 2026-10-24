// When the camera flies to an issue and when its callout (the ringed marker and the title bubble) is on stage.
// Pure, so Node can test it; useAnalysisView runs it from an effect and acts on the plan.
//
// The rules, in the order they matter:
// - The camera flies once per focus token (the token is a pick; the same pick shown again, after a tab round trip
//   or a re-run, does not fly again).
// - The callout points at a pick, and what says which pick is the highlight: it is made for the highlight that was
//   on when the token arrived and is retired as soon as the highlight is another one (a block of another issue was
//   clicked, the selection was cleared, a re-run dropped it), so the pointer never contradicts the glow.
// - Off stage (another tab) the callout is taken down but remembered: coming back shows it again without a flight.
// - When the layer cut hides every block of the pick, nothing is glowing: no flight, and no callout until the cut
//   lets some of them show.

export interface FocusInput {
    /** The token of the pick to point at; null: nothing is picked. */
    token: number | null;
    /** The blocks are on stage. */
    active: boolean;
    /** The highlight as it is now, as a key (a different set of blocks is a different key). */
    highlightKey: string;
    /** Every highlighted block is above the layer cut. */
    allHidden: boolean;
    /** The token already flown to (or deliberately not flown to). */
    appliedToken: number | null;
    /** The highlight key the callout was made for; null: no callout to show (never made, or dismissed). */
    calloutFor: string | null;
}

export interface FocusPlan {
    /** Fly the camera to the pick now. */
    fly: boolean;
    /** The callout is on stage. */
    showCallout: boolean;
    /** The state to carry into the next call. */
    appliedToken: number | null;
    calloutFor: string | null;
}

export function planFocus(input: FocusInput): FocusPlan {
    const { token, active, highlightKey, allHidden, appliedToken, calloutFor } = input;
    // Nothing is picked: nothing to point at, whatever was remembered.
    if (token === null) return { fly: false, showCallout: false, appliedToken, calloutFor: null };
    // Off stage: no flight, no callout, and the memory is kept for the way back.
    if (!active) return { fly: false, showCallout: false, appliedToken, calloutFor };
    const fresh = token !== appliedToken;
    const madeFor = fresh ? highlightKey : calloutFor;
    return {
        fly: fresh && !allHidden,
        showCallout: madeFor !== null && madeFor === highlightKey && !allHidden,
        appliedToken: fresh ? token : appliedToken,
        calloutFor: madeFor,
    };
}
