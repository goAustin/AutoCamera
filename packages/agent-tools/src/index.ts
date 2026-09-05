import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { GenerationAttempt, Shot, Uuid, VideoProject } from '@h3/domain';

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

type ToolDetails =
  | { readonly ok: true; readonly code: 'OK'; readonly data?: unknown }
  | { readonly ok: false; readonly code: string };

function textResult<T extends ToolDetails>(details: T): AgentToolResult<T> {
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

type OperationalToolDetails =
  | { readonly ok: true; readonly code: 'OK'; readonly data?: unknown }
  | { readonly ok: false; readonly code: string };

function operationalDenied(
  context: OperationalToolContext,
  code: string,
  operation: string,
): AgentToolResult<OperationalToolDetails> {
  context.onPolicyDenial?.(code, operation);
  return textResult({ ok: false, code });
}

function operationalProject(
  context: OperationalToolContext,
  requestedProjectId: string | undefined,
  operation: string,
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
  operation: string,
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
            data: {
              id: project.id,
              status: project.status,
              budgetMicrousd: project.budgetMicrousd,
              spentMicrousd: project.spentMicrousd,
              remainingMicrousd: project.remainingMicrousd,
            } satisfies OperationalProjectToolView,
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
          const acceptanceCriteria = Array.isArray(shot.acceptanceCriteria)
            ? shot.acceptanceCriteria
                .filter(
                  (criterion): criterion is string =>
                    typeof criterion === 'string' &&
                    criterion.trim().length > 0,
                )
                .slice(0, 8)
                .map((criterion) => criterion.trim().slice(0, 280))
            : [];
          return textResult({
            ok: true,
            code: 'OK',
            data: {
              id: shot.id,
              projectId: shot.projectId,
              status: shot.status,
              acceptanceCriteria,
            },
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
            data: {
              id: revision.id,
              projectId: revision.projectId,
              shotId: revision.shotId,
              profileId: operationalText(
                revision.profileId,
                128,
                'unknown-profile',
              ),
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
            },
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
            data: {
              id: attempt.id,
              projectId: attempt.projectId,
              shotId: attempt.shotId,
              status: attempt.status,
              ...(attempt.failureCode
                ? { failureCode: attempt.failureCode }
                : {}),
            },
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

export const operationalRecommendationSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'critical']),
    recommendationCode: z
      .string()
      .trim()
      .regex(/^[A-Z0-9][A-Z0-9_.-]{0,63}$/),
    title: boundedText(240),
    detail: boundedText(2_000),
    proposedActionType: z.enum([
      'retry_attempt',
      'open_workflow_revision',
      'wait_for_executor',
      'request_human_review',
      'no_action',
    ]),
  })
  .strict();

export type OperationalRecommendationOutput = z.infer<
  typeof operationalRecommendationSchema
>;

export function validateOperationalRecommendation(
  candidate: unknown,
): OperationalRecommendationOutput {
  const result = operationalRecommendationSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      'The operational Pi run returned invalid structured output.',
    );
  }
  return result.data;
}
