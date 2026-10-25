// Runs the analysis for the model in the viewer: automatically once its GLB is loaded ("after generating the
// geometry"), again (debounced) when the settings change, and never for a model that is no longer on screen.
// The result goes to store/analysis.ts; the headline numbers are saved with the model.
//
// Two kinds of model are analysed:
//   - a mesh (and a stabilized model whose source is gone, shown as its own blocks): the viewer's GLB IS the model, so its
//     triangles are voxelised (a block assembly declares its cells, which are read instead);
//   - a stabilized model shown on the mesh it was made from (store/versions.ts: the viewer loads the SOURCE's GLB): the
//     blocks are the descriptor read from the stabilized model's own GLB, and the viewer's triangles only give the source's
//     bounds, which place the lattice over the mesh exactly as voxelising that mesh does (voxelize.ts transformForBounds).
//     The run is for the active model and its id, whatever mesh is on stage.

import { useEffect } from "react";

import type { Bounds } from "@/assignment/analysis/assembly";
import type { AnalysisResult, LoadedModel, TriangleSoup } from "@/assignment/analysis/types";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { stageWords } from "@/assignment/store/analysisLogic";
import { saveSummary } from "@/assignment/store/analysisSave";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { loadAssembly, useDisplayModel } from "@/assignment/store/versions";

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

/** The bounds of what a viewer handle shows, read once per handle (the triangles of a big mesh are not cheap to copy out). */
const boundsOfHandle = new WeakMap<LoadedModel, Bounds>();

export function useAnalysisRunner(model: ModelAsset | null): void {
    // The runner lives as long as the workspace: when the workspace goes, so does a stabilizer run that is not saving yet.
    useEffect(() => () => useStabilizeStore.getState().leave(), []);

    const modelId = model?.id ?? null;
    // The mesh the viewer loads for this model: its own GLB, or for a stabilized model the GLB of the model it was made from.
    const display = useDisplayModel(model);
    const glbUrl = display?.glb_url ?? null;
    // The stabilized model's own file, read for its blocks while the viewer shows another one.
    // (By id and url, not the object: saving the summary replaces the model with a new object, which must not restart the run.)
    const stabilizedOnSource = model !== null && display !== null && display.id !== model.id && model.kind === "stabilized";
    const blocksId = stabilizedOnSource ? model.id : null;
    const blocksUrl = stabilizedOnSource ? model.glb_url : null;
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
        const blocksFrom = blocksId !== null && blocksUrl !== null ? { id: blocksId, glb_url: blocksUrl } : null;
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
                const onProgress = ({ stage, progress, step }: { stage: string; progress: number; step?: string }) => {
                    // The panel's own words for the stage, not the engine's label ("Voxelising the model").
                    if (!signal.aborted) useAnalysisStore.getState().runProgress(modelId, stageWords(step, stage), progress);
                };
                let result: AnalysisResult;
                if (blocksFrom) {
                    // A stabilized model on its source mesh: the blocks from its own file, the placement from the mesh on stage.
                    const [descriptor, assemblyModule] = await Promise.all([loadAssembly(blocksFrom), import("@/assignment/analysis/assembly")]);
                    if (signal.aborted) return;
                    let bounds = boundsOfHandle.get(handle);
                    if (!bounds) {
                        bounds = assemblyModule.soupBoundsOf(readTriangles(handle).positions) ?? undefined;
                        if (!bounds) throw new ModelNotReady();
                        boundsOfHandle.set(handle, bounds);
                    }
                    const placement = assemblyModule.sourcePlacementOf(bounds, settings, descriptor);
                    if (!placement) throw new ModelNotReady();
                    result = await runAnalysis(() => readTriangles(handle), settings, {
                        signal,
                        // The pair, so a result for these blocks over this mesh is never taken for another pairing.
                        cacheKey: `${blocksFrom.glb_url}@${handle.url}`,
                        assembly: descriptor,
                        // Where the mesh puts the blocks, and how big that mesh is: the model's size is the original's, whichever version is shown.
                        sourceTransform: placement.transform,
                        sourceSizeMm: placement.sizeMm,
                        onProgress,
                    });
                } else {
                    // The triangles are only extracted when the engine needs them; the url lets it reuse a cached
                    // result or the voxelised model when only a setting moved.
                    result = await runAnalysis(() => readTriangles(handle), settings, {
                        signal,
                        cacheKey: handle.url,
                        // A stabilized model declares its blocks: they are analysed as they are, never voxelised again.
                        assembly: handle.assembly,
                        onProgress,
                    });
                }
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
    }, [modelId, glbUrl, blocksId, blocksUrl, ready, loaded, settings, attempt]);
}
