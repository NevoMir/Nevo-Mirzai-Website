import { useRef } from "react";
import { CircleCheck, Download, Info, RotateCcw, TriangleAlert } from "lucide-react";

import { downloadBytes } from "@/assignment/components/analysis/download";
import { Segmented, type SegmentedOption } from "@/assignment/components/analysis/atoms";
import { TONE } from "@/assignment/components/analysis/style";
import { useFocusOnEnd } from "@/assignment/components/analysis/useFocusOnEnd";
import { ConvergenceChart } from "@/assignment/components/optimize/ConvergenceChart";
import { Button } from "@/assignment/components/ui/button";
import { Slider } from "@/assignment/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/assignment/components/ui/tooltip";
import { modelFileName } from "@/assignment/components/workspace/format";
import { cn } from "@/assignment/lib/utils";
import { useOptimizeStore } from "@/assignment/store/optimize";
import { COMPARE_WORDS, compareRows, focusOf, noChangeWords, rowOfRecord, stopWords, targetLine, verdictLine, type CompareMode } from "@/assignment/store/optimizeLogic";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const COMPARE_OPTIONS: ReadonlyArray<SegmentedOption<CompareMode>> = (["before", "after", "changes"] as const).map((m) => ({ value: m, label: COMPARE_WORDS[m] }));
const small = "h-11 gap-1.5 px-3 text-xs md:h-8";
const quiet = "hover:bg-secondary hover:text-foreground";

/**
 * The end of a run, before anything is saved: what it did to the figures in one sentence, why it stopped, the Before | After | Change table, and
 * the stage toggles (Before, After, Changes, the round slider). "Keep this version" saves it as a new version of the project; only a result
 * that meets every limit and changes the blocks can be kept.
 */
export function ResultCard() {
    const wire = useOptimizeStore((s) => s.result);
    const spec = useOptimizeStore((s) => s.spec);
    const compare = useOptimizeStore((s) => s.compare);
    const scrub = useOptimizeStore((s) => s.scrubRound);
    const kgPer = useOptimizeStore((s) => s.kgPer);
    const effective = useOptimizeStore((s) => s.effective);
    const modelId = useOptimizeStore((s) => s.modelId);
    const endedAt = useOptimizeStore((s) => s.endedAt);
    const keep = useOptimizeStore((s) => s.keep);
    const discard = useOptimizeStore((s) => s.discard);
    const tryAgain = useOptimizeStore((s) => s.tryAgain);
    const setCompare = useOptimizeStore((s) => s.setCompare);
    const scrubTo = useOptimizeStore((s) => s.scrubTo);
    const source = useWorkspaceStore((s) => s.models.find((m) => m.id === modelId));
    const ref = useFocusOnEnd<HTMLDivElement>(endedAt);
    // "Hold to see before": the stage goes back to the version while the button is pressed.
    const held = useRef<CompareMode | null>(null);
    if (!wire || !spec) return null;

    const { meta, result } = wire;
    const keepable = wire.changed && meta.feasible;
    const objective = meta.spec.objective.map((t) => t.metric);
    const rows = compareRows(meta.before, meta.after, objective);
    const rounds = result.history.length > 0 ? result.history[result.history.length - 1].iteration : 0;
    const target = targetLine(meta.spec, meta.before, meta.after);
    const stopped = result.stop === "canceled";
    // A run that changed nothing says why (a Stop or a time-out is not "as good as it gets") and what to try; one that changed something says why it stopped.
    const unchanged = meta.feasible && !wire.changed ? noChangeWords({ stop: result.stop, complete: result.complete, rounds, blocks: meta.before.blocks, effective }) : null;
    const stop = unchanged ? unchanged.detail : stopped ? `You stopped it at round ${rounds}. This is the best valid state it had reached.` : stopWords(result);
    const headline = !meta.feasible ? "It could not meet every limit, so nothing was changed." : unchanged ? unchanged.headline : verdictLine(meta.before, meta.after, objective, meta);
    const tone = keepable ? TONE.pass : meta.feasible ? TONE.muted : TONE.warn;
    const Icon = keepable ? CircleCheck : meta.feasible ? Info : TriangleAlert;
    const download = () => downloadBytes(modelFileName({ prompt: source?.prompt ?? "model", provider: "optimizer", kind: "optimized" }), "model/gltf-binary", wire.glb);

    return (
        <div className="px-4 pb-3" data-testid="optimize-result" data-keepable={keepable}>
            <div ref={ref} tabIndex={-1} className={cn("rounded-xl border p-3 focus:outline-none", tone.soft, tone.border)} data-testid="optimize-verdict">
                <div className="flex items-start gap-2.5">
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} aria-hidden />
                    <div className="min-w-0 flex-1">
                        <p className={cn("text-[13px] font-semibold leading-snug", tone.text)} role="status" data-testid="optimize-headline">
                            {headline}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground" data-testid="optimize-stop-words">
                            {stop}
                            {target ? ` ${target}` : ""}
                        </p>
                    </div>
                </div>
            </div>

            {result.notes.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs leading-snug text-amber-800 dark:text-amber-300" data-testid="optimize-result-notes">
                    {result.notes.map((note) => (
                        <li key={note}>{note}</li>
                    ))}
                </ul>
            )}

            {keepable && (
                <div className="mt-3" data-testid="optimize-stage-toggles">
                    <Segmented label="What the stage shows" value={compare} options={COMPARE_OPTIONS} onChange={setCompare} />
                    <div className="mt-2 flex items-center gap-2">
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <button
                                    type="button"
                                    className="shrink-0 rounded-md border border-border/70 px-2 py-1 text-[11px] font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    data-testid="optimize-hold"
                                    onPointerDown={() => {
                                        held.current = compare;
                                        setCompare("before");
                                    }}
                                    onPointerUp={() => {
                                        if (held.current) setCompare(held.current);
                                        held.current = null;
                                    }}
                                    onPointerLeave={() => {
                                        if (held.current) setCompare(held.current);
                                        held.current = null;
                                    }}
                                >
                                    Hold to see before
                                </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs">
                                Keep the button pressed to see the version as it was.
                            </TooltipContent>
                        </Tooltip>
                        {rounds >= 2 && (
                            <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="optimize-scrub">
                                <Slider
                                    min={0}
                                    max={rounds}
                                    step={1}
                                    value={[scrub ?? rounds]}
                                    onValueChange={([v]) => scrubTo(v >= rounds ? null : v)}
                                    aria-label="Round shown on the stage"
                                    aria-valuetext={`Round ${scrub ?? rounds} of ${rounds}`}
                                />
                                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                                    {scrub ?? rounds}/{rounds}
                                </span>
                            </div>
                        )}
                    </div>
                    {compare !== "before" && (
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" data-testid="optimize-legend">
                            <span className="flex items-center gap-1">
                                <span aria-hidden className="inline-block h-2.5 w-2.5 border border-dashed border-red-500 bg-red-500/20" />
                                taken out
                            </span>
                            <span className="flex items-center gap-1">
                                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px] ring-2 ring-green-500" />
                                put in
                            </span>
                        </p>
                    )}
                </div>
            )}

            {meta.feasible && (
                <table className="mt-3 w-full text-left text-xs tabular-nums" data-testid="optimize-compare">
                    <caption className="sr-only">Before and after</caption>
                    <thead className="text-[11px] text-muted-foreground">
                        <tr>
                            <th scope="col" className="py-1 pr-2 font-medium" />
                            <th scope="col" className="py-1 pr-2 text-right font-medium">
                                Before
                            </th>
                            <th scope="col" className="py-1 pr-2 text-right font-medium">
                                After
                            </th>
                            <th scope="col" className="py-1 text-right font-medium">
                                Change
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <tr key={row.key} className="border-t border-border/50" data-row={row.key}>
                                <th scope="row" className="py-1.5 pr-2 font-normal text-foreground">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className="cursor-help">{row.label}</span>
                                        </TooltipTrigger>
                                        <TooltipContent side="top" className="max-w-56 text-xs">
                                            {row.tip}
                                        </TooltipContent>
                                    </Tooltip>
                                </th>
                                <td className="py-1.5 pr-2 text-right text-muted-foreground">{row.before}</td>
                                <td className="py-1.5 pr-2 text-right font-medium text-foreground">{row.after}</td>
                                <td className={cn("py-1.5 text-right", row.better ? TONE.pass.text : "text-muted-foreground")}>
                                    {row.better && <span className="sr-only">better: </span>}
                                    {row.change}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {keepable && effective && meta.after.max_utilisation !== null && meta.before.max_utilisation !== null && meta.after.max_utilisation > meta.before.max_utilisation && (
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground" data-testid="optimize-tradeoff">
                    Strength used rises, up to the limit you set ({Math.round(effective.maxStressPct)}%): taking blocks away is paid for with strength.
                </p>
            )}

            {result.history.length > 1 && (
                <div className="mt-3">
                    <ConvergenceChart rows={result.history.map(rowOfRecord)} kgPerBlock={kgPer} limit={effective ? effective.maxStressPct / 100 : null} focus={focusOf(objective)} />
                </div>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5" data-testid="optimize-result-actions">
                {keepable && (
                    <Button type="button" size="sm" className={small} onClick={() => void keep()} data-testid="optimize-keep">
                        Keep this version
                    </Button>
                )}
                <Button type="button" size="sm" variant="outline" className={cn(small, quiet)} onClick={tryAgain} data-testid="optimize-try-again">
                    <RotateCcw />
                    Try again
                </Button>
                <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={discard} data-testid="optimize-discard">
                    {keepable ? "Discard" : "Dismiss"}
                </Button>
                {keepable && (
                    <Button type="button" size="sm" variant="ghost" className={cn(small, quiet)} onClick={download} data-testid="optimize-download">
                        <Download />
                        Download GLB
                    </Button>
                )}
            </div>
            {keepable && <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">Try again keeps your goal and limits so you can change them and run again.</p>}
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="optimize-disclaimer">
                An estimate, not a certificate: the model's own weight only, joints that never open, and no buckling, sliding or wind.
            </p>
        </div>
    );
}
