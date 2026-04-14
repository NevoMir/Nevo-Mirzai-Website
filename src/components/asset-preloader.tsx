import { useEffect, useMemo } from "react";
import { ProjectsData } from "@/data/projects";
import { UserInfo } from "@/data/profile";
import { EduData } from "@/data/education";
import { WorkData } from "@/data/work";
import { getProjectAssets, getProjectHero } from "@/lib/project-assets";
import { parseTimelineToTimestamp } from "@/lib/utils";

// Slugs of projects featured on the About Me page
const ABOUT_ME_PROJECT_SLUGS = [
    "rl-quadruped-training",
    "hand-gesture-drone-swarms",
    "soft-arm-sim-to-real",
    "aerial-am",
    "eye-tracker-headlamp",
    "autonomous-drone-racing",
];

const VIMEO_WARMUP_LIMIT = 3;

export function AssetPreloader() {
    const sortedProjects = useMemo(() => {
        return [...ProjectsData].sort((a, b) => {
            const aTime = parseTimelineToTimestamp(a.timeline) ?? -Infinity;
            const bTime = parseTimelineToTimestamp(b.timeline) ?? -Infinity;
            return bTime - aTime;
        });
    }, []);

    const vimeoWarmupUrls = useMemo(() => {
        const urls: string[] = [];
        const addHero = (slug: string) => {
            const hero = getProjectHero(slug);
            if (hero?.type === "vimeo" && hero.embedUrl) {
                urls.push(hero.embedUrl);
            }
        };

        ABOUT_ME_PROJECT_SLUGS.forEach(addHero);
        sortedProjects.forEach((project) => addHero(project.slug));

        return Array.from(new Set(urls)).slice(0, VIMEO_WARMUP_LIMIT);
    }, [sortedProjects]);

    useEffect(() => {
        const preloadImage = (src: string) => {
            const img = new Image();
            img.src = src;
        };

        const preloadQueue: string[] = [];
        const addedAssets = new Set<string>();

        const addToQueue = (src?: string) => {
            if (src && !addedAssets.has(src)) {
                preloadQueue.push(src);
                addedAssets.add(src);
            }
        };

        // --- Priority 1: About Me Page Assets ---

        // 1.1 Profile Image
        addToQueue(UserInfo.profile_url);

        // 1.2 Education & Work Logos
        EduData.forEach((edu) => addToQueue(edu.logo));
        WorkData.forEach((work) => addToQueue(work.logo));

        // 1.3 Featured Projects on About Me Page
        // We want to preload the Hero asset AND the detail assets for these specific projects first.
        // Skip video-type heroes — <video> elements handle their own loading.
        // Preloading mp4 URLs via Image() creates wasted/competing HTTP requests.
        ABOUT_ME_PROJECT_SLUGS.forEach((slug) => {
            // Hero (images & thumbnails only)
            const hero = getProjectHero(slug);
            if (hero) {
                if (hero.type === "youtube" || hero.type === "vimeo") {
                    addToQueue(hero.thumbnailUrl);
                } else if (hero.type === "image") {
                    addToQueue(hero.url);
                }
            }

            // Details
            const assets = getProjectAssets(slug);
            if (assets.images) assets.images.forEach(addToQueue);
            if (assets.poster) addToQueue(assets.poster);
        });

        // --- Priority 2: Remaining Projects (Sorted by Recency) ---

        sortedProjects.forEach((project) => {
            // Hero (images & thumbnails only — skip video heroes)
            const hero = getProjectHero(project.slug);
            if (hero) {
                if (hero.type === "youtube" || hero.type === "vimeo") {
                    addToQueue(hero.thumbnailUrl);
                } else if (hero.type === "image") {
                    addToQueue(hero.url);
                }
            }

            // Details
            const assets = getProjectAssets(project.slug);
            if (assets.images) assets.images.forEach(addToQueue);
            if (assets.poster) addToQueue(assets.poster);
        });

        // --- Queue Processing ---

        const processQueue = () => {
            if (preloadQueue.length === 0) return;

            // Process a batch
            const batchSize = 3;
            const batch = preloadQueue.splice(0, batchSize);

            batch.forEach((src) => {
                preloadImage(src);
            });

            // Schedule next batch
            if (preloadQueue.length > 0) {
                if ("requestIdleCallback" in window) {
                    window.requestIdleCallback(() => processQueue(), { timeout: 1000 });
                } else {
                    setTimeout(processQueue, 200);
                }
            }
        };

        // Start processing after a short delay to allow initial render
        const timeoutId = setTimeout(() => {
            if ("requestIdleCallback" in window) {
                window.requestIdleCallback(() => processQueue(), { timeout: 1000 });
            } else {
                processQueue();
            }
        }, 2000);

        return () => clearTimeout(timeoutId);
    }, [sortedProjects]);

    if (vimeoWarmupUrls.length === 0) {
        return null;
    }

    return (
        <div
            aria-hidden="true"
            className="pointer-events-none"
            style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
        >
            {vimeoWarmupUrls.map((url) => (
                <iframe
                    key={url}
                    src={url}
                    title="Vimeo warmup"
                    loading="eager"
                    tabIndex={-1}
                    aria-hidden="true"
                    allow="autoplay; fullscreen; picture-in-picture"
                    referrerPolicy="strict-origin-when-cross-origin"
                    style={{
                        width: 1,
                        height: 1,
                        border: 0,
                        opacity: 0,
                        position: "absolute",
                        inset: 0,
                    }}
                />
            ))}
        </div>
    );
}
