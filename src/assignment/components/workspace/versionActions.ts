// What switching versions does to the stores: one function for the bar's switcher, the "V" key, a stabilize run that has just
// been saved (the new version opens on the tab that is open), the Models list and the chat cards, so they can never drift apart.
// The Stability tab has no version buttons of its own. Plain functions over the stores (not hooks), like store/models.ts.

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { toast } from "@/assignment/components/ui/sonner";
import {
    inTypingContext,
    isVersionKey,
    rememberStabilized,
    toggleTarget,
    type KeyLike,
} from "@/assignment/components/workspace/versionLogic";
import type { ModelAsset } from "@/assignment/shared/contract";
import { versionFamily } from "@/assignment/store/versions";
import { useWorkspaceStore, type WorkspaceTab } from "@/assignment/store/useWorkspaceStore";

/**
 * Put a model in the viewer. The tab stays where it is (3D stays 3D, Stability stays Stability) unless a caller that
 * comes from elsewhere (the Models list, a chat card) asks for one. An id the project does not have is ignored by the store.
 */
export function openVersion(model: Pick<ModelAsset, "id">, options: { tab?: WorkspaceTab } = {}): void {
    const state = useWorkspaceStore.getState();
    // Leaving a stabilized version: remember which one, so "back to stabilized" returns to it.
    rememberStabilized(versionFamily(state.models, state.activeModelId));
    state.setActiveModel(model.id);
    if (options.tab) state.setWorkspaceTab(options.tab);
}

/**
 * "V": flip between the original and the stabilized version, on the tab that is open. false when there is nothing to
 * flip to (no stabilized version yet, the original is gone) or the Models tab is open (its list has its own buttons).
 */
export function toggleVersion(): boolean {
    const state = useWorkspaceStore.getState();
    if (state.workspaceTab === "models") return false;
    const target = toggleTarget(versionFamily(state.models, state.activeModelId));
    if (!target) return false;
    openVersion(target);
    return true;
}

// ---------- the "V" key ----------

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
 * A bare "V" pressed while the 3D view or the version switch has focus (the callers attach it to those, never to the window: a
 * single-letter shortcut that cannot be switched off must not fire from anywhere on the page). Flips the version and claims the
 * key; with nothing to flip to it says so (a screen reader hears it too) and leaves the key alone. false: not a "V" to act on.
 */
export function handleVersionKey(e: VersionKeyEvent): boolean {
    if (!isVersionKey(e) || inTypingContext(e.target)) return false;
    if (toggleVersion()) {
        e.preventDefault();
        return true;
    }
    const state = useWorkspaceStore.getState();
    // The Models tab has its own buttons, and with no model there is nothing to be told.
    if (state.workspaceTab !== "models" && state.activeModelId !== null) {
        toast.info("There is no other version of this model yet", { id: "version-none" });
    }
    return true;
}
