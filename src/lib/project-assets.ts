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

const coverModules = import.meta.glob<AssetModule>("@/assets/projects/*/cover/*", {
    eager: true,
});

const videoExtensions = ["mp4", "webm", "ogg", "mov", "m4v"];

const imagesBySlug: Record<string, string[]> = {};
const videosBySlug: Record<string, string[]> = {};
const pdfBySlug: Record<string, string> = {};
const imageLookupBySlug: Record<string, Record<string, string>> = {};
const videoLookupBySlug: Record<string, Record<string, string>> = {};
const coverLookupBySlug: Record<string, Record<string, string>> = {};
const heroBySlug: Record<string, { url: string; type: "image" | "video" }> = {};

function inferAssetType(path: string): "image" | "video" {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return videoExtensions.includes(ext) ? "video" : "image";
}

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

for (const [path, module] of Object.entries(coverModules)) {
    const match = path.match(/projects\/([^/]+)\/cover\//);
    if (!match) continue;
    const slug = match[1];
    coverLookupBySlug[slug] ??= {};
    const fileName = path.split("/").pop() ?? "";
    if (fileName) {
        coverLookupBySlug[slug][fileName] = module.default;
    }
    if (!heroBySlug[slug]) {
        heroBySlug[slug] = { url: module.default, type: inferAssetType(path) };
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

export function getProjectHero(slug: string) {
    if (heroBySlug[slug]) {
        return heroBySlug[slug];
    }
    if ((videosBySlug[slug] ?? []).length > 0) {
        return { url: videosBySlug[slug][0], type: "video" };
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
        return videoLookupBySlug[slug]?.[key];
    }

    if (normalized.startsWith("cover/")) {
        const key = normalized.slice("cover/".length);
        return coverLookupBySlug[slug]?.[key];
    }

    return undefined;
}
