// The bundled examples: the list the galleries show, and opening one as a new project.
//
// An example is a project made without a single generation: a model with structural problems and its stabilized
// version, both shipped with the site (worker/examples.ts). Opening one is one POST, so it costs no tokens.
// Plain functions over the stores (not hooks), like store/generation.ts, so a click that outlives its dialog finishes.

import { create } from "zustand";

import { ApiRequestError, createProjectFromExample, listExamples } from "@/assignment/lib/api";
import { notifyHubChanged } from "@/assignment/lib/hub/hubClient";
import { projectPath } from "@/assignment/lib/projectPath";
import { toast } from "@/assignment/components/ui/sonner";
import type { ExampleSummary, ProviderInfo } from "@/assignment/shared/contract";
import { plural, verdictOf } from "@/assignment/store/analysisLogic";
import { hasPaidProvider } from "@/assignment/store/providers";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

// ---------- the list ----------

export type ExamplesStatus = "idle" | "loading" | "ready" | "error";

interface ExamplesState {
    status: ExamplesStatus;
    examples: ExampleSummary[];
    error: string | null;
}

export const useExamplesStore = create<ExamplesState>()(() => ({ status: "idle", examples: [], error: null }));

let inFlight: Promise<void> | null = null;

/**
 * Fetch the list into the store. One request at a time; a list already loaded stays unless `force` (Retry, or an
 * example the server no longer knows). The galleries call this on mount, so the second one to open is instant.
 */
export function loadExamples(force = false): Promise<void> {
    const { status } = useExamplesStore.getState();
    if (!force && status === "ready") return Promise.resolve();
    if (inFlight) return inFlight;
    // Keep the old list on screen while a forced reload runs; a first load shows the skeleton.
    useExamplesStore.setState((s) => ({ status: s.status === "ready" ? "ready" : "loading", error: null }));
    inFlight = listExamples()
        .then((examples) => useExamplesStore.setState({ status: "ready", examples, error: null }))
        .catch((err: unknown) => {
            useExamplesStore.setState({
                status: "error",
                examples: [],
                error: err instanceof Error && err.message ? err.message : "Could not load the examples.",
            });
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

// ---------- what a card says ----------

export interface ExampleChips {
    /** "2 problems → Stable", "1 warning → Stable", or "Already stable" for a model with nothing to fix. */
    status: string;
    /** True when the stabilized version fixes something: the card then reads as a before and after. */
    fixed: boolean;
    /** "+14 blocks", null when the stabilizer had nothing to add. */
    added: string | null;
    /** "198% → 21%": the highest joint stress before and after, null when it did not change or is not known. */
    stress: string | null;
}

const percent = (utilisation: number): string => `${Math.round(utilisation * 100)}%`;

/** The chips of an example's card, worded from the numbers the manifest carries (no analysis runs for a card). */
export function exampleChips(example: ExampleSummary): ExampleChips {
    const before = verdictOf(example.original.analysis);
    const after = verdictOf(example.stabilized.analysis);
    const added = example.stabilized.added_blocks;
    const fixed = Boolean(before && after && before.kind !== "pass" && after.kind === "pass");
    let status: string;
    if (!before || !after) status = "";
    else if (before.kind === "pass" && after.kind === "pass") status = "Already stable";
    else if (before.short === after.short) status = after.short;
    else status = `${before.short} → ${after.short}`;
    const b = example.stabilized.before.max_utilisation;
    const a = example.stabilized.after.max_utilisation;
    const stress = b !== null && a !== null && Math.abs(b - a) >= 0.005 ? `${percent(b)} → ${percent(a)}` : null;
    return { status, fixed, added: added > 0 ? `+${plural(added, "block")}` : null, stress };
}

/** "Mushroom table, 2 problems to Stable, +14 blocks": the card's accessible name (an arrow is read out as a symbol). */
export function exampleLabel(example: ExampleSummary): string {
    const chips = exampleChips(example);
    return [example.title, chips.status.replace(" → ", " to "), chips.added].filter(Boolean).join(", ");
}

// ---------- the new-chat hero ----------

export type StartMode = "examples" | "prompts";

/**
 * Which row the new-chat hero starts on. Examples when nothing paid can be generated with (the deployment has no key
 * or generation is switched off, so a prompt would go nowhere), unless there are no examples to show; prompts
 * otherwise. The visitor's own choice, once made, wins over this (components/chat/HeroStart.tsx).
 */
export function defaultStartMode(providers: readonly ProviderInfo[] | undefined, examplesUsable: boolean): StartMode {
    if (!examplesUsable) return "prompts";
    return hasPaidProvider(providers) ? "prompts" : "examples";
}

export interface StartModeInput {
    /** The row the visitor picked (here or last time), else null. */
    picked: StartMode | null;
    /** The default the last visit ended up with, so the first paint can already show it. */
    remembered: StartMode | null;
    providers: readonly ProviderInfo[] | undefined;
    examplesStatus: ExamplesStatus;
    examplesCount: number;
    /** Waited long enough for the answers: decide with what there is. */
    timedOut: boolean;
}

/**
 * The row the hero shows. The default depends on two answers (the model list and the examples), and a first paint made
 * before they arrive would flip to the other row when they do, under the visitor's pointer: until both are in, it shows
 * what the last visit ended on, else null (the hero then shows a placeholder). `known`: the answers are in, so the default
 * is worth remembering.
 */
export function resolveStartMode(input: StartModeInput): { mode: StartMode | null; known: boolean } {
    if (input.picked) return { mode: input.picked, known: true };
    const known = input.providers !== undefined && (input.examplesStatus === "ready" || input.examplesStatus === "error");
    if (!known && !input.timedOut) return { mode: input.remembered, known: false };
    const usable = input.examplesStatus !== "error" && !(input.examplesStatus === "ready" && input.examplesCount === 0);
    return { mode: defaultStartMode(input.providers, usable), known };
}

const START_MODE_KEY = "assembly-studio-start-mode";
const START_DEFAULT_KEY = "assembly-studio-start-default";

/** The row the visitor picked last time, or null when they never picked (then the default above decides). */
export function loadStartMode(): StartMode | null {
    try {
        const raw = localStorage.getItem(START_MODE_KEY);
        return raw === "examples" || raw === "prompts" ? raw : null;
    } catch {
        return null;
    }
}

export function saveStartMode(mode: StartMode): void {
    try {
        localStorage.setItem(START_MODE_KEY, mode);
    } catch {
        // Storage blocked: the choice just will not survive a reload.
    }
}

/** The default the hero ended up with last time (not a choice of the visitor's: that is loadStartMode). */
export function loadStartDefault(): StartMode | null {
    try {
        const raw = localStorage.getItem(START_DEFAULT_KEY);
        return raw === "examples" || raw === "prompts" ? raw : null;
    } catch {
        return null;
    }
}

export function saveStartDefault(mode: StartMode): void {
    try {
        localStorage.setItem(START_DEFAULT_KEY, mode);
    } catch {
        // Storage blocked: the first paint just shows a placeholder.
    }
}

// ---------- opening one ----------

/** Where an opened example lands: the Analysis tab, because the verdict and the Stabilize story are there. */
export const OPEN_EXAMPLE_QUERY = "?tab=analysis";

export type OpenExampleResult = { ok: true; projectId: string } | { ok: false; error: string };

export interface OpenExampleOptions {
    /** Seed tag, when it is opened from a tag page of the hub. */
    tagId?: string | null;
    /** The router's navigate (relative to the app's basename). */
    navigate: (to: string) => void;
}

const errorText = (err: unknown): string =>
    err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.";

let opening = false;

/**
 * Create a project from the example and show it. The project is put in the workspace store at once (so the page it
 * lands on paints without waiting for a second read), the hub is told to re-read, and the router moves to it with
 * the Analysis tab asked for. A failure toasts with a Retry (except where retrying cannot help) and leaves everything
 * as it was. One open at a time: a second click while one is in flight does nothing.
 */
export async function openExample(slug: string, options: OpenExampleOptions): Promise<OpenExampleResult> {
    if (opening) return { ok: false, error: "Another example is opening." };
    opening = true;
    try {
        const detail = await createProjectFromExample(slug, options.tagId);
        const workspace = useWorkspaceStore.getState();
        workspace.setProject(detail);
        // setProject starts every project on the 3D tab; this one is opened on the verdict.
        workspace.setWorkspaceTab("analysis");
        notifyHubChanged();
        options.navigate(`${projectPath(detail.id)}${OPEN_EXAMPLE_QUERY}`);
        return { ok: true, projectId: detail.id };
    } catch (err) {
        const status = err instanceof ApiRequestError ? err.status : 0;
        if (status === 404) {
            // The server no longer has it (a deploy changed the set): refresh the list instead of offering the same card.
            toast.error("That example is no longer available", { description: "The list has been refreshed." });
            void loadExamples(true);
        } else if (status === 429) {
            toast.error("Could not open the example", { description: errorText(err) });
        } else {
            toast.error("Could not open the example", {
                description: errorText(err),
                action: { label: "Retry", onClick: () => void openExample(slug, options) },
            });
        }
        return { ok: false, error: errorText(err) };
    } finally {
        opening = false;
    }
}
