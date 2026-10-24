import { useEffect, useState } from 'react';

/**
 * What to show for a running job: its own 0-100 progress, pushed along by the model's typical run
 * time. Providers report progress in coarse steps (some not at all), so a bar that followed only
 * the real number would sit still for a minute. The result is whichever of the two is further,
 * and it never goes backwards.
 */
export function useShownProgress({
  active,
  value,
  startedAt,
  estimateSeconds,
}: {
  active: boolean;
  /** The job's own progress, 0-100. */
  value: number;
  /** When the job began (ms since the epoch). */
  startedAt?: number;
  /** The model's typical end-to-end time. */
  estimateSeconds?: number;
}): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!active) {
      setShown(0);
      return;
    }
    const update = () => {
      const real = Math.min(100, Math.max(0, value));
      let estimate = 0;
      if (startedAt !== undefined && Number.isFinite(startedAt) && estimateSeconds) {
        const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
        // Approaches 90% as the typical time passes; a run that overshoots keeps inching along.
        estimate = Math.min(94, 90 * (1 - Math.exp(-elapsed / (estimateSeconds * 0.6))));
      }
      setShown((previous) => Math.max(previous, real, estimate));
    };
    update();
    const tick = setInterval(update, 1000);
    return () => clearInterval(tick);
  }, [active, value, startedAt, estimateSeconds]);
  return shown;
}
