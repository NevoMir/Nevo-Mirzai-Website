// PNG (and, where the browser can, JPEG) encoding of the pictures. PNG needs only deflate, which every runtime that can run the editor
// has as CompressionStream; JPEG needs a canvas (OffscreenCanvas in a worker). Each filter row is picked by the usual smallest-sum rule.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(parts: readonly Uint8Array[]): number {
    let c = 0xffffffff;
    for (const part of parts) for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** The scanlines of an RGB image with the best filter per row, each prefixed by its filter byte. */
function filterRows(rgb: Uint8Array, W: number, H: number): Uint8Array {
    const stride = W * 3;
    const out = new Uint8Array(H * (stride + 1));
    const candidate = new Uint8Array(stride);
    for (let y = 0; y < H; y++) {
        let best = -1;
        let bestCost = Infinity;
        let bestRow = candidate;
        for (let f = 0; f < 5; f++) {
            const row = new Uint8Array(stride);
            let cost = 0;
            for (let i = 0; i < stride; i++) {
                const x = rgb[y * stride + i];
                const a = i >= 3 ? rgb[y * stride + i - 3] : 0;
                const b = y > 0 ? rgb[(y - 1) * stride + i] : 0;
                const c = y > 0 && i >= 3 ? rgb[(y - 1) * stride + i - 3] : 0;
                const v = f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
                row[i] = v & 255;
                cost += row[i] < 128 ? row[i] : 256 - row[i];
            }
            if (cost < bestCost) { bestCost = cost; best = f; bestRow = row; }
        }
        out[y * (stride + 1)] = best;
        out.set(bestRow, y * (stride + 1) + 1);
    }
    return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const canEncodePng = (): boolean => typeof CompressionStream !== "undefined";

/** An RGB image as PNG bytes. */
export async function encodePng(rgb: Uint8Array, W: number, H: number): Promise<Uint8Array> {
    const idat = await deflate(filterRows(rgb, W, H));
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
        const out = new Uint8Array(12 + data.length);
        const view = new DataView(out.buffer);
        view.setUint32(0, data.length);
        const name = new TextEncoder().encode(type);
        out.set(name, 4);
        out.set(data, 8);
        view.setUint32(8 + data.length, crc32([name, data]));
        return out;
    };
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, W);
    hv.setUint32(4, H);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolour
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

/** An RGB image as JPEG bytes, or null where there is no canvas to do it (the page then keeps the PNG). */
export async function encodeJpegFromRgb(rgb: Uint8Array, W: number, H: number, quality: number): Promise<Uint8Array | null> {
    if (typeof OffscreenCanvas === "undefined") return null;
    try {
        const canvas = new OffscreenCanvas(W, H);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const data = new ImageData(W, H);
        for (let i = 0; i < W * H; i++) {
            data.data[i * 4] = rgb[i * 3];
            data.data[i * 4 + 1] = rgb[i * 3 + 1];
            data.data[i * 4 + 2] = rgb[i * 3 + 2];
            data.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(data, 0, 0);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        return new Uint8Array(await blob.arrayBuffer());
    } catch {
        return null;
    }
}

export function toDataUrl(bytes: Uint8Array, mime: string): string {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return `data:${mime};base64,${btoa(binary)}`;
}
