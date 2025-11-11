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

const slideModules = import.meta.glob<AssetModule>("@/assets/projects/*/slides/*", {
    eager: true,
});

const imagesBySlug: Record<string, string[]> = {};
const videosBySlug: Record<string, string[]> = {};
const pdfBySlug: Record<string, string> = {};
const slidesBySlug: Record<string, string> = {};

for (const [path, module] of Object.entries(imageModules)) {
    const match = path.match(/projects\/([^/]+)\/images\//);
    if (!match) continue;
    const slug = match[1];
    imagesBySlug[slug] ??= [];
    imagesBySlug[slug].push(module.default);
}

for (const [path, module] of Object.entries(videoModules)) {
    const match = path.match(/projects\/([^/]+)\/videos\//);
    if (!match) continue;
    const slug = match[1];
    videosBySlug[slug] ??= [];
    videosBySlug[slug].push(module.default);
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

for (const [path, module] of Object.entries(slideModules)) {
    const match = path.match(/projects\/([^/]+)\/slides\//);
    if (!match) continue;
    const slug = match[1];
    if (!slidesBySlug[slug]) {
        slidesBySlug[slug] = module.default;
    }
}

Object.values(imagesBySlug).forEach((images) => images.sort());
Object.values(videosBySlug).forEach((videos) => videos.sort());

export function getProjectAssets(slug: string) {
    return {
        images: imagesBySlug[slug] ?? [],
        videos: videosBySlug[slug] ?? [],
        pdf: pdfBySlug[slug],
        slides: slidesBySlug[slug],
    };
}

export function getProjectCover(slug: string) {
    const images = imagesBySlug[slug];
    return images && images.length > 0 ? images[0] : undefined;
}
