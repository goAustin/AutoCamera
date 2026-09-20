import type { ReactElement } from 'react';
import { humanize } from '../format.js';

export type StatusTone = 'positive' | 'negative' | 'active' | 'neutral';

const POSITIVE = new Set([
  'accepted',
  'completed',
  'validated',
  'passed',
  'ok',
]);
const NEGATIVE = new Set([
  'failed',
  'timed_out',
  'invalid',
  'critical',
  'needs_attention',
]);
const ACTIVE = new Set([
  'queued',
  'running',
  'generating',
  'planning',
  'evaluating',
]);

/** Maps a domain status string onto the badge's four tones. */
export function toneForStatus(status: string): StatusTone {
  if (POSITIVE.has(status)) return 'positive';
  if (NEGATIVE.has(status)) return 'negative';
  if (ACTIVE.has(status)) return 'active';
  return 'neutral';
}

export interface StatusBadgeProps {
  /** A raw domain status — the badge humanizes it and picks its own tone. */
  readonly status: string;
  /** Overrides the tone derived from `status`. */
  readonly tone?: StatusTone | undefined;
}

/** A pill carrying a run, attempt, evaluation or revision status. */
export function StatusBadge({ status, tone }: StatusBadgeProps): ReactElement {
  const resolved = tone ?? toneForStatus(status);
  const className =
    resolved === 'neutral'
      ? 'status-badge'
      : `status-badge status-badge--${resolved}`;
  return <span className={className}>{humanize(status)}</span>;
}
