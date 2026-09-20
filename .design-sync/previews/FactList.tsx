import { FactList } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

export const AttemptFacts = () => (
  <Surface>
    <FactList
      columns={4}
      facts={[
        { label: 'Queued', value: 'Sep 6, 2026, 2:10 AM' },
        { label: 'Profile hash', value: <code>6e7ec38830a9…</code> },
        { label: 'Parameters', value: '960×544 · 5s · seed 1908982807' },
        { label: 'Cost', value: '$0.10' },
      ]}
    />
  </Surface>
);

export const EvaluationDetails = () => (
  <Surface>
    <FactList
      columns={3}
      facts={[
        { label: 'Container', value: 'mp4' },
        { label: 'Frame rate', value: '24' },
        { label: 'Duration', value: '5.00s' },
      ]}
    />
  </Surface>
);

export const Stacked = () => (
  <Surface>
    <FactList
      facts={[
        { label: 'Evaluation', value: 'Passed' },
        { label: 'Estimated cost', value: '$0.10' },
        { label: 'Budget headroom', value: '$24.90' },
      ]}
    />
  </Surface>
);
