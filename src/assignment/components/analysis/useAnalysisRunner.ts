// Runs the analysis for the model in the viewer: automatically once its GLB is loaded ("after generating the
// geometry"), again (debounced) when the settings change, and never for a model that is no longer on screen.
// The result goes to store/analysis.ts; the headline numbers are saved with the model.

import { useEffect } from "react";

import type { LoadedModel, TriangleSoup } from "@/assignment/analysis/types";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { saveSummary } from "@/assignment/store/analysisSave";
import { useStabilizeStore } from "@/assignment/store/stabilize";

/** A slider drag or a typed number fires many changes; run once the user pauses. */
const SETTINGS_DEBOUNCE_MS = 350;

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** The viewer's handle has no triangles: its scene is gone or reloading. Not a result, so never cached or saved. */
class ModelNotReady extends Error {}

/** How long to wait for a reloading viewer before giving up, one pause per try (an array so a test can shorten it). */
export const NOT_READY_RETRY_MS = [400, 800, 1600, 3200];

/** An empty list is not a model with no blocks: it is a viewer that has nothing to give right now. */
function readTriangles(loaded: LoadedModel): TriangleSoup {
    const soup = loaded.extractTriangles();
    if (soup.positions.length < 9) throw new ModelNotReady();
    return soup;
}

export function useAnalysisRunner(model: ModelAsset | null): void {
    // The runner lives as long as the workspace: when the workspace goes, so does a stabilizer run that is not saving yet.
    useEffect(() => () => useStabilizeStore.getState().leave(), []);

    const modelId = model?.id ?? null;
    const glbUrl = model?.glb_url ?? null;
    // The handle itself, not just its url: a viewer that reloaded the same model hands over a fresh one, and the
    // run that found it empty must start again with it.
    const loaded = useAnalysisStore((s) => s.loaded);
    const settings = useAnalysisStore((s) => s.settings);
    const attempt = useAnalysisStore((s) => s.attempt);
    const ready = glbUrl !== null && loaded !== null && loaded.url === glbUrl;

    useEffect(() => {
        if (!modelId || !ready) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let notReady = 0;
        const { signal } = controller;
        const store = useAnalysisStore.getState();
        // The first run for a model starts at once; a settings change waits for the user to pause.
        const delay = store.resultModelId === modelId ? SETTINGS_DEBOUNCE_MS : 0;

        const run = async () => {
            const state = useAnalysisStore.getState();
            // The latest handle: a viewer that reloaded the same url handed over a fresh one.
            const handle = state.loaded;
            if (!handle || handle.url !== glbUrl) return;
            state.runStarted(modelId);
            try {
                // The engine (and its worker) load on first use, not with the page.
                const { runAnalysis } = await import("@/assignment/analysis/runAnalysis");
                if (signal.aborted) return;
                // The triangles are only extracted when the engine needs them; the url lets it reuse a cached
                // result or the voxelised model when only a setting moved.
                const result = await runAnalysis(() => readTriangles(handle), settings, {
                    signal,
                    cacheKey: handle.url,
                    // A stabilized model declares its blocks: they are analysed as they are, never voxelised again.
                    assembly: handle.assembly,
                    onProgress: ({ stage, progress }) => {
                        if (!signal.aborted) useAnalysisStore.getState().runProgress(modelId, stage, progress);
                    },
                });
                if (signal.aborted) return;
                useAnalysisStore.getState().runSucceeded(modelId, result);
                void saveSummary(modelId, settings, result.summary);
            } catch (error) {
                if (signal.aborted || isAbort(error)) return;
                if (error instanceof ModelNotReady) {
                    // The viewer is still putting the model back (a quick switch away and back, a lost context):
                    // look again shortly, and say so if it never comes.
                    if (notReady < NOT_READY_RETRY_MS.length) {
                        timer = setTimeout(() => void run(), NOT_READY_RETRY_MS[notReady++]);
                        return;
                    }
                    useAnalysisStore
                        .getState()
                        .runFailed(modelId, "The 3D view has no geometry to read for this model. If it is still loading, try again in a moment.");
                    return;
                }
                const message = error instanceof Error && error.message ? error.message : "The analysis failed.";
                useAnalysisStore.getState().runFailed(modelId, message);
            }
        };

        timer = setTimeout(() => void run(), delay);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [modelId, glbUrl, ready, loaded, settings, attempt]);
}
