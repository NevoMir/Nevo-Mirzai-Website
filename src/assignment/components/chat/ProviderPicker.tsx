import { ChevronDown, Cuboid, Layers } from "lucide-react";

import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import type { ProviderId, ProviderInfo } from "@/assignment/shared/contract";
import { MAX_PROVIDERS_PER_PROMPT, approxTime, generationSwitchedOff, viaLabel } from "@/assignment/store/providers";

const chip = "rounded-full border px-1.5 text-[10px] leading-4";

/**
 * The composer's model picker: a small pill with a checkbox menu. Several boxes ticked means the
 * same prompt is sent to each, so the results can be compared side by side. Models whose API key is
 * missing are listed but disabled, so it is clear what the deployment could do.
 */
export function ProviderPicker({
    providers,
    selected,
    onChange,
    disabled,
    usage = null,
}: {
    /** undefined until GET /providers has answered. */
    providers: readonly ProviderInfo[] | undefined;
    selected: readonly ProviderId[];
    onChange: (next: ProviderId[]) => void;
    disabled?: boolean;
    /** Today's count, repeated in the menu for when the composer is too narrow to show it. */
    usage?: { used: number; limit: number } | null;
}) {
    const chosen = providers?.filter((p) => selected.includes(p.id)) ?? [];
    const usable = providers?.filter((p) => p.available) ?? [];
    const label =
        chosen.length === 1 ? chosen[0].label : chosen.length > 1 ? `${chosen.length} models` : providers ? "Pick a model" : "Models";
    const Icon = chosen.length > 1 ? Layers : Cuboid;
    const atMax = selected.length >= MAX_PROVIDERS_PER_PROMPT;

    // A deployment with a single model (the public one has only Hunyuan) has nothing to pick: a plain
    // label says which model runs, without a menu of providers that are not set up.
    if (providers && usable.length <= 1) {
        const only = usable[0];
        const via = viaLabel(only?.via);
        return (
            <div
                data-testid="provider-picker"
                title={only ? [only.description, via].filter(Boolean).join(" · ") : undefined}
                className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground"
            >
                <Cuboid className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                    {only ? only.label : generationSwitchedOff(providers) ? "Generation is switched off" : "No model available"}
                </span>
            </div>
        );
    }

    const toggle = (id: ProviderId, on: boolean) => {
        if (on) onChange(atMax ? [...selected] : [...selected, id]);
        // Never end up with nothing ticked: a send needs at least one model.
        else if (selected.length > 1) onChange(selected.filter((s) => s !== id));
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={disabled || !providers}
                    data-testid="provider-picker"
                    aria-label={`Model: ${label}. Change model`}
                    title={chosen.length > 1 ? chosen.map((p) => p.label).join(", ") : "Choose the text-to-3D model"}
                    className="flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[9.5rem] truncate">{label}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="w-[19rem]">
                <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
                    Models
                </DropdownMenuLabel>
                {providers?.map((p) => {
                    const checked = selected.includes(p.id);
                    const via = viaLabel(p.via);
                    return (
                        <DropdownMenuCheckboxItem
                            key={p.id}
                            checked={checked}
                            disabled={!p.available || (!checked && atMax)}
                            // Keep the menu open so several models can be ticked in a row.
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={(on) => toggle(p.id, on === true)}
                            className="items-start py-2"
                        >
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs font-medium text-foreground">{p.label}</span>
                                    {p.parts && (
                                        <span className={`${chip} border-accent/50 text-accent-hover dark:text-accent`}>parts</span>
                                    )}
                                    {p.textured && (
                                        <span className={`${chip} border-border text-muted-foreground`}>textured</span>
                                    )}
                                </div>
                                <p className="text-[11px] leading-snug text-muted-foreground">{p.description}</p>
                                <p className="text-[11px] text-muted-foreground">
                                    {p.vendor} · {approxTime(p.approx_seconds)}
                                    {p.available && via ? ` · ${via}` : ""}
                                    {!p.available && " · needs an API key"}
                                </p>
                            </div>
                        </DropdownMenuCheckboxItem>
                    );
                })}
                <DropdownMenuSeparator />
                <p className="px-2 pb-1 pt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {atMax
                        ? `Up to ${MAX_PROVIDERS_PER_PROMPT} models per prompt.`
                        : "Tick several to compare them on the same prompt."}
                    {usage && ` ${usage.used} of ${usage.limit} generations used today.`}
                </p>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
