import type { ReactElement } from 'react';
import { formatDate, humanize } from '../format.js';
import type { EvaluationView } from '../types.js';
import { FactList } from './FactList.js';
import { Notice } from './Notice.js';
import { StatusBadge } from './StatusBadge.js';

export interface EvaluationPanelProps {
  /** Omit while the worker has not produced an evaluation yet. */
  readonly evaluation?: EvaluationView | undefined;
  /** Shown in place of the panel when there is no evaluation. */
  readonly pendingMessage?: string | undefined;
}

/** The technical verdict for one attempt: overall status, then each check. */
export function EvaluationPanel({
  evaluation,
  pendingMessage = 'Technical evaluation is not available yet. The worker will add it after artifact ingestion.',
}: EvaluationPanelProps): ReactElement {
  if (!evaluation) return <Notice variant="info">{pendingMessage}</Notice>;

  const details = Object.entries(evaluation.details).map(([name, value]) => ({
    label: humanize(name),
    value: String(value),
  }));

  return (
    <div className="evaluation-panel">
      <div className="evaluation-heading">
        <strong>Technical evaluation</strong>
        <StatusBadge status={evaluation.status} />
      </div>
      <div className="check-grid">
        {Object.entries(evaluation.checks).map(([name, check]) => (
          <div className="check-row" key={name}>
            <span>{humanize(name)}</span>
            <StatusBadge status={check.status} />
            <small>{check.detail}</small>
          </div>
        ))}
      </div>
      {details.length > 0 && <FactList facts={details} columns={3} />}
      <small className="muted">
        Evaluator {evaluation.evaluatorVersion} ·{' '}
        {formatDate(evaluation.evaluatedAt)}
      </small>
    </div>
  );
}
