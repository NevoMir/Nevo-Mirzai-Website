import { useEffect } from "react";
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

export function AssetPreloader() {
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
        ABOUT_ME_PROJECT_SLUGS.forEach((slug) => {
            // Hero
            const hero = getProjectHero(slug);
            if (hero) addToQueue(hero.url);

            // Details
            const assets = getProjectAssets(slug);
            if (assets.images) assets.images.forEach(addToQueue);
            if (assets.poster) addToQueue(assets.poster);
        });

        // --- Priority 2: Remaining Projects (Sorted by Recency) ---

        // Sort projects by timeline (newest first)
        const sortedProjects = [...ProjectsData].sort((a, b) => {
            const aTime = parseTimelineToTimestamp(a.timeline) ?? -Infinity;
            const bTime = parseTimelineToTimestamp(b.timeline) ?? -Infinity;
            return bTime - aTime;
        });

        sortedProjects.forEach((project) => {
            // Skip if it was already processed in the About Me section (though Set handles dedupe, we can skip logic)
            // But we need to be careful because we might have only added hero or something. 
            // The Set ensures we don't double-load, so we can just iterate everything.

            // Hero
            const hero = getProjectHero(project.slug);
            if (hero) addToQueue(hero.url);

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
    }, []);

    return null;
}
