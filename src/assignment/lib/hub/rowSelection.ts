/**
 * Selecting rows with a mouse, as three pure answers.
 *
 * The page owns the `Set` and the pointer events; what is worth pinning is the
 * ARITHMETIC — which ids a shift-click or a drag covers — because it is the
 * part that is wrong silently: a range computed over the wrong order selects
 * the wrong projects, and the next click is a bulk delete.
 *
 * The order passed in is always the order ON SCREEN (sorted, searched,
 * scoped), never the order rows were fetched in: "everything between these
 * two" means what the eye sees between them.
 */

export interface RowSelection {
    selected: Set<string>;
    /** Where the next shift-click measures from — the last row touched on its
   *  own. Null until something is picked. */
    anchor: string | null;
}

export const EMPTY_SELECTION: RowSelection = { selected: new Set(), anchor: null };

/** Every id from `fromId` to `toId` inclusive, in list order. Either way round;
 *  empty when either id is not in the list (a row that scrolled out of the
 *  filter under the pointer). */
export function rangeBetween(orderedIds: string[], fromId: string, toId: string): string[] {
    const from = orderedIds.indexOf(fromId);
    const to = orderedIds.indexOf(toId);
    if (from < 0 || to < 0) return [];
    return orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** The base selection plus that range — what a drag and a shift-click both
 *  want. `base` is never mutated: a drag re-computes from the selection as it
 *  was when the pointer went down, so sweeping back up UNselects again. */
export function withRange(
    base: Set<string>,
    orderedIds: string[],
    fromId: string,
    toId: string,
): Set<string> {
    return new Set([...base, ...rangeBetween(orderedIds, fromId, toId)]);
}

/**
 * One tick on a row: its checkbox, its ⋯ → Select, a long press, or any click
 * once something is already selected (a modifier alone never starts
 * selecting).
 *
 * Shift extends from the anchor and leaves the anchor where it is, so a run of
 * shift-clicks keeps measuring from the same row. Anything else toggles the
 * row and becomes the new anchor.
 */
export function applyRowClick(
    state: RowSelection,
    orderedIds: string[],
    id: string,
    mods: { shiftKey?: boolean } = {},
): RowSelection {
    if (mods.shiftKey && state.anchor) {
        return { selected: withRange(state.selected, orderedIds, state.anchor, id), anchor: state.anchor };
    }
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
}

/**
 * The selection minus the rows an action just handled. An action on ONE row (its ⋯ menu), or
 * an Undo, must not throw away a multi-selection it was never about; the bulk bar acts on
 * every selected row, so for it this is the same as clearing. Returns the same object when
 * nothing was in it, and EMPTY_SELECTION (anchor forgotten) when nothing is left.
 */
export function withoutIds(state: RowSelection, ids: readonly string[]): RowSelection {
    if (!ids.some((id) => state.selected.has(id))) return state;
    const gone = new Set(ids);
    const selected = new Set([...state.selected].filter((id) => !gone.has(id)));
    if (selected.size === 0) return EMPTY_SELECTION;
    return { selected, anchor: state.anchor && selected.has(state.anchor) ? state.anchor : null };
}
