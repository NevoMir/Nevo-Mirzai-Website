import { useModelVerdict } from "@/assignment/components/analysis/useAnalysis";
import { switcherMode, switcherPending, type SwitcherMode } from "@/assignment/components/workspace/versionLogic";
import type { WorkspaceTab } from "@/assignment/store/useWorkspaceStore";
import { useVersionFamily, type VersionFamily } from "@/assignment/store/versions";

/** What the bar needs to know about the switcher: whether it is there at all (a bar that gives it a row reserves the room), and why. */
export interface VersionSwitcherState {
    mode: SwitcherMode;
    family: VersionFamily | null;
    /** No switcher yet, but the original's first analysis may still bring one: a row for it is kept so nothing moves when it lands. */
    pending: boolean;
}

/**
 * Whether the bar shows a switcher for the model in the viewer: "switch" when it has a stabilized version, "offer" when it
 * has problems and none yet, else "none". Read by the shell (layout) and by the switcher itself.
 */
export function useVersionSwitcherState(tab: WorkspaceTab): VersionSwitcherState {
    const family = useVersionFamily();
    const rootVerdict = useModelVerdict(family?.root ?? null);
    return { mode: switcherMode({ family, rootVerdict, tab }), family, pending: switcherPending({ family, rootVerdict, tab }) };
}
