import { useId, type KeyboardEvent } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import { Textarea } from "@/assignment/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { cn } from "@/assignment/lib/utils";
import { CHIPS, GOAL_EXAMPLE, GOAL_MAX } from "@/assignment/store/optimizeLogic";
import type { PresetKind } from "@/assignment/shared/optimizeSpec";

export interface GoalFieldProps {
    text: string;
    onText: (text: string) => void;
    /** Read the words with Muse Spark (about 10 s). */
    onPlan: () => void;
    /** A button: fill the controls at once, no network. */
    onChip: (chip: PresetKind) => void;
    /** Muse cannot be asked (the server has no key); the buttons still work. */
    museOff: boolean;
    /** The facts of the version are being prepared: the buttons wait a moment. */
    busy: boolean;
    /** Asking Muse failed: what happened, and that the buttons still work. */
    notice: string | null;
}

/**
 * "What should it do?": the goal in words (read by Muse Spark when the sparkle is pressed) and four buttons that need no model. A button fills the
 * controls at once; the words take about ten seconds.
 */
export function GoalField({ text, onText, onPlan, onChip, museOff, busy, notice }: GoalFieldProps) {
    const id = useId();
    const empty = text.trim() === "";
    const submit = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter sends the words; Shift+Enter is a new line.
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!empty && !museOff && !busy) onPlan();
        }
    };
    return (
        <div className="px-4 pb-3" data-testid="optimize-goal">
            <label htmlFor={id} className="text-xs font-medium text-foreground">
                What should it do?
            </label>
            <div className="relative mt-1.5">
                <Textarea
                    id={id}
                    rows={2}
                    maxLength={GOAL_MAX}
                    value={text}
                    onChange={(event) => onText(event.target.value)}
                    onKeyDown={submit}
                    placeholder={`e.g. “${GOAL_EXAMPLE}”`}
                    aria-describedby={`${id}-help`}
                    className="min-h-[3.5rem] resize-none py-2 pr-11 text-base leading-snug md:text-sm"
                    data-testid="optimize-goal-input"
                />
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={onPlan}
                            disabled={empty || museOff || busy}
                            aria-label="Plan with Muse (about 10 seconds)"
                            data-testid="optimize-plan"
                            className="absolute bottom-1.5 right-1.5 grid h-9 w-9 place-items-center rounded-full text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent md:h-8 md:w-8"
                        >
                            <Sparkles className="h-4 w-4" aria-hidden />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56 text-xs">
                        {museOff ? "Muse is not set up on this server. The four buttons below still work." : "Muse reads your words and fills in the limits for you to check. About 10 seconds."}
                    </TooltipContent>
                </Tooltip>
            </div>
            <p id={`${id}-help`} className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {museOff ? "Pick one of the four goals." : "Press the sparkle (or Enter) to have Muse read it, or pick one of the four goals."}
            </p>
            {notice && (
                <div role="status" className="mt-2 flex items-start gap-2 rounded-lg border border-warning/45 bg-warning/10 p-2.5 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-notice">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>{notice}</span>
                </div>
            )}
            <ul className="mt-2.5 grid grid-cols-2 gap-1.5" aria-label="Goals that need no waiting" data-testid="optimize-chips">
                {CHIPS.map((chip) => (
                    <li key={chip.id}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    onClick={() => onChip(chip.id)}
                                    disabled={busy}
                                    data-testid={`optimize-chip-${chip.id}`}
                                    className={cn(
                                        "flex min-h-11 w-full flex-col items-start justify-center rounded-xl border border-border/70 bg-card px-2.5 py-1.5 text-left transition-colors md:min-h-0",
                                        "hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
                                    )}
                                >
                                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
                                        {chip.label}
                                        {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />}
                                    </span>
                                    <span className="text-[11px] leading-tight text-muted-foreground">{chip.hint}</span>
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-56 text-xs">
                                {chip.tip}
                            </TooltipContent>
                        </Tooltip>
                    </li>
                ))}
            </ul>
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">Thin models have little hidden inside; you can allow thinning in the limits.</p>
        </div>
    );
}
