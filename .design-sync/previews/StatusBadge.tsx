import { StatusBadge } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: "1rem", borderRadius: "0.75rem" }}
  >
    {children}
  </div>
);

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
    {children}
  </div>
);

export const Tones = () => (
  <Surface>
    <Row>
      <StatusBadge status="passed" />
      <StatusBadge status="failed" />
      <StatusBadge status="running" />
      <StatusBadge status="awaiting_review" />
    </Row>
  </Surface>
);

export const AttemptLifecycle = () => (
  <Surface>
    <Row>
      <StatusBadge status="queued" />
      <StatusBadge status="submitting" />
      <StatusBadge status="generating" />
      <StatusBadge status="evaluating" />
      <StatusBadge status="accepted" />
    </Row>
  </Surface>
);

export const FailureStates = () => (
  <Surface>
    <Row>
      <StatusBadge status="timed_out" />
      <StatusBadge status="invalid" />
      <StatusBadge status="needs_attention" />
      <StatusBadge status="critical" />
    </Row>
  </Surface>
);
