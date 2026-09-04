export const apiOrigin =
  import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000';

export interface ApiReadiness {
  readonly service: 'api';
  readonly status: 'ok' | 'degraded';
  readonly dependencies: { readonly postgres: 'ok' | 'unavailable' };
}

export interface Project {
  readonly id: string;
  readonly tenantId: string;
  readonly title: string;
  readonly brief: string;
  readonly status: string;
  readonly targetDurationSeconds: number;
  readonly budgetMicrousd: number;
  readonly budgetUsd: string;
  readonly spentMicrousd: number;
  readonly spentUsd: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoryboardShot {
  readonly ordinal: number;
  readonly purpose: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly mode: 't2v';
  readonly qualityTier: 'preview';
  readonly visualDescription?: string;
  readonly cameraDirection?: string;
  readonly audioDirection?: string;
  readonly dialogue?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly requiredAssetIds?: readonly string[];
}

export interface StoryboardProposal {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly status: 'proposed' | 'approved' | 'superseded';
  readonly shots: readonly StoryboardShot[];
  readonly totalDurationSeconds: number;
  readonly durationToleranceSeconds: number;
  readonly objective?: string;
  readonly assumptions?: readonly string[];
  readonly risks?: readonly string[];
  readonly agentRunId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Shot {
  readonly id: string;
  readonly projectId: string;
  readonly storyboardProposalId: string;
  readonly ordinal: number;
  readonly purpose: string;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly mode: 't2v';
  readonly qualityTier: 'preview';
  readonly visualDescription?: string;
  readonly cameraDirection?: string;
  readonly audioDirection?: string;
  readonly dialogue?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly requiredAssetIds?: readonly string[];
  readonly status: string;
  readonly acceptedAttemptId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecutorInfo {
  readonly mode: 'fake' | 'remote';
  readonly readiness: {
    readonly ready: boolean;
    readonly checkedAt: string;
    readonly apiVersion?: string;
    readonly capabilityFingerprint?: string;
    readonly errorCode?: string;
  };
  readonly frontendUrl?: string;
  readonly activeProfileIds: readonly string[];
  readonly capabilityFingerprint?: string;
  readonly capabilityValidatedAt: string;
  readonly worker: {
    readonly state: string;
    readonly queuePending: number;
    readonly queueRunning: number;
  };
}

export type WorkflowGraph = Record<string, unknown>;

export interface WorkflowDraft {
  readonly id: string;
  readonly projectId: string;
  readonly shotId: string;
  readonly baseRevisionId?: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly editorGraph: WorkflowGraph;
  readonly lastApiGraph?: WorkflowGraph;
  readonly authorType: string;
  readonly authorId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowValidationError {
  readonly code: string;
  readonly message: string;
}

export interface WorkflowValidation {
  readonly valid: boolean;
  readonly profileId?: string;
  readonly profileVersion?: string;
  readonly errors: readonly WorkflowValidationError[];
  readonly executorFingerprint?: string;
}

export interface WorkflowRevision {
  readonly id: string;
  readonly projectId: string;
  readonly shotId: string;
  readonly revisionNumber: number;
  readonly parentRevisionId?: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly source: string;
  readonly frontendVersion?: string;
  readonly frontendCommit?: string;
  readonly authorType: string;
  readonly authorId: string;
  readonly editorGraph: WorkflowGraph;
  readonly apiGraph: WorkflowGraph;
  readonly executionHash: string;
  readonly executionParameters: Record<string, unknown>;
  readonly validationStatus: 'pending' | 'validated' | 'invalid';
  readonly validationErrors: readonly WorkflowValidationError[];
  readonly validatedAt?: string;
  readonly executorFingerprint?: string;
  readonly createdAt: string;
}

export interface WorkflowRevisionResult {
  readonly revision: WorkflowRevision;
  readonly validation: WorkflowValidation;
}

export interface Attempt {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly shotId: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly seed: number;
  readonly steps: number;
  readonly requestedWidth: number;
  readonly requestedHeight: number;
  readonly requestedDurationSeconds: number;
  readonly workflowVersionId?: string;
  readonly workflowRevisionId?: string;
  readonly workflowHash: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly scenario?: string;
  readonly comfyPromptId?: string;
  readonly queuedAt: string;
  readonly submittedAt?: string;
  readonly finishedAt?: string;
  readonly computeSeconds?: number;
  readonly estimatedCostMicrousd: number;
  readonly estimatedCostUsd: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly sourceAttemptId?: string;
  readonly artifactId?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvaluationCheck {
  readonly status: 'passed' | 'failed' | 'not_applicable';
  readonly detail: string;
}

export interface Evaluation {
  readonly id: string;
  readonly attemptId: string;
  readonly evaluatorVersion: string;
  readonly status: 'passed' | 'failed';
  readonly checks: Record<string, EvaluationCheck>;
  readonly details: Record<string, unknown>;
  readonly evaluatedAt: string;
}

export interface AttemptDetail {
  readonly attempt: Attempt;
  readonly evaluation?: Evaluation;
}

export interface Cost {
  readonly budgetMicrousd: number;
  readonly budgetUsd: string;
  readonly spentMicrousd: number;
  readonly spentUsd: string;
  readonly remainingMicrousd: number;
  readonly remainingUsd: string;
}

export interface RunCost {
  readonly estimatedCostMicrousd: number;
  readonly estimatedCostUsd: string;
  readonly projectBudgetMicrousd: number | null;
  readonly projectBudgetUsd: string | null;
  readonly projectSpentMicrousd: number;
  readonly projectSpentUsd: string;
  readonly projectRemainingMicrousd: number | null;
  readonly projectRemainingUsd: string | null;
}

export interface RunReview {
  readonly decision: 'accepted' | 'rejected';
  readonly note?: string;
  readonly author?: string;
  readonly reviewedAt?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly projectId: string;
  readonly revisionId: string | null;
  readonly executionHash: string;
  readonly status: string;
  readonly validation: {
    readonly status: string;
    readonly errors: readonly WorkflowValidationError[];
  };
  readonly attempt: Omit<Attempt, 'shotId'>;
  readonly revision: Omit<WorkflowRevision, 'shotId'> | null;
  readonly artifact: Record<string, unknown> | null;
  readonly evaluation: Evaluation | null;
  readonly evaluationStatus: 'passed' | 'failed' | 'not-run';
  readonly cost: RunCost;
  readonly review: RunReview | null;
  readonly pinned: boolean;
  readonly project: Project;
  readonly events: readonly ProjectEvent[];
}

export interface CreateRunResponse {
  readonly runId: string | null;
  readonly projectId: string;
  readonly revisionId: string;
  readonly executionHash: string;
  readonly status: string;
  readonly validation: {
    readonly status: string;
    readonly errors: readonly WorkflowValidationError[];
  };
}

export interface ProjectEvent {
  readonly id: string;
  readonly eventSequence?: number;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly observedAt?: string;
  readonly projectId?: string;
  readonly shotId?: string;
  readonly attemptId?: string;
  readonly payload: Record<string, unknown>;
}

export interface OperatorRecommendation {
  readonly id: string;
  readonly projectId: string;
  readonly shotId?: string;
  readonly attemptId?: string;
  readonly triggerEventId: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly recommendationCode: string;
  readonly title: string;
  readonly detail: string;
  readonly evidenceReferences: readonly {
    readonly type: string;
    readonly resourceId: string;
  }[];
  readonly proposedActionType: string;
  readonly proposedResourceIds: readonly string[];
  readonly status: 'pending' | 'applied' | 'dismissed' | 'expired';
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SseEvent {
  readonly id: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface ApiProblem {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly traceId?: string;
  readonly retryable?: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;
  readonly retryable: boolean;

  constructor(problem: ApiProblem, fallbackStatus = 500) {
    super(problem.detail ?? problem.title ?? 'The API request failed.');
    this.name = 'ApiError';
    this.status = problem.status ?? fallbackStatus;
    this.code = problem.code ?? 'API_REQUEST_FAILED';
    this.retryable = problem.retryable === true;
    if (problem.traceId) this.traceId = problem.traceId;
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { detail: 'The API returned malformed JSON.' };
  }
}

async function request<T>(
  token: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...options.headers,
  };
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;
  const response = await fetch(`${apiOrigin}${path}`, init);
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(
      isRecord(payload) ? (payload as ApiProblem) : {},
      response.status,
    );
  }
  return payload as T;
}

async function publicRequest<T>(path: string): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    headers: { accept: 'application/json' },
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(
      isRecord(payload) ? (payload as ApiProblem) : {},
      response.status,
    );
  }
  return payload as T;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function createIdempotencyKey(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  const suffix =
    random ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`.slice(0, 200);
}

function mutationOptions(prefix: string, body: unknown): RequestOptions {
  return {
    method: 'POST',
    body,
    headers: { 'idempotency-key': createIdempotencyKey(prefix) },
  };
}

export function fetchReadiness(): Promise<ApiReadiness> {
  return publicRequest<ApiReadiness>('/health/ready');
}

export function listProjects(
  token: string,
): Promise<{ readonly projects: readonly Project[] }> {
  return request(token, '/v1/projects');
}

export function getProject(
  token: string,
  projectId: string,
): Promise<{ readonly project: Project }> {
  return request(token, `/v1/projects/${pathSegment(projectId)}`);
}

export function getStoryboard(
  token: string,
  projectId: string,
): Promise<{ readonly proposal: StoryboardProposal | null }> {
  return request(token, `/v1/projects/${pathSegment(projectId)}/storyboard`);
}

export function listShots(
  token: string,
  projectId: string,
): Promise<{ readonly shots: readonly Shot[] }> {
  return request(token, `/v1/projects/${pathSegment(projectId)}/shots`);
}

export function createProject(
  token: string,
  body: {
    readonly title: string;
    readonly brief: string;
    readonly targetDurationSeconds: number;
    readonly budgetUsd?: string;
  },
): Promise<{ readonly project: Project }> {
  return request(
    token,
    '/v1/projects',
    mutationOptions('project-create', body),
  );
}

export function planProject(
  token: string,
  projectId: string,
): Promise<{
  readonly project: Project;
  readonly proposal: StoryboardProposal;
}> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/plan`,
    mutationOptions('project-plan', {}),
  );
}

export function approveStoryboard(
  token: string,
  projectId: string,
  proposalId: string,
): Promise<{ readonly project: Project; readonly shots: readonly Shot[] }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/storyboard/approve`,
    mutationOptions('storyboard-approve', { proposalId }),
  );
}

export function getExecutor(token: string): Promise<ExecutorInfo> {
  return request(token, '/v1/executor');
}

export function listRuns(
  token: string,
  filters: {
    readonly status?: string;
    readonly reviewed?: boolean;
    readonly pinned?: boolean;
    readonly evaluation?: 'passed' | 'failed' | 'not-run';
    readonly projectId?: string;
    readonly since?: string;
    readonly limit?: number;
  } = {},
): Promise<{
  readonly runs: readonly RunRecord[];
  readonly nextSince?: string;
}> {
  const query = new URLSearchParams();
  if (filters.status) query.set('status', filters.status);
  if (filters.reviewed !== undefined)
    query.set('reviewed', String(filters.reviewed));
  if (filters.pinned !== undefined) query.set('pinned', String(filters.pinned));
  if (filters.evaluation) query.set('evaluation', filters.evaluation);
  if (filters.projectId) query.set('projectId', filters.projectId);
  if (filters.since) query.set('since', filters.since);
  if (filters.limit !== undefined) query.set('limit', String(filters.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request(token, `/v1/runs${suffix}`);
}

export function getRun(token: string, runId: string): Promise<RunRecord> {
  return request(token, `/v1/runs/${pathSegment(runId)}`);
}

export function createRun(
  token: string,
  body: {
    readonly editorGraph: WorkflowGraph;
    readonly apiGraph: WorkflowGraph;
    readonly label?: string;
    readonly projectId?: string;
    readonly profileId?: string;
    readonly idempotencyKey?: string;
    readonly executionHash?: string;
  },
  idempotencyKey?: string,
): Promise<CreateRunResponse> {
  const headerKey =
    idempotencyKey ?? body.idempotencyKey ?? createIdempotencyKey('run-create');
  return request(token, '/v1/runs', {
    method: 'POST',
    body,
    headers: { 'idempotency-key': headerKey },
  });
}

export function pinRun(token: string, runId: string): Promise<RunRecord> {
  return request(
    token,
    `/v1/runs/${pathSegment(runId)}/pin`,
    mutationOptions('run-pin', {}),
  );
}

export function unpinRun(token: string, runId: string): Promise<RunRecord> {
  return request(token, `/v1/runs/${pathSegment(runId)}/pin`, {
    method: 'DELETE',
    headers: { 'idempotency-key': createIdempotencyKey('run-unpin') },
  });
}

export function reviewRun(
  token: string,
  runId: string,
  body: { readonly decision: 'accepted' | 'rejected'; readonly note?: string },
): Promise<RunRecord> {
  return request(
    token,
    `/v1/runs/${pathSegment(runId)}/review`,
    mutationOptions('run-review', body),
  );
}

export function getWorkflowDraft(
  token: string,
  projectId: string,
  shotId: string,
): Promise<{ readonly draft: WorkflowDraft | null }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/shots/${pathSegment(shotId)}/workflow-draft`,
  );
}

export function saveWorkflowDraft(
  token: string,
  projectId: string,
  shotId: string,
  body: {
    readonly editorGraph: WorkflowGraph;
    readonly lastApiGraph: WorkflowGraph;
    readonly baseRevisionId?: string;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly expectedVersion?: number;
  },
): Promise<{ readonly draft: WorkflowDraft }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/shots/${pathSegment(shotId)}/workflow-draft`,
    {
      method: 'PUT',
      body,
      headers: {
        'idempotency-key': createIdempotencyKey('workflow-draft-save'),
      },
    },
  );
}

export function listWorkflowRevisions(
  token: string,
  projectId: string,
  shotId: string,
): Promise<{ readonly revisions: readonly WorkflowRevision[] }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/shots/${pathSegment(shotId)}/workflow-revisions`,
  );
}

export function createWorkflowRevision(
  token: string,
  projectId: string,
  shotId: string,
  body: {
    readonly editorGraph: WorkflowGraph;
    readonly apiGraph: WorkflowGraph;
    readonly parentRevisionId?: string;
    readonly profileId: string;
    readonly profileVersion: string;
    readonly source: 'comfy_editor' | 'official_template' | 'system';
    readonly frontendVersion?: string;
  },
): Promise<WorkflowRevisionResult> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/shots/${pathSegment(shotId)}/workflow-revisions`,
    mutationOptions('workflow-revision-create', body),
  );
}

export function validateWorkflowRevision(
  token: string,
  revisionId: string,
): Promise<WorkflowRevisionResult> {
  return request(
    token,
    `/v1/workflow-revisions/${pathSegment(revisionId)}/validate`,
    mutationOptions('workflow-revision-validate', {}),
  );
}

export function createManagedAttempt(
  token: string,
  projectId: string,
  shotId: string,
  workflowRevisionId: string,
): Promise<{ readonly attempt: Attempt }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/shots/${pathSegment(shotId)}/managed-attempts`,
    mutationOptions('managed-attempt-create', { workflowRevisionId }),
  );
}

export function listProjectAttempts(
  token: string,
  projectId: string,
): Promise<{ readonly attempts: readonly Attempt[] }> {
  return request(token, `/v1/projects/${pathSegment(projectId)}/attempts`);
}

export function getAttemptDetail(
  token: string,
  attemptId: string,
): Promise<AttemptDetail> {
  return request(token, `/v1/attempts/${pathSegment(attemptId)}`);
}

export function acceptAttempt(
  token: string,
  attemptId: string,
): Promise<unknown> {
  return request(
    token,
    `/v1/attempts/${pathSegment(attemptId)}/accept`,
    mutationOptions('attempt-accept', {}),
  );
}

export function rejectAttempt(
  token: string,
  attemptId: string,
  reasonCode: string,
): Promise<unknown> {
  return request(
    token,
    `/v1/attempts/${pathSegment(attemptId)}/reject`,
    mutationOptions('attempt-reject', { reasonCode }),
  );
}

export function retryAttempt(
  token: string,
  attemptId: string,
  resolveUncertain = false,
): Promise<{ readonly attempt: Attempt }> {
  return request(
    token,
    `/v1/attempts/${pathSegment(attemptId)}/retry`,
    mutationOptions(
      'attempt-retry',
      resolveUncertain ? { resolveUncertain: true } : {},
    ),
  );
}

export function getCost(token: string, projectId: string): Promise<Cost> {
  return request(token, `/v1/projects/${pathSegment(projectId)}/cost`);
}

export function listProjectEvents(
  token: string,
  projectId: string,
): Promise<{ readonly events: readonly ProjectEvent[] }> {
  return request(token, `/v1/projects/${pathSegment(projectId)}/events`);
}

export function listRecommendations(
  token: string,
  projectId: string,
): Promise<{ readonly recommendations: readonly OperatorRecommendation[] }> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/operator/recommendations`,
  );
}

export function applyRecommendation(
  token: string,
  projectId: string,
  recommendationId: string,
  expectedVersion: number,
): Promise<unknown> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/operator/recommendations/${pathSegment(recommendationId)}/apply`,
    {
      method: 'POST',
      body: { expectedVersion },
      headers: {
        'idempotency-key': createIdempotencyKey('recommendation-apply'),
      },
    },
  );
}

export function dismissRecommendation(
  token: string,
  projectId: string,
  recommendationId: string,
  expectedVersion: number,
): Promise<unknown> {
  return request(
    token,
    `/v1/projects/${pathSegment(projectId)}/operator/recommendations/${pathSegment(recommendationId)}/dismiss`,
    {
      method: 'POST',
      body: { expectedVersion },
      headers: {
        'idempotency-key': createIdempotencyKey('recommendation-dismiss'),
      },
    },
  );
}

export function artifactContentUrl(artifactId: string): string {
  return `${apiOrigin}/v1/artifacts/${pathSegment(artifactId)}/content`;
}

export async function fetchArtifact(
  token: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(artifactContentUrl(artifactId), {
    headers: { accept: 'video/mp4', authorization: `Bearer ${token}` },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const payload = await parseResponse(response);
    throw new ApiError(
      isRecord(payload) ? (payload as ApiProblem) : {},
      response.status,
    );
  }
  return response.blob();
}

export async function fetchProjectEventStream(
  token: string,
  projectId: string,
  lastEventId: number,
  signal?: AbortSignal,
): Promise<readonly SseEvent[]> {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    authorization: `Bearer ${token}`,
  };
  if (lastEventId > 0) headers['last-event-id'] = String(lastEventId);
  const response = await fetch(
    `${apiOrigin}/v1/projects/${pathSegment(projectId)}/events/stream`,
    { headers, ...(signal ? { signal } : {}) },
  );
  const payload = await response.text();
  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      parsed = {};
    }
    throw new ApiError(
      isRecord(parsed) ? (parsed as ApiProblem) : {},
      response.status,
    );
  }
  return parseSseFrames(payload);
}

export function parseSseFrames(text: string): readonly SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    let id: number | undefined;
    let type = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value =
        separator === -1 ? '' : line.slice(separator + 1).trimStart();
      if (field === 'id' && /^\d+$/.test(value)) id = Number(value);
      if (field === 'event' && value) type = value;
      if (field === 'data') dataLines.push(value);
    }
    if (id === undefined || dataLines.length === 0) continue;
    try {
      const data = JSON.parse(dataLines.join('\n')) as unknown;
      if (isRecord(data)) events.push({ id, type, data });
    } catch {
      // A malformed frame is ignored; the next REST refresh reconstructs truth.
    }
  }
  return events;
}
