import { afterEach, describe, expect, it } from 'vitest';
import { getApiConfig } from '@h3/config';
import {
  createInMemoryStore,
  OutboxDispatcher,
  type TransactionalStore,
} from '@h3/db';
import { createTraceId } from '@h3/telemetry';
import { buildApiApp } from './app.js';

const apps = new Set<Awaited<ReturnType<typeof buildApiApp>>>();

function createApp(store: TransactionalStore = createInMemoryStore()) {
  const app = buildApiApp({
    config: getApiConfig({ NODE_ENV: 'test', DEV_AUTH_TOKEN: 'test-secret' }),
    store,
  });
  apps.add(app);
  return app;
}

function authHeaders(key?: string): Record<string, string> {
  return {
    authorization: 'Bearer test-secret',
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

afterEach(async () => {
  await Promise.all([...apps].map((app) => app.close()));
  apps.clear();
});

describe('Phase 2 project API', () => {
  it('authenticates /v1 routes and returns redacted problem details', async () => {
    const app = createApp();
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/v1/projects',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(unauthorized.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
      retryable: false,
    });
    expect(JSON.stringify(unauthorized.json())).not.toContain('test-secret');

    const secret = 'prompt-and-secret-value';
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('invalid-body'),
      payload: { title: '', brief: secret, targetDurationSeconds: 1 },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.stringify(invalid.json())).not.toContain(secret);
    expect(JSON.stringify(invalid.json())).not.toContain('node_modules');
    expect(JSON.stringify(invalid.json())).not.toContain('SQL');
  });

  it('creates, plans, approves, retrieves, and costs a project', async () => {
    const app = createApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('create-1'),
      payload: {
        title: 'Launch film',
        brief: 'A bright product launch in three beats.',
        targetDurationSeconds: 5,
        budgetUsd: '12.50',
      },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json().project;
    expect(project).toMatchObject({
      status: 'draft',
      budgetMicrousd: 12_500_000,
      spentMicrousd: 0,
      version: 1,
    });

    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/plan`,
      headers: authHeaders('plan-1'),
      payload: {},
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().project.status).toBe('awaiting_storyboard_approval');
    const proposal = plan.json().proposal;
    expect(proposal.shots).toHaveLength(3);
    expect(
      proposal.shots.map((shot: { ordinal: number }) => shot.ordinal),
    ).toEqual([1, 2, 3]);
    expect(
      proposal.shots.reduce(
        (sum: number, shot: { durationSeconds: number }) =>
          sum + shot.durationSeconds,
        0,
      ),
    ).toBeCloseTo(5, 6);

    const approval = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/storyboard/approve`,
      headers: authHeaders('approve-1'),
      payload: { proposalId: proposal.id },
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json().project.status).toBe('ready_for_generation');
    expect(approval.json().shots).toHaveLength(3);
    expect(
      approval.json().shots.map((shot: { ordinal: number }) => shot.ordinal),
    ).toEqual([1, 2, 3]);
    expect(
      approval
        .json()
        .shots.every(
          (shot: { status: string }) =>
            shot.status === 'approved_for_generation',
        ),
    ).toBe(true);

    const retrieved = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}`,
      headers: authHeaders(),
    });
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json().project.status).toBe('ready_for_generation');

    const shots = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/shots`,
      headers: authHeaders(),
    });
    expect(shots.json().shots).toHaveLength(3);

    const events = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/events`,
      headers: authHeaders(),
    });
    expect(events.statusCode).toBe(200);
    expect(
      events.json().events.map((event: { type: string }) => event.type),
    ).toEqual([
      'project.created',
      'project.planning_started',
      'storyboard.proposed',
      'project.planned',
      'storyboard.approved',
      'shot.created',
      'shot.created',
      'shot.created',
      'project.ready_for_generation',
    ]);
    expect(JSON.stringify(events.json())).not.toContain(
      'bright product launch',
    );

    const cost = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/cost`,
      headers: authHeaders(),
    });
    expect(cost.statusCode).toBe(200);
    expect(cost.json()).toMatchObject({
      budgetMicrousd: 12_500_000,
      spentMicrousd: 0,
      remainingMicrousd: 12_500_000,
    });
  });

  it('replays identical mutations, rejects key reuse, and never duplicates approval shots', async () => {
    const app = createApp();
    const payload = {
      title: 'Idempotent project',
      brief: 'A repeatable brief.',
      targetDurationSeconds: 6,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload: {
        brief: payload.brief,
        title: payload.title,
        targetDurationSeconds: 6,
      },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());

    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('same-create'),
      payload: { ...payload, title: 'Different project' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const projectId = first.json().project.id;
    const plan = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/plan`,
      headers: authHeaders('same-plan'),
      payload: {},
    });
    const planReplay = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/plan`,
      headers: authHeaders('same-plan'),
      payload: {},
    });
    expect(planReplay.json()).toEqual(plan.json());
    const proposalId = plan.json().proposal.id;

    const approval = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/storyboard/approve`,
      headers: authHeaders('same-approval'),
      payload: { proposalId },
    });
    const approvalReplay = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/storyboard/approve`,
      headers: authHeaders('same-approval'),
      payload: { proposalId },
    });
    expect(approvalReplay.json()).toEqual(approval.json());

    const duplicateApproval = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/storyboard/approve`,
      headers: authHeaders('different-approval'),
      payload: { proposalId },
    });
    expect(duplicateApproval.statusCode).toBe(409);
    expect(duplicateApproval.json()).toMatchObject({
      code: 'STORYBOARD_NOT_APPROVABLE',
    });
    const shots = await app.inject({
      method: 'GET',
      url: `/v1/projects/${projectId}/shots`,
      headers: authHeaders(),
    });
    expect(shots.json().shots).toHaveLength(3);
  });

  it('serializes concurrent identical create requests to one effect', async () => {
    const app = createApp();
    const request = {
      method: 'POST' as const,
      url: '/v1/projects',
      headers: authHeaders('concurrent-create'),
      payload: {
        title: 'Concurrent project',
        brief: 'One durable effect.',
        targetDurationSeconds: 3,
      },
    };
    const responses = await Promise.all([
      app.inject(request),
      app.inject(request),
      app.inject(request),
    ]);
    expect(responses.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    const projects = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: authHeaders(),
    });
    expect(projects.json().projects).toHaveLength(1);
  });

  it('publishes all implemented routes in OpenAPI and can dispatch the outbox', async () => {
    const store = createInMemoryStore();
    const app = createApp(store);
    const openApi = await app.inject({
      method: 'GET',
      url: '/documentation/json',
    });
    expect(openApi.statusCode).toBe(200);
    const paths = Object.keys(openApi.json().paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/v1/projects',
        '/v1/projects/{projectId}',
        '/v1/projects/{projectId}/plan',
        '/v1/projects/{projectId}/storyboard/approve',
        '/v1/projects/{projectId}/shots',
        '/v1/projects/{projectId}/events',
        '/v1/projects/{projectId}/cost',
      ]),
    );
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: authHeaders('outbox-create'),
      payload: {
        title: 'Outbox project',
        brief: 'Dispatch me.',
        targetDurationSeconds: 3,
      },
    });
    expect(response.statusCode).toBe(201);
    const dispatcher = new OutboxDispatcher(store);
    expect(await dispatcher.pollOnce()).toBe(true);
    expect(await dispatcher.pollOnce()).toBe(false);
  });
});
