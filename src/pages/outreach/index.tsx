import { useEffect } from "react";
import { FaLock } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-pagetitle";

// Unlisted route: forwards to a private claude.ai page that only its owner can open.
// Access is enforced by the claude.ai login, not by this route being hidden.
const PRIVATE_PAGE_URL = "https://claude.ai/artifact/676BwCFYJjUDCdZrABRVoq";

export default function Outreach() {
    usePageTitle("Private");

    useEffect(() => {
        const robots = document.createElement("meta");
        robots.name = "robots";
        robots.content = "noindex, nofollow";
        document.head.appendChild(robots);
        window.location.replace(PRIVATE_PAGE_URL);
        return () => {
            robots.remove();
        };
    }, []);

    return (
        <div className="flex flex-col items-center justify-center h-full space-y-4 text-center">
            <FaLock className="w-8 h-8 text-muted-foreground" />
            <p className="text-base sm:text-lg text-muted-foreground">Opening a private page…</p>
            <Button asChild variant="outline">
                <a href={PRIVATE_PAGE_URL} rel="noopener noreferrer">
                    Continue
                </a>
            </Button>
        </div>
    );
}
