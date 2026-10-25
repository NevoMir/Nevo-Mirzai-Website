// What the server accepts of an edited model (worker/editUpload.ts checkEditedGlbJson), so the editor can tell the person BEFORE the work that
// a file cannot be saved afterwards: the reader refuses a source that uses a glTF extension the upload would refuse or a picture bigger than it
// takes (the writer copies both as they are, so the edit would run, write a file and fail at the upload, and Retry could never succeed), and the
// writer refuses a result with too many nodes. Pure: no imports, so the Worker can use the same lists (test-edit-mesh.mjs checks that the two agree).

/** The glTF extensions an edited model may use: what the Hunyuan files carry and what the editor writes. */
export const EDITED_EXTENSIONS: readonly string[] = ["KHR_materials_specular", "KHR_texture_transform", "KHR_materials_unlit"];

/** The most nodes an edited model may have. */
export const MAX_EDITED_NODES = 200;

/** The biggest picture an edited model may carry, on a side and in pixels (worker/editUpload.ts: everyone's viewer decodes it to 4 bytes a pixel). */
export const MAX_EDITED_IMAGE_SIDE = 4096;
export const MAX_EDITED_IMAGE_PIXELS = 4096 * 4096;

/**
 * The pixel size a PNG or JPEG declares in its header, or null when it cannot be read (nothing is decoded, so this is cheap). The editor
 * copies the model's own picture into the result unless it repaints it, so a picture the server would refuse has to be turned away first.
 */
export function declaredPictureSize(bytes: Uint8Array, mime: string): { width: number; height: number } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (mime === "image/png") {
        // 8-byte signature, then the IHDR chunk: length, "IHDR", width and height as big-endian 32-bit numbers.
        const ihdr = bytes.length >= 24 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52;
        return ihdr ? { width: view.getUint32(16), height: view.getUint32(20) } : null;
    }
    if (mime !== "image/jpeg" || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    // Walk the marker segments until a start-of-frame one, which holds height then width (big-endian 16-bit).
    let at = 2;
    while (at + 4 <= bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker === 0xff) {
            at += 1; // fill byte
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            at += 2; // markers without a payload
            continue;
        }
        const length = view.getUint16(at + 2);
        // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return at + 9 <= bytes.length ? { width: view.getUint16(at + 7), height: view.getUint16(at + 5) } : null;
        }
        if (length < 2) return null;
        at += 2 + length;
    }
    return null;
}

/** Is this picture, by what its header says, bigger than the server takes? (A header that cannot be read is the server's to judge.) */
export function pictureTooBig(bytes: Uint8Array, mime: string): boolean {
    const size = declaredPictureSize(bytes, mime);
    return size !== null && (size.width > MAX_EDITED_IMAGE_SIDE || size.height > MAX_EDITED_IMAGE_SIDE || size.width * size.height > MAX_EDITED_IMAGE_PIXELS);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function collect(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 12 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
        for (const item of value) collect(item, out, depth + 1);
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === "extensions" && isRecord(child)) for (const name of Object.keys(child)) out.add(name);
        else if (key !== "extras") collect(child, out, depth + 1);
    }
}

/** The first extension the file declares or uses (anywhere in its description) that an edited model may not have, else null. */
export function firstDisallowedExtension(json: unknown): string | null {
    if (!isRecord(json)) return null;
    for (const key of ["extensionsUsed", "extensionsRequired"]) {
        const list = json[key];
        if (Array.isArray(list)) for (const name of list) if (typeof name === "string" && !EDITED_EXTENSIONS.includes(name)) return name;
    }
    const used = new Set<string>();
    collect(json, used);
    for (const name of used) if (!EDITED_EXTENSIONS.includes(name)) return name;
    return null;
}
