import type { ReactNode } from "react";
import { Info, X } from "lucide-react";

import { TONE, type Tone } from "@/assignment/components/analysis/style";
import { useFocusOnEnd } from "@/assignment/components/analysis/useFocusOnEnd";
import { cn } from "@/assignment/lib/utils";

/** A boxed message of the panel in a tone: a title, a few words under it, and the buttons that answer it. */
export function StatusStrip({
    tone,
    icon: Icon,
    title,
    children,
    actions,
    onDismiss,
    testId,
    spin = false,
    endedAt = null,
}: {
    tone: Tone;
    icon: typeof Info;
    title: string;
    children?: ReactNode;
    actions?: ReactNode;
    onDismiss?: () => void;
    testId: string;
    spin?: boolean;
    /** When what it reports ended: a strip that appears right after takes the keyboard focus, so the person lands on it. */
    endedAt?: number | null;
}) {
    const t = TONE[tone];
    const ref = useFocusOnEnd<HTMLDivElement>(endedAt);
    return (
        <div ref={ref} tabIndex={-1} className={cn("rounded-xl border p-3 focus:outline-none", t.soft, t.border)} data-testid={testId} role="status">
            <div className="flex items-start gap-2.5">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", t.icon, spin && "animate-spin motion-reduce:animate-none")} aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className={cn("text-[13px] font-semibold leading-snug", t.text)}>{title}</p>
                    {children && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">{children}</div>}
                </div>
                {onDismiss && (
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="-m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:-m-0.5 md:h-6 md:w-6"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                )}
            </div>
            {actions && <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>}
        </div>
    );
}
