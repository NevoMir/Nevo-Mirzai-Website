import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { DEFINITIONS, HOW_IT_WORKS, SCREEN_DEFINITIONS, STRESS_ASSUMPTIONS } from "@/assignment/analysis/definitions";
import type { AnalysisResult } from "@/assignment/analysis/types";
import { materialLine, solverLine } from "@/assignment/components/analysis/stressText";
import { GLOSSARY } from "@/assignment/components/analysis/vocabulary";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/assignment/components/ui/collapsible";
import type { ModelAsset } from "@/assignment/shared/contract";
import { fmtPct } from "@/assignment/store/analysisLogic";

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="space-y-2">
            <h3 className="text-[13px] font-medium text-foreground">{title}</h3>
            {children}
        </section>
    );
}

/** The last sentence of a tooltip names the technical term; the glossary shows it in a column of its own. */
const explanation = (tip: string): string => tip.replace(/\s*Technical term: .*$/i, "");

/**
 * "How is this computed?": the four steps in plain words, the words used on screen with the technical terms a teaching assistant
 * knows them by, the rules in detail (the same text as the exported report), and what the strength estimate and the stabilizer
 * assume. The glossary is where the technical terms live, since a phone has no tooltips.
 */
export function AboutPage({ model, result }: { model: ModelAsset | null; result: AnalysisResult | null }) {
    const stress = result?.stress ?? null;
    const material = result?.settings.material ?? "concrete";
    const meta = model?.kind === "stabilized" ? model.derived : null;
    return (
        <div className="space-y-5 px-4 py-4" data-testid="analysis-definitions">
            <Section title="In four steps">
                <ol className="space-y-2.5">
                    {HOW_IT_WORKS.map((step, i) => (
                        <li key={step.title} className="flex items-start gap-2.5">
                            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary font-mono text-[11px] text-secondary-foreground">{i + 1}</span>
                            <span className="min-w-0">
                                <span className="block text-xs font-medium text-foreground">{step.title}</span>
                                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{step.text}</span>
                            </span>
                        </li>
                    ))}
                </ol>
            </Section>

            <Section title="Words used here">
                <dl className="space-y-2.5" data-testid="analysis-glossary">
                    {GLOSSARY.map((term) => (
                        <div key={term.label}>
                            <dt className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-foreground">
                                {term.label}
                                <span className="text-[11px] font-normal text-muted-foreground">
                                    <span className="sr-only">technical term: </span>
                                    {term.tech}
                                </span>
                            </dt>
                            <dd className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{explanation(term.tip)}</dd>
                        </div>
                    ))}
                </dl>
            </Section>

            <Section title="The rules in detail">
                <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-card">
                    {[...DEFINITIONS.filter((d) => d.key !== "stabilizer"), ...SCREEN_DEFINITIONS].map((definition) => (
                        <Collapsible key={definition.key}>
                            <CollapsibleTrigger className="group flex min-h-11 w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:min-h-9">
                                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden />
                                {definition.title}
                            </CollapsibleTrigger>
                            <CollapsibleContent className="px-3 pb-3 pl-[30px] text-[11px] leading-relaxed text-muted-foreground">{definition.text}</CollapsibleContent>
                        </Collapsible>
                    ))}
                </div>
            </Section>

            <Section title="What the strength estimate assumes">
                <ul className="list-disc space-y-1 pl-4 text-[11px] leading-snug text-muted-foreground">
                    {STRESS_ASSUMPTIONS.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
                <p className="text-[11px] leading-snug text-muted-foreground">
                    Material: {materialLine(material)}. {stress ? solverLine(stress.solver) : ""}
                </p>
            </Section>

            <Section title="What the stabilizer does">
                <p className="text-[11px] leading-relaxed text-muted-foreground">{DEFINITIONS.find((d) => d.key === "stabilizer")?.text}</p>
                {meta && (
                    <p className="text-[11px] leading-snug text-muted-foreground" data-testid="analysis-stabilizer-note">
                        This version was made aiming under {fmtPct(meta.target_utilisation)} of what a joint takes, with {meta.material} joints. Solver: Awatif FEM (
                        {meta.solver === "awatif-wasm" ? "WebAssembly" : "TypeScript"}). Your original blocks were not removed or moved.
                    </p>
                )}
            </Section>
        </div>
    );
}
