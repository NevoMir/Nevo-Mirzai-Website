/**
 * Keyboard focus, when the control that held it is about to leave the page.
 *
 * An action that removes a row (⋯ then Archive or Move to trash, Delete forever), and
 * every action on the bulk bar (the bar unmounts), leaves `document.activeElement` on
 * <body>: the next Tab starts from the top of the page and a screen reader loses its
 * place in a long list. The rescue hands focus to the row that took the removed one's
 * place, or to the list heading when no row is left.
 */

/** The id of the list's heading (`tabIndex={-1}`): where focus lands when no row can take it. */
export const HUB_LIST_HEADING_ID = "hub-list";

/**
 * Which row should take focus after `acted` rows were handled.
 *
 * `leaving`: the rows are about to disappear from the list, so the heir is the first row
 * after the first acted one that survives (else the last one before it). Otherwise they stay
 * (a tag was ticked, the selection was cleared) and focus goes to the first acted row itself.
 * Null when there is no such row: the heading takes it.
 */
export function focusHeirOf(
    orderedIds: readonly string[],
    acted: ReadonlySet<string>,
    leaving: boolean,
): string | null {
    const first = orderedIds.findIndex((id) => acted.has(id));
    if (first < 0) return null;
    if (!leaving) return orderedIds[first];
    for (let i = first + 1; i < orderedIds.length; i += 1) if (!acted.has(orderedIds[i])) return orderedIds[i];
    for (let i = first - 1; i >= 0; i -= 1) if (!acted.has(orderedIds[i])) return orderedIds[i];
    return null;
}

/**
 * When to look. A menu or a confirm dialog hands focus back to its trigger only once its
 * close animation has finished, and the trigger is gone by then, so focus falls to <body> a
 * beat AFTER the click. Each look does nothing unless focus really is nowhere, so a user who
 * moved on (the search box, another row) is never pulled back.
 */
const LOOK_AT_MS = [0, 160, 400, 800];

export function rescueFocus(heirId: string | null): void {
    const look = () => {
        const active = document.activeElement;
        if (active && active !== document.body && document.contains(active)) return;
        const heir = heirId
            ? Array.from(document.querySelectorAll<HTMLElement>("[data-project-row]")).find(
                  (row) => row.dataset.projectId === heirId,
              )
            : null;
        // preventScroll: the heir sits where the removed row was, which is already in view.
        (heir ?? document.getElementById(HUB_LIST_HEADING_ID))?.focus({ preventScroll: true });
    };
    for (const ms of LOOK_AT_MS) window.setTimeout(look, ms);
}
