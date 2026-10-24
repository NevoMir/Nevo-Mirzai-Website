import { useEffect, useState } from 'react';

/**
 * Live "how long has this been running" readout for the generation UI —
 * a nine-minute build with no clock reads as a hang.
 *
 * The start time lives in the store (`pipelineStartedAt`), not in component
 * state, so the count survives a re-render, a project switch and a reattach:
 * the clock belongs to the run, not to whoever is watching it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** One second-ticker shared by every readout — the phone layout mounts the
 *  chat mirror and the canvas overlay at the same time. */
const listeners = new Set<(now: number) => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
function subscribe(fn: (now: number) => void): () => void {
  listeners.add(fn);
  if (!ticker) {
    ticker = setInterval(() => {
      const now = Date.now();
      for (const listener of listeners) listener(now);
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

export function ElapsedTime({ startedAt, className }: { startedAt: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    return subscribe(setNow);
  }, [startedAt]);
  return (
    <span data-testid="pipeline-elapsed" className={className}>
      {formatElapsed(now - startedAt)}
    </span>
  );
}
