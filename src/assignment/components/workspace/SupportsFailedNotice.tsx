import { RotateCcw, TriangleAlert } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";

/**
 * On the 3D tab of a stabilized model: the added supports could not be loaded, so the stage shows the bare original mesh, which
 * would read as a stabilizer that added nothing. Said in the viewer's own overlay slot, with the way to try again (the Stability tab
 * has its own error card for the same failure).
 */
export function SupportsFailedNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
    const text = message.trim();
    return (
        <div
            role="alert"
            data-testid="supports-failed"
            className="flex max-w-sm items-start gap-2.5 rounded-2xl border border-border/70 bg-background/90 px-3 py-2.5 shadow-lg backdrop-blur"
        >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1 text-xs">
                <p className="font-medium text-foreground">The added supports could not be loaded</p>
                <p className="mt-0.5 leading-snug text-muted-foreground">{/[.!?]$/.test(text) ? text : `${text}.`} This is the original model without them.</p>
            </div>
            <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 px-2.5 text-xs" onClick={onRetry} data-testid="supports-retry">
                <RotateCcw />
                Try again
            </Button>
        </div>
    );
}
