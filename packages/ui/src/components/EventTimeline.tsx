import type { ReactElement } from 'react';
import { formatClock, formatDate } from '../format.js';
import type { TimelineEvent } from '../types.js';
import { EmptyState } from './StateBlock.js';
import { Panel } from './Panel.js';

export interface EventTimelineProps {
  /** Newest first. The caller decides how many to pass and what each says. */
  readonly events: readonly TimelineEvent[];
  /** Total count for the heading pill, when it differs from `events.length`. */
  readonly totalCount?: number | undefined;
  readonly title?: string | undefined;
  readonly kicker?: string | undefined;
  readonly intro?: string | undefined;
}

/** The durable record of what happened, as a vertical trail. */
export function EventTimeline({
  events,
  totalCount,
  title = 'Project timeline',
  kicker,
  intro,
}: EventTimelineProps): ReactElement {
  return (
    <Panel
      title={title}
      titleId="timeline-title"
      count={totalCount ?? events.length}
      kicker={kicker}
      intro={intro}
    >
      {events.length === 0 ? (
        <EmptyState
          title="Timeline is quiet"
          detail="Project and worker events will be recorded here."
        />
      ) : (
        <ol className="timeline-list">
          {events.map((event) => (
            <li key={event.id}>
              <span
                className="timeline-time"
                title={formatDate(event.timestamp)}
              >
                {formatClock(event.timestamp)}
              </span>
              <span className="timeline-dot" aria-hidden="true" />
              <div className="timeline-body">
                <strong>{event.title}</strong>
                {event.sequence !== undefined && (
                  <small>#{event.sequence}</small>
                )}
                {event.detail && (
                  <span className="timeline-detail">{event.detail}</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
