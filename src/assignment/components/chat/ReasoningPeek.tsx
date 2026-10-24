import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * A peek at what the model is thinking, while it thinks. A nine-minute wait
 * with one static status line reads as a hang; a moving trace reads as work.
 *
 * The text is MODEL OUTPUT — rendered as a plain text node, never as markup —
 * and only the tail is kept (capped at the source, capped again in the store).
 * Collapsed by default so it never competes with the pipeline event feed:
 * that feed says WHAT the run has done, this says what it is doing right now.
 */
export function ReasoningPeek({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Follow the tail while open, the way a log pane does.
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [text, open]);

  if (!text.trim()) return null;
  return (
    <div className="mt-1.5" data-testid="reasoning-peek">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden
        />
        {open ? 'Hide thinking' : 'Show thinking'}
      </button>
      {open && (
        <div
          ref={bodyRef}
          data-testid="reasoning-peek-body"
          className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          {text}
        </div>
      )}
    </div>
  );
}
