import { Boxes } from "lucide-react";

import { ElapsedTime } from "@/assignment/components/chat/ElapsedTime";
import { GenerationProgressBar } from "@/assignment/components/workspace/GenerationProgressBar";
import { useShownProgress } from "@/assignment/components/workspace/useShownProgress";
import { epochOf } from "@/assignment/components/workspace/format";
import type { Job, ProviderInfo } from "@/assignment/shared/contract";
import { providerInfo, providerLabel } from "@/assignment/store/providers";

/**
 * The card in the middle of the viewer while the project's first model is being made and there is
 * nothing to look at yet: what the model is doing, how far along, how long it has run. With several
 * models racing it follows the first and says how many are running.
 */
export function GenerationOverlay({ jobs, providers }: { jobs: readonly Job[]; providers: readonly ProviderInfo[] | undefined }) {
    const lead = jobs[0];
    const info = providerInfo(providers, lead.provider);
    const startedAt = epochOf(lead.created_at);
    const shown = useShownProgress({
        active: true,
        value: lead.progress,
        startedAt,
        estimateSeconds: info?.approx_seconds,
    });

    return (
        <div
            role="status"
            aria-live="polite"
            data-testid="generation-overlay"
            className="w-72 max-w-full rounded-2xl border border-border/70 bg-sidebar/95 px-5 py-4 text-center shadow-xl backdrop-blur"
        >
            <Boxes className="mx-auto mb-2 h-6 w-6 text-accent" strokeWidth={1.5} aria-hidden />
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {providerLabel(providers, lead.provider)}
            </p>
            <p className="mt-1 text-[15px] font-medium text-shimmer">{lead.stage || "Queued"}</p>
            <GenerationProgressBar active value={shown} className="mx-auto mt-3 w-full" />
            <div className="mt-2 flex items-center justify-between font-mono text-[11px] tabular-nums text-muted-foreground">
                <span>{Math.round(shown)}%</span>
                {startedAt !== undefined && <ElapsedTime startedAt={startedAt} />}
            </div>
            {jobs.length > 1 && (
                <p className="mt-2 text-[11px] text-muted-foreground">{jobs.length} models generating</p>
            )}
        </div>
    );
}
