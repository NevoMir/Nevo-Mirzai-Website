/**
 * <GlbViewer url={...} />: Cably's three.js viewer layer for GLB models (no CAD engine behind it).
 *
 * The stage fills its parent. Everything three.js (the renderer, the GLB loader and its decoders, the
 * splitter) is imported on first use, so this file adds almost nothing to the page until a model is
 * shown. Floating UI (the toolbar, the parts list, the selection card, chips, the empty/loading/error
 * states and the `overlay`) lives in the part of the stage the `insets` leave uncovered, and the
 * camera frames the model around the middle of that same rect.
 *
 * One renderer serves every model the component is given: a new `url` aborts the load in flight,
 * swaps the scene and disposes the old one (geometries, materials, textures).
 *
 * A stabilized model is shown on its SOURCE mesh: the 3D tab draws that mesh and, over it, only the blocks the stabilizer added
 * (`supports`: solid cubes in their role colours, a legend chip with a switch, a tooltip and a card per cube; see
 * useSupportsOverlay), and the block view maps the stabilized blocks over the same mesh. The toolbar's download can name another
 * file than the one on stage (`downloadUrl`: the stabilized GLB).
 *
 * Structural analysis (see src/assignment/analysis): `onModelReady` hands the workspace the loaded geometry to
 * analyse (and takes it back, with null, when that model leaves the stage); given the result and
 * `analysisView.mode === "blocks"`, the stage shows the assembly as 100 mm blocks with the checks drawn on it
 * instead of the model (useAnalysisView does the work). The workspace owns the state of that view; the stage owns
 * its controls: the Colour chip and the legend under it (top left), the Layers popover and the Show menu (toolbar).
 * They report a choice through `onViewChange`, and this component renders the state it is given and reports hover and
 * clicks. Which version of a model is on stage (the original, or the stabilized model) is the workspace's switcher:
 * a version is simply the result this component is given.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AlertTriangle, Boxes, Layers, Loader2, RotateCcw } from "lucide-react";
import type { AnalysisResult, AnalysisViewState, LoadedModel } from "@/assignment/analysis/types";
import type { AssemblyDescriptor } from "@/assignment/shared/assembly";
import { Button } from "@/assignment/components/ui/button";
import { TooltipProvider } from "@/assignment/components/ui/tooltip";
import { useIsDark } from "@/assignment/hooks/useIsDark";
import { cn } from "@/assignment/lib/utils";
import { AnalysisLegend } from "./AnalysisLegend.tsx";
import { highlightCut, resolveColorBy } from "./analysisGeometry.ts";
import { assemblyCounts, assemblyNote, decorateAssemblyRows, stageStepOffset } from "./assemblyParts.ts";
import { ColorChip } from "./ColorChip.tsx";
import { downloadLabelFor, downloadStem, formatCount, num, partDetail, stageLabel } from "./format.ts";
import { createModelHandle, type ModelHandle } from "./loadedModel.ts";
import { PartsPanel } from "./PartsPanel.tsx";
import { SelectionCard } from "./SelectionCard.tsx";
import { stackHeight, type MeasuredStack } from "./stackHeight.ts";
import { paintThumbnailBackground, stageBackgroundCss } from "./stage.ts";
import { colorChipModel, layerCut } from "./stageControls.ts";
import { SupportCard } from "./SupportCard.tsx";
import { SupportsChip } from "./SupportsChip.tsx";
import { describeSupport, hasAddedSupports, routeHover, supportCounts, supportIndexOf, supportsDrawn } from "./supports.ts";
import type { PartRow, Px, ViewTheme } from "./types.ts";
import { ViewerContextMenu, type MenuEntry } from "./ViewerContextMenu.tsx";
import { useAnalysisView, type AnalysisBridge } from "./useAnalysisView.ts";
import { useSupportsOverlay } from "./useSupportsOverlay.ts";
import { ViewerToolbar, type SplitState } from "./ViewerToolbar.tsx";
// Types only: the runtime of these is imported lazily below.
import type { Environment, GlbScene } from "./glbScene.ts";
import type { OrbitViewer } from "./orbitViewer.ts";

export interface GlbViewerProps {
    url: string | null; // same-origin GLB URL; null -> empty stage
    title?: string; // used for the aria labels, and for the download file name unless downloadName is given
    /**
     * The file name (without ".glb") the toolbar's download saves under. Without it the title is used, with "-stabilized" added
     * for a stabilized model (which keeps its source's prompt), so the two versions never download under the same name.
     */
    downloadName?: string;
    insets?: { top: number; right: number; bottom: number; left: number }; // px of the stage covered by floating UI (top bar, chat panel). Keep toolbar, panels and model framing inside the uncovered rect.
    className?: string;
    overlay?: ReactNode; // rendered centred in the uncovered rect, above the model (generation progress)
    emptyState?: ReactNode; // shown when url is null
    onThumbnail?: (blob: Blob) => void; // once per url, after the first good render: 512x384 WebP (PNG fallback), model framed iso, transparent->stage colour background
    onLoadError?: (message: string) => void;
    /**
     * After every successful load of the model (a new url, a retry, a reloaded context): the geometry to analyse.
     * `extractTriangles()` is a soup of 9 floats per triangle in this viewer's Z-up display frame as loaded (no
     * explode or split offsets, hidden parts and every mesh included, world transforms baked). The handle is good
     * for as long as that model is shown: when it is replaced, the viewer is torn down or the component unmounts,
     * this is called with null and the old handle's extractTriangles throws (never an empty soup).
     */
    onModelReady?: (model: LoadedModel | null) => void;
    /**
     * The block view's data: the result to draw. The workspace picks it by the version on stage (the original, or the
     * stabilized model), so a switch is a new result here and never moves the camera. While the new version's own analysis is
     * on its way the workspace keeps handing the last version's result over the same mesh (components/workspace/stageHold.ts),
     * so the stage never falls back to the plain model in between. The blocks are only drawn when `analysisView.mode` is "blocks".
     */
    analysis?: AnalysisResult | null;
    analysisView?: AnalysisViewState;
    /**
     * A result the stabilizer streams while it works: when set in blocks mode it is drawn instead of `analysis`, in role
     * colours, and the blocks each step adds flash once. Its `transform` must be the one of the model on stage.
     */
    previewResult?: AnalysisResult | null;
    /** What the chip over a preview calls it ("Stabilizer preview", the default; a block edit and the optimizer have their own). */
    previewLabel?: string;
    /**
     * A stage control of the block view was used: the Colour chip (`colorBy`), the Layers popover (`layerMax`, the highest layer
     * shown, from 0) or the Show menu (`showCog`, `showGhost`). Without it those controls are not offered (the Colour chip only
     * reports what is on stage).
     */
    onViewChange?: (patch: Partial<Pick<AnalysisViewState, "colorBy" | "layerMax" | "showGhost" | "showCog">>) => void;
    /** The last pick raised the layer cut to keep its blocks in view: the stage says so (a chip, and a line in the Layers popover). */
    layerRaised?: boolean;
    /** A block is under the pointer (null: none). Not called while the blocks are not on stage. */
    onBlockHover?: (index: number | null) => void;
    /** A click on a block, or on nothing (null). */
    onBlockClick?: (index: number | null) => void;
    /** An analysis is running: a subtle "Analysing…" chip on the stage. */
    analysisBusy?: boolean;
    /**
     * A stabilized model shown on its source mesh: the analysis of the stabilized assembly under that mesh's transform
     * (`transform` maps the loaded mesh's frame to analysis mm). In the model view the blocks it holds with a role other than
     * "original" are drawn over the mesh as solid cubes in their role colours; the legend chip, tooltip and card say what they
     * are. Also the source of the step numbering and the block counts when the model on stage is a mesh. Ignored when the model
     * on stage is itself an assembly (its own cubes are the blocks).
     */
    supports?: AnalysisResult | null;
    /** The added supports are drawn (default true: the viewer keeps the switch itself unless this is given). */
    showSupports?: boolean;
    onShowSupportsChange?: (show: boolean) => void;
    /**
     * The file the toolbar's download saves, when it is not the one on stage (the stabilized assembly while its source mesh is
     * shown). Omitted: `url`. null: no download button.
     */
    downloadUrl?: string | null;
    /**
     * Steps of earlier stabilizer runs the stabilized model behind `supports` carries, so its tooltips and cards number the run
     * on screen from 1 ("added in step 1") as the Stabilize timeline does. The source mesh on stage has no log to read this from;
     * the workspace knows it: assemblyParts.stepsBeforeOwnRun(topStep, the model's own step count). Omitted: the loaded
     * assembly's own log (a stabilized model shown as itself), else 0.
     */
    stepOffset?: number;
    /**
     * The assembly of the version shown on its source mesh, for the step numbering only (the 3D tab no longer draws its added blocks, so
     * `supports` is not given): with `stepOffset`, the Stability and Optimization tabs number the run on screen from 1.
     */
    stepAssembly?: AssemblyDescriptor | null;
    /** What the toolbar's download says when `downloadUrl` is not the file on stage. Omitted: "Download stabilized GLB". */
    downloadLabel?: string;
}

type Phase = "idle" | "loading" | "ready" | "error" | "nowebgl" | "lost";

interface Looks {
    selected: string[];
    hidden: string[];
    isolated: string[] | null;
}

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const EMPTY_LOOKS: Looks = { selected: [], hidden: [], isolated: null };
const THUMBNAIL = { width: 512, height: 384 };
/** Below this stage width the four views fold into a menu and the parts list starts closed. */
const COMPACT_PX = 560;
/** A click is a press and release within this many px; further is an orbit. */
const CLICK_SLOP_PX = 6;
/** Space the viewer's own floating UI takes in the uncovered rect (the framing keeps the model clear of it). */
const PARTS_PX = 272;
const TOOLBAR_PX = 56;
const CHIPS_PX = 28;
/** The block view's chips (a summary, the Colour chip and the legend under it) stand higher. */
const BLOCK_CHIPS_PX = 88;
/** The added-supports legend chip adds this to the model view's chips. */
const SUPPORTS_CHIP_PX = 28;
/** The chip stack's distance from the top of the free rect (Tailwind's top-2). */
const STACK_TOP_PX = 8;
/** The identify tooltip goes below the pointer when there is less room than this above it. */
const TIP_ROOM_PX = 58;

const coarsePointer = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
const isTyping = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true']");
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const toggled = (ids: readonly string[], id: string) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
const nextFrames = (count: number) =>
    new Promise<void>((resolve) => {
        const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
        step(count);
    });

export default function GlbViewer({
    url,
    title,
    downloadName,
    insets,
    className,
    overlay,
    emptyState,
    onThumbnail,
    onLoadError,
    onModelReady,
    analysis: analysisProp,
    analysisView,
    previewResult,
    previewLabel = "Stabilizer preview",
    onViewChange,
    layerRaised,
    onBlockHover,
    onBlockClick,
    analysisBusy,
    supports,
    showSupports,
    onShowSupportsChange,
    downloadUrl: downloadUrlProp,
    stepOffset: stepOffsetProp,
    stepAssembly,
    downloadLabel: downloadLabelProp,
}: GlbViewerProps) {
    const free = insets ?? NO_INSETS;
    const dark = useIsDark();
    const theme: ViewTheme = dark ? "dark" : "light";
    const helpId = useId();

    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);
    const labelsHostRef = useRef<HTMLDivElement>(null);
    const bridgeRef = useRef<AnalysisBridge | null>(null);
    /** The url whose scene is on stage: what a LoadedModel's extractTriangles reads from. */
    const loadedUrlRef = useRef<string | null>(null);
    /** The handle given out for it, until it is retired. */
    const handleRef = useRef<ModelHandle | null>(null);
    const viewerRef = useRef<OrbitViewer | null>(null);
    const sceneRef = useRef<GlbScene | null>(null);
    const envRef = useRef<Environment | null>(null);
    const modulesRef = useRef<{ viewer: typeof import("./orbitViewer.ts"); scene: typeof import("./glbScene.ts") } | null>(null);
    const splitAbortRef = useRef<AbortController | null>(null);
    const loadAbortRef = useRef<AbortController | null>(null);
    const lostRef = useRef(false);
    /** Urls whose cover was made (or offered): once per url, not once per visit. */
    const thumbnailed = useRef(new Set<string>());
    /** The part the scene is lit as hovered, from the pointer or the parts list: an unchanged one costs nothing. */
    const hoverIdRef = useRef<string | null>(null);

    const [viewerWanted, setViewerWanted] = useState(false);
    const [viewerEpoch, setViewerEpoch] = useState(0);
    const [modelEpoch, setModelEpoch] = useState(0); // bumped when a model's scene is put on stage
    const [reloads, setReloads] = useState(0);
    const [attempt, setAttempt] = useState(0);
    const [phase, setPhase] = useState<Phase>("idle");
    const [progress, setProgress] = useState<number | null>(0);
    const [error, setError] = useState("");
    const [rows, setRows] = useState<readonly PartRow[]>([]);
    /** The block assembly the model on stage declares (a stabilized model), else null. */
    const [assembly, setAssembly] = useState<AssemblyDescriptor | null>(null);
    /** Steps of earlier stabilizer runs that assembly carries (a re-stabilized model); 0 otherwise. */
    const [earlier, setEarlier] = useState(0);
    const [stats, setStats] = useState({ triangles: 0, canSplit: false });
    const [looks, setLooks] = useState<Looks>(EMPTY_LOOKS);
    const [explode, setExplode] = useState(0);
    const [split, setSplit] = useState<SplitState>("off");
    const [splitProgress, setSplitProgress] = useState(0);
    const [treeUser, setTreeUser] = useState<boolean | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [menu, setMenu] = useState<{ at: Px; entries: MenuEntry[] } | null>(null);
    const [tipId, setTipId] = useState<string | null>(null);
    const [stage, setStage] = useState({ width: 0, height: 0 });
    const [ring, setRing] = useState(false); // the stage was focused from the keyboard
    const pointerFocus = useRef(false);
    /** The cube a click picked (a block index of the `supports` it was picked in: a new result forgets it). */
    const [supportPick, setSupportPick] = useState<{ of: AnalysisResult; index: number } | null>(null);
    /** The switch of the added supports while the host does not keep it. */
    const [supportsLocal, setSupportsLocal] = useState(true);

    // The latest of everything the viewer's long-lived callbacks read.
    const looksRef = useRef(looks);
    const rowsRef = useRef(rows);
    const themeRef = useRef(theme);
    const insetsRef = useRef(free);
    const stageWidthRef = useRef(0);
    const callbacks = useRef({ onThumbnail, onLoadError, onModelReady });
    /** The added supports, for the long-lived callbacks of the viewer (its hover is made once, with the viewer). */
    const supportsRef = useRef<{ hoverable: boolean; setHover(index: number | null): void }>({ hoverable: false, setHover: () => undefined });
    useEffect(() => {
        rowsRef.current = rows;
        themeRef.current = theme;
        insetsRef.current = free;
        callbacks.current = { onThumbnail, onLoadError, onModelReady };
    });
    const tipAt = useRef<Px>({ x: 0, y: 0 });
    const press = useRef<{ x: number; y: number } | null>(null);
    const menuPress = useRef<{ x: number; y: number } | null>(null);

    // The workspace is told when the model it analyses leaves the stage, so it never analyses a scene that is gone.
    const retireModel = useCallback(() => {
        const handle = handleRef.current;
        handleRef.current = null;
        if (handle?.retire()) callbacks.current.onModelReady?.(null);
    }, []);

    // ---- looks: selection, hidden, isolated ----
    const applyLooks = useCallback((next: Looks) => {
        looksRef.current = next;
        setLooks(next);
        sceneRef.current?.update({ selected: next.selected, hidden: next.hidden, isolated: next.isolated }); // draws its own frame when something changed
    }, []);
    const setHover = useCallback((id: string | null) => {
        const scene = sceneRef.current;
        if (!scene || hoverIdRef.current === id) return;
        hoverIdRef.current = id;
        scene.update({ hover: id });
    }, []);
    const reload = useCallback(() => {
        lostRef.current = false;
        setPhase("loading");
        setReloads((n) => n + 1);
    }, []);
    // Parts and an added support are picked one at a time: picking a part (from the stage or the parts list) lets go of the cube.
    const select = (ids: string[]) => {
        if (ids.length > 0) setSupportPick(null);
        applyLooks({ ...looksRef.current, selected: ids });
    };
    const toggleHidden = (ids: readonly string[]) => {
        const now = looksRef.current;
        const allHidden = ids.length > 0 && ids.every((id) => now.hidden.includes(id));
        applyLooks({ ...now, hidden: allHidden ? now.hidden.filter((id) => !ids.includes(id)) : [...new Set([...now.hidden, ...ids])] });
    };
    const isolate = (ids: readonly string[]) => {
        if (!ids.length) return;
        const now = looksRef.current;
        applyLooks({ ...now, isolated: [...ids], hidden: now.hidden.filter((id) => !ids.includes(id)) });
    };
    const exitIsolate = () => applyLooks({ ...looksRef.current, isolated: null });
    const showAll = () => applyLooks({ ...looksRef.current, hidden: [] });
    const objectsOf = (ids: readonly string[]) => ids.flatMap((id) => sceneRef.current?.objectsOf(id) ?? []);
    // F reads the selection through a ref: the viewer's callback is made once, with the viewer.
    const objectsOfRef = useRef(objectsOf);
    useEffect(() => {
        objectsOfRef.current = objectsOf;
    });
    const frame = (ids: readonly string[]) => viewerRef.current?.fit(objectsOf(ids));
    const stepBack = () => {
        if (supportSel !== null) setSupportPick(null);
        else if (looksRef.current.selected.length) select([]);
        else if (looksRef.current.isolated) exitIsolate();
    };
    const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;

    const entriesFor = (ids: readonly string[]): MenuEntry[] => {
        const now = looksRef.current;
        const allHidden = ids.every((id) => now.hidden.includes(id));
        return [
            now.isolated ? { label: "Exit isolate", run: exitIsolate } : { label: "Isolate", run: () => isolate(ids) },
            { label: allHidden ? "Show" : "Hide", run: () => toggleHidden(ids) },
            { label: "Show all", run: showAll, disabled: now.hidden.length === 0, title: now.hidden.length === 0 ? "Nothing is hidden" : undefined },
            { label: "Frame selection", run: () => frame(ids) },
        ];
    };
    const spaceEntries = (): MenuEntry[] => [
        { label: "Show all", run: showAll, disabled: looksRef.current.hidden.length === 0, title: looksRef.current.hidden.length === 0 ? "Nothing is hidden" : undefined },
        ...(looksRef.current.isolated ? [{ label: "Exit isolate", run: exitIsolate }] : []),
        { label: "Fit everything", run: () => viewerRef.current?.setView("fit") },
    ];

    // ---- the identify tooltip follows the pointer without re-rendering ----
    const placeTip = useCallback(() => {
        const el = tipRef.current;
        if (!el) return;
        const { x, y } = tipAt.current;
        const w = stageWidthRef.current;
        const along = w > 0 ? Math.min(1, Math.max(0, x / w)) : 0.5;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.transform = `translate(${-along * 100}%, ${y < TIP_ROOM_PX ? "10px" : "calc(-100% - 10px)"})`;
    }, []);
    useLayoutEffect(placeTip, [tipId, placeTip]);

    // ---- stage size (responsive decisions, tooltip edges) ----
    useEffect(() => {
        const el = rootRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const measure = () => {
            stageWidthRef.current = el.clientWidth;
            setStage((prev) => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    // ---- 1. the viewer: created on the first model, kept for the component's life ----
    useEffect(() => {
        if (url !== null) setViewerWanted(true);
    }, [url]);

    useEffect(() => {
        const host = stageRef.current;
        if (!viewerWanted || !host) return;
        let cancelled = false;
        let viewer: OrbitViewer | null = null;
        lostRef.current = false;
        void (async () => {
            try {
                const [viewerModule, sceneModule] = await Promise.all([import("./orbitViewer.ts"), import("./glbScene.ts")]);
                if (cancelled) return;
                try {
                    viewer = viewerModule.mountOrbitViewer(host, viewerModule.createEmptyViewerScene(), {
                        theme: themeRef.current,
                        coarsePointer: coarsePointer(),
                        insets: insetsRef.current,
                        // Focus is read when F is pressed: the selection, else everything (and among blocks, always everything).
                        focus: () => (bridgeRef.current?.isActive() ? [] : objectsOfRef.current(looksRef.current.selected)),
                        hoverEnabled: () => rowsRef.current.length > 1 || !!bridgeRef.current?.isActive() || supportsRef.current.hoverable,
                        onHover: (hit) => {
                            if (bridgeRef.current?.handleHover(hit)) return; // a block, not a part
                            // An added support has an id of its own: it is lit by the overlay, not by the scene's parts. The pointer tracks
                            // a one-part model only so its cubes can be hovered: that lone mesh gets no tint and no part tooltip.
                            const route = routeHover(hit?.id, rowsRef.current.length);
                            supportsRef.current.setHover(route.support);
                            setHover(route.part);
                            if (hit) {
                                tipAt.current = { x: hit.x, y: hit.y };
                                placeTip();
                            }
                            setTipId(route.tip);
                        },
                        onContextLost: () => {
                            lostRef.current = true;
                            setPhase("lost");
                        },
                        // What the environment holds is not restored with the context: a fresh viewer, as the Reload button makes.
                        onContextRestored: reload,
                    });
                } catch (cause) {
                    console.error("[viewer] the 3D view could not start", cause);
                    if (cause instanceof viewerModule.NoWebGLError) setPhase("nowebgl");
                    else {
                        setError("The 3D view could not start.");
                        setPhase("error");
                    }
                    return;
                }
                modulesRef.current = { viewer: viewerModule, scene: sceneModule };
                try {
                    envRef.current = sceneModule.createEnvironment(viewer.renderer);
                } catch (cause) {
                    // Reflections are a refinement: the three lights still show the model.
                    console.warn("[viewer] the environment could not be built", cause);
                }
                viewerRef.current = viewer;
                setViewerEpoch((n) => n + 1);
            } catch (cause) {
                if (cancelled) return;
                // three and the viewer are chunks of their own: after a deploy, only a page reload finds them.
                console.error("[viewer] the 3D modules could not be loaded", cause);
                setError("The 3D viewer could not be loaded. Reload the page and try again.");
                setPhase("error");
            }
        })();
        return () => {
            cancelled = true;
            retireModel(); // its scene goes with the viewer
            splitAbortRef.current?.abort();
            bridgeRef.current?.drop(); // the blocks come off the stage while there is one
            viewer?.dispose();
            sceneRef.current?.dispose();
            envRef.current?.dispose();
            viewerRef.current = null;
            sceneRef.current = null;
            envRef.current = null;
            modulesRef.current = null;
            hoverIdRef.current = null;
            loadAbortRef.current?.abort(); // a download in flight has no viewer to go to
            setTipId(null);
        };
    }, [viewerWanted, reloads, placeTip, setHover, reload, retireModel]);

    // ---- 2. the model: load, build, show; dispose on the next url ----
    useEffect(() => {
        const viewer = viewerRef.current;
        const modules = modulesRef.current;
        if (!viewer || !modules || lostRef.current) return;
        const controller = new AbortController();
        loadAbortRef.current = controller;
        let cancelled = false;
        // This run's result must not be shown (or kept) once a newer url or retry took over, its viewer was replaced,
        // or the GL context is gone: a dead canvas draws nothing, and "ready" would hide the "paused" card.
        const stale = () => cancelled || lostRef.current || viewerRef.current !== viewer || viewer.contextLost();

        applyLooks(EMPTY_LOOKS);
        hoverIdRef.current = null;
        setRows([]);
        setAssembly(null);
        setEarlier(0);
        setStats({ triangles: 0, canSplit: false });
        setExplode(0);
        setSplit("off");
        setTreeUser(null); // the parts list follows the new model, not the last model's split
        setNotice(null);
        setMenu(null);
        setTipId(null);
        setSupportPick(null);
        if (url === null) {
            setPhase("idle");
            return;
        }
        setPhase("loading");
        setProgress(0);
        setError("");

        void (async () => {
            try {
                const { loadGlb } = await import("./loadGlb.ts");
                const loaded = await loadGlb(url, { signal: controller.signal, renderer: viewer.renderer, onProgress: (fraction) => !cancelled && setProgress(fraction) });
                if (stale()) {
                    modules.scene.disposeObject(loaded.scene);
                    return;
                }
                let scene: GlbScene;
                try {
                    scene = modules.scene.buildGlbScene(loaded.scene, { environment: envRef.current?.texture ?? null, onChange: () => viewerRef.current?.requestFrame() });
                } catch (cause) {
                    modules.scene.disposeObject(loaded.scene);
                    throw cause;
                }
                sceneRef.current = scene;
                loadedUrlRef.current = url;
                viewer.setScene(scene);
                viewer.setView("iso");
                setRows(scene.rows);
                setAssembly(loaded.assembly);
                setEarlier(loaded.stepOffset);
                setStats({ triangles: scene.triangles, canSplit: scene.canSplit });
                setModelEpoch((n) => n + 1);
                setPhase("ready");
                // The analysis reads the geometry through the url; a retry or a reloaded context hands over a fresh handle
                // (the old one was retired when its scene went), and a retired handle throws rather than read as empty.
                retireModel();
                const handle = createModelHandle(url, () => (loadedUrlRef.current === url && sceneRef.current ? sceneRef.current.extractTriangles() : null), loaded.assembly);
                handleRef.current = handle;
                callbacks.current.onModelReady?.(handle.model);
                // The first good render of this model is its thumbnail (the stage has had a frame or two to settle).
                if (callbacks.current.onThumbnail && !thumbnailed.current.has(url)) {
                    await nextFrames(2);
                    if (stale()) return;
                    // Always the model, even if the block view happens to be on stage. The added supports of a stabilized model are not
                    // there yet (the workspace analyses the stabilized GLB after this mesh is up), so its cover is the bare mesh, as the original's.
                    const blob = await viewer.snapshot({ ...THUMBNAIL, scene, paintBackground: paintThumbnailBackground });
                    if (stale() || !blob) return;
                    thumbnailed.current.add(url);
                    callbacks.current.onThumbnail?.(blob);
                }
            } catch (cause) {
                if (stale() || isAbort(cause)) return;
                console.error("[viewer] the model could not be shown", cause);
                const message = cause instanceof Error && cause.message ? cause.message : "The model could not be displayed.";
                setError(message);
                setPhase("error");
                callbacks.current.onLoadError?.(message);
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            retireModel(); // before its scene is freed: nobody may read the geometry of a model that is going
            splitAbortRef.current?.abort();
            hoverIdRef.current = null;
            bridgeRef.current?.drop(); // its ghost shares the model's geometry
            loadedUrlRef.current = null;
            const old = sceneRef.current;
            sceneRef.current = null;
            if (old) {
                // Off the stage before it is freed: the viewer may draw once more before the next scene arrives.
                viewerRef.current?.setScene(modules.viewer.createEmptyViewerScene());
                old.dispose();
            }
        };
        // applyLooks and retireModel are stable; the model depends on the url, a retry, and a fresh viewer.
    }, [url, attempt, viewerEpoch, applyLooks, retireModel]);

    // ---- layout ----
    const freeWidth = Math.max(0, stage.width - free.left - free.right);
    const compact = freeWidth > 0 && freeWidth < COMPACT_PX;
    const ready = phase === "ready";
    const multi = rows.length > 1;
    // What the stage draws: the stabilizer's live preview while there is one (and the block view is asked for), else the result.
    const previewing = !!previewResult && analysisView?.mode === "blocks";
    const analysis = previewing ? previewResult : analysisProp;
    const colorBy = analysisView && analysis ? resolveColorBy(analysisView, analysis, previewing) : "status";
    // A stabilized model on stage: its parts are its roles. One shown on its source mesh has none of that, but the result it is given
    // (`supports`: the stabilized assembly) still says how many blocks it started with and how many were added, for its name.
    const stageCounts = useMemo(() => (assembly ? assemblyCounts(assembly) : null), [assembly]);
    const counts = useMemo(() => stageCounts ?? (supports?.assembly ? assemblyCounts(supports.assembly.descriptor) : null), [stageCounts, supports]);
    const viewRows = useMemo(() => decorateAssemblyRows(rows, assembly), [rows, assembly]);
    // The added supports: drawn over a mesh. Not when the model on stage is itself an assembly (its cubes are the blocks).
    const supportsResult = supports && !assembly && hasAddedSupports(supports) ? supports : null;
    const supportList = useMemo(() => (supportsResult ? supportCounts(supportsResult.blocks) : []), [supportsResult]);
    const supportsAsked = showSupports ?? supportsLocal;
    const setSupportsShown = (show: boolean) => {
        setSupportsLocal(show);
        if (!show) setSupportPick(null); // a card for a cube that is not drawn would point at nothing
        onShowSupportsChange?.(show);
    };
    // The tooltips number the steps of the run on screen from 1: a preview continues from the model's top step, a saved model from its own log.
    // A stabilized model shown on its source mesh has no log on stage (`earlier` is 0 there): the host gives the offset (`stepOffset`).
    const modelAssembly = assembly ?? supports?.assembly?.descriptor ?? stepAssembly ?? null;
    const savedStepOffset = stageStepOffset({ assembly: modelAssembly, previewing: false, hosted: stepOffsetProp, earlier });
    const stepOffset = previewing ? stageStepOffset({ assembly: modelAssembly, previewing: true, earlier }) : savedStepOffset;
    // The block view: the analysis drawn as blocks, in place of the model's scene.
    const bridge = useAnalysisView({
        viewerRef,
        sceneRef,
        envRef,
        labelsHostRef,
        stageRef,
        ready,
        viewerEpoch,
        modelEpoch,
        url,
        theme,
        analysis,
        view: analysisView,
        previewing,
        // A stabilized model's own cubes are the lattice: a ghost of them would only veil the blocks (see useAnalysisView).
        noGhost: !!assembly,
        stepOffset,
        onBlockHover,
        onBlockClick,
    });
    useEffect(() => {
        bridgeRef.current = bridge;
    });
    const blocksOn = ready && bridge.active && !!analysis;
    // The added supports: exploding the parts would leave them behind, so they are put away while it lasts.
    const cubes = useSupportsOverlay({ viewerRef, sceneRef, ready, viewerEpoch, modelEpoch, theme, supports: supportsResult, visible: supportsAsked && explode === 0, stepOffset: savedStepOffset });
    const supportSel = supportPick && supportPick.of === supportsResult ? supportPick.index : null;
    const { setSelected: selectCube, setHover: hoverCube, epoch: cubesEpoch, frame: frameCube } = cubes;
    useEffect(() => {
        selectCube(blocksOn ? null : supportSel);
    }, [selectCube, supportSel, blocksOn, cubesEpoch]);
    const cubesDrawn = supportsDrawn({ has: !!supportsResult, shown: supportsAsked, explode, blocks: blocksOn });
    useEffect(() => {
        supportsRef.current = { hoverable: cubesDrawn, setHover: hoverCube };
    });
    const clearSupport = () => setSupportPick(null);
    const pickSupport = (index: number) => {
        if (!supportsResult) return;
        select([]);
        setSupportPick({ of: supportsResult, index });
    };
    const supportInfo = (index: number | null) => {
        const block = supportsResult && index !== null ? supportsResult.blocks[index] : undefined;
        return supportsResult && block ? describeSupport(block, supportsResult.settings, savedStepOffset) : null;
    };
    const treeOpen = ready && !blocksOn && (treeUser ?? (multi && !compact));
    // ---- theme, insets, explode ----
    useEffect(() => {
        viewerRef.current?.setTheme(theme);
    }, [theme, viewerEpoch]);
    // The camera frames the model beside the viewer's own floating UI too: the parts list, the toolbar, the chips.
    // The chip stack's real height, not a guess: the legend, the summary and the Colour chip wrap on a narrow stage. The
    // constants stand in until it is measured (and for the first frame after the view changes). Only the stack that is always
    // there is measured; the chips that come and go (Analysing, notices) must not re-frame the camera.
    const stackRef = useRef<HTMLDivElement>(null);
    const [stack, setStack] = useState<MeasuredStack | null>(null);
    useLayoutEffect(() => {
        const el = stackRef.current;
        if (!el) return;
        const measure = () => {
            const px = Math.ceil(el.getBoundingClientRect().height) + STACK_TOP_PX;
            setStack((prev) => (prev && prev.blocks === blocksOn && prev.px === px ? prev : { blocks: blocksOn, px }));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ready, blocksOn]);
    const supportsChipOn = !blocksOn && !!supportsResult && supportList.length > 0;
    const stackEstimate = blocksOn ? BLOCK_CHIPS_PX : CHIPS_PX + (supportsChipOn ? SUPPORTS_CHIP_PX : 0);
    const frameTop = free.top + (ready ? stackHeight(stack, blocksOn, stackEstimate, STACK_TOP_PX) : 0);
    const frameRight = free.right;
    const frameBottom = free.bottom + (ready ? TOOLBAR_PX : 0);
    const frameLeft = free.left + (treeOpen ? PARTS_PX : 0);
    useEffect(() => {
        viewerRef.current?.setInsets({ top: frameTop, right: frameRight, bottom: frameBottom, left: frameLeft });
    }, [frameTop, frameRight, frameBottom, frameLeft, viewerEpoch]);
    // The HTML labels are drawn below the floating UI (the top bar, the report dock, the chat): they keep to the same free rect the camera frames in.
    const { setLabelInsets } = bridge;
    useEffect(() => {
        setLabelInsets({ top: frameTop, right: frameRight, bottom: frameBottom, left: frameLeft });
    }, [frameTop, frameRight, frameBottom, frameLeft, setLabelInsets]);
    // An issue picked and then cut away by the layer slider glows nowhere: say so instead of showing an unexplained empty stage.
    const cutNote = blocksOn && analysis && analysisView && analysisView.highlight.length > 0 ? highlightCut(analysis.blocks, analysisView.highlight, analysisView.layerMax) : null;
    // The block view's stage controls (the Colour chip, the Layers popover and the Show menu) read the view they are given and report a choice.
    const layerState = useMemo(() => (blocksOn && analysis && analysisView ? layerCut(analysis.blocks, analysisView.layerMax, analysis.settings.blockSizeMm) : null), [blocksOn, analysis, analysisView]);
    const colorModel = useMemo(() => (blocksOn && analysis ? colorChipModel({ analysis, colorBy, previewing, busy: !!analysisBusy }) : null), [blocksOn, analysis, colorBy, previewing, analysisBusy]);
    useEffect(() => {
        const scene = sceneRef.current;
        if (!scene) return;
        scene.setExplode(explode);
        viewerRef.current?.refresh();
    }, [explode]);
    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(null), 6000);
        return () => clearTimeout(timer);
    }, [notice]);

    // ---- split into parts ----
    const partsChanged = (scene: GlbScene, splitting: boolean) => {
        applyLooks(EMPTY_LOOKS);
        hoverIdRef.current = null; // the scene dropped its looks with its parts
        setRows(scene.rows);
        // The pieces are the point of splitting; a narrow stage keeps the list closed until asked. Joined again, the list follows the part count.
        setTreeUser(splitting && !compact ? true : null);
        viewerRef.current?.refresh();
    };
    const toggleSplit = async () => {
        const scene = sceneRef.current;
        if (!scene || split === "working") return;
        if (split === "on") {
            scene.unsplit();
            partsChanged(scene, false);
            setSplit("off");
            return;
        }
        const controller = new AbortController();
        splitAbortRef.current = controller;
        setSplit("working");
        setSplitProgress(0);
        try {
            const summary = await scene.split({ signal: controller.signal, onProgress: setSplitProgress });
            if (controller.signal.aborted || sceneRef.current !== scene) return;
            if (!summary.changed) {
                setSplit("off");
                setNotice(summary.components > 1 ? "This model could not be divided into separate parts." : "This model is one connected piece, so there is nothing to split.");
                return;
            }
            partsChanged(scene, true);
            setSplit("on");
            setNotice(`Split into ${summary.pieces} parts${summary.merged > 0 ? `; ${summary.merged} small ${summary.merged === 1 ? "fragment is" : "fragments are"} grouped as "Small pieces"` : ""}.`);
        } catch (cause) {
            if (controller.signal.aborted || sceneRef.current !== scene) return;
            setSplit("off");
            console.error("[viewer] split failed", cause);
            setNotice(cause instanceof Error && cause.name === "SplitTooLargeError" ? cause.message : "The model could not be split into parts.");
        }
    };

    // ---- stage pointer and keys ----
    const near = (down: { x: number; y: number } | null, event: { clientX: number; clientY: number }) => !!down && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= CLICK_SLOP_PX;
    const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        // A canvas click would not move focus by itself; the keys listen on the stage. (No ring for this focus: it is not the keyboard's.)
        pointerFocus.current = true;
        stageRef.current?.focus({ preventScroll: true });
        pointerFocus.current = false;
        press.current = { x: event.clientX, y: event.clientY };
        if (event.button === 2) menuPress.current = { x: event.clientX, y: event.clientY };
    };
    const blockEntries = (index: number | null): MenuEntry[] => [
        ...(index !== null
            ? [
                  { label: "Select block", run: () => bridge.click(index) },
                  { label: "Frame block", run: () => bridge.frameBlock(index) },
              ]
            : [{ label: "Clear selection", run: () => bridge.click(null) }]),
        { label: "Fit the 1 m volume", run: () => viewerRef.current?.setView("fit") },
    ];
    const supportEntries = (index: number): MenuEntry[] => [
        { label: "Frame support", run: () => frameCube(index) },
        { label: "Hide added supports", run: () => setSupportsShown(false) },
        { label: "Clear selection", run: clearSupport },
    ];
    const onStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
        const viewer = viewerRef.current;
        if (!viewer || phase !== "ready") return;
        if (bridge.isActive()) {
            // The blocks are on stage: a click picks a block (or nothing), a right-click opens a small menu.
            if (event.button === 2) {
                const down = menuPress.current;
                menuPress.current = null;
                if (!near(down, event)) return;
                const index = bridge.pickBlock(event.clientX, event.clientY);
                setMenu({ at: { x: event.clientX, y: event.clientY }, entries: blockEntries(index) });
            } else if (event.button === 0 && near(press.current, event)) bridge.click(bridge.pickBlock(event.clientX, event.clientY));
            return;
        }
        if (event.button === 2) {
            const down = menuPress.current;
            menuPress.current = null;
            if (!near(down, event)) return;
            const id = viewer.pick(event.clientX, event.clientY);
            const support = supportIndexOf(id);
            if (support !== null) {
                // An added support is not a part: its menu frames it or puts the supports away.
                pickSupport(support);
                setMenu({ at: { x: event.clientX, y: event.clientY }, entries: supportEntries(support) });
                return;
            }
            if (id && !looksRef.current.selected.includes(id)) select([id]);
            if (id) clearSupport();
            setMenu({ at: { x: event.clientX, y: event.clientY }, entries: id ? entriesFor(looksRef.current.selected) : spaceEntries() });
            return;
        }
        if (event.button !== 0 || !near(press.current, event)) return;
        // A click selects the part under it (Shift, Cmd or Ctrl adds or removes), or clears. A click on an added support picks that
        // cube (and lets go of the parts); a click on a part, or on nothing, lets go of the cube.
        const id = viewer.pick(event.clientX, event.clientY);
        const support = supportIndexOf(id);
        if (support !== null) {
            pickSupport(support);
            return;
        }
        const adding = event.shiftKey || event.metaKey || event.ctrlKey;
        const selected = looksRef.current.selected;
        if (id || !adding) clearSupport();
        select(id ? (adding ? toggled(selected, id) : [id]) : adding ? selected : []);
    };
    const onKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (phase !== "ready" || isTyping(event.target) || !event.currentTarget.contains(event.target as Node) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (bridge.isActive()) {
            // The parts keys have nothing to act on among blocks; Escape lets go of the selected block.
            if (event.key === "Escape") {
                bridge.click(null);
                event.preventDefault();
            }
            return;
        }
        const selected = looksRef.current.selected;
        const key = event.key.toLowerCase();
        const outside = event.target !== stageRef.current; // inside the stage F and 0 are the viewer's own
        if (key === "i") {
            if (looksRef.current.isolated) exitIsolate();
            else isolate(selected);
        } else if (key === "h" && event.shiftKey) showAll();
        else if (key === "h") toggleHidden(selected);
        else if (key === "escape") stepBack();
        else if (key === "f" && outside) frame(selected);
        else if (key === "0" && outside) viewerRef.current?.setView("fit");
        else return;
        event.preventDefault();
    };
    const refocus = () => {
        pointerFocus.current = true;
        stageRef.current?.focus({ preventScroll: true });
        pointerFocus.current = false;
    };

    const selectedRows = viewRows.filter((r) => looks.selected.includes(r.id));
    const hoveredRow = tipId ? viewRows.find((r) => r.id === tipId) : undefined; // the decorated rows, so a role reads "9 blocks" here as in the list
    const hoveredSupport = cubesDrawn ? supportInfo(supportIndexOf(tipId)) : null; // an added support under the pointer (not a part)
    // The card describes a cube that is drawn: not one put away by the switch or by exploding the parts.
    const pickedSupport = cubesDrawn ? supportInfo(supportSel) : null;
    const allSelectedHidden = looks.selected.length > 0 && looks.selected.every((id) => looks.hidden.includes(id));
    const stabilized = !!counts && counts.added > 0;
    const label = stageLabel(title, stabilized);
    const chip = "pointer-events-auto flex items-center gap-1.5 rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-foreground shadow-sm backdrop-blur";
    const chipButton = "rounded px-1 font-medium text-primary hover:underline";
    const showEmpty = url === null && !overlay && phase === "idle";
    // A url with the phase still idle is the viewer's own start (its chunks, the renderer, the environment): loading too.
    const loading = phase === "loading" || (url !== null && phase === "idle");
    const card = "pointer-events-auto flex max-w-xs flex-col items-center gap-3 rounded-2xl border border-border/70 bg-sidebar/95 p-6 text-center text-sm text-muted-foreground shadow-lg backdrop-blur";

    return (
        <TooltipProvider delayDuration={300}>
            <div ref={rootRef} className={cn("absolute inset-0 overflow-hidden", className)} onKeyDown={onKeys}>
                {/* The viewer's container: it owns the canvas inside, so React puts nothing there. */}
                <div
                    ref={stageRef}
                    tabIndex={0}
                    role="application"
                    aria-roledescription="3D viewer"
                    aria-label={label}
                    aria-describedby={helpId}
                    className={cn("absolute inset-0 outline-none [&_canvas]:block", ring && "ring-2 ring-inset ring-ring")}
                    style={{ background: stageBackgroundCss(theme) }}
                    onFocus={() => setRing(!pointerFocus.current)}
                    onBlur={() => setRing(false)}
                    onPointerDown={onStagePointerDown}
                    onPointerUp={onStagePointerUp}
                    onPointerLeave={() => setTipId(null)}
                    onDoubleClick={(event) => {
                        if (bridge.isActive()) {
                            const index = bridge.pickBlock(event.clientX, event.clientY);
                            if (index !== null) bridge.frameBlock(index);
                            return;
                        }
                        const id = ready ? viewerRef.current?.pick(event.clientX, event.clientY) : null;
                        const support = supportIndexOf(id);
                        if (support !== null) frameCube(support);
                        else if (id) frame([id]);
                    }}
                />
                <p id={helpId} className="sr-only">
                    Arrow keys orbit, Shift and the arrow keys pan, plus and minus zoom, F frames the selection (or everything), 0 frames everything, and 1 to 4 pick the Iso, Top, Front and Right views. A click selects a part, and
                    Shift-click adds one; Escape steps back. H hides or shows the selection, Shift+H shows everything, and I isolates the selection.
                    {blocksOn && " In the block view, hovering a block says where it is and why it is the colour it is, a click selects it, a double-click frames it, and Escape lets go."}
                    {supportsChipOn && " The cubes the stabilizer added to the model are not parts: hovering one says what it is for, a click selects it, and a double-click frames it."}
                </p>
                {/* HTML labels pinned to the 3D scene (block tooltip, dimensions, COG note, callout); moved per frame, not by React. */}
                <div ref={labelsHostRef} aria-hidden className="pointer-events-none absolute inset-0 z-[11] overflow-hidden" />
                <p role="status" aria-live="polite" className="sr-only">
                    {bridge.hoverText || hoveredSupport?.text || ""}
                </p>

                {/* Everything floating lives in the part of the stage the insets leave uncovered. */}
                <div className="pointer-events-none absolute z-10" style={{ left: free.left, top: free.top, right: free.right, bottom: free.bottom }}>
                    {/* States, centred. */}
                    {(loading || showEmpty || phase === "error" || phase === "nowebgl" || phase === "lost" || overlay) && (
                        <div className="absolute inset-0 flex items-center justify-center p-4">
                            {loading && !overlay && (
                                <div role="status" className="flex items-center gap-2 rounded-md bg-background/85 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur">
                                    <Loader2 className="h-5 w-5 animate-spin" />
                                    {progress !== null && progress > 0 && progress < 1 ? `Loading model… ${Math.round(progress * 100)}%` : "Loading model…"}
                                </div>
                            )}
                            {showEmpty &&
                                (emptyState ? (
                                    <div className="pointer-events-auto">{emptyState}</div>
                                ) : (
                                    <div className="flex flex-col items-center gap-2 text-center text-muted-foreground">
                                        <Boxes className="h-8 w-8 opacity-50" aria-hidden />
                                        <p className="text-sm">No model yet</p>
                                        <p className="max-w-[16rem] text-xs opacity-80">Describe what you want and it appears here.</p>
                                    </div>
                                ))}
                            {phase === "error" && (
                                <div role="alert" className={card}>
                                    <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
                                    <p>{error || "The model could not be displayed."}</p>
                                    {url !== null && (
                                        <Button variant="outline" size="sm" onClick={() => (viewerRef.current ? setAttempt((n) => n + 1) : reload())}>
                                            <RotateCcw className="h-4 w-4" />
                                            {viewerEpoch > 0 ? "Try again" : "Reload 3D view"}
                                        </Button>
                                    )}
                                </div>
                            )}
                            {phase === "nowebgl" && (
                                <div role="alert" className={card}>
                                    <AlertTriangle className="h-5 w-5 text-warning" aria-hidden />
                                    <p>3D needs WebGL, which this browser has turned off.</p>
                                </div>
                            )}
                            {phase === "lost" && (
                                <div role="alert" className={card}>
                                    <p className="font-medium text-foreground">3D view paused</p>
                                    <p>The browser took back the graphics context, usually to free memory for another tab.</p>
                                    <Button variant="outline" size="sm" onClick={reload}>
                                        <RotateCcw className="h-4 w-4" />
                                        Reload 3D view
                                    </Button>
                                </div>
                            )}
                            {/* Interactive content (a Cancel button) works; the rest of the stage still orbits. */}
                            {overlay && <div className="pointer-events-auto">{overlay}</div>}
                        </div>
                    )}

                    {ready && (
                        <>
                            {/* Chips: what is shown, isolated or hidden, and notices. */}
                            <div className={cn("pointer-events-none absolute top-2 flex flex-col items-start gap-1", treeOpen ? "left-[17rem] max-w-[calc(100%-18rem)]" : "left-2 max-w-[calc(100%-1rem)]", (selectedRows.length > 0 || pickedSupport) && !blocksOn && !compact && "pr-[15rem]")}>
                                {/* The chips that are always there, measured for the framing (the ones below come and go). */}
                                <div ref={stackRef} className="flex max-w-full flex-col items-start gap-1">
                                    {blocksOn && analysis && analysisView ? (
                                        <p className="rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur">
                                            {previewing ? previewLabel : "Block view"} · {formatCount(analysis.blocks.length)} {analysis.blocks.length === 1 ? "block" : "blocks"} of {num(analysis.settings.blockSizeMm)} mm
                                            {previewing && analysis.assembly ? ` (${formatCount(analysis.blocks.length - analysis.assembly.roleCounts[0])} added)` : ""}
                                        </p>
                                    ) : (
                                        <p className="rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-muted-foreground backdrop-blur">
                                            {stageCounts ? `Block assembly · ${formatCount(stageCounts.original + stageCounts.added + stageCounts.edited)} blocks${assemblyNote(stageCounts, formatCount)} · ${formatCount(rows.length)} ${rows.length === 1 ? "role" : "roles"}` : `GLB · ${formatCount(rows.length)} ${rows.length === 1 ? "part" : "parts"} · ${formatCount(stats.triangles)} triangles`}
                                        </p>
                                    )}
                                    {supportsChipOn && (
                                        <SupportsChip counts={supportList} shown={supportsAsked} onShownChange={setSupportsShown} note={supportsAsked && explode > 0 ? "hidden while exploded" : undefined} />
                                    )}
                                    {colorModel && analysisView && <ColorChip model={colorModel} onChange={onViewChange ? (next) => onViewChange({ colorBy: next }) : undefined} />}
                                    {blocksOn && analysis && analysisView && <AnalysisLegend analysis={analysis} colorBy={colorBy} theme={theme} />}
                                </div>
                                {analysisBusy && (
                                    <p role="status" className={chip}>
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Analysing…
                                    </p>
                                )}
                                {cutNote && cutNote.hidden > 0 && (
                                    <p role="status" className="pointer-events-none flex items-center gap-1.5 rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-foreground shadow-sm backdrop-blur">
                                        <Layers className="h-3 w-3 shrink-0" aria-hidden />
                                        {cutNote.hidden === cutNote.total
                                            ? "The highlighted blocks are above the layer cut."
                                            : `${cutNote.hidden} of ${cutNote.total} highlighted blocks are above the layer cut.`}
                                    </p>
                                )}
                                {blocksOn && layerRaised && (
                                    <p role="status" className="pointer-events-none flex items-center gap-1.5 rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-foreground shadow-sm backdrop-blur">
                                        <Layers className="h-3 w-3 shrink-0" aria-hidden />
                                        Layer cut raised to show this.
                                    </p>
                                )}
                                {bridge.buildFailed && !blocksOn && (
                                    <p role="alert" className={chip}>
                                        <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden />
                                        The block view could not be loaded.
                                        <button type="button" className={chipButton} onClick={() => window.location.reload()}>
                                            Reload the page
                                        </button>
                                    </p>
                                )}
                                {!blocksOn && cubes.failed && (
                                    <p role="alert" className={chip}>
                                        <AlertTriangle className="h-3 w-3 shrink-0 text-warning" aria-hidden />
                                        The added supports could not be loaded.
                                        <button type="button" className={chipButton} onClick={() => window.location.reload()}>
                                            Reload the page
                                        </button>
                                    </p>
                                )}
                                {!blocksOn && looks.isolated && (
                                    <p className={chip}>
                                        Isolated: {looks.isolated.length === 1 ? nameOf(looks.isolated[0]) : `${looks.isolated.length} parts`}
                                        <button
                                            type="button"
                                            className={chipButton}
                                            title="Exit isolate (I)"
                                            onClick={() => {
                                                exitIsolate();
                                                refocus();
                                            }}
                                        >
                                            Exit
                                        </button>
                                    </p>
                                )}
                                {!blocksOn && looks.hidden.length > 0 && (
                                    <p className={chip}>
                                        {looks.hidden.length} hidden ·
                                        <button
                                            type="button"
                                            className={chipButton}
                                            title="Show all (Shift+H)"
                                            onClick={() => {
                                                showAll();
                                                refocus();
                                            }}
                                        >
                                            Show all
                                        </button>
                                    </p>
                                )}
                                {!blocksOn && split === "working" && (
                                    <p role="status" className={chip}>
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Splitting into parts… {Math.round(splitProgress * 100)}%
                                    </p>
                                )}
                                {notice && (
                                    <p role="status" className="pointer-events-auto max-w-[32rem] rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-foreground backdrop-blur">
                                        {notice}
                                    </p>
                                )}
                            </div>

                            {treeOpen && (
                                <PartsPanel
                                    rows={viewRows}
                                    selected={looks.selected}
                                    hidden={looks.hidden}
                                    onSelect={(id, adding) => select(adding ? toggled(looksRef.current.selected, id) : [id])}
                                    onToggle={(id) => toggleHidden([id])}
                                    onHover={setHover}
                                    onMenu={(id, at) => setMenu({ at, entries: entriesFor([id]) })}
                                />
                            )}

                            {selectedRows.length > 0 && !blocksOn && (
                                <SelectionCard
                                    rows={selectedRows}
                                    hidden={allSelectedHidden}
                                    isolated={!!looks.isolated}
                                    compact={compact}
                                    onIsolate={() => (looks.isolated ? exitIsolate() : isolate(looksRef.current.selected))}
                                    onHide={() => toggleHidden(looksRef.current.selected)}
                                    onClear={() => {
                                        select([]);
                                        refocus();
                                    }}
                                />
                            )}

                            {pickedSupport && !blocksOn && (
                                <SupportCard
                                    info={pickedSupport}
                                    compact={compact}
                                    onFrame={() => frameCube(pickedSupport.index)}
                                    onClear={() => {
                                        clearSupport();
                                        refocus();
                                    }}
                                />
                            )}

                            <div className="pointer-events-none absolute inset-x-2 bottom-2 z-20 flex justify-center">
                                <ViewerToolbar
                                    compact={compact}
                                    blocks={blocksOn}
                                    partCount={rows.length}
                                    treeOpen={treeOpen}
                                    onToggleTree={() => setTreeUser(!treeOpen)}
                                    onView={(view) => {
                                        viewerRef.current?.setView(view);
                                        refocus();
                                    }}
                                    onZoom={(steps) => viewerRef.current?.zoomBy(steps)}
                                    canExplode={multi}
                                    explode={explode}
                                    onExplode={(value) => {
                                        if (value > 0) clearSupport(); // the cubes are put away while exploded; so is the card for one
                                        setExplode(value);
                                    }}
                                    canSplit={stats.canSplit && !assembly}
                                    split={split}
                                    splitProgress={splitProgress}
                                    onSplit={() => void toggleSplit()}
                                    downloadUrl={downloadUrlProp !== undefined ? downloadUrlProp : url}
                                    downloadName={downloadName || downloadStem(title, stabilized)}
                                    downloadLabel={downloadLabelFor(downloadUrlProp, url, downloadLabelProp)}
                                    layers={layerState && onViewChange ? { cut: layerState, onChange: (layerMax) => onViewChange({ layerMax }), raised: !!layerRaised } : undefined}
                                    show={
                                        blocksOn && analysisView && onViewChange
                                            ? {
                                                  cog: analysisView.showCog,
                                                  onCog: (showCog) => onViewChange({ showCog }),
                                                  // A block assembly has no model behind its blocks: they are the model.
                                                  ghost: assembly ? null : analysisView.showGhost,
                                                  onGhost: (showGhost) => onViewChange({ showGhost }),
                                              }
                                            : undefined
                                    }
                                />
                            </div>
                        </>
                    )}
                </div>

                {menu && (
                    <ViewerContextMenu
                        at={menu.at}
                        entries={menu.entries}
                        onClose={() => {
                            setMenu(null);
                            refocus();
                        }}
                    />
                )}

                {ready && !blocksOn && hoveredRow && !menu && (
                    <div ref={tipRef} role="tooltip" className="pointer-events-none absolute z-20 max-w-[16rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <p className="font-medium">{hoveredRow.name}</p>
                        <p className="text-muted-foreground">{partDetail(hoveredRow)}</p>
                    </div>
                )}
                {ready && !blocksOn && hoveredSupport && !menu && (
                    <div ref={tipRef} role="tooltip" className="pointer-events-none absolute z-20 max-w-[16rem] rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <p className="flex items-center gap-1.5 font-medium">
                            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] ring-1 ring-black/25" style={{ background: hoveredSupport.color }} />
                            {hoveredSupport.tooltip}
                        </p>
                        <p className="text-muted-foreground">{hoveredSupport.zRange}</p>
                    </div>
                )}
            </div>
        </TooltipProvider>
    );
}
