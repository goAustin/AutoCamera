import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type {
  GenerationAttempt,
  Shot,
  StoryboardProposal,
  Uuid,
  VideoProject,
} from '@h3/domain';

/** The only operations exposed to a planning agent. */
export const PLANNING_TOOL_NAMES = [
  'get_video_project',
  'submit_storyboard_for_approval',
  'request_shot_generation',
  'get_generation_attempt',
  'request_regeneration',
  'get_project_incidents',
] as const;

export type PlanningToolName = (typeof PLANNING_TOOL_NAMES)[number];

/** Kept for the Phase 1 package contract. */
export interface PlanningToolDescriptor {
  readonly name: string;
  readonly description: string;
}

export const PHASE_1_PLANNING_TOOLS: readonly PlanningToolDescriptor[] = [
  { name: 'read-project', description: 'Read the current project brief.' },
  {
    name: 'propose-storyboard',
    description: 'Propose a storyboard for later phases.',
  },
];

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const emptyAssetIds = z.array(z.string().max(0)).length(0);

const storyboardShotSchema = z
  .object({
    ordinal: z.number().int().min(1).max(3),
    purpose: boundedText(400),
    generationMode: z.literal('t2v'),
    durationSeconds: z.number().finite().gt(0).lte(10),
    visualDescription: boundedText(2_000),
    cameraDirection: boundedText(2_000),
    audioDirection: boundedText(2_000),
    dialogue: boundedText(280).optional(),
    requiredAssetIds: emptyAssetIds,
    acceptanceCriteria: z.array(boundedText(280)).min(1).max(8),
  })
  .strict();

export const storyboardProposalSchema = z
  .object({
    projectId: z.string().uuid(),
    objective: boundedText(400),
    assumptions: z.array(boundedText(280)).max(12),
    shots: z.array(storyboardShotSchema).length(3),
    totalDurationSeconds: z.number().finite().gt(0).lte(30),
    risks: z.array(boundedText(280)).max(12),
  })
  .strict();

export type StoryboardProposalOutput = z.infer<typeof storyboardProposalSchema>;

export type StoryboardValidationCode =
  | 'PROJECT_ID_MISMATCH'
  | 'INVALID_SHOT_COUNT'
  | 'INVALID_ORDINAL'
  | 'INVALID_DURATION'
  | 'UNSUPPORTED_PREVIEW'
  | 'INVALID_STRUCTURED_OUTPUT';

export class StoryboardValidationError extends Error {
  readonly code: StoryboardValidationCode;

  constructor(code: StoryboardValidationCode, message: string) {
    super(message);
    this.name = 'StoryboardValidationError';
    this.code = code;
  }
}

export const PREVIEW_CONSTRAINTS = Object.freeze({
  minimumShotDurationSeconds: 0.1,
  maximumShotDurationSeconds: 10,
  maximumTotalDurationSeconds: 30,
  durationToleranceSeconds: 0.05,
});

export function validateStoryboardProposal(
  candidate: unknown,
  project: Pick<VideoProject, 'id' | 'targetDurationSeconds'>,
): StoryboardProposalOutput {
  const parsed = storyboardProposalSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new StoryboardValidationError(
      'INVALID_STRUCTURED_OUTPUT',
      'The planning agent returned invalid structured output.',
    );
  }
  const value = parsed.data;
  if (value.projectId !== project.id) {
    throw new StoryboardValidationError(
      'PROJECT_ID_MISMATCH',
      'The planning agent returned a proposal for a different project.',
    );
  }
  if (value.shots.length !== 3) {
    throw new StoryboardValidationError(
      'INVALID_SHOT_COUNT',
      'The storyboard must contain exactly three shots.',
    );
  }
  const ordinals = value.shots.map((shot) => shot.ordinal);
  if (ordinals.join(',') !== '1,2,3') {
    throw new StoryboardValidationError(
      'INVALID_ORDINAL',
      'Storyboard shot ordinals must be exactly 1, 2, and 3.',
    );
  }
  const total = value.shots.reduce(
    (sum, shot) => sum + shot.durationSeconds,
    0,
  );
  if (
    value.shots.some(
      (shot) =>
        shot.durationSeconds < PREVIEW_CONSTRAINTS.minimumShotDurationSeconds ||
        shot.durationSeconds > PREVIEW_CONSTRAINTS.maximumShotDurationSeconds,
    ) ||
    Math.abs(total - value.totalDurationSeconds) >
      PREVIEW_CONSTRAINTS.durationToleranceSeconds
  ) {
    throw new StoryboardValidationError(
      'INVALID_DURATION',
      'Storyboard shot durations are inconsistent or outside preview bounds.',
    );
  }
  if (
    value.totalDurationSeconds >
      PREVIEW_CONSTRAINTS.maximumTotalDurationSeconds ||
    Math.abs(total - project.targetDurationSeconds) >
      PREVIEW_CONSTRAINTS.durationToleranceSeconds
  ) {
    throw new StoryboardValidationError(
      'UNSUPPORTED_PREVIEW',
      'The requested storyboard duration is not supported by preview generation.',
    );
  }
  return value;
}

export interface ProjectToolView {
  readonly id: Uuid;
  readonly title: string;
  readonly brief: string;
  readonly status: VideoProject['status'];
  readonly targetDurationSeconds: number;
  readonly budgetMicrousd: number | null;
  readonly spentMicrousd: number;
  readonly remainingMicrousd: number | null;
}

export interface StoryboardToolView {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly revision: number;
  readonly status: StoryboardProposal['status'];
  readonly shotCount: number;
  readonly totalDurationSeconds: number;
}

export interface AttemptToolView {
  readonly id: Uuid;
  readonly projectId: Uuid;
  readonly shotId: Uuid;
  readonly status: GenerationAttempt['status'];
  readonly failureCode?: GenerationAttempt['failureCode'];
}

export interface ProjectIncidentToolView {
  readonly code: string;
  readonly status: string;
  readonly occurredAt: string;
}

export interface PlanningToolServices {
  getVideoProject(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<ProjectToolView | null>;
  submitStoryboardForApproval(input: {
    tenantId: Uuid;
    projectId: Uuid;
    proposalId?: Uuid;
    idempotencyKey: string;
  }): Promise<StoryboardToolView>;
  requestShotGeneration(input: {
    tenantId: Uuid;
    projectId: Uuid;
    shotId: Uuid;
    idempotencyKey: string;
  }): Promise<AttemptToolView>;
  getGenerationAttempt(
    tenantId: Uuid,
    attemptId: Uuid,
  ): Promise<AttemptToolView | null>;
  requestRegeneration(input: {
    tenantId: Uuid;
    projectId: Uuid;
    shotId: Uuid;
    sourceAttemptId?: Uuid;
    idempotencyKey: string;
  }): Promise<AttemptToolView>;
  getProjectIncidents(
    tenantId: Uuid,
    projectId: Uuid,
  ): Promise<readonly ProjectIncidentToolView[]>;
}

export interface PlanningToolContext {
  readonly tenantId: Uuid;
  readonly projectId: Uuid;
  readonly agentRunId: string;
  readonly services: PlanningToolServices;
  readonly effectCache?: Map<string, Promise<unknown>>;
  readonly onPolicyDenial?: (code: string, operation: string) => void;
}

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

const projectParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
});
const approvalParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  proposalId: Type.Optional(Type.String({ format: 'uuid' })),
});
const generationParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  shotId: Type.String({ format: 'uuid' }),
});
const attemptParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  attemptId: Type.String({ format: 'uuid' }),
});
const regenerationParams = typeBoxObject({
  projectId: Type.Optional(Type.String({ format: 'uuid' })),
  shotId: Type.String({ format: 'uuid' }),
  sourceAttemptId: Type.Optional(Type.String({ format: 'uuid' })),
});

const projectInputSchema = z
  .object({ projectId: z.string().uuid().optional() })
  .strict();
const approvalInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    proposalId: z.string().uuid().optional(),
  })
  .strict();
const generationInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    shotId: z.string().uuid(),
  })
  .strict();
const attemptInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    attemptId: z.string().uuid(),
  })
  .strict();
const regenerationInputSchema = z
  .object({
    projectId: z.string().uuid().optional(),
    shotId: z.string().uuid(),
    sourceAttemptId: z.string().uuid().optional(),
  })
  .strict();

function safeUuid(value: string): Uuid {
  return value as Uuid;
}

function contextProject(
  context: PlanningToolContext,
  requestedProjectId: string | undefined,
  operation: string,
): Uuid | null {
  if (
    requestedProjectId !== undefined &&
    requestedProjectId !== context.projectId
  ) {
    context.onPolicyDenial?.('PROJECT_SCOPE_DENIED', operation);
    return null;
  }
  return context.projectId;
}

function denied<T extends ToolDetails>(
  context: PlanningToolContext,
  code: string,
  operation: string,
): AgentToolResult<T> {
  context.onPolicyDenial?.(code, operation);
  return textResult({ ok: false, code } as T);
}

function serviceFailureCode(
  error: unknown,
  allowed: readonly string[],
  fallback: string,
): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    allowed.includes(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function withDerivedKey<T>(
  context: PlanningToolContext,
  toolCallId: string,
  operation: string,
  aggregateId: string,
  work: (idempotencyKey: string) => Promise<T>,
): Promise<T> {
  const idempotencyKey = `${context.agentRunId}:${toolCallId}:${operation}:${aggregateId}`;
  const cache = context.effectCache;
  const existing = cache?.get(idempotencyKey);
  if (existing) return existing as Promise<T>;
  const pending = work(idempotencyKey);
  cache?.set(idempotencyKey, pending);
  return pending;
}

function toolResult<T extends TSchema, D extends ToolDetails>(input: {
  name: PlanningToolName;
  label: string;
  description: string;
  parameters: T;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<D>>;
}): AgentTool<T, D> {
  return {
    name: input.name,
    label: input.label,
    description: input.description,
    parameters: input.parameters,
    execute: async (toolCallId, params, signal) =>
      input.execute(toolCallId, params, signal),
  };
}

export function createPlanningTools(
  context: PlanningToolContext,
  enabledTools: readonly PlanningToolName[] = PLANNING_TOOL_NAMES,
): AgentTool[] {
  const tools: AgentTool[] = [];
  const has = (name: PlanningToolName) => enabledTools.includes(name);

  if (has('get_video_project')) {
    tools.push(
      toolResult({
        name: 'get_video_project',
        label: 'Get video project',
        description: 'Read the current project summary and budget state.',
        parameters: projectParams,
        execute: async (toolCallId, raw) => {
          const parsed = projectInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(context, 'INVALID_ARGUMENTS', 'get_video_project');
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'get_video_project',
          );
          if (!projectId) {
            return denied(context, 'PROJECT_SCOPE_DENIED', 'get_video_project');
          }
          return withDerivedKey(
            context,
            toolCallId,
            'get_video_project',
            projectId,
            async () => {
              try {
                const project = await context.services.getVideoProject(
                  context.tenantId,
                  projectId,
                );
                return project
                  ? textResult({ ok: true, code: 'OK', data: project })
                  : textResult({ ok: false, code: 'PROJECT_NOT_FOUND' });
              } catch {
                return denied(
                  context,
                  'PROJECT_NOT_FOUND',
                  'get_video_project',
                );
              }
            },
          );
        },
      }),
    );
  }

  if (has('submit_storyboard_for_approval')) {
    tools.push(
      toolResult({
        name: 'submit_storyboard_for_approval',
        label: 'Submit storyboard for approval',
        description:
          'Submit the current storyboard proposal for human approval.',
        parameters: approvalParams,
        execute: async (toolCallId, raw) => {
          const parsed = approvalInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(
              context,
              'INVALID_ARGUMENTS',
              'submit_storyboard_for_approval',
            );
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'submit_storyboard_for_approval',
          );
          if (!projectId) {
            return denied(
              context,
              'PROJECT_SCOPE_DENIED',
              'submit_storyboard_for_approval',
            );
          }
          const aggregateId = parsed.data.proposalId ?? projectId;
          return withDerivedKey(
            context,
            toolCallId,
            'submit_storyboard_for_approval',
            aggregateId,
            async (idempotencyKey) => {
              try {
                return textResult({
                  ok: true,
                  code: 'OK',
                  data: await context.services.submitStoryboardForApproval({
                    tenantId: context.tenantId,
                    projectId,
                    ...(parsed.data.proposalId
                      ? { proposalId: safeUuid(parsed.data.proposalId) }
                      : {}),
                    idempotencyKey,
                  }),
                });
              } catch (error) {
                return denied(
                  context,
                  serviceFailureCode(
                    error,
                    [
                      'STORYBOARD_NOT_APPROVABLE',
                      'MISSING_STORYBOARD',
                      'STALE_STORYBOARD',
                      'STORYBOARD_ALREADY_MATERIALIZED',
                    ],
                    'APPROVAL_DENIED',
                  ),
                  'submit_storyboard_for_approval',
                );
              }
            },
          );
        },
      }),
    );
  }

  if (has('request_shot_generation')) {
    tools.push(
      toolResult({
        name: 'request_shot_generation',
        label: 'Request shot generation',
        description:
          'Request one durable preview generation attempt for a shot.',
        parameters: generationParams,
        execute: async (toolCallId, raw) => {
          const parsed = generationInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(
              context,
              'INVALID_ARGUMENTS',
              'request_shot_generation',
            );
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'request_shot_generation',
          );
          if (!projectId) {
            return denied(
              context,
              'PROJECT_SCOPE_DENIED',
              'request_shot_generation',
            );
          }
          return withDerivedKey(
            context,
            toolCallId,
            'request_shot_generation',
            parsed.data.shotId,
            async (idempotencyKey) => {
              try {
                return textResult({
                  ok: true,
                  code: 'OK',
                  data: await context.services.requestShotGeneration({
                    tenantId: context.tenantId,
                    projectId,
                    shotId: safeUuid(parsed.data.shotId),
                    idempotencyKey,
                  }),
                });
              } catch (error) {
                return denied(
                  context,
                  serviceFailureCode(
                    error,
                    [
                      'SHOT_SCOPE_DENIED',
                      'SHOT_NOT_FOUND',
                      'SHOT_NOT_READY_FOR_GENERATION',
                      'ATTEMPT_LIMIT_REACHED',
                      'BUDGET_EXCEEDED',
                    ],
                    'GENERATION_DENIED',
                  ),
                  'request_shot_generation',
                );
              }
            },
          );
        },
      }),
    );
  }

  if (has('get_generation_attempt')) {
    tools.push(
      toolResult({
        name: 'get_generation_attempt',
        label: 'Get generation attempt',
        description: 'Read the safe status of one generation attempt.',
        parameters: attemptParams,
        execute: async (toolCallId, raw) => {
          const parsed = attemptInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(
              context,
              'INVALID_ARGUMENTS',
              'get_generation_attempt',
            );
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'get_generation_attempt',
          );
          if (!projectId) {
            return denied(
              context,
              'PROJECT_SCOPE_DENIED',
              'get_generation_attempt',
            );
          }
          return withDerivedKey(
            context,
            toolCallId,
            'get_generation_attempt',
            parsed.data.attemptId,
            async () => {
              const attempt = await context.services.getGenerationAttempt(
                context.tenantId,
                safeUuid(parsed.data.attemptId),
              );
              if (!attempt || attempt.projectId !== projectId) {
                return denied(
                  context,
                  'ATTEMPT_SCOPE_DENIED',
                  'get_generation_attempt',
                );
              }
              return textResult({ ok: true, code: 'OK', data: attempt });
            },
          );
        },
      }),
    );
  }

  if (has('request_regeneration')) {
    tools.push(
      toolResult({
        name: 'request_regeneration',
        label: 'Request regeneration',
        description: 'Request a durable regeneration after a rejected attempt.',
        parameters: regenerationParams,
        execute: async (toolCallId, raw) => {
          const parsed = regenerationInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(context, 'INVALID_ARGUMENTS', 'request_regeneration');
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'request_regeneration',
          );
          if (!projectId) {
            return denied(
              context,
              'PROJECT_SCOPE_DENIED',
              'request_regeneration',
            );
          }
          return withDerivedKey(
            context,
            toolCallId,
            'request_regeneration',
            parsed.data.shotId,
            async (idempotencyKey) => {
              try {
                return textResult({
                  ok: true,
                  code: 'OK',
                  data: await context.services.requestRegeneration({
                    tenantId: context.tenantId,
                    projectId,
                    shotId: safeUuid(parsed.data.shotId),
                    ...(parsed.data.sourceAttemptId
                      ? {
                          sourceAttemptId: safeUuid(
                            parsed.data.sourceAttemptId,
                          ),
                        }
                      : {}),
                    idempotencyKey,
                  }),
                });
              } catch (error) {
                return denied(
                  context,
                  serviceFailureCode(
                    error,
                    [
                      'ATTEMPT_SCOPE_DENIED',
                      'ATTEMPT_NOT_FOUND',
                      'ATTEMPT_NOT_REJECTED',
                      'SHOT_NOT_READY_FOR_GENERATION',
                      'ATTEMPT_LIMIT_REACHED',
                      'BUDGET_EXCEEDED',
                    ],
                    'REGENERATION_DENIED',
                  ),
                  'request_regeneration',
                );
              }
            },
          );
        },
      }),
    );
  }

  if (has('get_project_incidents')) {
    tools.push(
      toolResult({
        name: 'get_project_incidents',
        label: 'Get project incidents',
        description: 'Read bounded project incident summaries.',
        parameters: projectParams,
        execute: async (toolCallId, raw) => {
          const parsed = projectInputSchema.safeParse(raw);
          if (!parsed.success) {
            return denied(
              context,
              'INVALID_ARGUMENTS',
              'get_project_incidents',
            );
          }
          const projectId = contextProject(
            context,
            parsed.data.projectId,
            'get_project_incidents',
          );
          if (!projectId) {
            return denied(
              context,
              'PROJECT_SCOPE_DENIED',
              'get_project_incidents',
            );
          }
          return withDerivedKey(
            context,
            toolCallId,
            'get_project_incidents',
            projectId,
            async () => {
              try {
                return textResult({
                  ok: true,
                  code: 'OK',
                  data: await context.services.getProjectIncidents(
                    context.tenantId,
                    projectId,
                  ),
                });
              } catch {
                return denied(
                  context,
                  'INCIDENTS_UNAVAILABLE',
                  'get_project_incidents',
                );
              }
            },
          );
        },
      }),
    );
  }

  return tools;
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
