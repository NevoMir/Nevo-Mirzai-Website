/**
 * Loads a same-origin GLB into a three.js scene: fetch with progress (and a size cap), then
 * GLTFLoader.parseAsync. The Draco, Meshopt and KTX2 decoders are imported (and their decoder files
 * fetched) only when the file's own header says it uses them. Imports three: load it lazily.
 *
 * Provider URLs are signed, expire and lack CORS, so the Worker stores every model in R2 and the
 * app only ever passes its own `/api/assignment_alex/files/...` URLs here.
 */
import type * as THREE from "three";
import { decodersNeeded, inspectGlb, isGlb } from "./glbHeader.ts";
import { tagMeshGroups } from "./glbParts.ts";

/** A GLB bigger than this is refused (the Worker stores at most what a provider returns, ~tens of MB). */
export const MAX_GLB_BYTES = 150 * 1024 * 1024;

// Vite serves public/ at BASE_URL, so the decoders sit at /assignment_alex/draco/ and /assignment_alex/basis/.
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/?$/, "/");
export const DRACO_DECODER_PATH = `${BASE}assignment_alex/draco/`;
export const BASIS_TRANSCODER_PATH = `${BASE}assignment_alex/basis/`;

export interface LoadGlbOptions {
    signal?: AbortSignal;
    /** 0..1 while the size is known, null while it is not. */
    onProgress?: (fraction: number | null) => void;
    /** Needed only to pick a texture transcoder format for KTX2 files (renderer.capabilities). */
    renderer?: THREE.WebGLRenderer;
    /** The size cap, default MAX_GLB_BYTES. */
    maxBytes?: number;
}

export interface LoadedGlb {
    /** The glTF scene, untouched (glTF units: metres, +Y up). */
    scene: THREE.Object3D;
    bytes: number;
}

/** A load that failed with a message fit for the user. */
export class GlbLoadError extends Error {
    constructor(message: string, cause?: unknown) {
        super(message);
        this.name = "GlbLoadError";
        if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
    }
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Downloads `url` with progress; checks status, size cap and the GLB magic (an SPA fallback page is HTML, not a model). */
export async function fetchGlb(url: string, options: Pick<LoadGlbOptions, "signal" | "onProgress" | "maxBytes"> = {}): Promise<ArrayBuffer> {
    const { signal, onProgress, maxBytes = MAX_GLB_BYTES } = options;
    let response: Response;
    try {
        response = await fetch(url, { signal, credentials: "same-origin" });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new GlbLoadError("The model could not be downloaded. Check your connection and try again.", error);
    }
    if (!response.ok) {
        throw new GlbLoadError(response.status === 404 ? "The model file was not found." : `The model could not be downloaded (HTTP ${response.status}).`);
    }
    const total = Number(response.headers.get("content-length")) || 0;
    if (total > maxBytes) throw new GlbLoadError(`The model is too large to display (${megabytes(total)}; the limit is ${megabytes(maxBytes)}).`);

    let buffer: ArrayBuffer;
    if (!response.body) {
        buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw new GlbLoadError(`The model is too large to display (over ${megabytes(maxBytes)}).`);
        onProgress?.(1);
    } else {
        const reader = response.body.getReader();
        // One buffer filled in place when the size is known (peak memory = the file, not twice it); it doubles when the size is missing or understated.
        let store = new Uint8Array(total > 0 ? total : 1024 * 1024);
        let received = 0;
        onProgress?.(total ? 0 : null);
        for (;;) {
            let step: ReadableStreamReadResult<Uint8Array>;
            try {
                step = await reader.read();
            } catch (error) {
                if (signal?.aborted) throw error;
                throw new GlbLoadError("The model download was interrupted. Check your connection and try again.", error);
            }
            const { done, value } = step;
            if (done) break;
            const at = received;
            received += value.byteLength;
            if (received > maxBytes) {
                void reader.cancel();
                throw new GlbLoadError(`The model is too large to display (over ${megabytes(maxBytes)}).`);
            }
            if (received > store.byteLength) {
                const bigger = new Uint8Array(Math.min(maxBytes, Math.max(store.byteLength * 2, received)));
                bigger.set(store.subarray(0, at));
                store = bigger;
            }
            store.set(value, at);
            // A compressed response can deliver more bytes than Content-Length counts.
            onProgress?.(total ? Math.min(0.99, received / total) : null);
        }
        buffer = (store.byteLength === received ? store.buffer : store.buffer.slice(0, received)) as ArrayBuffer;
        onProgress?.(1);
    }
    if (!isGlb(buffer)) throw new GlbLoadError("The file is not a valid 3D model (GLB).");
    return buffer;
}

/** Fetches and parses a GLB. Decoders for Draco, Meshopt and KTX2 are loaded only when the file declares them. */
export async function loadGlb(url: string, options: LoadGlbOptions = {}): Promise<LoadedGlb> {
    const buffer = await fetchGlb(url, options);
    options.signal?.throwIfAborted();
    const needs = decodersNeeded(inspectGlb(buffer));

    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const loader = new GLTFLoader();
    const disposers: Array<() => void> = [];
    try {
        if (needs.draco) {
            const { DRACOLoader } = await import("three/examples/jsm/loaders/DRACOLoader.js");
            const draco = new DRACOLoader();
            draco.setDecoderPath(DRACO_DECODER_PATH);
            loader.setDRACOLoader(draco);
            disposers.push(() => draco.dispose());
        }
        if (needs.meshopt) {
            const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
            loader.setMeshoptDecoder(MeshoptDecoder);
        }
        if (needs.ktx2) {
            const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
            const ktx2 = new KTX2Loader();
            ktx2.setTranscoderPath(BASIS_TRANSCODER_PATH);
            if (options.renderer) ktx2.detectSupport(options.renderer);
            loader.setKTX2Loader(ktx2);
            disposers.push(() => ktx2.dispose());
        }
        options.signal?.throwIfAborted();
        let gltf;
        try {
            gltf = await loader.parseAsync(buffer, "");
        } catch (error) {
            if (options.signal?.aborted) throw error;
            const detail = error instanceof Error ? error.message.replace(/^THREE\.GLTFLoader:\s*/, "") : String(error);
            throw new GlbLoadError(`The model file could not be read (${detail}).`, error);
        }
        // Keep a multi-primitive mesh (one object, several materials) as one part.
        tagMeshGroups(gltf.scene, gltf.parser.associations as unknown as ReadonlyMap<unknown, { meshes?: number; primitives?: number }>);
        return { scene: gltf.scene, bytes: buffer.byteLength };
    } finally {
        for (const dispose of disposers) dispose();
    }
}
