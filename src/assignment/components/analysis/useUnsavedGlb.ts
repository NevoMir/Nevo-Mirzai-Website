// The stabilized model of a run that is not saved (yet): a file in reach while it uploads, when the upload failed, or while a
// partial result waits for a decision. Read by the export menu and by the run strip's Download buttons.

import { useCallback } from "react";

import { downloadBytes } from "@/assignment/components/analysis/download";
import { modelFileName } from "@/assignment/components/workspace/format";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { stabilizedFileName } from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

export interface UnsavedGlb {
    fileName: string;
    download: () => void;
}

/** The run's GLB, or null when there is none to hand over: no run, a run still going, a stopped run not written yet, or one that is saved. */
export function useUnsavedGlb(): UnsavedGlb | null {
    const status = useStabilizeStore((s) => s.status);
    const result = useStabilizeStore((s) => s.result);
    const sourceModelId = useStabilizeStore((s) => s.sourceModelId);
    const sourcePrompt = useStabilizeStore((s) => s.sourcePrompt);
    const source = useWorkspaceStore((s) => s.models.find((m) => m.id === sourceModelId));
    const glb = result?.glb ?? null;
    const fileName = stabilizedFileName(modelFileName(source ?? { prompt: sourcePrompt, provider: "stabilizer" }));
    const download = useCallback(() => {
        if (glb) downloadBytes(fileName, "model/gltf-binary", glb);
    }, [glb, fileName]);
    if (!glb || status === "idle" || status === "running" || status === "saved") return null;
    return { fileName, download };
}
