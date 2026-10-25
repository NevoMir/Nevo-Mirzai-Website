// Pure logic behind the composer's New | Edit toggle: whether a typed change can be sent as an edit, to what (the parts of a design, the
// mesh, the blocks), what the route chip and the placeholder say, and what a queued prompt remembers. No React and no stores, so the
// composer, the chat panel and scripts/assignment/test-store.mjs share one copy.

import type { EditTarget, ModelAsset, ProvidersResponse } from "@/assignment/shared/contract";
import { EDIT_INSTRUCTION_MAX } from "@/assignment/shared/contract";
import { editTargetFor, rootOf, versionTitle, type WorkTab } from "@/assignment/shared/versionTree";
import type { ComposerMode } from "@/assignment/store/useWorkspaceStore";

export const AI_EDITOR_MISSING = "The AI editor is not set up on the server.";

/** What the server says about the AI editor (absent on a server from before it). */
export type AssistInfo = NonNullable<ProvidersResponse["assist"]>;

/**
 * Why an edit of this kind cannot be sent now, or null. Blocks need the OpenRouter key; the parts of a design and the mesh also need the
 * queue. A server that does not say (from before the editor) has none of it.
 */
export function assistReason(assist: AssistInfo | undefined, target: EditTarget): string | null {
    if (!assist || !assist.available) return AI_EDITOR_MISSING;
    if (target !== "voxel" && !assist.queued) return AI_EDITOR_MISSING;
    return null;
}

/** The day's AI calls are used up (the daily cap of the editor, shared by edits and optimization goals). */
export function assistLimitReached(assist: AssistInfo | undefined): boolean {
    return Boolean(assist && assist.daily_limit !== null && assist.used_today >= assist.daily_limit);
}

/** The words of the route chip: who does the edit and what it works on. */
export const ROUTE_WORDS: Record<EditTarget, string> = {
    design: "Muse · edits the parts",
    mesh: "Muse · adjusts the model",
    voxel: "Muse · changes the blocks",
};

/** What the route chip says in its tooltip. */
export const ROUTE_HINTS: Record<EditTarget, string> = {
    design: "Muse Spark changes the named parts of this design. Takes about 10 seconds.",
    mesh: "Muse Spark reads three pictures of the model and plans a change that runs here in your browser. Takes about 30 seconds.",
    voxel: "Muse Spark changes the blocks of this version. You look at the change before it is kept.",
};

export interface ComposerState {
    /** What a typed prompt does now. */
    mode: ComposerMode;
    /** There is a model on screen at all (the toggle is shown). */
    hasModel: boolean;
    /** A change can be sent as an edit now. */
    canEdit: boolean;
    /** Why not, in words (the Edit segment's tooltip), else null. */
    editReason: string | null;
    /** What an edit would act on, when it can be told. */
    target: EditTarget | null;
    /** The name of what an edit changes: "v3 · Stabilized", "the original". */
    subject: string | null;
}

/**
 * The composer's state. The person's choice wins when it can be honoured; with none made it edits whenever a model is on screen and can be
 * edited, and makes a new model otherwise. A choice of Edit that cannot be honoured (an example, a server without the editor) falls back
 * to New, with the reason on the disabled Edit segment.
 */
export function composerStateOf(input: {
    models: readonly ModelAsset[];
    activeModelId: string | null;
    tab: WorkTab;
    assist: AssistInfo | undefined;
    choice: ComposerMode | null;
}): ComposerState {
    const active = input.models.find((m) => m.id === input.activeModelId) ?? null;
    if (!active) return { mode: "new", hasModel: false, canEdit: false, editReason: null, target: null, subject: null };
    const { target, reason } = editTargetFor(input.models, active, input.tab);
    const editReason = target === null ? reason : assistReason(input.assist, target);
    const canEdit = target !== null && editReason === null;
    const root = rootOf(input.models, active);
    const subject = root && root.id === active.id ? "the original" : versionTitle(input.models, active);
    const mode: ComposerMode = canEdit && (input.choice ?? "edit") === "edit" ? "edit" : "new";
    return { mode, hasModel: true, canEdit, editReason, target, subject };
}

/** The box's placeholder: short on purpose (the box is one line tall). */
export function placeholderFor(input: { mode: ComposerMode; generating: boolean; started: boolean; target: EditTarget | null; subject: string | null }): string {
    if (input.mode === "edit") {
        if (input.generating) return "Queue the next change";
        return input.target === "voxel" ? "Describe a change to the blocks" : `Describe a change to ${input.subject ?? "this model"}`;
    }
    if (input.generating) return "Queue the next prompt";
    return input.started ? "Describe another object" : "Describe the object you want to build";
}

/** The longest text the box takes: a prompt for a new model, or the shorter instruction of an edit. */
export const maxCharsFor = (mode: ComposerMode, promptMax: number): number => (mode === "edit" ? EDIT_INSTRUCTION_MAX : promptMax);
