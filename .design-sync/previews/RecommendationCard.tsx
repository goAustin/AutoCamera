import { ConfirmPanel, RecommendationCard } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const warning = {
  id: 'rec-1',
  severity: 'warning',
  title: 'Review the invalid workflow revision',
  detail:
    'The persisted workflow revision did not pass validation and requires human review.',
  recommendationCode: 'WORKFLOW_REVISION_INVALID',
  proposedAction: 'Open Workflow Revision',
};

const List = ({ children }: { children: React.ReactNode }) => (
  <ul className="recommendation-list">{children}</ul>
);

export const Warning = () => (
  <Surface>
    <List>
      <RecommendationCard
        recommendation={warning}
        onApply={() => undefined}
        onDismiss={() => undefined}
      />
    </List>
  </Surface>
);

export const Critical = () => (
  <Surface>
    <List>
      <RecommendationCard
        recommendation={{
          ...warning,
          id: 'rec-2',
          severity: 'critical',
          title: 'Budget headroom is nearly exhausted',
          detail:
            'Remaining preview budget covers fewer than three attempts at the current profile cost.',
          recommendationCode: 'BUDGET_HEADROOM_LOW',
          proposedAction: 'Raise Budget Ceiling',
        }}
        onApply={() => undefined}
        onDismiss={() => undefined}
      />
    </List>
  </Surface>
);

export const WithConfirmation = () => (
  <Surface>
    <List>
      <RecommendationCard
        recommendation={{
          ...warning,
          id: 'rec-3',
          title: 'Retry the uncertain submission',
          detail:
            'The ComfyUI submission did not acknowledge before the timeout. A human must confirm the uncertainty is resolved before a derived retry.',
          recommendationCode: 'COMFY_SUBMISSION_UNCERTAIN',
          proposedAction: 'Retry Attempt',
        }}
        onApply={() => undefined}
        onDismiss={() => undefined}
      >
        <ConfirmPanel
          title="Apply a budget-spending recommendation?"
          detail="This human-approved action will create a derived retry after the server rechecks scope, limits, budget, workflow validation, and executor capability."
          confirmLabel="Apply and retry"
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />
      </RecommendationCard>
    </List>
  </Surface>
);
