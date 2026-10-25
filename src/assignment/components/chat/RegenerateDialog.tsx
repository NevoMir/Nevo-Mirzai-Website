import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/assignment/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/assignment/components/ui/dialog";
import { Textarea } from "@/assignment/components/ui/textarea";
import { requestAccessCode } from "@/assignment/store/access";
import { sendPrompt } from "@/assignment/store/generation";
import { useWorkspaceStore } from "@/assignment/store/useWorkspaceStore";

/** What one Hunyuan run costs the person (their Tencent credits), said out loud before it is spent. */
export const HUNYUAN_CREDITS = 25;
/** Hunyuan takes at most 1024 characters of prompt. */
export const REGENERATE_PROMPT_MAX = 1000;

/**
 * "Generate it again with Hunyuan": a plain new model made from a prompt (the original one with the change in it), after the person has
 * read what it costs and confirmed. It is not linked to the edited model (a different model will come out). The prompt is theirs to change.
 */
export function RegenerateDialog({ open, onOpenChange, initialPrompt }: { open: boolean; onOpenChange: (open: boolean) => void; initialPrompt: string }) {
    const [prompt, setPrompt] = useState(initialPrompt);
    const sending = useWorkspaceStore((s) => s.sending);
    useEffect(() => {
        if (open) setPrompt(initialPrompt);
    }, [open, initialPrompt]);
    const trimmed = prompt.trim();

    const confirm = async (): Promise<void> => {
        if (!trimmed || sending) return;
        const outcome = await sendPrompt({ prompt: trimmed, providers: ["hunyuan"], requestAccessCode });
        if (outcome.ok) onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent data-testid="regenerate-dialog">
                <DialogHeader>
                    <DialogTitle>Generate it again with Hunyuan?</DialogTitle>
                    <DialogDescription>
                        This makes a brand-new model from the description below. It uses <strong>{HUNYUAN_CREDITS} of your Hunyuan credits</strong>, takes about
                        4 minutes, and the result will look different from the current model.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor="regenerate-prompt" className="text-xs font-medium text-foreground">
                        Description
                    </label>
                    <Textarea
                        id="regenerate-prompt"
                        value={prompt}
                        maxLength={REGENERATE_PROMPT_MAX}
                        rows={5}
                        onChange={(e) => setPrompt(e.target.value)}
                        data-testid="regenerate-prompt"
                    />
                    <p className="text-right text-[11px] text-muted-foreground">
                        {prompt.length} / {REGENERATE_PROMPT_MAX}
                    </p>
                </div>
                <DialogFooter className="gap-2 sm:gap-0">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={() => void confirm()} disabled={!trimmed || sending} data-testid="regenerate-confirm">
                        <Sparkles />
                        Generate ({HUNYUAN_CREDITS} credits)
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
