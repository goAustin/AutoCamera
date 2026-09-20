import type { ReactElement } from 'react';
import { formatDate, shortId } from '../format.js';
import type { RevisionView } from '../types.js';
import { Button } from './Button.js';
import { EmptyState } from './StateBlock.js';
import { Panel } from './Panel.js';
import { StatusBadge } from './StatusBadge.js';

export interface RevisionHistoryProps {
  readonly revisions: readonly RevisionView[];
  readonly selectedRevisionId?: string | undefined;
  /** Omit to hide the "Use revision" action entirely. */
  readonly onUse?: ((revision: RevisionView) => void) | undefined;
  readonly onValidate?: ((revision: RevisionView) => void) | undefined;
  /** Id of the revision currently being re-validated. */
  readonly validatingId?: string | undefined;
}

/** The immutable record of workflow revisions, newest-first as supplied. */
export function RevisionHistory({
  revisions,
  selectedRevisionId,
  onUse,
  onValidate,
  validatingId,
}: RevisionHistoryProps): ReactElement {
  return (
    <Panel
      title="Workflow revisions"
      titleId="revision-history-title"
      count={revisions.length}
    >
      {revisions.length === 0 ? (
        <EmptyState
          title="No revisions yet"
          detail="Create a revision after saving or exporting a draft."
        />
      ) : (
        <ol className="revision-list">
          {revisions.map((revision) => (
            <li
              className={
                revision.id === selectedRevisionId
                  ? 'revision-item revision-item--selected'
                  : 'revision-item'
              }
              key={revision.id}
            >
              <div className="revision-heading">
                <strong>Revision {revision.revisionNumber}</strong>
                <StatusBadge status={revision.validationStatus} />
              </div>
              <div className="revision-meta">
                <span>{revision.source}</span>
                <span>{formatDate(revision.createdAt)}</span>
              </div>
              <code title={revision.executionHash}>
                {revision.executionHash.slice(0, 16)}…
              </code>
              {revision.parentRevisionId && (
                <span className="muted">
                  Parent {shortId(revision.parentRevisionId, 8, 0)}
                </span>
              )}
              {revision.validationErrors.length > 0 && (
                <ul className="validation-list">
                  {revision.validationErrors.map((issue) => (
                    <li key={`${issue.code}-${issue.message}`}>
                      <strong>{issue.code}</strong> {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {(onUse || onValidate) && (
                <div className="button-row">
                  {onUse && (
                    <Button onClick={() => onUse(revision)}>
                      Use revision
                    </Button>
                  )}
                  {onValidate && revision.validationStatus !== 'validated' && (
                    <Button
                      disabled={validatingId === revision.id}
                      onClick={() => onValidate(revision)}
                    >
                      {validatingId === revision.id
                        ? 'Validating…'
                        : 'Validate again'}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
