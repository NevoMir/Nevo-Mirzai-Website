// The versions of a model: the model as it was made (a generated model or an example) and the stabilized versions that were
// made from it, directly or from another version.
//
// What the viewer draws follows from this. A stabilized model is a block assembly (its GLB is 100 mm blocks), but the 3D
// tab should show the real model: so the viewer loads the ROOT of the family, the mesh the stabilizer started from, and the
// stabilized model's blocks are drawn over it. That works because the stabilizer works in the source's own grid: the cells
// of a stabilized model are cells of the source's voxelisation, and the source's transform (analysis/voxelize.ts
// transformForBounds) places them. `display` is that mesh. When the root is not in the project (deleted) the stabilized GLB
// itself is shown, as before.
//
//   versionFamily(models, activeId)   pure: the family of the active model (an optional third argument: source meshes that failed to load)
//   useVersionFamily()                the same for the open project, as a hook
//   useDisplayModel(model)            the model whose GLB the viewer loads for `model`
//   markMeshFailed(id)                a source mesh could not be loaded: its stabilized versions show their own blocks until it is cleared
//   useAssemblyFor(model)             the block assembly of a stabilized model, read once from its GLB and kept
//   loadAssembly(model)               the same without a hook (the analysis runner)

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { AssemblyDescriptor } from "@/assignment/shared/assembly";
import type { ModelAsset } from "@/assignment/shared/contract";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { descendantsOf } from "@/assignment/store/versionTree";

export interface VersionFamily {
    /** The model nobody made from another one (kind "generated" or "example") that the active model descends from; null when it is not in the project. */
    root: ModelAsset | null;
    /** Every stabilized version made from the root, directly or through another version, newest first. */
    stabilized: ModelAsset[];
    /** The model in the viewer. */
    active: ModelAsset;
    /** The model whose GLB the viewer loads: the root for a stabilized active model whose root is present, else `active`. */
    display: ModelAsset;
    /** The active model is a stabilized version. */
    isStabilized: boolean;
}

const isStabilized = (model: ModelAsset): boolean => model.kind === "stabilized";

/**
 * The model a chain of stabilized versions starts from: follow `source_model_id` up through stabilized ancestors to the first
 * model that is not a stabilized version. Null when a link is missing (the source is not in the list) or the chain loops.
 */
export function rootOf(models: readonly ModelAsset[], model: ModelAsset): ModelAsset | null {
    const byId = new Map(models.map((m) => [m.id, m]));
    const seen = new Set<string>();
    let current: ModelAsset | undefined = model;
    while (current && isStabilized(current)) {
        if (seen.has(current.id)) return null;
        seen.add(current.id);
        current = current.source_model_id ? byId.get(current.source_model_id) : undefined;
    }
    return current ?? null;
}

/**
 * The family of the active model, or null when there is no active model or the project does not have it.
 *
 * - A chain generated -> stabilized -> stabilized again is one family: the root is the generated model, `stabilized` has both
 *   versions (newest first) and `display` is the root, whichever of the three is active.
 * - A stabilized model whose chain does not reach a model of the project (the original is gone) has no root and no siblings;
 *   it displays itself.
 */
export function versionFamily(models: readonly ModelAsset[], activeId: string | null, failedMeshes: ReadonlySet<string> = NO_FAILURES): VersionFamily | null {
    if (activeId === null) return null;
    const active = models.find((m) => m.id === activeId);
    if (!active) return null;
    const stabilizedActive = isStabilized(active);
    const root = rootOf(models, active);
    if (!root) return { root: null, stabilized: [], active, display: active, isStabilized: stabilizedActive };

    // Newest first; the tree is read the same way by the Stabilize card (store/versionTree.ts).
    // A root whose mesh could not be loaded is not shown: the stabilized model shows its own blocks, as when the root is gone.
    const display = stabilizedActive && !failedMeshes.has(root.id) ? root : active;
    return { root, stabilized: descendantsOf(models, root.id), active, display, isStabilized: stabilizedActive };
}

// ---------- a source mesh that will not load ----------

const NO_FAILURES: ReadonlySet<string> = new Set();
/** Ids of the models whose mesh the viewer could not load while it was shown behind a stabilized version. Replaced, never changed, so a hook can compare it. */
let failedMeshes: ReadonlySet<string> = NO_FAILURES;
const failureListeners = new Set<() => void>();
const subscribeFailures = (fn: () => void): (() => void) => {
    failureListeners.add(fn);
    return () => void failureListeners.delete(fn);
};

/** The source meshes known not to load right now (the viewer and the analysis both decide what is on stage from this). */
export function meshFailures(): ReadonlySet<string> {
    return failedMeshes;
}

/**
 * The mesh of `modelId` could not be loaded while a stabilized version was shown over it. From now on that version's `display` is
 * itself (its own blocks, as when the source is deleted), so the stage, the analysis and the buttons all agree on one file.
 */
export function markMeshFailed(modelId: string): void {
    if (failedMeshes.has(modelId)) return;
    failedMeshes = new Set(failedMeshes).add(modelId);
    failureListeners.forEach((fn) => fn());
}

/** Try the source meshes again (another model was opened, the workspace was left). */
export function clearMeshFailures(): void {
    if (failedMeshes.size === 0) return;
    failedMeshes = NO_FAILURES;
    failureListeners.forEach((fn) => fn());
}

function useMeshFailures(): ReadonlySet<string> {
    return useSyncExternalStore(subscribeFailures, meshFailures, meshFailures);
}

/** The model whose GLB the viewer loads when `modelId` is the active model: itself, or its family's root. Null when the project does not have it. */
export function displayModelOf(models: readonly ModelAsset[], modelId: string | null): ModelAsset | null {
    return versionFamily(models, modelId, failedMeshes)?.display ?? null;
}

/** The family of the open project's active model. */
export function useVersionFamily(): VersionFamily | null {
    const models = useWorkspaceStore((s) => s.models);
    const activeId = useWorkspaceStore((s) => s.activeModelId);
    const failed = useMeshFailures();
    return useMemo(() => versionFamily(models, activeId, failed), [models, activeId, failed]);
}

/** The model whose GLB the viewer loads for `model` (which should be the active one); `model` itself when the project has no better. */
export function useDisplayModel(model: ModelAsset | null): ModelAsset | null {
    const models = useWorkspaceStore((s) => s.models);
    const failed = useMeshFailures();
    return useMemo(() => (model ? (versionFamily(models, model.id, failed)?.display ?? model) : null), [models, model, failed]);
}

// ---------- the block assembly of a stabilized model ----------

export type AssemblyStatus = "idle" | "loading" | "ready" | "error";

export interface AssemblyState {
    status: AssemblyStatus;
    /** The cells, roles and steps of the model; null until `status` is "ready". */
    descriptor: AssemblyDescriptor | null;
    /** What went wrong when `status` is "error". */
    error: string | null;
}

const IDLE: AssemblyState = { status: "idle", descriptor: null, error: null };

interface Entry {
    state: AssemblyState;
    promise: Promise<AssemblyDescriptor>;
}

/** Descriptors are a few KB each; this many models are enough for any project (at most MAX_DERIVED_PER_PROJECT versions). */
const MAX_ENTRIES = 32;
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((fn) => fn());
const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
};

type AssemblySource = Pick<ModelAsset, "id" | "glb_url">;
const keyOf = (model: AssemblySource): string => `${model.id}|${model.glb_url}`;

const failureText = (detail: string): string => `The stabilized model's blocks could not be read (${detail}).`;

async function fetchDescriptor(model: AssemblySource): Promise<AssemblyDescriptor> {
    let response: Response;
    try {
        response = await fetch(model.glb_url, { credentials: "same-origin" });
    } catch {
        throw new Error("The stabilized model could not be downloaded. Check your connection and try again.");
    }
    if (!response.ok) throw new Error(response.status === 404 ? "The stabilized model's file was not found." : `The stabilized model could not be downloaded (HTTP ${response.status}).`);
    // The strict reader is loaded when a stabilized model is first shown, not with the page.
    const { readAssemblyGlb } = await import("@/assignment/shared/assemblyGlb");
    const read = readAssemblyGlb(new Uint8Array(await response.arrayBuffer()));
    if (!read.ok) throw new Error(failureText(read.error.replace(/\.$/, "")));
    return read.descriptor;
}

/**
 * The block assembly a stabilized model's GLB declares. The file is fetched once per model (a repeat call, or the hook, gets the
 * same promise); a failure is not kept, so asking again tries again. Rejects with an Error whose message is fit for the user.
 */
export function loadAssembly(model: AssemblySource): Promise<AssemblyDescriptor> {
    const key = keyOf(model);
    const known = entries.get(key);
    if (known && known.state.status !== "error") return known.promise;
    const entry: Entry = { state: { status: "loading", descriptor: null, error: null }, promise: undefined as unknown as Promise<AssemblyDescriptor> };
    entry.promise = fetchDescriptor(model).then(
        (descriptor) => {
            entry.state = { status: "ready", descriptor, error: null };
            notify();
            return descriptor;
        },
        (error: unknown) => {
            const message = error instanceof Error && error.message ? error.message : failureText("unknown error");
            entry.state = { status: "error", descriptor: null, error: message };
            notify();
            throw new Error(message);
        },
    );
    // Nobody may be waiting for this promise (the hook only watches the state): its rejection is reported through the state.
    entry.promise.catch(() => {});
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
    notify();
    return entry.promise;
}

/** What is known of a model's assembly right now, without asking for it. */
export function peekAssembly(model: AssemblySource | null): AssemblyState {
    return (model && entries.get(keyOf(model))?.state) || IDLE;
}

/** Forget every assembly read so far (tests, a different server). */
export function forgetAssemblies(): void {
    entries.clear();
    notify();
}

/**
 * The block assembly of a stabilized model (its cells, roles and steps), read once from its GLB and kept. `idle` for a model
 * that is not a stabilized version (a mesh has no assembly) and for no model.
 */
export function useAssemblyFor(model: ModelAsset | null): AssemblyState {
    const target = model && isStabilized(model) ? model : null;
    const key = target ? keyOf(target) : null;
    useEffect(() => {
        if (target) void loadAssembly(target).catch(() => {});
        // `target` is read through `key`: the same model object with a new identity must not fetch again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return useSyncExternalStore(
        subscribe,
        () => peekAssembly(target),
        () => IDLE,
    );
}
