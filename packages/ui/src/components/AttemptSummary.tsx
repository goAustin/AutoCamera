import type { ReactElement, ReactNode } from 'react';
import { formatDate, formatDuration, formatMoney, shortId } from '../format.js';
import type { AttemptView } from '../types.js';
import { FactList, type Fact } from './FactList.js';
import { ProgressBar } from './ProgressBar.js';
import { StatusBadge } from './StatusBadge.js';

export interface AttemptSummaryProps {
  readonly attempt: AttemptView;
  /** Worker progress, when the attempt is still executing. */
  readonly progress?:
    | { readonly value: number; readonly max: number }
    | undefined;
  /** Player, evaluation, confirmation gates and actions are composed in here. */
  readonly children?: ReactNode | undefined;
}

/**
 * One immutable attempt: what was asked for, what it cost, how far it got.
 * The card is the single border — nothing inside it draws another frame.
 */
export function AttemptSummary({
  attempt,
  progress,
  children,
}: AttemptSummaryProps): ReactElement {
  const facts: Fact[] = [
    {
      label: 'Profile hash',
      value: <code>{attempt.workflowHash.slice(0, 12)}…</code>,
    },
    {
      label: 'Parameters',
      value: `${attempt.requestedWidth}×${attempt.requestedHeight} · ${formatDuration(attempt.requestedDurationSeconds)} · seed ${attempt.seed}`,
    },
    { label: 'Cost', value: formatMoney(attempt.estimatedCostUsd) },
  ];
  if (attempt.sourceAttemptId) {
    facts.push({
      label: 'Derived from',
      value: shortId(attempt.sourceAttemptId, 12, 0),
    });
  }
  if (attempt.failureCode) {
    facts.push({ label: 'Failure', value: attempt.failureCode });
  }

  return (
    <article className="attempt-card" aria-labelledby={`attempt-${attempt.id}`}>
      <div className="attempt-heading">
        <div>
          <h4 id={`attempt-${attempt.id}`}>Generation attempt</h4>
          <div className="attempt-meta">
            {shortId(attempt.id, 12, 0)} · {formatDate(attempt.queuedAt)}
          </div>
        </div>
        <StatusBadge status={attempt.status} />
      </div>
      <FactList facts={facts} columns={4} />
      {progress && (
        <div className="attempt-progress">
          <ProgressBar value={progress.value} max={progress.max} />
        </div>
      )}
      {attempt.failureMessage && (
        <p className="failure-copy">{attempt.failureMessage}</p>
      )}
      {children}
    </article>
  );
}
