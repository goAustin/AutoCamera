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
  'awaiting_review',
]);
/** The subset of active statuses that are actually happening right now, as
 * opposed to waiting in a queue for one — these carry the pulsing dot. */
const PULSING = new Set(['generating', 'awaiting_review']);

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
  const pulsing = resolved === 'active' && PULSING.has(status);
  const className = [
    'status-badge',
    resolved === 'neutral' ? '' : `status-badge--${resolved}`,
    pulsing ? 'status-badge--pulsing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <span className={className}>{humanize(status)}</span>;
}
