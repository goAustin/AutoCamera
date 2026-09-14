import {
  type FormEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import {
  acceptAttempt,
  applyRecommendation,
  ApiError,
  createRun,
  dismissRecommendation,
  fetchArtifact,
  fetchProjectEventStream,
  getAttemptDetail,
  getRun,
  listRecommendations,
  listRuns,
  rejectAttempt,
  retryAttempt,
  pinRun,
  reviewRun,
  unpinRun,
  validateWorkflowRevision,
  type Attempt,
  type Evaluation,
  type OperatorRecommendation,
  type ProjectEvent,
  type RunRecord,
  type WorkflowRevision,
} from './api.js';
import {
  createPanelBridgeMessage,
  validateComfyBridgeEvent,
  readManagedBridgeContext,
  type BridgeParentMessage,
} from './bridge.js';
import {
  buildFakeWorkflowGraphs,
  DEFAULT_FAKE_WORKFLOW_SETTINGS,
  extractFakeWorkflowSettings,
  MINIMAX_H3_PROFILE_ID,
} from './workflow-fixture.js';

const TOKEN_STORAGE_KEY = 'h3-videoops-development-token';
const ACTIVE_ATTEMPT_STATUSES = new Set([
  'queued',
  'claimed',
  'submitting',
  'submitted',
  'running',
  'generated',
  'evaluating',
]);
const RETRYABLE_ATTEMPT_STATUSES = new Set(['failed', 'timed_out', 'rejected']);

function readStoredToken(): string | null {
  try {
    const value = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    return value?.trim() || null;
  } catch {
    return null;
  }
}

function rememberToken(token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Session storage is deliberately best-effort for local development.
  }
}

function forgetToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Session storage is deliberately best-effort for local development.
  }
}

function humanize(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : value;
}

function formatDuration(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}s`;
}

function formatMoney(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2) : value;
  return `$${text}`;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message}${error.code ? ` (${error.code})` : ''}`;
  }
  if (error instanceof Error) return error.message;
  return 'The request could not be completed.';
}

function errorTrace(error: unknown): string | undefined {
  return error instanceof ApiError ? error.traceId : undefined;
}

function statusClass(status: string): string {
  if (
    status === 'accepted' ||
    status === 'completed' ||
    status === 'validated' ||
    status === 'passed' ||
    status === 'ok'
  ) {
    return 'status-badge status-badge--positive';
  }
  if (
    status === 'failed' ||
    status === 'timed_out' ||
    status === 'invalid' ||
    status === 'critical' ||
    status === 'needs_attention'
  ) {
    return 'status-badge status-badge--negative';
  }
  if (
    status === 'queued' ||
    status === 'running' ||
    status === 'generating' ||
    status === 'planning' ||
    status === 'evaluating'
  ) {
    return 'status-badge status-badge--active';
  }
  return 'status-badge';
}

function StatusBadge({ status }: { readonly status: string }): ReactElement {
  return <span className={statusClass(status)}>{humanize(status)}</span>;
}

function ErrorNotice({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}): ReactElement {
  const traceId = errorTrace(error);
  return (
    <div className="notice notice--error" role="alert">
      <strong>{errorText(error)}</strong>
      {traceId && <span>Trace {traceId}</span>}
      {onRetry && (
        <button
          className="button button--quiet"
          type="button"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

function InfoNotice({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return <div className="notice notice--info">{children}</div>;
}

function ConfirmPanel({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
}): ReactElement {
  return (
    <div className="confirm-panel" role="alertdialog" aria-label={title}>
      <strong>{title}</strong>
      <p>{detail}</p>
      <div className="button-row">
        <button
          className="button button--quiet"
          type="button"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="button button--primary"
          type="button"
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  );
}

function TokenGate({
  onAuthenticated,
  embedded = false,
}: {
  readonly onAuthenticated: (token: string) => void;
  readonly embedded?: boolean;
}): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError('Enter the local development bearer token to continue.');
      return;
    }
    rememberToken(token);
    onAuthenticated(token);
  };

  return (
    <main
      className={embedded ? 'auth-shell auth-shell--embedded' : 'auth-shell'}
    >
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="eyebrow">
          {embedded
            ? 'VIDEOOPS MANAGED RUN PANEL'
            : 'AUTHENTICATED PROJECT STUDIO'}
        </p>
        <h1 id="auth-title">
          {embedded ? 'Connect this panel.' : 'Connect this studio.'}
        </h1>
        <p className="lede">
          This local studio uses a development bearer token. It is held only in
          this Studio-origin browser session and is never passed to the ComfyUI
          origin.
        </p>
        <form className="stack-form" onSubmit={submit}>
          <label htmlFor="dev-token">Development token</label>
          <input
            id="dev-token"
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="DEV_AUTH_TOKEN"
            aria-describedby={error ? 'token-error' : undefined}
          />
          {error && (
            <span id="token-error" className="field-error">
              {error}
            </span>
          )}
          <button className="button button--primary" type="submit">
            {embedded ? 'Connect VideoOps' : 'Enter Project Studio'}
          </button>
        </form>
      </section>
    </main>
  );
}

function AppShell({
  onSignOut,
  children,
}: {
  readonly onSignOut: () => void;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <div className="app-frame">
      <header className="app-header">
        <Link className="brand" to="/" aria-label="H3 VideoOps home">
          <span className="brand-mark" aria-hidden="true">
            H3
          </span>
          <span>
            <strong>VideoOps</strong>
            <small>Project Studio</small>
          </span>
        </Link>
        <div className="header-actions">
          <span className="header-mode">Local development</span>
          <button
            className="button button--quiet"
            type="button"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function LoadingState({ label }: { readonly label: string }): ReactElement {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

function EmptyState({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}): ReactElement {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function RevisionHistory({
  revisions,
  selectedRevisionId,
  onUse,
  onValidate,
  validatingId,
}: {
  readonly revisions: readonly Omit<WorkflowRevision, 'shotId'>[];
  readonly selectedRevisionId?: string | undefined;
  readonly onUse?: (revision: Omit<WorkflowRevision, 'shotId'>) => void;
  readonly onValidate: (revision: Omit<WorkflowRevision, 'shotId'>) => void;
  readonly validatingId?: string | undefined;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="revision-history-title">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">IMMUTABLE HISTORY</span>
          <h3 id="revision-history-title">Workflow revisions</h3>
        </div>
        <span className="count-badge">{revisions.length}</span>
      </div>
      {revisions.length === 0 && (
        <EmptyState
          title="No revisions yet"
          detail="Create a revision after saving or exporting a draft."
        />
      )}
      {revisions.length > 0 && (
        <ol className="revision-list">
          {revisions.map((revision) => (
            <li
              className={
                revision.id === selectedRevisionId
                  ? 'revision-item revision-item--selected'
                  : 'revision-item'
              }
              key={revision.id}
            >
              <div className="revision-heading">
                <strong>Revision {revision.revisionNumber}</strong>
                <StatusBadge status={revision.validationStatus} />
              </div>
              <div className="revision-meta">
                <span>{revision.source}</span>
                <span>{formatDate(revision.createdAt)}</span>
              </div>
              <code title={revision.executionHash}>
                {revision.executionHash.slice(0, 16)}…
              </code>
              {revision.parentRevisionId && (
                <span className="muted">
                  Parent {revision.parentRevisionId.slice(0, 8)}…
                </span>
              )}
              {revision.validationErrors.length > 0 && (
                <ul className="validation-list">
                  {revision.validationErrors.map((issue) => (
                    <li key={`${issue.code}-${issue.message}`}>
                      <strong>{issue.code}</strong> {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="button-row">
                {onUse && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => onUse(revision)}
                  >
                    Use revision
                  </button>
                )}
                {revision.validationStatus !== 'validated' && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => onValidate(revision)}
                    disabled={validatingId === revision.id}
                  >
                    {validatingId === revision.id
                      ? 'Validating…'
                      : 'Validate again'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvaluationPanel({
  evaluation,
}: {
  readonly evaluation: Evaluation | undefined;
}): ReactElement {
  if (!evaluation)
    return (
      <InfoNotice>
        Technical evaluation is not available yet. The worker will add it after
        artifact ingestion.
      </InfoNotice>
    );
  return (
    <div className="evaluation-panel">
      <div className="evaluation-heading">
        <strong>Technical evaluation</strong>
        <StatusBadge status={evaluation.status} />
      </div>
      <div className="check-grid">
        {Object.entries(evaluation.checks).map(([name, check]) => (
          <div className="check-row" key={name}>
            <span>{humanize(name)}</span>
            <StatusBadge status={check.status} />
            <small>{check.detail}</small>
          </div>
        ))}
      </div>
      <dl className="compact-details compact-details--horizontal">
        {Object.entries(evaluation.details)
          .filter(([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value),
          )
          .map(([name, value]) => (
            <div key={name}>
              <dt>{humanize(name)}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
      </dl>
      <small className="muted">
        Evaluator {evaluation.evaluatorVersion} ·{' '}
        {formatDate(evaluation.evaluatedAt)}
      </small>
    </div>
  );
}

function ArtifactPlayer({
  token,
  artifactId,
}: {
  readonly token: string;
  readonly artifactId: string;
}): ReactElement {
  const [source, setSource] = useState<string | undefined>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setSource(undefined);
    setError(undefined);
    void fetchArtifact(token, artifactId, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, token]);
  if (error) return <ErrorNotice error={error} />;
  if (!source) return <LoadingState label="Loading authorized artifact…" />;
  return (
    <video className="artifact-player" controls preload="metadata" src={source}>
      <track kind="captions" />
    </video>
  );
}

function progressForAttempt(
  events: readonly ProjectEvent[],
  attemptId: string,
): { readonly value: number; readonly max: number } | undefined {
  let current: { readonly value: number; readonly max: number } | undefined;
  for (const event of events) {
    if (event.attemptId !== attemptId) continue;
    const value = event.payload.value;
    const max = event.payload.max;
    if (typeof value === 'number' && typeof max === 'number' && max > 0)
      current = { value, max };
  }
  return current;
}

function AttemptCard({
  token,
  attempt,
  events,
  invalidateProject,
}: {
  readonly token: string;
  readonly attempt: Omit<Attempt, 'shotId'>;
  readonly events: readonly ProjectEvent[];
  readonly invalidateProject: () => void;
}): ReactElement {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('VISUAL_REVIEW');
  const [retryOpen, setRetryOpen] = useState(false);
  const detailQuery = useQuery({
    queryKey: ['attempt', attempt.id],
    queryFn: () => getAttemptDetail(token, attempt.id),
    refetchInterval: (query) => {
      const detailStatus = query.state.data?.attempt.status;
      const waitingForEvaluation =
        attempt.status === 'awaiting_review' &&
        query.state.data?.evaluation === undefined;
      return ACTIVE_ATTEMPT_STATUSES.has(attempt.status) ||
        ACTIVE_ATTEMPT_STATUSES.has(detailStatus ?? '') ||
        waitingForEvaluation
        ? 2_000
        : false;
    },
  });
  const detail: {
    readonly attempt: Omit<Attempt, 'shotId'>;
    readonly evaluation?: Evaluation;
  } = detailQuery.data ?? { attempt };
  const reviewMutation = useMutation({
    mutationFn: (action: 'accept' | 'reject') =>
      action === 'accept'
        ? acceptAttempt(token, attempt.id)
        : rejectAttempt(token, attempt.id, reason),
    onSuccess: () => {
      setRejectOpen(false);
      invalidateProject();
    },
  });
  const retryMutation = useMutation({
    mutationFn: (resolveUncertain: boolean) =>
      retryAttempt(token, attempt.id, resolveUncertain),
    onSuccess: () => {
      setRetryOpen(false);
      invalidateProject();
    },
  });
  const progress = progressForAttempt(events, attempt.id);
  const progressPercent = progress
    ? Math.min(100, Math.max(0, (progress.value / progress.max) * 100))
    : undefined;
  const uncertain = attempt.failureCode === 'COMFY_SUBMISSION_UNCERTAIN';
  const evaluation = detail.evaluation;
  return (
    <article className="attempt-card" aria-labelledby={`attempt-${attempt.id}`}>
      <div className="attempt-heading">
        <div>
          <span className="section-kicker">ATTEMPT</span>
          <h4 id={`attempt-${attempt.id}`}>{attempt.id.slice(0, 12)}…</h4>
        </div>
        <StatusBadge status={attempt.status} />
      </div>
      <dl className="attempt-facts">
        <div>
          <dt>Queued</dt>
          <dd>{formatDate(attempt.queuedAt)}</dd>
        </div>
        <div>
          <dt>Profile hash</dt>
          <dd>
            <code>{attempt.workflowHash.slice(0, 12)}…</code>
          </dd>
        </div>
        <div>
          <dt>Parameters</dt>
          <dd>
            {attempt.requestedWidth}×{attempt.requestedHeight} ·{' '}
            {formatDuration(attempt.requestedDurationSeconds)} · seed{' '}
            {attempt.seed}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatMoney(attempt.estimatedCostUsd)}</dd>
        </div>
        {attempt.sourceAttemptId && (
          <div>
            <dt>Derived from</dt>
            <dd>{attempt.sourceAttemptId.slice(0, 12)}…</dd>
          </div>
        )}
        {attempt.failureCode && (
          <div>
            <dt>Failure</dt>
            <dd>{attempt.failureCode}</dd>
          </div>
        )}
      </dl>
      {progressPercent !== undefined && (
        <div
          className="progress-block"
          role="progressbar"
          aria-label={`Progress ${Math.round(progressPercent)} percent`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPercent)}
        >
          <div className="progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <span>{Math.round(progressPercent)}% · worker event stream</span>
        </div>
      )}
      {attempt.failureMessage && (
        <p className="failure-copy">{attempt.failureMessage}</p>
      )}
      {attempt.artifactId && (
        <ArtifactPlayer token={token} artifactId={attempt.artifactId} />
      )}
      {detailQuery.isError && (
        <ErrorNotice
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
        />
      )}
      <EvaluationPanel evaluation={evaluation} />
      {reviewMutation.isError && <ErrorNotice error={reviewMutation.error} />}
      {retryMutation.isError && <ErrorNotice error={retryMutation.error} />}
      {retryOpen && (
        <ConfirmPanel
          title={
            uncertain
              ? 'Resolve and retry this attempt?'
              : 'Spend budget on a derived retry?'
          }
          detail={
            uncertain
              ? 'The original ComfyUI submission is uncertain. Confirm that a human has resolved that uncertainty before creating a new attempt.'
              : 'This creates a new immutable attempt and reserves the server-enforced preview cost. The source attempt remains terminal.'
          }
          confirmLabel={uncertain ? 'Confirm resolved retry' : 'Confirm retry'}
          onCancel={() => setRetryOpen(false)}
          onConfirm={() => retryMutation.mutate(uncertain)}
          busy={retryMutation.isPending}
        />
      )}
      {rejectOpen && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            reviewMutation.mutate('reject');
          }}
        >
          <label htmlFor={`reject-reason-${attempt.id}`}>
            Review reason code
          </label>
          <input
            id={`reject-reason-${attempt.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value.toUpperCase())}
            maxLength={64}
            required
          />
          <div className="button-row">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setRejectOpen(false)}
            >
              Cancel
            </button>
            <button
              className="button button--danger"
              type="submit"
              disabled={reviewMutation.isPending}
            >
              Reject attempt
            </button>
          </div>
        </form>
      )}
      <div className="button-row attempt-actions">
        {attempt.status === 'awaiting_review' && (
          <>
            <button
              className="button button--primary"
              type="button"
              onClick={() => reviewMutation.mutate('accept')}
              disabled={
                reviewMutation.isPending || evaluation?.status !== 'passed'
              }
            >
              Accept passing attempt
            </button>
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setRejectOpen(true)}
              disabled={reviewMutation.isPending}
            >
              Reject
            </button>
          </>
        )}
        {RETRYABLE_ATTEMPT_STATUSES.has(attempt.status) && (
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setRetryOpen(true)}
            disabled={retryMutation.isPending}
          >
            Retry with confirmation
          </button>
        )}
      </div>
    </article>
  );
}

function RecommendationPanel({
  token,
  projectId,
  recommendations,
  invalidateProject,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly recommendations: readonly OperatorRecommendation[];
  readonly invalidateProject: () => void;
}): ReactElement {
  const [confirmId, setConfirmId] = useState<string>();
  const applyMutation = useMutation({
    mutationFn: (recommendation: OperatorRecommendation) =>
      applyRecommendation(
        token,
        projectId,
        recommendation.id,
        recommendation.version,
      ),
    onSuccess: () => {
      setConfirmId(undefined);
      invalidateProject();
    },
  });
  const dismissMutation = useMutation({
    mutationFn: (recommendation: OperatorRecommendation) =>
      dismissRecommendation(
        token,
        projectId,
        recommendation.id,
        recommendation.version,
      ),
    onSuccess: invalidateProject,
  });
  const pending = recommendations.filter(
    (recommendation) => recommendation.status === 'pending',
  );
  return (
    <section className="panel" aria-labelledby="recommendations-title">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">OPERATIONS / PI</span>
          <h3 id="recommendations-title">Recommendations</h3>
        </div>
        <span className="count-badge">{pending.length}</span>
      </div>
      <p className="panel-intro">
        Pi receives sanitized VideoOps evidence and proposes bounded actions. A
        human must apply or dismiss each recommendation.
      </p>
      {pending.length === 0 && (
        <EmptyState
          title="No pending recommendations"
          detail="Operational signals will appear here when the durable event loop needs attention."
        />
      )}
      <ul className="recommendation-list">
        {pending.map((recommendation) => (
          <li className="recommendation-card" key={recommendation.id}>
            <div className="recommendation-heading">
              <StatusBadge status={recommendation.severity} />
              <strong>{recommendation.title}</strong>
            </div>
            <p>{recommendation.detail}</p>
            <div className="recommendation-meta">
              <span>{recommendation.recommendationCode}</span>
              <span>Action: {humanize(recommendation.proposedActionType)}</span>
            </div>
            {confirmId === recommendation.id &&
              recommendation.proposedActionType === 'retry_attempt' && (
                <ConfirmPanel
                  title="Apply a budget-spending recommendation?"
                  detail="This human-approved action will create a derived retry after the server rechecks scope, limits, budget, workflow validation, and executor capability."
                  confirmLabel="Apply and retry"
                  onCancel={() => setConfirmId(undefined)}
                  onConfirm={() => applyMutation.mutate(recommendation)}
                  busy={applyMutation.isPending}
                />
              )}
            {applyMutation.isError && (
              <ErrorNotice error={applyMutation.error} />
            )}
            {dismissMutation.isError && (
              <ErrorNotice error={dismissMutation.error} />
            )}
            <div className="button-row">
              <button
                className="button button--primary"
                type="button"
                onClick={() =>
                  recommendation.proposedActionType === 'retry_attempt'
                    ? setConfirmId(recommendation.id)
                    : applyMutation.mutate(recommendation)
                }
                disabled={applyMutation.isPending}
              >
                Apply recommendation
              </button>
              <button
                className="button button--quiet"
                type="button"
                onClick={() => dismissMutation.mutate(recommendation)}
                disabled={dismissMutation.isPending}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventTimeline({
  events,
}: {
  readonly events: readonly ProjectEvent[];
}): ReactElement {
  const safePayloadKeys = new Set([
    'status',
    'code',
    'recoverable',
    'value',
    'max',
    'artifactId',
    'evaluationId',
    'reasonCode',
    'workflowRevisionId',
    'sourceAttemptId',
    'estimatedCostMicrousd',
    'acceptedShotCount',
    'shotCount',
    'ordinal',
  ]);
  const recent = events.slice(-24).reverse();
  return (
    <section className="panel" aria-labelledby="timeline-title">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">DURABLE EVENTS / SSE</span>
          <h3 id="timeline-title">Project timeline</h3>
        </div>
        <span className="count-badge">{events.length}</span>
      </div>
      <p className="panel-intro">
        The stream is an update signal; refresh recovery always rebuilds from
        REST state.
      </p>
      {recent.length === 0 && (
        <EmptyState
          title="Timeline is quiet"
          detail="Project and worker events will be recorded here."
        />
      )}
      <ol className="timeline-list">
        {recent.map((event) => {
          const details = Object.entries(event.payload).filter(
            ([key, value]) =>
              safePayloadKeys.has(key) &&
              ['string', 'number', 'boolean'].includes(typeof value),
          );
          return (
            <li key={`${event.id}-${event.eventSequence ?? ''}`}>
              <span className="timeline-dot" aria-hidden="true" />
              <div>
                <strong>{humanize(event.type)}</strong>
                <small>
                  {formatDate(event.occurredAt)}
                  {event.eventSequence ? ` · #${event.eventSequence}` : ''}
                </small>
                {details.length > 0 && (
                  <span className="timeline-detail">
                    {details
                      .map(
                        ([key, value]) => `${humanize(key)}: ${String(value)}`,
                      )
                      .join(' · ')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type ManagedBridgeContext = NonNullable<
  ReturnType<typeof readManagedBridgeContext>
>;
type ExportedWorkflowMessage = Extract<
  BridgeParentMessage,
  { readonly type: 'workflow.exported' }
>;
type ManagedLiveEvent = Awaited<
  ReturnType<typeof fetchProjectEventStream>
>[number];

function shortRunId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function progressFromEvents(
  runEvents: readonly ProjectEvent[],
  liveEvents: readonly ManagedLiveEvent[],
  runId: string,
): { readonly value: number; readonly max: number } | undefined {
  let latest: { readonly value: number; readonly max: number } | undefined;
  for (const event of runEvents) {
    if (
      event.type !== 'attempt.execution_progress' ||
      (event.attemptId !== undefined && event.attemptId !== runId)
    ) {
      continue;
    }
    const value = event.payload.value;
    const max = event.payload.max;
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      typeof max === 'number' &&
      Number.isFinite(max) &&
      max > 0
    ) {
      latest = { value: Math.max(0, value), max };
    }
  }
  for (const event of liveEvents) {
    const data = event.data;
    const payload = data.payload;
    const eventAttemptId =
      typeof data.attemptId === 'string'
        ? data.attemptId
        : isPlainObject(payload) && typeof payload.attemptId === 'string'
          ? payload.attemptId
          : undefined;
    if (event.type !== 'attempt.execution_progress' || eventAttemptId !== runId)
      continue;
    const value = isPlainObject(payload) ? payload.value : undefined;
    const max = isPlainObject(payload) ? payload.max : undefined;
    if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      typeof max === 'number' &&
      Number.isFinite(max) &&
      max > 0
    ) {
      latest = { value: Math.max(0, value), max };
    }
  }
  return latest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Node classes the pinned H3 template carries that resolution legitimately
 * collapses away: the parameter helpers, and the turbo LoRA branch that
 * `ComfySwitchNode` deselects for the preview profile.
 */
const RESOLVABLE_HELPER_NODE_CLASSES = new Set([
  'ResolutionSelector',
  'ComfyMathExpression',
  'ComfySwitchNode',
  'PrimitiveInt',
  'PrimitiveFloat',
  'PrimitiveBoolean',
  'LoraLoaderModelOnly',
]);

function apiGraphNodeClasses(graph: unknown): readonly string[] {
  if (!isPlainObject(graph)) return [];
  return Object.values(graph)
    .map((node) =>
      isPlainObject(node)
        ? (node as { class_type?: unknown }).class_type
        : undefined,
    )
    .filter((value): value is string => typeof value === 'string');
}

/**
 * The pinned H3 profile executes only a resolved graph: the editor's helper
 * nodes (resolution pickers, math expressions, switches, primitives) must be
 * collapsed into literal parameters before submission. Studio derives that
 * resolved form from the exported graph, which is a faithful compilation only
 * while the export stays within the node classes the resolver understands.
 *
 * Anything outside that set means the user changed something the resolver
 * cannot express. Submitting the resolved graph anyway would silently drop the
 * edit and store an execution hash for a workflow the user never built, so
 * refuse instead of narrowing in silence.
 */
export function unresolvableNodeClasses(
  exportedApiGraph: unknown,
  resolvedApiGraph: unknown,
): readonly string[] {
  const known = new Set([
    ...RESOLVABLE_HELPER_NODE_CLASSES,
    ...apiGraphNodeClasses(resolvedApiGraph),
  ]);
  return [
    ...new Set(
      apiGraphNodeClasses(exportedApiGraph).filter(
        (nodeClass) => !known.has(nodeClass),
      ),
    ),
  ].sort();
}

interface RunViewSnapshot {
  readonly runsLoaded: boolean;
  readonly runs: readonly RunRecord[];
  readonly run: RunRecord | undefined;
  readonly progress:
    | { readonly value: number; readonly max: number }
    | undefined;
  readonly pendingFindingCount: number;
}

/**
 * Run list, run detail, progress, evaluation status, findings, revision
 * restore, pin, and review. No bridge, no `postMessage`, no ComfyUI-origin
 * awareness whatsoever: `ManagedPanelPage` mounts this alongside the bridge
 * for the ComfyUI sidebar, and `StandaloneRunPage` mounts it alone at `/` so
 * the durable record stays readable when no ComfyUI origin exists at all.
 *
 * `onRunSnapshot` and `onLoadRevision` are the only seams `ManagedPanelPage`
 * needs: the first lets it read the currently selected run (for the
 * ComfyUI status-feed payload) without this component knowing that feed
 * exists; the second lets it push a revision's graph back into ComfyUI
 * without this component ever importing `postMessage`.
 */
function RunView({
  token,
  selectRunId,
  onRunSnapshot,
  onLoadRevision,
}: {
  readonly token: string;
  readonly selectRunId?: string | undefined;
  readonly onRunSnapshot?: (snapshot: RunViewSnapshot) => void;
  readonly onLoadRevision?: (
    revision: Omit<WorkflowRevision, 'shotId'>,
  ) => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>();
  const [liveEvents, setLiveEvents] = useState<readonly ManagedLiveEvent[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const liveEventCursor = useRef(0);

  const runsQuery = useQuery({
    queryKey: ['managed-runs'],
    queryFn: () => listRuns(token, { limit: 50 }),
    refetchInterval: 3_000,
  });
  const runs = runsQuery.data?.runs ?? [];
  const selectedRun = runs.find((run) => run.runId === selectedRunId);
  const runQuery = useQuery({
    queryKey: ['managed-run', selectedRunId],
    queryFn: () => getRun(token, selectedRunId ?? ''),
    enabled: Boolean(selectedRunId),
    refetchInterval: 2_000,
  });
  const run = runQuery.data ?? selectedRun;
  const revision = run?.revision;
  const findingsQuery = useQuery({
    queryKey: ['managed-run-findings', run?.projectId],
    queryFn: () => listRecommendations(token, run?.projectId ?? ''),
    enabled: Boolean(run?.projectId),
    refetchInterval: 5_000,
  });
  const findings = findingsQuery.data?.recommendations ?? [];
  const pendingFindings = findings.filter(
    (finding) => finding.status === 'pending',
  );
  const progress = run
    ? progressFromEvents(run.events, liveEvents, run.runId)
    : undefined;

  useEffect(() => {
    if (selectedRunId && runs.some((item) => item.runId === selectedRunId))
      return;
    const first = runs[0];
    if (first) setSelectedRunId(first.runId);
  }, [runs, selectedRunId]);

  // The only inbound seam from `ManagedPanelPage`: a run created from a
  // ComfyUI export should become the selected run here, exactly as it did
  // before the bridge and the run list lived in the same component.
  useEffect(() => {
    if (selectRunId !== undefined) setSelectedRunId(selectRunId);
  }, [selectRunId]);

  useEffect(() => {
    const projectId = run?.projectId;
    liveEventCursor.current = 0;
    setLiveEvents([]);
    if (!projectId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      if (!active) return;
      try {
        const events = await fetchProjectEventStream(
          token,
          projectId,
          liveEventCursor.current,
        );
        if (!active) return;
        if (events.length > 0) {
          liveEventCursor.current = Math.max(
            liveEventCursor.current,
            ...events.map((event) => event.id),
          );
          setLiveEvents((current) => [...current, ...events].slice(-100));
          void runQuery.refetch();
        }
      } catch {
        // The panel keeps polling REST truth when replay is unavailable.
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 2_500);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [run?.projectId, runQuery.refetch, token]);

  // The only outbound seam to `ManagedPanelPage`: it needs the selected run,
  // the run list, computed progress, and the pending-finding count to build
  // the ComfyUI status-feed payload and to decide whether to show the
  // "first run" onboarding panel. Neither of those is this component's
  // concern, so it exposes the raw ingredients instead of the bridge shape.
  useEffect(() => {
    onRunSnapshot?.({
      runsLoaded: runsQuery.isSuccess,
      runs,
      run,
      progress,
      pendingFindingCount: pendingFindings.length,
    });
  }, [
    onRunSnapshot,
    runsQuery.isSuccess,
    runs,
    run,
    progress,
    pendingFindings.length,
  ]);

  const pinMutation = useMutation({
    mutationFn: (runId: string) => pinRun(token, runId),
    onSuccess: (updated) => {
      setSelectedRunId(updated.runId);
      void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
      void runQuery.refetch();
    },
  });
  const unpinMutation = useMutation({
    mutationFn: (runId: string) => unpinRun(token, runId),
    onSuccess: (updated) => {
      setSelectedRunId(updated.runId);
      void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
      void runQuery.refetch();
    },
  });
  const reviewMutation = useMutation({
    mutationFn: (input: {
      readonly runId: string;
      readonly decision: 'accepted' | 'rejected';
    }) =>
      reviewRun(token, input.runId, {
        decision: input.decision,
        ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}),
      }),
    onSuccess: (updated) => {
      setReviewNote('');
      setSelectedRunId(updated.runId);
      setNotice(`Run annotated ${updated.review?.decision ?? 'reviewed'}.`);
      void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
      void runQuery.refetch();
    },
  });
  const validateMutation = useMutation({
    mutationFn: (revisionId: string) =>
      validateWorkflowRevision(token, revisionId),
    onSuccess: (result) => {
      setNotice(
        result.validation.valid
          ? 'Revision validated against the current executor.'
          : 'Revision remains invalid; review the correction details.',
      );
      void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
      if (run)
        void queryClient.invalidateQueries({
          queryKey: ['managed-run', run.runId],
        });
    },
  });

  // Shared invalidation for the carried-over `AttemptCard` and
  // `RecommendationPanel`, which each expect a single "something about this
  // project may have changed" callback rather than the run-scoped query keys
  // this view happens to use.
  const invalidateRunState = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
    if (run) {
      void queryClient.invalidateQueries({
        queryKey: ['managed-run', run.runId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['managed-run-findings', run.projectId],
      });
    }
  }, [queryClient, run]);

  return (
    <>
      {runsQuery.isError && <ErrorNotice error={runsQuery.error} />}
      {pinMutation.isError && <ErrorNotice error={pinMutation.error} />}
      {unpinMutation.isError && <ErrorNotice error={unpinMutation.error} />}
      {reviewMutation.isError && <ErrorNotice error={reviewMutation.error} />}
      {validateMutation.isError && (
        <ErrorNotice error={validateMutation.error} />
      )}
      {notice && <InfoNotice>{notice}</InfoNotice>}
      <div className="managed-panel-grid">
        <section
          className="managed-history panel"
          aria-labelledby="managed-history-title"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">DURABLE RUNS</span>
              <h2 id="managed-history-title">History</h2>
            </div>
            <span className="count-badge">{runs.length}</span>
          </div>
          {runsQuery.isPending && <LoadingState label="Loading run history…" />}
          {runs.length === 0 && runsQuery.isSuccess && (
            <EmptyState
              title="No managed runs"
              detail="Managed Run exports will be recorded here."
            />
          )}
          <ol className="managed-run-list">
            {runs.map((item) => (
              <li key={item.runId}>
                <button
                  className={
                    item.runId === run?.runId
                      ? 'managed-run-item managed-run-item--selected'
                      : 'managed-run-item'
                  }
                  type="button"
                  aria-pressed={item.runId === run?.runId}
                  onClick={() => setSelectedRunId(item.runId)}
                >
                  <span>
                    <strong>{shortRunId(item.runId)}</strong>
                    <small>{formatDate(item.attempt.createdAt)}</small>
                  </span>
                  <StatusBadge status={item.status} />
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section
          className="managed-detail panel"
          aria-labelledby="managed-detail-title"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">RUN / RESULT / REVIEW</span>
              <h2 id="managed-detail-title">Selected run</h2>
            </div>
          </div>
          {!run && (
            <EmptyState
              title="Select a run"
              detail="Run status, evaluation, findings, and review controls will appear here."
            />
          )}
          {run && (
            <>
              <dl className="managed-facts">
                <div>
                  <dt>Run ID</dt>
                  <dd>{run.runId}</dd>
                </div>
                <div>
                  <dt>Evaluation</dt>
                  <dd>{humanize(run.evaluationStatus)}</dd>
                </div>
                <div>
                  <dt>Estimated cost</dt>
                  <dd>{formatMoney(run.cost.estimatedCostUsd)}</dd>
                </div>
                <div>
                  <dt>Budget headroom</dt>
                  <dd>
                    {run.cost.projectRemainingUsd === null
                      ? 'Not budgeted'
                      : formatMoney(run.cost.projectRemainingUsd)}
                  </dd>
                </div>
                <div>
                  <dt>Keeper</dt>
                  <dd>{run.pinned ? 'Pinned' : 'Not pinned'}</dd>
                </div>
                <div>
                  <dt>Review</dt>
                  <dd>
                    {run.review?.decision
                      ? humanize(run.review.decision)
                      : 'Not annotated'}
                  </dd>
                </div>
              </dl>
              <div className="button-row">
                {revision && onLoadRevision && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() => onLoadRevision(revision)}
                  >
                    Load revision in ComfyUI
                  </button>
                )}
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() =>
                    run.pinned
                      ? unpinMutation.mutate(run.runId)
                      : pinMutation.mutate(run.runId)
                  }
                  disabled={pinMutation.isPending || unpinMutation.isPending}
                >
                  {run.pinned ? 'Unpin keeper' : 'Pin keeper'}
                </button>
              </div>
              <section
                className="managed-subsection"
                aria-labelledby="managed-progress-title"
              >
                <div className="panel-heading">
                  <h3 id="managed-progress-title">Progress and trace</h3>
                  <span className="live-chip">Live SSE</span>
                </div>
                {progress ? (
                  <progress max={progress.max} value={progress.value} />
                ) : (
                  <p className="muted">No execution progress reported yet.</p>
                )}
                {run.attempt.failureCode && (
                  <p className="failure-line">
                    {run.attempt.failureCode}:{' '}
                    {run.attempt.failureMessage ?? 'Execution failed.'}
                  </p>
                )}
                {run.attempt.traceId && (
                  <p className="trace-line">Trace ID: {run.attempt.traceId}</p>
                )}
                <p className="muted">
                  Node durations: not recorded in the durable Phase 7 feed.
                </p>
                {run.artifact && (
                  <p>
                    Artifact recorded: {String(run.artifact.id ?? 'available')}
                  </p>
                )}
              </section>
              {revision && (
                <RevisionHistory
                  revisions={[revision]}
                  selectedRevisionId={revision.id}
                  onValidate={(target) => validateMutation.mutate(target.id)}
                  validatingId={
                    validateMutation.isPending
                      ? validateMutation.variables
                      : undefined
                  }
                />
              )}
              <AttemptCard
                key={run.attempt.id}
                token={token}
                attempt={run.attempt}
                events={run.events}
                invalidateProject={invalidateRunState}
              />
              <RecommendationPanel
                token={token}
                projectId={run.projectId}
                recommendations={findings}
                invalidateProject={invalidateRunState}
              />
              <section
                className="managed-subsection"
                aria-labelledby="managed-review-title"
              >
                <div className="panel-heading">
                  <h3 id="managed-review-title">Human review</h3>
                </div>
                <textarea
                  aria-label="Review note"
                  rows={3}
                  maxLength={2_000}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  placeholder="Optional review note"
                />
                <div className="button-row">
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() =>
                      reviewMutation.mutate({
                        runId: run.runId,
                        decision: 'accepted',
                      })
                    }
                    disabled={reviewMutation.isPending}
                  >
                    Accept annotation
                  </button>
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={() =>
                      reviewMutation.mutate({
                        runId: run.runId,
                        decision: 'rejected',
                      })
                    }
                    disabled={reviewMutation.isPending}
                  >
                    Reject annotation
                  </button>
                </div>
              </section>
              <EventTimeline events={run.events} />
            </>
          )}
        </section>
      </div>
    </>
  );
}

/**
 * `RunView` plus the ComfyUI bridge. The bridge coupling is confined to this
 * component: `bridgeReady`, `handleExport`, `postToComfy`, the `message`
 * listener, and the status-feed effect. `RunView` itself never sees any of
 * it; this component observes `RunView`'s state through `onRunSnapshot` and
 * pushes graphs back into ComfyUI through `onLoadRevision`.
 */
function ManagedPanelPage({
  token,
  context,
  onSignOut,
}: {
  readonly token: string;
  readonly context: ManagedBridgeContext;
  readonly onSignOut: () => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const [bridgeReady, setBridgeReady] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | undefined>();
  const [bridgeNotice, setBridgeNotice] = useState<string | undefined>();
  const [requestedRunId, setRequestedRunId] = useState<string>();
  const [snapshot, setSnapshot] = useState<RunViewSnapshot>({
    runsLoaded: false,
    runs: [],
    run: undefined,
    progress: undefined,
    pendingFindingCount: 0,
  });
  const seenParentMessages = useRef(new Set<string>());
  const handledExports = useRef(new Set<string>());
  const defaultLoadSent = useRef(false);
  const statusSent = useRef('');

  const createRunMutation = useMutation({
    mutationFn: (message: ExportedWorkflowMessage) => {
      const settings = extractFakeWorkflowSettings(
        message.editorGraph,
        message.apiGraph,
        DEFAULT_FAKE_WORKFLOW_SETTINGS,
      );
      const resolvedGraphs = buildFakeWorkflowGraphs(settings);
      const unresolvable = unresolvableNodeClasses(
        message.apiGraph,
        resolvedGraphs.apiGraph,
      );
      if (unresolvable.length > 0) {
        throw new Error(
          `This graph uses nodes the managed H3 profile cannot resolve: ${unresolvable.join(', ')}. ` +
            'Managed runs currently support the pinned H3 template and its ' +
            'resolution, duration, seed and prompt controls. Remove the ' +
            'unsupported nodes, or run this graph outside managed mode.',
        );
      }
      return createRun(
        token,
        {
          editorGraph: message.editorGraph,
          apiGraph: resolvedGraphs.apiGraph,
          label: 'ComfyUI managed run',
          profileId: MINIMAX_H3_PROFILE_ID,
        },
        `run-export-${message.requestId}`,
      );
    },
    onSuccess: (result) => {
      if (result.runId) setRequestedRunId(result.runId);
      setBridgeNotice(
        result.runId
          ? `Managed run ${shortRunId(result.runId)} created.`
          : 'The graph was recorded with validation errors; no run was queued.',
      );
      void queryClient.invalidateQueries({ queryKey: ['managed-runs'] });
    },
  });
  const mutateCreateRun = createRunMutation.mutate;

  const handleExport = useCallback(
    (message: ExportedWorkflowMessage): void => {
      if (handledExports.current.has(message.requestId)) return;
      handledExports.current.add(message.requestId);
      mutateCreateRun(message);
    },
    [mutateCreateRun],
  );

  const postToComfy = useCallback(
    (
      type: 'workflow.load' | 'run.status',
      fields: Record<string, unknown>,
    ): void => {
      try {
        window.parent.postMessage(
          createPanelBridgeMessage(type, context.nonce, fields),
          context.parentOrigin,
        );
      } catch (error) {
        setBridgeError(
          error instanceof Error
            ? error.message
            : 'The managed panel could not send a bridge message.',
        );
      }
    },
    [context.nonce, context.parentOrigin],
  );

  useEffect(() => {
    seenParentMessages.current.clear();
    setBridgeReady(false);
    const parentWindow = window.parent;
    const handleMessage = (event: MessageEvent<unknown>): void => {
      try {
        const message = validateComfyBridgeEvent(
          { origin: event.origin, source: event.source, data: event.data },
          context.parentOrigin,
          parentWindow,
          context.nonce,
          seenParentMessages.current,
        );
        if (message.type === 'comfy.context') {
          setBridgeReady(true);
          setBridgeError(undefined);
        } else if (message.type === 'workflow.exported') {
          handleExport(message);
        } else if (message.type === 'bridge.error') {
          setBridgeError(`ComfyUI bridge error: ${message.code}.`);
        }
      } catch (error) {
        setBridgeError(
          error instanceof Error
            ? error.message
            : 'The managed panel rejected a bridge message.',
        );
      }
    };
    window.addEventListener('message', handleMessage);
    try {
      parentWindow.postMessage(
        createPanelBridgeMessage('panel.ready', context.nonce),
        context.parentOrigin,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error
          ? error.message
          : 'The managed panel could not announce readiness.',
      );
    }
    return () => window.removeEventListener('message', handleMessage);
  }, [context.nonce, context.parentOrigin, handleExport]);

  useEffect(() => {
    if (!bridgeReady || !snapshot.runsLoaded || snapshot.runs.length > 0)
      return;
    if (defaultLoadSent.current) return;
    defaultLoadSent.current = true;
    const template = buildFakeWorkflowGraphs(DEFAULT_FAKE_WORKFLOW_SETTINGS);
    postToComfy('workflow.load', { editorGraph: template.editorGraph });
    setBridgeNotice('The MiniMax H3 template is open in ComfyUI.');
  }, [bridgeReady, postToComfy, snapshot.runsLoaded, snapshot.runs]);

  const statusEvaluation = useMemo(() => {
    const run = snapshot.run;
    if (!run) return undefined;
    const activeRunCount = snapshot.runs.filter(
      (item) => item.status === 'queued' || item.status === 'running',
    ).length;
    const evaluation: Record<string, unknown> = {
      status: run.evaluationStatus,
      executorReadiness: 'managed-studio',
      activeRunCount,
      nodeDurations: { status: 'not-recorded' },
      openFindingCount: snapshot.pendingFindingCount,
    };
    if (snapshot.progress) evaluation.progress = snapshot.progress;
    if (run.cost.projectRemainingUsd !== null)
      evaluation.budgetHeadroom = run.cost.projectRemainingUsd;
    const failureCode = run.attempt.failureCode;
    const failureMessage = run.attempt.failureMessage;
    const traceId = run.attempt.traceId;
    if (failureCode || failureMessage) {
      evaluation.failure = {
        ...(failureCode ? { code: failureCode } : {}),
        ...(failureMessage ? { message: failureMessage.slice(0, 256) } : {}),
      };
    }
    if (traceId) evaluation.traceId = traceId;
    return evaluation;
  }, [snapshot]);

  useEffect(() => {
    const run = snapshot.run;
    if (!bridgeReady || !run || !statusEvaluation) {
      if (!bridgeReady) statusSent.current = '';
      return;
    }
    const signature = JSON.stringify({
      runId: run.runId,
      status: run.status,
      evaluation: statusEvaluation,
    });
    if (signature === statusSent.current) return;
    statusSent.current = signature;
    postToComfy('run.status', {
      runId: run.runId,
      status: run.status,
      evaluation: statusEvaluation,
    });
  }, [bridgeReady, postToComfy, snapshot, statusEvaluation]);

  const handleLoadRevision = useCallback(
    (revision: Omit<WorkflowRevision, 'shotId'>): void => {
      if (!revision.editorGraph) return;
      postToComfy('workflow.load', {
        editorGraph: revision.editorGraph,
        ...(revision.id ? { revisionId: revision.id } : {}),
      });
      setBridgeNotice(`Revision ${shortRunId(revision.id)} sent to ComfyUI.`);
    },
    [postToComfy],
  );

  return (
    <main className="managed-panel" aria-label="VideoOps managed run panel">
      <header className="managed-panel-header">
        <div>
          <p className="eyebrow">VIDEOOPS / MANAGED RUN PANEL</p>
          <h1>Run history</h1>
          <p className="managed-panel-lede">
            Studio controls the bearer token here. ComfyUI receives only the
            nonce-scoped workflow bridge.
          </p>
        </div>
        <div className="managed-panel-actions">
          <span
            className={
              bridgeReady
                ? 'bridge-status bridge-status--ready'
                : 'bridge-status'
            }
          >
            {bridgeReady ? 'ComfyUI connected' : 'Connecting…'}
          </span>
          <button
            className="button button--quiet"
            type="button"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </header>
      {bridgeError && <ErrorNotice error={new Error(bridgeError)} />}
      {createRunMutation.isError && (
        <ErrorNotice error={createRunMutation.error} />
      )}
      {bridgeNotice && <InfoNotice>{bridgeNotice}</InfoNotice>}
      {snapshot.runsLoaded && snapshot.runs.length === 0 && (
        <section className="managed-empty panel">
          <span className="section-kicker">FIRST RUN / MINIMAX H3</span>
          <h2>Template opened in ComfyUI</h2>
          <p>
            Edit the H3 graph in the ComfyUI canvas, then choose Managed Run. A
            run will appear here after Studio receives both graph forms.
          </p>
          <a
            className="button button--quiet"
            href="/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open the full run view
          </a>
        </section>
      )}
      <RunView
        token={token}
        selectRunId={requestedRunId}
        onRunSnapshot={setSnapshot}
        onLoadRevision={handleLoadRevision}
      />
    </main>
  );
}

/**
 * `RunView` mounted alone at `/`, for when no ComfyUI origin exists at all
 * (the rented-GPU topology in `infra/gpu-executor/README.md` destroys the
 * ComfyUI host between sessions). This is the only view of the durable
 * record at exactly the moment the record is all that is left, so it carries
 * playback, retry, and findings the same way the ComfyUI-embedded panel
 * does — same `RunView`, no bridge wrapped around it.
 */
function StandaloneRunPage({
  token,
}: {
  readonly token: string;
}): ReactElement {
  return (
    <main className="managed-panel" aria-label="H3 VideoOps run view">
      <header className="managed-panel-header">
        <div>
          <p className="eyebrow">VIDEOOPS / RUN VIEW</p>
          <h1>Run history</h1>
          <p className="managed-panel-lede">
            The durable execution and monitoring record for every submitted
            graph, readable even when no ComfyUI executor is running.
          </p>
        </div>
      </header>
      <RunView token={token} />
    </main>
  );
}

export function App(): ReactElement {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const queryClient = useQueryClient();
  const managedContext = useMemo(
    () => readManagedBridgeContext(window.location, document.referrer),
    [],
  );
  useEffect(() => {
    queryClient.clear();
  }, [queryClient]);
  if (!token)
    return (
      <TokenGate
        embedded={managedContext !== null}
        onAuthenticated={setToken}
      />
    );
  const signOut = (): void => {
    queryClient.clear();
    forgetToken();
    setToken(null);
  };
  if (managedContext)
    return (
      <ManagedPanelPage
        token={token}
        context={managedContext}
        onSignOut={signOut}
      />
    );
  return (
    <AppShell onSignOut={signOut}>
      <Routes>
        <Route path="/" element={<StandaloneRunPage token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
