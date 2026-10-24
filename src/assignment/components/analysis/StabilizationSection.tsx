import { useMemo } from "react";
import { CircleCheck, GitCompareArrows, TriangleAlert, Undo2, WandSparkles } from "lucide-react";

import { CountBadge, Section } from "@/assignment/components/analysis/atoms";
import { StabilizeTimeline } from "@/assignment/components/analysis/StabilizeTimeline";
import { TONE } from "@/assignment/components/analysis/style";
import type { AnalysisResult } from "@/assignment/analysis/types";
import { Button } from "@/assignment/components/ui/button";
import { cn } from "@/assignment/lib/utils";
import { ROLE_HEX } from "@/assignment/shared/assembly";
import { BLOCK_ROLES, type AddedRole, type DerivedMeta, type ModelAsset } from "@/assignment/shared/contract";
import { useAnalysisStore } from "@/assignment/store/analysis";
import { fmtPct, plural } from "@/assignment/store/analysisLogic";
import { savedStepOffset, stabilizedLine } from "@/assignment/store/stabilizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import { ROLE_PLURALS } from "@/assignment/viewer/analysisGeometry";

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
 * For a stabilized model: what the stabilizer did to the model it was made from, step by step. The log is the one stored
 * with the model (the file itself carries it), so it reads the same wherever the model is opened.
 */
export function StabilizationSection({ model, meta, result }: { model: ModelAsset; meta: DerivedMeta; result: AnalysisResult }) {
    const models = useWorkspaceStore((s) => s.models);
    const setActiveModel = useWorkspaceStore((s) => s.setActiveModel);
    const stepSelection = useAnalysisStore((s) => s.stepSelection);
    const selectStepBlocks = useAnalysisStore((s) => s.selectStepBlocks);
    const clearSelection = useAnalysisStore((s) => s.clearSelection);
    const setCompare = useAnalysisStore((s) => s.setCompare);

    const source = models.find((m) => m.id === model.source_model_id) ?? null;
    const offset = savedStepOffset(result, meta.steps.length);
    const selected = stepSelection === null ? null : stepSelection - offset;
    const tone = TONE[meta.complete ? "pass" : "warn"];
    const Glyph = meta.complete ? CircleCheck : TriangleAlert;
    const roles = useMemo(() => ADDED.filter((r) => (meta.added_by_role[r] ?? 0) > 0), [meta.added_by_role]);
    const select = (n: number | null) => {
        const step = n === null ? undefined : meta.steps.find((x) => x.n === n);
        if (!step || stepSelection === offset + step.n) {
            clearSelection();
            return;
        }
        selectStepBlocks(offset + step.n, { atMm: step.at_mm, label: `Step ${step.n}: ${step.move}` });
    };
    const { before, after } = meta;

    return (
        <Section
            title="Stabilization"
            icon={WandSparkles}
            testId="analysis-stabilization"
            badge={
                <CountBadge tone={meta.complete ? "pass" : "warn"} label={`${plural(meta.added_blocks, "block")} added`}>
                    +{meta.added_blocks}
                </CountBadge>
            }
        >
            <div className={cn("rounded-xl border px-3 py-2.5", tone.soft, tone.border)}>
                <p className={cn("flex items-start gap-2 text-xs font-semibold leading-snug", tone.text)}>
                    <Glyph className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {meta.complete ? "Stabilized" : "Improved, not fully stable"}: {stabilizedLine(meta)}
                </p>
            </div>

            <dl className="mt-3 space-y-1">
                <Row label="Problems" before={String(before.errors)} after={String(after.errors)} better={after.errors < before.errors} />
                <Row label="Floating blocks" before={String(before.floating_blocks)} after={String(after.floating_blocks)} better={after.floating_blocks < before.floating_blocks} />
                <Row label="Longest cantilever" before={String(before.longest_cantilever)} after={String(after.longest_cantilever)} better={after.longest_cantilever < before.longest_cantilever} />
                <Row
                    label="Peak stress"
                    before={before.max_utilisation === null ? "n/a" : fmtPct(before.max_utilisation)}
                    after={after.max_utilisation === null ? "n/a" : fmtPct(after.max_utilisation)}
                    better={before.max_utilisation !== null && after.max_utilisation !== null && after.max_utilisation < before.max_utilisation}
                />
            </dl>

            {roles.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Blocks added, by what they are for">
                    {roles.map((role) => (
                        <li key={role} className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-2 py-0.5 text-[11px]">
                            <span aria-hidden className="h-2 w-2 rounded-[2px] ring-1 ring-black/15 dark:ring-white/20" style={{ background: ROLE_HEX[role] }} />
                            <span className="text-foreground">{ROLE_PLURALS[role]}</span>
                            <span className="font-mono tabular-nums text-muted-foreground">{meta.added_by_role[role]}</span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => setCompare("overlay")} data-testid="stabilization-compare">
                    <GitCompareArrows />
                    Compare
                </Button>
                {source && (
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => setActiveModel(source.id)} data-testid="stabilization-original">
                        <Undo2 />
                        View original
                    </Button>
                )}
            </div>

            {meta.steps.length > 0 && (
                <div className="mt-3">
                    <p className="mb-1.5 text-xs font-medium text-foreground">Steps</p>
                    <StabilizeTimeline steps={meta.steps} running={false} selected={selected} onSelect={select} />
                </div>
            )}

            <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                Made by the stabilizer from {source ? <>“{source.prompt}”</> : "the model it was made from"}, aiming under {fmtPct(meta.target_utilisation)} of the allowable
                stress with {meta.material} joints. Solver: Awatif FEM ({meta.solver === "awatif-wasm" ? "WebAssembly" : "TypeScript"}). Your original blocks were not removed or moved.
            </p>
        </Section>
    );
}
