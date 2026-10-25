// "Stabilize…" in the workspace bar: open the Stability tab (the report sheet on a phone), bring the Stabilize card (or, while a run
// has something to say, its strip) into view and put the keyboard on its button. It never starts a run: the user still presses the button.

import { openAnalysisFor, useAnalysisStore } from "@/assignment/store/analysis";

/**
 * What "the card" is, whatever the run is doing. The offer (`stabilize-card`) and the live run (`stabilize-running`) are wrappers around
 * a box; each strip of a run that has ended (saving, failed, stopped, nothing to add, partial) is the box itself.
 */
const WRAPPERS = ["stabilize-card", "stabilize-running"];
const STRIPS = ["stabilize-saving", "stabilize-error", "stabilize-canceled", "stabilize-nothing", "stabilize-partial"];
const selectorOf = (ids: readonly string[], within = ""): string => ids.map((id) => `${within}[data-testid="${id}"]`).join(", ");
const CARD = selectorOf([...WRAPPERS, ...STRIPS]);
/** On a phone the peek card under the stage has one too; while the sheet is open, the sheet's is the one to go to. */
const CARD_IN_SHEET = selectorOf([...WRAPPERS, ...STRIPS], '[role="dialog"] ');
const WRAPPED = selectorOf(WRAPPERS);
/** The button the keyboard lands on: Start on the offer, Save (a stopped or partial run) or Retry (a save that failed) on a strip. */
const FIRST_BUTTON = '[data-testid="stabilize-save"], [data-testid="stabilize-retry"], [data-testid="stabilize-start"]';

/** The report mounts after the tab opens (the phone's sheet after its animation, the card after the analysis): look for ~4 s. */
const LOOK_EVERY_MS = 100;
const LOOK_FOR_MS = 4000;

/** How long the card keeps its highlight ring. */
const FLASH_MS = 1600;

/** Scroll the card into view, ring it for a moment and focus its button (else the card itself). true: found. */
export function focusStabilizeCard(root: ParentNode = document): boolean {
    const card = root.querySelector<HTMLElement>(CARD_IN_SHEET) ?? root.querySelector<HTMLElement>(CARD);
    if (!card) return false;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    card.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    const button = card.querySelector<HTMLElement>(FIRST_BUTTON);
    const target = button ?? card;
    if (target === card && !card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    // The ring is a data attribute (the card styles `data-[flash=true]`), not React state: on the box inside a wrapper, else on the strip itself.
    const box = card.matches?.(WRAPPED) ? card.firstElementChild : card;
    if (box instanceof HTMLElement) {
        box.setAttribute("data-flash", "true");
        setTimeout(() => box.removeAttribute("data-flash"), FLASH_MS);
    }
    return true;
}

/**
 * Open the model's analysis and wait for the Stabilize card to appear, then focus it. Returns a function that stops
 * waiting (the user went somewhere else first).
 */
export function revealStabilizeCard(modelId: string): () => void {
    openAnalysisFor(modelId);
    let waited = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
        if (waited === 0) {
            // The workspace folds the report into its pill when it opens in a window too narrow to show it beside the model;
            // the card is what was asked for, so the report stays open (over the stage).
            const analysis = useAnalysisStore.getState();
            if (!analysis.panelOpen) analysis.setPanelOpen(true);
        }
        if (focusStabilizeCard()) return;
        waited += LOOK_EVERY_MS;
        if (waited < LOOK_FOR_MS) timer = setTimeout(look, LOOK_EVERY_MS);
    };
    timer = setTimeout(look, 0);
    return () => clearTimeout(timer);
}
