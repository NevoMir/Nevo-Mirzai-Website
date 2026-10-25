import { TONE, VERDICT_ICON, VERDICT_TONE } from "@/assignment/components/analysis/style";
import { cn } from "@/assignment/lib/utils";
import type { Verdict } from "@/assignment/store/analysisLogic";

/** The verdict as a small chip: an icon and the words, so it does not rely on colour alone. */
export function VerdictChip({ verdict, className }: { verdict: Verdict; className?: string }) {
    const tone = TONE[VERDICT_TONE[verdict.kind]];
    const Icon = VERDICT_ICON[verdict.kind];
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4",
                tone.soft,
                tone.border,
                tone.text,
                className,
            )}
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {verdict.short}
            {verdict.custom && <span className="h-1 w-1 shrink-0 rounded-full bg-current opacity-70" aria-hidden />}
        </span>
    );
}
