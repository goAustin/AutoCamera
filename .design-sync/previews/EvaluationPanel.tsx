import { EvaluationPanel } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

export const Passed = () => (
  <Surface>
    <EvaluationPanel
      evaluation={{
        status: 'passed',
        checks: {
          duration: { status: 'passed', detail: '5.00s within 4.5–5.5s' },
          resolution: { status: 'passed', detail: '960×544 as requested' },
          audio_track: { status: 'passed', detail: 'aac, 48 kHz' },
        },
        details: { container: 'mp4', frame_rate: 24, size_mb: 3.4 },
        evaluatorVersion: 'phase-3-v1',
        evaluatedAt: '2026-09-06T02:10:41.000Z',
      }}
    />
  </Surface>
);

export const Failed = () => (
  <Surface>
    <EvaluationPanel
      evaluation={{
        status: 'failed',
        checks: {
          duration: { status: 'failed', detail: '3.20s below the 4.5s floor' },
          resolution: { status: 'passed', detail: '960×544 as requested' },
        },
        details: { container: 'mp4', frame_rate: 24 },
        evaluatorVersion: 'phase-3-v1',
        evaluatedAt: '2026-09-06T02:11:08.000Z',
      }}
    />
  </Surface>
);

export const Pending = () => (
  <Surface>
    <EvaluationPanel />
  </Surface>
);
