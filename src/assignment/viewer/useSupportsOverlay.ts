/**
 * Everything GlbViewer does for the added-supports overlay, kept out of the component: it builds the cubes of the blocks a
 * stabilizer added when a stabilized model is shown on its source mesh, puts them into the model's scene (GlbScene.setOverlay:
 * framed with the model, picked by its own ray test), keeps them in step with the user's toggle and the theme, and frees them
 * when the result, the model or the viewer goes away.
 *
 * The cube layer is a lazy chunk (it imports three) and is owned here. A new result replaces the layer in place (the new cubes
 * are built before the old ones go, so a re-analysis never flashes the bare mesh); a new model or viewer takes it down with the
 * scene it was in. Nothing here changes the camera except through `viewer.refresh()`, which re-frames only while the camera is
 * still on automatic.
 *
 * The cubes need a result, which the workspace produces after the mesh is on stage (it fetches the stabilized GLB and analyses
 * it), so they are never there for the mesh's first frames: a cover taken then is the bare mesh, as the original version's is.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AnalysisResult } from "@/assignment/analysis/types";
import type { GlbScene } from "./glbScene.ts";
import type { OrbitViewer } from "./orbitViewer.ts";
import type { SupportsLayer } from "./supportsLayer.ts";
import type { ViewTheme } from "./types.ts";

export interface SupportsOverlayArgs {
    viewerRef: RefObject<OrbitViewer | null>;
    sceneRef: RefObject<GlbScene | null>;
    /** The model is shown (the viewer, its scene and the first frame exist). */
    ready: boolean;
    viewerEpoch: number;
    /** Bumped when a model's scene is installed or removed. */
    modelEpoch: number;
    theme: ViewTheme;
    /**
     * The result whose added blocks to draw, or null for none. The caller passes null while the model on stage is itself an
     * assembly (its own cubes are the blocks) or when the result has nothing added.
     */
    supports: AnalysisResult | null;
    /** Drawn (the toggle is on, and the parts are not exploded). */
    visible: boolean;
    /**
     * Steps of earlier stabilizer runs the model carries (tooltips number the run on screen from 1). The mesh on stage has no
     * log, so the host says (see assemblyParts.stepsBeforeOwnRun). A change rebuilds the cubes: their tooltips are made with it.
     */
    stepOffset?: number;
}

export interface SupportsOverlay {
    /** The cubes exist and are in the model's scene. */
    built: boolean;
    /** Changes whenever a layer is put in or taken out: the host re-applies hover and selection. */
    epoch: number;
    /** The overlay was asked for and its chunk or its scene could not be made (a deploy removed the chunk). */
    failed: boolean;
    setHover(index: number | null): void;
    setSelected(index: number | null): void;
    /** Eases the camera onto a cube (block index), with room round it. */
    frame(index: number): void;
}

const FOCUS_MS = 400;
const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useSupportsOverlay(args: SupportsOverlayArgs): SupportsOverlay {
    const { viewerRef, sceneRef, ready, viewerEpoch, modelEpoch, theme, supports, visible, stepOffset } = args;
    const layerRef = useRef<SupportsLayer | null>(null);
    /** The scene the layer is in: what it is taken out of. */
    const hostRef = useRef<GlbScene | null>(null);
    const [epoch, setEpoch] = useState(0);
    const [failed, setFailed] = useState(false);
    const latest = useRef(args);
    useEffect(() => {
        latest.current = args;
    });

    const wanted = ready && !!supports;

    // ---- scope: a layer lives as long as the scene it is in; a new model, a new viewer or "not wanted" takes it down ----
    useEffect(() => {
        return () => {
            const layer = layerRef.current;
            const host = hostRef.current;
            layerRef.current = null;
            hostRef.current = null;
            if (!layer) return;
            host?.setOverlay(null); // a scene that is already gone ignores it
            layer.dispose();
            // The model alone is framed again (while the camera is still on automatic) when its scene is the one on stage.
            // The viewer on stage when the layer goes (not the one it was made for) is the one to re-frame.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            const viewer = viewerRef.current;
            if (host && viewer && viewer.scene() === host) viewer.refresh();
            setEpoch((n) => n + 1);
        };
    }, [wanted, viewerEpoch, modelEpoch, viewerRef]);

    // ---- content: built when the result is, replaced in place when the result changes ----
    useEffect(() => {
        const viewer = viewerRef.current;
        const glb = sceneRef.current;
        if (!wanted || !supports || !viewer || !glb) {
            setFailed(false);
            return;
        }
        let cancelled = false;
        void import("./supportsLayer.ts")
            .then(({ createSupportsLayer }) => {
                if (cancelled || viewerRef.current !== viewer || sceneRef.current !== glb || viewer.contextLost()) return;
                const now = latest.current;
                const layer = createSupportsLayer({ analysis: supports, theme: now.theme, stepOffset, onChange: () => viewerRef.current?.requestFrame() });
                const previous = layerRef.current;
                glb.setOverlay({ object: layer.object, framed: layer.framed, box: layer.box, pick: layer.pickRay });
                glb.setOverlayVisible(now.visible);
                layerRef.current = layer;
                hostRef.current = glb;
                previous?.dispose();
                // The grid, the bounds and an automatic camera follow the cubes (a footing can stick out of the mesh).
                if (viewer.scene() === glb) viewer.refresh();
                setFailed(false);
                setEpoch((n) => n + 1);
            })
            .catch((cause: unknown) => {
                console.error("[viewer] the added supports could not be drawn", cause);
                if (cancelled) return;
                // Cubes made from an older result would say what this one does not: none is better than a stale one.
                const stale = layerRef.current;
                if (stale) {
                    layerRef.current = null;
                    hostRef.current?.setOverlay(null);
                    hostRef.current = null;
                    stale.dispose();
                    setEpoch((n) => n + 1);
                }
                setFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [wanted, supports, stepOffset, viewerEpoch, modelEpoch, viewerRef, sceneRef]);

    // ---- the look: the user's toggle, the theme ----
    useEffect(() => {
        const layer = layerRef.current;
        const glb = sceneRef.current;
        if (!layer || !glb || hostRef.current !== glb) return;
        if (glb.setOverlayVisible(visible)) {
            const viewer = viewerRef.current;
            if (viewer && viewer.scene() === glb) viewer.refresh();
        }
    }, [visible, epoch, sceneRef, viewerRef]);

    useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        layer.setTheme(theme);
        viewerRef.current?.requestFrame();
    }, [theme, epoch, viewerRef]);

    const setHover = useCallback((index: number | null) => layerRef.current?.setHover(index), []);
    const setSelected = useCallback((index: number | null) => layerRef.current?.setSelected(index), []);
    const frame = useCallback(
        (index: number) => {
            const box = layerRef.current?.boxOf(index);
            if (!box) return;
            const size = box.getSize(box.min.clone());
            viewerRef.current?.flyToBox(box.expandByScalar(Math.max(size.x, size.y, size.z) * 1.5), prefersReducedMotion() ? 0 : FOCUS_MS);
        },
        [viewerRef],
    );

    return { built: layerRef.current !== null && hostRef.current === sceneRef.current, epoch, failed, setHover, setSelected, frame };
}
