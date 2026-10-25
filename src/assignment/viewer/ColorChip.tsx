/**
 * "Colour: Status v": how the blocks are coloured, as a chip in the stage's chip stack (right above the legend that explains the
 * colours). One radio menu lists the colourings; a colouring the result cannot do is greyed with the reason in place of its
 * hint, and Added blocks is only there when blocks were added. While the stabilizer previews a run the stage paints what it added
 * whatever was chosen, so the chip is locked and says so. It only reports the choice; the workspace owns the view.
 */
import { ChevronDown, Palette } from "lucide-react";
import type { AnalysisColorBy } from "@/assignment/analysis/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/assignment/components/ui/dropdown-menu";
import { cn } from "@/assignment/lib/utils";
import { COLOR_MODE_HINTS } from "./analysisGeometry.ts";
import type { ColorChipModel } from "./stageControls.ts";

export interface ColorChipProps {
    /** What the chip says and offers (see colorChipModel). */
    model: ColorChipModel;
    /** A colouring was picked. Without it the chip only reports the colouring on stage. */
    onChange?(value: AnalysisColorBy): void;
    className?: string;
}

const chip = "inline-flex max-w-full items-center gap-1.5 rounded-md bg-background/85 px-2 py-0.5 text-[11px] text-foreground shadow-sm backdrop-blur";

export function ColorChip({ model, onChange, className }: ColorChipProps) {
    const { value, options, text, locked } = model;
    const inert = !!locked || !onChange;
    const label = (
        <>
            <Palette className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 truncate font-medium">{text}</span>
        </>
    );

    if (inert) {
        return (
            <p
                data-testid="stage-color-chip"
                data-locked={locked ? "true" : undefined}
                title={locked ? "The stabilizer is previewing a run: what it added is coloured by kind." : undefined}
                className={cn(chip, locked && "text-muted-foreground", className)}
            >
                {label}
            </p>
        );
    }

    return (
        <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    data-testid="stage-color-chip"
                    title={COLOR_MODE_HINTS[value]}
                    className={cn(chip, "pointer-events-auto outline-none transition-colors hover:bg-background focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-background [@media(pointer:coarse)]:min-h-9", className)}
                >
                    {label}
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" className="min-w-[15rem]">
                <DropdownMenuRadioGroup aria-label="Colour blocks by" value={value} onValueChange={(next) => onChange?.(next as AnalysisColorBy)}>
                    {options.map((option) => (
                        <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled} data-testid={`color-option-${option.value}`} className="items-start py-1.5">
                            <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="text-[13px] leading-tight">{option.label}</span>
                                <span className="text-[11px] leading-snug text-muted-foreground">{option.disabled && option.reason ? option.reason : option.hint}</span>
                            </span>
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
