import type { ReactElement } from 'react';

export interface LoadingStateProps {
  /** Says what is loading — never a bare "Loading…". */
  readonly label: string;
}

/** The in-flight placeholder, announced politely to screen readers. */
export function LoadingState({ label }: LoadingStateProps): ReactElement {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  /** Says what will fill this space, so the emptiness reads as expected. */
  readonly detail: string;
}

/** The nothing-here-yet placeholder. */
export function EmptyState({ title, detail }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}
