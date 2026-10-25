import { useMemo } from "react";

import { runActivityOf, type RunActivity } from "@/assignment/components/workspace/shellLogic";
import { useBusyMeshRun } from "@/assignment/store/edit";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { useCurrentWork } from "@/assignment/store/workGuard";

/**
 * The work in progress of the open project (a change on the queue, a mesh edit in this page, the stabilizer, a block edit's request, the
 * optimizer), or null. The run chip shows it; the phone's bar asks it too, to keep a place for the chip while something runs.
 */
export function useRunActivity(): RunActivity | null {
    const jobs = useWorkspaceStore((s) => s.jobs);
    const projectId = useWorkspaceStore((s) => s.activeProjectId);
    const hold = useCurrentWork();
    const stabilizing = useStabilizeStore((s) => s.status === "running");
    const mesh = useBusyMeshRun(projectId);
    return useMemo(
        () => runActivityOf({ jobs, projectId, hold, stabilizing, meshRun: mesh ? { key: mesh.key, since: mesh.startedAt, stoppable: mesh.status !== "saving" } : null }),
        [jobs, projectId, hold, stabilizing, mesh],
    );
}
