// Hand the visitor a file made in the browser.

/** Save `blob` as `fileName` through a temporary link. */
export function downloadBlob(fileName: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // The click has handed the blob to the browser; release it a moment later.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save `text` as `fileName` through a temporary link. */
export function downloadText(fileName: string, mime: string, text: string): void {
    downloadBlob(fileName, new Blob([text], { type: mime }));
}

/** Save bytes (a GLB the stabilizer wrote) as `fileName`. */
export function downloadBytes(fileName: string, mime: string, bytes: Uint8Array): void {
    // A copy on a plain ArrayBuffer: the bytes may be a view on a buffer that was transferred out of a worker.
    downloadBlob(fileName, new Blob([new Uint8Array(bytes)], { type: mime }));
}
