import { describe, expect, it } from 'vitest';
import { createUuidV7 } from '@h3/domain';
import {
  PLANNING_TOOL_NAMES,
  createPlanningTools,
  type PlanningToolServices,
} from './index.js';

const tenantId = createUuidV7(1_700_000_000_001, new Uint8Array(10).fill(1));
const projectId = createUuidV7(1_700_000_000_002, new Uint8Array(10).fill(2));
const foreignProjectId = createUuidV7(
  1_700_000_000_003,
  new Uint8Array(10).fill(3),
);
const shotId = createUuidV7(1_700_000_000_004, new Uint8Array(10).fill(4));

function services(overrides: Partial<PlanningToolServices> = {}) {
  return {
    getVideoProject: async () => null,
    submitStoryboardForApproval: async () => ({
      id: projectId,
      projectId,
      revision: 1,
      status: 'approved' as const,
      shotCount: 3,
      totalDurationSeconds: 3,
    }),
    requestShotGeneration: async () => ({
      id: shotId,
      projectId,
      shotId,
      status: 'queued' as const,
    }),
    getGenerationAttempt: async () => null,
    requestRegeneration: async () => ({
      id: shotId,
      projectId,
      shotId,
      status: 'queued' as const,
    }),
    getProjectIncidents: async () => [],
    ...overrides,
  } satisfies PlanningToolServices;
}

function context(overrides: Partial<PlanningToolServices> = {}) {
  return {
    tenantId,
    projectId,
    agentRunId: projectId,
    services: services(overrides),
    effectCache: new Map(),
  };
}

function requiredTool(
  tools: ReturnType<typeof createPlanningTools>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

describe('scoped planning tools', () => {
  it('exposes exactly the Phase 4 capabilities', () => {
    expect(createPlanningTools(context()).map((tool) => tool.name)).toEqual(
      PLANNING_TOOL_NAMES,
    );
  });

  it('rejects model-supplied foreign project scope', async () => {
    let called = false;
    const tools = createPlanningTools(
      context({
        getVideoProject: async () => {
          called = true;
          return null;
        },
      }),
    );
    const tool = requiredTool(tools, 'get_video_project');
    const result = await tool.execute('scope-call', {
      projectId: foreignProjectId,
    });
    expect(result?.details).toEqual({
      ok: false,
      code: 'PROJECT_SCOPE_DENIED',
    });
    expect(called).toBe(false);
  });

  it('deduplicates the same durable generation tool call', async () => {
    let calls = 0;
    const tool = requiredTool(
      createPlanningTools(
        context({
          requestShotGeneration: async (input) => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(input.idempotencyKey).toContain('request_shot_generation');
            return {
              id: shotId,
              projectId,
              shotId,
              status: 'queued' as const,
            };
          },
        }),
        ['request_shot_generation'],
      ),
      'request_shot_generation',
    );
    const params = { projectId, shotId };
    const [first, second] = await Promise.all([
      tool.execute('duplicate-call', params),
      tool.execute('duplicate-call', params),
    ]);
    expect(calls).toBe(1);
    expect(first.details).toEqual(second.details);
  });

  it('returns stable policy codes for generation denials', async () => {
    const tool = requiredTool(
      createPlanningTools(
        context({
          requestShotGeneration: async () => {
            throw Object.assign(new Error('budget denied'), {
              code: 'BUDGET_EXCEEDED',
            });
          },
        }),
        ['request_shot_generation'],
      ),
      'request_shot_generation',
    );
    const result = await tool.execute('denied-call', { projectId, shotId });
    expect(result.details).toEqual({
      ok: false,
      code: 'BUDGET_EXCEEDED',
    });
  });

  it('returns stable approval and regeneration policy codes', async () => {
    const approval = requiredTool(
      createPlanningTools(
        context({
          submitStoryboardForApproval: async () => {
            throw Object.assign(new Error('approval denied'), {
              code: 'STORYBOARD_NOT_APPROVABLE',
            });
          },
        }),
        ['submit_storyboard_for_approval'],
      ),
      'submit_storyboard_for_approval',
    );
    const regeneration = requiredTool(
      createPlanningTools(
        context({
          requestRegeneration: async () => {
            throw Object.assign(new Error('source not rejected'), {
              code: 'ATTEMPT_NOT_REJECTED',
            });
          },
        }),
        ['request_regeneration'],
      ),
      'request_regeneration',
    );
    expect(
      (await approval.execute('approval-call', { projectId })).details,
    ).toEqual({ ok: false, code: 'STORYBOARD_NOT_APPROVABLE' });
    expect(
      (await regeneration.execute('regeneration-call', { projectId, shotId }))
        .details,
    ).toEqual({ ok: false, code: 'ATTEMPT_NOT_REJECTED' });
  });
});
