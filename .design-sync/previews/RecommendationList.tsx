import { RecommendationList } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const recommendations = [
  {
    id: 'rec-1',
    severity: 'warning',
    title: 'Review the invalid workflow revision',
    detail:
      'The persisted workflow revision did not pass validation and requires human review.',
    recommendationCode: 'WORKFLOW_REVISION_INVALID',
    proposedAction: 'Open Workflow Revision',
  },
  {
    id: 'rec-2',
    severity: 'critical',
    title: 'Budget headroom is nearly exhausted',
    detail:
      'Remaining preview budget covers fewer than three attempts at the current profile cost.',
    recommendationCode: 'BUDGET_HEADROOM_LOW',
    proposedAction: 'Raise Budget Ceiling',
  },
];

export const Pending = () => (
  <Surface>
    <RecommendationList
      recommendations={recommendations}
      onApply={() => undefined}
      onDismiss={() => undefined}
    />
  </Surface>
);

export const Empty = () => (
  <Surface>
    <RecommendationList recommendations={[]} />
  </Surface>
);
