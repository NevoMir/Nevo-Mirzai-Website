// What switching versions does to the stores: one function for the bar's control, the "V", "[" and "]" keys, a stabilize run that has just
// been saved (the new version opens on the tab that is open), the Models list and the chat cards, so they can never drift apart.
// The Stability tab has no version buttons of its own. Plain functions over the stores (not hooks), like store/models.ts.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { toast } from "@/assignment/components/ui/sonner";
import {
    inTypingContext,
    isVersionKey,
    stepKeyOf,
    toggleTarget,
    type KeyLike,
} from "@/assignment/components/workspace/versionLogic";
import type { ModelAsset } from "@/assignment/shared/contract";
import { rememberHead, stepTarget } from "@/assignment/shared/versionTree";
import { versionFamily } from "@/assignment/store/versions";
import { useWorkspaceStore, type WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

/**
 * Put a model in the viewer. The tab stays where it is (3D stays 3D, Stability stays Stability) unless a caller that
 * comes from elsewhere (the Models list, a chat card) asks for one. An id the project does not have is ignored by the store.
 */
export function openVersion(model: Pick<ModelAsset, "id">, options: { tab?: WorkspaceTab } = {}): void {
    const state = useWorkspaceStore.getState();
    // Leaving a version: remember which one, so going back to the original and forth returns to it.
    const leaving = state.models.find((m) => m.id === state.activeModelId);
    if (leaving) rememberHead(state.models, leaving);
    state.setActiveModel(model.id);
    if (options.tab) state.setWorkspaceTab(options.tab);
}

/**
 * The Models tab's "Edit...": show that version on the 3D tab, set the composer to describe a change to it, and put the cursor there. A
 * phone leaves for the chat (the page watches the focus request); on a desktop with the chat folded away the panel comes back first,
 * because a folded panel is invisible and cannot take the cursor.
 */
export function editVersion(model: Pick<ModelAsset, "id">): void {
    openVersion(model, { tab: "3d" });
    const state = useWorkspaceStore.getState();
    state.setChatHidden(false);
    state.setComposerChoice("edit");
    state.requestComposerFocus();
}

/**
 * "V": flip between the original and the version you are working on, on the tab that is open. false when there is nothing to
 * flip to (no version yet, the original is gone) or the Models tab is open (its tree has its own buttons).
 */
export function toggleVersion(): boolean {
    const state = useWorkspaceStore.getState();
    if (state.workspaceTab === "models") return false;
    const target = toggleTarget(versionFamily(state.models, state.activeModelId));
    if (!target) return false;
    openVersion(target);
    return true;
}

/**
 * "[" goes to the parent of the version on screen, "]" to its newest child, on the tab that is open. false when there is none or the
 * Models tab is open.
 */
export function stepVersion(dir: "parent" | "child"): boolean {
    const state = useWorkspaceStore.getState();
    if (state.workspaceTab === "models") return false;
    const active = state.models.find((m) => m.id === state.activeModelId);
    const target = active ? stepTarget(state.models, active, dir) : null;
    if (!target) return false;
    openVersion(target);
    return true;
}

// ---------- the keys ----------

/** A keydown as the shortcut reads it: the parts of the key, where it went, and a way to claim it. */
export interface VersionKeyEvent extends KeyLike {
    target: EventTarget | null;
    preventDefault(): void;
}

/** A React keydown, as the shortcut reads it (React's event has no `isComposing`: the native one does). */
export function versionKeyEvent(e: ReactKeyboardEvent): VersionKeyEvent {
    return {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        isComposing: e.nativeEvent.isComposing,
        defaultPrevented: e.defaultPrevented,
        target: e.target,
        preventDefault: () => e.preventDefault(),
    };
}

/**
 * A bare "V", "[" or "]" pressed while the 3D view or the version control has focus (the callers attach it to those, never to the window: a
 * single-letter shortcut that cannot be switched off must not fire from anywhere on the page). "V" flips between the original and the
 * version you are working on, "[" goes to the version this one was made from, "]" to the newest made from it. Claims the key; with
 * nowhere to go it says so (a screen reader hears it too) and leaves the key alone. false: not one of these keys, or typing.
 */
export function handleVersionKey(e: VersionKeyEvent): boolean {
    if (inTypingContext(e.target)) return false;
    const step = stepKeyOf(e);
    if (!isVersionKey(e) && step === null) return false;
    if (step !== null ? stepVersion(step) : toggleVersion()) {
        e.preventDefault();
        return true;
    }
    const state = useWorkspaceStore.getState();
    // The Models tab has its own buttons, and with no model there is nothing to be told.
    if (state.workspaceTab !== "models" && state.activeModelId !== null) {
        const words =
            step === "parent"
                ? "There is no earlier version of this one"
                : step === "child"
                  ? "There is no later version of this one"
                  : "There is no other version of this model yet";
        toast.info(words, { id: "version-none" });
    }
    return true;
}
