import { useEffect, useRef, useState, type FormEvent } from "react";

import { Button } from "@/assignment/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/assignment/components/ui/dialog";
import { Input } from "@/assignment/components/ui/input";
import { checkAccess, isValidAccessCode, setAccessCode } from "@/assignment/lib/api";

/**
 * Asks for the access code when a send needs one. Unlike the Settings dialog, this one is part of
 * a send in progress: `onResult(true)` lets the send carry on, `onResult(false)` (dismissed) cancels it.
 */
export function AccessCodeGate({ open, onResult }: { open: boolean; onResult: (ok: boolean) => void }) {
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The dialog can be dismissed while a check is in flight: that answer must not count then.
    const openRef = useRef(open);
    openRef.current = open;

    useEffect(() => {
        if (!open) return;
        setCode("");
        setError(null);
        setBusy(false);
    }, [open]);

    const submit = async (event: FormEvent) => {
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
            if (!openRef.current) return;
            if (!ok) {
                setError("That code was not accepted.");
                return;
            }
            setAccessCode(trimmed);
            onResult(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not check the code.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onResult(false)}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Enter the access code</DialogTitle>
                        <DialogDescription>
                            Generating 3D models costs money, so this deployment asks for a code first. Your prompt is
                            kept and sent as soon as the code is accepted. The code stays in this browser only.
                        </DialogDescription>
                    </DialogHeader>
                    <Input
                        type="password"
                        autoComplete="off"
                        autoFocus
                        placeholder="Access code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        aria-label="Access code"
                    />
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <DialogFooter className="gap-2 sm:gap-0">
                        <Button type="button" variant="ghost" onClick={() => onResult(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !code.trim()}>
                            {busy ? "Checking…" : "Continue"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
