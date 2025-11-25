import { useEffect } from "react";
import { ProjectsData } from "@/data/projects";
import { getProjectAssets, getProjectHero } from "@/lib/project-assets";

export function AssetPreloader() {
    useEffect(() => {
        const preloadImage = (src: string) => {
            const img = new Image();
            img.src = src;
        };

        const preloadQueue: string[] = [];

        // 1. Collect all assets to preload
        ProjectsData.forEach((project) => {
            // Hero assets (highest priority for list view)
            const hero = getProjectHero(project.slug);
            if (hero) {
                preloadQueue.push(hero.url);
            }

            // Detail page assets
            const assets = getProjectAssets(project.slug);

            // Images
            if (assets.images) {
                assets.images.forEach((img) => preloadQueue.push(img));
            }

            // Video posters (we don't preload full videos, just posters if available or inferred)
            // Note: The current getProjectAssets doesn't explicitly give us posters for every video unless they are in the poster folder.
            // If we want to preload video content, we should be careful. 
            // For now, let's stick to explicit posters and images.
            if (assets.poster) {
                preloadQueue.push(assets.poster);
            }
        });

        // 2. Deduplicate
        const uniqueQueue = Array.from(new Set(preloadQueue));

        // 3. Process queue with low priority
        const processQueue = () => {
            if (uniqueQueue.length === 0) return;

            // Process a batch
            const batchSize = 3;
            const batch = uniqueQueue.splice(0, batchSize);

            batch.forEach((src) => {
                preloadImage(src);
            });

            // Schedule next batch
            if (uniqueQueue.length > 0) {
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

    return null; // This component renders nothing
}
