import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button.js';

export interface NoticeProps {
  readonly variant?: 'info' | 'error' | undefined;
  readonly children: ReactNode;
}

/** An inline message block: a dot plus the text, no left-border rail.
 * `error` takes `role="alert"` automatically. */
export function Notice({
  variant = 'info',
  children,
}: NoticeProps): ReactElement {
  return (
    <div
      className={`notice notice--${variant}`}
      role={variant === 'error' ? 'alert' : undefined}
    >
      <span className="notice-dot" aria-hidden="true" />
      <div className="notice-content">{children}</div>
    </div>
  );
}

export interface ErrorNoticeProps {
  /** Already-formatted message. The design system never inspects error objects. */
  readonly message: string;
  /** Correlation id shown under the message when the caller has one. */
  readonly traceId?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly retryLabel?: string | undefined;
}

/** The failure presentation used wherever a request can fail. */
export function ErrorNotice({
  message,
  traceId,
  onRetry,
  retryLabel = 'Retry request',
}: ErrorNoticeProps): ReactElement {
  return (
    <Notice variant="error">
      <strong>{message}</strong>
      {traceId && <span className="notice-trace">Trace {traceId}</span>}
      {onRetry && (
        <Button variant="quiet" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </Notice>
  );
}
