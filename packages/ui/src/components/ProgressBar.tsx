import type { ReactElement } from 'react';

export interface ProgressBarProps {
  readonly value: number;
  readonly max: number;
  /** The unit the count is in, e.g. "steps". Appended after `value / max`. */
  readonly unit?: string | undefined;
}

/** A determinate progress track driven by the worker event stream. The
 * caption reads as a count against the unit that produced it — a diffusion
 * step count, not a percentage, which hides exactly how far along a long
 * step actually is. */
export function ProgressBar({
  value,
  max,
  unit = 'steps',
}: ProgressBarProps): ReactElement {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const rounded = Math.round(percent);
  return (
    <div
      className="progress-block"
      role="progressbar"
      aria-label={`Progress ${rounded} percent`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rounded}
    >
      <div className="progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="progress-caption">
        {value} / {max} {unit}
      </span>
    </div>
  );
}
