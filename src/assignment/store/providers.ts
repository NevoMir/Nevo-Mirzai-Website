// The model list (GET /providers) and everything derived from it: labels, which are usable, the
// remembered selection. The data lives in the workspace store so the picker, the job cards and the
// models list all read the same answer.

import { getProviders } from "@/assignment/lib/api";
import type { ProviderId, ProviderInfo } from "@/assignment/shared/contract";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/** Names for a model the server no longer lists (a job made before a key was removed). */
const FALLBACK_LABELS: Record<ProviderId, string> = {
    "tripo-parts": "Tripo H3.1 · Parts",
    tripo: "Tripo H3.1",
    meshy: "Meshy 7.1",
    rodin: "Rodin Gen-2.5",
    hunyuan: "Hunyuan 3D 3.1",
    mock: "Demo (offline)",
};

let inFlight: Promise<void> | null = null;

/** Fetch the model list and today's usage into the store. Concurrent calls share one request. */
export function refreshProviders(): Promise<void> {
    inFlight ??= getProviders()
        .then((response) => useWorkspaceStore.getState().setProviders(response))
        .catch((err: unknown) => {
            // Usage is a hint and the list is cached after the first success: stay quiet here.
            console.warn("Could not load the model list", err);
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

export function providerInfo(providers: readonly ProviderInfo[] | undefined, id: ProviderId): ProviderInfo | undefined {
    return providers?.find((p) => p.id === id);
}

export function providerLabel(providers: readonly ProviderInfo[] | undefined, id: ProviderId): string {
    return providerInfo(providers, id)?.label ?? FALLBACK_LABELS[id] ?? id;
}

/** "via fal" / "via Tripo": which API a model runs through, for the little badge. */
export function viaLabel(via: ProviderInfo["via"] | undefined): string | null {
    switch (via) {
        case "fal":
            return "via fal";
        case "tripo":
            return "via Tripo";
        case "meshy":
            return "via Meshy";
        case "tencent":
            return "via Tencent";
        case "mock":
            return "demo";
        default:
            return null;
    }
}

/**
 * Models have keys but none can be used: the server switched generation off (no access code is
 * configured), which is different from a deployment that has no keys at all.
 */
export function generationSwitchedOff(providers: readonly ProviderInfo[] | undefined): boolean {
    if (!providers || providers.length === 0) return false;
    return !providers.some((p) => p.available) && providers.some((p) => p.via !== null);
}

/**
 * Can the vendor stop this model once it runs? Tencent's Hunyuan API (and Tripo's) has no cancel call,
 * so a Stop would only drop our row while the vendor keeps running, and billing, the task. The server
 * can say so per model (`cancelable`); an answer without the field means "yes" until the server has
 * refused a stop for it (`refused`: the models this session was told cannot be stopped).
 */
export function isCancelable(info: ProviderInfo | undefined, refused: readonly ProviderId[] = []): boolean {
    if (info && refused.includes(info.id)) return false;
    return (info as (ProviderInfo & { cancelable?: boolean }) | undefined)?.cancelable !== false;
}

/** "~2 min" / "~45 s": a typical end-to-end time, rounded the way people say it. */
export function approxTime(seconds: number): string {
    if (seconds < 60) return `~${Math.max(5, Math.round(seconds / 5) * 5)} s`;
    return `~${Math.round(seconds / 60)} min`;
}

// ---------- The remembered selection ----------

const SELECTION_KEY = "assembly-studio-providers";
/** The Worker takes at most this many models per prompt. */
export const MAX_PROVIDERS_PER_PROMPT = 5;

export function loadSelection(): ProviderId[] {
    try {
        const raw = localStorage.getItem(SELECTION_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id): id is ProviderId => typeof id === "string") : [];
    } catch {
        return [];
    }
}

export function saveSelection(ids: readonly ProviderId[]): void {
    try {
        localStorage.setItem(SELECTION_KEY, JSON.stringify(ids));
    } catch {
        // Storage blocked: the choice just will not survive a reload.
    }
}

/**
 * The selection to start from: what was remembered, minus models that are gone or unavailable;
 * the server's default when nothing usable is left.
 */
export function initialSelection(
    providers: readonly ProviderInfo[],
    remembered: readonly ProviderId[],
    defaultProvider: ProviderId | null,
): ProviderId[] {
    const usable = new Set(providers.filter((p) => p.available).map((p) => p.id));
    const kept = remembered.filter((id) => usable.has(id)).slice(0, MAX_PROVIDERS_PER_PROMPT);
    if (kept.length > 0) return kept;
    if (defaultProvider && usable.has(defaultProvider)) return [defaultProvider];
    const first = providers.find((p) => p.available);
    return first ? [first.id] : [];
}
