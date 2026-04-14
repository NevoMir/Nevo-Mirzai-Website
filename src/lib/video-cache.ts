/**
 * In-memory Blob URL cache for cover videos.
 *
 * On first load videos stream from the network URL as usual.
 * After playback starts, the video is fetched as a Blob in the background
 * (typically served from the browser's HTTP cache, so no real double-download).
 * On subsequent mounts the Blob URL is reused for instant playback.
 *
 * Only videos under MAX_SINGLE_VIDEO_BYTES are cached.
 * The total cache budget is capped at MAX_TOTAL_CACHE_BYTES.
 */

const MAX_SINGLE_VIDEO_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_TOTAL_CACHE_BYTES = 30 * 1024 * 1024; // 30 MB

const cache = new Map<string, string>(); // network URL → blob URL
const pending = new Map<string, Promise<string | null>>(); // dedup in-flight fetches
let totalBytes = 0;

/** Synchronous lookup — returns the cached blob URL or null. */
export function getCachedUrl(networkUrl: string): string | null {
    return cache.get(networkUrl) ?? null;
}

/**
 * Cache a video in the background. Fire-and-forget — errors are swallowed
 * and the video will simply load from the network URL next time.
 */
export function cacheVideoInBackground(networkUrl: string): void {
    if (cache.has(networkUrl) || pending.has(networkUrl)) return;

    const promise = (async (): Promise<string | null> => {
        try {
            // Early exit via Content-Length when possible.
            const head = await fetch(networkUrl, { method: "HEAD" });
            const contentLength = Number(head.headers.get("Content-Length") ?? 0);
            if (contentLength > MAX_SINGLE_VIDEO_BYTES) return null;
            if (totalBytes + contentLength > MAX_TOTAL_CACHE_BYTES) return null;

            const response = await fetch(networkUrl);
            if (!response.ok) return null;

            const blob = await response.blob();
            if (blob.size > MAX_SINGLE_VIDEO_BYTES) return null;
            if (totalBytes + blob.size > MAX_TOTAL_CACHE_BYTES) return null;

            const blobUrl = URL.createObjectURL(blob);
            cache.set(networkUrl, blobUrl);
            totalBytes += blob.size;
            return blobUrl;
        } catch {
            return null;
        } finally {
            pending.delete(networkUrl);
        }
    })();

    pending.set(networkUrl, promise);
}
