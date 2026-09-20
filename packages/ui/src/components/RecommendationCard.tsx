import type { ReactElement, ReactNode } from 'react';
import type { RecommendationView } from '../types.js';
import { Button } from './Button.js';
import { EmptyState } from './StateBlock.js';
import { Panel } from './Panel.js';
import { StatusBadge } from './StatusBadge.js';

export interface RecommendationCardProps {
  readonly recommendation: RecommendationView;
  readonly onApply?: ((recommendation: RecommendationView) => void) | undefined;
  readonly onDismiss?:
    | ((recommendation: RecommendationView) => void)
    | undefined;
  readonly applyDisabled?: boolean | undefined;
  readonly dismissDisabled?: boolean | undefined;
  /** Confirmation gate or error notice rendered above the actions. */
  readonly children?: ReactNode | undefined;
}

/** One bounded operational suggestion awaiting a human decision. */
export function RecommendationCard({
  recommendation,
  onApply,
  onDismiss,
  applyDisabled = false,
  dismissDisabled = false,
  children,
}: RecommendationCardProps): ReactElement {
  return (
    <li className="recommendation-card">
      <div className="recommendation-heading">
        <StatusBadge status={recommendation.severity} />
        <strong>{recommendation.title}</strong>
      </div>
      <p>{recommendation.detail}</p>
      <div className="recommendation-meta">
        <span>{recommendation.recommendationCode}</span>
        <span>Action: {recommendation.proposedAction}</span>
      </div>
      {children}
      {(onApply || onDismiss) && (
        <div className="button-row">
          {onApply && (
            <Button
              variant="primary"
              disabled={applyDisabled}
              onClick={() => onApply(recommendation)}
            >
              Apply recommendation
            </Button>
          )}
          {onDismiss && (
            <Button
              disabled={dismissDisabled}
              onClick={() => onDismiss(recommendation)}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export interface RecommendationListProps {
  readonly recommendations: readonly RecommendationView[];
  readonly intro?: string | undefined;
  readonly onApply?: ((recommendation: RecommendationView) => void) | undefined;
  readonly onDismiss?:
    | ((recommendation: RecommendationView) => void)
    | undefined;
  /** Disables the apply action for the recommendation it returns true for. */
  readonly isApplying?:
    | ((recommendation: RecommendationView) => boolean)
    | undefined;
  readonly isDismissing?:
    | ((recommendation: RecommendationView) => boolean)
    | undefined;
  /** Extra content inside one card — a confirmation gate, or an error. */
  readonly renderExtra?:
    | ((recommendation: RecommendationView) => ReactNode)
    | undefined;
}

/** The recommendations section: heading, count, and one card per item. */
export function RecommendationList({
  recommendations,
  intro = 'Pi receives sanitized VideoOps evidence and proposes bounded actions. A human must apply or dismiss each recommendation.',
  onApply,
  onDismiss,
  isApplying,
  isDismissing,
  renderExtra,
}: RecommendationListProps): ReactElement {
  return (
    <Panel
      title="Recommendations"
      titleId="recommendations-title"
      count={recommendations.length}
      intro={intro}
    >
      {recommendations.length === 0 ? (
        <EmptyState
          title="No pending recommendations"
          detail="Operational signals will appear here when the durable event loop needs attention."
        />
      ) : (
        <ul className="recommendation-list">
          {recommendations.map((recommendation) => (
            <RecommendationCard
              key={recommendation.id}
              recommendation={recommendation}
              applyDisabled={isApplying?.(recommendation) ?? false}
              dismissDisabled={isDismissing?.(recommendation) ?? false}
              onApply={onApply}
              onDismiss={onDismiss}
            >
              {renderExtra?.(recommendation)}
            </RecommendationCard>
          ))}
        </ul>
      )}
    </Panel>
  );
}
