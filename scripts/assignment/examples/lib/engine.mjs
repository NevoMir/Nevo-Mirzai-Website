// Bridge to the app's own analysis engine and viewer code, so the numbers that ship with the examples come from
// exactly the code that runs in the browser (Node 22 strips the types of the .ts modules). In the repo this file lives
// in scripts/assignment/examples/lib/, four levels below the root.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const file = (rel) => resolve(REPO, rel);
const load = (rel) => import(pathToFileURL(file(rel)).href);

const analyzeMod = await load("src/assignment/analysis/analyze.ts");
const voxMod = await load("src/assignment/analysis/voxelize.ts");
const settingsMod = await load("src/assignment/analysis/settings.ts");
const stressMod = await load("src/assignment/analysis/stress.ts");
const assemblyMod = await load("src/assignment/analysis/assembly.ts");
const sharedAssembly = await load("src/assignment/shared/assembly.ts");
const sharedGlb = await load("src/assignment/shared/assemblyGlb.ts");

export const { analyzeGrid } = analyzeMod;
export const { voxelize } = voxMod;
export const { normalizeSettings } = settingsMod;
export const { computeStress, applyStress, loadSolver } = stressMod;
export const { analyzeAssembly, cellsOf, annotateRoles } = assemblyMod;
export const { descriptorFromBlocks, assemblyHash, roleCounts } = sharedAssembly;
export const { writeAssemblyGlb, readAssemblyGlb } = sharedGlb;

const THREE = await load("node_modules/three/build/three.module.js");
const { GLTFLoader } = await load("node_modules/three/examples/jsm/loaders/GLTFLoader.js");
const { MeshoptDecoder } = await load("node_modules/three/examples/jsm/libs/meshopt_decoder.module.js");
const parts = await load("src/assignment/viewer/glbParts.ts");

/** Awatif's WASM solver (the browser's), loaded from the vendored file; the TypeScript solver when it cannot load. */
export const WASM_PATH = file("src/assignment/analysis/fem/vendor/lSolver.wasm");
let solverPromise = null;
export const getSolver = () => (solverPromise ??= loadSolver(WASM_PATH));

/** GLB bytes -> Float32Array soup in the viewer's frame (Z-up), by the same path the app takes (GLTFLoader + glbParts + normalise). */
export async function loadSoupLikeTheApp(bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, "");
    parts.tagMeshGroups(gltf.scene, gltf.parser.associations);
    const root = new THREE.Group();
    const model = new THREE.Group();
    model.add(gltf.scene);
    root.add(model);
    // The viewer's own normalise() (viewer/glbScene.ts): Y-up metres -> Z-up, longest side TARGET_SIZE_MM (100), centred on XY, bottom on z = 0.
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const scale = longest > 0 && Number.isFinite(longest) ? 100 / longest : 1;
    model.rotation.x = Math.PI / 2;
    model.scale.setScalar(scale);
    const centreX = ((box.min.x + box.max.x) / 2) * scale;
    const centreY = (-(box.min.z + box.max.z) / 2) * scale;
    model.position.set(-centreX, -centreY, -box.min.y * scale);
    root.updateMatrixWorld(true);
    return { soup: { positions: parts.extractTriangleSoup(root) }, partNames: parts.extractParts(gltf.scene).map((p) => p.name) };
}

/** What analysis.worker.ts will do for a mesh: voxelise, analyse, then the stress stage. Returns the result with stress applied. */
export async function analyseSoup(soup, settingsIn = {}) {
    const settings = normalizeSettings(settingsIn);
    const grid = voxelize(soup, settings);
    return analyseGrid(grid, settings);
}

export async function analyseGrid(grid, settings) {
    const base = analyzeGrid(grid, settings);
    const solver = await getSolver();
    return applyStress(base, computeStress(base, solver, settings.material));
}

/** Analysis of a block assembly (descriptor), stress included. */
export async function analyseAssemblyFull(descriptor, settingsIn = {}, soupBounds = null) {
    const settings = normalizeSettings(settingsIn);
    const base = analyzeAssembly(descriptor, soupBounds, settings);
    const solver = await getSolver();
    return applyStress(base, computeStress(base, solver, settings.material));
}

export const readBytes = async (path) => new Uint8Array(await readFile(path));
