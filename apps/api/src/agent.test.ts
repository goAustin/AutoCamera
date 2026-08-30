import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import { createInMemoryStore } from '@h3/db';
import { InMemoryTelemetry } from '@h3/telemetry';
import { buildApiApp } from './app.js';

const auth = { authorization: 'Bearer test-token' };
const apps: Array<Awaited<ReturnType<typeof buildApiApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

function validOutput(projectId: string, duration: number) {
  const first = Math.round((duration / 3) * 1_000) / 1_000;
  const second = first;
  const third = Math.round((duration - first - second) * 1_000) / 1_000;
  return {
    projectId,
    objective: 'Create a concise three-shot preview storyboard.',
    assumptions: ['Preview generation is text-to-video only.'],
    shots: [1, 2, 3].map((ordinal) => ({
      ordinal,
      purpose: `Purpose ${ordinal}`,
      generationMode: 't2v',
      durationSeconds: [first, second, third][ordinal - 1],
      visualDescription: `Visual direction ${ordinal}`,
      cameraDirection: `Camera direction ${ordinal}`,
      audioDirection: `Audio direction ${ordinal}`,
      requiredAssetIds: [],
      acceptanceCriteria: [`Acceptance criterion ${ordinal}`],
    })),
    totalDurationSeconds: duration,
    risks: [],
  };
}

type FixtureOutput = ReturnType<typeof validOutput>;
type FixtureMutator = (output: FixtureOutput) => unknown;

async function createProject(
  app: Awaited<ReturnType<typeof buildApiApp>>,
  duration = 5,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/projects',
    headers: { ...auth, 'idempotency-key': `project-${Math.random()}` },
    payload: {
      title: 'Agent fixture',
      brief: 'A deterministic planning fixture.',
      targetDurationSeconds: duration,
      budgetUsd: '25.00',
    },
  });
  return response.json().project;
}

describe('Phase 4 Pi planning agent', () => {
  it('uses the Pi loop, reads the project, persists one validated proposal, and records telemetry', async () => {
    const store = createInMemoryStore();
    const telemetry = new InMemoryTelemetry();
    const app = buildApiApp({
      store,
      telemetry,
      config: getApiConfig({ NODE_ENV: 'test' }),
    });
    apps.push(app);
    const project = await createProject(app);
    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/plan`,
      headers: { ...auth, 'idempotency-key': 'agent-plan-1' },
      payload: {},
    });
    expect(plan.statusCode).toBe(200);
    const body = plan.json();
    expect(body.proposal.shots).toHaveLength(3);
    expect(
      body.proposal.shots.map((shot: { ordinal: number }) => shot.ordinal),
    ).toEqual([1, 2, 3]);
    expect(body.proposal.shots[0]).toMatchObject({
      mode: 't2v',
      visualDescription: expect.any(String),
      cameraDirection: expect.any(String),
      audioDirection: expect.any(String),
      acceptanceCriteria: [expect.any(String)],
      requiredAssetIds: [],
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/plan`,
      headers: { ...auth, 'idempotency-key': 'agent-plan-1' },
      payload: {},
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);

    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(project.tenantId, project.id),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      provider: 'faux',
      model: 'h3-videoops-storyboard-v1',
      toolCalls: 1,
    });
    expect(JSON.stringify(runs[0])).not.toContain(
      'deterministic planning fixture',
    );
    expect(telemetry.getSpans().map((span) => span.name)).toEqual(
      expect.arrayContaining([
        'agent.run',
        'agent.tool',
        'agent.structured_validation',
      ]),
    );
    expect(
      telemetry.getSpans().find((span) => span.name === 'agent.tool')
        ?.parentName,
    ).toBe('agent.run');
  });

  it.each<[string, FixtureMutator]>([
    ['shot count', (output) => ({ ...output, shots: [] })],
    [
      'ordinal',
      (output) => ({
        ...output,
        shots: output.shots.map((shot, index) =>
          index === 0 ? { ...shot, ordinal: 2 } : shot,
        ),
      }),
    ],
    [
      'duration',
      (output) => ({
        ...output,
        shots: [
          { ...output.shots[0], durationSeconds: 0.05 },
          { ...output.shots[1], durationSeconds: 2.475 },
          { ...output.shots[2], durationSeconds: 2.475 },
        ],
      }),
    ],
    [
      'oversized text',
      (output) => ({
        ...output,
        shots: output.shots.map((shot, index) =>
          index === 0
            ? { ...shot, visualDescription: 'x'.repeat(2_001) }
            : shot,
        ),
      }),
    ],
  ])('rejects invalid %s without project mutation', async (_name, mutate) => {
    const invalidStore = createInMemoryStore();
    const app = buildApiApp({
      store: invalidStore,
      config: getApiConfig({ NODE_ENV: 'test' }),
    });
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': `invalid-project-${_name}` },
      payload: {
        title: 'Invalid fixture',
        brief: 'The project must remain unchanged.',
        targetDurationSeconds: 5,
        budgetUsd: '25.00',
      },
    });
    const invalidProject = created.json().project;
    const output = mutate(validOutput(invalidProject.id, 5));
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const invalidApp = buildApiApp({
      store: invalidStore,
      config: getApiConfig({ NODE_ENV: 'test' }),
      planningScript: { output },
    });
    apps.push(invalidApp);
    const plan = await invalidApp.inject({
      method: 'POST',
      url: `/v1/projects/${invalidProject.id}/plan`,
      headers: { ...auth, 'idempotency-key': `invalid-plan-${_name}` },
      payload: {},
    });
    expect(plan.statusCode).toBe(422);
    expect(plan.json().code).toBe('INVALID_STRUCTURED_OUTPUT');
    const projectAfter = await invalidApp.inject({
      method: 'GET',
      url: `/v1/projects/${invalidProject.id}`,
      headers: auth,
    });
    expect(projectAfter.json().project.status).toBe('draft');
    const runs = await invalidStore.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(
        invalidProject.tenantId,
        invalidProject.id,
      ),
    );
    expect(runs[0]?.failureCode).toBe('INVALID_STRUCTURED_OUTPUT');
  });

  it('makes duplicate scripted tool calls harmless', async () => {
    const store = createInMemoryStore();
    const app = buildApiApp({
      store,
      config: getApiConfig({ NODE_ENV: 'test' }),
      planningScript: { duplicateToolCall: true },
    });
    apps.push(app);
    const project = await createProject(app);
    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/plan`,
      headers: { ...auth, 'idempotency-key': 'duplicate-plan' },
      payload: {},
    });
    expect(plan.statusCode).toBe(200);
    const runs = await store.withTransaction((repositories) =>
      repositories.agentRuns.listByProject(project.tenantId, project.id),
    );
    expect(runs[0]?.toolCalls).toBe(2);
    const proposal = await store.withTransaction((repositories) =>
      repositories.storyboards.findLatest(project.id),
    );
    expect(proposal).not.toBeNull();
  });

  it('records provider and abort failures as terminal runs', async () => {
    for (const [key, script, expectedStatus, expectedCode] of [
      [
        'provider',
        { providerError: 'offline provider' },
        'failed',
        'PROVIDER_ERROR',
      ],
      ['abort', { abort: true }, 'aborted', 'ABORTED'],
    ] as const) {
      const store = createInMemoryStore();
      const app = buildApiApp({
        store,
        config: getApiConfig({ NODE_ENV: 'test' }),
        planningScript: script,
      });
      apps.push(app);
      const project = await createProject(app);
      const plan = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/plan`,
        headers: { ...auth, 'idempotency-key': `failure-${key}` },
        payload: {},
      });
      expect(plan.statusCode).toBe(key === 'abort' ? 499 : 503);
      const runs = await store.withTransaction((repositories) =>
        repositories.agentRuns.listByProject(project.tenantId, project.id),
      );
      expect(runs[0]).toMatchObject({
        status: expectedStatus,
        failureCode: expectedCode,
      });
    }
  });
});
