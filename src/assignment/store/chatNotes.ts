// Lines the workspace writes into the chat on its own: the words of an edit the person typed, and what became of it. A generated model
// has its job cards; an edit of the blocks has none (the proposal lives in the Stability panel), so its two lines are notes. Plain functions
// over the workspace store (not hooks), like store/generation.ts, so a store that outlives a component can use them.
//
// A note belongs to the project it was written for. When the person has opened another project by the time it is written, it is dropped:
// the version it speaks of is on the server and in that project's Models tab, and the chat of the open project must not get a stranger's line.

import { newId } from "@/assignment/store/generation";
import { saveNow } from "@/assignment/store/persist";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import type { ChatMessage } from "@/assignment/shared/contract";

/** At most this many model cards a message can point at (the Worker keeps the same number). */
const MAX_MODEL_IDS = 10;

function post(projectId: string, message: ChatMessage): string | null {
    const state = useWorkspaceStore.getState();
    if (state.activeProjectId !== projectId) return null;
    state.addMessage(message);
    return message.id;
}

/**
 * The person's own words, as a message of the chat (an edit they typed). Returns the message's id, or null when the project is not the open one.
 * (Callers that undo the send remove the message with `removeNote`.)
 */
export function postUserNote(projectId: string, text: string): string | null {
    const content = text.trim();
    if (!content) return null;
    return post(projectId, { id: newId(), role: "user", content, timestamp: new Date().toISOString() });
}

/**
 * The assistant's line, with the model cards it points at (`opts.modelIds`: the versions it made, at most 10). Saved at once when it carries
 * a model, because that is the line that ties the card to the chat. Returns the message's id, or null when the project is not the open one.
 */
export function postAssistantNote(projectId: string, text: string, opts: { modelIds?: string[] } = {}): string | null {
    const content = text.trim();
    if (!content) return null;
    const ids = (opts.modelIds ?? []).filter((id) => id !== "").slice(0, MAX_MODEL_IDS);
    const id = post(projectId, {
        id: newId(),
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
        ...(ids.length > 0 ? { model_ids: ids } : {}),
    });
    if (id !== null && ids.length > 0) void saveNow();
    return id;
}

/** Take a note back out of the chat (the send it belonged to did not start). */
export function removeNote(id: string | null): void {
    if (id !== null) useWorkspaceStore.getState().removeMessage(id);
}
