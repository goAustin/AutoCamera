import { describe, expect, it } from 'vitest';
import type { Uuid } from '@h3/domain';
import {
  OPERATIONAL_SUBMISSION_TOOL_NAME,
  OPERATIONAL_TOOL_NAMES,
  createOperationalReadTools,
  createOperationalSubmissionTool,
  describeOperationalEvidence,
  validateOperationalRecommendation,
  describeOperationalRecommendationIssues,
  type OperationalEvidenceViews,
  type OperationalToolServices,
} from './index.js';

// `as Uuid`, not `as never`: `never` is assignable to every parameter, so
// these constants used to type-check against any signature the tools might
// grow. This is the convention the rest of the suite already uses for a
// fixture identifier (`operator.test.ts`, `control-plane.test.ts`).
const projectId = '00000000-0000-7000-8000-000000000001' as Uuid;
const otherProjectId = '00000000-0000-7000-8000-000000000002' as Uuid;
const shotId = '00000000-0000-7000-8000-000000000003' as Uuid;
const otherShotId = '00000000-0000-7000-8000-000000000004' as Uuid;
const revisionId = '00000000-0000-7000-8000-000000000005' as Uuid;
const attemptId = '00000000-0000-7000-8000-000000000006' as Uuid;
const tenantId = '00000000-0000-7000-8000-000000000007' as Uuid;

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

/** Keeps a resolved row's own type while asserting the fixture actually returned it. */
function required<T>(value: T | null, what: string): T {
  if (!value) throw new Error(`Expected the ${what} fixture to resolve.`);
  return value;
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

  it('denies cross-project and cross-resource reads, naming the identifier that is in scope', async () => {
    // W7: the code still says which rule was hit; the sentence beside it says
    // what to call instead, so the correction costs one turn rather than
    // several blind ones.
    const projectResult = await tool('get_project_status').execute('call-1', {
      projectId: otherProjectId,
    });
    expect(projectResult.details).toEqual({
      ok: false,
      code: 'PROJECT_SCOPE_DENIED',
      message: `get_project_status is scoped to this incident: call it with projectId=${projectId}, or omit projectId.`,
    });

    const shotResult = await tool('get_shot_status').execute('call-2', {
      projectId,
      shotId: otherShotId,
    });
    expect(shotResult.details).toEqual({
      ok: false,
      code: 'SHOT_SCOPE_DENIED',
      message: `get_shot_status is scoped to this incident: call it with shotId=${shotId}.`,
    });
    // What the model actually reads is the text block, not `details`.
    expect(shotResult.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify(shotResult.details),
    });
  });

  it('tells the model when evidence is out of scope, unreadable, or asked for wrongly', async () => {
    const unscoped = createOperationalReadTools({
      tenantId,
      projectId,
      services: services(),
    });
    const shotless = unscoped.find(
      (candidate) => candidate.name === 'get_shot_status',
    );
    if (!shotless) throw new Error('Missing tool get_shot_status.');

    // No shot in scope at all: there is no identifier to hand back, so the
    // model is told to stop guessing rather than to try another one. A v4
    // UUID is the reachable shape of that -- it passes the input schema and
    // fails the v7 identifier check.
    const outOfScope = await shotless.execute('call-1', {
      shotId: '00000000-0000-4000-8000-000000000009',
    });
    expect(outOfScope.details).toEqual({
      ok: false,
      code: 'SHOT_SCOPE_DENIED',
      message:
        'get_shot_status did not accept that shotId. This incident is ' +
        `scoped to projectId=${projectId} and names no shot, so there is no ` +
        'other one to try -- conclude from the evidence you do have.',
    });

    // A service that throws is not a retryable condition either.
    const failing = tool('get_executor_readiness', {
      ...services(),
      getExecutorReadiness: async () => {
        throw new Error('executor is down');
      },
    });
    expect(await failing.execute('call-2', {})).toMatchObject({
      details: {
        code: 'EXECUTOR_UNAVAILABLE',
        message:
          'The executor readiness for this incident is not readable. ' +
          'Retrying get_executor_readiness will not change that -- reach ' +
          'your conclusion from the evidence you do have.',
      },
    });

    // Bad arguments name what the tool takes.
    const badArguments = await tool('get_attempt_status').execute('call-3', {
      attempt: attemptId,
    });
    expect(badArguments.details).toEqual({
      ok: false,
      code: 'INVALID_ARGUMENTS',
      message:
        'get_attempt_status could not read its arguments. It takes ' +
        'attemptId, and optionally projectId.',
    });
  });

  it('reports the scope rule that actually failed, not the tool it failed in', async () => {
    // Collapsing both checks into one code told a model that got projectId
    // wrong to "call it with shotId=<the id it just sent>" -- unactionable, so
    // it resends the same call until the run's budget bound stops it.
    const denials: string[] = [];
    const scoped = createOperationalReadTools({
      tenantId,
      projectId,
      shotId,
      attemptId,
      workflowRevisionId: revisionId,
      services: services(),
      onPolicyDenial: (code, operation) => denials.push(`${code}/${operation}`),
    });
    const shot = scoped.find(
      (candidate) => candidate.name === 'get_shot_status',
    );
    if (!shot) throw new Error('Missing tool get_shot_status.');

    const wrongProject = await shot.execute('call-1', {
      projectId: otherProjectId,
      shotId,
    });
    expect(wrongProject.details).toEqual({
      ok: false,
      code: 'PROJECT_SCOPE_DENIED',
      message:
        'get_shot_status is scoped to this incident: call it with ' +
        `projectId=${projectId}, or omit projectId.`,
    });

    // The revision tool separates all three, so WORKFLOW_SCOPE_DENIED now
    // means the revision itself and its message can name revisionId.
    const revision = scoped.find(
      (candidate) => candidate.name === 'get_workflow_revision_validation',
    );
    if (!revision) throw new Error('Missing tool.');
    expect(
      (await revision.execute('call-2', { shotId: otherShotId, revisionId }))
        .details,
    ).toMatchObject({ code: 'SHOT_SCOPE_DENIED' });
    expect(
      (await revision.execute('call-3', { shotId, revisionId: otherShotId }))
        .details,
    ).toMatchObject({
      code: 'WORKFLOW_SCOPE_DENIED',
      message:
        'get_workflow_revision_validation is scoped to this incident: call ' +
        `it with shotId=${shotId} and revisionId=${revisionId}.`,
    });

    // One denied call is one span event, carrying the code the model saw.
    // The scope helpers used to emit one of their own as well.
    expect(denials).toEqual([
      'PROJECT_SCOPE_DENIED/get_shot_status',
      'SHOT_SCOPE_DENIED/get_workflow_revision_validation',
      'WORKFLOW_SCOPE_DENIED/get_workflow_revision_validation',
    ]);
  });

  it('names the parameter a tool takes, not the key the context stores it under', async () => {
    // The revision is `workflowRevisionId` in the event payload and the tool
    // context, and `revisionId` on `get_workflow_revision_validation`. A
    // denial that echoed the context key would send the model back with a
    // parameter no tool accepts.
    const denied = await tool('get_workflow_revision_validation').execute(
      'call-1',
      { projectId, shotId, revisionId: otherShotId },
    );
    expect(denied.details).toEqual({
      ok: false,
      code: 'WORKFLOW_SCOPE_DENIED',
      message:
        'get_workflow_revision_validation is scoped to this incident: call ' +
        `it with shotId=${shotId} and revisionId=${revisionId}.`,
    });

    // `createOperationalReadTools` is exported, and its context permits a shot
    // with no revision -- the adapter never builds that, but the message has
    // to name `revisionId` there too.
    const revisionless = createOperationalReadTools({
      tenantId,
      projectId,
      shotId,
      services: services(),
    }).find(
      (candidate) => candidate.name === 'get_workflow_revision_validation',
    );
    if (!revisionless) throw new Error('Missing the revision tool.');
    expect(
      await revisionless.execute('call-2', {
        projectId,
        shotId,
        revisionId: '00000000-0000-4000-8000-000000000009',
      }),
    ).toMatchObject({
      details: {
        code: 'WORKFLOW_SCOPE_DENIED',
        message:
          'get_workflow_revision_validation did not accept that revisionId. ' +
          `This incident is scoped to projectId=${projectId} and names no ` +
          'workflow revision, so there is no other one to try -- conclude ' +
          'from the evidence you do have.',
      },
    });
  });

  it('seeds the resolved evidence in the exact shape the tools return it', async () => {
    // W6: the prompt block and the tool result are one sanitizer, so a model
    // that re-reads a seeded row gets the same bytes back and has nothing to
    // reconcile.
    const resolved = services();
    // Typed, not cast: this test exists to prove the seeded row and the tool
    // result are the same shape, and `as never` would have thrown away the
    // compile-time half of that -- a service returning something else would
    // still have compiled.
    const evidence: OperationalEvidenceViews = {
      project: required(
        await resolved.getProjectStatus(tenantId, projectId),
        'project',
      ),
      shot: required(
        await resolved.getShotStatus(tenantId, projectId, shotId),
        'shot',
      ),
      attempt: required(
        await resolved.getAttemptStatus(tenantId, projectId, attemptId),
        'attempt',
      ),
      revision: required(
        await resolved.getWorkflowRevisionValidation(
          tenantId,
          projectId,
          shotId,
          revisionId,
        ),
        'workflow revision',
      ),
    };
    const seeded = describeOperationalEvidence(evidence);

    for (const [name, args] of [
      ['get_project_status', { projectId }],
      ['get_shot_status', { projectId, shotId }],
      ['get_attempt_status', { projectId, attemptId }],
      ['get_workflow_revision_validation', { projectId, shotId, revisionId }],
    ] as const) {
      const result = await tool(name).execute('call-1', args);
      const details = result.details as { readonly data: unknown };
      expect(seeded).toContain(`- ${name}: ${JSON.stringify(details.data)}`);
    }

    // The two views nobody resolved stay a reason to call a tool.
    expect(seeded).not.toContain('- get_recent_incidents:');
    expect(seeded).not.toContain('- get_executor_readiness:');
    expect(seeded).toContain('use your tool calls for what is not above');
  });

  it('omits an evidence row the incident does not have', () => {
    const seeded = describeOperationalEvidence({
      project: {
        id: projectId,
        status: 'needs_attention',
        budgetMicrousd: null,
        spentMicrousd: 0,
        remainingMicrousd: null,
      },
    });
    expect(seeded).toContain('- get_project_status:');
    expect(seeded).not.toContain('- get_shot_status:');
    expect(seeded).not.toContain('- get_attempt_status:');
    expect(seeded).not.toContain('- get_workflow_revision_validation:');
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

  it('answers for the tool, not about it: normalization applies everywhere', async () => {
    // The helper, the tool and tier 2's validator share one parse, so a
    // lower-case code is accepted by all three. Reporting it as a violation
    // while the tool accepted it made the helper describe a bounce that never
    // happened.
    const lowerCased = {
      ...submissionArgs,
      recommendationCode: '  executor_unavailable  ',
    };
    expect(describeOperationalRecommendationIssues(lowerCased)).toBeUndefined();
    expect(validateOperationalRecommendation(lowerCased)).toEqual({
      ...submissionArgs,
      recommendationCode: 'EXECUTOR_UNAVAILABLE',
    });

    const submission = createOperationalSubmissionTool();
    await callSubmission(submission, lowerCased);
    expect(submission.accepted()?.recommendationCode).toBe(
      'EXECUTOR_UNAVAILABLE',
    );
    expect(submission.rejections()).toBe(0);
  });
});
