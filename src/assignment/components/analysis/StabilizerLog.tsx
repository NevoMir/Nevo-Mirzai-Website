import { useMemo } from "react";

import type { AnalysisResult } from "@/assignment/analysis/types";
import { ROLE_WORDS } from "@/assignment/components/analysis/vocabulary";
import type { StabilizerLogData } from "@/assignment/components/analysis/useStabilizerLog";
import { StabilizeTimeline } from "@/assignment/components/analysis/StabilizeTimeline";
import { TONE } from "@/assignment/components/analysis/style";
import { cn } from "@/assignment/lib/utils";
import { ROLE_HEX } from "@/assignment/shared/assembly";
import { BLOCK_ROLES, type AddedRole } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { fmtPct } from "@/assignment/store/analysisLogic";
import { useStabilizeStore } from "@/assignment/store/stabilize";
import { savedStepOffset, stepOffsetOf } from "@/assignment/store/stabilizeLogic";


const ADDED: readonly AddedRole[] = BLOCK_ROLES.filter((r): r is AddedRole => r !== "original");

/** One before -> after line of the summary. */
function Row({ label, before, after, better }: { label: string; before: string; after: string; better: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono tabular-nums text-foreground">
                {before} <span aria-hidden>→</span>
                <span className="sr-only"> to </span> <span className={better ? TONE.pass.text : undefined}>{after}</span>
            </dd>
        </div>
    );
}

/**
 * "What the stabilizer did": the figures before and after, the blocks it added by what they are for, and its steps one by one, each
 * a button that lights up the blocks it added and flies the camera there. (Why a run stopped, the solver and the aim are on the
 * "How is this computed?" page.)
 */
export function StabilizerLog({ log, result }: { log: StabilizerLogData; result: AnalysisResult }) {
    const stepSelection = useAnalysisStore((s) => s.stepSelection);
    const selectStepBlocks = useAnalysisStore((s) => s.selectStepBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const selectRunStep = useStabilizeStore((s) => s.selectStep);
    const { meta, steps } = log;
    // A saved log counts from the steps the version already had; a run's from the steps of the model it started from.
    const offset = log.source === "saved" ? savedStepOffset(result, steps.length) : stepOffsetOf(result);
    const selected = stepSelection === null ? null : stepSelection - offset;
    const roles = useMemo(() => (meta ? ADDED.filter((r) => (meta.added_by_role[r] ?? 0) > 0) : []), [meta]);
    const select = (n: number | null) => {
        if (log.source === "run") {
            selectRunStep(n);
            return;
        }
        const step = n === null ? undefined : steps.find((x) => x.n === n);
        if (!step || stepSelection === offset + step.n) {
            clearSelection();
            return;
        }
        selectStepBlocks(offset + step.n, { atMm: step.at_mm, label: `Step ${step.n}: ${step.move}` });
    };

    return (
        <div data-testid="analysis-stabilization-body">
            {meta && (
                <dl className="space-y-1">
                    <Row
                        label="Problems"
                        before={String(meta.before.errors + meta.before.warnings)}
                        after={String(meta.after.errors + meta.after.warnings)}
                        better={meta.after.errors + meta.after.warnings < meta.before.errors + meta.before.warnings}
                    />
                    <Row label="Floating blocks" before={String(meta.before.floating_blocks)} after={String(meta.after.floating_blocks)} better={meta.after.floating_blocks < meta.before.floating_blocks} />
                    <Row
                        label="Longest overhang"
                        before={String(meta.before.longest_cantilever)}
                        after={String(meta.after.longest_cantilever)}
                        better={meta.after.longest_cantilever < meta.before.longest_cantilever}
                    />
                    <Row
                        label="Strength used"
                        before={meta.before.max_utilisation === null ? "n/a" : fmtPct(meta.before.max_utilisation)}
                        after={meta.after.max_utilisation === null ? "n/a" : fmtPct(meta.after.max_utilisation)}
                        better={meta.before.max_utilisation !== null && meta.after.max_utilisation !== null && meta.after.max_utilisation < meta.before.max_utilisation}
                    />
                </dl>
            )}

            {roles.length > 0 && meta && (
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Blocks added, by what they are for">
                    {roles.map((role) => (
                        <li key={role} className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2 py-0.5 text-[11px]">
                            <span aria-hidden className="h-2 w-2 rounded-[2px] ring-1 ring-black/15 dark:ring-white/20" style={{ background: ROLE_HEX[role] }} />
                            <span className="text-foreground">{ROLE_WORDS[role]}</span>
                            <span className="font-mono tabular-nums text-muted-foreground">{meta.added_by_role[role]}</span>
                        </li>
                    ))}
                </ul>
            )}

            {steps.length > 0 && (
                <div className={cn(meta && "mt-3")}>
                    <p className="mb-1.5 text-xs font-medium text-foreground">Steps</p>
                    <StabilizeTimeline steps={steps} running={false} selected={selected} onSelect={select} />
                </div>
            )}
        </div>
    );
}
