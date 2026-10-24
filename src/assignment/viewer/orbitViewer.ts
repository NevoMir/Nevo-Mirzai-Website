/**
 * The orbit viewer, ported from Cably's cad3d/viewer.ts: WebGLRenderer, Z-up camera (mm), OrbitControls
 * (no damping, no listenToKeyEvents), Cably's key handler, the identify raycast, on-demand frames
 * (+ a 2 s warm-up), resize, theme (ground grid 10/50 mm; the renderer clears transparent over the
 * stage's CSS background) and context loss. Imports three: load it lazily.
 *
 * Differences from Cably's: the scene handle is a small ViewerScene (no CAD model behind it); the
 * floating UI's `insets` (all four sides) are honoured with camera.setViewOffset, so the model is
 * framed around the middle of the UNCOVERED rect of the stage instead of sliding the target by hand;
 * hover picking is coalesced to one raycast per frame and backs off on heavy meshes; and the
 * viewer can render a thumbnail of the scene it shows. The scene handed in is drawn as a child of a
 * root scene of the viewer's own, and three reads the environment from the scene it renders, so the
 * root takes over the handle's environment (see syncEnvironment).
 *
 * For the block view: a scene may pick by its own ray test instead of by parts (`pickRay`) and say it draws
 * its own ground (`grid: false`); the viewer can project a world point to stage pixels (`project`, for HTML
 * labels), report every drawn frame (`onFrame`), and ease the camera onto a box (`flyToBox`).
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { boxCorners, fitFrame, FOV, viewOffsetFor, visibleRect, visibleTangents } from "./framing.ts";
import { GRID_COLORS } from "./stage.ts";
import type { CameraState, Insets, ViewPreset, ViewTheme, Vec3 } from "./types.ts";

/** Thrown by mountOrbitViewer when `new WebGLRenderer` throws; the view shows the WebGL message. */
export class NoWebGLError extends Error {
    constructor(cause?: unknown) {
        super("3D needs WebGL, which this browser has turned off.");
        this.name = "NoWebGLError";
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

/** What the viewer reads of a scene. */
export interface ViewerScene {
    scene: THREE.Scene;
    /** World bounds of everything drawn (the grid and the clip planes follow it). */
    bounds: THREE.Box3;
    /** Pick id -> the object that is the part; the pick takes the first shown, pickable hit. */
    parts: ReadonlyMap<string, THREE.Object3D>;
    /** False for a part a click should go through (what isolate leaves out). */
    pickable?(id: string): boolean;
    /** Bumped whenever parts move, show, hide or are replaced: what Fit frames is re-read only then. */
    revision(): number;
    /** The parts Fit frames (default: every shown part). */
    framed?(): readonly THREE.Object3D[];
    /** The viewer's own ground grid (default true). A scene that draws its own ground says false. */
    grid?: boolean;
    /**
     * A scene that is picked by something other than its parts: the first hit along a world-space ray (the
     * block view). When set, `parts` play no part in picking and hovering.
     */
    pickRay?(ray: THREE.Ray): ViewerRayHit | null;
}

/** A hit of a scene's own ray test: an id the host understands, and the world point. */
export interface ViewerRayHit {
    id: string;
    point: Vec3;
}

/** A scene with nothing in it (the stage before a model arrives). */
export function createEmptyViewerScene(): ViewerScene {
    return { scene: new THREE.Scene(), bounds: new THREE.Box3(), parts: new Map(), revision: () => 0 };
}

/** What is under a pointer: its pick id, the world point and the face's unit normal there, and the object hit. */
export interface ViewerHit {
    id: string;
    point: Vec3;
    normal: Vec3 | null;
    object: THREE.Object3D;
}

export interface SnapshotOptions {
    width: number;
    height: number;
    /** Painted under the (transparent) render, e.g. the stage colour. */
    paintBackground?: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
    /** Margin about the model, default 1.12. */
    margin?: number;
    /** Shoot this scene instead of the one on stage (the model, while the block view is shown). */
    scene?: ViewerScene;
}

export interface OrbitViewerOptions {
    theme: ViewTheme;
    /** `(pointer: coarse)`: DPR <= 1.5 (else <= 2). */
    coarsePointer?: boolean;
    /** Px of the stage covered by floating UI. */
    insets?: Insets;
    /** After every camera move (controls, keys, presets). */
    onCameraChange?: (camera: CameraState) => void;
    /** Pointer over a part (x, y relative to the stage's top-left, for placing the tooltip) or off every part. */
    onHover?: (hit: { id: string; x: number; y: number } | null) => void;
    /** Hover picking is skipped while this returns false (a one-part model has nothing to point at). */
    hoverEnabled?: () => boolean;
    /** `webglcontextlost` on the canvas. */
    onContextLost?: () => void;
    /**
     * `webglcontextrestored`. three re-creates its own resources, but not what was rendered once into a
     * render target (the environment): the host should make a new viewer.
     */
    onContextRestored?: () => void;
    /** What F frames (the selection); none: everything, as 0. */
    focus?: () => readonly THREE.Object3D[];
}

export interface OrbitViewer {
    readonly renderer: THREE.WebGLRenderer;
    camera(): CameraState;
    /**
     * 'fit' = the last preset's direction (iso until one is picked), framed on what is shown.
     * Until the user moves the camera, a resize or an inset change re-frames it.
     */
    setView(view: ViewPreset): void;
    /** +1 = closer (distance x 0.8), -1 = farther. */
    zoomBy(steps: number): void;
    /** Degrees about +Z through the target, and of elevation. */
    orbitBy(azimuthDeg: number, elevationDeg: number): void;
    /** Swap in another scene, keeping the camera as it is. The caller disposes the old one. No-op once disposed. */
    setScene(handle: ViewerScene): void;
    /** The scene's parts moved or changed visibility: re-read its bounds, grid and fit points (and re-frame while the camera is automatic). */
    refresh(): void;
    scene(): ViewerScene;
    setTheme(theme: ViewTheme): void;
    /** Px of the stage that floating UI covers: the model is framed around the rest. */
    setInsets(insets: Insets): void;
    /** Client px -> the part id under it, or null. */
    pick(clientX: number, clientY: number): string | null;
    hit(clientX: number, clientY: number): ViewerHit | null;
    /** Frames these objects (what is shown of them) from the view as it is; none: Fit. */
    fit(objects?: readonly THREE.Object3D[]): void;
    /** Frames what the scene shows from the direction the camera looks from now (a scene swap, or the first look at the block view). */
    fitView(): void;
    /** Eases the camera onto `box` (world), keeping its direction; `ms` 0 jumps. A pointer drag in flight stops it. */
    flyToBox(box: THREE.Box3, ms?: number): void;
    /** Stage px (relative to the stage's top-left) of a world point, and whether it is in front of the camera. */
    project(point: Vec3): { x: number; y: number; visible: boolean };
    /** Called after every drawn frame; returns the unsubscribe. */
    onFrame(listener: () => void): () => void;
    /** Render one frame (on-demand rendering). */
    requestFrame(): void;
    /** True while the GL context is lost, which `onContextLost` may not have reported yet. */
    contextLost(): boolean;
    /** An iso shot of the scene on a transparent canvas, painted over `paintBackground`; WebP, else PNG. Null if the browser cannot encode, there is nothing to show, or the GL context is lost (nothing would be drawn). */
    snapshot(options: SnapshotOptions): Promise<Blob | null>;
    /** Listeners off, controls and renderer disposed, renderer.forceContextLoss() (unless already lost), canvas removed. Never disposes the scene. Idempotent. */
    dispose(): void;
}

const KEY_ORBIT_DEG = 15;
const KEY_PAN_FRAC = 0.1;
const ZOOM_STEP = 0.8;
/** Frames rendered after mount regardless of events (~2 s at 60 Hz): late layout settles. */
const WARM_UP_FRAMES = 120;
/** An inset change smaller than this (px), from the insets the camera was last framed for, does not re-frame an automatic camera: it only shifts the view offset. */
const REFIT_INSET_PX = 12;
const FIT_MARGIN = 1.08;
/** Unit directions from the target toward the camera. Top keeps a sliver of -Y so the screen's up is +Y. */
const PRESETS: Record<Exclude<ViewPreset, "fit">, THREE.Vector3> = {
    iso: new THREE.Vector3(1, -1, 1).normalize(),
    top: new THREE.Vector3(0, -1e-4, 1).normalize(),
    front: new THREE.Vector3(0, -1, 0),
    right: new THREE.Vector3(1, 0, 0),
};

/** Drawn: the object and every ancestor visible (a hidden part's group, a hidden solid). */
const shown = (o: THREE.Object3D) => {
    for (let a: THREE.Object3D | null = o; a; a = a.parent) if (!a.visible) return false;
    return true;
};

/** What Fit frames: the corners of each framed part's world box, or the bounds' corners when nothing is. */
function fitPoints(handle: ViewerScene): THREE.Vector3[] {
    handle.scene.updateMatrixWorld(true);
    const points: THREE.Vector3[] = [];
    for (const part of handle.framed?.() ?? handle.parts.values()) if (shown(part)) boxCorners(new THREE.Box3().setFromObject(part), points);
    if (!points.length) boxCorners(handle.bounds, points);
    return points;
}

/**
 * Mounts a renderer canvas into `container` (the view's stage element) and listens for keys on
 * `container`: arrows orbit 15 degrees, Shift+arrows pan, +/= and - zoom, F frames the focus, 0 fits,
 * 1-4 pick Iso/Top/Front/Right. Pointer moves on the canvas drive onHover. The canvas rect's
 * width/height fall back to container.clientWidth/Height, else 640 x 420, when layout reports 0.
 * @throws NoWebGLError when WebGLRenderer cannot be created.
 */
export function mountOrbitViewer(container: HTMLElement, handle: ViewerScene, opts: OrbitViewerOptions): OrbitViewer {
    let renderer: THREE.WebGLRenderer;
    try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
        throw new NoWebGLError(error);
    }
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.outline = "none";
    // Read at every resize, not once: browser zoom or a move to another screen changes it.
    const pixelRatioNow = () => Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, opts.coarsePointer ? 1.5 : 2);
    renderer.setPixelRatio(pixelRatioNow());
    renderer.setClearColor(0x000000, 0);
    container.appendChild(canvas);

    const rect = () => {
        const r = canvas.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width || container.clientWidth || 640, height: r.height || container.clientHeight || 420 };
    };

    const world = new THREE.Scene();
    let current = handle;
    world.add(current.scene);
    /**
     * three takes environment, intensity and rotation from the scene passed to render() and ignores a
     * nested Scene's, so without this the model is lit by its three lights alone (a default-metal glTF
     * material then renders near black). Run whenever `current` changes, before it is compiled or drawn.
     */
    const syncEnvironment = (from: ViewerScene = current) => {
        const source = from.scene;
        world.environment = source.environment;
        world.environmentIntensity = source.environmentIntensity;
        world.environmentRotation.copy(source.environmentRotation);
    };
    syncEnvironment();
    /** fitPoints of the scene as last shown, and the revision it was read at (null: a scene swapped in since). */
    let silhouette: THREE.Vector3[] = [];
    let silhouetteRevision: number | null = null;
    const outline = () => {
        const revision = current.revision();
        if (revision !== silhouetteRevision) [silhouette, silhouetteRevision] = [fitPoints(current), revision];
        return silhouette;
    };
    let theme = opts.theme;
    let insets: Insets = opts.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    let grid: THREE.Group | null = null;
    let gridKey = "";

    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10_000);
    camera.up.set(0, 0, 1); // before OrbitControls, which reads it once
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;

    /** The insets the camera was last framed for: a refit is judged against these, so many small steps add up. */
    let fittedInsets = insets;
    let lastPreset: Exclude<ViewPreset, "fit"> = "iso";
    /**
     * The camera is still the automatic frame of a preset (no user move), so a resize or an inset change
     * re-frames it: the stage often settles after mount (the chat panel docking).
     */
    let autoFit = false;
    let disposed = false;
    let quiet = false;
    let warm = WARM_UP_FRAMES;
    let raf = 0;
    let busy = false; // inside a snapshot: no re-entrant renders

    const radiusOf = (handle: ViewerScene) => Math.max(handle.bounds.getSize(new THREE.Vector3()).length() / 2, 5);
    const radius = () => radiusOf(current);

    const frameListeners = new Set<() => void>();
    const render = () => {
        if (disposed || busy) return;
        renderer.render(world, camera);
        frameListeners.forEach((listener) => listener());
    };

    /** Camera aspect and the view offset that centres the optical axis in the uncovered rect. */
    const applyView = () => {
        const { width, height } = rect();
        camera.aspect = width / height;
        const offset = viewOffsetFor(width, height, visibleRect(width, height, insets));
        if (Math.abs(offset.x) < 0.5 && Math.abs(offset.y) < 0.5) camera.clearViewOffset();
        else camera.setViewOffset(width, height, offset.x, offset.y, width, height);
        camera.updateProjectionMatrix();
    };

    const resize = () => {
        const { width, height } = rect();
        const ratio = pixelRatioNow();
        if (ratio !== renderer.getPixelRatio()) renderer.setPixelRatio(ratio);
        renderer.setSize(width, height, false);
        applyView();
    };

    /** Near/far follow the distance, so depth precision holds from a close-up to the whole model. */
    const clip = () => {
        const distance = camera.position.distanceTo(controls.target);
        camera.near = Math.max(0.05, distance / 500);
        camera.far = distance + radius() * 4 + 2000;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
    };

    const state = (): CameraState => ({ position: camera.position.toArray() as Vec3, target: controls.target.toArray() as Vec3 });

    const changed = () => {
        clip();
        render();
        opts.onCameraChange?.(state());
    };

    /** A programmatic move: controls.update() (its clamps) without a second 'change' round. */
    const moved = () => {
        quiet = true;
        camera.lookAt(controls.target);
        controls.update();
        quiet = false;
        changed();
    };

    const disposeGrid = () => {
        if (!grid) return;
        world.remove(grid);
        grid.traverse((o) => {
            (o as THREE.LineSegments).geometry?.dispose();
            ((o as THREE.LineSegments).material as THREE.Material | undefined)?.dispose();
        });
        grid = null;
        gridKey = "";
    };

    const buildGrid = () => {
        const b = current.bounds;
        if (b.isEmpty() || current.grid === false) return disposeGrid(); // no model: no ground either; some scenes draw their own
        const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, 50) + 200;
        const size = Math.ceil(span / 50) * 50;
        const cx = Math.round((b.min.x + b.max.x) / 2 / 50) * 50;
        const cy = Math.round((b.min.y + b.max.y) / 2 / 50) * 50;
        const z = Math.min(0, b.min.z) - 0.05;
        const key = `${theme}|${size}|${cx}|${cy}|${z.toFixed(2)}`;
        if (key === gridKey) return;
        disposeGrid();
        gridKey = key;
        const colors = GRID_COLORS[theme];
        const minor = new THREE.GridHelper(size, size / 10, colors.minor, colors.minor);
        const major = new THREE.GridHelper(size, size / 50, colors.major, colors.major);
        major.position.y = 0.02; // over the minor lines it shares, so they never fight in depth
        grid = new THREE.Group();
        grid.name = "assembly:grid";
        grid.add(minor, major);
        grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; the ground is XY
        grid.position.set(cx, cy, z);
        world.add(grid);
    };

    /** Frames the model from `dir` inside the uncovered rect (see framing.fitFrame). `focus`: these points about their own centre. */
    const frame = (dir: THREE.Vector3, focus?: THREE.Vector3[]) => {
        const points = focus ?? outline();
        const b = focus ? new THREE.Box3().setFromPoints(focus) : current.bounds;
        const center = b.getCenter(new THREE.Vector3());
        const { width, height } = rect();
        const { tanH, tanV } = visibleTangents(FOV, height, visibleRect(width, height, insets));
        const fitted = fitFrame({ points, center, dir, tanH, tanV, margin: FIT_MARGIN });
        fittedInsets = insets;
        controls.target.copy(fitted.target);
        camera.position.copy(fitted.position);
        moved();
    };

    const setView = (view: ViewPreset) => {
        cancelFlight();
        if (view !== "fit") lastPreset = view;
        autoFit = true;
        frame(PRESETS[lastPreset]);
    };

    /** F: the focus's shown parts from the view as it is; none shown: Fit. */
    const fit = (objects: readonly THREE.Object3D[] = []) => {
        const points: THREE.Vector3[] = [];
        for (const o of objects) if (shown(o)) boxCorners(new THREE.Box3().setFromObject(o), points);
        if (!points.length) return setView("fit");
        cancelFlight();
        autoFit = false;
        frame(camera.position.clone().sub(controls.target).normalize(), points);
    };

    let flightRaf = 0;
    /** Which flight is current: a frame already queued by an older one does nothing. */
    let flightId = 0;
    const cancelFlight = () => {
        flightId += 1;
        if (flightRaf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(flightRaf);
        flightRaf = 0;
    };

    /** The scene framed from where the camera looks now; the camera stays automatic or manual as it was. */
    const fitView = () => {
        cancelFlight();
        const dir = camera.position.clone().sub(controls.target);
        frame(dir.lengthSq() > 0 ? dir.normalize() : PRESETS[lastPreset]);
    };

    const flyTo = (position: THREE.Vector3, target: THREE.Vector3, ms: number) => {
        cancelFlight();
        autoFit = false;
        if (ms <= 0 || typeof requestAnimationFrame !== "function") {
            controls.target.copy(target);
            camera.position.copy(position);
            moved();
            return;
        }
        const fromPosition = camera.position.clone();
        const fromTarget = controls.target.clone();
        const id = flightId;
        let start = -1;
        const step = (now?: number) => {
            if (id !== flightId || disposed) return;
            flightRaf = 0;
            const t = typeof now === "number" ? now : performance.now();
            if (start < 0) start = t;
            const k = Math.min(1, (t - start) / ms);
            const eased = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2; // ease in and out
            controls.target.lerpVectors(fromTarget, target, eased);
            camera.position.lerpVectors(fromPosition, position, eased);
            moved();
            if (k < 1) flightRaf = requestAnimationFrame(step);
        };
        flightRaf = requestAnimationFrame(step);
    };

    const flyToBox = (box: THREE.Box3, ms = 400) => {
        if (box.isEmpty()) return;
        const dir = camera.position.clone().sub(controls.target);
        if (dir.lengthSq() === 0) dir.copy(PRESETS[lastPreset]);
        const { width, height } = rect();
        const { tanH, tanV } = visibleTangents(FOV, height, visibleRect(width, height, insets));
        const fitted = fitFrame({ points: boxCorners(box), center: box.getCenter(new THREE.Vector3()), dir: dir.normalize(), tanH, tanV, margin: 1.1 });
        fittedInsets = insets;
        flyTo(fitted.position, fitted.target, ms);
    };

    const projected = new THREE.Vector3();
    const project = (point: Vec3) => {
        camera.updateMatrixWorld();
        projected.fromArray(point).applyMatrix4(camera.matrixWorldInverse);
        const visible = projected.z < 0;
        projected.applyMatrix4(camera.projectionMatrix);
        const r = rect();
        return { x: ((projected.x + 1) / 2) * r.width, y: ((1 - projected.y) / 2) * r.height, visible };
    };

    const orbitBy = (azimuthDeg: number, elevationDeg: number) => {
        cancelFlight();
        autoFit = false;
        const offset = camera.position.clone().sub(controls.target);
        const distance = offset.length();
        const azimuth = Math.atan2(offset.y, offset.x) + THREE.MathUtils.degToRad(azimuthDeg);
        let elevation = Math.asin(THREE.MathUtils.clamp(offset.z / (distance || 1), -1, 1));
        // Clamped short of the poles, where azimuth stops meaning anything (Top keeps its own sliver).
        const limit = THREE.MathUtils.degToRad(89.5);
        if (elevationDeg) elevation = THREE.MathUtils.clamp(elevation + THREE.MathUtils.degToRad(elevationDeg), -limit, limit);
        camera.position.set(
            controls.target.x + distance * Math.cos(elevation) * Math.cos(azimuth),
            controls.target.y + distance * Math.cos(elevation) * Math.sin(azimuth),
            controls.target.z + distance * Math.sin(elevation),
        );
        moved();
    };

    const zoomBy = (steps: number) => {
        cancelFlight();
        autoFit = false;
        const offset = camera.position.clone().sub(controls.target);
        offset.multiplyScalar(ZOOM_STEP ** steps);
        camera.position.copy(controls.target).add(offset);
        moved();
    };

    /** Shift+arrows: slide the camera and target together by a tenth of the visible height. */
    const panBy = (dx: number, dy: number) => {
        cancelFlight();
        autoFit = false;
        const distance = camera.position.distanceTo(controls.target);
        const step = 2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * KEY_PAN_FRAC;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        const shift = right.multiplyScalar(dx * step).addScaledVector(up, dy * step);
        camera.position.add(shift);
        controls.target.add(shift);
        moved();
    };

    const onKey = (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
        const arrow = arrows[event.key];
        if (arrow && event.shiftKey) panBy(-arrow[0], -arrow[1]);
        else if (arrow) orbitBy(arrow[0] * KEY_ORBIT_DEG, arrow[1] * KEY_ORBIT_DEG);
        else if (event.key === "+" || event.key === "=") zoomBy(1);
        else if (event.key === "-" || event.key === "_") zoomBy(-1);
        else if (event.key === "f" || event.key === "F") fit(opts.focus?.());
        else if (event.key === "0") setView("fit");
        else if (event.key >= "1" && event.key <= "4") setView((["iso", "top", "front", "right"] as const)[Number(event.key) - 1]);
        else return;
        event.preventDefault();
    };

    const raycaster = new THREE.Raycaster();
    const aim = (clientX: number, clientY: number) => {
        const r = rect();
        const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        camera.updateMatrixWorld();
        raycaster.setFromCamera(ndc, camera);
    };
    const hit = (clientX: number, clientY: number): ViewerHit | null => {
        aim(clientX, clientY);
        current.scene.updateMatrixWorld();
        if (current.pickRay) {
            const own = current.pickRay(raycaster.ray);
            return own ? { id: own.id, point: own.point, normal: null, object: current.scene } : null;
        }
        // The nearest shown, pickable hit decides; a hidden part, or one isolate leaves out, is clicked through.
        for (const h of raycaster.intersectObjects([...current.parts.values()], true)) {
            if (!shown(h.object)) continue;
            let id: string | null = null;
            for (let o: THREE.Object3D | null = h.object; o && id === null; o = o.parent) if (typeof o.userData.componentId === "string") id = o.userData.componentId;
            if (id === null) return null;
            if (current.pickable && !current.pickable(id)) continue;
            const normal = h.face ? (h.face.normal.clone().transformDirection(h.object.matrixWorld).toArray() as Vec3) : null;
            return { id, point: h.point.toArray() as Vec3, normal, object: h.object };
        }
        return null;
    };
    const pick = (clientX: number, clientY: number) => hit(clientX, clientY)?.id ?? null;

    // Hover: one raycast per animation frame at most, and none sooner than 3x the last one took, so a
    // dense mesh (no BVH here) cannot make the pointer lag.
    let hoverAt: { x: number; y: number } | null = null;
    let hoverRaf = 0;
    let hoverNotBefore = 0;
    /** onHover last got a part (not null): "off every part" is told once, not on every pointer move. */
    let hovered = false;
    const endHover = () => {
        if (!hovered) return;
        hovered = false;
        opts.onHover?.(null);
    };
    const flushHover = () => {
        hoverRaf = 0;
        if (disposed || !hoverAt || !opts.onHover) return;
        const t = performance.now();
        if (t < hoverNotBefore) {
            hoverRaf = requestAnimationFrame(flushHover);
            return;
        }
        const { x, y } = hoverAt;
        const id = pick(x, y);
        const box = container.getBoundingClientRect();
        if (id) {
            hovered = true;
            opts.onHover({ id, x: x - box.left, y: y - box.top });
        } else endHover();
        hoverNotBefore = performance.now() + (performance.now() - t) * 3;
    };
    const cancelHover = () => {
        hoverAt = null;
        if (hoverRaf) cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
    };
    const onPointerMove = (event: MouseEvent) => {
        if (!opts.onHover) return;
        // A drag is orbiting, not pointing at parts.
        if (event.buttons || (opts.hoverEnabled && !opts.hoverEnabled())) {
            cancelHover();
            return endHover();
        }
        hoverAt = { x: event.clientX, y: event.clientY };
        if (!hoverRaf) hoverRaf = requestAnimationFrame(flushHover);
    };
    const onPointerLeave = () => {
        cancelHover();
        endHover();
    };

    const onContextLost = (event: Event) => {
        event.preventDefault();
        opts.onContextLost?.();
    };
    const onContextRestored = () => opts.onContextRestored?.();
    const contextLost = () => renderer.getContext().isContextLost();

    /** A pointer drag or wheel (programmatic moves are quiet). */
    const onControlsChange = () => {
        if (quiet) return;
        autoFit = false;
        changed();
    };

    const tick = () => {
        raf = 0;
        if (disposed) return;
        render();
        if ((warm -= 1) > 0 && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);
    };

    resize();
    buildGrid();
    renderer.compile(world, camera); // the root, as render() will see it: the same programs, environment included
    setView("iso");
    controls.addEventListener("change", onControlsChange);
    controls.addEventListener("start", cancelFlight);
    container.addEventListener("keydown", onKey);
    canvas.addEventListener("pointermove", onPointerMove as EventListener);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    const observer =
        typeof ResizeObserver !== "undefined"
            ? new ResizeObserver(() => {
                  resize();
                  if (autoFit) frame(PRESETS[lastPreset]);
                  else render();
              })
            : null;
    observer?.observe(container);
    render();
    if (typeof requestAnimationFrame === "function") raf = requestAnimationFrame(tick);

    const snapshot = async (options: SnapshotOptions): Promise<Blob | null> => {
        // A lost context draws nothing: the shot would be the bare background, kept as a project's cover for good.
        const subject = options.scene ?? current;
        if (disposed || subject.bounds.isEmpty() || typeof document === "undefined" || contextLost()) return null;
        const { width, height } = options;
        const size = renderer.getSize(new THREE.Vector2());
        const out = document.createElement("canvas");
        out.width = width;
        out.height = height;
        const ctx = out.getContext("2d");
        if (!ctx) return null;
        busy = true;
        const wasGrid = grid?.visible ?? true;
        // Another scene than the one on stage takes its place for the shot (and its lighting with it).
        const swapped = subject !== current;
        if (swapped) {
            world.remove(current.scene);
            world.add(subject.scene);
            syncEnvironment(subject);
        }
        try {
            // Frame the iso view with no insets on a 4:3-ish camera of its own, leaving the user's camera alone.
            const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
            const fitted = fitFrame({ points: swapped ? fitPoints(subject) : outline(), center: subject.bounds.getCenter(new THREE.Vector3()), dir: PRESETS.iso, tanH: tanV * (width / height), tanV, margin: options.margin ?? 1.12 });
            const shot = new THREE.PerspectiveCamera(FOV, width / height, 0.1, 10_000);
            shot.up.set(0, 0, 1);
            shot.position.copy(fitted.position);
            shot.lookAt(fitted.target);
            shot.near = Math.max(0.05, fitted.distance / 500);
            shot.far = fitted.distance + radiusOf(subject) * 4 + 2000;
            shot.updateProjectionMatrix();
            shot.updateMatrixWorld();
            if (grid) grid.visible = false;
            renderer.setPixelRatio(1);
            renderer.setSize(width, height, false);
            renderer.render(world, shot);
            options.paintBackground?.(ctx, width, height);
            ctx.drawImage(canvas, 0, 0, width, height); // synchronous: the drawing buffer is still valid
        } finally {
            if (swapped) {
                world.remove(subject.scene);
                world.add(current.scene);
                syncEnvironment();
            }
            if (grid) grid.visible = wasGrid;
            renderer.setPixelRatio(pixelRatioNow());
            renderer.setSize(size.x, size.y, false);
            busy = false;
            render();
        }
        const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => out.toBlob(resolve, type, quality));
        const webp = await encode("image/webp", 0.85);
        // Safari answers a WebP request with a PNG; a browser that cannot encode at all answers null.
        return webp ?? (await encode("image/png"));
    };

    return {
        renderer,
        camera: state,
        setView,
        zoomBy,
        orbitBy,
        setScene(next) {
            if (disposed) return;
            world.remove(current.scene);
            current = next;
            world.add(current.scene);
            syncEnvironment();
            silhouetteRevision = null;
            // A part of the old scene is not under the pointer now: the host is told, once.
            cancelHover();
            endHover();
            buildGrid();
            clip();
            if (!contextLost()) renderer.compile(world, camera);
            render();
        },
        refresh() {
            if (disposed) return;
            silhouetteRevision = null;
            buildGrid();
            if (autoFit) frame(PRESETS[lastPreset]);
            else {
                clip();
                render();
            }
        },
        setTheme(next) {
            if (next === theme) return;
            theme = next;
            buildGrid();
            render();
        },
        setInsets(next) {
            const delta = (from: Insets) => Math.max(Math.abs(next.top - from.top), Math.abs(next.right - from.right), Math.abs(next.bottom - from.bottom), Math.abs(next.left - from.left));
            if (delta(insets) === 0 || disposed) return;
            insets = next;
            applyView();
            // Against the insets of the last framing, not of the last call: an eased or dragged change arrives in steps under the threshold.
            if (autoFit && delta(fittedInsets) >= REFIT_INSET_PX) frame(PRESETS[lastPreset]);
            else render();
        },
        pick,
        hit,
        fit,
        fitView,
        flyToBox,
        project,
        onFrame(listener) {
            frameListeners.add(listener);
            return () => frameListeners.delete(listener);
        },
        scene: () => current,
        requestFrame: render,
        contextLost,
        snapshot,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
            raf = 0;
            cancelHover();
            observer?.disconnect();
            cancelFlight();
            controls.removeEventListener("change", onControlsChange);
            controls.removeEventListener("start", cancelFlight);
            container.removeEventListener("keydown", onKey);
            canvas.removeEventListener("pointermove", onPointerMove as EventListener);
            canvas.removeEventListener("pointerleave", onPointerLeave);
            // Off before forceContextLoss, whose own 'webglcontextlost' must not read as a crash.
            canvas.removeEventListener("webglcontextlost", onContextLost);
            canvas.removeEventListener("webglcontextrestored", onContextRestored);
            controls.dispose();
            disposeGrid();
            frameListeners.clear();
            world.environment = null;
            world.clear();
            renderer.dispose();
            // A context already lost has no WEBGL_lose_context left, and three warns.
            if (!renderer.getContext()?.isContextLost()) renderer.forceContextLoss();
            canvas.remove();
        },
    };
}
