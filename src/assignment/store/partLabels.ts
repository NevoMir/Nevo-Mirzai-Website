// Which part of the model each block belongs to ("the backrest"), for the natural-language edits of the blocks and the optimizer's
// "keep the seat". The labels of a version are found, in this order:
//   1. its own log, when it is a block version made by an edit or an optimization (the log carries `parts` and `labels`, one letter per
//      block, and a version made from it inherits them by cell);
//   2. the nearest ancestor that has one;
//   3. the model's mesh: each glTF part voxelised alone on the lattice of the whole model (analysis/partLabels.ts, in the analysis worker).
//      This needs the mesh on the stage (its parts are read from the viewer's scene); when it is not, there are no labels this time and
//      nothing is remembered, so asking again later can work.
// A model with fewer than two parts that own a block (a single mesh like Hunyuan's) has no labels: the scene text then names its structure
// by pieces ("o1", "c1") instead. The result is by CELL, not by block number, so the labels of an ancestor fit any version made from it.

import type { PartSoup } from "@/assignment/analysis/partLabels";
import { CELLS, labelsFromString, type PartLabels } from "@/assignment/shared/voxelEdit/grid";
import { noLabels } from "@/assignment/shared/voxelEdit/labels";
import type { AssemblyDescriptor } from "@/assignment/shared/assembly";
import { cellCode } from "@/assignment/shared/assembly";
import type { ModelAsset } from "@/assignment/shared/contract";
import { meshBaseOf, representation } from "@/assignment/shared/versionTree";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { partSoupsOfModel } from "@/assignment/viewer/loadedModel";

/** The labels of a model's blocks, and where they came from. */
export type PartLabelling = PartLabels & { source: "log" | "mesh" | "none" };

/** The parts as the optimizer wants them: part name -> the codes of the cells it owns (the caller keeps the ones that hold a block). */
export function cellsByPart(labelling: PartLabels): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    labelling.names.forEach((name) => (out[name] = []));
    for (let c = 0; c < CELLS; c++) {
        const p = labelling.owner[c];
        if (p >= 0 && p < labelling.names.length) out[labelling.names[p]].push(c);
    }
    return out;
}

// ---------- what a test can replace ----------

export interface PartLabelDeps {
    /** The parts and labels in the log of a block version's GLB, with its blocks; null when the file cannot be read. */
    readLog: (model: Pick<ModelAsset, "id" | "glb_url">) => Promise<{ names: string[]; labels: string; descriptor: AssemblyDescriptor } | null>;
    /** Labels for a mesh model from its parts; null when its parts cannot be read right now (it is not on the stage). */
    labelMesh: (model: ModelAsset) => Promise<PartLabels | null>;
}

async function readLogFromFile(model: Pick<ModelAsset, "id" | "glb_url">): Promise<{ names: string[]; labels: string; descriptor: AssemblyDescriptor } | null> {
    try {
        const response = await fetch(model.glb_url, { credentials: "same-origin" });
        if (!response.ok) return null;
        const { readAssemblyGlb } = await import("@/assignment/shared/assemblyGlb");
        const read = readAssemblyGlb(new Uint8Array(await response.arrayBuffer()));
        if (!read.ok) return null;
        if (read.edit) return { names: read.edit.parts, labels: read.edit.labels, descriptor: read.descriptor };
        if (read.optimization) return { names: read.optimization.parts, labels: read.optimization.labels, descriptor: read.descriptor };
        return null;
    } catch {
        return null;
    }
}

/** The codes of the blocks the mesh's own voxelisation has: from the analysis on screen when it is the mesh's, else by analysing the mesh. */
async function usedCellsOf(model: ModelAsset): Promise<number[]> {
    const analysis = useAnalysisStore.getState();
    const { result, resultModelId, loaded } = analysis;
    const code = (cell: readonly number[]): number => cellCode(cell[0], cell[1], cell[2]);
    if (result && resultModelId === model.id) return result.blocks.map((b) => code(b.cell));
    if (result && resultModelId) {
        // A block version on this mesh: its original blocks are the mesh's (the stabilizer never moves one).
        const models = useWorkspaceStore.getState().models;
        const shown = models.find((m) => m.id === resultModelId);
        if (shown && meshBaseOf(models, shown)?.id === model.id) return result.blocks.filter((b) => !b.role || b.role === "original").map((b) => code(b.cell));
    }
    if (!loaded) return [];
    const { runAnalysis } = await import("@/assignment/analysis/runAnalysis");
    const own = await runAnalysis(() => loaded.extractTriangles(), analysis.settings, { cacheKey: loaded.url });
    return own.blocks.map((b) => code(b.cell));
}

/**
 * The stored part count of a mesh edit is its source's (the server copies it), but an edit can add parts ("a cup holder") to the file: for
 * an edited mesh the count says nothing, and the parts on the stage are the truth.
 */
const partCountIsStale = (model: ModelAsset): boolean => model.kind === "edited" && model.edit?.target === "mesh";

async function labelMeshOnStage(model: ModelAsset): Promise<PartLabels | null> {
    // A single-part model (Hunyuan) has nothing to label: no need to read its triangles.
    if (model.part_count !== null && model.part_count < 2 && !partCountIsStale(model)) return noLabels();
    const { loaded } = useAnalysisStore.getState();
    if (!loaded || loaded.url !== model.glb_url) return null;
    let parts: PartSoup[] | null;
    try {
        parts = partSoupsOfModel(loaded);
    } catch {
        return null; // the viewer's handle was retired: the model is no longer on the stage
    }
    if (parts === null) return null;
    if (parts.length < 2) return noLabels();
    const used = await usedCellsOf(model);
    const { labelModel } = await import("@/assignment/analysis/runAnalysis");
    return labelModel(parts, used, useAnalysisStore.getState().settings);
}

const defaultDeps: PartLabelDeps = { readLog: readLogFromFile, labelMesh: labelMeshOnStage };
let deps: PartLabelDeps = defaultDeps;

/** Swap the file reader or the mesh labeller (tests). Called with nothing, puts the real ones back. */
export function setPartLabelDeps(next?: Partial<PartLabelDeps>): void {
    deps = { ...defaultDeps, ...next };
}

// ---------- the cache ----------

const MAX_ENTRIES = 24;
const known = new Map<string, Promise<PartLabelling>>();

const remember = (id: string, value: Promise<PartLabelling>): void => {
    known.delete(id);
    known.set(id, value);
    while (known.size > MAX_ENTRIES) {
        const oldest = known.keys().next().value;
        if (oldest === undefined) break;
        known.delete(oldest);
    }
};

/** A block version made by an edit of the blocks or an optimization has a log with labels in its file. */
const carriesLog = (m: ModelAsset): boolean => (m.kind === "edited" && m.edit?.target === "voxel") || m.kind === "optimized";

const NONE = (): PartLabelling => ({ ...noLabels(), source: "none" });

async function resolveLabels(model: ModelAsset): Promise<{ labelling: PartLabelling; final: boolean }> {
    const models = useWorkspaceStore.getState().models;
    const seen = new Set<string>();
    let cur: ModelAsset | undefined = model;
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (carriesLog(cur)) {
            const log = await deps.readLog(cur);
            if (!log) return { labelling: NONE(), final: false };
            const labels = labelsFromString(log.names, log.labels, log.descriptor);
            if (!labels) return { labelling: NONE(), final: false };
            return { labelling: { ...labels, source: "log" }, final: true };
        }
        if (representation(cur) === "mesh") {
            const labels = await deps.labelMesh(cur);
            if (!labels) return { labelling: NONE(), final: false };
            return { labelling: { ...labels, source: labels.names.length > 0 ? "mesh" : "none" }, final: true };
        }
        const parentId: string | null = cur.source_model_id;
        cur = parentId ? models.find((m) => m.id === parentId) : undefined;
    }
    return { labelling: NONE(), final: true };
}

/**
 * The labels of `model`'s blocks (see the header): cached per model, and shared by the block editor and the optimizer. Never rejects: a
 * model whose parts cannot be read gets no labels, and that answer is not kept.
 */
export function partLabelsFor(model: ModelAsset): Promise<PartLabelling> {
    const cached = known.get(model.id);
    if (cached) return cached;
    const work = resolveLabels(model).then(
        ({ labelling, final }) => {
            if (!final && known.get(model.id) === work) known.delete(model.id);
            return labelling;
        },
        () => {
            if (known.get(model.id) === work) known.delete(model.id);
            return NONE();
        },
    );
    remember(model.id, work);
    return work;
}

/** A new version's labels are known without reading its file (the editor just made them). */
export function primePartLabels(modelId: string, labelling: PartLabels): void {
    remember(modelId, Promise.resolve({ ...labelling, source: "log" }));
}

/** Forget every answer (tests, a different project). */
export function forgetPartLabels(): void {
    known.clear();
}
