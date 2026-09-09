import { describe, expect, it } from 'vitest';
import {
  OPERATIONAL_SUBMISSION_TOOL_NAME,
  OPERATIONAL_TOOL_NAMES,
  createOperationalReadTools,
  createOperationalSubmissionTool,
  describeOperationalRecommendationIssues,
  type OperationalToolServices,
} from './index.js';

const projectId = '00000000-0000-7000-8000-000000000001' as never;
const otherProjectId = '00000000-0000-7000-8000-000000000002' as never;
const shotId = '00000000-0000-7000-8000-000000000003' as never;
const otherShotId = '00000000-0000-7000-8000-000000000004' as never;
const revisionId = '00000000-0000-7000-8000-000000000005' as never;
const attemptId = '00000000-0000-7000-8000-000000000006' as never;
const tenantId = '00000000-0000-7000-8000-000000000007' as never;

function services(): OperationalToolServices {
  return {
    getProjectStatus: async (_tenant, id) =>
      id === projectId
        ? {
            id: projectId,
            status: 'needs_attention',
            budgetMicrousd: 10_000_000,
            spentMicrousd: 2_000_000,
            remainingMicrousd: 8_000_000,
          }
        : null,
    getShotStatus: async (_tenant, project, id) =>
      project === projectId && id === shotId
        ? {
            id: shotId,
            projectId,
            status: 'retryable',
            acceptanceCriteria: ['The subject remains legible.'],
          }
        : null,
    getWorkflowRevisionValidation: async (_tenant, project, shot, id) =>
      project === projectId && shot === shotId && id === revisionId
        ? {
            id: revisionId,
            projectId,
            shotId,
            profileId: 'minimax-h3-t2va-preview',
            profileVersion: '1',
            validationStatus: 'invalid',
            validationErrors: [
              { code: 'GRAPH_SCHEMA_INVALID', message: 'Graph is invalid.' },
            ],
            executorFingerprint: 'fingerprint-safe',
          }
        : null,
    getAttemptStatus: async (_tenant, project, id) =>
      project === projectId && id === attemptId
        ? {
            id: attemptId,
            projectId,
            shotId,
            status: 'failed',
            failureCode: 'COMFY_EXECUTION_FAILED',
          }
        : null,
    getRecentIncidents: async () => [
      {
        eventId: revisionId,
        type: 'attempt.failed',
        status: 'failed',
        occurredAt: '2026-01-01T00:00:00.000Z',
        code: 'COMFY_EXECUTION_FAILED',
        shotId,
        attemptId,
      },
    ],
    getExecutorReadiness: async () => ({
      mode: 'fake',
      ready: false,
      checkedAt: '2026-01-01T00:00:00.000Z',
      errorCode: 'EXECUTOR_UNAVAILABLE',
      pendingCount: 2,
      runningCount: 1,
    }),
  };
}

function tool(name: string, servicesOverride?: OperationalToolServices) {
  const tools = createOperationalReadTools({
    tenantId,
    projectId,
    shotId,
    attemptId,
    workflowRevisionId: revisionId,
    services: servicesOverride ?? services(),
  });
  const selected = tools.find((candidate) => candidate.name === name);
  if (!selected) throw new Error(`Missing tool ${name}.`);
  return selected;
}

describe('operational Pi read-only tools', () => {
  it('exposes only the six sanitized read tools', () => {
    const names = createOperationalReadTools({
      tenantId,
      projectId,
      services: services(),
    }).map((candidate) => candidate.name);
    expect(names).toEqual(OPERATIONAL_TOOL_NAMES);
    expect(names).not.toEqual(
      expect.arrayContaining([
        'retry_attempt',
        'request_regeneration',
        'submit_storyboard_for_approval',
      ]),
    );
  });

  it('denies cross-project and cross-resource reads', async () => {
    const projectResult = await tool('get_project_status').execute('call-1', {
      projectId: otherProjectId,
    });
    expect(projectResult.details).toEqual({
      ok: false,
      code: 'PROJECT_SCOPE_DENIED',
    });

    const shotResult = await tool('get_shot_status').execute('call-2', {
      projectId,
      shotId: otherShotId,
    });
    expect(shotResult.details).toEqual({
      ok: false,
      code: 'SHOT_SCOPE_DENIED',
    });
  });

  it('returns bounded typed evidence without prompt, graph, or artifact data', async () => {
    const revisionResult = await tool(
      'get_workflow_revision_validation',
    ).execute('call-3', { projectId, shotId, revisionId });
    const attemptResult = await tool('get_attempt_status').execute('call-4', {
      projectId,
      attemptId,
    });
    const incidentResult = await tool('get_recent_incidents').execute(
      'call-5',
      {
        projectId,
      },
    );
    const executorResult = await tool('get_executor_readiness').execute(
      'call-6',
      {},
    );
    const serialized = JSON.stringify({
      revision: revisionResult.details,
      attempt: attemptResult.details,
      incidents: incidentResult.details,
      executor: executorResult.details,
    });

    expect(serialized).toContain('GRAPH_SCHEMA_INVALID');
    expect(serialized).toContain('COMFY_EXECUTION_FAILED');
    expect(serialized).toContain('fingerprint-safe');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('graph_json');
    expect(serialized).not.toContain('artifact');
  });

  it('never mixes the submission tool into the read-only tool set', () => {
    // 75-PHASE-7E-OPERATIONAL-INTELLIGENCE.md step 3: "createOperationalReadTools
    // returns exactly the six read tools; the submission tool is defined by
    // a separate factory" -- kept a literally checkable property, not a
    // judgement call.
    const names = createOperationalReadTools({
      tenantId,
      projectId,
      services: services(),
    }).map((candidate) => candidate.name);
    expect(names).toEqual(OPERATIONAL_TOOL_NAMES);
    expect(names).not.toContain(OPERATIONAL_SUBMISSION_TOOL_NAME);
  });
});

const submissionArgs = {
  severity: 'critical',
  recommendationCode: 'EXECUTOR_UNAVAILABLE',
  title: 'Wait for the executor to recover',
  detail: 'The execution service is unavailable.',
  proposedActionType: 'wait_for_executor',
};

/** Runs one `submit_recommendation` call the way pi's loop does: prepare, then execute. */
async function callSubmission(
  submission: ReturnType<typeof createOperationalSubmissionTool>,
  args: unknown,
): Promise<{ readonly terminate?: boolean } | Error> {
  const { tool } = submission;
  let prepared: unknown;
  try {
    prepared = tool.prepareArguments?.(args) ?? args;
  } catch (error) {
    return error as Error;
  }
  return tool.execute('call-1', prepared);
}

describe('operational Pi submission tool', () => {
  it('is a terminal tool that captures the accepted submission at execution', async () => {
    const submission = createOperationalSubmissionTool();
    expect(submission.tool.name).toBe(OPERATIONAL_SUBMISSION_TOOL_NAME);
    expect(submission.accepted()).toBeUndefined();

    const result = await callSubmission(submission, submissionArgs);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { readonly terminate?: boolean }).terminate).toBe(true);
    expect(submission.accepted()).toEqual(submissionArgs);
    expect(submission.attempts()).toBe(1);
    expect(submission.rejections()).toBe(0);
  });

  it('normalizes only what is cosmetic, and lets a later submission win', async () => {
    const submission = createOperationalSubmissionTool();
    await callSubmission(submission, submissionArgs);
    await callSubmission(submission, {
      ...submissionArgs,
      // N3: extra key dropped, whitespace trimmed, code upper-cased.
      reasoning: 'the model volunteering a field',
      recommendationCode: '  executor_unavailable  ',
      title: '  A later conclusion  ',
    });

    expect(submission.accepted()).toEqual({
      ...submissionArgs,
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
      title: 'A later conclusion',
    });
    expect(submission.attempts()).toBe(2);
    expect(submission.rejections()).toBe(0);
  });

  it('bounces meaning-changing input with a field-by-field message, and counts it', async () => {
    const submission = createOperationalSubmissionTool();
    const detail = 'x'.repeat(2_280);
    const error = await callSubmission(submission, {
      ...submissionArgs,
      severity: 'urgent',
      detail,
    });

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      `${OPERATIONAL_SUBMISSION_TOOL_NAME} was not accepted.`,
    );
    expect(message).toContain(
      'severity must be one of "info", "warning", "critical" (received "urgent").',
    );
    expect(message).toContain(
      'detail is 2280 characters; the maximum is 2000. Shorten it.',
    );
    // The over-long detail is named, never echoed back at the model.
    expect(message).not.toContain(detail);
    expect(submission.accepted()).toBeUndefined();
    expect(submission.attempts()).toBe(1);
    expect(submission.rejections()).toBe(1);
  });

  it('refuses to repair an identifier, and names what each other field needs', () => {
    // A code is what says which finding this is; rewriting one would change
    // the finding, so it bounces rather than being cleaned up (N3).
    expect(
      describeOperationalRecommendationIssues({
        ...submissionArgs,
        recommendationCode: 'BAD CODE!',
      }),
    ).toContain('recommendationCode must match ^[A-Z0-9][A-Z0-9_.-]{0,63}$');

    expect(describeOperationalRecommendationIssues({})).toContain(
      'title is required.',
    );
    expect(
      describeOperationalRecommendationIssues({
        ...submissionArgs,
        title: '   ',
      }),
    ).toContain('title must not be empty.');
    expect(describeOperationalRecommendationIssues('not an object')).toContain(
      'the arguments must be a JSON object',
    );
    expect(
      describeOperationalRecommendationIssues(submissionArgs),
    ).toBeUndefined();
  });
});
