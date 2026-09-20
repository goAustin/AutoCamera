import { Button, EmptyState, FactList, Panel } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

export const WithCount = () => (
  <Surface>
    <Panel title="Durable runs" count={2} titleId="p-runs">
      <FactList
        facts={[
          { label: 'Evaluation', value: 'Passed' },
          { label: 'Estimated cost', value: '$0.10' },
          { label: 'Budget headroom', value: '$24.90' },
        ]}
      />
    </Panel>
  </Surface>
);

export const WithIntro = () => (
  <Surface>
    <Panel
      title="Recommendations"
      count={1}
      titleId="p-recs"
      intro="Pi receives sanitized VideoOps evidence and proposes bounded actions. A human must apply or dismiss each recommendation."
    >
      <EmptyState
        title="No pending recommendations"
        detail="Operational signals will appear here when the durable event loop needs attention."
      />
    </Panel>
  </Surface>
);

export const WithAction = () => (
  <Surface>
    <Panel
      title="Selected run"
      titleId="p-run"
      action={<Button variant="quiet">Pin keeper</Button>}
    >
      <FactList
        facts={[
          { label: 'Run', value: '01a072c3-880a…bff49' },
          { label: 'Keeper', value: 'Not pinned' },
        ]}
      />
    </Panel>
  </Surface>
);

export const WithKicker = () => (
  <Surface>
    <Panel
      title="Workflow revisions"
      kicker="Immutable history"
      count={3}
      titleId="p-rev"
    >
      <EmptyState
        title="No revisions yet"
        detail="Create a revision after saving or exporting a draft."
      />
    </Panel>
  </Surface>
);
