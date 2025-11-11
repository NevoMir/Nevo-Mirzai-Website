type AssetModule = { default: string };

const imageModules = import.meta.glob<AssetModule>("@/assets/projects/*/images/*", {
    eager: true,
});

const videoModules = import.meta.glob<AssetModule>("@/assets/projects/*/videos/*", {
    eager: true,
});

const pdfModules = import.meta.glob<AssetModule>("@/assets/projects/*/pdf/*", {
    eager: true,
});

const imagesBySlug: Record<string, string[]> = {};
const videosBySlug: Record<string, string[]> = {};
const pdfBySlug: Record<string, string> = {};
const imageLookupBySlug: Record<string, Record<string, string>> = {};
const videoLookupBySlug: Record<string, Record<string, string>> = {};

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

for (const [path, module] of Object.entries(videoModules)) {
    const match = path.match(/projects\/([^/]+)\/videos\//);
    if (!match) continue;
    const slug = match[1];
    const fileName = path.split("/").pop() ?? "";
    videosBySlug[slug] ??= [];
    videoLookupBySlug[slug] ??= {};
    videosBySlug[slug].push(module.default);
    if (fileName) {
        videoLookupBySlug[slug][fileName] = module.default;
    }
}

for (const [path, module] of Object.entries(pdfModules)) {
    const match = path.match(/projects\/([^/]+)\/pdf\//);
    if (!match) continue;
    const slug = match[1];
    // If multiple PDFs exist, keep the first one discovered alphabetically.
    if (!pdfBySlug[slug]) {
        pdfBySlug[slug] = module.default;
    }
}

Object.values(imagesBySlug).forEach((images) => images.sort());
Object.values(videosBySlug).forEach((videos) => videos.sort());

export function getProjectAssets(slug: string) {
    return {
        images: imagesBySlug[slug] ?? [],
        videos: videosBySlug[slug] ?? [],
        pdf: pdfBySlug[slug],
    };
}

export function getProjectCover(slug: string) {
    const images = imagesBySlug[slug];
    return images && images.length > 0 ? images[0] : undefined;
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
        return videoLookupBySlug[slug]?.[key];
    }

    return undefined;
}
