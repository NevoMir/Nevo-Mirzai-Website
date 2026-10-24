// Hand the visitor a file made in the browser.

/** Save `text` as `fileName` through a temporary link. */
export function downloadText(fileName: string, mime: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
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
