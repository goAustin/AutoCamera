import type { ReactElement } from 'react';

export interface ProgressBarProps {
  readonly value: number;
  readonly max: number;
  /** Caption under the track naming where the numbers come from. */
  readonly caption?: string | undefined;
}

/** A determinate progress track driven by the worker event stream. */
export function ProgressBar({
  value,
  max,
  caption = 'worker event stream',
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
      <span>
        {rounded}% · {caption}
      </span>
    </div>
  );
}
