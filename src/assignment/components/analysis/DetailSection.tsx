import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/assignment/components/ui/collapsible";
import { cn } from "@/assignment/lib/utils";

export interface DetailSectionProps {
    /** The name the panel's accordion knows it by (one section is open at a time). */
    id: string;
    title: string;
    /** What the closed section says on its right: "2 of 5 pass", "Peak 132%". */
    summary?: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Cannot be opened (while the stabilizer runs, the numbers are about to change); the summary says why. */
    disabled?: boolean;
    testId?: string;
    children: ReactNode;
}

/**
 * One item of the panel's details: a quiet 13 px title, a summary on the right while closed, a chevron. Items are controlled
 * by the panel, so opening one closes the other. An opened item is brought into view, because it opens at the foot of a scrolling
 * panel.
 */
export function DetailSection({ id, title, summary, open, onOpenChange, disabled = false, testId, children }: DetailSectionProps) {
    const ref = useRef<HTMLDivElement>(null);
    const wasOpen = useRef(open);

    useEffect(() => {
        if (open && !wasOpen.current) {
            const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            // After the content has been laid out.
            const frame = requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" }));
            wasOpen.current = open;
            return () => cancelAnimationFrame(frame);
        }
        wasOpen.current = open;
    }, [open]);

    return (
        <Collapsible
            ref={ref}
            open={open && !disabled}
            onOpenChange={(next) => !disabled && onOpenChange(next)}
            className="border-t border-border/60"
            data-testid={testId}
            data-detail={id}
        >
            <CollapsibleTrigger
                disabled={disabled}
                className={cn(
                    "group flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left transition-colors md:min-h-10",
                    "hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
                )}
            >
                <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
                    aria-hidden
                />
                <span className="text-[13px] font-medium text-foreground">{title}</span>
                {summary !== undefined && summary !== null && (
                    <span className="ml-auto truncate pl-2 text-xs tabular-nums text-muted-foreground">{summary}</span>
                )}
            </CollapsibleTrigger>
            <CollapsibleContent className="px-4 pb-4 pt-1">{children}</CollapsibleContent>
        </Collapsible>
    );
}
