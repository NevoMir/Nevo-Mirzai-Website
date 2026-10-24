/**
 * The block view's scene: the analysed assembly drawn as discrete 100 mm blocks, with everything that explains
 * its verdict around them (the ground plate and its grid, the 1 m target cube, the footprint, the support base,
 * the centre of gravity and where it falls, the cut of the layer slider, a faint ghost of the original model).
 * Imports three: load it lazily.
 *
 * It is a ViewerScene of its own, swapped in for the model's scene (the camera stays where it is). Everything is
 * built in analysis mm and put into the viewer's display frame by one transform on a root group, so no vertex is
 * ever converted. Blocks are two InstancedMeshes (the ones in focus, and the dimmed rest), a halo mesh behind the
 * highlighted ones, and merged line segments for the edges: a few draw calls however many blocks there are.
 * Picking is a plain ray/box test over the shown blocks (no raycaster over instance geometry).
 *
 * Ownership: this scene owns every geometry, material and instanced buffer it makes, except the model's own
 * geometry that the ghost draws (that stays with the model's scene).
 */
import * as THREE from "three";
import type { AnalysisColorBy, AnalysisResult, Block } from "../analysis/types.ts";
import {
    PALETTE,
    blockColor,
    boxEdgeSegments,
    cellOutlineSegments,
    cellTriangles,
    cutActive,
    describeBlock,
    describeStress,
    DIM_EDGE_OPACITY,
    DIM_OPACITY,
    dimColor,
    dimensionOffset,
    displayPlacement,
    fanTriangles,
    focusBounds,
    mmToDisplay,
    pickBlock,
    ribbonTriangles,
    sceneLabels,
    sectionLayer,
    tipArrow,
    topLayer,
    volumeMm,
    type BlockInfo,
    type BlockPalette,
    type SceneLabel,
} from "./analysisGeometry.ts";
import { addStageLighting } from "./glbScene.ts";
import type { ViewerScene } from "./orbitViewer.ts";
import type { Vec3, ViewTheme } from "./types.ts";

/** The model's meshes as loaded, for the ghost. Geometry is shared with the model's scene, never copied or freed here. */
export interface GhostSource {
    geometry: THREE.BufferGeometry;
    /** World matrix of the mesh in the viewer's display frame. */
    matrix: THREE.Matrix4;
    /** An instanced mesh's per-instance matrices (16 floats each). */
    instances?: { matrices: Float32Array; count: number };
}

export interface BlocksViewPatch {
    colorBy: AnalysisColorBy;
    layerMax: number;
    showGhost: boolean;
    showCog: boolean;
    highlight: readonly number[];
}

export interface BlocksSceneOptions {
    analysis: AnalysisResult;
    view: BlocksViewPatch;
    theme: ViewTheme;
    /** Shared PBR environment (as the model's scene gets it); none: the three lights alone. */
    environment?: THREE.Texture | null;
    ghost?: readonly GhostSource[];
    /** The scene changed after the fact: render a frame. */
    onChange?: () => void;
    /** No pulse on the highlighted blocks, no flash on the fresh ones. */
    reducedMotion?: boolean;
    /** Blocks (indices of analysis.blocks) that have just appeared, as the stabilizer's preview adds them: they flash once. */
    fresh?: readonly number[];
    /** Steps of earlier stabilizer runs the model carries: a tooltip numbers the steps of the run on screen from 1 (see addedWhen). */
    stepOffset?: number;
}

export interface BlocksScene extends ViewerScene {
    readonly analysis: AnalysisResult;
    /** Applies a look; true when something changed (and a frame is due). */
    setView(view: BlocksViewPatch): boolean;
    setTheme(theme: ViewTheme): void;
    /** The block under the pointer gets an outline; null clears it. */
    setHover(index: number | null): void;
    /** The layer cut leaves this block on screen. */
    isShown(index: number): boolean;
    info(index: number): BlockInfo | null;
    /** The colour the block is drawn in now, as hex. */
    colorOf(index: number): string;
    /** World point at the top centre of a block (where its tooltip hangs). */
    anchorOf(index: number): Vec3 | null;
    /** World box of a block's cell. */
    boxOf(index: number): THREE.Box3 | null;
    /** The box the camera frames for an issue: the point and the blocks highlighted now. */
    focusBox(focusMm: Vec3): THREE.Box3;
    toWorld(mm: Vec3): Vec3;
    /** The scene's own labels with world anchors (dimensions, COG, tip direction, layer cut). */
    labels(): SceneLabel[];
    /** Advances the highlight pulse and the flash of fresh blocks; true while it needs more frames. */
    animate(now: number): boolean;
    /** Fresh blocks are flashing or about to: the host must run frames for them. */
    flashing(): boolean;
    dispose(): void;
}

/** Blocks are drawn at this share of their cell, so the assembly reads as discrete components. */
const INSET = 0.92;
const HALO_SCALE = 1.045;
const HOVER_SCALE = 0.945;
const HALO_OPACITY = 0.9;
const GHOST_OPACITY = 0.15;
const PULSE_MS = 1800;
const PULSE_PERIOD_MS = 600;
/** The flash of freshly added blocks: one fade, not a loop. */
const FRESH_MS = 1300;
const FRESH_SCALE = 1.09;
/** Drawn after everything, without the depth test: how the COG and the support base show through blocks. */
const XRAY_ORDER = 20;
const EDGE_VERTICES = 24;
const UNIT_EDGES = boxEdgeSegments([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);

type Role = keyof BlockPalette | "verdict";

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function createBlocksScene(options: BlocksSceneOptions): BlocksScene {
    const { analysis } = options;
    const blocks = analysis.blocks;
    const count = blocks.length;
    const cell = analysis.settings.blockSizeMm;
    const volume = volumeMm(analysis);
    const transform = analysis.transform.factor > 0 && Number.isFinite(analysis.transform.factor) ? analysis.transform : { ...analysis.transform, factor: 1 };
    const stability = analysis.stability;
    const top = topLayer(blocks);
    const layers = Math.max(1, top + 1);
    const limit = analysis.settings.cantileverLimit;
    const toWorld = (mm: Vec3): Vec3 => mmToDisplay(mm, transform);

    let theme = options.theme;
    let palette = PALETTE[theme];
    let reduced = options.reducedMotion ?? false;
    /** The layer cut, kept to the layers that exist (below 0 shows nothing). */
    const clampLayer = (layerMax: number) => Math.min(top, Math.floor(Number.isFinite(layerMax) ? layerMax : top));
    const view: BlocksViewPatch = { colorBy: options.view.colorBy, layerMax: clampLayer(options.view.layerMax), showGhost: options.view.showGhost, showCog: options.view.showCog, highlight: [...options.view.highlight] };

    // ---- bookkeeping: everything made here is freed in dispose() ----
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const instanced: THREE.InstancedMesh[] = [];
    const geo = <G extends THREE.BufferGeometry>(g: G): G => {
        geometries.add(g);
        return g;
    };
    const mat = <M extends THREE.Material>(m: M): M => {
        materials.add(m);
        return m;
    };
    /** Materials whose colour is a palette entry, repainted when the theme changes. */
    const painted: Array<{ material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial; role: Role }> = [];
    const paint = <M extends THREE.MeshBasicMaterial | THREE.LineBasicMaterial>(material: M, role: Role): M => {
        painted.push({ material, role });
        materials.add(material);
        return material;
    };
    const resolve = (role: Role): string => (role === "verdict" ? (stability?.inside === false ? palette.bad : palette.ok) : palette[role]);

    // ---- scene, root (mm -> display frame) ----
    const scene = new THREE.Scene();
    addStageLighting(scene, options.environment);
    const root = new THREE.Group();
    root.name = "blocks:root";
    const placement = displayPlacement(transform);
    root.scale.setScalar(placement.scale);
    root.position.set(...placement.position);
    scene.add(root);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromPoints([new THREE.Vector3(...toWorld([0, 0, 0])), new THREE.Vector3(...toWorld(volume))]);

    const triangles = (positions: Float32Array, material: THREE.Material, order: number): THREE.Mesh => {
        const g = geo(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const mesh = new THREE.Mesh(g, material);
        mesh.renderOrder = order;
        mesh.frustumCulled = false;
        return mesh;
    };
    const segments = (positions: Float32Array, material: THREE.Material, order: number): THREE.LineSegments => {
        const g = geo(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        const lines = new THREE.LineSegments(g, material);
        lines.renderOrder = order;
        lines.frustumCulled = false;
        return lines;
    };
    const flat = (opacity: number, role: Role, extra: THREE.MeshBasicMaterialParameters = {}) =>
        paint(new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, ...extra }), role);
    const thin = (opacity: number, role: Role, extra: THREE.LineBasicMaterialParameters = {}) => paint(new THREE.LineBasicMaterial({ transparent: true, opacity, depthWrite: false, ...extra }), role);

    /** A flat shape drawn twice: once honouring depth, once faintly through whatever is in front of it. */
    const marked = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, role: Role, solid: number, xray: number, order: number) => {
        const front = new THREE.Mesh(geometry, flat(solid, role));
        front.renderOrder = order;
        front.frustumCulled = false;
        const back = new THREE.Mesh(geometry, flat(xray, role, { depthTest: false }));
        back.renderOrder = XRAY_ORDER;
        back.frustumCulled = false;
        parent.add(front, back);
    };
    const flatGeometry = (positions: Float32Array) => {
        const g = geo(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        return g;
    };

    // ---- context: ground plate, grid, footprint, target cube, dimensions ----
    const context = new THREE.Group();
    context.name = "blocks:context";
    root.add(context);

    const plate = new THREE.Mesh(geo(new THREE.PlaneGeometry(volume[0], volume[1]).translate(volume[0] / 2, volume[1] / 2, -0.6)), flat(0.55, "plate"));
    plate.renderOrder = -10;
    context.add(plate);

    const gridLines: number[] = [];
    for (let i = 0; i <= analysis.gridSize[0]; i += 1) gridLines.push(i * cell, 0, 0.3, i * cell, volume[1], 0.3);
    for (let j = 0; j <= analysis.gridSize[1]; j += 1) gridLines.push(0, j * cell, 0.3, volume[0], j * cell, 0.3);
    context.add(segments(Float32Array.from(gridLines), thin(0.7, "plateLine"), -9));
    const border = triangles(ribbonTriangles([[0, 0], [volume[0], 0], [volume[0], volume[1]], [0, volume[1]]], cell * 0.03, 0.35), flat(0.85, "plateBorder"), -8);
    context.add(border);

    // The cells under the structure: where it stands.
    const footprint = new Map<number, [number, number]>();
    for (const b of blocks) if (b.cell[2] === 0) footprint.set(b.cell[1] * 4096 + b.cell[0], [b.cell[0], b.cell[1]]);
    if (footprint.size) context.add(triangles(cellTriangles([...footprint.values()], cell, 0.5, cell * 0.03), flat(0.3, "footprint"), -9));

    const cube = segments(boxEdgeSegments([0, 0, 0], volume), paint(new THREE.LineDashedMaterial({ transparent: true, opacity: 0.5, dashSize: cell * 0.22, gapSize: cell * 0.14, depthWrite: false }), "cube"), -6);
    cube.computeLineDistances();
    context.add(cube);

    // Dimension lines with end ticks, off the two nearest edges of the cube (width and height).
    const d = dimensionOffset(volume);
    const tick = d * 0.22;
    context.add(
        segments(
            Float32Array.from([
                0, -d, 0, volume[0], -d, 0,
                0, -d - tick, 0, 0, -d + tick, 0,
                volume[0], -d - tick, 0, volume[0], -d + tick, 0,
                volume[0] + d * 0.7, -d * 0.7, 0, volume[0] + d * 0.7, -d * 0.7, volume[2],
                volume[0] + d * 0.7 - tick, -d * 0.7, 0, volume[0] + d * 0.7 + tick, -d * 0.7, 0,
                volume[0] + d * 0.7 - tick, -d * 0.7, volume[2], volume[0] + d * 0.7 + tick, -d * 0.7, volume[2],
            ]),
            thin(0.85, "dimension"),
            -5,
        ),
    );

    // ---- the support base and the centre of gravity ----
    const verdict = new THREE.Group();
    verdict.name = "blocks:verdict";
    root.add(verdict);
    if (stability) {
        const hull = stability.supportHull;
        if (hull.length >= 3) verdict.add(triangles(fanTriangles(hull, 0.7), flat(0.14, "verdict"), -7));
        if (hull.length >= 2) marked(verdict, flatGeometry(ribbonTriangles(hull, cell * 0.055, 0.9)), "verdict", 1, 0.4, -6);

        const [cx, cy, cz] = stability.cogMm;
        const r = cell * 0.27;
        const sphere = geo(new THREE.SphereGeometry(r, 28, 18));
        const body = new THREE.Mesh(sphere, mat(new THREE.MeshStandardMaterial({ color: palette.cog, roughness: 0.4, metalness: 0, emissive: palette.cog, emissiveIntensity: 0.25 })));
        body.position.set(cx, cy, cz);
        const rim = new THREE.Mesh(sphere, mat(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })));
        rim.position.copy(body.position);
        rim.scale.setScalar(1.22);
        const through = new THREE.Mesh(sphere, flat(0.55, "cog", { depthTest: false }));
        through.position.copy(body.position);
        through.renderOrder = XRAY_ORDER;
        verdict.add(rim, body, through);
        for (const m of [rim, body]) m.frustumCulled = false;

        const arm = cell * 0.7;
        const crosshair = (opacity: number, depthTest: boolean, order: number) => {
            const lines = segments(Float32Array.from([cx - arm, cy, cz, cx + arm, cy, cz, cx, cy - arm, cz, cx, cy + arm, cz, cx, cy, cz - arm, cx, cy, cz + arm]), thin(opacity, "cog", { depthTest }), order);
            verdict.add(lines);
        };
        crosshair(1, true, 5);
        crosshair(0.55, false, XRAY_ORDER);

        // The drop line from the COG to the ground, always readable through the blocks.
        const drop = segments(Float32Array.from([cx, cy, cz, cx, cy, 1]), paint(new THREE.LineDashedMaterial({ transparent: true, opacity: 0.95, dashSize: cell * 0.12, gapSize: cell * 0.08, depthTest: false, depthWrite: false }), "cog"), XRAY_ORDER);
        drop.computeLineDistances();
        verdict.add(drop);

        // Where it lands: a ring when it is inside the base, a cross when it is not (not by colour alone).
        const [gx, gy] = stability.groundPointMm;
        if (stability.inside) {
            const ring = geo(new THREE.RingGeometry(cell * 0.17, cell * 0.26, 40).translate(gx, gy, 1.1));
            const dot = geo(new THREE.CircleGeometry(cell * 0.07, 20).translate(gx, gy, 1.1));
            marked(verdict, ring, "verdict", 1, 0.55, -4);
            marked(verdict, dot, "verdict", 1, 0.55, -4);
        } else {
            const a = cell * 0.22;
            const bar = (x0: number, y0: number, x1: number, y1: number) => ribbonTriangles([[x0, y0], [x1, y1]], cell * 0.055, 1.1);
            const cross = new Float32Array([...bar(gx - a, gy - a, gx + a, gy + a), ...bar(gx - a, gy + a, gx + a, gy - a)]);
            marked(verdict, flatGeometry(cross), "verdict", 1, 0.55, -4);
            // Where it would pivot, and the way it tips.
            const pivot = geo(new THREE.CircleGeometry(cell * 0.11, 24).translate(stability.pivotMm[0], stability.pivotMm[1], 1.4));
            marked(verdict, pivot, "verdict", 1, 0.65, -3);
            const arrow = tipArrow(stability, cell);
            if (arrow) {
                const head = cell * 0.46;
                const [dx, dy] = arrow.dir;
                const [tx, ty] = arrow.to;
                const bx = tx - dx * head;
                const by = ty - dy * head;
                const wing = cell * 0.21;
                const shaft = ribbonTriangles([arrow.from, [bx, by]], cell * 0.065, 1.6);
                const tip = Float32Array.from([tx, ty, 1.6, bx - dy * wing, by + dx * wing, 1.6, bx + dy * wing, by - dx * wing, 1.6]);
                marked(verdict, flatGeometry(new Float32Array([...shaft, ...tip])), "verdict", 1, 0.6, -3);
            }
        }
    }

    // ---- ghost of the original model ----
    const ghost = new THREE.Group();
    ghost.name = "blocks:ghost";
    scene.add(ghost);
    const ghostMaterial = mat(new THREE.MeshStandardMaterial({ color: palette.ghost, roughness: 0.8, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }));
    for (const source of options.ghost ?? []) {
        let object: THREE.Mesh;
        if (source.instances) {
            const many = new THREE.InstancedMesh(source.geometry, ghostMaterial, source.instances.count);
            many.instanceMatrix.array.set(source.instances.matrices);
            many.instanceMatrix.needsUpdate = true;
            many.frustumCulled = false;
            instanced.push(many);
            object = many;
        } else object = new THREE.Mesh(source.geometry, ghostMaterial);
        object.matrixAutoUpdate = false;
        object.matrix.copy(source.matrix);
        object.matrixWorldNeedsUpdate = true;
        object.renderOrder = -4;
        ghost.add(object);
    }

    // ---- blocks ----
    const unit = geo(new THREE.BoxGeometry(1, 1, 1));
    const instancedBlocks = (material: THREE.Material, order: number): THREE.InstancedMesh => {
        const capacity = Math.max(1, count);
        const mesh = new THREE.InstancedMesh(unit, material, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        instanced.push(mesh);
        return mesh;
    };
    const faceOffset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
    const solidMaterial = mat(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.94, 0.94, 0.94), roughness: 0.78, metalness: 0, ...faceOffset }));
    const dimMaterial = mat(new THREE.MeshStandardMaterial({ color: new THREE.Color(0.94, 0.94, 0.94), roughness: 0.9, metalness: 0, transparent: true, opacity: DIM_OPACITY[theme], depthWrite: false, ...faceOffset }));
    const active = instancedBlocks(solidMaterial, 0);
    const dimmed = instancedBlocks(dimMaterial, -3);
    const haloMaterial = paint(new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: HALO_OPACITY, depthWrite: false }), "highlight");
    const halo = new THREE.InstancedMesh(unit, haloMaterial, Math.max(1, count));
    halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    halo.count = 0;
    halo.frustumCulled = false;
    halo.renderOrder = -2;
    instanced.push(halo);

    // The flash of freshly added blocks: a ring a little further out than the highlight's, fading once.
    const freshMaterial = paint(new THREE.MeshBasicMaterial({ side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false }), "fresh");
    const freshHalo = new THREE.InstancedMesh(unit, freshMaterial, Math.max(1, count));
    freshHalo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    freshHalo.count = 0;
    freshHalo.frustumCulled = false;
    freshHalo.renderOrder = -2;
    instanced.push(freshHalo);

    const edgeLines = (opacity: number, order: number) => {
        const g = geo(new THREE.BufferGeometry());
        const attribute = new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * EDGE_VERTICES * 3), 3);
        attribute.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("position", attribute);
        g.setDrawRange(0, 0);
        const lines = new THREE.LineSegments(g, paint(new THREE.LineBasicMaterial({ transparent: true, opacity }), "edge"));
        lines.frustumCulled = false;
        lines.renderOrder = order;
        return lines;
    };
    const activeEdges = edgeLines(0.6, -1);
    const dimmedEdges = edgeLines(DIM_EDGE_OPACITY, -2);

    const blocksGroup = new THREE.Group();
    blocksGroup.name = "blocks:blocks";
    root.add(blocksGroup);
    blocksGroup.add(dimmed, dimmedEdges, halo, freshHalo, active, activeEdges);

    // The layer cut: the top faces of the last shown layer, outlined and faintly filled.
    const cells = Math.max(1, analysis.gridSize[0] * analysis.gridSize[1]);
    const sectionOutline = segments(new Float32Array(cells * 24), thin(0.95, "section", { depthTest: false }), 6);
    const sectionFill = triangles(new Float32Array(cells * 18), flat(0.22, "section", { depthTest: false }), 5);
    for (const part of [sectionOutline, sectionFill]) {
        part.geometry.setDrawRange(0, 0);
        blocksGroup.add(part);
    }

    // Hover: an outline just outside the block, and a light wash on it.
    const hoverFill = new THREE.Mesh(unit, flat(0.2, "hover", { depthWrite: false, side: THREE.FrontSide }));
    hoverFill.scale.setScalar(cell * HOVER_SCALE);
    hoverFill.renderOrder = 8;
    const hoverOutline = segments(UNIT_EDGES.slice(), thin(1, "hover"), 8);
    hoverOutline.scale.setScalar(cell * 1.005);
    hoverFill.visible = false;
    hoverOutline.visible = false;
    blocksGroup.add(hoverFill, hoverOutline);

    // ---- colours ----
    const rgb = new Float32Array(Math.max(1, count) * 3);
    const dimRgb = new Float32Array(Math.max(1, count) * 3);
    const hexes: string[] = new Array<string>(count).fill("#94a3b8");
    const swatch = new THREE.Color();
    const recolor = () => {
        const ctx = { theme, limit, layers, stress: analysis.stress?.byBlock ?? null };
        for (let i = 0; i < count; i += 1) {
            const hex = blockColor(blocks[i], view.colorBy, ctx);
            hexes[i] = hex;
            swatch.set(hex);
            rgb[i * 3] = swatch.r;
            rgb[i * 3 + 1] = swatch.g;
            rgb[i * 3 + 2] = swatch.b;
            swatch.set(dimColor(hex, theme));
            dimRgb[i * 3] = swatch.r;
            dimRgb[i * 3 + 1] = swatch.g;
            dimRgb[i * 3 + 2] = swatch.b;
        }
    };

    // ---- instance buffers ----
    const shownIndices = new Int32Array(Math.max(1, count));
    let shownCount = 0;
    let shownSet = new Set<number>();
    let emphasised: ReadonlySet<number> | null = null; // the highlighted blocks that are shown
    let pulseStart = -1;
    let pulsing = false;
    let freshStart = -1;
    const freshSet = new Set<number>((options.fresh ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < count));
    let flash = !reduced && freshSet.size > 0;

    const writeBox = (array: Float32Array, slot: number, b: Block, size: number) => {
        const o = slot * 16;
        array.fill(0, o, o + 16);
        array[o] = size;
        array[o + 5] = size;
        array[o + 10] = size;
        array[o + 12] = b.centerMm[0];
        array[o + 13] = b.centerMm[1];
        array[o + 14] = b.centerMm[2];
        array[o + 15] = 1;
    };
    const writeEdges = (array: Float32Array, slot: number, b: Block, size: number) => {
        const o = slot * EDGE_VERTICES * 3;
        for (let v = 0; v < EDGE_VERTICES; v += 1) {
            array[o + v * 3] = b.centerMm[0] + UNIT_EDGES[v * 3] * size;
            array[o + v * 3 + 1] = b.centerMm[1] + UNIT_EDGES[v * 3 + 1] * size;
            array[o + v * 3 + 2] = b.centerMm[2] + UNIT_EDGES[v * 3 + 2] * size;
        }
    };

    const rebuildBlocks = () => {
        // A highlight the layer cut hides entirely emphasises nothing (the rest is not dimmed for it); the stage says so in a chip.
        const highlighted = new Set<number>();
        for (const i of view.highlight) if (i >= 0 && i < count && blocks[i].cell[2] <= view.layerMax) highlighted.add(i);
        const focused = highlighted.size > 0;
        emphasised = focused ? highlighted : null;
        shownSet = new Set<number>();
        shownCount = 0;
        const size = cell * INSET;
        const activeMatrices = active.instanceMatrix.array as Float32Array;
        const activeColors = active.instanceColor!.array as Float32Array;
        const dimMatrices = dimmed.instanceMatrix.array as Float32Array;
        const dimColors = dimmed.instanceColor!.array as Float32Array;
        const haloMatrices = halo.instanceMatrix.array as Float32Array;
        const activeEdge = activeEdges.geometry.getAttribute("position").array as Float32Array;
        const dimEdge = dimmedEdges.geometry.getAttribute("position").array as Float32Array;
        const freshMatrices = freshHalo.instanceMatrix.array as Float32Array;
        let nActive = 0;
        let nDim = 0;
        let nHalo = 0;
        let nFresh = 0;
        for (let i = 0; i < count; i += 1) {
            const b = blocks[i];
            if (b.cell[2] > view.layerMax) continue;
            shownIndices[shownCount++] = i;
            shownSet.add(i);
            if (flash && freshSet.has(i)) writeBox(freshMatrices, nFresh++, b, cell * FRESH_SCALE);
            if (!focused || highlighted.has(i)) {
                writeBox(activeMatrices, nActive, b, size);
                activeColors[nActive * 3] = rgb[i * 3];
                activeColors[nActive * 3 + 1] = rgb[i * 3 + 1];
                activeColors[nActive * 3 + 2] = rgb[i * 3 + 2];
                writeEdges(activeEdge, nActive, b, size);
                nActive += 1;
                if (focused) writeBox(haloMatrices, nHalo++, b, cell * HALO_SCALE);
            } else {
                writeBox(dimMatrices, nDim, b, size);
                dimColors[nDim * 3] = dimRgb[i * 3];
                dimColors[nDim * 3 + 1] = dimRgb[i * 3 + 1];
                dimColors[nDim * 3 + 2] = dimRgb[i * 3 + 2];
                writeEdges(dimEdge, nDim, b, size);
                nDim += 1;
            }
        }
        active.count = nActive;
        dimmed.count = nDim;
        halo.count = nHalo;
        freshHalo.count = nFresh;
        freshHalo.instanceMatrix.needsUpdate = true;
        for (const mesh of [active, dimmed]) {
            mesh.instanceMatrix.needsUpdate = true;
            mesh.instanceColor!.needsUpdate = true;
        }
        halo.instanceMatrix.needsUpdate = true;
        activeEdges.geometry.setDrawRange(0, nActive * EDGE_VERTICES);
        dimmedEdges.geometry.setDrawRange(0, nDim * EDGE_VERTICES);
        activeEdges.geometry.getAttribute("position").needsUpdate = true;
        dimmedEdges.geometry.getAttribute("position").needsUpdate = true;
    };

    const rebuildSection = () => {
        // The outline sits on the highest layer that holds blocks at or below the cut, so a gap in the layers does not lose it.
        const layer = view.layerMax >= 0 && cutActive(blocks, view.layerMax) ? sectionLayer(blocks, view.layerMax) : -1;
        const row: Array<[number, number]> = [];
        if (layer >= 0) for (const i of shownIndices.subarray(0, shownCount)) if (blocks[i].cell[2] === layer) row.push([blocks[i].cell[0], blocks[i].cell[1]]);
        const z = (layer + 1) * cell;
        const lines = cellOutlineSegments(row, cell, z);
        const fill = cellTriangles(row, cell, z);
        (sectionOutline.geometry.getAttribute("position").array as Float32Array).set(lines.subarray(0, Math.min(lines.length, cells * 24)));
        (sectionFill.geometry.getAttribute("position").array as Float32Array).set(fill.subarray(0, Math.min(fill.length, cells * 18)));
        sectionOutline.geometry.setDrawRange(0, Math.min(row.length, cells) * 8);
        sectionFill.geometry.setDrawRange(0, Math.min(row.length, cells) * 6);
        sectionOutline.geometry.getAttribute("position").needsUpdate = true;
        sectionFill.geometry.getAttribute("position").needsUpdate = true;
    };

    // ---- picking ----
    const mins = new Float32Array(Math.max(1, count) * 3);
    const maxs = new Float32Array(Math.max(1, count) * 3);
    for (let i = 0; i < count; i += 1) {
        for (let a = 0; a < 3; a += 1) {
            mins[i * 3 + a] = blocks[i].centerMm[a] - cell / 2;
            maxs[i * 3 + a] = blocks[i].centerMm[a] + cell / 2;
        }
    }
    const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const point = new THREE.Vector3();

    // ---- applying the look ----
    const applyPalette = () => {
        palette = PALETTE[theme];
        for (const { material, role } of painted) material.color.set(resolve(role));
        ghostMaterial.color.set(palette.ghost);
        dimMaterial.opacity = DIM_OPACITY[theme];
    };
    const applyVisibility = () => {
        ghost.visible = view.showGhost;
        verdict.visible = view.showCog && !!stability;
    };

    applyPalette();
    recolor();
    applyVisibility();
    rebuildBlocks();
    rebuildSection();
    if (view.highlight.length) pulsing = !reduced;
    if (flash) freshMaterial.opacity = 0.95;

    const labelCache = { key: "", labels: [] as SceneLabel[] };
    const hover = { index: -1 };

    const handle: BlocksScene = {
        analysis,
        scene,
        bounds,
        parts: new Map(),
        grid: false,
        revision: () => 0,
        toWorld,

        pickRay(ray) {
            origin.copy(ray.origin).applyMatrix4(inverse);
            direction.copy(ray.direction).transformDirection(inverse);
            const hit = pickBlock([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z], mins, maxs, shownIndices.subarray(0, shownCount), emphasised);
            if (!hit) return null;
            point.copy(origin).addScaledVector(direction, hit.t);
            root.localToWorld(point);
            return { id: String(hit.index), point: [point.x, point.y, point.z] };
        },

        setView(next) {
            const layerMax = clampLayer(next.layerMax);
            const colorChanged = next.colorBy !== view.colorBy;
            const cutChanged = layerMax !== view.layerMax;
            const highlightChanged = !sameList(next.highlight, view.highlight);
            const flagsChanged = next.showGhost !== view.showGhost || next.showCog !== view.showCog;
            if (!colorChanged && !cutChanged && !highlightChanged && !flagsChanged) return false;
            view.colorBy = next.colorBy;
            view.layerMax = layerMax;
            view.showGhost = next.showGhost;
            view.showCog = next.showCog;
            view.highlight = [...next.highlight];
            if (colorChanged) recolor();
            applyVisibility();
            if (colorChanged || cutChanged || highlightChanged) rebuildBlocks();
            if (cutChanged) rebuildSection();
            if (hover.index >= 0 && !shownSet.has(hover.index)) handle.setHover(null);
            if (highlightChanged && view.highlight.length) {
                pulsing = !reduced;
                pulseStart = -1;
            }
            options.onChange?.();
            return true;
        },

        setTheme(next) {
            if (next === theme) return;
            theme = next;
            applyPalette();
            recolor();
            rebuildBlocks();
            options.onChange?.();
        },

        setHover(index) {
            const next = index !== null && shownSet.has(index) ? index : -1;
            if (next === hover.index) return;
            hover.index = next;
            hoverFill.visible = next >= 0;
            hoverOutline.visible = next >= 0;
            if (next >= 0) {
                const [x, y, z] = blocks[next].centerMm;
                hoverFill.position.set(x, y, z);
                hoverOutline.position.set(x, y, z);
            }
            options.onChange?.();
        },

        isShown: (index) => shownSet.has(index),
        info: (index) => (index >= 0 && index < count ? describeBlock(blocks[index], analysis.settings, describeStress(analysis, index), options.stepOffset ?? 0) : null),
        colorOf: (index) => hexes[index] ?? "#94a3b8",
        anchorOf(index) {
            const b = blocks[index];
            return b ? toWorld([b.centerMm[0], b.centerMm[1], b.centerMm[2] + cell / 2]) : null;
        },
        boxOf(index) {
            const b = blocks[index];
            if (!b) return null;
            const h = cell / 2;
            return new THREE.Box3().setFromPoints([new THREE.Vector3(...toWorld([b.centerMm[0] - h, b.centerMm[1] - h, b.centerMm[2] - h])), new THREE.Vector3(...toWorld([b.centerMm[0] + h, b.centerMm[1] + h, b.centerMm[2] + h]))]);
        },
        focusBox(focusMm) {
            const named = emphasised ? [...emphasised].map((i) => blocks[i]) : [];
            const { min, max } = focusBounds(focusMm, named, cell);
            return new THREE.Box3().setFromPoints([new THREE.Vector3(...toWorld(min)), new THREE.Vector3(...toWorld(max))]);
        },

        labels() {
            const key = `${view.showCog}|${view.layerMax}|${view.colorBy}`;
            if (labelCache.key !== key) {
                labelCache.key = key;
                labelCache.labels = sceneLabels(analysis, view).map((label) => ({ ...label, anchor: toWorld(label.anchor) }));
            }
            return labelCache.labels;
        },

        animate(now) {
            let more = false;
            if (pulsing) {
                if (pulseStart < 0) pulseStart = now;
                const t = now - pulseStart;
                if (t >= PULSE_MS) {
                    pulsing = false;
                    haloMaterial.opacity = HALO_OPACITY;
                } else {
                    haloMaterial.opacity = 0.4 + 0.55 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / PULSE_PERIOD_MS));
                    more = true;
                }
            }
            if (flash) {
                if (freshStart < 0) freshStart = now;
                const t = now - freshStart;
                if (t >= FRESH_MS) {
                    // Done: the ring comes off, and does not come back with a layer cut.
                    flash = false;
                    freshMaterial.opacity = 0;
                    freshHalo.count = 0;
                } else {
                    const left = 1 - t / FRESH_MS;
                    freshMaterial.opacity = 0.95 * left * left;
                    more = true;
                }
            }
            return more;
        },

        flashing: () => flash,

        dispose() {
            for (const mesh of instanced) mesh.dispose();
            for (const geometry of geometries) geometry.dispose();
            for (const material of materials) material.dispose();
            instanced.length = 0;
            geometries.clear();
            materials.clear();
            painted.length = 0;
            ghost.clear();
            scene.clear();
            reduced = true;
            flash = false;
        },
    };
    return handle;
}
