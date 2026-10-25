import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Boxes, CircleCheck, Loader2, TriangleAlert } from "lucide-react";

import { TONE } from "@/assignment/components/analysis/style";
import { CardStrip } from "@/assignment/components/chat/CardStrip";
import { Button } from "@/assignment/components/ui/button";
import { Skeleton } from "@/assignment/components/ui/skeleton";
import { cn } from "@/assignment/lib/utils";
import type { ExampleSummary } from "@/assignment/shared/contract";
import { exampleChips, exampleLabel, loadExamples, openExample, useExamplesStore } from "@/assignment/store/examples";

const chip = "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4";

export interface ExampleGalleryProps {
    /** "hero": the new-chat strip (compact cards, arrow keys walk them). "grid": the hub's dialog (cover, blurb, tags). */
    variant: "hero" | "grid";
    /** The project exists and the page is about to show it. */
    onOpened?: (projectId: string) => void;
    /** Seed tag for the new project (the hub's tag page). */
    tagId?: string | null;
    className?: string;
}

/** The cover image, or a quiet glyph on the canvas colour when it is missing or fails to load. */
function Cover({ example, busy, ratio }: { example: ExampleSummary; busy: boolean; ratio: string }) {
    const [failed, setFailed] = useState(false);
    return (
        <div className={cn("relative flex items-center justify-center overflow-hidden border-b border-border/70 bg-canvas", ratio)}>
            {failed ? (
                <Boxes className="h-8 w-8 text-muted-foreground/40" strokeWidth={1.5} aria-hidden />
            ) : (
                <img
                    src={example.cover_url}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onError={() => setFailed(true)}
                    className="h-full w-full object-cover"
                />
            )}
            {busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
                    <Loader2 className="h-6 w-6 animate-spin text-foreground" aria-hidden />
                </div>
            )}
        </div>
    );
}

/** "2 problems → Stable" with a tick when the stabilized version fixes it, a warning sign when it cannot. */
function StatusChip({ example }: { example: ExampleSummary }) {
    const { status, fixed } = exampleChips(example);
    if (!status) return null;
    const stable = fixed || status === "Already stable";
    const tone = TONE[stable ? "pass" : "warn"];
    const Icon = stable ? CircleCheck : TriangleAlert;
    return (
        <span className={cn(chip, tone.soft, tone.border, tone.text)}>
            <Icon className="h-3 w-3 shrink-0" aria-hidden />
            {status}
        </span>
    );
}

function ExampleCard({
    example,
    variant,
    busy,
    locked,
    onOpen,
}: {
    example: ExampleSummary;
    variant: "hero" | "grid";
    /** This card's example is being created. */
    busy: boolean;
    /** Another one is: ignore clicks, keep the card focusable. */
    locked: boolean;
    onOpen: (example: ExampleSummary) => void;
}) {
    const chips = exampleChips(example);
    const grid = variant === "grid";
    return (
        <button
            type="button"
            data-strip-card
            data-example-project={example.slug}
            aria-busy={busy}
            aria-disabled={locked || busy}
            aria-label={`Open the example: ${exampleLabel(example)}`}
            onClick={() => {
                if (!locked && !busy) onOpen(example);
            }}
            className={cn(
                "flex w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-sidebar text-left shadow-sm transition",
                "hover:-translate-y-0.5 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                (locked || busy) && "cursor-progress hover:translate-y-0",
                locked && !busy && "opacity-60",
                grid && "h-full",
            )}
        >
            <Cover example={example} busy={busy} ratio={grid ? "aspect-[4/3]" : "aspect-[16/10]"} />
            <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5 px-3", grid ? "py-3" : "py-2")}>
                <div className={cn("truncate font-medium text-foreground", grid ? "text-sm" : "text-[13px]")}>{example.title}</div>
                {grid && <p className="line-clamp-3 text-xs text-muted-foreground">{example.blurb}</p>}
                <div className="flex flex-wrap items-center gap-1">
                    <StatusChip example={example} />
                    {chips.added && <span className={cn(chip, "border-accent/50 text-accent-hover dark:text-accent")}>{chips.added}</span>}
                    {grid && chips.stress && (
                        <span className={cn(chip, "border-border text-muted-foreground")} title="How much of what its weakest joint can take is used: before and after the stabilizer">
                            strength used {chips.stress}
                        </span>
                    )}
                </div>
                {grid && example.tags.length > 0 && (
                    <div className="mt-auto flex flex-wrap gap-1 pt-1">
                        {example.tags.slice(0, 4).map((tag) => (
                            <span key={tag} className="rounded-md bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
                                {tag}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </button>
    );
}

/** Placeholder cards the size of the real ones (cover plus text), so the list arriving does not move what is below it. */
export function ExampleGalleryLoading({ variant }: { variant: "hero" | "grid" }) {
    const grid = variant === "grid";
    return (
        <div
            role="status"
            aria-busy="true"
            aria-label="Loading examples"
            className={grid ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" : "flex w-full max-w-[880px] gap-4 px-1 py-1"}
        >
            {[0, 1, 2].map((i) => (
                <div key={i} className={cn("flex min-w-0 flex-col gap-1.5", !grid && "flex-1", !grid && i > 0 && "hidden @[26rem]:flex")}>
                    <Skeleton className={cn("w-full rounded-2xl", grid ? "aspect-[4/3]" : "aspect-[16/10]")} />
                    <Skeleton className={cn("w-full rounded-lg", grid ? "h-[84px]" : "h-[40px]")} />
                </div>
            ))}
        </div>
    );
}

/**
 * The ready-made projects: a card each, with the cover, the title and what the stabilizer does to it. A click creates
 * the project and opens it, so a visitor can try the whole tool without generating anything (and without tokens).
 */
export function ExampleGallery({ variant, onOpened, tagId = null, className }: ExampleGalleryProps) {
    const navigate = useNavigate();
    const status = useExamplesStore((s) => s.status);
    const examples = useExamplesStore((s) => s.examples);
    const [openingSlug, setOpeningSlug] = useState<string | null>(null);

    useEffect(() => {
        void loadExamples();
    }, []);

    const open = async (example: ExampleSummary) => {
        if (openingSlug) return;
        setOpeningSlug(example.slug);
        const result = await openExample(example.slug, { tagId, navigate });
        if (result.ok) {
            onOpened?.(result.projectId);
            // The page moves on and takes this gallery with it: the busy card stays busy until then.
            return;
        }
        setOpeningSlug(null);
    };

    if (status === "idle" || (status === "loading" && examples.length === 0)) {
        return (
            <div className={cn("@container w-full", variant === "hero" && "flex justify-center", className)}>
                <ExampleGalleryLoading variant={variant} />
            </div>
        );
    }

    if (status === "error" || examples.length === 0) {
        return (
            <div
                role={status === "error" ? "alert" : "status"}
                data-testid="example-gallery-empty"
                className={cn(
                    "flex w-full max-w-[880px] flex-col items-center gap-2 rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center",
                    className,
                )}
            >
                <p className="text-sm font-medium text-foreground">
                    {status === "error" ? "The examples could not be loaded" : "There are no examples yet"}
                </p>
                {status === "error" && (
                    <>
                        <p className="max-w-sm text-xs text-muted-foreground">Check your connection, then try again.</p>
                        <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void loadExamples(true)}>
                            Retry
                        </Button>
                    </>
                )}
            </div>
        );
    }

    const card = (example: ExampleSummary) => (
        <ExampleCard
            example={example}
            variant={variant}
            busy={openingSlug === example.slug}
            locked={openingSlug !== null}
            onOpen={(e) => void open(e)}
        />
    );

    if (variant === "hero") {
        return (
            <CardStrip
                label="Example projects"
                testId="example-gallery"
                className={className}
                items={examples.map((example) => ({ key: example.slug, node: card(example) }))}
            />
        );
    }
    return (
        <div
            role="list"
            aria-label="Example projects"
            data-testid="example-gallery-grid"
            className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
        >
            {examples.map((example) => (
                <div key={example.slug} role="listitem" className="flex min-w-0">
                    {card(example)}
                </div>
            ))}
        </div>
    );
}
