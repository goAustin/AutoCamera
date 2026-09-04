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
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom';
import {
  acceptAttempt,
  approveStoryboard,
  applyRecommendation,
  ApiError,
  createRun,
  createManagedAttempt,
  createProject,
  createWorkflowRevision,
  dismissRecommendation,
  fetchArtifact,
  fetchProjectEventStream,
  fetchReadiness,
  getAttemptDetail,
  getCost,
  getExecutor,
  getProject,
  getRun,
  getStoryboard,
  getWorkflowDraft,
  listProjectAttempts,
  listProjectEvents,
  listProjects,
  listRecommendations,
  listRuns,
  listShots,
  listWorkflowRevisions,
  planProject,
  rejectAttempt,
  retryAttempt,
  pinRun,
  reviewRun,
  saveWorkflowDraft,
  unpinRun,
  validateWorkflowRevision,
  type Attempt,
  type Cost,
  type Evaluation,
  type ExecutorInfo,
  type OperatorRecommendation,
  type Project,
  type ProjectEvent,
  type Shot,
  type StoryboardProposal,
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
  durationToFrames,
  extractFakeWorkflowSettings,
  MINIMAX_H3_DEFAULT_STEPS,
  MINIMAX_H3_FPS,
  MINIMAX_H3_PROFILE_ID,
  MINIMAX_H3_PROFILE_VERSION,
  type FakeWorkflowGraphs,
  type FakeWorkflowSettings,
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
          {embedded ? 'Connect this panel.' : 'Bring a brief to life.'}
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

function ApiHealthCard({
  readiness,
}: {
  readonly readiness: UseQueryResult<
    Awaited<ReturnType<typeof fetchReadiness>>
  >;
}): ReactElement {
  const status = readiness.isSuccess
    ? readiness.data.status
    : readiness.isPending
      ? 'checking'
      : 'unavailable';
  return (
    <section className="health-card" aria-label="System health">
      <div className="health-heading">
        <span className="section-kicker">SYSTEM HEALTH</span>
        <StatusBadge status={status} />
      </div>
      <div className="health-grid">
        <div>
          <span className="metric-label">API</span>
          <strong>{humanize(status)}</strong>
        </div>
        <div>
          <span className="metric-label">PostgreSQL</span>
          <strong>{readiness.data?.dependencies.postgres ?? 'waiting'}</strong>
        </div>
      </div>
      {readiness.isError && (
        <span className="muted">
          The API readiness endpoint is not responding.
        </span>
      )}
    </section>
  );
}

function ProjectListPage({ token }: { readonly token: string }): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => listProjects(token),
    refetchInterval: 5_000,
  });
  const readinessQuery = useQuery({
    queryKey: ['api-readiness'],
    queryFn: fetchReadiness,
    refetchInterval: 5_000,
  });
  const createMutation = useMutation({
    mutationFn: (body: {
      readonly title: string;
      readonly brief: string;
      readonly targetDurationSeconds: number;
      readonly budgetUsd?: string;
    }) => createProject(token, body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${result.project.id}`);
    },
  });
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [duration, setDuration] = useState('15');
  const [budget, setBudget] = useState('25.00');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    const trimmedBrief = brief.trim();
    const targetDurationSeconds = Number(duration);
    if (
      !trimmedTitle ||
      !trimmedBrief ||
      !Number.isFinite(targetDurationSeconds)
    )
      return;
    const trimmedBudget = budget.trim();
    const body = trimmedBudget
      ? {
          title: trimmedTitle,
          brief: trimmedBrief,
          targetDurationSeconds,
          budgetUsd: trimmedBudget,
        }
      : { title: trimmedTitle, brief: trimmedBrief, targetDurationSeconds };
    createMutation.mutate(body);
  };

  return (
    <main className="page-shell">
      <section className="page-intro">
        <div>
          <p className="eyebrow">CONTROL PLANE / HOME</p>
          <h1>Projects that stay explainable.</h1>
          <p className="lede">
            Plan three shots, shape the graph, and keep every managed attempt
            reviewable.
          </p>
        </div>
        <ApiHealthCard readiness={readinessQuery} />
      </section>

      <div className="home-grid">
        <section
          className="panel panel--accent"
          aria-labelledby="new-project-title"
        >
          <div className="panel-heading">
            <div>
              <span className="section-kicker">NEW PROJECT</span>
              <h2 id="new-project-title">Start with a brief</h2>
            </div>
            <span className="panel-number">01</span>
          </div>
          <form className="stack-form" onSubmit={submit}>
            <label htmlFor="project-title">Project title</label>
            <input
              id="project-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Summer launch film"
              required
            />
            <label htmlFor="project-brief">Creative brief</label>
            <textarea
              id="project-brief"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              maxLength={20_000}
              rows={5}
              placeholder="What should the audience feel, see, and remember?"
              required
            />
            <div className="form-row">
              <div>
                <label htmlFor="target-duration">
                  Target duration (seconds)
                </label>
                <input
                  id="target-duration"
                  type="number"
                  min="3"
                  max="3600"
                  step="1"
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="project-budget">Budget (USD)</label>
                <input
                  id="project-budget"
                  inputMode="decimal"
                  value={budget}
                  onChange={(event) => setBudget(event.target.value)}
                  placeholder="25.00"
                />
              </div>
            </div>
            {createMutation.isError && (
              <ErrorNotice error={createMutation.error} />
            )}
            <button
              className="button button--primary"
              type="submit"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending
                ? 'Creating project…'
                : 'Create project'}
            </button>
          </form>
        </section>

        <section className="panel" aria-labelledby="projects-title">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">WORKSPACE INDEX</span>
              <h2 id="projects-title">Your projects</h2>
            </div>
            <span className="count-badge">
              {projectsQuery.data?.projects.length ?? 0}
            </span>
          </div>
          {projectsQuery.isPending && (
            <LoadingState label="Loading projects…" />
          )}
          {projectsQuery.isError && (
            <ErrorNotice
              error={projectsQuery.error}
              onRetry={() => void projectsQuery.refetch()}
            />
          )}
          {projectsQuery.isSuccess &&
            projectsQuery.data.projects.length === 0 && (
              <EmptyState
                title="No projects yet"
                detail="Create a project to open the planning workspace."
              />
            )}
          {projectsQuery.isSuccess &&
            projectsQuery.data.projects.length > 0 && (
              <ul className="project-list">
                {projectsQuery.data.projects.map((project) => (
                  <li key={project.id}>
                    <Link
                      className="project-list-item"
                      to={`/projects/${project.id}`}
                    >
                      <span className="project-list-copy">
                        <strong>{project.title}</strong>
                        <span>{project.brief}</span>
                      </span>
                      <span className="project-list-meta">
                        <StatusBadge status={project.status} />
                        <small>{formatDate(project.updatedAt)}</small>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </main>
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

function ProjectOverview({
  project,
  cost,
  executor,
}: {
  readonly project: Project;
  readonly cost: Cost | undefined;
  readonly executor: ExecutorInfo | undefined;
}): ReactElement {
  return (
    <section className="overview-card" aria-labelledby="project-title">
      <div className="overview-main">
        <span className="section-kicker">PROJECT STUDIO</span>
        <h1 id="project-title">{project.title}</h1>
        <p>{project.brief}</p>
        <div className="tag-row">
          <StatusBadge status={project.status} />
          <span className="plain-tag">
            {formatDuration(project.targetDurationSeconds)} target
          </span>
          <span className="plain-tag">v{project.version}</span>
        </div>
      </div>
      <div className="overview-metrics">
        <div>
          <span className="metric-label">Budget</span>
          <strong>{formatMoney(cost?.budgetUsd ?? project.budgetUsd)}</strong>
        </div>
        <div>
          <span className="metric-label">Reserved</span>
          <strong>{formatMoney(cost?.spentUsd ?? project.spentUsd)}</strong>
        </div>
        <div>
          <span className="metric-label">Executor</span>
          <strong>
            {executor?.mode === 'fake'
              ? 'Simulated'
              : executor?.mode === 'remote'
                ? 'Remote GPU'
                : 'Checking'}
          </strong>
        </div>
      </div>
    </section>
  );
}

function StoryboardSection({
  project,
  proposal,
  isLoading,
  planPending,
  approvePending,
  planError,
  approveError,
  onPlan,
  onApprove,
}: {
  readonly project: Project;
  readonly proposal: StoryboardProposal | null | undefined;
  readonly isLoading: boolean;
  readonly planPending: boolean;
  readonly approvePending: boolean;
  readonly planError: unknown;
  readonly approveError: unknown;
  readonly onPlan: () => void;
  readonly onApprove: () => void;
}): ReactElement {
  return (
    <section className="panel" aria-labelledby="storyboard-title">
      <div className="panel-heading">
        <div>
          <span className="section-kicker">PLANNING / APPROVAL</span>
          <h2 id="storyboard-title">Storyboard</h2>
        </div>
        {proposal && (
          <span className="plain-tag">Revision {proposal.revision}</span>
        )}
      </div>
      {isLoading && <LoadingState label="Recovering storyboard state…" />}
      {!isLoading && !proposal && (
        <div className="planning-empty">
          <p>
            {project.status === 'planning'
              ? 'Pi is shaping a structured three-shot proposal.'
              : 'No proposal is waiting yet. Run the deterministic planning agent to create one.'}
          </p>
          <button
            className="button button--primary"
            type="button"
            onClick={onPlan}
            disabled={planPending || project.status === 'planning'}
          >
            {planPending ? 'Planning with Pi…' : 'Plan with Pi'}
          </button>
        </div>
      )}
      {planError !== undefined && planError !== null ? (
        <ErrorNotice error={planError} />
      ) : null}
      {approveError !== undefined && approveError !== null ? (
        <ErrorNotice error={approveError} />
      ) : null}
      {proposal && (
        <>
          <div className="proposal-summary">
            <p>
              {proposal.objective ?? 'A structured proposal for the project.'}
            </p>
            <span>
              {proposal.shots.length} shots ·{' '}
              {formatDuration(proposal.totalDurationSeconds)} total ·{' '}
              {humanize(proposal.status)}
            </span>
          </div>
          <ol className="storyboard-grid">
            {proposal.shots.map((shot) => (
              <li className="storyboard-card" key={shot.ordinal}>
                <div className="shot-card-topline">
                  <span className="shot-index">0{shot.ordinal}</span>
                  <span>{formatDuration(shot.durationSeconds)}</span>
                </div>
                <h3>{shot.purpose}</h3>
                <p>{shot.visualDescription ?? shot.prompt}</p>
                <dl className="compact-details">
                  <div>
                    <dt>Camera</dt>
                    <dd>{shot.cameraDirection ?? 'Not specified'}</dd>
                  </div>
                  <div>
                    <dt>Audio</dt>
                    <dd>{shot.audioDirection ?? 'Not specified'}</dd>
                  </div>
                  {shot.dialogue && (
                    <div>
                      <dt>Dialogue</dt>
                      <dd>{shot.dialogue}</dd>
                    </div>
                  )}
                </dl>
                <div className="criteria-block">
                  <span className="metric-label">Acceptance criteria</span>
                  <ul>
                    {(shot.acceptanceCriteria ?? []).map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
          {proposal.status === 'proposed' && (
            <div className="approval-bar">
              <div>
                <strong>Ready for human approval</strong>
                <span>Approval materializes the three durable shots.</span>
              </div>
              <button
                className="button button--primary"
                type="button"
                onClick={onApprove}
                disabled={approvePending}
              >
                {approvePending ? 'Approving…' : 'Approve storyboard'}
              </button>
            </div>
          )}
          {proposal.status === 'approved' && (
            <InfoNotice>
              The storyboard is approved. Select a shot below to shape its
              managed workflow.
            </InfoNotice>
          )}
        </>
      )}
    </section>
  );
}

function ShotNavigation({
  projectId,
  shots,
  selectedShotId,
}: {
  readonly projectId: string;
  readonly shots: readonly Shot[];
  readonly selectedShotId?: string | undefined;
}): ReactElement {
  return (
    <nav className="shot-nav" aria-label="Shots">
      <span className="section-kicker">SHOT NAVIGATION</span>
      <ol>
        {shots.map((shot) => (
          <li key={shot.id}>
            <Link
              className={
                shot.id === selectedShotId
                  ? 'shot-nav-link shot-nav-link--selected'
                  : 'shot-nav-link'
              }
              aria-current={shot.id === selectedShotId ? 'page' : undefined}
              to={`/projects/${projectId}/shots/${shot.id}`}
            >
              <span>Shot {String(shot.ordinal).padStart(2, '0')}</span>
              <StatusBadge status={shot.status} />
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function useProjectStream(token: string, projectId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    let lastEventId = 0;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      if (!active) return;
      try {
        const events = await fetchProjectEventStream(
          token,
          projectId,
          lastEventId,
        );
        for (const event of events)
          lastEventId = Math.max(lastEventId, event.id);
        if (events.length > 0)
          void queryClient.invalidateQueries({
            queryKey: ['project', projectId],
          });
      } catch {
        // REST queries continue to provide truth when the SSE replay endpoint is unavailable.
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 4_000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectId, queryClient, token]);
}

function ProjectStudioPage({
  token,
}: {
  readonly token: string;
}): ReactElement {
  const { projectId, shotId } = useParams();
  const queryClient = useQueryClient();
  const validProjectId = typeof projectId === 'string' ? projectId : '';
  const projectQuery = useQuery({
    queryKey: ['project', validProjectId],
    queryFn: () => getProject(token, validProjectId),
    enabled: Boolean(validProjectId),
    refetchInterval: 4_000,
  });
  const project = projectQuery.data?.project;
  const storyboardQuery = useQuery({
    queryKey: ['project', validProjectId, 'storyboard'],
    queryFn: () => getStoryboard(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 4_000,
  });
  const shotsQuery = useQuery({
    queryKey: ['project', validProjectId, 'shots'],
    queryFn: () => listShots(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 4_000,
  });
  const costQuery = useQuery({
    queryKey: ['project', validProjectId, 'cost'],
    queryFn: () => getCost(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 4_000,
  });
  const executorQuery = useQuery({
    queryKey: ['executor'],
    queryFn: () => getExecutor(token),
    refetchInterval: 5_000,
  });
  const attemptsQuery = useQuery({
    queryKey: ['project', validProjectId, 'attempts'],
    queryFn: () => listProjectAttempts(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 2_500,
  });
  const eventsQuery = useQuery({
    queryKey: ['project', validProjectId, 'events'],
    queryFn: () => listProjectEvents(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 4_000,
  });
  const recommendationsQuery = useQuery({
    queryKey: ['project', validProjectId, 'recommendations'],
    queryFn: () => listRecommendations(token, validProjectId),
    enabled: Boolean(project),
    refetchInterval: 4_000,
  });
  useProjectStream(token, validProjectId);

  const invalidateProject = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['project', validProjectId],
    });
  }, [queryClient, validProjectId]);
  const planMutation = useMutation({
    mutationFn: () => planProject(token, validProjectId),
    onSuccess: invalidateProject,
  });
  const approveMutation = useMutation({
    mutationFn: (proposal: StoryboardProposal) =>
      approveStoryboard(token, validProjectId, proposal.id),
    onSuccess: invalidateProject,
  });

  if (!validProjectId) return <Navigate to="/" replace />;
  if (projectQuery.isPending)
    return (
      <main className="page-shell">
        <LoadingState label="Opening Project Studio…" />
      </main>
    );
  if (projectQuery.isError || !project) {
    return (
      <main className="page-shell">
        <ErrorNotice
          error={projectQuery.error ?? new Error('Project not found.')}
          onRetry={() => void projectQuery.refetch()}
        />
      </main>
    );
  }
  const shots = shotsQuery.data?.shots ?? [];
  const selectedShot = shotId
    ? shots.find((shot) => shot.id === shotId)
    : undefined;
  const attempts = attemptsQuery.data?.attempts ?? [];
  const events = eventsQuery.data?.events ?? [];
  const recommendations = recommendationsQuery.data?.recommendations ?? [];

  return (
    <main className="page-shell studio-page">
      <div className="breadcrumb">
        <Link to="/">Projects</Link>
        <span>/</span>
        <span>{project.title}</span>
      </div>
      <ProjectOverview
        project={project}
        cost={costQuery.data}
        executor={executorQuery.data}
      />
      {executorQuery.isError && (
        <ErrorNotice
          error={executorQuery.error}
          onRetry={() => void executorQuery.refetch()}
        />
      )}
      <StoryboardSection
        project={project}
        proposal={storyboardQuery.data?.proposal}
        isLoading={storyboardQuery.isPending}
        planPending={planMutation.isPending}
        approvePending={approveMutation.isPending}
        planError={planMutation.error}
        approveError={approveMutation.error}
        onPlan={() => planMutation.mutate()}
        onApprove={() => {
          const proposal = storyboardQuery.data?.proposal;
          if (proposal) approveMutation.mutate(proposal);
        }}
      />
      {shotsQuery.isError && (
        <ErrorNotice
          error={shotsQuery.error}
          onRetry={() => void shotsQuery.refetch()}
        />
      )}
      {shots.length > 0 && (
        <ShotNavigation
          projectId={validProjectId}
          shots={shots}
          selectedShotId={shotId}
        />
      )}
      {shotId && !selectedShot && shotsQuery.isSuccess && (
        <ErrorNotice
          error={new Error('That shot is not part of this project.')}
        />
      )}
      {selectedShot && (
        <ShotWorkspace
          key={selectedShot.id}
          token={token}
          projectId={validProjectId}
          shot={selectedShot}
          executor={executorQuery.data}
          executorLoading={executorQuery.isPending}
          executorError={executorQuery.error}
          attempts={attempts}
          events={events}
          invalidateProject={invalidateProject}
        />
      )}
      {attemptsQuery.isError && (
        <ErrorNotice
          error={attemptsQuery.error}
          onRetry={() => void attemptsQuery.refetch()}
        />
      )}
      <div className="support-grid">
        <RecommendationPanel
          token={token}
          projectId={validProjectId}
          recommendations={recommendations}
          invalidateProject={invalidateProject}
        />
        <EventTimeline events={events} />
      </div>
      {recommendationsQuery.isError && (
        <ErrorNotice
          error={recommendationsQuery.error}
          onRetry={() => void recommendationsQuery.refetch()}
        />
      )}
      {eventsQuery.isError && (
        <ErrorNotice
          error={eventsQuery.error}
          onRetry={() => void eventsQuery.refetch()}
        />
      )}
    </main>
  );
}

function StandaloneWorkflowPanel({
  settings,
  onChange,
}: {
  readonly settings: FakeWorkflowSettings;
  readonly onChange: (next: FakeWorkflowSettings) => void;
}): ReactElement {
  const frames =
    Number.isFinite(settings.durationSeconds) && settings.durationSeconds > 0
      ? durationToFrames(settings.durationSeconds)
      : undefined;
  return (
    <section className="editor-panel" aria-labelledby="fake-editor-title">
      <div className="editor-panel-heading">
        <div>
          <span className="section-kicker">FAKE MODE / MANAGED WORKFLOW</span>
          <h3 id="fake-editor-title">Deterministic H3 profile</h3>
        </div>
        <span className="simulation-badge">SIMULATED</span>
      </div>
      <p className="editor-explainer">
        Fake mode intentionally exposes a bounded workflow panel instead of
        pretending to be the visual ComfyUI editor. The saved graphs still
        follow the managed revision and validation contract.
      </p>
      <fieldset className="workflow-fields">
        <legend>Preview parameters</legend>
        <label htmlFor="fake-prompt">Prompt</label>
        <textarea
          id="fake-prompt"
          rows={5}
          maxLength={32_000}
          value={settings.prompt}
          onChange={(event) =>
            onChange({ ...settings, prompt: event.target.value })
          }
        />
        <div className="form-row form-row--three">
          <div>
            <label htmlFor="fake-width">Width</label>
            <input
              id="fake-width"
              type="number"
              min="32"
              max="1344"
              step="32"
              value={settings.width}
              onChange={(event) =>
                onChange({ ...settings, width: Number(event.target.value) })
              }
            />
          </div>
          <div>
            <label htmlFor="fake-height">Height</label>
            <input
              id="fake-height"
              type="number"
              min="32"
              max="1344"
              step="32"
              value={settings.height}
              onChange={(event) =>
                onChange({ ...settings, height: Number(event.target.value) })
              }
            />
          </div>
          <div>
            <label htmlFor="fake-duration">Duration (seconds)</label>
            <input
              id="fake-duration"
              type="number"
              min="0.1"
              max="15"
              step="0.1"
              value={settings.durationSeconds}
              onChange={(event) =>
                onChange({
                  ...settings,
                  durationSeconds: Number(event.target.value),
                })
              }
            />
          </div>
        </div>
        <label htmlFor="fake-seed">Seed</label>
        <input
          id="fake-seed"
          type="number"
          min="0"
          max="9007199254740991"
          step="1"
          value={settings.seed}
          onChange={(event) =>
            onChange({ ...settings, seed: Number(event.target.value) })
          }
        />
      </fieldset>
      <dl className="workflow-facts">
        <div>
          <dt>Profile</dt>
          <dd>
            {MINIMAX_H3_PROFILE_ID} · v{MINIMAX_H3_PROFILE_VERSION}
          </dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd>
            {settings.width}×{settings.height} · {MINIMAX_H3_FPS} fps ·{' '}
            {MINIMAX_H3_DEFAULT_STEPS} steps
          </dd>
        </div>
        <div>
          <dt>Frame grid</dt>
          <dd>
            {frames
              ? `${frames} frames · ${(frames / MINIMAX_H3_FPS).toFixed(2)}s actual`
              : 'Enter a positive duration'}
          </dd>
        </div>
        <div>
          <dt>Audio</dt>
          <dd>Native stereo · 32 kHz</dd>
        </div>
      </dl>
    </section>
  );
}

function StandaloneComfySummary(): ReactElement {
  return (
    <section
      className="editor-panel editor-panel--remote"
      aria-labelledby="comfy-summary-title"
    >
      <div className="editor-panel-heading">
        <div>
          <span className="section-kicker">REMOTE MODE / COMFYUI SHELL</span>
          <h3 id="comfy-summary-title">Managed editor handoff</h3>
        </div>
        <span className="bridge-status bridge-status--ready">Shell mode</span>
      </div>
      <p className="editor-explainer">
        Open the pinned ComfyUI shell separately. Its VideoOps sidebar hosts a
        Studio-origin iframe; the VideoOps bearer token never enters ComfyUI.
      </p>
      <p className="editor-help">
        Use <strong>Managed Run</strong> in ComfyUI after opening VideoOps from
        its sidebar. The native ComfyUI queue is disabled for this integration.
      </p>
    </section>
  );
}

function RevisionHistory({
  revisions,
  selectedRevisionId,
  onUse,
  onValidate,
  validatingId,
}: {
  readonly revisions: readonly WorkflowRevision[];
  readonly selectedRevisionId?: string | undefined;
  readonly onUse: (revision: WorkflowRevision) => void;
  readonly onValidate: (revision: WorkflowRevision) => void;
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
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={() => onUse(revision)}
                >
                  Use revision
                </button>
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
  readonly attempt: Attempt;
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
  const detail = detailQuery.data ?? { attempt };
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

function ShotWorkspace({
  token,
  projectId,
  shot,
  executor,
  executorLoading,
  executorError,
  attempts,
  events,
  invalidateProject,
}: {
  readonly token: string;
  readonly projectId: string;
  readonly shot: Shot;
  readonly executor: ExecutorInfo | undefined;
  readonly executorLoading: boolean;
  readonly executorError: unknown;
  readonly attempts: readonly Attempt[];
  readonly events: readonly ProjectEvent[];
  readonly invalidateProject: () => void;
}): ReactElement {
  const queryClient = useQueryClient();
  const draftQuery = useQuery({
    queryKey: ['project', projectId, 'shot', shot.id, 'draft'],
    queryFn: () => getWorkflowDraft(token, projectId, shot.id),
    refetchInterval: 4_000,
  });
  const revisionsQuery = useQuery({
    queryKey: ['project', projectId, 'shot', shot.id, 'revisions'],
    queryFn: () => listWorkflowRevisions(token, projectId, shot.id),
    refetchInterval: 4_000,
  });
  const draft = draftQuery.data?.draft;
  const revisions = revisionsQuery.data?.revisions ?? [];
  const [settings, setSettings] = useState<FakeWorkflowSettings>({
    ...DEFAULT_FAKE_WORKFLOW_SETTINGS,
    prompt: shot.prompt,
  });
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string>();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>();
  const [actionError, setActionError] = useState<unknown>();
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const fakeGraphs = useMemo<FakeWorkflowGraphs>(
    () => buildFakeWorkflowGraphs(settings),
    [settings],
  );
  const selectedRevision = revisions.find(
    (revision) => revision.id === selectedRevisionId,
  );
  const mode = executor?.mode;

  useEffect(() => {
    if (selectedRevisionId !== undefined || revisions.length === 0) return;
    const latestRevision = revisions[revisions.length - 1];
    if (latestRevision) setSelectedRevisionId(latestRevision.id);
  }, [revisions, selectedRevisionId]);

  useEffect(() => {
    const key = `${shot.id}:${draft?.id ?? 'none'}:${draft?.updatedAt ?? 'none'}`;
    if (key === hydratedDraftKey) return;
    setHydratedDraftKey(key);
    if (draft) {
      setSettings(
        extractFakeWorkflowSettings(draft.editorGraph, draft.lastApiGraph, {
          ...DEFAULT_FAKE_WORKFLOW_SETTINGS,
          prompt: shot.prompt,
        }),
      );
      if (!selectedRevisionId && draft.baseRevisionId)
        setSelectedRevisionId(draft.baseRevisionId);
    } else {
      setSettings({ ...DEFAULT_FAKE_WORKFLOW_SETTINGS, prompt: shot.prompt });
    }
  }, [draft, hydratedDraftKey, selectedRevisionId, shot.id, shot.prompt]);

  const currentGraphs = useCallback(():
    | {
        readonly editorGraph: Record<string, unknown>;
        readonly apiGraph: Record<string, unknown>;
        readonly frontendVersion?: string;
      }
    | undefined => {
    if (mode === 'fake')
      return {
        editorGraph: fakeGraphs.editorGraph,
        apiGraph: fakeGraphs.apiGraph,
        frontendVersion: 'fake-mode-fixture',
      };
    if (mode === 'remote') {
      if (draft?.editorGraph && draft.lastApiGraph)
        return { editorGraph: draft.editorGraph, apiGraph: draft.lastApiGraph };
    }
    return undefined;
  }, [draft, fakeGraphs, mode]);

  const draftBody = useCallback(
    (graphs: {
      readonly editorGraph: Record<string, unknown>;
      readonly apiGraph: Record<string, unknown>;
    }) => ({
      editorGraph: graphs.editorGraph,
      lastApiGraph: graphs.apiGraph,
      profileId: MINIMAX_H3_PROFILE_ID,
      profileVersion: MINIMAX_H3_PROFILE_VERSION,
      ...(selectedRevisionId
        ? { baseRevisionId: selectedRevisionId }
        : draft?.baseRevisionId
          ? { baseRevisionId: draft.baseRevisionId }
          : {}),
      ...(draft ? { expectedVersion: draft.version } : {}),
    }),
    [draft, selectedRevisionId],
  );

  const revisionBody = useCallback(
    (graphs: {
      readonly editorGraph: Record<string, unknown>;
      readonly apiGraph: Record<string, unknown>;
      readonly frontendVersion?: string;
    }) => ({
      editorGraph: graphs.editorGraph,
      apiGraph: graphs.apiGraph,
      profileId: MINIMAX_H3_PROFILE_ID,
      profileVersion: MINIMAX_H3_PROFILE_VERSION,
      source:
        mode === 'remote'
          ? ('comfy_editor' as const)
          : ('official_template' as const),
      ...(selectedRevisionId ? { parentRevisionId: selectedRevisionId } : {}),
      ...(graphs.frontendVersion
        ? { frontendVersion: graphs.frontendVersion }
        : {}),
    }),
    [mode, selectedRevisionId],
  );

  const saveDraftMutation = useMutation({
    mutationFn: (body: Parameters<typeof saveWorkflowDraft>[3]) =>
      saveWorkflowDraft(token, projectId, shot.id, body),
    onSuccess: () => {
      setNotice('Draft saved with optimistic versioning.');
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  const createRevisionMutation = useMutation({
    mutationFn: (body: Parameters<typeof createWorkflowRevision>[3]) =>
      createWorkflowRevision(token, projectId, shot.id, body),
    onSuccess: (result) => {
      setSelectedRevisionId(result.revision.id);
      setNotice(
        result.validation.valid
          ? `Revision ${result.revision.revisionNumber} validated.`
          : `Revision ${result.revision.revisionNumber} saved with validation errors.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  const validateMutation = useMutation({
    mutationFn: (revisionId: string) =>
      validateWorkflowRevision(token, revisionId),
    onSuccess: (result) => {
      setSelectedRevisionId(result.revision.id);
      setNotice(
        result.validation.valid
          ? 'Revision validated against the current executor.'
          : 'Revision remains invalid; review the correction details.',
      );
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
  const generateMutation = useMutation({
    mutationFn: (revisionId: string) =>
      createManagedAttempt(token, projectId, shot.id, revisionId),
    onSuccess: (result) => {
      setNotice(
        `Managed attempt ${result.attempt.id.slice(0, 12)}… queued. The worker will report progress below.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const saveDraft = (): void => {
    setActionError(undefined);
    const graphs = currentGraphs();
    if (!graphs) {
      setActionError(
        new Error('Export the graph from ComfyUI before saving this draft.'),
      );
      return;
    }
    saveDraftMutation.mutate(draftBody(graphs));
  };
  const createRevision = (): void => {
    setActionError(undefined);
    const graphs = currentGraphs();
    if (!graphs) {
      setActionError(
        new Error(
          'Export both editable and API graphs before creating a revision.',
        ),
      );
      return;
    }
    createRevisionMutation.mutate(revisionBody(graphs));
  };
  const confirmAndGenerate = async (): Promise<void> => {
    setConfirmGenerate(false);
    setActionError(undefined);
    try {
      let revision = selectedRevision;
      const graphs = currentGraphs();
      const hasFreshGraph = mode === 'fake';
      if (revision?.validationStatus !== 'validated' || hasFreshGraph) {
        if (!graphs) {
          setActionError(
            new Error(
              'Export the graph from ComfyUI before generating managed.',
            ),
          );
          return;
        }
        await saveDraftMutation.mutateAsync(draftBody(graphs));
        const created = await createRevisionMutation.mutateAsync(
          revisionBody(graphs),
        );
        if (
          !created.validation.valid ||
          created.revision.validationStatus !== 'validated'
        ) {
          setActionError(
            new Error(
              'The revision was saved but is not valid. Correct the validation errors before generating.',
            ),
          );
          return;
        }
        revision = created.revision;
      }
      if (!revision) {
        setActionError(new Error('A validated workflow revision is required.'));
        return;
      }
      await generateMutation.mutateAsync(revision.id);
    } catch (error) {
      setActionError(error);
    }
  };
  const useRevision = (revision: WorkflowRevision): void => {
    setSelectedRevisionId(revision.id);
    if (mode === 'fake')
      setSettings(
        extractFakeWorkflowSettings(
          revision.editorGraph,
          revision.apiGraph,
          settings,
        ),
      );
    setNotice(
      `Loaded revision ${revision.revisionNumber} as the editing base.`,
    );
  };
  const shotAttempts = attempts.filter((attempt) => attempt.shotId === shot.id);
  const editorReady = executor?.readiness.ready === true;
  const canGenerate =
    editorReady &&
    selectedRevision?.validationStatus !== 'invalid' &&
    (Boolean(currentGraphs()) ||
      Boolean(selectedRevision?.validationStatus === 'validated')) &&
    ['approved_for_generation', 'rejected', 'retryable'].includes(shot.status);
  return (
    <section className="shot-workspace" aria-labelledby="selected-shot-title">
      <div className="shot-workspace-heading">
        <div>
          <span className="section-kicker">
            SELECTED SHOT / {String(shot.ordinal).padStart(2, '0')}
          </span>
          <h2 id="selected-shot-title">{shot.purpose}</h2>
          <p>{shot.visualDescription ?? shot.prompt}</p>
        </div>
        <StatusBadge status={shot.status} />
      </div>
      <div className="shot-detail-grid">
        <aside className="shot-brief panel">
          <span className="section-kicker">SHOT BRIEF</span>
          <h3>Creative direction</h3>
          <dl className="compact-details">
            <div>
              <dt>Camera</dt>
              <dd>{shot.cameraDirection ?? 'Not specified'}</dd>
            </div>
            <div>
              <dt>Audio</dt>
              <dd>{shot.audioDirection ?? 'Not specified'}</dd>
            </div>
            {shot.dialogue && (
              <div>
                <dt>Dialogue</dt>
                <dd>{shot.dialogue}</dd>
              </div>
            )}
            <div>
              <dt>Duration</dt>
              <dd>{formatDuration(shot.durationSeconds)} target</dd>
            </div>
          </dl>
          <div className="criteria-block">
            <span className="metric-label">Acceptance criteria</span>
            <ul>
              {(shot.acceptanceCriteria ?? []).map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
        </aside>
        <div className="workflow-column">
          <div className="panel workflow-shell">
            <div className="workflow-shell-heading">
              <div>
                <span className="section-kicker">WORKFLOW AUTHORING</span>
                <h3>Shape the managed graph</h3>
              </div>
              <StatusBadge
                status={mode ?? (executorLoading ? 'checking' : 'unavailable')}
              />
            </div>
            {executorError !== undefined && executorError !== null ? (
              <ErrorNotice error={executorError} />
            ) : null}
            {!executorError && executorLoading && (
              <LoadingState label="Checking executor mode…" />
            )}
            {!executorError &&
              !executorLoading &&
              mode === 'remote' &&
              executor && <StandaloneComfySummary />}
            {!executorError && !executorLoading && mode === 'fake' && (
              <StandaloneWorkflowPanel
                settings={settings}
                onChange={setSettings}
              />
            )}
            {!executorError && !executorLoading && !editorReady && (
              <InfoNotice>
                The executor is not ready. Draft authoring remains visible, but
                validation and Generate managed will wait for capability
                recovery.
              </InfoNotice>
            )}
            <div className="workflow-actions">
              <div className="draft-state">
                <span className="metric-label">Draft state</span>
                <strong>
                  {draft ? `Saved · v${draft.version}` : 'Not saved yet'}
                </strong>
                {draft && <small>{formatDate(draft.updatedAt)}</small>}
              </div>
              <div className="button-row">
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={saveDraft}
                  disabled={saveDraftMutation.isPending || !currentGraphs()}
                >
                  {saveDraftMutation.isPending ? 'Saving…' : 'Save draft'}
                </button>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={createRevision}
                  disabled={
                    createRevisionMutation.isPending || !currentGraphs()
                  }
                >
                  {createRevisionMutation.isPending
                    ? 'Validating…'
                    : 'Create revision & validate'}
                </button>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => setConfirmGenerate(true)}
                  disabled={generateMutation.isPending || !canGenerate}
                >
                  {generateMutation.isPending
                    ? 'Queueing…'
                    : 'Generate managed'}
                </button>
              </div>
            </div>
            {saveDraftMutation.isError && (
              <ErrorNotice error={saveDraftMutation.error} />
            )}
            {createRevisionMutation.isError && (
              <ErrorNotice error={createRevisionMutation.error} />
            )}
            {validateMutation.isError && (
              <ErrorNotice error={validateMutation.error} />
            )}
            {generateMutation.isError && (
              <ErrorNotice error={generateMutation.error} />
            )}
            {actionError !== undefined && actionError !== null ? (
              <ErrorNotice error={actionError} />
            ) : null}
            {notice && <InfoNotice>{notice}</InfoNotice>}
            {confirmGenerate && (
              <ConfirmPanel
                title="Generate this managed revision?"
                detail="This queues one preview attempt and reserves the server-enforced budget. The worker alone submits the exact validated revision to ComfyUI."
                confirmLabel="Confirm Generate managed"
                onCancel={() => setConfirmGenerate(false)}
                onConfirm={() => void confirmAndGenerate()}
                busy={
                  generateMutation.isPending ||
                  createRevisionMutation.isPending ||
                  saveDraftMutation.isPending
                }
              />
            )}
          </div>
          <RevisionHistory
            revisions={revisions}
            selectedRevisionId={selectedRevisionId}
            onUse={useRevision}
            onValidate={(revision) => validateMutation.mutate(revision.id)}
            validatingId={
              validateMutation.isPending
                ? validateMutation.variables
                : undefined
            }
          />
        </div>
      </div>
      <section
        className="panel attempt-history"
        aria-labelledby="attempt-history-title"
      >
        <div className="panel-heading">
          <div>
            <span className="section-kicker">EXECUTION / REVIEW</span>
            <h3 id="attempt-history-title">Attempt history</h3>
          </div>
          <span className="count-badge">{shotAttempts.length}</span>
        </div>
        {shotAttempts.length === 0 && (
          <EmptyState
            title="No managed attempts"
            detail="A validated revision can be queued when this shot is approved for generation."
          />
        )}
        <div className="attempt-list">
          {shotAttempts
            .slice()
            .reverse()
            .map((attempt) => (
              <AttemptCard
                key={attempt.id}
                token={token}
                attempt={attempt}
                events={events}
                invalidateProject={invalidateProject}
              />
            ))}
        </div>
      </section>
    </section>
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
      isPlainObject(node) ? (node as { class_type?: unknown }).class_type : undefined,
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
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>();
  const [liveEvents, setLiveEvents] = useState<readonly ManagedLiveEvent[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const seenParentMessages = useRef(new Set<string>());
  const handledExports = useRef(new Set<string>());
  const defaultLoadSent = useRef(false);
  const statusSent = useRef('');
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
      if (result.runId) setSelectedRunId(result.runId);
      setNotice(
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
    if (!bridgeReady || !runsQuery.isSuccess || runs.length > 0) return;
    if (defaultLoadSent.current) return;
    defaultLoadSent.current = true;
    const template = buildFakeWorkflowGraphs(DEFAULT_FAKE_WORKFLOW_SETTINGS);
    postToComfy('workflow.load', { editorGraph: template.editorGraph });
    setNotice('The MiniMax H3 template is open in ComfyUI.');
  }, [bridgeReady, postToComfy, runs, runsQuery.isSuccess]);

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

  const statusEvaluation = useMemo(() => {
    if (!run) return undefined;
    const activeRunCount = runs.filter(
      (item) => item.status === 'queued' || item.status === 'running',
    ).length;
    const evaluation: Record<string, unknown> = {
      status: run.evaluationStatus,
      executorReadiness: 'managed-studio',
      activeRunCount,
      nodeDurations: { status: 'not-recorded' },
      openFindingCount: pendingFindings.length,
    };
    if (progress) evaluation.progress = progress;
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
  }, [pendingFindings.length, progress, run, runs]);

  useEffect(() => {
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
  }, [bridgeReady, postToComfy, run, statusEvaluation]);

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

  const loadRevision = (): void => {
    if (!run?.revision?.editorGraph) return;
    postToComfy('workflow.load', {
      editorGraph: run.revision.editorGraph,
      ...(run.revision.id ? { revisionId: run.revision.id } : {}),
    });
    setNotice(`Revision ${shortRunId(run.revision.id)} sent to ComfyUI.`);
  };

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
      {runsQuery.isError && <ErrorNotice error={runsQuery.error} />}
      {createRunMutation.isError && (
        <ErrorNotice error={createRunMutation.error} />
      )}
      {pinMutation.isError && <ErrorNotice error={pinMutation.error} />}
      {unpinMutation.isError && <ErrorNotice error={unpinMutation.error} />}
      {reviewMutation.isError && <ErrorNotice error={reviewMutation.error} />}
      {notice && <InfoNotice>{notice}</InfoNotice>}
      {runsQuery.isSuccess && runs.length === 0 && (
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
            Start from a brief
          </a>
        </section>
      )}
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
            {run && <StatusBadge status={run.status} />}
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
                {run.revision && (
                  <button
                    className="button button--quiet"
                    type="button"
                    onClick={loadRevision}
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
              <section
                className="managed-subsection"
                aria-labelledby="managed-findings-title"
              >
                <div className="panel-heading">
                  <h3 id="managed-findings-title">Findings</h3>
                  <span className="count-badge">{pendingFindings.length}</span>
                </div>
                {pendingFindings.length === 0 ? (
                  <p className="muted">No pending operator findings.</p>
                ) : (
                  <ul className="managed-finding-list">
                    {pendingFindings.map((finding) => (
                      <li key={finding.id}>
                        <StatusBadge status={finding.severity} />
                        <strong>{finding.title}</strong>
                        <span>{finding.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
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
              <section
                className="managed-subsection"
                aria-labelledby="managed-events-title"
              >
                <div className="panel-heading">
                  <h3 id="managed-events-title">Event feed</h3>
                  <span className="count-badge">{run.events.length}</span>
                </div>
                <ol className="managed-event-list">
                  {run.events
                    .slice(-8)
                    .reverse()
                    .map((event) => (
                      <li key={event.id}>
                        <strong>{humanize(event.type)}</strong>
                        <small>{formatDate(event.occurredAt)}</small>
                      </li>
                    ))}
                </ol>
              </section>
            </>
          )}
        </section>
      </div>
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
        <Route path="/" element={<ProjectListPage token={token} />} />
        <Route
          path="/projects/:projectId"
          element={<ProjectStudioPage token={token} />}
        />
        <Route
          path="/projects/:projectId/shots/:shotId"
          element={<ProjectStudioPage token={token} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}
