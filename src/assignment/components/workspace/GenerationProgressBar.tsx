import { useEffect, useState } from 'react';

/**
 * The build's loading bar. Two modes:
 *
 * - Creeping (Cably's original): indeterminate but not static. It creeps toward a ceiling that
 *   rises with each finished stage, so the user reads progress without the pipeline promising a
 *   percentage it does not know.
 * - Measured (`value` given, 0-100): draws exactly that. Feed it `useShownProgress` for a job.
 */
export function GenerationProgressBar({
  active,
  stageCount = 0,
  review = false,
  className = 'mt-5 w-72 max-w-[70%]',
  value,
}: {
  active: boolean;
  stageCount?: number;
  review?: boolean;
  className?: string;
  value?: number;
}) {
  const [progress, setProgress] = useState(0);
  const measured = value !== undefined;
  useEffect(() => {
    if (!active) {
      setProgress(0);
      return;
    }
    if (measured) return;
    const tick = setInterval(() => {
      setProgress((p) => {
        const target = Math.min(0.94, 0.1 + stageCount * 0.12 + (review ? 0.18 : 0));
        const eased = p + Math.max(0, target - p) * 0.07 + 0.0012;
        return Math.min(eased, 0.97);
      });
    }, 120);
    return () => clearInterval(tick);
  }, [active, measured, stageCount, review]);

  const percent = measured ? value : progress * 100;
  return (
    <div className={className} data-testid="generation-progress-bar">
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-border/60"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={measured ? Math.round(percent) : undefined}
      >
        <div
          className="cably-progress-fill h-full rounded-full"
          style={{ width: `${Math.max(3, Math.round(percent))}%` }}
        />
      </div>
    </div>
  );
}
