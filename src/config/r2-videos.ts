/**
 * Cloudflare R2 video URL configuration.
 *
 * After creating your R2 bucket and making it publicly accessible,
 * set the R2_PUBLIC_URL below to your bucket's public URL, e.g.:
 *   https://videos.yourdomain.com
 *   https://pub-xxxx.r2.dev
 *
 * Videos are stored in R2 with the path structure:
 *   {R2_PUBLIC_URL}/{project-slug}/cover/{filename}
 *   {R2_PUBLIC_URL}/{project-slug}/videos/{filename}
 *
 * Use the upload script (scripts/upload-videos-to-r2.sh) to upload
 * all videos from src/assets/projects/ to your R2 bucket.
 */

const R2_PUBLIC_URL = import.meta.env.VITE_R2_PUBLIC_URL ?? "";

type VideoEntry = {
    /** Path relative to the project folder, e.g. "cover/cover.mp4" or "videos/demo.mp4" */
    path: string;
};

type R2VideoManifest = Record<string, VideoEntry[]>;

/**
 * Manifest of all videos hosted on R2, keyed by project slug.
 * The paths mirror the original src/assets/projects/{slug}/{path} structure.
 */
export const r2VideoManifest: R2VideoManifest = {
    "aerial-am": [
        { path: "cover/cover.mp4" },
        { path: "videos/curing-transition.mp4" },
        { path: "videos/expansion-only.mp4" },
    ],
    "autonomous-drone-racing": [
        { path: "cover/cover.mp4" },
        { path: "videos/video_yugo.mp4" },
    ],
    "autonomous-vehicle-mpc": [
        { path: "cover/cover.mp4" },
    ],
    "eye-tracker-headlamp": [
        { path: "cover/cover.mp4" },
        { path: "videos/full-system-demo.mp4" },
    ],
    "billiard-vision-analysis": [
        { path: "cover/cover.mp4" },
    ],
    "hand-gesture-drone-swarms": [
        { path: "cover/cover.mp4" },
        { path: "videos/Obstacle-course.mp4" },
        { path: "videos/hands-ellipsoid.mp4" },
        { path: "videos/real-swarm-no-velocity.mp4" },
        { path: "videos/real-swarm-velocity.mp4" },
        { path: "videos/vr-2d-swarm.mp4" },
    ],
    "lerobot": [
        { path: "cover/cover.mp4" },
        { path: "videos/lerobot_video_1.mp4" },
        { path: "videos/lerobot_video_2.mp4" },
    ],
    "rl-quadruped-training": [
        { path: "videos/Dog Robot Cover 1080p.mp4" },
    ],
    "robot-vision-navigation": [
        { path: "cover/cover.mp4" },
    ],
    "soft-arm-sim-to-real": [
        { path: "cover/cover.mp4" },
    ],
    "virtual-drone-racing": [
        { path: "cover/cover.mp4" },
    ],
};

/**
 * Build a full R2 URL for a video.
 */
export function getR2VideoUrl(slug: string, path: string): string {
    return `${R2_PUBLIC_URL}/${slug}/${path}`;
}

/**
 * Build lookup maps from the manifest for quick access by slug.
 */
export function buildR2Lookups() {
    const coverBySlug: Record<string, string> = {};
    const videosBySlug: Record<string, string[]> = {};
    const videoLookupBySlug: Record<string, Record<string, string>> = {};
    const coverLookupBySlug: Record<string, Record<string, string>> = {};

    for (const [slug, entries] of Object.entries(r2VideoManifest)) {
        for (const entry of entries) {
            const url = getR2VideoUrl(slug, entry.path);
            const fileName = entry.path.split("/").pop() ?? "";

            if (entry.path.startsWith("cover/")) {
                if (!coverBySlug[slug]) {
                    coverBySlug[slug] = url;
                }
                coverLookupBySlug[slug] ??= {};
                coverLookupBySlug[slug][fileName] = url;
            } else if (entry.path.startsWith("videos/")) {
                videosBySlug[slug] ??= [];
                videosBySlug[slug].push(url);
                videoLookupBySlug[slug] ??= {};
                videoLookupBySlug[slug][fileName] = url;
            }
        }
    }

    return { coverBySlug, videosBySlug, videoLookupBySlug, coverLookupBySlug };
}
