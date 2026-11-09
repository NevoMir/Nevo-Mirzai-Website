import { useEffect } from "react";
import { FaLock } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-pagetitle";

// For unlisted routes: forwards to a private claude.ai page that only its owner can open.
// Access is enforced by the claude.ai login, not by the route being hidden.
export function PrivateRedirect({ url }: { url: string }) {
    usePageTitle("Private");

    useEffect(() => {
        const robots = document.createElement("meta");
        robots.name = "robots";
        robots.content = "noindex, nofollow";
        document.head.appendChild(robots);
        window.location.replace(url);
        return () => {
            robots.remove();
        };
    }, [url]);

    return (
        <div className="flex flex-col items-center justify-center h-full space-y-4 text-center">
            <FaLock className="w-8 h-8 text-muted-foreground" />
            <p className="text-base sm:text-lg text-muted-foreground">Opening a private page…</p>
            <Button asChild variant="outline">
                <a href={url} rel="noopener noreferrer">
                    Continue
                </a>
            </Button>
        </div>
    );
}
