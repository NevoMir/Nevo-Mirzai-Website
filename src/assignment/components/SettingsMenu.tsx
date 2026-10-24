import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Monitor, Moon, Info, Settings, Sun } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/assignment/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/assignment/components/ui/dropdown-menu";
import { Input } from "@/assignment/components/ui/input";
import { toast } from "@/assignment/components/ui/sonner";
import { useTheme } from "@/assignment/hooks/useTheme";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";
import {
    checkAccess,
    clearAccessCode,
    getAccessCode,
    getProviders,
    isValidAccessCode,
    setAccessCode,
} from "@/assignment/lib/api";
import type { ProvidersResponse } from "@/assignment/shared/contract";

/**
 * The settings menu: Cably's account menu minus the account. Appears in the same two
 * places (the hub and the workspace header), so it is one component with the same
 * trigger style: a bare round button that rings on hover.
 *
 * The dialogs it opens are mounted here, beside the menu, so both pages get them free.
 */
export interface SettingsMenuProps {
    side?: "top" | "bottom" | "left" | "right";
    align?: "start" | "center" | "end";
    className?: string;
}

export function SettingsMenu({ side = "bottom", align = "end", className = "" }: SettingsMenuProps) {
    const { mode, setMode } = useTheme();
    const [aboutOpen, setAboutOpen] = useState(false);
    const [accessOpen, setAccessOpen] = useState(false);
    // Only a deployment with an ACCESS_CODE secret asks for one; otherwise the item would just confuse.
    const accessRequired = useWorkspaceStore((s) => s.providers?.access_required ?? false);

    return (
        <>
            {/* Not modal: a modal menu that hands over to a dialog leaves `pointer-events: none`
                stuck on <body> when that dialog closes (a Radix race), freezing the whole page. */}
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        data-testid="settings-menu-trigger"
                        aria-label="Settings"
                        title="Settings"
                        className={`flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-secondary-foreground hover:ring-2 hover:ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
                    >
                        <Settings className="h-3.5 w-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side={side} align={align} className="w-56">
                    <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Assembly Studio</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="gap-2 text-xs">
                            {mode === "light" ? (
                                <Sun className="h-3.5 w-3.5" />
                            ) : mode === "dark" ? (
                                <Moon className="h-3.5 w-3.5" />
                            ) : (
                                <Monitor className="h-3.5 w-3.5" />
                            )}
                            Theme
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                                <DropdownMenuRadioItem value="light" className="text-xs">
                                    Light
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="dark" className="text-xs">
                                    Dark
                                </DropdownMenuRadioItem>
                                <DropdownMenuRadioItem value="system" className="text-xs">
                                    System
                                </DropdownMenuRadioItem>
                            </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {accessRequired && (
                        <DropdownMenuItem className="gap-2 text-xs" onClick={() => setAccessOpen(true)}>
                            <KeyRound className="h-3.5 w-3.5" /> Access code
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="gap-2 text-xs" onClick={() => setAboutOpen(true)}>
                        <Info className="h-3.5 w-3.5" /> About this app
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
            <AccessCodeDialog open={accessOpen} onOpenChange={setAccessOpen} />
        </>
    );
}

interface DialogState {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/** What the app is, which models it can call (live from the server), and where files live. */
function AboutDialog({ open, onOpenChange }: DialogState) {
    const [info, setInfo] = useState<ProvidersResponse | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        setFailed(false);
        getProviders(controller.signal)
            .then(setInfo)
            .catch((err: unknown) => {
                if (!controller.signal.aborted) setFailed(true);
                console.warn("Could not load the model list", err);
            });
        return () => controller.abort();
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>About Assembly Studio</DialogTitle>
                    <DialogDescription>
                        A text-to-3D assembly generator, built for a university assignment.
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 text-sm text-foreground">
                    <p>
                        Describe an object in plain words and Assembly Studio asks text-to-3D models to build it, then
                        shows the result in an interactive 3D viewer. Send one prompt to several models to compare
                        them; models that return separate parts give you a true assembly you can take apart. Chats and
                        models are organised in projects you can rename, tag, pin and archive.
                    </p>
                    <div>
                        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Models
                        </h3>
                        {info ? (
                            <ul className="space-y-1.5">
                                {info.providers.map((p) => (
                                    <li key={p.id} className="flex items-start gap-2">
                                        <span
                                            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${p.available ? "bg-success" : "bg-muted-foreground/40"}`}
                                            title={p.available ? "Available" : "Not configured on this deployment"}
                                        />
                                        <span className="min-w-0">
                                            <span className="font-medium">{p.label}</span>
                                            <span className="text-muted-foreground"> ({p.vendor})</span>
                                            <span className="block text-xs text-muted-foreground">{p.description}</span>
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : failed ? (
                            <p className="text-muted-foreground">
                                The live model list could not be loaded. The app can call Tripo H3.1 (including a
                                multi-part assembly mode), Meshy 7.1, Hyper3D Rodin Gen-2.5 and Tencent Hunyuan 3D 3.1.
                            </p>
                        ) : (
                            <p className="text-muted-foreground">Loading…</p>
                        )}
                        {info && (
                            <p className="mt-2 text-xs text-muted-foreground">
                                {info.daily_limit === null
                                    ? `${info.used_today} generation${info.used_today === 1 ? "" : "s"} today.`
                                    : `${info.used_today} of ${info.daily_limit} generations used today.`}
                            </p>
                        )}
                    </div>
                    <p className="text-muted-foreground">
                        Provider download links expire, so every finished model is copied into Cloudflare R2 object
                        storage and served from there. Projects, tags and jobs live in Cloudflare D1, behind a
                        Cloudflare Worker.
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Enter (or remove) the code that unlocks generation on a protected deployment. */
export function AccessCodeDialog({ open, onOpenChange }: DialogState) {
    const [code, setCode] = useState("");
    const [stored, setStored] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setStored(getAccessCode() !== null);
        setCode("");
        setError(null);
    }, [open]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        const trimmed = code.trim();
        if (!trimmed || busy) return;
        // Only printable ASCII can travel as a header; anything else cannot be the code.
        if (!isValidAccessCode(trimmed)) {
            setError("That code was not accepted.");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { ok } = await checkAccess(trimmed);
            if (!ok) {
                setError("That code was not accepted.");
                return;
            }
            setAccessCode(trimmed);
            toast.success("Access code saved");
            onOpenChange(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not check the code.");
        } finally {
            setBusy(false);
        }
    };

    const remove = () => {
        clearAccessCode();
        setStored(false);
        toast.success("Access code removed");
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={save} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Access code</DialogTitle>
                        <DialogDescription>
                            Generating models costs money, so this deployment may ask for a code. It is kept in this
                            browser only.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        type="password"
                        autoComplete="off"
                        placeholder={stored ? "A code is saved. Enter a new one to replace it" : "Access code"}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        aria-label="Access code"
                    />
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <DialogFooter className="gap-2 sm:gap-0">
                        {stored && (
                            <Button type="button" variant="ghost" onClick={remove}>
                                Remove saved code
                            </Button>
                        )}
                        <Button type="submit" disabled={busy || !code.trim()}>
                            {busy ? "Checking…" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
