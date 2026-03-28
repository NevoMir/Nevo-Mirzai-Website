import { ProjectsData } from "@/data/projects";
import type { ProjectHero } from "@/data/projects";
import { buildR2Lookups } from "@/config/r2-videos";

type AssetModule = { default: string };

const imageModules = import.meta.glob<AssetModule>("@/assets/projects/*/images/*", {
    eager: true,
});

const pdfModules = import.meta.glob<AssetModule>("@/assets/projects/*/pdf/*", {
    eager: true,
});

const posterModules = import.meta.glob<AssetModule>("@/assets/projects/*/poster/*", {
    eager: true,
});

// Videos and covers are now served from Cloudflare R2.
// Local fallbacks via Vite glob are kept for dev convenience —
// if a video exists locally it will be used when R2_PUBLIC_URL is not set.
const localVideoModules = import.meta.glob<AssetModule>("@/assets/projects/*/videos/*", {
    eager: true,
});

const localCoverModules = import.meta.glob<AssetModule>("@/assets/projects/*/cover/*", {
    eager: true,
});

const videoExtensions = ["mp4", "webm", "ogg", "mov", "m4v"];

const imagesBySlug: Record<string, string[]> = {};
const pdfBySlug: Record<string, string> = {};
const posterBySlug: Record<string, string> = {};
const pdfLookupBySlug: Record<string, Record<string, string>> = {};
const imageLookupBySlug: Record<string, Record<string, string>> = {};
const posterLookupBySlug: Record<string, Record<string, string>> = {};
const heroBySlug: Record<string, ProjectHero> = {};

// --- R2 lookups (external video hosting) ---
const r2 = buildR2Lookups();

// --- Local video/cover fallback lookups ---
const localVideosBySlug: Record<string, string[]> = {};
const localVideoLookupBySlug: Record<string, Record<string, string>> = {};
const localCoverLookupBySlug: Record<string, Record<string, string>> = {};
const localCoverBySlug: Record<string, string> = {};

function inferAssetType(path: string): "image" | "video" {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return videoExtensions.includes(ext) ? "video" : "image";
}

function getYouTubeId(input: string): string | null {
    if (!input) return null;
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
        return input;
    }

    try {
        const url = new URL(input);
        if (url.hostname === "youtu.be") {
            return url.pathname.split("/").filter(Boolean)[0] ?? null;
        }
        if (url.hostname.endsWith("youtube.com")) {
            if (url.pathname.startsWith("/watch")) {
                return url.searchParams.get("v");
            }
            if (url.pathname.startsWith("/embed/") || url.pathname.startsWith("/shorts/")) {
                return url.pathname.split("/").filter(Boolean)[1] ?? null;
            }
        }
    } catch {
        // Fall through to regex parsing.
    }

    const match = input.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})(?:\b|&|$)/);
    return match ? match[1] : null;
}

function buildYouTubeEmbedUrl(videoId: string) {
    const params = new URLSearchParams({
        autoplay: "1",
        mute: "1",
        loop: "1",
        playlist: videoId,
        controls: "0",
        modestbranding: "1",
        rel: "0",
        playsinline: "1",
        vq: "hd1080",
        showinfo: "0",
        iv_load_policy: "3",
        fs: "0",
        disablekb: "1",
    });
    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
}

function buildYouTubeThumbnailUrl(videoId: string) {
    return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

function getVimeoId(input: string): string | null {
    if (!input) return null;
    if (/^\d+$/.test(input)) {
        return input;
    }

    try {
        const url = new URL(input);
        if (url.hostname.endsWith("vimeo.com")) {
            const match = url.pathname.match(/(?:video\/)?(\d+)/);
            if (match?.[1]) {
                return match[1];
            }
        }
    } catch {
        // Fall through to regex parsing.
    }

    const match = input.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    return match ? match[1] : null;
}

function buildVimeoEmbedUrl(videoId: string) {
    const params = new URLSearchParams({
        autoplay: "1",
        muted: "1",
        loop: "1",
        autopause: "0",
        background: "1",
        controls: "0",
        title: "0",
        byline: "0",
        portrait: "0",
        badge: "0",
        dnt: "1",
        playsinline: "1",
        api: "1",
    });
    return `https://player.vimeo.com/video/${videoId}?${params.toString()}`;
}

export function getEmbedPoster(src: string): string | undefined {
    const youtubeId = getYouTubeId(src);
    if (youtubeId) {
        return buildYouTubeThumbnailUrl(youtubeId);
    }

    return undefined;
}

export function getEmbedProvider(src: string): "youtube" | "vimeo" | null {
    if (getYouTubeId(src)) {
        return "youtube";
    }
    if (getVimeoId(src)) {
        return "vimeo";
    }
    return null;
}

function resolveHeroOverride(hero: ProjectHero): ProjectHero {
    if (hero.type !== "youtube" && hero.type !== "vimeo") {
        return hero;
    }

    if (hero.type === "youtube") {
        const videoId = getYouTubeId(hero.url);
        if (!videoId) {
            return hero;
        }

        return {
            ...hero,
            embedUrl: hero.embedUrl ?? buildYouTubeEmbedUrl(videoId),
            thumbnailUrl: hero.thumbnailUrl ?? buildYouTubeThumbnailUrl(videoId),
        };
    }

    const videoId = getVimeoId(hero.url);
    if (!videoId) {
        return hero;
    }

    return {
        ...hero,
        embedUrl: hero.embedUrl ?? buildVimeoEmbedUrl(videoId),
    };
}

const heroOverrides: Record<string, ProjectHero> = {};

ProjectsData.forEach((project) => {
    if (project.hero) {
        heroOverrides[project.slug] = resolveHeroOverride(project.hero);
    }
});

// --- Populate image lookups (unchanged — still Vite-bundled) ---

for (const [path, module] of Object.entries(imageModules)) {
    const match = path.match(/projects\/([^/]+)\/images\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    imagesBySlug[slug] ??= [];
    imageLookupBySlug[slug] ??= {};
    imagesBySlug[slug].push(module.default);
    if (fileName) {
        imageLookupBySlug[slug][fileName] = module.default;
    }
}

// --- Populate local video fallback lookups ---

for (const [path, module] of Object.entries(localVideoModules)) {
    const match = path.match(/projects\/([^/]+)\/videos\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    localVideosBySlug[slug] ??= [];
    localVideoLookupBySlug[slug] ??= {};
    localVideosBySlug[slug].push(module.default);
    if (fileName) {
        localVideoLookupBySlug[slug][fileName] = module.default;
    }
}

// --- Populate local cover fallback lookups ---

for (const [path, module] of Object.entries(localCoverModules)) {
    const match = path.match(/projects\/([^/]+)\/cover\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    localCoverLookupBySlug[slug] ??= {};
    if (fileName) {
        localCoverLookupBySlug[slug][fileName] = module.default;
    }
    if (!localCoverBySlug[slug]) {
        localCoverBySlug[slug] = module.default;
    }
}

// --- Populate merged hero lookup (R2 takes priority, local fallback) ---

// For local covers, we need to track their original paths so we can infer the type.
const localCoverPathBySlug: Record<string, string> = {};

for (const [path] of Object.entries(localCoverModules)) {
    const match = path.match(/projects\/([^/]+)\/cover\//);
    if (!match) continue;
    const slug = match[1];
    if (!localCoverPathBySlug[slug]) {
        localCoverPathBySlug[slug] = path;
    }
}

const allSlugs = new Set([
    ...Object.keys(r2.coverBySlug),
    ...Object.keys(localCoverBySlug),
]);

for (const slug of allSlugs) {
    if (r2.coverBySlug[slug]) {
        // R2 covers are always video (we only upload videos to R2)
        heroBySlug[slug] = { url: r2.coverBySlug[slug], type: "video" };
    } else if (localCoverBySlug[slug]) {
        const coverPath = localCoverPathBySlug[slug] ?? "";
        heroBySlug[slug] = { url: localCoverBySlug[slug], type: inferAssetType(coverPath) };
    }
}

// --- PDF lookups ---

for (const [path, module] of Object.entries(pdfModules)) {
    const match = path.match(/projects\/([^/]+)\/pdf\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    pdfLookupBySlug[slug] ??= {};
    if (fileName) {
        pdfLookupBySlug[slug][fileName] = module.default;
    }
    if (!pdfBySlug[slug]) {
        pdfBySlug[slug] = module.default;
    }
}

// --- Poster lookups ---

for (const [path, module] of Object.entries(posterModules)) {
    const match = path.match(/projects\/([^/]+)\/poster\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    posterLookupBySlug[slug] ??= {};
    if (fileName) {
        posterLookupBySlug[slug][fileName] = module.default;
    }
    if (!posterBySlug[slug]) {
        posterBySlug[slug] = module.default;
    }
}

Object.values(imagesBySlug).forEach((images) => images.sort());

// --- Merged accessors (R2 first, local fallback) ---

function getVideosBySlug(slug: string): string[] {
    return r2.videosBySlug[slug] ?? localVideosBySlug[slug] ?? [];
}

function getVideoLookup(slug: string): Record<string, string> {
    return { ...localVideoLookupBySlug[slug], ...r2.videoLookupBySlug[slug] };
}

function getCoverLookup(slug: string): Record<string, string> {
    return { ...localCoverLookupBySlug[slug], ...r2.coverLookupBySlug[slug] };
}

export function getProjectAssets(slug: string) {
    return {
        images: imagesBySlug[slug] ?? [],
        videos: getVideosBySlug(slug),
        pdf: pdfBySlug[slug],
        poster: posterBySlug[slug],
    };
}

export function getProjectHero(slug: string): ProjectHero | undefined {
    if (heroOverrides[slug]) {
        return heroOverrides[slug];
    }
    if (heroBySlug[slug]) {
        return heroBySlug[slug];
    }
    const videos = getVideosBySlug(slug);
    if (videos.length > 0) {
        return { url: videos[0], type: "video" };
    }
    if ((imagesBySlug[slug] ?? []).length > 0) {
        return { url: imagesBySlug[slug][0], type: "image" };
    }
    return undefined;
}

export function resolveProjectMedia(slug: string, relativePath?: string) {
    if (!relativePath) return undefined;
    const normalized = relativePath.replace(/^\.?\//, "");

    if (normalized.startsWith("images/")) {
        const key = normalized.slice("images/".length);
        return imageLookupBySlug[slug]?.[key];
    }

    if (normalized.startsWith("videos/")) {
        const key = normalized.slice("videos/".length);
        return getVideoLookup(slug)[key];
    }

    if (normalized.startsWith("cover/")) {
        const key = normalized.slice("cover/".length);
        return getCoverLookup(slug)[key];
    }

    if (normalized.startsWith("pdf/")) {
        const key = normalized.slice("pdf/".length);
        return pdfLookupBySlug[slug]?.[key];
    }

    if (normalized.startsWith("poster/")) {
        const key = normalized.slice("poster/".length);
        return posterLookupBySlug[slug]?.[key];
    }

    return undefined;
}
