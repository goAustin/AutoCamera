import type { ReactElement } from 'react';
import { formatDate, humanize } from '../format.js';
import type { EvaluationView } from '../types.js';
import { FactList } from './FactList.js';
import { Notice } from './Notice.js';
import { toneForStatus } from './StatusBadge.js';

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
  const verdictTone = toneForStatus(evaluation.status);

  return (
    <div className="evaluation-panel">
      <div className="evaluation-heading">
        <strong>Technical evaluation</strong>
        <span
          className={`evaluation-verdict evaluation-verdict--${verdictTone}`}
        >
          {humanize(evaluation.status)}
        </span>
      </div>
      <div className="check-grid">
        {Object.entries(evaluation.checks).map(([name, check]) => (
          <div className="check-row" key={name}>
            <span
              className={`check-dot check-dot--${toneForStatus(check.status)}`}
              aria-hidden="true"
            />
            <span className="check-label">{humanize(name)}</span>
            <span className="check-value">{check.detail}</span>
          </div>
        ))}
      </div>
      {details.length > 0 && <FactList facts={details} columns={3} />}
      <div className="evaluation-footer">
        Evaluator {evaluation.evaluatorVersion} ·{' '}
        {formatDate(evaluation.evaluatedAt)}
      </div>
    </div>
  );
}
