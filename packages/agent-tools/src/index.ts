import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { GenerationAttempt, Shot, Uuid, VideoProject } from '@h3/domain';

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

function textResult<T extends OperationalToolDetails>(
  details: T,
): AgentToolResult<T> {
  return {
    content: [{ type: 'text', text: JSON.stringify(details) }],
    details,
  };
}

function typeBoxObject(properties: Record<string, TSchema>) {
  return Type.Object(properties, { additionalProperties: false });
}

/**
 * Operational Pi is deliberately a different capability surface from the
 * storyboard planner. These tools are reads only; the operator can propose an
 * action, but it cannot execute one.
 */
export const OPERATIONAL_TOOL_NAMES = [
  'get_project_status',
  'get_shot_status',
  'get_workflow_revision_validation',
  'get_attempt_status',
  'get_recent_incidents',
  'get_executor_readiness',
] as const;

export type OperationalToolName = (typeof OPERATIONAL_TOOL_NAMES)[number];

export interface OperationalProjectToolView {
  readonly id: Uuid;
  readonly status: VideoProject['status'];
  readonly budgetMicrousd: number | null;
  readonly spentMicrousd: number;
  readonly remainingMicrousd: number | null;
}

export interface OperationalShotToolView {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly status: Shot['status'];
  readonly acceptanceCriteria: readonly string[];
}

export interface OperationalWorkflowRevisionToolView {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly validationStatus: 'pending' | 'validated' | 'invalid';
  readonly validationErrors: readonly {
    readonly code: string;
    readonly message: string;
  }[];
  readonly executorFingerprint?: string;
}

export interface OperationalAttemptToolView {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly status: GenerationAttempt['status'];
  readonly failureCode?: GenerationAttempt['failureCode'];
}

export interface OperationalIncidentToolView {
  readonly eventId: Uuid;
  readonly type: string;
  readonly status: string;
  readonly occurredAt: string;
  readonly code?: string;
  readonly shotId?: Uuid;
  readonly attemptId?: Uuid;
}

export interface OperationalExecutorToolView {
  readonly mode: string;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly capabilityFingerprint?: string;
  readonly errorCode?: string;
  readonly pendingCount?: number;
  readonly runningCount?: number;
}

export interface OperationalToolServices {
  getProjectStatus(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<OperationalProjectToolView | null>;
  getShotStatus(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
  ): Promise<OperationalShotToolView | null>;
  getWorkflowRevisionValidation(
    tenantId: Uuid,
    projectId: Uuid,
    shotId: Uuid,
    revisionId: Uuid,
  ): Promise<OperationalWorkflowRevisionToolView | null>;
  getAttemptStatus(
    tenantId: Uuid,
    projectId: Uuid,
    attemptId: Uuid,
  ): Promise<OperationalAttemptToolView | null>;
  getRecentIncidents(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly OperationalIncidentToolView[]>;
  getExecutorReadiness(): Promise<OperationalExecutorToolView>;
}

export interface OperationalToolContext {
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly shotId?: Uuid;
  readonly attemptId?: Uuid;
  readonly workflowRevisionId?: Uuid;
  readonly services: OperationalToolServices;
  readonly onPolicyDenial?: (code: string, operation: string) => void;
}

const operationalProjectParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
});
const operationalShotParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  shotId: Type.String({ format: 'uuid' }),
});
const operationalRevisionParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  shotId: Type.String({ format: 'uuid' }),
  revisionId: Type.String({ format: 'uuid' }),
});
const operationalAttemptParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  attemptId: Type.String({ format: 'uuid' }),
});
const operationalEmptyParams = typeBoxObject({});

const operationalProjectInputSchema = z
  .object({ projectId: z.string().uuid().optional() })
  .strict();
const operationalShotInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    shotId: z.string().uuid(),
  })
  .strict();
const operationalRevisionInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    shotId: z.string().uuid(),
    revisionId: z.string().uuid(),
  })
  .strict();
const operationalAttemptInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    attemptId: z.string().uuid(),
  })
  .strict();
const operationalEmptyInputSchema = z.object({}).strict();

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function operationalUuid(value: unknown): Uuid | undefined {
  return typeof value === 'string' && uuidPattern.test(value)
    ? (value as Uuid)
    : undefined;
}

function operationalText(
  value: unknown,
  maximum: number,
  fallback: string,
): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, maximum)
    : fallback;
}

function operationalCode(value: unknown, fallback: string): string {
  const candidate = operationalText(value, 64, fallback).toUpperCase();
  return /^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(candidate) ? candidate : fallback;
}

function operationalErrors(
  value: unknown,
): readonly { readonly code: string; readonly message: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((issue) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const record = issue as Record<string, unknown>;
    return [
      {
        code: operationalCode(record.code, 'VALIDATION_ERROR'),
        message: operationalText(
          record.message,
          500,
          'The workflow validation failed.',
        ),
      },
    ];
  });
}

/**
 * One sanitizer per view, shared by the tool that returns it and by the
 * evidence W6 seeds into the prompt: same truncation, same fallbacks, same
 * field order. A second copy is how a seeded row would come to disagree with
 * the tool the model can re-read it with.
 */
function operationalProjectView(
  project: OperationalProjectToolView,
): OperationalProjectToolView {
  return {
    id: project.id,
    status: project.status,
    budgetMicrousd: project.budgetMicrousd,
    spentMicrousd: project.spentMicrousd,
    remainingMicrousd: project.remainingMicrousd,
  };
}

function operationalShotView(
  shot: OperationalShotToolView,
): OperationalShotToolView {
  return {
    id: shot.id,
    projectId: shot.projectId,
    status: shot.status,
    acceptanceCriteria: Array.isArray(shot.acceptanceCriteria)
      ? shot.acceptanceCriteria
          .filter(
            (criterion): criterion is string =>
              typeof criterion === 'string' && criterion.trim().length > 0,
          )
          .slice(0, 8)
          .map((criterion) => criterion.trim().slice(0, 280))
      : [],
  };
}

function operationalRevisionView(
  revision: OperationalWorkflowRevisionToolView,
): OperationalWorkflowRevisionToolView {
  return {
    id: revision.id,
    projectId: revision.projectId,
    shotId: revision.shotId,
    profileId: operationalText(revision.profileId, 128, 'unknown-profile'),
    profileVersion: operationalText(
      revision.profileVersion,
      64,
      'unknown-version',
    ),
    validationStatus: revision.validationStatus,
    validationErrors: operationalErrors(revision.validationErrors),
    ...(revision.executorFingerprint
      ? {
          executorFingerprint: operationalText(
            revision.executorFingerprint,
            256,
            'unknown',
          ),
        }
      : {}),
  };
}

function operationalAttemptView(
  attempt: OperationalAttemptToolView,
): OperationalAttemptToolView {
  return {
    id: attempt.id,
    projectId: attempt.projectId,
    shotId: attempt.shotId,
    status: attempt.status,
    ...(attempt.failureCode ? { failureCode: attempt.failureCode } : {}),
  };
}

/** The evidence the adapter has already resolved for one incident. */
export interface OperationalEvidenceViews {
  readonly project: OperationalProjectToolView;
  readonly shot?: OperationalShotToolView;
  readonly attempt?: OperationalAttemptToolView;
  readonly revision?: OperationalWorkflowRevisionToolView;
}

/**
 * W6: the rows the adapter resolved before the run, rendered for the prompt
 * through the same sanitizers the tools use -- so a model that re-reads one
 * gets byte-identical JSON back, and a model that trusts what it was given
 * spends its turns on the two views nobody resolved for it instead.
 */
export function describeOperationalEvidence(
  evidence: OperationalEvidenceViews,
): string {
  const row = (tool: OperationalToolName, data: unknown): string =>
    `- ${tool}: ${JSON.stringify(data)}`;
  return [
    'Evidence already read for this incident, each row in the exact shape ' +
      'the named tool returns:',
    row('get_project_status', operationalProjectView(evidence.project)),
    ...(evidence.shot
      ? [row('get_shot_status', operationalShotView(evidence.shot))]
      : []),
    ...(evidence.attempt
      ? [row('get_attempt_status', operationalAttemptView(evidence.attempt))]
      : []),
    ...(evidence.revision
      ? [
          row(
            'get_workflow_revision_validation',
            operationalRevisionView(evidence.revision),
          ),
        ]
      : []),
    'Those tools return this same JSON, so use your tool calls for what is ' +
      'not above -- get_recent_incidents and get_executor_readiness -- and ' +
      'then submit.',
  ].join('\n');
}

type OperationalToolDetails =
  | { readonly ok: true; readonly code: 'OK'; readonly data?: unknown }
  | {
      readonly ok: false;
      readonly code: string;
      /** W7: what to do about `code`, in a sentence the model can act on. */
      readonly message: string;
    };

/** What each tool accepts, named in every argument bounce `prepareArguments` throws. */
const OPERATIONAL_TOOL_ARGUMENTS: Record<OperationalToolName, string> = {
  get_project_status: 'It takes an optional projectId and nothing else.',
  get_shot_status: 'It takes shotId, and optionally projectId.',
  get_workflow_revision_validation:
    'It takes shotId and revisionId, and optionally projectId.',
  get_attempt_status: 'It takes attemptId, and optionally projectId.',
  get_recent_incidents: 'It takes an optional projectId and nothing else.',
  get_executor_readiness: 'It takes no arguments.',
};

type OperationalScopedKey = 'shotId' | 'attemptId' | 'workflowRevisionId';

/**
 * The parameter each scoped identifier is *called* by, which is not the
 * context key for the revision: the payload and the tool context call it
 * `workflowRevisionId`, `operationalRevisionParams` calls it `revisionId`. A
 * denial that named the context key would tell the model to send a parameter
 * no tool takes -- the opposite of W7's point.
 */
const OPERATIONAL_SCOPED_PARAMETERS: Record<
  OperationalScopedKey,
  { readonly parameter: string; readonly noun: string }
> = {
  shotId: { parameter: 'shotId', noun: 'shot' },
  attemptId: { parameter: 'attemptId', noun: 'attempt' },
  workflowRevisionId: { parameter: 'revisionId', noun: 'workflow revision' },
};

/**
 * W7: a denial the model can act on. A bare code cannot distinguish "you
 * asked about the wrong resource" from "that evidence does not exist", so a
 * model spends several blind retries telling them apart. A scope denial
 * therefore names the identifier this run is actually scoped to -- one
 * corrective turn -- and every other denial says plainly that the evidence is
 * not coming, so the conclusion has to be reached without it.
 */
function operationalDenialMessage(
  context: OperationalToolContext,
  code: string,
  operation: OperationalToolName,
): string {
  /**
   * Names every identifier the call needs, or -- when one of them is not in
   * this run's scope at all -- says so about the first that is missing, since
   * there is no value to offer for it.
   */
  const scoped = (
    ...keys: readonly [OperationalScopedKey, ...OperationalScopedKey[]]
  ): string => {
    const missing = keys.find((key) => context[key] === undefined);
    if (!missing) {
      const args = keys
        .map(
          (key) =>
            `${OPERATIONAL_SCOPED_PARAMETERS[key].parameter}=${context[key]}`,
        )
        .join(' and ');
      return `${operation} is scoped to this incident: call it with ${args}.`;
    }
    const { parameter, noun } = OPERATIONAL_SCOPED_PARAMETERS[missing];
    return `${operation} did not accept that ${parameter}. This incident is scoped to projectId=${context.projectId} and names no ${noun}, so there is no other one to try -- conclude from the evidence you do have.`;
  };
  const unavailable = (noun: string): string =>
    `The ${noun} for this incident is not readable. Retrying ${operation} will not change that -- reach your conclusion from the evidence you do have.`;
  switch (code) {
    case 'PROJECT_SCOPE_DENIED':
      return `${operation} is scoped to this incident: call it with projectId=${context.projectId}, or omit projectId.`;
    case 'SHOT_SCOPE_DENIED':
      return scoped('shotId');
    case 'ATTEMPT_SCOPE_DENIED':
      return scoped('attemptId');
    case 'WORKFLOW_SCOPE_DENIED':
      return scoped('shotId', 'workflowRevisionId');
    case 'INVALID_ARGUMENTS':
      return `${operation} could not read its arguments. ${OPERATIONAL_TOOL_ARGUMENTS[operation]}`;
    case 'PROJECT_NOT_FOUND':
      return unavailable('project');
    case 'SHOT_NOT_FOUND':
      return unavailable('shot');
    case 'WORKFLOW_REVISION_NOT_FOUND':
      return unavailable('workflow revision');
    case 'ATTEMPT_NOT_FOUND':
      return unavailable('attempt');
    case 'INCIDENTS_UNAVAILABLE':
      return unavailable('incident history');
    case 'EXECUTOR_UNAVAILABLE':
      return unavailable('executor readiness');
    default:
      return `${operation} was denied (${code}). Reach your conclusion from the evidence you do have.`;
  }
}

function operationalDenied(
  context: OperationalToolContext,
  code: string,
  operation: OperationalToolName,
): AgentToolResult<OperationalToolDetails> {
  context.onPolicyDenial?.(code, operation);
  return textResult({
    ok: false,
    code,
    message: operationalDenialMessage(context, code, operation),
  });
}

function operationalProject(
  context: OperationalToolContext,
  requestedProjectId: string | undefined,
  operation: OperationalToolName,
): Uuid | undefined {
  if (
    requestedProjectId !== undefined &&
    requestedProjectId !== context.projectId
  ) {
    context.onPolicyDenial?.('PROJECT_SCOPE_DENIED', operation);
    return undefined;
  }
  return context.projectId;
}

function operationalResource(
  context: OperationalToolContext,
  requested: string,
  expected: Uuid | undefined,
  operation: OperationalToolName,
): Uuid | undefined {
  const resourceId = operationalUuid(requested);
  if (!resourceId || (expected !== undefined && resourceId !== expected)) {
    context.onPolicyDenial?.('RESOURCE_SCOPE_DENIED', operation);
    return undefined;
  }
  return resourceId;
}

function operationalTool(input: {
  readonly name: OperationalToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<OperationalToolDetails>>;
}): AgentTool {
  return {
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.parameters,
    execute: async (toolCallId, params, signal) =>
      input.execute(toolCallId, params, signal),
  };
}

/** Build the bounded, read-only tool set for one event-scoped operator run. */
export function createOperationalReadTools(
  context: OperationalToolContext,
): AgentTool[] {
  const tools: AgentTool[] = [];

  tools.push(
    operationalTool({
      name: 'get_project_status',
      label: 'Get project status',
      description: 'Read the scoped project status and remaining budget.',
      parameters: operationalProjectParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalProjectInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_project_status',
          );
        }
        const projectId = operationalProject(
          context,
          parsed.data.projectId,
          'get_project_status',
        );
        if (!projectId) {
          return operationalDenied(
            context,
            'PROJECT_SCOPE_DENIED',
            'get_project_status',
          );
        }
        try {
          const project = await context.services.getProjectStatus(
            context.tenantId,
            projectId,
          );
          if (!project || project.id !== projectId) {
            return operationalDenied(
              context,
              'PROJECT_NOT_FOUND',
              'get_project_status',
            );
          }
          return textResult({
            ok: true,
            code: 'OK',
            data: operationalProjectView(project),
          });
        } catch {
          return operationalDenied(
            context,
            'PROJECT_NOT_FOUND',
            'get_project_status',
          );
        }
      },
    }),
  );

  tools.push(
    operationalTool({
      name: 'get_shot_status',
      label: 'Get shot status',
      description: 'Read the scoped shot status and acceptance criteria.',
      parameters: operationalShotParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalShotInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_shot_status',
          );
        }
        const projectId = operationalProject(
          context,
          parsed.data.projectId,
          'get_shot_status',
        );
        const shotId = operationalResource(
          context,
          parsed.data.shotId,
          context.shotId,
          'get_shot_status',
        );
        if (!projectId || !shotId) {
          return operationalDenied(
            context,
            'SHOT_SCOPE_DENIED',
            'get_shot_status',
          );
        }
        try {
          const shot = await context.services.getShotStatus(
            context.tenantId,
            projectId,
            shotId,
          );
          if (!shot || shot.id !== shotId || shot.projectId !== projectId) {
            return operationalDenied(
              context,
              'SHOT_NOT_FOUND',
              'get_shot_status',
            );
          }
          return textResult({
            ok: true,
            code: 'OK',
            data: operationalShotView(shot),
          });
        } catch {
          return operationalDenied(
            context,
            'SHOT_NOT_FOUND',
            'get_shot_status',
          );
        }
      },
    }),
  );

  tools.push(
    operationalTool({
      name: 'get_workflow_revision_validation',
      label: 'Get workflow validation',
      description: 'Read only the scoped workflow revision validation summary.',
      parameters: operationalRevisionParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalRevisionInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_workflow_revision_validation',
          );
        }
        const projectId = operationalProject(
          context,
          parsed.data.projectId,
          'get_workflow_revision_validation',
        );
        const shotId = operationalResource(
          context,
          parsed.data.shotId,
          context.shotId,
          'get_workflow_revision_validation',
        );
        const revisionId = operationalResource(
          context,
          parsed.data.revisionId,
          context.workflowRevisionId,
          'get_workflow_revision_validation',
        );
        if (!projectId || !shotId || !revisionId) {
          return operationalDenied(
            context,
            'WORKFLOW_SCOPE_DENIED',
            'get_workflow_revision_validation',
          );
        }
        try {
          const revision = await context.services.getWorkflowRevisionValidation(
            context.tenantId,
            projectId,
            shotId,
            revisionId,
          );
          if (
            !revision ||
            revision.id !== revisionId ||
            revision.projectId !== projectId ||
            revision.shotId !== shotId
          ) {
            return operationalDenied(
              context,
              'WORKFLOW_REVISION_NOT_FOUND',
              'get_workflow_revision_validation',
            );
          }
          return textResult({
            ok: true,
            code: 'OK',
            data: operationalRevisionView(revision),
          });
        } catch {
          return operationalDenied(
            context,
            'WORKFLOW_REVISION_NOT_FOUND',
            'get_workflow_revision_validation',
          );
        }
      },
    }),
  );

  tools.push(
    operationalTool({
      name: 'get_attempt_status',
      label: 'Get attempt status',
      description: 'Read the scoped attempt status and failure code only.',
      parameters: operationalAttemptParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalAttemptInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_attempt_status',
          );
        }
        const projectId = operationalProject(
          context,
          parsed.data.projectId,
          'get_attempt_status',
        );
        const attemptId = operationalResource(
          context,
          parsed.data.attemptId,
          context.attemptId,
          'get_attempt_status',
        );
        if (!projectId || !attemptId) {
          return operationalDenied(
            context,
            'ATTEMPT_SCOPE_DENIED',
            'get_attempt_status',
          );
        }
        try {
          const attempt = await context.services.getAttemptStatus(
            context.tenantId,
            projectId,
            attemptId,
          );
          if (
            !attempt ||
            attempt.id !== attemptId ||
            attempt.projectId !== projectId
          ) {
            return operationalDenied(
              context,
              'ATTEMPT_NOT_FOUND',
              'get_attempt_status',
            );
          }
          return textResult({
            ok: true,
            code: 'OK',
            data: operationalAttemptView(attempt),
          });
        } catch {
          return operationalDenied(
            context,
            'ATTEMPT_NOT_FOUND',
            'get_attempt_status',
          );
        }
      },
    }),
  );

  tools.push(
    operationalTool({
      name: 'get_recent_incidents',
      label: 'Get recent incidents',
      description: 'Read bounded sanitized incident summaries for the project.',
      parameters: operationalProjectParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalProjectInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_recent_incidents',
          );
        }
        const projectId = operationalProject(
          context,
          parsed.data.projectId,
          'get_recent_incidents',
        );
        if (!projectId) {
          return operationalDenied(
            context,
            'PROJECT_SCOPE_DENIED',
            'get_recent_incidents',
          );
        }
        try {
          const incidents = await context.services.getRecentIncidents(
            context.tenantId,
            projectId,
          );
          return textResult({
            ok: true,
            code: 'OK',
            data: incidents.slice(0, 20).map((incident) => ({
              eventId: incident.eventId,
              type: operationalText(incident.type, 80, 'incident'),
              status: operationalText(incident.status, 80, 'incident'),
              occurredAt: operationalText(
                incident.occurredAt,
                40,
                'unknown-time',
              ),
              ...(incident.code
                ? { code: operationalCode(incident.code, 'INCIDENT') }
                : {}),
              ...(incident.shotId ? { shotId: incident.shotId } : {}),
              ...(incident.attemptId ? { attemptId: incident.attemptId } : {}),
            })),
          });
        } catch {
          return operationalDenied(
            context,
            'INCIDENTS_UNAVAILABLE',
            'get_recent_incidents',
          );
        }
      },
    }),
  );

  tools.push(
    operationalTool({
      name: 'get_executor_readiness',
      label: 'Get executor readiness',
      description:
        'Read safe executor readiness and capability fingerprint data.',
      parameters: operationalEmptyParams,
      execute: async (_toolCallId, raw) => {
        const parsed = operationalEmptyInputSchema.safeParse(raw);
        if (!parsed.success) {
          return operationalDenied(
            context,
            'INVALID_ARGUMENTS',
            'get_executor_readiness',
          );
        }
        try {
          const readiness = await context.services.getExecutorReadiness();
          return textResult({
            ok: true,
            code: 'OK',
            data: {
              mode: operationalText(readiness.mode, 32, 'unknown'),
              ready: readiness.ready === true,
              checkedAt: operationalText(
                readiness.checkedAt,
                40,
                'unknown-time',
              ),
              ...(readiness.capabilityFingerprint
                ? {
                    capabilityFingerprint: operationalText(
                      readiness.capabilityFingerprint,
                      128,
                      'unknown',
                    ),
                  }
                : {}),
              ...(readiness.errorCode
                ? {
                    errorCode: operationalCode(
                      readiness.errorCode,
                      'EXECUTOR_UNAVAILABLE',
                    ),
                  }
                : {}),
              ...(Number.isSafeInteger(readiness.pendingCount) &&
              (readiness.pendingCount as number) >= 0
                ? { pendingCount: readiness.pendingCount }
                : {}),
              ...(Number.isSafeInteger(readiness.runningCount) &&
              (readiness.runningCount as number) >= 0
                ? { runningCount: readiness.runningCount }
                : {}),
            },
          });
        } catch {
          return operationalDenied(
            context,
            'EXECUTOR_UNAVAILABLE',
            'get_executor_readiness',
          );
        }
      },
    }),
  );

  return tools;
}

/**
 * Terminal tool for a non-faux provider (75-PHASE-7E step 3): its
 * parameters ARE `operationalRecommendationSchema`, so the model fills typed
 * fields instead of narrating JSON prose. Deliberately a separate factory
 * from `createOperationalReadTools` -- it has no side effects (it returns a
 * value to the adapter and touches nothing durable) but it is not a read, so
 * "the operator's read tools are reads only" stays a property a test can
 * assert on `OPERATIONAL_TOOL_NAMES` / `createOperationalReadTools` alone.
 */
export const OPERATIONAL_SUBMISSION_TOOL_NAME = 'submit_recommendation';

const RECOMMENDATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,63}$/;
const RECOMMENDATION_TITLE_MAX = 240;
const RECOMMENDATION_DETAIL_MAX = 2_000;
const RECOMMENDATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
const RECOMMENDATION_ACTION_TYPES = [
  'retry_attempt',
  'open_workflow_revision',
  'wait_for_executor',
  'request_human_review',
  'no_action',
] as const;

/**
 * Kept maximally precise -- enums, `maxLength`, `pattern`,
 * `additionalProperties: false` -- because this is what the provider shows
 * the model, and under N2 it costs nothing: `prepareArguments` below returns
 * only values that already satisfy it, so pi's own check
 * (`agent-loop.js:402`) can no longer reject a call.
 */
const submitRecommendationParams = typeBoxObject({
  severity: Type.Union(RECOMMENDATION_SEVERITIES.map((s) => Type.Literal(s))),
  recommendationCode: Type.String({
    pattern: RECOMMENDATION_CODE_PATTERN.source,
  }),
  title: Type.String({ maxLength: RECOMMENDATION_TITLE_MAX }),
  detail: Type.String({ maxLength: RECOMMENDATION_DETAIL_MAX }),
  proposedActionType: Type.Union(
    RECOMMENDATION_ACTION_TYPES.map((a) => Type.Literal(a)),
  ),
});

export const operationalRecommendationSchema = z.object({
  severity: z.enum(RECOMMENDATION_SEVERITIES),
  recommendationCode: z.string().trim().regex(RECOMMENDATION_CODE_PATTERN),
  title: boundedText(RECOMMENDATION_TITLE_MAX),
  detail: boundedText(RECOMMENDATION_DETAIL_MAX),
  proposedActionType: z.enum(RECOMMENDATION_ACTION_TYPES),
});

export type OperationalRecommendationOutput = z.infer<
  typeof operationalRecommendationSchema
>;

type OperationalIssue = z.ZodError['issues'][number];

/**
 * N3: repair only what is cosmetic. Unknown keys need no work here -- the
 * schema above is no longer `.strict()`, so zod strips them -- and
 * `.trim()` inside the field schemas handles surrounding whitespace. Casing
 * is the one repair zod cannot express before its own `regex` runs.
 * Anything that changes what the finding *says* is left alone, so the parse
 * bounces it back to the model.
 */
function normalizeOperationalSubmission(candidate: unknown): unknown {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return candidate;
  }
  const record = candidate as Record<string, unknown>;
  const code = record.recommendationCode;
  if (typeof code !== 'string') return record;
  return { ...record, recommendationCode: code.trim().toUpperCase() };
}

/** Quotes a received value for a bounce line without echoing a long payload back at the model. */
function receivedValueText(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length > 60 ? `"${value.slice(0, 60)}..."` : `"${value}"`;
  }
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return String(value);
}

/**
 * One imperative line per issue, naming the field, the value received and --
 * for a length overrun -- the actual overage, so a single retry is usually
 * enough. Modelled on Claude Code's `formatZodValidationError`
 * (`toolErrors.ts:66`): tell the model what to fix, not that it failed.
 */
function operationalIssueLine(
  issue: OperationalIssue,
  candidate: unknown,
): string {
  const field = issue.path[0];
  if (typeof field !== 'string') {
    return `the arguments must be a JSON object with the five recommendation fields (received ${receivedValueText(candidate)}).`;
  }
  const received =
    typeof candidate === 'object' && candidate !== null
      ? (candidate as Record<string, unknown>)[field]
      : undefined;
  switch (issue.code) {
    case 'too_big':
      return typeof received === 'string'
        ? `${field} is ${received.trim().length} characters; the maximum is ${String(issue.maximum)}. Shorten it.`
        : `${field} is too long; the maximum is ${String(issue.maximum)} characters. Shorten it.`;
    case 'too_small':
      return `${field} must not be empty.`;
    case 'invalid_value':
      return `${field} must be one of ${issue.values.map((value) => JSON.stringify(value)).join(', ')} (received ${receivedValueText(received)}).`;
    // `recommendationCode` is the only field carrying a format, so naming its
    // pattern here needs no dispatch on which one failed.
    case 'invalid_format':
      return `${field} must match ${RECOMMENDATION_CODE_PATTERN.source} -- an uppercase letter or digit, then uppercase letters, digits, "_", "." or "-" (received ${receivedValueText(received)}). It names the finding, so rewrite it rather than expecting a repair.`;
    case 'invalid_type':
      return received === undefined
        ? `${field} is required.`
        : `${field} must be a string (received ${receivedValueText(received)}).`;
    default:
      return `${field} was not accepted (received ${receivedValueText(received)}): ${issue.message}`;
  }
}

type OperationalRecommendationParse =
  | { readonly ok: true; readonly value: OperationalRecommendationOutput }
  | { readonly ok: false; readonly issues: string };

/**
 * The one place a candidate becomes a recommendation, for every entry point:
 * the tool's `prepareArguments`, tier 2's text extraction, and
 * `describeOperationalRecommendationIssues`. Normalizing here rather than in
 * the tool alone is what keeps them agreeing -- a lower-case
 * `recommendationCode` used to be accepted through the tool and reported as a
 * violation by the other two.
 */
function parseOperationalRecommendation(
  raw: unknown,
): OperationalRecommendationParse {
  const candidate = normalizeOperationalSubmission(raw);
  const result = operationalRecommendationSchema.safeParse(candidate);
  if (result.success) return { ok: true, value: result.data };
  const lines = result.error.issues
    .slice(0, 8)
    .map((issue) => `- ${operationalIssueLine(issue, candidate)}`);
  return {
    ok: false,
    issues: `${OPERATIONAL_SUBMISSION_TOOL_NAME} was not accepted. Fix these and call it again:\n${lines.join('\n')}`,
  };
}

/**
 * The field-by-field text the tool hands back to the model on a bounce, or
 * `undefined` when `candidate` is one the tool would accept -- normalization
 * included, so this answers for the tool rather than about it.
 */
export function describeOperationalRecommendationIssues(
  candidate: unknown,
): string | undefined {
  const parsed = parseOperationalRecommendation(candidate);
  return parsed.ok ? undefined : parsed.issues;
}

/**
 * Tier 2's validator: same schema and the same normalization, but a generic
 * message, because prose the model already stopped narrating cannot be handed
 * back for a retry.
 */
export function validateOperationalRecommendation(
  candidate: unknown,
): OperationalRecommendationOutput {
  const parsed = parseOperationalRecommendation(candidate);
  if (!parsed.ok) {
    throw new Error(
      'The operational Pi run returned invalid structured output.',
    );
  }
  return parsed.value;
}

/** A submission tool plus the run-scoped state its `execute` accumulates. */
export interface OperationalSubmission {
  readonly tool: AgentTool;
  /** The last accepted submission, if any. */
  readonly accepted: () => OperationalRecommendationOutput | undefined;
  /** submit_recommendation calls the model was asked to fix. */
  readonly rejections: () => number;
  /** submit_recommendation calls seen, accepted or not. */
  readonly attempts: () => number;
}

/** Builds the one terminal, argument-only submission tool. No evidence access. */
export function createOperationalSubmissionTool(): OperationalSubmission {
  let accepted: OperationalRecommendationOutput | undefined;
  let attempts = 0;
  let rejections = 0;
  const tool: AgentTool = {
    name: OPERATIONAL_SUBMISSION_TOOL_NAME,
    label: 'Submit operational recommendation',
    description:
      'Submit the one bounded operational recommendation for this incident. ' +
      'Call this after gathering evidence, with your final conclusion. ' +
      'severity is "info", "warning" or "critical"; recommendationCode is a ' +
      'SCREAMING_SNAKE_CASE identifier of at most 64 characters; title is at ' +
      `most ${RECOMMENDATION_TITLE_MAX} characters; detail is at most ` +
      `${RECOMMENDATION_DETAIL_MAX} characters; proposedActionType is one of ` +
      '"retry_attempt", "open_workflow_revision", "wait_for_executor", ' +
      '"request_human_review", "no_action".',
    parameters: submitRecommendationParams,
    // N2: pi runs this before its own argument check
    // (`agent-loop.js:401-402`) and turns a throw here into the call's error
    // result with our wording (`:446`), which is what makes this the sole
    // validation site -- and what lets a rejection be a retryable bounce
    // rather than a silent fall to the lookup table.
    prepareArguments: (args) => {
      attempts += 1;
      const parsed = parseOperationalRecommendation(args);
      if (!parsed.ok) {
        rejections += 1;
        throw new Error(parsed.issues);
      }
      return parsed.value;
    },
    execute: async (_toolCallId, params) => {
      // N1: the conclusion is captured where the tool runs, never by reading
      // a message's position in the transcript. `prepareArguments` above is
      // the only path into `execute`, so `params` is exactly the object it
      // returned -- already parsed by `operationalRecommendationSchema`.
      accepted = params as OperationalRecommendationOutput;
      return {
        ...textResult({ ok: true, code: 'OK', data: params }),
        // Now only a turn-saving optimisation: pi terminates a batch just
        // when every finalized call in it terminates
        // (`agent-loop.js:376`), so a submission batched with a read call
        // runs on -- and nothing above depends on this stopping the loop.
        terminate: true,
      };
    },
  };
  return {
    tool,
    accepted: () => accepted,
    rejections: () => rejections,
    attempts: () => attempts,
  };
}
