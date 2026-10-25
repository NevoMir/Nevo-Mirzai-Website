/**
 * Everything GlbViewer does for the block view, kept out of the component: it builds the block scene when the
 * view is asked for (and rebuilds it when the analysis changes), puts it on the stage in place of the model's
 * scene, keeps its look in step with AnalysisViewState, runs the HTML labels (the hover tooltip, the dimension
 * and COG labels, the callout of a focused issue), and answers the stage's hover, click and double-click.
 *
 * The block scene is lazy (its chunk loads on the first request) and owned here: it is disposed when the analysis
 * is replaced or cleared, when the model or the viewer goes away, and on unmount. Switching between the model and
 * the blocks swaps the scene and leaves the camera alone, except the very first look at a model's blocks, which
 * frames the whole 1 m volume. When the scene cannot be built (its chunk is gone after a deploy), `buildFailed`
 * says so, so the stage can tell the user instead of quietly showing the plain model.
 *
 * The result it is given is the one to show: the workspace picks it (the original or the stabilized version), and a
 * new result replaces the scene in place, so a switch never moves the camera. The colouring is the view's, resolved
 * against the result (resolveColorBy): a preview of the stabilizer (`previewing`) is in role colours, Stress without a
 * stress analysis is status. While previewing, blocks that were not in the previous result flash once.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AnalysisResult, AnalysisViewState } from "@/assignment/analysis/types";
import type { BlocksScene, BlocksViewPatch } from "./analysisLayer.ts";
import { planFocus } from "./analysisFocus.ts";
import { appearedBlocks, highlightCut, resolveColorBy, type SceneLabel } from "./analysisGeometry.ts";
import type { Environment, GlbScene } from "./glbScene.ts";
import type { OrbitViewer } from "./orbitViewer.ts";
import { blockTooltip, calloutElement, createLabelLayer, sceneLabelElement, type LabelLayer, type Placement } from "./overlayLabels.ts";
import type { Insets, ViewTheme } from "./types.ts";

const FOCUS_MS = 400;

const PLACEMENT: Record<SceneLabel["kind"], { placement: Placement; offset: number; clamp: boolean }> = {
    dimension: { placement: "center", offset: 0, clamp: false },
    cog: { placement: "right", offset: 16, clamp: true },
    tip: { placement: "right", offset: 8, clamp: true },
    cut: { placement: "left", offset: 8, clamp: true },
    stress: { placement: "above", offset: 10, clamp: true },
};

const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The part of the view the block scene is painted from. */
type LookOfView = Pick<AnalysisViewState, "colorBy" | "layerMax" | "showGhost" | "showCog" | "highlight">;

/** What the stage shows when the view is not set: the block view with everything at its default. */
const FALLBACK_VIEW: LookOfView = { colorBy: "status", layerMax: 99, showGhost: false, showCog: true, highlight: [] };

const patchOf = (view: LookOfView, analysis: AnalysisResult, previewing: boolean): BlocksViewPatch => ({
    colorBy: resolveColorBy(view, analysis, previewing),
    layerMax: view.layerMax,
    showGhost: view.showGhost,
    showCog: view.showCog,
    highlight: view.highlight,
});

export interface AnalysisBridgeArgs {
    viewerRef: RefObject<OrbitViewer | null>;
    sceneRef: RefObject<GlbScene | null>;
    envRef: RefObject<Environment | null>;
    /** An empty element over the stage, where the HTML labels live. */
    labelsHostRef: RefObject<HTMLElement | null>;
    stageRef: RefObject<HTMLElement | null>;
    /** The model is shown (the viewer, its scene and the first frame exist). */
    ready: boolean;
    viewerEpoch: number;
    /** Bumped when a model's scene is installed or removed. */
    modelEpoch: number;
    url: string | null;
    theme: ViewTheme;
    /** The result to draw (the workspace chooses the version on stage, or a preview of the stabilizer). */
    analysis: AnalysisResult | null | undefined;
    view: AnalysisViewState | undefined;
    /** `analysis` is a preview the stabilizer streams: drawn in role colours, with the blocks each step adds flashing once. */
    previewing?: boolean;
    /**
     * The model on stage is itself a block assembly (a stabilized model): its own cubes are the lattice the blocks are drawn on,
     * so the "original model" ghost would only lay a translucent shell over every block. No ghost is built for it.
     */
    noGhost?: boolean;
    /** Steps of earlier stabilizer runs the model carries, so a block tooltip numbers the run on screen from 1 (see addedWhen). */
    stepOffset?: number;
    onBlockHover?: (index: number | null) => void;
    onBlockClick?: (index: number | null) => void;
}

export interface AnalysisBridge {
    /** The blocks are on stage (state, for rendering). */
    active: boolean;
    /** The same, for the long-lived callbacks of the viewer. */
    isActive(): boolean;
    /** The hovered block, as text for assistive technology. */
    hoverText: string;
    /** Feed the viewer's hover into the blocks; true when it was theirs to handle. */
    handleHover(hit: { id: string } | null): boolean;
    pickBlock(clientX: number, clientY: number): number | null;
    frameBlock(index: number): void;
    click(index: number | null): void;
    /** Takes the blocks off the stage and frees them (the model or the viewer is going away). */
    drop(): void;
    /** The px of the stage the floating UI covers: the HTML labels stay out of them (they are drawn below that UI). */
    setLabelInsets(insets: Insets): void;
    /** The block view was asked for and could not be built (a chunk that will not load, a scene that threw). */
    buildFailed: boolean;
}

export function useAnalysisView(args: AnalysisBridgeArgs): AnalysisBridge {
    const { viewerRef, sceneRef, envRef, labelsHostRef, stageRef, ready, viewerEpoch, modelEpoch, url, theme, analysis, view } = args;
    // What the blocks are painted with: the view's colouring, made to fit the result (see resolveColorBy).
    const colorBy = view && analysis ? resolveColorBy(view, analysis, !!args.previewing) : "status";
    const blocksRef = useRef<BlocksScene | null>(null);
    const labelsRef = useRef<LabelLayer | null>(null);
    const activeRef = useRef(false);
    const hoverRef = useRef<number | null>(null);
    const rafRef = useRef(0);
    /** The focus token already flown to, the highlight the callout was made for (see analysisFocus); and the models whose blocks were framed once. */
    const appliedFocus = useRef<number | null>(null);
    const calloutFor = useRef<string | null>(null);
    const labelInsets = useRef<Insets | null>(null);
    const framed = useRef(new Set<string>());
    const [blocksEpoch, setBlocksEpoch] = useState(0);
    const [active, setActive] = useState(false);
    const [hoverText, setHoverText] = useState("");
    const [buildFailed, setBuildFailed] = useState(false);

    const latest = useRef(args);
    useEffect(() => {
        latest.current = args;
    });

    const wantBlocks = view?.mode === "blocks" && !!analysis;
    const highlightKey = view ? view.highlight.join(",") : "";
    // Every block of the pick is above the layer cut: nothing glows, so there is nothing to fly to or point at.
    const cut = analysis && view && view.highlight.length ? highlightCut(analysis.blocks, view.highlight, view.layerMax) : null;
    const highlightHidden = !!cut && cut.total > 0 && cut.hidden === cut.total;

    // ---- hover ----
    const endHover = useCallback((notify: boolean) => {
        if (hoverRef.current === null) return;
        hoverRef.current = null;
        blocksRef.current?.setHover(null);
        labelsRef.current?.remove("hover");
        if (stageRef.current) stageRef.current.style.cursor = "";
        setHoverText("");
        if (notify) latest.current.onBlockHover?.(null);
    }, [stageRef]);

    const handleHover = useCallback(
        (hit: { id: string } | null): boolean => {
            const blocks = blocksRef.current;
            if (!activeRef.current || !blocks) return false;
            const index = hit ? Number(hit.id) : null;
            if (index === hoverRef.current) return true;
            if (index === null || !Number.isFinite(index)) {
                endHover(true);
                return true;
            }
            const info = blocks.info(index);
            const anchor = blocks.anchorOf(index);
            if (!info || !anchor) {
                endHover(true);
                return true;
            }
            hoverRef.current = index;
            blocks.setHover(index);
            labelsRef.current?.set("hover", { anchor, key: `${index}|${blocks.colorOf(index)}`, el: () => blockTooltip(info, blocks.colorOf(index)), placement: "above", offset: 12, clamp: true });
            if (stageRef.current) stageRef.current.style.cursor = "pointer";
            setHoverText(info.text);
            viewerRef.current?.requestFrame();
            latest.current.onBlockHover?.(index);
            return true;
        },
        [endHover, stageRef, viewerRef],
    );

    // ---- freeing ----
    const drop = useCallback(() => {
        if (rafRef.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        const blocks = blocksRef.current;
        if (hoverRef.current !== null) {
            hoverRef.current = null;
            latest.current.onBlockHover?.(null); // the host forgets the block it was told about
        }
        labelsRef.current?.retain(new Set());
        setHoverText("");
        if (stageRef.current) stageRef.current.style.cursor = "";
        if (!blocks) return;
        blocksRef.current = null;
        activeRef.current = false;
        const viewer = viewerRef.current;
        // Off the stage before it is freed: the viewer may draw once more.
        if (viewer && viewer.scene() === blocks) {
            const glb = sceneRef.current;
            if (glb) viewer.setScene(glb);
        }
        blocks.dispose();
        setActive(false);
        setBlocksEpoch((n) => n + 1);
    }, [sceneRef, stageRef, viewerRef]);

    useEffect(() => drop, [drop]);

    // ---- the labels layer: one per viewer ----
    useEffect(() => {
        const viewer = viewerRef.current;
        const host = labelsHostRef.current;
        if (!viewer || !host) return;
        const layer = createLabelLayer(host, (point) => viewer.project(point));
        layer.setInsets(labelInsets.current);
        labelsRef.current = layer;
        const off = viewer.onFrame(() => layer.update());
        return () => {
            off();
            layer.dispose();
            if (labelsRef.current === layer) labelsRef.current = null;
        };
    }, [viewerEpoch, labelsHostRef, viewerRef]);

    // ---- the block scene: built when the view is asked for, replaced when the analysis is ----
    useEffect(() => {
        const viewer = viewerRef.current;
        const glb = sceneRef.current;
        if (!analysis) {
            drop();
            setBuildFailed(false);
            return;
        }
        if (!ready || !viewer || !glb) return;
        if (blocksRef.current?.analysis === analysis) return;
        // A block scene of an older analysis is not kept for a view nobody asked for.
        if (!wantBlocks) {
            drop();
            setBuildFailed(false);
            return;
        }
        let cancelled = false;
        void import("./analysisLayer.ts")
            .then((layer) => {
                if (cancelled || viewerRef.current !== viewer || sceneRef.current !== glb || viewer.contextLost()) return;
                const now = latest.current;
                const previous = blocksRef.current;
                const built = layer.createBlocksScene({
                    analysis,
                    view: patchOf(now.view ?? FALLBACK_VIEW, analysis, !!now.previewing),
                    theme: now.theme,
                    environment: envRef.current?.texture ?? null,
                    ghost: now.noGhost ? [] : glb.ghostSources(),
                    stepOffset: now.stepOffset,
                    onChange: () => viewerRef.current?.requestFrame(),
                    reducedMotion: prefersReducedMotion(),
                    // The blocks a step of the stabilizer added show once, against the result on stage before it.
                    fresh: now.previewing && previous ? appearedBlocks(previous.analysis.blocks, analysis.blocks) : undefined,
                });
                blocksRef.current = built;
                // Swapped in place when the old analysis was the one on stage: no flash of the model between them.
                if (previous && viewer.scene() === previous) viewer.setScene(built);
                previous?.dispose();
                endHover(true); // the new analysis has other blocks under the pointer
                setBuildFailed(false);
                setBlocksEpoch((n) => n + 1);
            })
            .catch((cause: unknown) => {
                console.error("[viewer] the block view could not be built", cause);
                // The analysis is done and the tab says so: the stage must not quietly keep showing the plain model.
                if (!cancelled) setBuildFailed(true);
            });
        return () => {
            cancelled = true;
        };
    }, [analysis, wantBlocks, ready, viewerEpoch, modelEpoch, drop, endHover, envRef, sceneRef, viewerRef]);

    // ---- which scene is on stage ----
    useEffect(() => {
        const viewer = viewerRef.current;
        const glb = sceneRef.current;
        if (!viewer || !glb || !ready) return;
        const blocks = wantBlocks ? blocksRef.current : null;
        const target = blocks ?? glb;
        if (viewer.scene() !== target) {
            viewer.setScene(target);
            const key = url ?? "";
            if (blocks && !framed.current.has(key)) {
                // The first look at a model's blocks: the whole 1 m volume, from where the camera looks.
                framed.current.add(key);
                viewer.fitView();
            } else viewer.refresh(); // a camera still on automatic follows the scene; one the user moved stays
        }
        activeRef.current = !!blocks;
        if (!blocks) endHover(true);
        setActive(!!blocks);
    }, [wantBlocks, blocksEpoch, ready, viewerEpoch, modelEpoch, url, endHover, sceneRef, viewerRef]);

    // ---- the look: colours, layer cut, ghost, COG, highlight, theme ----
    const kick = useCallback(() => {
        if (rafRef.current || typeof requestAnimationFrame !== "function") return;
        const step = (now: number) => {
            rafRef.current = 0;
            const blocks = blocksRef.current;
            const viewer = viewerRef.current;
            if (!blocks || !viewer) return;
            const more = blocks.animate(now);
            viewer.requestFrame();
            if (more && viewer.scene() === blocks) rafRef.current = requestAnimationFrame(step);
        };
        rafRef.current = requestAnimationFrame(step);
    }, [viewerRef]);

    const syncLabels = useCallback(() => {
        const layer = labelsRef.current;
        const blocks = blocksRef.current;
        if (!layer) return;
        if (!blocks || !activeRef.current) {
            layer.retain(new Set());
            return;
        }
        const keep = new Set<string>(["hover", "callout"]);
        for (const label of blocks.labels()) {
            keep.add(label.id);
            const place = PLACEMENT[label.kind];
            layer.set(label.id, { anchor: label.anchor, key: `${label.kind}|${label.text}|${label.sub ?? ""}|${label.tone}|${label.color ?? ""}`, el: () => sceneLabelElement(label), ...place });
        }
        layer.retain(keep);
    }, []);

    useEffect(() => {
        const blocks = blocksRef.current;
        const now = latest.current;
        if (!blocks || !now.view) return;
        blocks.setTheme(now.theme);
        // A scene born with blocks to flash needs its frames too, though its look did not change.
        if (blocks.setView(patchOf(now.view, blocks.analysis, !!now.previewing)) || blocks.flashing()) kick();
        syncLabels();
        viewerRef.current?.requestFrame();
    }, [blocksEpoch, active, theme, colorBy, view?.layerMax, view?.showGhost, view?.showCog, highlightKey, kick, syncLabels, viewerRef]);

    // ---- an issue was picked: fly to it and point at it (the rules are in analysisFocus) ----
    useEffect(() => {
        const blocks = blocksRef.current;
        const viewer = viewerRef.current;
        const layer = labelsRef.current;
        const focus = view?.focus ?? null;
        const plan = planFocus({
            token: focus?.token ?? null,
            active: active && !!blocks && !!viewer && !!layer,
            highlightKey,
            allHidden: highlightHidden,
            appliedToken: appliedFocus.current,
            calloutFor: calloutFor.current,
        });
        appliedFocus.current = plan.appliedToken;
        calloutFor.current = plan.calloutFor;
        if (!focus || !blocks || !viewer || !layer || !plan.showCallout) layer?.remove("callout");
        if (!focus || !blocks || !viewer || !layer) return;
        if (plan.fly) viewer.flyToBox(blocks.focusBox(focus.mm), prefersReducedMotion() ? 0 : FOCUS_MS);
        // Set again on every run: the same callout just follows its anchor (a re-run of the analysis may have moved the frame).
        if (plan.showCallout) layer.set("callout", { anchor: blocks.toWorld(focus.mm), key: `${focus.token}|${focus.label ?? ""}`, el: () => calloutElement(focus.label), placement: "center", offset: 0 });
        viewer.requestFrame();
    }, [active, blocksEpoch, viewerEpoch, view?.focus, highlightKey, highlightHidden, viewerRef]);

    const setLabelInsets = useCallback(
        (insets: Insets) => {
            const prev = labelInsets.current;
            if (prev && prev.top === insets.top && prev.right === insets.right && prev.bottom === insets.bottom && prev.left === insets.left) return;
            labelInsets.current = insets;
            labelsRef.current?.setInsets(insets);
            viewerRef.current?.requestFrame(); // the labels move on the next frame
        },
        [viewerRef],
    );

    const pickBlock = useCallback(
        (clientX: number, clientY: number): number | null => {
            if (!activeRef.current) return null;
            const id = viewerRef.current?.pick(clientX, clientY) ?? null;
            const index = id === null ? NaN : Number(id);
            return Number.isFinite(index) ? index : null;
        },
        [viewerRef],
    );

    const frameBlock = useCallback(
        (index: number) => {
            const blocks = blocksRef.current;
            const box = blocks?.boxOf(index);
            if (!blocks || !box) return;
            const size = box.getSize(box.min.clone());
            viewerRef.current?.flyToBox(box.expandByScalar(Math.max(size.x, size.y, size.z) * 1.5), prefersReducedMotion() ? 0 : FOCUS_MS);
        },
        [viewerRef],
    );

    const click = useCallback(
        (index: number | null) => {
            // A click on nothing (or Escape) lets go of the pick: the pointer goes with it, and stays gone.
            if (index === null) {
                calloutFor.current = null;
                labelsRef.current?.remove("callout");
            }
            // A touch screen has no pointer to hover with: a tap shows what the tooltip would have said.
            if (typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches) handleHover(index === null ? null : { id: String(index) });
            latest.current.onBlockClick?.(index);
        },
        [handleHover],
    );
    const isActive = useCallback(() => activeRef.current, []);

    return { active, isActive, hoverText, handleHover, pickBlock, frameBlock, click, drop, setLabelInsets, buildFailed };
}
