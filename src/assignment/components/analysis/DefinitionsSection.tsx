import { CircleHelp } from "lucide-react";

import { Section } from "@/assignment/components/analysis/atoms";
import { DEFINITIONS, type Definition } from "@/assignment/analysis/definitions";

/** What only the screen needs: the engine's definitions are shared with the exported report, these are not. */
const SCREEN_DEFINITIONS: Definition[] = [
    {
        key: "directions",
        title: "Directions",
        text: "+X is to the right and -Y is towards you in the Front view; +Z is up. Where the report says a part sticks out towards +X and -Y, it is the right-hand, front side. The Front, Right and Top buttons in the 3D view show each side.",
    },
    {
        key: "reach-unit",
        title: "How far a cantilever reaches",
        text: "Counted in block steps along the structure from the nearest support, not in a straight line. A step to a neighbouring block, sideways or across a corner, counts as one; going up or down is free. A straight arm or a plate therefore never reaches further than the model is wide, but a winding arm can.",
    },
];

/** The rules behind the numbers in plain words, so a reader can check the verdict against them. */
export function DefinitionsSection() {
    return (
        <Section title="How it is computed" icon={CircleHelp} defaultOpen={false} testId="analysis-definitions">
            <dl className="space-y-3">
                {[...DEFINITIONS, ...SCREEN_DEFINITIONS].map((definition) => (
                    <div key={definition.key}>
                        <dt className="text-xs font-medium text-foreground">{definition.title}</dt>
                        <dd className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{definition.text}</dd>
                    </div>
                ))}
            </dl>
        </Section>
    );
}
