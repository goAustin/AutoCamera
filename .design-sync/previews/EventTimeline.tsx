import { EventTimeline, type TimelineEvent } from '@h3/ui';

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div
    className="videoops-surface"
    style={{ padding: '1rem', borderRadius: '0.75rem' }}
  >
    {children}
  </div>
);

const events: TimelineEvent[] = [
  {
    id: 'e26',
    title: 'Evaluation Completed',
    timestamp: '2026-09-06T02:10:41.000Z',
    sequence: 26,
    detail:
      'Status: passed · Evaluation Id: 01a072c3-8936-7f22-8756-70133b6436fe',
  },
  {
    id: 'e25',
    title: 'Artifact Stored',
    timestamp: '2026-09-06T02:10:38.000Z',
    sequence: 25,
    detail: 'Artifact Id: 01a072c3-885c-7ffd-95ce-a943c4669b9f',
  },
  {
    id: 'e24',
    title: 'Attempt Evaluating',
    timestamp: '2026-09-06T02:10:37.000Z',
    sequence: 24,
  },
  {
    id: 'e22',
    title: 'Attempt Execution Started',
    timestamp: '2026-09-06T02:10:12.000Z',
    sequence: 22,
    detail: 'Status: running',
  },
  {
    id: 'e19',
    title: 'Attempt Queued',
    timestamp: '2026-09-06T02:10:04.000Z',
    sequence: 19,
    detail: 'Status: queued · Estimated Cost Microusd: 100000',
  },
  {
    id: 'e17',
    title: 'Shot Created',
    timestamp: '2026-09-06T02:10:00.000Z',
    sequence: 17,
    detail: 'Status: approved_for_generation · Ordinal: 1',
  },
];

export const RunTimeline = () => (
  <Surface>
    <EventTimeline
      events={events}
      intro="The stream is an update signal; refresh recovery always rebuilds from REST state."
    />
  </Surface>
);

export const Quiet = () => (
  <Surface>
      <EventTimeline events={[]} />
  </Surface>
);

export const Compact = () => (
  <Surface>
      <EventTimeline
        events={events.slice(0, 3)}
        totalCount={26}
        title="Recent activity"
      />
  </Surface>
);
