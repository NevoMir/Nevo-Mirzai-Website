// Reads a GLB's header and JSON chunk without parsing the scene, so the loader can bring in the
// Draco, Meshopt and KTX2 decoders only for files that use them. Pure (no three.js).

export interface GlbInfo {
    version: number;
    /** Declared byte length of the container. */
    length: number;
    extensionsUsed: string[];
    extensionsRequired: string[];
}

const MAGIC = 0x46546c67; // "glTF", little endian
const JSON_CHUNK = 0x4e4f534a; // "JSON"

/** True when the buffer starts with the GLB magic. */
export function isGlb(buffer: ArrayBuffer): boolean {
    return buffer.byteLength >= 12 && new DataView(buffer).getUint32(0, true) === MAGIC;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The container header and the extensions the file declares; null when it is not a GLB. */
export function inspectGlb(buffer: ArrayBuffer): GlbInfo | null {
    if (!isGlb(buffer)) return null;
    const view = new DataView(buffer);
    const info: GlbInfo = { version: view.getUint32(4, true), length: view.getUint32(8, true), extensionsUsed: [], extensionsRequired: [] };
    if (buffer.byteLength < 20 || view.getUint32(16, true) !== JSON_CHUNK) return info;
    const size = view.getUint32(12, true);
    if (20 + size > buffer.byteLength) return info;
    try {
        const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, size))) as { extensionsUsed?: unknown; extensionsRequired?: unknown };
        info.extensionsUsed = strings(json.extensionsUsed);
        info.extensionsRequired = strings(json.extensionsRequired);
    } catch {
        // GLTFLoader reports a damaged JSON chunk with a better message than we could.
    }
    return info;
}

export interface DecodersNeeded {
    draco: boolean;
    meshopt: boolean;
    ktx2: boolean;
}

/**
 * Which decoders a file needs, from its declared extensions. A name in extensionsRequired counts even
 * when extensionsUsed omits it, and meshopt has two names (EXT_ is the draft one still in the wild,
 * KHR_ the ratified one; GLTFLoader reads both and fails without a decoder when either is required).
 */
export function decodersNeeded(info: GlbInfo | null): DecodersNeeded {
    const declared = new Set([...(info?.extensionsUsed ?? []), ...(info?.extensionsRequired ?? [])]);
    return {
        draco: declared.has("KHR_draco_mesh_compression"),
        meshopt: declared.has("EXT_meshopt_compression") || declared.has("KHR_meshopt_compression"),
        ktx2: declared.has("KHR_texture_basisu"),
    };
}
