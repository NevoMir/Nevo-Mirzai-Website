// Where a typed change goes. The composer's Edit mode hands the text here; the router works out what the change acts on (the parts of a Muse
// design, the mesh of a fused model, or the blocks of a version: shared/versionTree.ts editTargetFor), checks that it may start and dispatches:
//
//   design, mesh  -> store/edit.ts        startDesignOrMeshEdit: a job on the queue; it writes the person's words and its reply card into the chat
//   voxel (blocks) -> store/voxelEdit.ts   requestBlockEdit: a direct request; the proposal is shown in the Stability tab (the router writes the
//                                          person's words into the chat, the block editor writes what became of them)
//
// Both are loaded on first use (the mesh editor and the block editor are not part of the first paint). One piece of work at a time: a block
// edit takes the work guard (store/workGuard.ts) while its request is out and its owner keeps it for the draft; a change of a design or a
// mesh waits for any other work to end.
//
// For a change to the blocks the router also sees to what the editor does not: changes kept from before a reload are put back before the
// request (so a request that ends with nothing cannot make the editor forget them), a proposal is brought up on the report (on a phone that is
// the other screen), and a request that came back with no answer at all (Stop, another version meanwhile) gets a line in the chat and the
// words back in the box.

import { toast } from "@/assignment/components/ui/sonner";
import { assistLimitReached, assistReason } from "@/assignment/components/chat/composerLogic";
import { EDIT_INSTRUCTION_MAX } from "@/assignment/shared/contract";
import { editTargetFor } from "@/assignment/shared/versionTree";
import { flatText } from "@/assignment/shared/voxelEdit/text";
import { withAccessRetry } from "@/assignment/store/access";
import { openAnalysisFor, useAnalysisStore } from "@/assignment/store/analysis";
import { postAssistantNote, postUserNote, removeNote } from "@/assignment/store/chatNotes";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { acquireWork, anyWorkMessage, workBusyMessage, WORK_CHIP_WORDS } from "@/assignment/store/workGuard";

export type SubmitEditOutcome =
    | { ok: true }
    /** Nothing was started. `restorePrompt`: give the text back to the composer. */
    | { ok: false; restorePrompt: boolean };

const refused: SubmitEditOutcome = { ok: false, restorePrompt: true };

const errorText = (err: unknown): string => (err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");

/** What the chat says when a request for a change to the blocks ended without an answer (the editor itself says nothing then). */
export const BLOCK_EDIT_STOPPED = "Stopped. Nothing was changed.";
export const BLOCK_EDIT_MOVED = "You moved to another version, so that change was dropped.";

type VoxelEditModule = typeof import("@/assignment/store/voxelEdit");

/**
 * Changes kept from before a reload ("You have 3 changes on this version. Continue / Discard") are put back before a new request, not
 * thrown away by it: a request that ended without content would otherwise close the session and forget them. Only when the check of the
 * model is done (the editor says "wait" otherwise, and a failed resume forgets the draft); the editor reports its own failures.
 */
async function continueKeptDraft(voxel: VoxelEditModule, modelId: string): Promise<void> {
    const analysis = useAnalysisStore.getState();
    if (analysis.resultModelId !== modelId || !analysis.result) return;
    voxel.useVoxelEditStore.getState().findResumable(modelId);
    if (voxel.useVoxelEditStore.getState().resumable?.modelId !== modelId) return;
    await voxel.useVoxelEditStore.getState().resume();
}

/**
 * What became of a request that came back without an error. A proposal is on the Stability tab, which on a phone is the other screen: it
 * is brought up (the page leaves the chat for the canvas on this request, and the sheet opens with the whole proposal). A question or a
 * refusal is a note the editor already wrote. Neither means the answer was dropped (Stop, or the person moved to another version while
 * the editor thought): that is said here, and the words go back to the box.
 */
function blockEditOutcome(voxel: VoxelEditModule, a: { projectId: string; modelId: string }): SubmitEditOutcome {
    const editor = voxel.useVoxelEditStore.getState();
    if (editor.proposal !== null) {
        openAnalysisFor(a.modelId);
        return { ok: true };
    }
    if (editor.notice !== null) return { ok: true };
    const here = useWorkspaceStore.getState();
    // Another project is open: its chat gets no line from this one, and the words are not its to hold.
    if (here.activeProjectId !== a.projectId) return { ok: true };
    postAssistantNote(a.projectId, here.activeModelId === a.modelId ? BLOCK_EDIT_STOPPED : BLOCK_EDIT_MOVED);
    return refused;
}

/**
 * Send `text` as a change to the model on screen. Resolves once the change has started (a job is on the queue, a proposal has come back), not
 * when it is done. The access code is asked for by the caller before this (the composer), as for a new model.
 */
export async function submitEdit(text: string): Promise<SubmitEditOutcome> {
    // One line: Shift+Enter in the box and pasted tabs would otherwise reach the saved log (which refuses control characters).
    const instruction = flatText(text);
    if (!instruction) return refused;
    if (instruction.length > EDIT_INSTRUCTION_MAX) {
        toast.error("That is too long for a change", { description: `Keep it under ${EDIT_INSTRUCTION_MAX} characters.` });
        return refused;
    }

    const state = useWorkspaceStore.getState();
    const projectId = state.activeProjectId;
    const active = state.models.find((m) => m.id === state.activeModelId) ?? null;
    if (!projectId || !active) {
        toast.error("There is no model to change yet", { description: "Describe an object first, then ask for changes." });
        return refused;
    }
    const { target, reason } = editTargetFor(state.models, active, state.workspaceTab);
    if (target === null) {
        toast.error("This model cannot be changed by words", { description: reason ?? undefined });
        return refused;
    }
    const assist = state.providers?.assist;
    const unavailable = assistReason(assist, target);
    if (unavailable) {
        toast.error("The AI editor is not available", { description: unavailable });
        return refused;
    }
    if (assistLimitReached(assist) && assist) {
        toast.warning("Daily limit reached", {
            description: `${assist.used_today} of ${assist.daily_limit} AI changes are used today. Try again tomorrow.`,
            duration: 9000,
        });
        return refused;
    }

    if (target === "voxel") {
        // Stop is on the run chip from the first moment: the editor cancels the request wherever it has got to.
        const release = acquireWork("blocks", projectId, {
            label: WORK_CHIP_WORDS.blocks,
            stop: () => void import("@/assignment/store/voxelEdit").then((voxel) => voxel.useVoxelEditStore.getState().cancel()),
        });
        if (!release) {
            toast.info("Not now", { description: workBusyMessage("blocks", projectId) ?? "Something else is running." });
            return refused;
        }
        // The proposal is shown in the Stability tab, wherever the words were typed.
        if (state.workspaceTab !== "analysis") state.setWorkspaceTab("analysis");
        const noteId = postUserNote(projectId, instruction);
        try {
            const voxel = await import("@/assignment/store/voxelEdit");
            await continueKeptDraft(voxel, active.id);
            // A stored access code the server refuses is asked for again, once, as for a new model.
            await withAccessRetry(() => voxel.requestBlockEdit({ modelId: active.id, instruction }));
            return blockEditOutcome(voxel, { projectId, modelId: active.id });
        } catch (err) {
            removeNote(noteId);
            toast.error("Could not change the blocks", { description: errorText(err) });
            return refused;
        } finally {
            release();
        }
    }

    const busy = anyWorkMessage(projectId) ?? workBusyMessage("blocks", projectId);
    if (busy) {
        toast.info("Not now", { description: busy });
        return refused;
    }
    try {
        const { meshEditBusy, startDesignOrMeshEdit } = await import("@/assignment/store/edit");
        // One mesh edit at a time per project. Said here, before the words leave the box: the editor itself would return without a sound.
        if (target === "mesh" && meshEditBusy(projectId)) {
            toast.info("Another edit is still running", { description: "Wait for it to finish, or stop it first." });
            return refused;
        }
        await startDesignOrMeshEdit({ projectId, modelId: active.id, target, instruction });
        return { ok: true };
    } catch (err) {
        // (It writes its own words into the chat, and its own explanation when a start fails; this is for what it did not expect.)
        toast.error("Could not start the change", { description: errorText(err) });
        return refused;
    }
}
