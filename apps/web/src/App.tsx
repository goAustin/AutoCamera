import {
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
  AppShell,
  ArtifactPlayer,
  AttemptSummary,
  Button,
  ConfirmPanel,
  EmptyState,
  ErrorNotice as UiErrorNotice,
  EvaluationPanel,
  type EvaluationView,
  EventTimeline as UiEventTimeline,
  FactList,
  formatDate,
  formatMoney,
  humanize,
  LoadingState,
  Notice,
  Panel,
  RecommendationList,
  type RecommendationView,
  RevisionHistory,
  shortId,
  StatusBadge,
  type TimelineEvent,
  TokenGate,
} from '@h3/ui';
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
  listProjectAttempts,
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
  type WorkflowRevisionResult,
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

/** A compact duration string ("6m", "2h", "3d") — no seconds precision, this
 * is a rail-row glance, not a stopwatch. */
function formatSpan(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** How long ago an ISO timestamp was, in the same compact vocabulary. */
function relativeAge(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  return formatSpan(Math.max(0, now - then));
}

/**
 * "3 attempts · 6m" has no direct field on `RunRecord` — there is no
 * attempts-count and no run-duration on the wire. Both are derived here from
 * `events`, which every rail row already carries: `attempt.queued` fires
 * once per attempt (a retry is a new attempt, and emits its own), so the
 * distinct count is exact; the span between the first and last recorded
 * event is the closest honest stand-in for "how long this run has taken."
 */
function railAttemptSummary(run: RunRecord): string {
  const attemptIds = new Set(
    run.events
      .filter((event) => event.type === 'attempt.queued')
      .map((event) => event.attemptId ?? event.id),
  );
  const attempts = attemptIds.size > 0 ? attemptIds.size : 1;
  const times = run.events
    .map((event) => new Date(event.occurredAt).getTime())
    .filter((value) => Number.isFinite(value));
  const span =
    times.length >= 2
      ? formatSpan(Math.max(...times) - Math.min(...times))
      : relativeAge(run.attempt.queuedAt);
  return `${attempts} attempt${attempts === 1 ? '' : 's'} · ${span}`;
}

type RailGroupKey = 'needs_review' | 'running' | 'recent';

/** Which of the rail's three groups a run belongs in — driven entirely by
 * `run.status`, which mirrors `attempt.status` (see `apps/api`). */
function railGroupFor(status: string): RailGroupKey {
  if (status === 'awaiting_review') return 'needs_review';
  if (ACTIVE_ATTEMPT_STATUSES.has(status)) return 'running';
  return 'recent';
}

const STEP_LABELS = [
  'Queued',
  'Submitted',
  'Generated',
  'Evaluated',
  'Review',
] as const;

/**
 * The stepper's position, derived from the durable event record rather than
 * a hard-coded assumption — it reflects the furthest milestone this attempt
 * actually reached, so a failed attempt still shows real progress instead of
 * snapping back to "Queued."
 */
function stepIndexForRun(run: RunRecord): number {
  const types = new Set(run.events.map((event) => event.type));
  if (
    types.has('attempt.accepted') ||
    types.has('attempt.rejected') ||
    run.status === 'awaiting_review' ||
    run.status === 'accepted' ||
    run.status === 'rejected'
  )
    return 4;
  if (types.has('evaluation.completed') || run.status === 'evaluating')
    return 3;
  if (
    types.has('attempt.generated') ||
    run.status === 'generated' ||
    run.status === 'running'
  )
    return 2;
  if (
    types.has('attempt.submitted') ||
    run.status === 'submitting' ||
    run.status === 'submitted'
  )
    return 1;
  return 0;
}

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'timed_out', 'cancelled']);

/** The header's one-sentence state summary, from real status and timestamps
 * only — never a description of a field the run doesn't carry. */
function runStateSentence(run: RunRecord): string {
  const { status, attempt } = run;
  if (status === 'awaiting_review')
    return `Awaiting your review — submitted ${relativeAge(attempt.updatedAt)} ago.`;
  if (status === 'accepted')
    return `Accepted ${relativeAge(attempt.updatedAt)} ago.`;
  if (status === 'rejected')
    return `Rejected ${relativeAge(attempt.updatedAt)} ago.`;
  if (TERMINAL_FAILURE_STATUSES.has(status))
    return attempt.failureCode
      ? `Failed — ${humanize(attempt.failureCode)}.`
      : 'Failed to complete.';
  if (status === 'evaluating') return 'Evaluating the generated clip.';
  if (status === 'running' || status === 'generated')
    return 'Generating on the executor.';
  if (status === 'submitting' || status === 'submitted')
    return 'Submitted to the executor.';
  return `Queued ${relativeAge(attempt.queuedAt)} ago.`;
}

/** Adapts an unknown thrown value onto the design system's error presentation. */
function ErrorNotice({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
}): ReactElement {
  return (
    <UiErrorNotice
      message={errorText(error)}
      traceId={errorTrace(error)}
      onRetry={onRetry}
    />
  );
}

function InfoNotice({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return <Notice variant="info">{children}</Notice>;
}

/**
 * Fetches the artifact with the Studio-origin bearer token and hands the
 * resulting object URL to the player. The token never leaves this layer.
 */
function AuthorizedArtifactPlayer({
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
  return <ArtifactPlayer src={source} />;
}

/**
 * Narrows an API evaluation onto the presentational shape. Non-primitive
 * detail values are dropped here rather than inside the design system.
 */
function toEvaluationView(
  evaluation: Evaluation | undefined,
): EvaluationView | undefined {
  if (!evaluation) return undefined;
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evaluation.details)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      details[key] = value;
    }
  }
  return {
    status: evaluation.status,
    checks: evaluation.checks,
    details,
    evaluatorVersion: evaluation.evaluatorVersion,
    evaluatedAt: evaluation.evaluatedAt,
  };
}

/**
 * The attempt-review mutations and gates, lifted out of a single card so the
 * primary actions can live in the sticky header while the detail — player,
 * evaluation, failure copy — stays in the scrolling body. Both read from this
 * one hook instance, so "Accept" disables and re-enables identically whether
 * the click came from the header or (on a narrow viewport) the body.
 */
function useAttemptWorkspace(
  token: string,
  attempt: Omit<Attempt, 'shotId'>,
  invalidateProject: () => void,
) {
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
  return {
    detailQuery,
    evaluation: detail.evaluation,
    reviewMutation,
    retryMutation,
    rejectOpen,
    setRejectOpen,
    reason,
    setReason,
    retryOpen,
    setRetryOpen,
    uncertain: attempt.failureCode === 'COMFY_SUBMISSION_UNCERTAIN',
  };
}

type AttemptWorkspace = ReturnType<typeof useAttemptWorkspace>;

/** Accept / Reject / Derive retry — the run header's primary actions. */
function AttemptActionBar({
  attempt,
  workspace,
}: {
  readonly attempt: Omit<Attempt, 'shotId'>;
  readonly workspace: AttemptWorkspace;
}): ReactElement {
  const {
    reviewMutation,
    retryMutation,
    evaluation,
    setRejectOpen,
    setRetryOpen,
  } = workspace;
  return (
    <div className="button-row run-header-actions">
      {attempt.status === 'awaiting_review' && (
        <>
          <Button
            variant="primary"
            disabled={
              reviewMutation.isPending || evaluation?.status !== 'passed'
            }
            onClick={() => reviewMutation.mutate('accept')}
          >
            Accept passing attempt
          </Button>
          <Button
            disabled={reviewMutation.isPending}
            onClick={() => setRejectOpen(true)}
          >
            Reject
          </Button>
        </>
      )}
      {RETRYABLE_ATTEMPT_STATUSES.has(attempt.status) && (
        <Button
          disabled={retryMutation.isPending}
          onClick={() => setRetryOpen(true)}
        >
          Derive retry
        </Button>
      )}
    </div>
  );
}

/** Errors and confirmation gates for the header actions — rendered in the
 * body, directly under the header, so they stay reachable without the
 * actions themselves scrolling away. */
function AttemptGates({
  attempt,
  workspace,
}: {
  readonly attempt: Omit<Attempt, 'shotId'>;
  readonly workspace: AttemptWorkspace;
}): ReactElement {
  const {
    detailQuery,
    reviewMutation,
    retryMutation,
    retryOpen,
    setRetryOpen,
    rejectOpen,
    setRejectOpen,
    reason,
    setReason,
    uncertain,
  } = workspace;
  return (
    <>
      {detailQuery.isError && (
        <ErrorNotice
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
        />
      )}
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
            <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              type="submit"
              disabled={reviewMutation.isPending}
            >
              Reject attempt
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

/** The latest attempt's own detail: facts, then poster beside its evaluation
 * checks — a two-column treatment `AttemptSummary` doesn't impose on its
 * own, composed here via layout glue in the app's own stylesheet. */
function AttemptDetail({
  token,
  attempt,
  workspace,
  progress,
}: {
  readonly token: string;
  readonly attempt: Omit<Attempt, 'shotId'>;
  readonly workspace: AttemptWorkspace;
  readonly progress:
    | { readonly value: number; readonly max: number }
    | undefined;
}): ReactElement {
  return (
    <AttemptSummary attempt={attempt} progress={progress}>
      <div className="attempt-media-grid">
        {attempt.artifactId && (
          <AuthorizedArtifactPlayer
            token={token}
            artifactId={attempt.artifactId}
          />
        )}
        <EvaluationPanel evaluation={toEvaluationView(workspace.evaluation)} />
      </div>
      {/* `AttemptSummary` already renders `attempt.failureMessage` itself. */}
      {attempt.traceId && <p className="trace-line">Trace {attempt.traceId}</p>}
    </AttemptSummary>
  );
}

/** Earlier attempts for the same run: one compact, read-only row each — the
 * source of "3 attempts" isn't invented, it's `listProjectAttempts`, the
 * same collection every retry appends to. */
function EarlierAttempts({
  attempts,
}: {
  readonly attempts: readonly Attempt[];
}): ReactElement | null {
  if (attempts.length === 0) return null;
  return (
    <ol className="attempt-compact-list">
      {attempts.map((item) => (
        <li className="attempt-compact-row" key={item.id}>
          <StatusBadge status={item.status} />
          <code>{shortId(item.id, 10, 0)}</code>
          <span className="attempt-compact-meta">
            {formatDate(item.queuedAt)} · {formatMoney(item.estimatedCostUsd)}
          </span>
        </li>
      ))}
    </ol>
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
  const byId = new Map(pending.map((item) => [item.id, item]));
  const views: RecommendationView[] = pending.map((recommendation) => ({
    id: recommendation.id,
    severity: recommendation.severity,
    title: recommendation.title,
    detail: recommendation.detail,
    recommendationCode: recommendation.recommendationCode,
    proposedAction: humanize(recommendation.proposedActionType),
  }));

  return (
    <RecommendationList
      recommendations={views}
      isApplying={() => applyMutation.isPending}
      isDismissing={() => dismissMutation.isPending}
      onApply={(view) => {
        const recommendation = byId.get(view.id);
        if (!recommendation) return;
        if (recommendation.proposedActionType === 'retry_attempt') {
          setConfirmId(recommendation.id);
          return;
        }
        applyMutation.mutate(recommendation);
      }}
      onDismiss={(view) => {
        const recommendation = byId.get(view.id);
        if (recommendation) dismissMutation.mutate(recommendation);
      }}
      renderExtra={(view) => {
        const recommendation = byId.get(view.id);
        return (
          <>
            {confirmId === view.id &&
              recommendation?.proposedActionType === 'retry_attempt' && (
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
          </>
        );
      }}
    />
  );
}

/**
 * Payload keys safe to render on the timeline. Anything outside this set is
 * dropped before the event reaches the design system, which renders whatever
 * string it is handed.
 */
const TIMELINE_SAFE_PAYLOAD_KEYS = new Set([
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

/** Collapsed to a handful of rows behind "Show all N" — newest first, same
 * as before, but the endless scroll no longer starts here. */
const TIMELINE_COLLAPSED_COUNT = 6;

function EventTimeline({
  events,
}: {
  readonly events: readonly ProjectEvent[];
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const recent: TimelineEvent[] = events
    .slice(-24)
    .reverse()
    .map((event) => {
      const details = Object.entries(event.payload)
        .filter(
          ([key, value]) =>
            TIMELINE_SAFE_PAYLOAD_KEYS.has(key) &&
            ['string', 'number', 'boolean'].includes(typeof value),
        )
        .map(([key, value]) => `${humanize(key)}: ${String(value)}`)
        .join(' · ');
      return {
        id: `${event.id}-${event.eventSequence ?? ''}`,
        title: humanize(event.type),
        timestamp: event.occurredAt,
        sequence: event.eventSequence,
        detail: details || undefined,
      };
    });
  const visible = expanded ? recent : recent.slice(0, TIMELINE_COLLAPSED_COUNT);

  return (
    <>
      <UiEventTimeline
        events={visible}
        totalCount={events.length}
        intro="The stream is an update signal; refresh recovery always rebuilds from REST state."
      />
      {recent.length > TIMELINE_COLLAPSED_COUNT && (
        <Button variant="quiet" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : `Show all ${events.length}`}
        </Button>
      )}
    </>
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

const RAIL_TABS = [
  ['all', 'All'],
  ['needs_review', 'Needs review'],
  ['running', 'Running'],
  ['recent', 'Recent'],
] as const;
type RailTab = (typeof RAIL_TABS)[number][0];

/** One named group of rail rows — "Needs review · N", "Running · N",
 * "Recent · N". Runs are titled by name, never by id: `project.title` is the
 * heading, the run id is demoted to a mono meta line beneath it. */
function RunRailGroup({
  label,
  items,
  selectedRunId,
  onSelect,
}: {
  readonly label: string;
  readonly items: readonly RunRecord[];
  readonly selectedRunId: string | undefined;
  readonly onSelect: (runId: string) => void;
}): ReactElement {
  return (
    <div className="run-rail-group">
      <p className="run-rail-group-label">
        {label} · {items.length}
      </p>
      <ol className="run-rail-list">
        {items.map((item) => (
          <li key={item.runId}>
            <button
              type="button"
              className={
                item.runId === selectedRunId
                  ? 'run-rail-item run-rail-item--selected'
                  : 'run-rail-item'
              }
              aria-pressed={item.runId === selectedRunId}
              onClick={() => onSelect(item.runId)}
            >
              <span className="run-rail-item-title">{item.project.title}</span>
              <span className="run-rail-item-meta">
                {shortId(item.runId, 8, 4)} · {railAttemptSummary(item)}
              </span>
              <StatusBadge status={item.status} />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The selected run's own column: a sticky header (mono meta, the run's name,
 * a state sentence, and the primary Accept / Reject / Derive retry actions)
 * above a scrolling body (stepper, run facts, attempts, recommendations,
 * human review, revisions, timeline). Keyed by `run.runId` at the call site
 * so switching runs resets every local gate — the reject form, the retry
 * confirmation — exactly as `key={attempt.id}` did for the single-card
 * version this replaces.
 */
function RunDetailColumn({
  token,
  run,
  findings,
  progress,
  reviewNote,
  setReviewNote,
  runReviewMutation,
  pinMutation,
  unpinMutation,
  validateMutation,
  onLoadRevision,
  invalidateRunState,
}: {
  readonly token: string;
  readonly run: RunRecord;
  readonly findings: readonly OperatorRecommendation[];
  readonly progress:
    | { readonly value: number; readonly max: number }
    | undefined;
  readonly reviewNote: string;
  readonly setReviewNote: (value: string) => void;
  readonly runReviewMutation: ReturnType<
    typeof useMutation<
      RunRecord,
      unknown,
      { readonly runId: string; readonly decision: 'accepted' | 'rejected' }
    >
  >;
  readonly pinMutation: ReturnType<
    typeof useMutation<RunRecord, unknown, string>
  >;
  readonly unpinMutation: ReturnType<
    typeof useMutation<RunRecord, unknown, string>
  >;
  readonly validateMutation: ReturnType<
    typeof useMutation<WorkflowRevisionResult, unknown, string>
  >;
  readonly onLoadRevision?:
    | ((revision: Omit<WorkflowRevision, 'shotId'>) => void)
    | undefined;
  readonly invalidateRunState: () => void;
}): ReactElement {
  const attempt = run.attempt;
  const revision = run.revision;
  const workspace = useAttemptWorkspace(token, attempt, invalidateRunState);
  const attemptsQuery = useQuery({
    queryKey: ['managed-run-attempts', run.projectId],
    queryFn: () => listProjectAttempts(token, run.projectId),
    enabled: Boolean(run.projectId),
    refetchInterval: 5_000,
  });
  const attempts = attemptsQuery.data?.attempts ?? [];
  const earlierAttempts = [...attempts]
    .filter((item) => item.id !== attempt.id)
    .sort(
      (a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime(),
    );
  const currentStep = stepIndexForRun(run);
  const failed = TERMINAL_FAILURE_STATUSES.has(run.status);

  return (
    <>
      <header className="run-header">
        <p className="run-header-meta">
          RUN {shortId(run.runId)} · started {formatDate(attempt.queuedAt)}
        </p>
        <div className="run-header-top">
          <h1>{run.project.title}</h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="run-header-state">{runStateSentence(run)}</p>
        <AttemptActionBar attempt={attempt} workspace={workspace} />
      </header>
      <div className="run-body">
        {attemptsQuery.isError && <ErrorNotice error={attemptsQuery.error} />}
        <AttemptGates attempt={attempt} workspace={workspace} />
        <ol className="run-stepper" aria-label="Attempt progress">
          {STEP_LABELS.map((label, index) => {
            const state =
              index < currentStep
                ? 'done'
                : index === currentStep
                  ? failed
                    ? 'failed'
                    : 'current'
                  : 'upcoming';
            return (
              <li key={label} className={`run-step run-step--${state}`}>
                <span className="run-step-dot" aria-hidden="true" />
                <span className="run-step-label">{label}</span>
              </li>
            );
          })}
        </ol>
        <Panel title="Run" kicker="COST / BUDGET / KEEPER">
          <FactList
            columns={4}
            facts={[
              {
                label: 'Estimated cost',
                value: formatMoney(run.cost.estimatedCostUsd),
              },
              {
                label: 'Budget headroom',
                value:
                  run.cost.projectRemainingUsd === null
                    ? 'Not budgeted'
                    : formatMoney(run.cost.projectRemainingUsd),
              },
              { label: 'Keeper', value: run.pinned ? 'Pinned' : 'Not pinned' },
              {
                label: 'Review',
                value: run.review?.decision
                  ? humanize(run.review.decision)
                  : 'Not annotated',
              },
            ]}
          />
          <div className="button-row">
            {revision && onLoadRevision && (
              <Button variant="quiet" onClick={() => onLoadRevision(revision)}>
                Load revision in ComfyUI
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={pinMutation.isPending || unpinMutation.isPending}
              onClick={() =>
                run.pinned
                  ? unpinMutation.mutate(run.runId)
                  : pinMutation.mutate(run.runId)
              }
            >
              {run.pinned ? 'Unpin keeper' : 'Pin keeper'}
            </Button>
          </div>
        </Panel>
        <Panel
          title="Attempts"
          kicker="GENERATION HISTORY"
          count={attempts.length || 1}
        >
          <AttemptDetail
            token={token}
            attempt={attempt}
            workspace={workspace}
            progress={progress}
          />
          <EarlierAttempts attempts={earlierAttempts} />
        </Panel>
        <RecommendationPanel
          token={token}
          projectId={run.projectId}
          recommendations={findings}
          invalidateProject={invalidateRunState}
        />
        <Panel title="Human review" kicker="ANNOTATION">
          <textarea
            aria-label="Review note"
            rows={3}
            maxLength={2_000}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder="Optional review note"
          />
          <div className="button-row">
            <Button
              variant="primary"
              disabled={runReviewMutation.isPending}
              onClick={() =>
                runReviewMutation.mutate({
                  runId: run.runId,
                  decision: 'accepted',
                })
              }
            >
              Accept annotation
            </Button>
            <Button
              disabled={runReviewMutation.isPending}
              onClick={() =>
                runReviewMutation.mutate({
                  runId: run.runId,
                  decision: 'rejected',
                })
              }
            >
              Reject annotation
            </Button>
          </div>
        </Panel>
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
        <EventTimeline events={run.events} />
      </div>
    </>
  );
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
  const [railFilter, setRailFilter] = useState<RailTab>('all');
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
  const runReviewMutation = useMutation({
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

  const needsReview = runs.filter(
    (item) => railGroupFor(item.status) === 'needs_review',
  );
  const runningRuns = runs.filter(
    (item) => railGroupFor(item.status) === 'running',
  );
  const recentRuns = runs.filter(
    (item) => railGroupFor(item.status) === 'recent',
  );

  return (
    <>
      {runsQuery.isError && <ErrorNotice error={runsQuery.error} />}
      {pinMutation.isError && <ErrorNotice error={pinMutation.error} />}
      {unpinMutation.isError && <ErrorNotice error={unpinMutation.error} />}
      {runReviewMutation.isError && (
        <ErrorNotice error={runReviewMutation.error} />
      )}
      {validateMutation.isError && (
        <ErrorNotice error={validateMutation.error} />
      )}
      {notice && <InfoNotice>{notice}</InfoNotice>}
      <div className="run-console">
        <aside className="run-rail" aria-label="Run history">
          <div className="run-rail-tabs" role="tablist">
            {RAIL_TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={railFilter === key}
                className={
                  railFilter === key
                    ? 'run-rail-tab run-rail-tab--active'
                    : 'run-rail-tab'
                }
                onClick={() => setRailFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="run-rail-scroll">
            {runsQuery.isPending && (
              <LoadingState label="Loading run history…" />
            )}
            {runs.length === 0 && runsQuery.isSuccess && (
              <EmptyState
                title="No managed runs"
                detail="Managed Run exports will be recorded here."
              />
            )}
            {(railFilter === 'all' || railFilter === 'needs_review') &&
              needsReview.length > 0 && (
                <RunRailGroup
                  label="Needs review"
                  items={needsReview}
                  selectedRunId={run?.runId}
                  onSelect={setSelectedRunId}
                />
              )}
            {(railFilter === 'all' || railFilter === 'running') &&
              runningRuns.length > 0 && (
                <RunRailGroup
                  label="Running"
                  items={runningRuns}
                  selectedRunId={run?.runId}
                  onSelect={setSelectedRunId}
                />
              )}
            {(railFilter === 'all' || railFilter === 'recent') &&
              recentRuns.length > 0 && (
                <RunRailGroup
                  label="Recent"
                  items={recentRuns}
                  selectedRunId={run?.runId}
                  onSelect={setSelectedRunId}
                />
              )}
          </div>
        </aside>
        <section className="run-main" aria-label="Selected run">
          {!run && (
            <div className="run-main-empty">
              <EmptyState
                title="Select a run"
                detail="Run status, evaluation, findings, and review controls will appear here."
              />
            </div>
          )}
          {run && (
            <RunDetailColumn
              key={run.runId}
              token={token}
              run={run}
              findings={findings}
              progress={progress}
              reviewNote={reviewNote}
              setReviewNote={setReviewNote}
              runReviewMutation={runReviewMutation}
              pinMutation={pinMutation}
              unpinMutation={unpinMutation}
              validateMutation={validateMutation}
              onLoadRevision={onLoadRevision}
              invalidateRunState={invalidateRunState}
            />
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
          ? `Managed run ${shortId(result.runId)} created.`
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
      setBridgeNotice(`Revision ${shortId(revision.id)} sent to ComfyUI.`);
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
        onSubmit={(value) => {
          rememberToken(value);
          setToken(value);
        }}
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
    <AppShell
      onSignOut={signOut}
      renderHomeLink={(content) => (
        <Link className="brand" to="/" aria-label="H3 VideoOps home">
          {content}
        </Link>
      )}
    >
      <Routes>
        <Route path="/" element={<StandaloneRunPage token={token} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
