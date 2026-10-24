import { useEffect, useState } from "react";

import { ExampleGallery, ExampleGalleryLoading } from "@/assignment/components/chat/ExampleGallery";
import { ExamplePrompts } from "@/assignment/components/chat/ExamplePrompts";
import { cn } from "@/assignment/lib/utils";
import {
    loadExamples,
    loadStartDefault,
    loadStartMode,
    resolveStartMode,
    saveStartDefault,
    saveStartMode,
    useExamplesStore,
    type StartMode,
} from "@/assignment/store/examples";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

const OPTIONS: { mode: StartMode; label: string }[] = [
    { mode: "examples", label: "Open an example" },
    { mode: "prompts", label: "Try a prompt" },
];

/**
 * What a new chat offers to start from: ready-made example projects (nothing is generated, so it costs nothing) or
 * example prompts for the composer. A deployment that cannot generate (no key, or switched off) starts on the
 * examples, one that can starts on the prompts; once the visitor picks a side it is remembered in this browser. Until the
 * two answers that decide the default have arrived it shows the default of the last visit, or a placeholder: a first
 * paint on the wrong row would swap under the pointer.
 */
export function HeroStart({ onPick, tagId = null, className }: { onPick: (prompt: string) => void; tagId?: string | null; className?: string }) {
    const providers = useWorkspaceStore((s) => s.providers?.providers);
    const examplesStatus = useExamplesStore((s) => s.status);
    const examplesCount = useExamplesStore((s) => s.examples.length);
    const [picked, setPicked] = useState<StartMode | null>(() => loadStartMode());
    const [remembered] = useState<StartMode | null>(() => loadStartDefault());
    const [timedOut, setTimedOut] = useState(false);

    // Whether there is anything to open decides the default, so the list is asked for as soon as the hero shows.
    useEffect(() => {
        void loadExamples();
    }, []);

    const { mode, known } = resolveStartMode({ picked, remembered, providers, examplesStatus, examplesCount, timedOut });
    // A list that never arrives (a failed request) must not leave the hero blank.
    useEffect(() => {
        if (known || timedOut) return;
        const timer = setTimeout(() => setTimedOut(true), 3000);
        return () => clearTimeout(timer);
    }, [known, timedOut]);
    useEffect(() => {
        if (known && picked === null && mode) saveStartDefault(mode);
    }, [known, picked, mode]);

    const choose = (next: StartMode) => {
        setPicked(next);
        saveStartMode(next);
    };

    return (
        <div className={cn("flex w-full flex-col items-center gap-3", className)} data-testid="hero-start" data-mode={mode}>
            <div role="group" aria-label="Start from" className="inline-flex rounded-full border border-border/70 bg-sidebar/90 p-0.5 text-xs shadow-sm">
                {OPTIONS.map(({ mode: option, label }) => (
                    <button
                        key={option}
                        type="button"
                        aria-pressed={mode === option}
                        data-testid={`start-${option}`}
                        onClick={() => choose(option)}
                        className={cn(
                            "rounded-full px-3 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            mode === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {mode === null ? (
                <div className="@container flex w-full justify-center" data-testid="hero-start-pending">
                    <ExampleGalleryLoading variant="hero" />
                </div>
            ) : mode === "examples" ? (
                <>
                    {/* Dropped on a short window: the hero must still clear the top bar and the composer. */}
                    <p className="max-w-md text-xs text-muted-foreground [@media(max-height:720px)]:hidden">
                        Ready-made projects with a generated model and its stabilized version. Nothing is generated, so it costs nothing.
                    </p>
                    <ExampleGallery variant="hero" tagId={tagId} />
                </>
            ) : (
                <ExamplePrompts onPick={onPick} />
            )}
        </div>
    );
}
