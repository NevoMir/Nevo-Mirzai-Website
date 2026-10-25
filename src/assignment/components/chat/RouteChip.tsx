import { ChevronDown, Sparkles } from "lucide-react";

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { ROUTE_HINTS, ROUTE_WORDS } from "@/assignment/components/chat/composerLogic";
import type { EditTarget } from "@/assignment/shared/contract";

/**
 * In Edit mode this stands where the model picker stands: who does the change and what it works on ("✦ Muse · changes the blocks"). It has
 * nothing to choose, so it is a label. A change to a mesh has a second way, asking Hunyuan for a new model with the change in its prompt;
 * the chip is a menu with both, the second one only where Hunyuan can be used (`onRegenerate`).
 */
export function RouteChip({ target, onRegenerate }: { target: EditTarget; onRegenerate?: (() => void) | null }) {
    const words = ROUTE_WORDS[target];
    const look = "flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground";
    if (target !== "mesh" || !onRegenerate) {
        return (
            <div data-testid="route-chip" data-target={target} title={ROUTE_HINTS[target]} className={look}>
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="truncate">{words}</span>
            </div>
        );
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    data-testid="route-chip"
                    data-target={target}
                    aria-label={`${words}. Other ways to make this change`}
                    title={ROUTE_HINTS[target]}
                    className={`${look} transition-colors hover:bg-muted hover:text-foreground`}
                >
                    <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{words}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-[19rem]">
                <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">How to make the change</DropdownMenuLabel>
                <DropdownMenuItem className="items-start gap-2 py-2 text-xs" data-testid="route-muse">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                        Muse · adjusts the model
                        <span className="block text-[11px] text-muted-foreground">About 30 seconds. Free of Hunyuan credits.</span>
                    </span>
                </DropdownMenuItem>
                <DropdownMenuItem className="items-start gap-2 py-2 text-xs" data-testid="route-regenerate" onSelect={() => onRegenerate()}>
                    <span className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                        Hunyuan · generate again with the change
                        <span className="block text-[11px] text-muted-foreground">About 4 minutes. Uses 25 of your credits; the model will look different.</span>
                    </span>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
