import {
  AttemptSummary,
  Button,
  EvaluationPanel,
  type AttemptView,
} from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const base: AttemptView = {
  id: '01a072c3-880a-79b1-9b3f-3992ecabff49',
  status: 'awaiting_review',
  queuedAt: '2026-09-06T02:10:00.000Z',
  workflowHash: '6e7ec38830a94f11c0de5b2a7c118d43',
  requestedWidth: 960,
  requestedHeight: 544,
  requestedDurationSeconds: 5,
  seed: 1908982807,
  estimatedCostUsd: '0.10',
};

export const AwaitingReview = () => (
  <Surface>
    <AttemptSummary attempt={base}>
      <div className="button-row attempt-actions">
        <Button variant="primary">Accept passing attempt</Button>
        <Button variant="quiet">Reject</Button>
      </div>
    </AttemptSummary>
  </Surface>
);

export const Running = () => (
  <Surface>
    <AttemptSummary
      attempt={{ ...base, status: 'running' }}
      progress={{ value: 14, max: 20 }}
    />
  </Surface>
);

export const Failed = () => (
  <Surface>
    <AttemptSummary
      attempt={{
        ...base,
        status: 'failed',
        failureCode: 'COMFY_SUBMISSION_UNCERTAIN',
        failureMessage:
          'The ComfyUI submission did not acknowledge within the timeout. A human must resolve the uncertainty before a derived retry.',
      }}
    >
      <div className="button-row attempt-actions">
        <Button variant="quiet">Retry with confirmation</Button>
      </div>
    </AttemptSummary>
  </Surface>
);

export const DerivedRetry = () => (
  <Surface>
    <AttemptSummary
      attempt={{
        ...base,
        id: '01a072c3-9f14-7c02-b8ae-51d0c7724e63',
        status: 'accepted',
        seed: 442019887,
        sourceAttemptId: '01a072c3-880a-79b1-9b3f-3992ecabff49',
      }}
    >
      <EvaluationPanel
        evaluation={{
          status: 'passed',
          checks: {
            duration: { status: 'passed', detail: '5.00s within 4.5–5.5s' },
            resolution: { status: 'passed', detail: '960×544 as requested' },
          },
          details: { container: 'mp4', frame_rate: 24 },
          evaluatorVersion: 'phase-3-v1',
          evaluatedAt: '2026-09-06T02:10:41.000Z',
        }}
      />
    </AttemptSummary>
  </Surface>
);
