// Shared helpers of the optimizer tests (test-optimize.mjs, fuzz-optimize.mjs, test-optimize-ui.mjs): the bundled examples as assemblies, the
// real WASM solver, the official analysis of an occupancy and the part cells of an example's original mesh. Not a test itself.
// Needs Node >= 22.18 (imports the .ts sources directly; the callers re-run themselves with --experimental-strip-types on 22.6 to 22.17).
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const R = `${ROOT}/src/assignment/`;
const EX = `${ROOT}/public/assignment_alex/examples/`;
export const A = (n) => import(`${R}${n}.ts`);

export const asm = await A("shared/assembly");
export const glb = await A("shared/assemblyGlb");
export const grid = await A("analysis/stabilize/grid");
export const adapter = await A("analysis/stabilize/stressAdapter");
export const fem = await A("analysis/fem/index");
export const st = await A("analysis/stress");
export const mats = await A("analysis/materials");
export const settingsMod = await A("analysis/settings");
export const analysis = await A("analysis/assembly");
export const SL = await A("shared/optimizeSpec");
export const MC = await A("shared/optimizeMeta");
export const SPEC = await A("analysis/optimize/spec");
export const OPT = await A("analysis/optimize/optimize");
export const EVAL = await A("analysis/optimize/evaluate");
export const OA = await A("analysis/optimize/optimizeAssembly");
export const DIMS = { gx: 10, gy: 10, gz: 10 };
export const SLUGS = ["pencil-leg-chair", "desk-lamp", "cantilever-house", "long-neck-dino", "leaning-tower", "oak-tree", "harbour-crane", "arch-footbridge", "step-pyramid", "mushroom-pavilion"];

/** The stabilized example as { descriptor, ... } (readAssemblyGlb's answer). */
export function loadStabilized(slug) {
    const bytes = new Uint8Array(readFileSync(`${EX}${slug}/stabilized.glb`));
    const r = glb.readAssemblyGlb(bytes);
    if (!r.ok) throw new Error(r.error);
    return r;
}

/** occupancy, role and step arrays (by cell index) from a descriptor */
export function occOf(desc) {
    const occ = new Uint8Array(1000), role = new Uint8Array(1000), step = new Uint8Array(1000);
    for (let n = 0; n < desc.cells.length; n += 5) {
        const c = grid.cellIndex(DIMS, desc.cells[n], desc.cells[n + 1], desc.cells[n + 2]);
        occ[c] = 1; role[c] = desc.cells[n + 3]; step[c] = desc.cells[n + 4];
    }
    return { occ, role, step };
}

export const WASM_PATH = `${R}analysis/fem/vendor/lSolver.wasm`;
export async function getSolver() {
    return await st.loadSolver(WASM_PATH);
}

/** The official verdict of an occupancy: the Stability tab's own pipeline (analyzeAssembly + computeStress + applyStress). */
export async function official(occ) {
    const desc = asm.descriptorFromBlocks([...Array(1000).keys()].filter((c) => occ[c]).map((c) => ({ cell: grid.cellCoords(DIMS, c), role: "original", step: 0 })));
    const base = analysis.analyzeAssembly(desc, null, {});
    const solver = await getSolver();
    const stress = st.computeStress(base, solver);
    return st.applyStress(base, stress);
}

export function fmtM(m) {
    return `n=${m.blocks} util=${m.maxUtil === null ? "-" : m.maxUtil.toFixed(3)} margin=${m.cogMarginMm === null ? "-" : m.cogMarginMm.toFixed(1)}mm defl=${m.maxDeflectionMm === null ? "-" : (m.maxDeflectionMm * 1000).toFixed(2)}um float=${m.floating} over=${m.overLimit} bodies=${m.bodies}`;
}

// ---------- the named parts of an example's original mesh (what the part labels give the optimizer) ----------

const load = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
let three = null;
async function threeStuff() {
    if (three) return three;
    const THREE = await load("node_modules/three/build/three.module.js");
    const { GLTFLoader } = await load("node_modules/three/examples/jsm/loaders/GLTFLoader.js");
    const { MeshoptDecoder } = await load("node_modules/three/examples/jsm/libs/meshopt_decoder.module.js");
    three = { THREE, GLTFLoader, MeshoptDecoder, glbParts: await A("viewer/glbParts"), vox: await A("analysis/voxelize") };
    return three;
}

/** { soups: [{name, positions}], whole } in the viewer's frame (Z-up, normalised), as the part labels see the example's original mesh */
export async function loadParts(slug) {
    const { THREE, GLTFLoader, MeshoptDecoder, glbParts } = await threeStuff();
    const bytes = new Uint8Array(readFileSync(`${EX}${slug}/original.glb`));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buffer, "");
    glbParts.tagMeshGroups(gltf.scene, gltf.parser.associations);
    const root = new THREE.Group();
    const model = new THREE.Group();
    model.add(gltf.scene);
    root.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene, true);
    const size = box.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    const scale = longest > 0 && Number.isFinite(longest) ? 100 / longest : 1;
    model.rotation.x = Math.PI / 2;
    model.scale.setScalar(scale);
    model.position.set(-((box.min.x + box.max.x) / 2) * scale, (-(box.min.z + box.max.z) / 2) * scale, -box.min.y * scale);
    root.updateMatrixWorld(true);
    const specs = glbParts.extractParts(gltf.scene);
    const soups = specs.map((p) => ({ name: p.name, positions: glbParts.extractTriangleSoup(p.object) }));
    return { soups, whole: glbParts.extractTriangleSoup(root) };
}

/** cells (Uint8Array 1000) each part claims: its solid fill >= fillThreshold under the placement of the WHOLE mesh */
export async function labelParts(soups, whole, fillThreshold = 0.1) {
    const { vox } = await threeStuff();
    const settings = settingsMod.normalizeSettings({});
    const b = vox.finiteBounds(whole, Math.floor(whole.length / 9));
    // two degenerate triangles at the corners of the whole model's box pin the placement without adding volume
    const pin = new Float32Array([...b.min, ...b.min, ...b.min, ...b.max, ...b.max, ...b.max]);
    const out = {};
    for (const s of soups) {
        const merged = new Float32Array(s.positions.length + pin.length);
        merged.set(s.positions); merged.set(pin, s.positions.length);
        const g = vox.voxelize({ positions: merged }, settings);
        const cells = new Uint8Array(1000);
        for (let c = 0; c < 1000; c++) if (g.solid[c] / vox.CELLS_PER_BLOCK >= fillThreshold) cells[c] = 1;
        out[s.name] = cells;
    }
    return out;
}

/** SpecContext for an example: occupancy, roles, named parts (from the ORIGINAL mesh), start metrics, and the descriptor */
export async function ctxFor(slug, withParts = true) {
    const solver = await getSolver();
    const r = loadStabilized(slug);
    const state = occOf(r.descriptor);
    const settings = settingsMod.normalizeSettings({});
    const material = mats.materialOf(settings.material).fem;
    const ev = EVAL.createEvaluator({ solve: solver.solve, blockSizeMm: 100, material, cantileverLimit: settings.cantileverLimit });
    const g = ev.geometry(state.occ);
    const f = ev.field(state.occ);
    const start = EVAL.metricsOf(g, f);
    const parts = {};
    if (withParts) {
        const { soups, whole } = await loadParts(slug);
        const lab = await labelParts(soups, whole, 0.03);
        for (const [name, cells] of Object.entries(lab)) {
            let any = false;
            for (let c = 0; c < 1000; c++) if (cells[c] && state.occ[c]) { any = true; break; }
            if (any) parts[name] = cells;
        }
    }
    return { ctx: { occ: state.occ, role: state.role, parts, cantileverLimit: settings.cantileverLimit, start }, state, solver, material, settings, descriptor: r.descriptor };
}

/** { name: [cell index, ...] } of a ctx.parts (Uint8Array masks), the form OptimizeInput takes */
export const partCells = (parts) => Object.fromEntries(Object.entries(parts).map(([n, m]) => [n, [...Array(1000).keys()].filter((c) => m[c])]));
