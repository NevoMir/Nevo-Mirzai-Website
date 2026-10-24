import type { KeyboardEvent } from "react";

/**
 * Is this key press part of an IME composition (Chinese, Japanese, Korean, ...)?
 *
 * Enter confirms the candidate being typed; it does not submit the field. Browsers report
 * that either as `isComposing`, or (Safari fires the composition's end BEFORE the keydown)
 * as the legacy keyCode 229. A field that saves on Enter has to skip both, or it saves a
 * half-typed name.
 */
export function isImeKey(e: Pick<KeyboardEvent, "nativeEvent" | "keyCode">): boolean {
    return e.nativeEvent.isComposing || e.keyCode === 229;
}
