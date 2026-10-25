// The person's words as the edit code keeps them: one line, no control characters. The composer's box takes Shift+Enter (a newline) and pasted
// text may carry tabs; the saved log refuses control characters (log.ts), so every entry point flattens the text first, once, the same way the
// design and mesh paths do (shared/partsEdit.ts cleanInstruction). No imports: the composer's router uses it before anything else is loaded.

import { EDIT_INSTRUCTION_MAX } from "../contract.ts";

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** `raw` with every control character and run of blanks turned into a single space, trimmed ("a\nb" -> "a b"). */
export function flatText(raw: string): string {
    return raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** An instruction as the log keeps it: flattened and cut to EDIT_INSTRUCTION_MAX characters ("" stays ""). */
export function flatInstruction(raw: string): string {
    return flatText(raw).slice(0, EDIT_INSTRUCTION_MAX).trimEnd();
}
